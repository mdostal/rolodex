import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyPullToStore,
  createGoogleSync,
  findExistingMatch,
  mapPersonToContact,
  mergeLocalOnlyFields,
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
    const fakeClient: PeopleApiClient = { people: { connections: { list } } };

    const sync = createGoogleSync({ secrets, createPeopleClient: () => fakeClient });
    const contacts = await sync.pull();

    expect(contacts.map((c) => c.name)).toEqual(["One", "Two", "Three"]);
    expect(list).toHaveBeenCalledTimes(2);
    // First call: no pageToken. Second call: forwards the prior page's
    // nextPageToken. Both calls request the same resourceName/personFields.
    expect(list.mock.calls[0]![0]).toMatchObject({
      resourceName: "people/me",
      personFields: "names,organizations,emailAddresses,phoneNumbers",
      pageToken: undefined,
    });
    expect(list.mock.calls[1]![0]).toMatchObject({ pageToken: "page-2" });
  });

  it("returns an empty array when the account has no connections", async () => {
    const secrets = await seededSecrets();
    const list = vi.fn().mockResolvedValueOnce({ data: {} });
    const sync = createGoogleSync({ secrets, createPeopleClient: () => ({ people: { connections: { list } } }) });
    expect(await sync.pull()).toEqual([]);
  });

  it("stops after a single page when the first response has no nextPageToken", async () => {
    const secrets = await seededSecrets();
    const list = vi.fn().mockResolvedValueOnce({
      data: { connections: [{ resourceName: "people/1", names: [{ displayName: "Solo" }] }] },
    });
    const sync = createGoogleSync({ secrets, createPeopleClient: () => ({ people: { connections: { list } } }) });
    const contacts = await sync.pull();
    expect(contacts).toHaveLength(1);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("throws an actionable error when no OAuth client is stored", async () => {
    const secrets = createInMemorySecretsAdapter();
    const sync = createGoogleSync({ secrets, createPeopleClient: () => ({ people: { connections: { list: vi.fn() } } }) });
    await expect(sync.pull()).rejects.toThrow(/isn't connected/i);
  });

  it("throws an actionable error when the OAuth client is stored but corrupt", async () => {
    const secrets = createInMemorySecretsAdapter();
    await secrets.set(GOOGLE_OAUTH_CLIENT_KEY, "not json");
    const sync = createGoogleSync({ secrets, createPeopleClient: () => ({ people: { connections: { list: vi.fn() } } }) });
    await expect(sync.pull()).rejects.toThrow(/corrupt/i);
  });

  it("throws an actionable error when the OAuth client is stored but incomplete", async () => {
    const secrets = createInMemorySecretsAdapter();
    await secrets.set(GOOGLE_OAUTH_CLIENT_KEY, JSON.stringify({ clientId: "only-id" }));
    const sync = createGoogleSync({ secrets, createPeopleClient: () => ({ people: { connections: { list: vi.fn() } } }) });
    await expect(sync.pull()).rejects.toThrow(/incomplete/i);
  });

  it("throws an actionable error when the client is configured but no token is stored yet (sign-in not done)", async () => {
    const secrets = createInMemorySecretsAdapter();
    await secrets.set(GOOGLE_OAUTH_CLIENT_KEY, JSON.stringify({ clientId: "cid", clientSecret: "csecret" }));
    const sync = createGoogleSync({ secrets, createPeopleClient: () => ({ people: { connections: { list: vi.fn() } } }) });
    await expect(sync.pull()).rejects.toThrow(/sign-in/i);
  });

  it("never calls the People client at all when credentials are missing", async () => {
    const secrets = createInMemorySecretsAdapter();
    const list = vi.fn();
    const sync = createGoogleSync({ secrets, createPeopleClient: () => ({ people: { connections: { list } } }) });
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
        return { people: { connections: { list } } };
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

describe("createGoogleSync().push()", () => {
  it("stays an unimplemented stub (explicitly out of scope for this story)", async () => {
    const sync = createGoogleSync({ secrets: createInMemorySecretsAdapter() });
    await expect(sync.push(baseContact())).rejects.toThrow(/not implemented/i);
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
