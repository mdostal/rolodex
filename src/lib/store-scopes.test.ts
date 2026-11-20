// Scope enforcement tests for the Store (contacts-memory cm-02).
//
// Covers the acceptance criteria directly (v0.5 migration into user:local,
// read isolation, upsert-with-foreign-id denial) plus a seeded property test:
// for random ScopeSets and random operations, no Store method returns or
// mutates a row outside the set.

import { DatabaseSync } from "node:sqlite";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyPullToStore, pushAllToGoogle } from "./google-sync.js";
import { LOCAL_SCOPE_SET } from "./local-scope.js";
import { ScopeKind, formatScope, isScope, parseScope, scopeClause, type Scope, type ScopeSet } from "./scope.js";
import { ScopeDenied, Store } from "./store.js";
import type { Contact } from "./types.js";

const FIXTURE_DB = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__", "standalone-v0.5.db");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "rolodex-scopes-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function card(fields: Partial<Contact> & { name: string }): Contact {
  return { id: "", verdict: "none", createdAt: "", updatedAt: "", ...fields };
}

const rw = (s: Scope): ScopeSet => ({ read: [s], write: s });
const ro = (...s: Scope[]): ScopeSet => ({ read: s });

/** Raw, unscoped view of the database — the test's ground truth. */
function raw(dbPath: string) {
  const db = new DatabaseSync(dbPath);
  return {
    contacts: () =>
      db.prepare("SELECT * FROM contacts ORDER BY id").all() as Array<Record<string, unknown> & { id: string }>,
    interactions: () => db.prepare("SELECT * FROM interactions ORDER BY id").all(),
    settings: () => db.prepare("SELECT * FROM settings ORDER BY scope, key").all() as Array<{ scope: string; key: string }>,
    close: () => db.close(),
  };
}

describe("scope model", () => {
  it("parses kind:id at the first colon and rejects unknown kinds / empty ids", () => {
    expect(parseScope("client:acme:eu")).toEqual({ kind: "client", id: "acme:eu" });
    expect(parseScope("user:local")).toEqual({ kind: "user", id: "local" });
    for (const bad of ["", "user", "user:", "team:x", ":x"]) expect(() => parseScope(bad)).toThrow(/invalid scope/);
    expect(isScope("client:a")).toBe(true);
    expect(isScope("nope:a")).toBe(false);
    expect(formatScope(ScopeKind.Client, "a")).toBe("client:a");
  });

  it("scopeClause matches nothing for an empty scope list", () => {
    expect(scopeClause([])).toEqual({ sql: "(0)", params: [] });
    expect(scopeClause([{ kind: "user", id: "local" }], "c")).toEqual({
      sql: "((c.scopeKind = ? AND c.scopeId = ?))",
      params: ["user", "local"],
    });
  });
});

describe("migration from v0.5", () => {
  it("opens a v0.5 database with every contact and setting in user:local, idempotently", () => {
    const dbPath = path.join(dir, "v05.db");
    copyFileSync(FIXTURE_DB, dbPath);

    // Sanity: the fixture really is pre-scopes.
    const before = new DatabaseSync(dbPath);
    const cols = (before.prepare("PRAGMA table_info(contacts)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).not.toContain("scopeKind");
    const contactCount = (before.prepare("SELECT COUNT(*) AS n FROM contacts").get() as { n: number }).n;
    const settingKeys = (before.prepare("SELECT key FROM settings ORDER BY key").all() as Array<{ key: string }>).map(
      (r) => r.key,
    );
    before.close();
    expect(contactCount).toBeGreaterThan(0);
    expect(settingKeys.length).toBeGreaterThan(0);

    for (let open = 0; open < 3; open++) {
      const store = new Store(dbPath);
      expect(store.list(LOCAL_SCOPE_SET)).toHaveLength(contactCount);
      expect(store.list(ro("client:a"))).toHaveLength(0);
      expect(store.getSetting(LOCAL_SCOPE_SET, "custom.key", "missing")).not.toBe("missing");

      const r = raw(dbPath);
      const rows = r.contacts();
      expect(rows).toHaveLength(contactCount);
      expect(rows.every((c) => c.scopeKind === "user" && c.scopeId === "local")).toBe(true);
      const settings = r.settings();
      expect(settings.map((s) => s.key)).toEqual(expect.arrayContaining(settingKeys));
      expect(settings.every((s) => s.scope === "user:local")).toBe(true);
      r.close();
    }
  });

  it("makes settings keys unique per scope, not globally", () => {
    const store = new Store(path.join(dir, "s.db"));
    store.setSetting(rw("client:a"), "k", "a");
    store.setSetting(rw("client:b"), "k", "b");
    store.setSetting(LOCAL_SCOPE_SET, "k", "local");
    expect(store.getSetting(rw("client:a"), "k", "")).toBe("a");
    expect(store.getSetting(ro("client:b"), "k", "")).toBe("b");
    expect(store.getSetting(LOCAL_SCOPE_SET, "k", "")).toBe("local");
    // A multi-scope read-only set has no single book to read settings from.
    expect(store.getSetting(ro("client:a", "client:b"), "k", "fallback")).toBe("fallback");
  });
});

describe("scope enforcement", () => {
  let dbPath: string;
  let store: Store;
  let ids: Record<string, string>;

  beforeEach(() => {
    dbPath = path.join(dir, "e.db");
    store = new Store(dbPath);
    ids = {
      a: store.upsert(rw("client:a"), card({ name: "Alice Acme", email: "alice@acme.test", nextStep: "call" })).id,
      b: store.upsert(rw("client:b"), card({ name: "Bob Beta", email: "bob@beta.test", nextStep: "call" })).id,
      u: store.upsert(LOCAL_SCOPE_SET, card({ name: "Ursula Local", email: "u@local.test", nextStep: "call" })).id,
    };
    store.logInteraction(rw("client:b"), { id: "", contactId: ids.b!, at: "2020-01-01T00:00:00.000Z", note: "met" });
    store.logInteraction(LOCAL_SCOPE_SET, { id: "", contactId: ids.u!, at: "2020-01-01T00:00:00.000Z", note: "met" });
  });

  it("with read [client:a], no client:b or user:* row is ever returned", () => {
    const a = ro("client:a");
    expect(store.list(a).map((c) => c.id)).toEqual([ids.a]);
    expect(store.get(a, ids.b!)).toBeUndefined();
    expect(store.get(a, ids.u!)).toBeUndefined();
    for (const q of ["Bob", "Ursula", "beta", "call"]) {
      expect(store.search(a, q).every((r) => r.contact.id === ids.a)).toBe(true);
    }
    expect(store.search(a, "Bob")).toEqual([]);
    expect(store.needsFollowUp(a, 0, 0).every((c) => c.id === ids.a)).toBe(true);
    expect(store.listInteractions(a, ids.b!)).toEqual([]);
    expect(store.listInteractions(a, ids.u!)).toEqual([]);
  });

  it("upsert with a foreign id throws ScopeDenied and changes nothing", () => {
    const r = raw(dbPath);
    const snapshot = { c: r.contacts(), i: r.interactions(), s: r.settings() };
    expect(() => store.upsert(rw("client:a"), card({ id: ids.b!, name: "Hijacked" }))).toThrow(ScopeDenied);
    expect(() => store.upsert(rw("client:a"), card({ id: ids.u!, name: "Hijacked" }))).toThrow(ScopeDenied);
    // Even when the foreign scope is readable: read does not grant write.
    expect(() =>
      store.upsert({ read: ["client:a", "client:b"], write: "client:a" }, card({ id: ids.b!, name: "Hijacked" })),
    ).toThrow(ScopeDenied);
    expect({ c: r.contacts(), i: r.interactions(), s: r.settings() }).toEqual(snapshot);
    r.close();
  });

  it("every write without a write scope throws ScopeDenied", () => {
    const a = ro("client:a");
    expect(() => store.upsert(a, card({ name: "New" }))).toThrow(ScopeDenied);
    expect(() => store.upsert(a, card({ id: ids.a!, name: "Edit" }))).toThrow(ScopeDenied);
    expect(() => store.delete(a, ids.a!)).toThrow(ScopeDenied);
    expect(() => store.setVerdict(a, ids.a!, "pass")).toThrow(ScopeDenied);
    expect(() => store.setNextStep(a, ids.a!, "x")).toThrow(ScopeDenied);
    expect(() => store.logInteraction(a, { id: "", contactId: ids.a!, at: "", note: "n" })).toThrow(ScopeDenied);
    expect(() => store.setSetting(a, "k", "v")).toThrow(ScopeDenied);
    expect(() => store.setFollowUpConfig(a, { windowDays: 1, graceDays: 1 })).toThrow(ScopeDenied);
    expect(() => store.updateGoogleSyncState(a, { account: "x@y" })).toThrow(ScopeDenied);
    expect(store.get(LOCAL_SCOPE_SET, ids.u!)?.name).toBe("Ursula Local");
  });

  it("delete/setVerdict/setNextStep across scopes throw ScopeDenied and leave the card alone", () => {
    const a = rw("client:a");
    expect(() => store.delete(a, ids.b!)).toThrow(ScopeDenied);
    expect(() => store.setVerdict(a, ids.b!, "pass")).toThrow(ScopeDenied);
    expect(() => store.setNextStep(a, ids.b!, "hijack")).toThrow(ScopeDenied);
    expect(store.get(rw("client:b"), ids.b!)).toMatchObject({ verdict: "none", nextStep: "call" });
    expect(store.listInteractions(rw("client:b"), ids.b!)).toHaveLength(1);
    expect(store.delete(a, "no-such-id")).toBe(false);
  });

  it("delete removes the card's interactions", () => {
    expect(store.delete(rw("client:b"), ids.b!)).toBe(true);
    const r = raw(dbPath);
    expect((r.interactions() as Array<{ contactId: string }>).map((i) => i.contactId)).toEqual([ids.u]);
    r.close();
  });

  it("interactions inherit their card's scope: logging requires the card in the write scope", () => {
    expect(() =>
      store.logInteraction(rw("client:a"), { id: "", contactId: ids.b!, at: "", note: "sneaky" }),
    ).toThrow(ScopeDenied);
    expect(() =>
      store.logInteraction(rw("client:a"), { id: "", contactId: "no-such-card", at: "", note: "orphan" }),
    ).toThrow(ScopeDenied);
    store.logInteraction(rw("client:a"), { id: "", contactId: ids.a!, at: "", note: "ok" });
    expect(store.listInteractions(ro("client:a"), ids.a!)).toHaveLength(1);
    expect(store.listInteractions(ro("client:b"), ids.a!)).toEqual([]);
    expect(store.listInteractions(ro("client:b"), ids.b!)).toHaveLength(1);
  });

  it("dedupes by normalized email and phone digits within the write scope only", () => {
    const a = rw("client:a");
    expect(store.upsert(a, card({ name: "Alice again", email: "  ALICE@acme.test " })).id).toBe(ids.a);
    // Same email in another scope is a different card.
    const b = store.upsert(rw("client:b"), card({ name: "Alice at Beta", email: "alice@acme.test" }));
    expect(b.id).not.toBe(ids.a);
    expect(store.get(rw("client:a"), ids.a!)?.name).toBe("Alice again");

    const p1 = store.upsert(a, card({ name: "Phone Person", phone: "+1 (555) 010-2000" }));
    expect(store.upsert(a, card({ name: "Phone Person 2", phone: "1-555-010-2000" })).id).toBe(p1.id);
    expect(store.upsert(rw("client:b"), card({ name: "Phone Person", phone: "15550102000" })).id).not.toBe(p1.id);
    expect(store.list(ro("client:a"))).toHaveLength(2);
  });

  it("the write scope is readable even when read omits it", () => {
    const set: ScopeSet = { read: [], write: "client:a" };
    expect(store.list(set).map((c) => c.id)).toEqual([ids.a]);
    const created = store.upsert(set, card({ name: "New A" }));
    expect(store.get(set, created.id)?.name).toBe("New A");
  });

  it("rejects malformed scopes instead of widening or narrowing silently", () => {
    expect(() => store.list({ read: ["team:x" as Scope] })).toThrow(/invalid scope/);
    expect(() => store.upsert({ read: [], write: "client:" as Scope }, card({ name: "x" }))).toThrow(/invalid scope/);
  });
});

describe("Google sync is bound to one scope", () => {
  it("pushAllToGoogle pushes only the bound write scope, applyPullToStore lands in it, sync state is per scope", async () => {
    const store = new Store(path.join(dir, "g.db"));
    store.upsert(rw("client:a"), card({ name: "A1" }));
    store.upsert(rw("client:b"), card({ name: "B1" }));
    store.upsert(LOCAL_SCOPE_SET, card({ name: "L1" }));

    // Reads both client books, writes client:a: sync must still only see client:a.
    const scoped = store.scoped({ read: ["client:a", "client:b"], write: "client:a" });
    const pushed: string[] = [];
    const summary = await pushAllToGoogle(scoped, {
      push: async (c) => {
        pushed.push(c.name);
        return { resourceName: `people/${c.name}` };
      },
    });
    expect(pushed).toEqual(["A1"]);
    expect(summary.pushed).toBe(1);

    applyPullToStore([card({ name: "Pulled", googleResourceName: "people/p1" })], scoped);
    expect(store.list(ro("client:a")).map((c) => c.name).sort()).toEqual(["A1", "Pulled"]);
    expect(store.list(ro("client:b")).map((c) => c.name)).toEqual(["B1"]);

    expect(store.getGoogleSyncState(ro("client:a"))).toMatchObject({
      lastPushAt: expect.any(String),
      lastPullAt: expect.any(String),
    });
    expect(store.getGoogleSyncState(ro("client:b"))).toEqual({});
    expect(() => store.scoped(ro("client:a")).forSync()).toThrow(ScopeDenied);
  });
});

// ---------------------------------------------------------------------------
// Property test: random ScopeSets x random operations. Ground truth is a raw
// unscoped read of the database; for every operation we check that
//   (1) every returned contact/interaction belongs to a readable scope, and
//   (2) no row outside the write scope changed (contacts, interactions,
//       settings), whether the call succeeded or threw.
// Deterministic (seeded mulberry32), no extra dependencies.
// ---------------------------------------------------------------------------

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const POOL: Scope[] = ["user:local", "user:x", "client:a", "client:b", "client:c"];
const NAMES = ["Ada", "Grace", "Linus", "Barbara", "Edsger", "Alan"];
const EMAILS = ["ada@x.test", "ADA@x.test ", "grace@y.test", undefined];
const PHONES = ["+1 555 010 2000", "15550102000", "555-1111", undefined];

describe("property: no method returns or mutates a row outside the ScopeSet", () => {
  it("holds for 250 random (ScopeSet, operation sequence) cases", () => {
    const CASES = 250;
    const rand = mulberry32(0xc0ffee);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
    let checkedOps = 0;
    let denied = 0;

    for (let n = 0; n < CASES; n++) {
      const dbPath = path.join(dir, `p${n}.db`);
      const store = new Store(dbPath);
      const db = new DatabaseSync(dbPath);

      // Seed every scope with a few cards and interactions.
      for (const s of POOL) {
        const k = 1 + Math.floor(rand() * 3);
        for (let j = 0; j < k; j++) {
          const c = store.upsert(
            rw(s),
            card({ name: `${pick(NAMES)} ${s}`, email: pick(EMAILS), phone: pick(PHONES), nextStep: "follow up" }),
          );
          if (rand() < 0.6) store.logInteraction(rw(s), { id: "", contactId: c.id, at: "2020-01-01T00:00:00.000Z", note: "seed" });
        }
        store.setSetting(rw(s), "k", s);
      }

      const read = POOL.filter(() => rand() < 0.4);
      const write = rand() < 0.7 ? pick(POOL) : undefined;
      const set: ScopeSet = write ? { read, write } : { read };
      const readable = new Set<string>(write ? [...read, write] : read);

      const owner = (id: string) => {
        const row = db.prepare("SELECT scopeKind, scopeId FROM contacts WHERE id = ?").get(id) as
          | { scopeKind: string; scopeId: string }
          | undefined;
        return row ? `${row.scopeKind}:${row.scopeId}` : undefined;
      };
      const outside = () => ({
        c: db
          .prepare("SELECT * FROM contacts WHERE (scopeKind || ':' || scopeId) IS NOT ? ORDER BY id")
          .all(write ?? null),
        i: db
          .prepare(
            `SELECT i.* FROM interactions i JOIN contacts c ON c.id = i.contactId
             WHERE (c.scopeKind || ':' || c.scopeId) IS NOT ? ORDER BY i.id`,
          )
          .all(write ?? null),
        s: db.prepare("SELECT * FROM settings WHERE scope IS NOT ? ORDER BY scope, key").all(write ?? null),
      });
      const allIds = () => (db.prepare("SELECT id FROM contacts").all() as Array<{ id: string }>).map((r) => r.id);
      const assertReadable = (contacts: Array<Contact | undefined>) => {
        for (const c of contacts) if (c) expect(readable.has(owner(c.id) ?? "deleted")).toBe(true);
      };

      for (let step = 0; step < 8; step++) {
        const ids = allIds();
        const id = rand() < 0.85 && ids.length ? pick(ids) : `missing-${n}-${step}`;
        const before = outside();
        try {
          switch (Math.floor(rand() * 13)) {
            case 0:
              assertReadable(store.list(set));
              break;
            case 1:
              assertReadable([store.get(set, id)]);
              break;
            case 2:
              assertReadable(store.search(set, pick([...NAMES, "follow", "client", "user"])).map((r) => r.contact));
              break;
            case 3:
              assertReadable(store.needsFollowUp(set, 0, 0));
              break;
            case 4: {
              const out = store.listInteractions(set, id);
              if (out.length) expect(readable.has(owner(id)!)).toBe(true);
              break;
            }
            case 5: {
              const useId = rand() < 0.5;
              const saved = store.upsert(
                set,
                card({ id: useId ? id : "", name: pick(NAMES), email: pick(EMAILS), phone: pick(PHONES) }),
              );
              expect(owner(saved.id)).toBe(write);
              break;
            }
            case 6:
              store.delete(set, id);
              break;
            case 7:
              store.setVerdict(set, id, "pass");
              break;
            case 8:
              store.setNextStep(set, id, "changed");
              break;
            case 9:
              store.logInteraction(set, { id: "", contactId: id, at: "", note: "prop" });
              expect(owner(id)).toBe(write);
              break;
            case 10:
              store.setSetting(set, "k", "changed");
              break;
            case 11: {
              const v = store.getSetting(set, "k", "fallback");
              expect(v === "fallback" || v === "changed" || readable.has(v)).toBe(true);
              break;
            }
            case 12:
              store.setFollowUpConfig(set, { windowDays: 3, graceDays: 1 });
              store.getFollowUpConfig(set);
              store.setAppearance(set, { theme: "brass", iconId: 2 });
              break;
          }
        } catch (err) {
          expect(err).toBeInstanceOf(ScopeDenied);
          denied++;
        }
        expect(outside()).toEqual(before);
        checkedOps++;
      }
      db.close();
    }
    // The generator must actually exercise both allowed and denied paths.
    expect(checkedOps).toBe(CASES * 8);
    expect(denied).toBeGreaterThan(50);
    expect(denied).toBeLessThan(checkedOps);
    // 250 cases each open a real SQLite file: ~2s locally, ~9s on CI runners.
  }, 60_000);
});
