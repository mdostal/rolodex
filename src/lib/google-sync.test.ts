import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyPullToStore,
  contactToPersonBody,
  createGoogleSync,
  deleteContactEverywhere,
  findExistingMatch,
  mapPersonToContact,
  mergeLocalOnlyFields,
  type DeletableStore,
  type GoogleSync,
  type PeopleApiClient,
  type PersonLite,
} from "./google-sync.js";
import { createInMemorySecretsAdapter } from "./secrets-adapter.js";
import { Store } from "./store.js";
import type { Contact } from "./types.js";

// Mirrors src/shell/server.ts's GOOGLE_OAUTH_CLIENT_KEY constant — duplicated
// deliberately (see google-sync.ts's own docstring on the same constant).
const GOOGLE_OAUTH_CLIENT_KEY = "google.oauth.client";
const GOOGLE_OAUTH_TOKEN_KEY = "google.oauth.token";

function baseContact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: "id-1",
    name: "Ada Lovelace",
    verdict: "none",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** A full, correctly-typed PeopleApiClient for pull()-only tests — throwing
 * stubs for createContact/updateContact/deleteContact make it obvious (a
 * real assertion failure, not `undefined` silently propagating) if a
 * pull()-only test accidentally exercises a push()/delete code path. */
function fakePeopleClient(list: PeopleApiClient["people"]["connections"]["list"]): PeopleApiClient {
  return {
    people: {
      connections: { list },
      createContact: () => {
        throw new Error("createContact should not be called by a pull()-only test");
      },
      updateContact: () => {
        throw new Error("updateContact should not be called by a pull()-only test");
      },
      deleteContact: () => {
        throw new Error("deleteContact should not be called by a pull()-only test");
      },
    },
  };
}

// ---------------------------------------------------------------------------
// mapPersonToContact — field-mapping logic
// ---------------------------------------------------------------------------
describe("mapPersonToContact", () => {
  it("maps name, org, role, email, phone, and resourceName -> googleResourceName", () => {
    const person: PersonLite = {
      resourceName: "people/c123",
      names: [{ displayName: "Grace Hopper" }],
      organizations: [{ name: "US Navy", title: "Rear Admiral" }],
      emailAddresses: [{ value: "grace@example.com" }],
      phoneNumbers: [{ value: "+1-555-0100" }],
    };

    const contact = mapPersonToContact(person);

    expect(contact).toMatchObject({
      id: "people/c123",
      googleResourceName: "people/c123",
      name: "Grace Hopper",
      org: "US Navy",
      role: "Rear Admiral",
      email: "grace@example.com",
      phone: "+1-555-0100",
      verdict: "none",
    });
  });

  it("captures metadata.sources[].etag as googleEtag", () => {
    const person: PersonLite = {
      resourceName: "people/c123",
      names: [{ displayName: "Grace Hopper" }],
      metadata: { sources: [{ type: "CONTACT", etag: 'W/"abc123"' }] },
    };
    expect(mapPersonToContact(person).googleEtag).toBe('W/"abc123"');
  });

  it("takes the first source that actually has an etag, when there are multiple sources", () => {
    const person: PersonLite = {
      resourceName: "people/c123",
      names: [{ displayName: "Grace Hopper" }],
      metadata: { sources: [{ type: "PROFILE", etag: null }, { type: "CONTACT", etag: 'W/"real"' }] },
    };
    expect(mapPersonToContact(person).googleEtag).toBe('W/"real"');
  });

  it("leaves googleEtag undefined when metadata/sources are absent", () => {
    const contact = mapPersonToContact({ resourceName: "people/c1", names: [{ displayName: "X" }] });
    expect(contact.googleEtag).toBeUndefined();
  });

  it("only reads the first entry in each repeated field", () => {
    const person: PersonLite = {
      resourceName: "people/c1",
      names: [{ displayName: "First Name" }, { displayName: "Second Name" }],
      emailAddresses: [{ value: "first@example.com" }, { value: "second@example.com" }],
    };
    const contact = mapPersonToContact(person);
    expect(contact.name).toBe("First Name");
    expect(contact.email).toBe("first@example.com");
  });

  it("leaves local-only fields (met/what/angle/nextStep/tags) unset", () => {
    const contact = mapPersonToContact({ resourceName: "people/c1", names: [{ displayName: "X" }] });
    expect(contact.met).toBeUndefined();
    expect(contact.what).toBeUndefined();
    expect(contact.angle).toBeUndefined();
    expect(contact.nextStep).toBeUndefined();
    expect(contact.tags).toBeUndefined();
    expect(contact.verdict).toBe("none");
  });

  it("falls back to email when there's no displayName", () => {
    const contact = mapPersonToContact({
      resourceName: "people/c1",
      emailAddresses: [{ value: "no-name@example.com" }],
    });
    expect(contact.name).toBe("no-name@example.com");
  });

  it("falls back to '(no name)' when neither displayName nor email is present", () => {
    const contact = mapPersonToContact({ resourceName: "people/c1" });
    expect(contact.name).toBe("(no name)");
  });

  it("generates a fallback id when resourceName itself is absent", () => {
    const contact = mapPersonToContact({ names: [{ displayName: "No ResourceName" }] });
    expect(contact.id).toBeTruthy();
    expect(contact.googleResourceName).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createGoogleSync().pull() — pagination + credential handling, fully mocked
// (no real googleapis network calls; the People API client is injected).
// ---------------------------------------------------------------------------
describe("createGoogleSync().pull()", () => {
  async function seededSecrets() {
    const secrets = createInMemorySecretsAdapter();
    await secrets.set(GOOGLE_OAUTH_CLIENT_KEY, JSON.stringify({ clientId: "cid", clientSecret: "csecret" }));
    await secrets.set(GOOGLE_OAUTH_TOKEN_KEY, JSON.stringify({ access_token: "at", refresh_token: "rt" }));
    return secrets;
  }

  it("paginates via pageToken until nextPageToken is absent, concatenating every page's connections in order", async () => {
    const secrets = await seededSecrets();
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          connections: [
            { resourceName: "people/1", names: [{ displayName: "One" }] },
            { resourceName: "people/2", names: [{ displayName: "Two" }] },
          ],
          nextPageToken: "page-2",
        },
      })
      .mockResolvedValueOnce({
        data: {
          connections: [{ resourceName: "people/3", names: [{ displayName: "Three" }] }],
          // no nextPageToken -> pagination stops
        },
      });
    const fakeClient: PeopleApiClient = fakePeopleClient(list);

    const sync = createGoogleSync({ secrets, createPeopleClient: () => fakeClient });
    const contacts = await sync.pull();

    expect(contacts.map((c) => c.name)).toEqual(["One", "Two", "Three"]);
    expect(list).toHaveBeenCalledTimes(2);
    // First call: no pageToken. Second call: forwards the prior page's
    // nextPageToken. Both calls request the same resourceName/personFields.
    expect(list.mock.calls[0]![0]).toMatchObject({
      resourceName: "people/me",
      personFields: "names,organizations,emailAddresses,phoneNumbers,metadata",
      pageToken: undefined,
    });
    expect(list.mock.calls[1]![0]).toMatchObject({ pageToken: "page-2" });
  });

  it("returns an empty array when the account has no connections", async () => {
    const secrets = await seededSecrets();
    const list = vi.fn().mockResolvedValueOnce({ data: {} });
    const sync = createGoogleSync({ secrets, createPeopleClient: () => fakePeopleClient(list) });
    expect(await sync.pull()).toEqual([]);
  });

  it("stops after a single page when the first response has no nextPageToken", async () => {
    const secrets = await seededSecrets();
    const list = vi.fn().mockResolvedValueOnce({
      data: { connections: [{ resourceName: "people/1", names: [{ displayName: "Solo" }] }] },
    });
    const sync = createGoogleSync({ secrets, createPeopleClient: () => fakePeopleClient(list) });
    const contacts = await sync.pull();
    expect(contacts).toHaveLength(1);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("throws an actionable error when no OAuth client is stored", async () => {
    const secrets = createInMemorySecretsAdapter();
    const sync = createGoogleSync({ secrets, createPeopleClient: () => fakePeopleClient(vi.fn()) });
    await expect(sync.pull()).rejects.toThrow(/isn't connected/i);
  });

  it("throws an actionable error when the OAuth client is stored but corrupt", async () => {
    const secrets = createInMemorySecretsAdapter();
    await secrets.set(GOOGLE_OAUTH_CLIENT_KEY, "not json");
    const sync = createGoogleSync({ secrets, createPeopleClient: () => fakePeopleClient(vi.fn()) });
    await expect(sync.pull()).rejects.toThrow(/corrupt/i);
  });

  it("throws an actionable error when the OAuth client is stored but incomplete", async () => {
    const secrets = createInMemorySecretsAdapter();
    await secrets.set(GOOGLE_OAUTH_CLIENT_KEY, JSON.stringify({ clientId: "only-id" }));
    const sync = createGoogleSync({ secrets, createPeopleClient: () => fakePeopleClient(vi.fn()) });
    await expect(sync.pull()).rejects.toThrow(/incomplete/i);
  });

  it("throws an actionable error when the client is configured but no token is stored yet (sign-in not done)", async () => {
    const secrets = createInMemorySecretsAdapter();
    await secrets.set(GOOGLE_OAUTH_CLIENT_KEY, JSON.stringify({ clientId: "cid", clientSecret: "csecret" }));
    const sync = createGoogleSync({ secrets, createPeopleClient: () => fakePeopleClient(vi.fn()) });
    await expect(sync.pull()).rejects.toThrow(/sign-in/i);
  });

  it("never calls the People client at all when credentials are missing", async () => {
    const secrets = createInMemorySecretsAdapter();
    const list = vi.fn();
    const sync = createGoogleSync({ secrets, createPeopleClient: () => fakePeopleClient(list) });
    await expect(sync.pull()).rejects.toThrow();
    expect(list).not.toHaveBeenCalled();
  });

  // gof-01 AC10: pull()'s OAuth2Client construction wires the same
  // 'tokens'-event persistence hook google-oauth-flow.ts uses, so a token
  // refreshed internally during pull() (not just at initial connect) gets
  // saved back to the keychain instead of being silently re-derived from
  // refresh_token on every future call. createPeopleClient() is the only
  // injection seam pull() has, but it's handed the *real* OAuth2Client
  // instance it just constructed — that's a real EventEmitter, so a test
  // can capture it and fire 'tokens' on it directly, exactly mirroring what
  // googleapis' own internals do on a silent background refresh.
  it("persists a refreshed token back to the keychain when the OAuth2Client's 'tokens' event fires during pull()", async () => {
    const secrets = await seededSecrets();
    let capturedAuth: { emit: (event: string, payload: unknown) => void } | undefined;
    const list = vi.fn().mockResolvedValueOnce({ data: {} });
    const sync = createGoogleSync({
      secrets,
      createPeopleClient: (auth) => {
        capturedAuth = auth as unknown as { emit: (event: string, payload: unknown) => void };
        return fakePeopleClient(list);
      },
    });

    await sync.pull();
    expect(capturedAuth).toBeDefined();

    capturedAuth!.emit("tokens", { access_token: "refreshed-access", refresh_token: "rt", expiry_date: Date.now() + 1000 });
    // secrets.set() is async — give its microtask a turn.
    await new Promise((r) => setTimeout(r, 0));

    const stored = await secrets.get(GOOGLE_OAUTH_TOKEN_KEY);
    expect(JSON.parse(stored!)).toMatchObject({ access_token: "refreshed-access" });
  });
});

describe("contactToPersonBody", () => {
  it("puts the whole name in givenName (never splits it) and maps org/role/email/phone", () => {
    const body = contactToPersonBody(
      baseContact({ name: "Ada Lovelace", org: "Analytical Engines", role: "Mathematician", email: "ada@example.com", phone: "+1-555-0100" }),
    );
    expect(body).toEqual({
      names: [{ givenName: "Ada Lovelace" }],
      organizations: [{ name: "Analytical Engines", title: "Mathematician" }],
      emailAddresses: [{ value: "ada@example.com" }],
      phoneNumbers: [{ value: "+1-555-0100" }],
    });
  });

  it("omits organizations/emailAddresses/phoneNumbers entirely when unset, rather than sending empty arrays", () => {
    const body = contactToPersonBody(baseContact({ name: "Ada Lovelace" }));
    expect(body).toEqual({ names: [{ givenName: "Ada Lovelace" }] });
  });

  it("never includes local-only fields (verdict/angle/nextStep/tags/met/what) — Google has no fields for them", () => {
    const body = contactToPersonBody(
      baseContact({
        name: "Ada Lovelace",
        verdict: "strong",
        angle: "warm intro",
        nextStep: "follow up",
        tags: ["vip"],
        met: "conference",
        what: "engineering",
      }),
    );
    expect(JSON.stringify(body)).not.toMatch(/strong|warm intro|follow up|vip|conference|engineering/);
  });
});

describe("createGoogleSync().push()", () => {
  async function seededSecrets() {
    const secrets = createInMemorySecretsAdapter();
    await secrets.set(GOOGLE_OAUTH_CLIENT_KEY, JSON.stringify({ clientId: "cid", clientSecret: "csecret" }));
    await secrets.set(GOOGLE_OAUTH_TOKEN_KEY, JSON.stringify({ access_token: "at", refresh_token: "rt" }));
    return secrets;
  }

  it("creates a new contact (no googleResourceName) via createContact, returning the new resourceName/etag", async () => {
    const secrets = await seededSecrets();
    const createContact = vi.fn().mockResolvedValue({
      data: { resourceName: "people/new1", metadata: { sources: [{ etag: 'W/"e1"' }] } },
    });
    const updateContact = vi.fn();
    const list = vi.fn();
    const sync = createGoogleSync({ secrets, createPeopleClient: () => ({ people: { connections: { list }, createContact, updateContact, deleteContact: vi.fn() } }) });

    const result = await sync.push(baseContact({ name: "Ada Lovelace" }));

    expect(result).toEqual({ resourceName: "people/new1", etag: 'W/"e1"' });
    expect(updateContact).not.toHaveBeenCalled();
    expect(createContact).toHaveBeenCalledWith({ requestBody: { names: [{ givenName: "Ada Lovelace" }] } });
  });

  it("updates an existing linked contact via updateContact, sending the field mask and the stored etag", async () => {
    const secrets = await seededSecrets();
    const updateContact = vi.fn().mockResolvedValue({
      data: { resourceName: "people/existing", metadata: { sources: [{ etag: 'W/"e2"' }] } },
    });
    const createContact = vi.fn();
    const list = vi.fn();
    const sync = createGoogleSync({ secrets, createPeopleClient: () => ({ people: { connections: { list }, createContact, updateContact, deleteContact: vi.fn() } }) });

    const result = await sync.push(
      baseContact({ name: "Ada Lovelace", googleResourceName: "people/existing", googleEtag: 'W/"old"' }),
    );

    expect(result).toEqual({ resourceName: "people/existing", etag: 'W/"e2"' });
    expect(createContact).not.toHaveBeenCalled();
    expect(updateContact).toHaveBeenCalledWith({
      resourceName: "people/existing",
      updatePersonFields: "names,organizations,emailAddresses,phoneNumbers",
      requestBody: {
        names: [{ givenName: "Ada Lovelace" }],
        metadata: { sources: [{ etag: 'W/"old"' }] },
      },
    });
  });

  it("surfaces a clear, contact-named conflict error (not the raw API error) on a 400 — never silently overwrites", async () => {
    const secrets = await seededSecrets();
    const conflictErr = Object.assign(new Error("Precondition check failed."), { code: 400 });
    const updateContact = vi.fn().mockRejectedValue(conflictErr);
    const createContact = vi.fn();
    const list = vi.fn();
    const sync = createGoogleSync({ secrets, createPeopleClient: () => ({ people: { connections: { list }, createContact, updateContact, deleteContact: vi.fn() } }) });

    await expect(
      sync.push(baseContact({ name: "Ada Lovelace", googleResourceName: "people/existing", googleEtag: 'W/"stale"' })),
    ).rejects.toThrow(/Ada Lovelace.*changed on Google/i);
    expect(createContact).not.toHaveBeenCalled();
  });

  it("falls back to createContact (re-creates) when updateContact 404s — never treats the local row as orphaned", async () => {
    const secrets = await seededSecrets();
    const notFoundErr = Object.assign(new Error("Requested entity was not found."), { code: 404 });
    const updateContact = vi.fn().mockRejectedValue(notFoundErr);
    const createContact = vi.fn().mockResolvedValue({
      data: { resourceName: "people/recreated", metadata: { sources: [{ etag: 'W/"e3"' }] } },
    });
    const list = vi.fn();
    const sync = createGoogleSync({ secrets, createPeopleClient: () => ({ people: { connections: { list }, createContact, updateContact, deleteContact: vi.fn() } }) });

    const result = await sync.push(
      baseContact({ name: "Ada Lovelace", googleResourceName: "people/gone", googleEtag: 'W/"old"' }),
    );

    expect(result).toEqual({ resourceName: "people/recreated", etag: 'W/"e3"' });
    expect(createContact).toHaveBeenCalledTimes(1);
  });

  it("rethrows any other error unchanged (not a 400 or 404)", async () => {
    const secrets = await seededSecrets();
    const serverErr = Object.assign(new Error("Internal error."), { code: 500 });
    const updateContact = vi.fn().mockRejectedValue(serverErr);
    const createContact = vi.fn();
    const list = vi.fn();
    const sync = createGoogleSync({ secrets, createPeopleClient: () => ({ people: { connections: { list }, createContact, updateContact, deleteContact: vi.fn() } }) });

    await expect(
      sync.push(baseContact({ name: "Ada Lovelace", googleResourceName: "people/existing", googleEtag: 'W/"x"' })),
    ).rejects.toThrow("Internal error.");
    expect(createContact).not.toHaveBeenCalled();
  });

  it("throws a clear error if createContact's response is missing a resourceName, rather than returning a broken link", async () => {
    const secrets = await seededSecrets();
    const createContact = vi.fn().mockResolvedValue({ data: {} });
    const updateContact = vi.fn();
    const list = vi.fn();
    const sync = createGoogleSync({ secrets, createPeopleClient: () => ({ people: { connections: { list }, createContact, updateContact, deleteContact: vi.fn() } }) });

    await expect(sync.push(baseContact({ name: "Ada Lovelace" }))).rejects.toThrow(/resourceName/);
  });
});

describe("createGoogleSync().deleteContact()", () => {
  async function seededSecrets() {
    const secrets = createInMemorySecretsAdapter();
    await secrets.set(GOOGLE_OAUTH_CLIENT_KEY, JSON.stringify({ clientId: "cid", clientSecret: "csecret" }));
    await secrets.set(GOOGLE_OAUTH_TOKEN_KEY, JSON.stringify({ access_token: "at", refresh_token: "rt" }));
    return secrets;
  }

  it("calls the real client's deleteContact with the resourceName", async () => {
    const secrets = await seededSecrets();
    const deleteContact = vi.fn().mockResolvedValue(undefined);
    const sync = createGoogleSync({
      secrets,
      createPeopleClient: () => ({
        people: { connections: { list: vi.fn() }, createContact: vi.fn(), updateContact: vi.fn(), deleteContact },
      }),
    });

    await sync.deleteContact("people/gone");
    expect(deleteContact).toHaveBeenCalledWith({ resourceName: "people/gone" });
  });

  it("treats a 404 (already gone) as success, not an error", async () => {
    const secrets = await seededSecrets();
    const notFoundErr = Object.assign(new Error("not found"), { code: 404 });
    const deleteContact = vi.fn().mockRejectedValue(notFoundErr);
    const sync = createGoogleSync({
      secrets,
      createPeopleClient: () => ({
        people: { connections: { list: vi.fn() }, createContact: vi.fn(), updateContact: vi.fn(), deleteContact },
      }),
    });

    await expect(sync.deleteContact("people/already-gone")).resolves.toBeUndefined();
  });

  it("rethrows any other error", async () => {
    const secrets = await seededSecrets();
    const serverErr = Object.assign(new Error("Internal error."), { code: 500 });
    const deleteContact = vi.fn().mockRejectedValue(serverErr);
    const sync = createGoogleSync({
      secrets,
      createPeopleClient: () => ({
        people: { connections: { list: vi.fn() }, createContact: vi.fn(), updateContact: vi.fn(), deleteContact },
      }),
    });

    await expect(sync.deleteContact("people/x")).rejects.toThrow("Internal error.");
  });
});

describe("deleteContactEverywhere", () => {
  function fakeStore(contact: Contact | undefined): { store: DeletableStore; deleteCalls: string[] } {
    const deleteCalls: string[] = [];
    const store: DeletableStore = {
      get: (id) => (contact && contact.id === id ? contact : undefined),
      delete: (id) => {
        deleteCalls.push(id);
        return Boolean(contact && contact.id === id);
      },
    };
    return { store, deleteCalls };
  }

  it("returns deleted:false and never calls delete on either side when the contact doesn't exist locally", async () => {
    const { store, deleteCalls } = fakeStore(undefined);
    const deleteContact = vi.fn();
    const google: Pick<GoogleSync, "deleteContact"> = { deleteContact };

    const summary = await deleteContactEverywhere("missing-id", store, google);

    expect(summary).toEqual({ deleted: false });
    expect(deleteCalls).toEqual([]);
    expect(deleteContact).not.toHaveBeenCalled();
  });

  it("deletes locally only, without calling Google, when the contact has no googleResourceName", async () => {
    const contact = baseContact({ id: "local-only" });
    const { store } = fakeStore(contact);
    const deleteContact = vi.fn();

    const summary = await deleteContactEverywhere("local-only", store, { deleteContact });

    expect(summary).toEqual({ deleted: true });
    expect(deleteContact).not.toHaveBeenCalled();
  });

  it("deletes locally AND calls Google's deleteContact when the contact is linked", async () => {
    const contact = baseContact({ id: "linked", googleResourceName: "people/c1" });
    const { store } = fakeStore(contact);
    const deleteContact = vi.fn().mockResolvedValue(undefined);

    const summary = await deleteContactEverywhere("linked", store, { deleteContact });

    expect(summary).toEqual({ deleted: true });
    expect(deleteContact).toHaveBeenCalledWith("people/c1");
  });

  it("still reports deleted:true (local delete is not rolled back) when the Google-side delete fails, and surfaces the error", async () => {
    const contact = baseContact({ id: "linked", googleResourceName: "people/c1" });
    const { store } = fakeStore(contact);
    const deleteContact = vi.fn().mockRejectedValue(new Error("Google isn't connected yet"));

    const summary = await deleteContactEverywhere("linked", store, { deleteContact });

    expect(summary.deleted).toBe(true);
    expect(summary.googleDeleteError).toMatch(/isn't connected/);
  });
});

// ---------------------------------------------------------------------------
// findExistingMatch / mergeLocalOnlyFields — the "local fields survive sync"
// building blocks, unit-tested directly.
// ---------------------------------------------------------------------------
describe("findExistingMatch", () => {
  it("matches by googleResourceName first", () => {
    const pulled = baseContact({ googleResourceName: "people/1", email: "a@example.com" });
    const byResourceName = baseContact({ id: "r1", googleResourceName: "people/1" });
    const byEmail = baseContact({ id: "r2", googleResourceName: "people/other", email: "a@example.com" });
    expect(findExistingMatch(pulled, [byEmail, byResourceName])).toBe(byResourceName);
  });

  it("falls back to email when googleResourceName has no match", () => {
    const pulled = baseContact({ googleResourceName: "people/new", email: "a@example.com" });
    const byEmail = baseContact({ id: "r2", email: "a@example.com" });
    expect(findExistingMatch(pulled, [byEmail])).toBe(byEmail);
  });

  it("returns undefined when nothing matches", () => {
    const pulled = baseContact({ googleResourceName: "people/new", email: "new@example.com" });
    expect(findExistingMatch(pulled, [baseContact({ id: "r3", email: "someone-else@example.com" })])).toBeUndefined();
  });
});

describe("mergeLocalOnlyFields", () => {
  it("returns the pulled contact unchanged when there's no existing match", () => {
    const pulled = baseContact({ name: "New Person" });
    expect(mergeLocalOnlyFields(pulled, undefined)).toEqual(pulled);
  });

  it("carries the existing row's id/verdict/nextStep/angle/met/what/tags/createdAt onto the pulled contact", () => {
    const pulled = baseContact({
      id: "should-be-discarded",
      name: "Updated From Google",
      org: "New Org",
      verdict: "none",
      createdAt: "2026-06-01T00:00:00.000Z",
    });
    const existing = baseContact({
      id: "real-local-id",
      name: "Old Name",
      verdict: "strong",
      nextStep: "Send proposal",
      angle: "co-marketing",
      met: "conference",
      what: "runs a fintech startup",
      tags: ["vip"],
      createdAt: "2025-01-01T00:00:00.000Z",
    });

    const merged = mergeLocalOnlyFields(pulled, existing);

    // Synced fields come from the pulled (fresh-from-Google) contact.
    expect(merged.name).toBe("Updated From Google");
    expect(merged.org).toBe("New Org");
    // Local-only + identity fields come from the existing row, untouched.
    expect(merged.id).toBe("real-local-id");
    expect(merged.verdict).toBe("strong");
    expect(merged.nextStep).toBe("Send proposal");
    expect(merged.angle).toBe("co-marketing");
    expect(merged.met).toBe("conference");
    expect(merged.what).toBe("runs a fintech startup");
    expect(merged.tags).toEqual(["vip"]);
    expect(merged.createdAt).toBe("2025-01-01T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// applyPullToStore — integration against a real Store (temp-file sqlite),
// proving the actual dedup + "local fields survive sync" invariant end to
// end: a contact pulled with the same resourceName as an existing,
// manually-added contact dedups to one row, and that row's pre-existing
// verdict/nextStep survive the sync untouched.
// ---------------------------------------------------------------------------
describe("applyPullToStore (integration with a real Store)", () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "rolodex-google-sync-test-"));
    store = new Store(path.join(dir, "rolodex.db"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("dedups a pulled contact against an existing manually-added one by googleResourceName, ending with one row not two", () => {
    const manual = store.upsert(
      baseContact({
        id: "",
        googleResourceName: "people/c123",
        name: "Manually Typed Name",
        verdict: "strong",
        nextStep: "Send follow-up",
        createdAt: "",
      }),
    );

    const pulled = mapPersonToContact({
      resourceName: "people/c123",
      names: [{ displayName: "Name From Google" }],
      organizations: [{ name: "Acme Corp" }],
      emailAddresses: [{ value: "person@acme.example" }],
    });

    const summary = applyPullToStore([pulled], store);

    const all = store.list();
    expect(all).toHaveLength(1);
    expect(summary).toEqual({ pulled: 1, created: 0, updated: 1 });
    expect(all[0]!.id).toBe(manual.id);
  });

  it("leaves the pre-existing verdict and nextStep untouched by the sync (local fields survive sync)", () => {
    store.upsert(
      baseContact({
        id: "",
        googleResourceName: "people/c123",
        name: "Manually Typed Name",
        verdict: "strong",
        nextStep: "Send follow-up",
        angle: "potential co-founder",
        createdAt: "",
      }),
    );

    const pulled = mapPersonToContact({
      resourceName: "people/c123",
      names: [{ displayName: "Name From Google" }],
      organizations: [{ name: "Acme Corp" }],
    });
    // Sanity: the raw pulled contact (pre-merge) has none of the local
    // fields — if applyPullToStore just forwarded this to upsert() as-is,
    // it WOULD clobber the existing row's verdict/nextStep/angle.
    expect(pulled.verdict).toBe("none");
    expect(pulled.nextStep).toBeUndefined();

    applyPullToStore([pulled], store);

    const [row] = store.list();
    expect(row).toMatchObject({
      verdict: "strong",
      nextStep: "Send follow-up",
      angle: "potential co-founder",
      // Synced fields DID pick up the fresher Google-side values.
      name: "Name From Google",
      org: "Acme Corp",
    });
  });

  it("falls back to matching by email when googleResourceName isn't already linked", () => {
    const manual = store.upsert(
      baseContact({ id: "", email: "person@example.com", name: "Manual Entry", verdict: "watch", createdAt: "" }),
    );

    const pulled = mapPersonToContact({
      resourceName: "people/new-link",
      names: [{ displayName: "Person Name" }],
      emailAddresses: [{ value: "person@example.com" }],
    });

    const summary = applyPullToStore([pulled], store);

    const all = store.list();
    expect(all).toHaveLength(1);
    expect(summary).toEqual({ pulled: 1, created: 0, updated: 1 });
    expect(all[0]).toMatchObject({ id: manual.id, verdict: "watch", googleResourceName: "people/new-link" });
  });

  it("creates a new row for a pulled contact with no local match", () => {
    const pulled = mapPersonToContact({ resourceName: "people/brand-new", names: [{ displayName: "Brand New" }] });
    const summary = applyPullToStore([pulled], store);
    expect(summary).toEqual({ pulled: 1, created: 1, updated: 0 });
    expect(store.list()).toHaveLength(1);
  });

  it("processes a full batch: mixes new and existing contacts in one pull", () => {
    store.upsert(baseContact({ id: "", googleResourceName: "people/existing", verdict: "pass", createdAt: "" }));

    const summary = applyPullToStore(
      [
        mapPersonToContact({ resourceName: "people/existing", names: [{ displayName: "Still Here" }] }),
        mapPersonToContact({ resourceName: "people/brand-new", names: [{ displayName: "New Person" }] }),
      ],
      store,
    );

    expect(summary).toEqual({ pulled: 2, created: 1, updated: 1 });
    expect(store.list()).toHaveLength(2);
    const existingRow = store.list().find((c) => c.googleResourceName === "people/existing");
    expect(existingRow?.verdict).toBe("pass");
  });
});
