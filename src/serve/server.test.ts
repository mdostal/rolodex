import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Store } from "../lib/store.js";
import { createServeServer, type ServeServer } from "./server.js";

/**
 * End-to-end HTTP tests for `rolodex serve` (contacts-memory cm-04).
 *
 * The signature is computed HERE, from the scheme as written in the story,
 * not with the server's own helper, so a bug shared by signer and verifier
 * cannot make these pass:
 *   hex(HMAC-SHA256(token, method \n path \n sha256(body) \n scopes \n ts))
 */

const TOKEN = "test-service-token-0123456789abcdef";

type WireScopeSet = { read: Array<{ kind: string; id: string }>; write?: { kind: string; id: string } };

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function sign(token: string, method: string, pathname: string, body: string, scopes: string, ts: string): string {
  return createHmac("sha256", token)
    .update(`${method}\n${pathname}\n${sha256Hex(body)}\n${scopes}\n${ts}`)
    .digest("hex");
}

interface CallOpts {
  token?: string;
  /** Scopes sent in the header. */
  scopes?: WireScopeSet | string;
  /** Scopes the signature is computed over (defaults to the header's). */
  signScopes?: string;
  ts?: number;
  sig?: string | null;
  omit?: Array<"auth" | "scopes" | "ts" | "sig">;
}

let tmp: string;
let store: Store;
let server: ServeServer;
let base: string;
let now: number;

beforeEach(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "rolodex-serve-"));
  store = new Store(path.join(tmp, "serve.db"));
  now = Date.now();
  server = createServeServer({ store, token: TOKEN, version: "9.9.9", now: () => now, log: () => {} });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(tmp, { recursive: true, force: true });
});

const A: WireScopeSet = { read: [{ kind: "client", id: "a" }], write: { kind: "client", id: "a" } };
const B: WireScopeSet = { read: [{ kind: "client", id: "b" }], write: { kind: "client", id: "b" } };
const READ_A: WireScopeSet = { read: [{ kind: "client", id: "a" }] };
const READ_AB: WireScopeSet = { read: [{ kind: "client", id: "a" }, { kind: "client", id: "b" }] };

async function call(op: string, body: unknown, opts: CallOpts = {}): Promise<{ status: number; json: any }> {
  const pathname = `/v1/${op}`;
  const raw = JSON.stringify(body);
  const scopes = typeof opts.scopes === "string" ? opts.scopes : JSON.stringify(opts.scopes ?? READ_A);
  const ts = String(opts.ts ?? now);
  const sig = opts.sig === undefined ? sign(opts.token ?? TOKEN, "POST", pathname, raw, opts.signScopes ?? scopes, ts) : opts.sig;
  const omit = new Set(opts.omit ?? []);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (!omit.has("auth")) headers.authorization = `Bearer ${opts.token ?? TOKEN}`;
  if (!omit.has("scopes")) headers["x-rolodex-scopes"] = scopes;
  if (!omit.has("ts")) headers["x-rolodex-ts"] = ts;
  if (!omit.has("sig") && sig !== null) headers["x-rolodex-sig"] = sig;
  const res = await fetch(base + pathname, { method: "POST", headers, body: raw });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
}

async function seed(scopes: WireScopeSet, name: string, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await call("upsert", { contact: { name, ...extra } }, { scopes });
  expect(r.status).toBe(200);
  return r.json.contact.id as string;
}

describe("GET /v1/health", () => {
  it("answers 200 with version without any auth", async () => {
    const res = await fetch(base + "/v1/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.version).toBe("9.9.9");
    expect(typeof body.schema).toBe("string");
  });
});

describe("authentication and request signature", () => {
  it("accepts a correctly signed request", async () => {
    const r = await call("search", { query: "" });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ contacts: [] });
  });

  it("rejects a missing bearer token with 401", async () => {
    expect((await call("search", { query: "" }, { omit: ["auth"] })).status).toBe(401);
  });

  it("rejects a wrong bearer token with 401, even when signed with that token", async () => {
    expect((await call("search", { query: "" }, { token: "x".repeat(TOKEN.length) })).status).toBe(401);
  });

  it("rejects a missing signature, scopes or timestamp header with 401", async () => {
    for (const h of ["sig", "scopes", "ts"] as const) {
      expect((await call("search", { query: "" }, { omit: [h] })).status, h).toBe(401);
    }
  });

  it("rejects a garbage signature with 401", async () => {
    expect((await call("search", { query: "" }, { sig: "00" })).status).toBe(401);
    expect((await call("search", { query: "" }, { sig: "zz".repeat(32) })).status).toBe(401);
  });

  it("rejects a signature over a different body with 401", async () => {
    const pathname = "/v1/search";
    const scopes = JSON.stringify(READ_A);
    const ts = String(now);
    const sig = sign(TOKEN, "POST", pathname, JSON.stringify({ query: "other" }), scopes, ts);
    expect((await call("search", { query: "" }, { sig })).status).toBe(401);
  });

  it("rejects a signature over a different path with 401", async () => {
    const scopes = JSON.stringify(READ_A);
    const ts = String(now);
    const raw = JSON.stringify({ query: "" });
    const sig = sign(TOKEN, "POST", "/v1/get", raw, scopes, ts);
    expect((await call("search", { query: "" }, { sig })).status).toBe(401);
  });

  it("given a valid token but a signature over different scopes, answers 401 and reads nothing", async () => {
    await seed(A, "Alice A");
    await seed(B, "Bob B");
    const spies = (["search", "list", "get", "listInteractions", "links", "connections", "candidates"] as const).map(
      (m) => vi.spyOn(store, m),
    );
    const r = await call("search", { query: "" }, { scopes: READ_AB, signScopes: JSON.stringify(READ_A) });
    expect(r.status).toBe(401);
    expect(r.json).toEqual({ error: "unauthorized" });
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });

  it("rejects a timestamp 61 s old with 401", async () => {
    expect((await call("search", { query: "" }, { ts: now - 61_000 })).status).toBe(401);
  });

  it("accepts a timestamp 59 s old", async () => {
    expect((await call("search", { query: "" }, { ts: now - 59_000 })).status).toBe(200);
  });

  it("rejects a timestamp more than 60 s in the future with 401", async () => {
    expect((await call("search", { query: "" }, { ts: now + 61_000 })).status).toBe(401);
  });

  it("rejects a non-numeric timestamp with 401", async () => {
    expect((await call("search", { query: "" }, { ts: "yesterday" as unknown as number })).status).toBe(401);
  });

  it("rejects malformed scopes with 401, even when correctly signed", async () => {
    for (const scopes of [
      "not json",
      JSON.stringify({ read: [] }),
      JSON.stringify({ read: [{ kind: "nope", id: "a" }] }),
      JSON.stringify({ read: [{ kind: "client", id: "" }] }),
      JSON.stringify({ read: "client:a" }),
      JSON.stringify({ read: [{ kind: "client", id: "a" }], write: { kind: "client" } }),
    ]) {
      expect((await call("search", { query: "" }, { scopes })).status, scopes).toBe(401);
    }
  });

  it("never echoes the token in a response", async () => {
    const r = await call("search", { query: "" }, { sig: "00" });
    expect(JSON.stringify(r.json)).not.toContain(TOKEN);
  });

  it("answers 404 for an unknown route (after auth)", async () => {
    expect((await call("nope", {})).status).toBe(404);
  });

  it("answers 405 for GET on an operation route", async () => {
    const res = await fetch(base + "/v1/search");
    expect(res.status).toBe(405);
  });
});

describe("scope pass-through (end to end over HTTP)", () => {
  it("with read [client:a], returns only client:a data", async () => {
    const a = await seed(A, "Shared Name Alpha", { emails: ["alpha@a.test"] });
    const b = await seed(B, "Shared Name Beta", { emails: ["beta@b.test"] });

    const search = await call("search", { query: "Shared" }, { scopes: READ_A });
    expect(search.status).toBe(200);
    expect(search.json.contacts.map((c: { id: string }) => c.id)).toEqual([a]);
    expect(search.json.contacts[0].scope).toEqual({ kind: "client", id: "a" });

    const all = await call("search", { query: "" }, { scopes: READ_A });
    expect(all.json.contacts.map((c: { id: string }) => c.id)).toEqual([a]);

    const getB = await call("get", { id: b }, { scopes: READ_A });
    expect(getB.status).toBe(200);
    expect(getB.json).toEqual({ contact: null });

    const both = await call("search", { query: "" }, { scopes: READ_AB });
    expect(both.json.contacts.map((c: { id: string }) => c.id).sort()).toEqual([a, b].sort());
  });

  it("ignores no part of the header: a body `scopes` that differs from the header is refused", async () => {
    const r = await call("search", { query: "", scopes: READ_AB }, { scopes: READ_A });
    expect(r.status).toBe(400);
  });

  it("accepts a body `scopes` equal to the header", async () => {
    const r = await call("search", { query: "", scopes: READ_A }, { scopes: READ_A });
    expect(r.status).toBe(200);
  });

  it("refuses a write without a write scope", async () => {
    const r = await call("upsert", { contact: { name: "No Write" } }, { scopes: READ_A });
    expect(r.status).toBe(403);
  });

  it("refuses to update another scope's card (403) and leaves it unchanged", async () => {
    const b = await seed(B, "Bob B");
    const r = await call("upsert", { contact: { id: b, name: "Hijacked" } }, { scopes: A });
    expect(r.status).toBe(403);
    const got = await call("get", { id: b }, { scopes: B });
    expect(got.json.contact.name).toBe("Bob B");
  });
});

describe("contract operations", () => {
  it("upsert creates, then updates, preserving fields the contract does not carry", async () => {
    const created = await call(
      "upsert",
      { contact: { name: "Ada", emails: ["ada@x.test"], phones: ["+1 555 0100"], org: "Engines", title: "CTO", notes: "met at a conf", tags: ["math"] } },
      { scopes: A },
    );
    expect(created.status).toBe(200);
    expect(created.json.created).toBe(true);
    const c = created.json.contact;
    expect(c).toMatchObject({
      name: "Ada",
      emails: ["ada@x.test"],
      phones: ["+1 555 0100"],
      org: "Engines",
      title: "CTO",
      notes: "met at a conf",
      tags: ["math"],
      scope: { kind: "client", id: "a" },
    });
    expect(typeof c.createdAt).toBe("string");

    // A rolodex-only field set out of band (e.g. by the standalone UI).
    store.setVerdict({ read: ["client:a"], write: "client:a" }, c.id, "strong");

    const updated = await call("upsert", { contact: { id: c.id, name: "Ada L." } }, { scopes: A });
    expect(updated.status).toBe(200);
    expect(updated.json.created).toBe(false);
    expect(updated.json.contact).toMatchObject({ id: c.id, name: "Ada L.", emails: ["ada@x.test"], org: "Engines" });
    expect(store.get({ read: ["client:a"] }, c.id)?.verdict).toBe("strong");
  });

  it("upsert without id dedupes by email within the write scope (created: false)", async () => {
    const first = await seed(A, "Dup", { emails: ["dup@x.test"] });
    const again = await call("upsert", { contact: { name: "Dup Again", emails: ["DUP@x.test"] } }, { scopes: A });
    expect(again.json).toMatchObject({ created: false, contact: { id: first } });
    const other = await call("upsert", { contact: { name: "Dup", emails: ["dup@x.test"] } }, { scopes: B });
    expect(other.json.created).toBe(true);
    expect(other.json.contact.id).not.toBe(first);
  });

  it("upsert refuses more than one email or phone rather than dropping data", async () => {
    const r = await call("upsert", { contact: { name: "Two", emails: ["a@x.test", "b@x.test"] } }, { scopes: A });
    expect(r.status).toBe(400);
  });

  it("upsert rejects an invalid body with 400", async () => {
    expect((await call("upsert", { contact: { emails: [] } }, { scopes: A })).status).toBe(400);
    expect((await call("upsert", { nope: true }, { scopes: A })).status).toBe(400);
  });

  it("get returns contact, interactions and links", async () => {
    const a1 = await seed(A, "One");
    const a2 = await seed(A, "Two");
    const logged = await call(
      "log",
      { interaction: { contactId: a1, at: "2026-01-01T10:00:00.000Z", channel: "call", summary: "intro call" } },
      { scopes: A },
    );
    expect(logged.status).toBe(200);
    expect(logged.json.interaction).toMatchObject({ contactId: a1, channel: "call", summary: "intro call", scope: { kind: "client", id: "a" } });
    const linked = await call("link", { link: { from: a1, to: a2, predicate: "knows" } }, { scopes: A });
    expect(linked.status).toBe(200);
    expect(linked.json.link).toMatchObject({ from: a1, to: a2, predicate: "knows", assertedIn: { kind: "client", id: "a" } });

    const got = await call("get", { id: a1 }, { scopes: READ_A });
    expect(got.json.contact.id).toBe(a1);
    expect(got.json.interactions).toHaveLength(1);
    expect(got.json.interactions[0].summary).toBe("intro call");
    expect(got.json.links.map((l: { id: string }) => l.id)).toEqual([linked.json.link.id]);
  });

  it("log on a card outside the write scope is refused", async () => {
    const b = await seed(B, "Bob");
    const r = await call(
      "log",
      { interaction: { contactId: b, at: "2026-01-01T10:00:00.000Z", channel: "call", summary: "x" } },
      { scopes: A },
    );
    expect(r.status).toBe(403);
  });

  it("link toOrg, connections at depth 1 and 2, unlink", async () => {
    const x = await seed(A, "X");
    const y = await seed(A, "Y");
    const z = await seed(A, "Z");
    const xy = (await call("link", { link: { from: x, to: y, predicate: "knows" } }, { scopes: A })).json.link;
    await call("link", { link: { from: y, to: z, predicate: "colleague" } }, { scopes: A });
    const org = await call("link", { link: { from: x, toOrg: "Acme", predicate: "works_at" } }, { scopes: A });
    expect(org.status).toBe(200);
    expect(org.json.link.toOrg).toBe("acme");

    const d1 = await call("connections", { id: x }, { scopes: READ_A });
    expect(d1.json.contacts.map((c: { id: string }) => c.id)).toEqual([y]);
    const d2 = await call("connections", { id: x, depth: 2 }, { scopes: READ_A });
    expect(d2.json.contacts.map((c: { id: string }) => c.id).sort()).toEqual([y, z].sort());
    expect(d2.json.links).toHaveLength(2);

    expect((await call("connections", { id: x, depth: 3 }, { scopes: READ_A })).status).toBe(400);

    expect((await call("unlink", { linkId: xy.id }, { scopes: A })).json).toEqual({ removed: true });
    expect((await call("unlink", { linkId: xy.id }, { scopes: A })).json).toEqual({ removed: false });
  });

  it("a cross-scope link is invisible to a caller who can read only one end", async () => {
    const a = await seed(A, "Alice");
    const b = await seed(B, "Bob");
    const both = { read: [{ kind: "client", id: "a" }, { kind: "client", id: "b" }], write: { kind: "client", id: "a" } };
    const l = await call("link", { link: { from: a, to: b, predicate: "knows" } }, { scopes: both });
    expect(l.status).toBe(200);
    expect((await call("get", { id: a }, { scopes: READ_A })).json.links).toEqual([]);
    expect((await call("connections", { id: a }, { scopes: READ_A })).json).toEqual({ contacts: [], links: [] });
  });

  it("link to an unreadable card answers 404", async () => {
    const a = await seed(A, "Alice");
    const b = await seed(B, "Bob");
    expect((await call("link", { link: { from: a, to: b, predicate: "knows" } }, { scopes: A })).status).toBe(404);
  });

  it("delete removes a card; a second delete answers deleted: false", async () => {
    const a = await seed(A, "Gone");
    expect((await call("delete", { id: a }, { scopes: A })).json).toEqual({ deleted: true });
    expect((await call("delete", { id: a }, { scopes: A })).json).toEqual({ deleted: false });
  });

  it("candidates: pending pairs from readable scopes, confirmed for same_as links", async () => {
    const a1 = await seed(A, "Pat Doe", { emails: ["pat@x.test"] });
    const both = { read: [{ kind: "client", id: "a" }, { kind: "client", id: "b" }], write: { kind: "client", id: "b" } };
    const b1 = await seed(both as WireScopeSet, "Pat D.", { emails: ["pat@x.test"] });

    // Only client:a readable: no pair.
    expect((await call("candidates", {}, { scopes: READ_A })).json).toEqual({ candidates: [] });

    const pending = await call("candidates", {}, { scopes: READ_AB });
    expect(pending.status).toBe(200);
    expect(pending.json.candidates).toHaveLength(1);
    const cand = pending.json.candidates[0];
    expect([cand.a, cand.b].sort()).toEqual([a1, b1].sort());
    expect(cand.verdict).toBe("pending");
    expect(cand.score).toBeGreaterThan(0);
    expect(cand.score).toBeLessThanOrEqual(1);
    expect(cand.reason).toContain("email");

    await call("link", { link: { from: a1, to: b1, predicate: "same_as" } }, { scopes: both });
    const after = await call("candidates", {}, { scopes: READ_AB });
    expect(after.json.candidates).toHaveLength(1);
    expect(after.json.candidates[0].verdict).toBe("confirmed");
    expect((await call("candidates", { verdict: "pending" }, { scopes: READ_AB })).json.candidates).toEqual([]);
  });

  it("followups: interactions whose followUpAt is due and not superseded", async () => {
    const a = await seed(A, "Follow");
    const past = new Date(now - 86_400_000).toISOString();
    const future = new Date(now + 7 * 86_400_000).toISOString();
    const due = await call(
      "log",
      { interaction: { contactId: a, at: new Date(now - 2 * 86_400_000).toISOString(), channel: "email", summary: "sent deck", followUpAt: past } },
      { scopes: A },
    );
    await call(
      "log",
      { interaction: { contactId: a, at: new Date(now - 3 * 86_400_000).toISOString(), channel: "email", summary: "older", followUpAt: future } },
      { scopes: A },
    );
    const f = await call("followups", {}, { scopes: READ_A });
    expect(f.status).toBe(200);
    expect(f.json.followups).toEqual([
      { contactId: a, interactionId: due.json.interaction.id, dueAt: past, summary: "sent deck" },
    ]);
    // Another scope sees nothing.
    expect((await call("followups", {}, { scopes: { read: [{ kind: "client", id: "b" }] } })).json).toEqual({ followups: [] });

    // A later interaction closes the follow-up.
    await call(
      "log",
      { interaction: { contactId: a, at: new Date(now - 60_000).toISOString(), channel: "call", summary: "they replied" } },
      { scopes: A },
    );
    expect((await call("followups", {}, { scopes: READ_A })).json).toEqual({ followups: [] });
  });

  it("summary: candidate verdict counts, follow-ups due, last sync per read scope", async () => {
    await seed(A, "Sam", { emails: ["sam@x.test"] });
    const both = { read: [{ kind: "client", id: "a" }, { kind: "client", id: "b" }], write: { kind: "client", id: "b" } };
    await seed(both as WireScopeSet, "Sam Two", { emails: ["sam@x.test"] });
    store.updateGoogleSyncState({ read: ["client:a"], write: "client:a" }, { lastPullAt: "2026-11-01T00:00:00.000Z" });

    const s = await call("summary", {}, { scopes: READ_AB });
    expect(s.status).toBe(200);
    expect(s.json).toEqual({
      verdicts: { pending: 1, confirmed: 0, rejected: 0 },
      followupsDue: 0,
      lastSync: [
        { scope: { kind: "client", id: "a" }, at: "2026-11-01T00:00:00.000Z" },
        { scope: { kind: "client", id: "b" }, at: null },
      ],
    });
  });
});
