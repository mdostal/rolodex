import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRolodexMcpServer, type RolodexMcpHandlers } from "./server.js";
import { Store } from "../lib/store.js";
import { createInMemorySecretsAdapter } from "../lib/secrets-adapter.js";
import { createGoogleSync, type PeopleApiClient } from "../lib/google-sync.js";

const GOOGLE_OAUTH_CLIENT_KEY = "google.oauth.client";
const GOOGLE_OAUTH_TOKEN_KEY = "google.oauth.token";

let dir: string;
let dbPath: string;
let store: Store;
let handlers: RolodexMcpHandlers;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "rolodex-mcp-server-test-"));
  dbPath = path.join(dir, "rolodex.db");
  store = new Store(dbPath);
  ({ handlers } = createRolodexMcpServer({ store }));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Every handler's CallToolResult puts its payload as JSON text in
 * content[0].text — this pulls it back out and parses it, the shape every
 * test below actually wants to assert against. */
function parseResult(result: { content: Array<{ type: string; text?: string }> }): unknown {
  const first = result.content[0];
  expect(first?.type).toBe("text");
  return JSON.parse(first!.text!);
}

describe("rolodex_upsert", () => {
  it("persists a new contact and returns it", async () => {
    const result = await handlers.rolodex_upsert({ name: "Ada Lovelace", org: "Analytical Engines", verdict: "strong" });
    expect(result.isError).toBeUndefined();
    const saved = parseResult(result) as { id: string; name: string; org: string; verdict: string };
    expect(saved.name).toBe("Ada Lovelace");
    expect(saved.org).toBe("Analytical Engines");
    expect(saved.verdict).toBe("strong");
    expect(saved.id).toBeTruthy();

    // Actually landed in the store, not just echoed back.
    expect(store.get(saved.id)).toMatchObject({ name: "Ada Lovelace", org: "Analytical Engines" });
  });

  it("updates an existing contact when the same id round-trips", async () => {
    const first = parseResult(await handlers.rolodex_upsert({ name: "Grace Hopper" })) as { id: string };
    const second = parseResult(
      await handlers.rolodex_upsert({ id: first.id, name: "Grace Murray Hopper" }),
    ) as { id: string; name: string };

    expect(second.id).toBe(first.id);
    expect(second.name).toBe("Grace Murray Hopper");
    expect(store.list()).toHaveLength(1);
  });
});

describe("rolodex_search", () => {
  it("returns real matches from the store", async () => {
    await handlers.rolodex_upsert({ name: "Ada Lovelace", org: "Analytical Engines" });
    await handlers.rolodex_upsert({ name: "Grace Hopper", org: "US Navy" });

    const result = await handlers.rolodex_search({ query: "Analytical" });
    const parsed = parseResult(result) as Array<{ contact: { name: string } }>;
    expect(parsed.map((r) => r.contact.name)).toEqual(["Ada Lovelace"]);
  });

  it("respects verdict + limit options", async () => {
    await handlers.rolodex_upsert({ name: "Strong One", org: "SharedTerm", verdict: "strong" });
    await handlers.rolodex_upsert({ name: "Watch One", org: "SharedTerm", verdict: "watch" });

    const filtered = parseResult(
      await handlers.rolodex_search({ query: "SharedTerm", verdict: "strong" }),
    ) as Array<{ contact: { name: string } }>;
    expect(filtered.map((r) => r.contact.name)).toEqual(["Strong One"]);

    const limited = parseResult(await handlers.rolodex_search({ query: "SharedTerm", limit: 1 })) as unknown[];
    expect(limited).toHaveLength(1);
  });
});

describe("rolodex_followups", () => {
  const DAY = 86_400_000;
  const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

  it("reflects a real overdue contact", async () => {
    // Backdated createdAt can't come through the MCP arg shape (upsert's
    // zod schema has no createdAt field, by design) — write it directly
    // through the same Store instance, same pattern server.test.ts uses.
    const stale = store.upsert({
      id: "",
      name: "Stale Contact",
      verdict: "none",
      nextStep: "Send intro",
      createdAt: iso(40 * DAY),
      updatedAt: iso(40 * DAY),
    });

    const result = await handlers.rolodex_followups({});
    const parsed = parseResult(result) as Array<{ id: string }>;
    expect(parsed.map((c) => c.id)).toEqual([stale.id]);
  });

  it("excludes a contact with no nextStep", async () => {
    store.upsert({ id: "", name: "No Next Step", verdict: "none", createdAt: iso(60 * DAY), updatedAt: iso(60 * DAY) });
    const result = await handlers.rolodex_followups({ withinDays: 30 });
    expect(parseResult(result)).toEqual([]);
  });
});

describe("rolodex_log_interaction", () => {
  it("persists an interaction and it appears in history", async () => {
    const contact = parseResult(await handlers.rolodex_upsert({ name: "Ada Lovelace" })) as { id: string };

    const result = await handlers.rolodex_log_interaction({
      contactId: contact.id,
      note: "Great call about follow-up.",
      channel: "call",
    });
    const created = parseResult(result) as { id: string; contactId: string; note: string; channel: string; at: string };
    expect(created.contactId).toBe(contact.id);
    expect(created.note).toBe("Great call about follow-up.");
    expect(created.channel).toBe("call");
    expect(created.id).toBeTruthy();
    expect(created.at).toBeTruthy();

    const history = store.listInteractions(contact.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ id: created.id, note: "Great call about follow-up." });
  });

  it("defaults `at` to now when omitted", async () => {
    const contact = parseResult(await handlers.rolodex_upsert({ name: "Ada Lovelace" })) as { id: string };
    const created = parseResult(
      await handlers.rolodex_log_interaction({ contactId: contact.id, note: "No date given" }),
    ) as { at: string };
    expect(new Date(created.at).toISOString().slice(0, 10)).toBe(new Date().toISOString().slice(0, 10));
  });
});

describe("rolodex_delete", () => {
  it("deletes an existing contact", async () => {
    const contact = parseResult(await handlers.rolodex_upsert({ name: "Ada Lovelace" })) as { id: string };

    const result = await handlers.rolodex_delete({ contactId: contact.id });
    const payload = parseResult(result) as { deleted: boolean; id: string; name: string };
    expect(payload).toEqual({ deleted: true, id: contact.id, name: "Ada Lovelace" });
    expect(store.get(contact.id)).toBeUndefined();
  });

  it("also deletes the contact's interaction history", async () => {
    const contact = parseResult(await handlers.rolodex_upsert({ name: "Ada Lovelace" })) as { id: string };
    await handlers.rolodex_log_interaction({ contactId: contact.id, note: "Called once" });

    await handlers.rolodex_delete({ contactId: contact.id });

    expect(store.listInteractions(contact.id)).toHaveLength(0);
  });

  it("returns isError for an unknown contact id, without throwing", async () => {
    const result = await handlers.rolodex_delete({ contactId: "does-not-exist" });
    expect(result.isError).toBe(true);
  });
});

describe("rolodex_sync_google", () => {
  async function seededSecrets() {
    const secrets = createInMemorySecretsAdapter();
    await secrets.set(GOOGLE_OAUTH_CLIENT_KEY, JSON.stringify({ clientId: "cid", clientSecret: "csecret" }));
    await secrets.set(GOOGLE_OAUTH_TOKEN_KEY, JSON.stringify({ access_token: "at", refresh_token: "rt" }));
    return secrets;
  }

  it("pull populates contacts and preserves local-only fields on an already-existing contact", async () => {
    // A manually-added contact with local-only fields set (verdict/nextStep)
    // that a Google pull must NOT clobber — mirrors google-sync.test.ts's
    // own "local fields survive sync" invariant check.
    store.upsert({
      id: "",
      googleResourceName: "people/c123",
      name: "Manually Typed Name",
      verdict: "strong",
      nextStep: "Send follow-up",
      createdAt: "",
      updatedAt: "",
    });

    const secrets = await seededSecrets();
    const list = async () => ({
      data: {
        connections: [
          {
            resourceName: "people/c123",
            names: [{ displayName: "Name From Google" }],
            organizations: [{ name: "Acme Corp" }],
          },
          {
            resourceName: "people/brand-new",
            names: [{ displayName: "Brand New Person" }],
          },
        ],
      },
    });
    const fakeClient: PeopleApiClient = { people: { connections: { list } } };
    const google = createGoogleSync({ secrets, createPeopleClient: () => fakeClient });

    ({ handlers } = createRolodexMcpServer({ store, google }));
    const result = await handlers.rolodex_sync_google({ direction: "pull" });
    expect(result.isError).toBeUndefined();
    const summary = parseResult(result) as { pulled: number; created: number; updated: number };
    expect(summary).toEqual({ pulled: 2, created: 1, updated: 1 });

    const all = store.list();
    expect(all).toHaveLength(2);
    const existingRow = all.find((c) => c.googleResourceName === "people/c123");
    expect(existingRow).toMatchObject({
      name: "Name From Google", // synced field updated
      org: "Acme Corp",
      verdict: "strong", // local-only field survived
      nextStep: "Send follow-up", // local-only field survived
    });
  });

  it("direction 'both' runs the pull half for real and notes push wasn't performed", async () => {
    const secrets = await seededSecrets();
    const list = async () => ({ data: { connections: [{ resourceName: "people/1", names: [{ displayName: "One" }] }] } });
    const google = createGoogleSync({ secrets, createPeopleClient: () => ({ people: { connections: { list } } }) });
    ({ handlers } = createRolodexMcpServer({ store, google }));

    const result = await handlers.rolodex_sync_google({ direction: "both" });
    expect(result.isError).toBeUndefined();
    const summary = parseResult(result) as { pulled: number; created: number; updated: number; pushed: boolean };
    expect(summary).toMatchObject({ pulled: 1, created: 1, updated: 0, pushed: false });
    expect(store.list()).toHaveLength(1);
  });

  it("direction 'push' returns isError:true without crashing and never calls pull/push", async () => {
    let pullCalled = false;
    const google = {
      async pull() {
        pullCalled = true;
        return [];
      },
      async push() {
        throw new Error("should never be called");
      },
    };
    ({ handlers } = createRolodexMcpServer({ store, google }));

    const result = await handlers.rolodex_sync_google({ direction: "push" });
    expect(result.isError).toBe(true);
    const parsed = parseResult(result) as { error: string };
    expect(parsed.error).toMatch(/not implemented/i);
    expect(pullCalled).toBe(false);
  });
});

describe("error handling — a thrown error from the underlying Store/GoogleSync never escapes the handler", () => {
  it("rolodex_log_interaction: Store.logInteraction() throwing (empty note) surfaces as isError:true, not a throw", async () => {
    const contact = parseResult(await handlers.rolodex_upsert({ name: "Ada Lovelace" })) as { id: string };

    // note is empty -> Store.logInteraction() throws "note is required"
    // (src/lib/store.ts) — the handler must catch it, not propagate.
    await expect(handlers.rolodex_log_interaction({ contactId: contact.id, note: "   " })).resolves.not.toThrow();
    const result = await handlers.rolodex_log_interaction({ contactId: contact.id, note: "" });
    expect(result.isError).toBe(true);
    const parsed = parseResult(result) as { error: string };
    expect(parsed.error).toMatch(/note is required/i);
  });

  it("rolodex_sync_google pull: GoogleSync.pull() rejecting (no OAuth configured) surfaces as isError:true, not a throw", async () => {
    const google = createGoogleSync({ secrets: createInMemorySecretsAdapter() });
    ({ handlers } = createRolodexMcpServer({ store, google }));

    const result = await handlers.rolodex_sync_google({ direction: "pull" });
    expect(result.isError).toBe(true);
    const parsed = parseResult(result) as { error: string };
    expect(parsed.error).toMatch(/isn't connected/i);
  });

  it("rolodex_upsert: a Store that throws surfaces as isError:true, not a throw", async () => {
    const throwingStore = {
      upsert() {
        throw new Error("boom: disk full");
      },
    } as unknown as Store;
    ({ handlers } = createRolodexMcpServer({ store: throwingStore }));

    const result = await handlers.rolodex_upsert({ name: "Doesn't matter" });
    expect(result.isError).toBe(true);
    const parsed = parseResult(result) as { error: string };
    expect(parsed.error).toMatch(/boom: disk full/);
  });
});
