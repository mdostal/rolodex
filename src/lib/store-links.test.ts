// Link tests for the Rolodex Store (contacts-memory cm-03).
//
// A link is visible only when the caller can read the scope it was asserted
// in AND both endpoint cards' scopes. Otherwise it is omitted: no stub, no
// count, no "hidden" marker. These tests cover the acceptance criteria
// directly (both directions, depth 2, delete cascade), the existence-leak
// risk (unreadable and missing return the same NotFound), and a seeded
// property test over random scopes and links.

import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOCAL_SCOPE_SET } from "./local-scope.js";
import type { Scope, ScopeSet } from "./scope.js";
import { NotFound, ScopeDenied, Store } from "./store.js";
import { normalizeOrg } from "./dedupe.js";
import type { Contact, Link } from "./types.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "rolodex-links-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function card(fields: Partial<Contact> & { name: string }): Contact {
  return { id: "", verdict: "none", createdAt: "", updatedAt: "", ...fields };
}

const rw = (s: Scope, ...more: Scope[]): ScopeSet => ({ read: [s, ...more], write: s });
const ro = (...s: Scope[]): ScopeSet => ({ read: s });

function rawLinks(dbPath: string) {
  const db = new DatabaseSync(dbPath);
  const rows = db.prepare("SELECT * FROM links ORDER BY id").all() as Array<
    Record<string, unknown> & { fromContactId: string; toContactId: string | null }
  >;
  db.close();
  return rows;
}

describe("normalizeOrg", () => {
  it("lowercases, trims and collapses whitespace; blank is undefined", () => {
    expect(normalizeOrg("  Acme   Widgets\tInc ")).toBe("acme widgets inc");
    expect(normalizeOrg("   ")).toBeUndefined();
    expect(normalizeOrg(undefined)).toBeUndefined();
  });
});

describe("link()", () => {
  let store: Store;
  let ids: Record<string, string>;
  const OP = rw("user:operator", "client:a");

  beforeEach(() => {
    store = new Store(path.join(dir, "l.db"));
    ids = {
      op: store.upsert(rw("user:operator"), card({ name: "Opal Operator", email: "opal@x.test" })).id,
      a: store.upsert(rw("client:a"), card({ name: "Opal Acme", email: "opal@x.test" })).id,
      b: store.upsert(rw("client:b"), card({ name: "Bea Beta" })).id,
    };
  });

  it("creates a cross-scope link asserted in the write scope", () => {
    const l = store.link(OP, { fromContactId: ids.op!, toContactId: ids.a!, predicate: "same_as", note: "same person" });
    expect(l).toMatchObject({
      fromContactId: ids.op,
      toContactId: ids.a,
      predicate: "same_as",
      note: "same person",
      assertedIn: "user:operator",
    });
    expect(l.id).toBeTruthy();
    expect(store.links(OP, ids.a!).map((x) => x.id)).toEqual([l.id]);
    expect(store.links(OP, ids.op!).map((x) => x.id)).toEqual([l.id]);
  });

  it("stores toOrg normalized, and only for works_at", () => {
    const l = store.link(OP, { fromContactId: ids.op!, toOrg: "  Acme   Corp ", predicate: "works_at" });
    expect(l.toOrg).toBe("acme corp");
    expect(l.toContactId).toBeUndefined();
    expect(() => store.link(OP, { fromContactId: ids.op!, toOrg: "Acme", predicate: "knows" })).toThrow(/toOrg/);
    expect(() => store.link(OP, { fromContactId: ids.op!, toOrg: "   ", predicate: "works_at" })).toThrow(/toOrg/);
  });

  it("validates predicate, target shape and self links", () => {
    expect(() =>
      store.link(OP, { fromContactId: ids.op!, toContactId: ids.a!, predicate: "loves" as Link["predicate"] }),
    ).toThrow(/predicate/);
    expect(() => store.link(OP, { fromContactId: ids.op!, predicate: "knows" })).toThrow(/exactly one/);
    expect(() =>
      store.link(OP, { fromContactId: ids.op!, toContactId: ids.a!, toOrg: "x", predicate: "works_at" }),
    ).toThrow(/exactly one/);
    expect(() => store.link(OP, { fromContactId: ids.op!, toContactId: ids.op!, predicate: "knows" })).toThrow(/itself/);
  });

  it("needs a write scope (ScopeDenied before any endpoint lookup)", () => {
    expect(() =>
      store.link(ro("user:operator", "client:a"), { fromContactId: ids.op!, toContactId: ids.a!, predicate: "knows" }),
    ).toThrow(ScopeDenied);
    expect(() =>
      store.link(ro("user:operator"), { fromContactId: "no-such-card", toContactId: ids.a!, predicate: "knows" }),
    ).toThrow(ScopeDenied);
  });

  it("an unreadable endpoint and a missing endpoint fail identically (no existence leak)", () => {
    const errOf = (f: () => unknown): Error => {
      try {
        f();
      } catch (e) {
        return e as Error;
      }
      throw new Error("expected a throw");
    };
    const unreadable = errOf(() => store.link(OP, { fromContactId: ids.op!, toContactId: ids.b!, predicate: "knows" }));
    const missing = errOf(() => store.link(OP, { fromContactId: ids.op!, toContactId: "nope", predicate: "knows" }));
    expect(unreadable).toBeInstanceOf(NotFound);
    expect(missing).toBeInstanceOf(NotFound);
    expect(unreadable.message).toBe(missing.message);
    expect(unreadable.name).toBe(missing.name);

    const unreadableFrom = errOf(() => store.link(OP, { fromContactId: ids.b!, toContactId: ids.op!, predicate: "knows" }));
    const missingFrom = errOf(() => store.link(OP, { fromContactId: "nope", toContactId: ids.op!, predicate: "knows" }));
    expect(unreadableFrom.message).toBe(missingFrom.message);
    expect(unreadableFrom).toBeInstanceOf(NotFound);
  });

  it("is idempotent: the same assertion returns the existing link (symmetric predicates either way round)", () => {
    const l1 = store.link(OP, { fromContactId: ids.op!, toContactId: ids.a!, predicate: "same_as" });
    const l2 = store.link(OP, { fromContactId: ids.a!, toContactId: ids.op!, predicate: "same_as" });
    expect(l2.id).toBe(l1.id);
    const i1 = store.link(OP, { fromContactId: ids.op!, toContactId: ids.a!, predicate: "introduced" });
    const i2 = store.link(OP, { fromContactId: ids.a!, toContactId: ids.op!, predicate: "introduced" });
    expect(i2.id).not.toBe(i1.id); // directional
    expect(store.links(OP, ids.op!)).toHaveLength(3);
  });

  it("unlink: needs write on assertedIn; invisible and missing both return false", () => {
    const l = store.link(OP, { fromContactId: ids.op!, toContactId: ids.a!, predicate: "knows" });
    // client:a can't see the link (can't read user:operator): same as missing.
    expect(store.unlink(rw("client:a"), l.id)).toBe(false);
    expect(store.unlink(rw("client:a"), "no-such-link")).toBe(false);
    // Visible but asserted elsewhere: ScopeDenied (no leak, the caller already sees it).
    expect(() => store.unlink({ read: ["user:operator"], write: "client:a" }, l.id)).toThrow(ScopeDenied);
    expect(store.links(OP, ids.op!)).toHaveLength(1);
    expect(store.unlink(OP, l.id)).toBe(true);
    expect(store.links(OP, ids.op!)).toHaveLength(0);
  });
});

describe("visibility (acceptance)", () => {
  it("a user:operator link to a client:a card is absent for a [client:a] reader: get, links, connections, candidates", () => {
    const store = new Store(path.join(dir, "v.db"));
    const op = store.upsert(rw("user:operator"), card({ name: "Opal", email: "opal@x.test", org: "Acme" })).id;
    const a = store.upsert(rw("client:a"), card({ name: "Opal", email: "opal@x.test", org: "Acme" })).id;
    const a2 = store.upsert(rw("client:a"), card({ name: "Arlo" })).id;
    const OP = rw("user:operator", "client:a");
    store.link(OP, { fromContactId: op, toContactId: a, predicate: "same_as" });
    store.link(OP, { fromContactId: a, toContactId: op, predicate: "introduced" });
    store.link(rw("client:a"), { fromContactId: a, toContactId: a2, predicate: "colleague" });

    const A = ro("client:a");
    expect(store.get(A, op)).toBeUndefined();
    const visible = store.links(A, a);
    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({ predicate: "colleague", toContactId: a2 });
    for (const depth of [1, 2]) {
      const conn = store.connections(A, a, depth);
      expect(conn.map((c) => c.contact.id)).toEqual([a2]);
      expect(JSON.stringify(conn)).not.toContain(op);
    }
    expect(store.candidates(A, a)).toEqual([]);
    // Nothing reachable from the operator card for this reader, and no error.
    expect(store.links(A, op)).toEqual([]);
    expect(store.connections(A, op, 2)).toEqual([]);
    expect(store.candidates(A, op)).toEqual([]);

    // The operator sees all of it.
    expect(store.connections(OP, a, 1).map((c) => c.contact.id).sort()).toEqual([op, a2].sort());
    // Already linked same_as: not a candidate any more.
    expect(store.candidates(OP, a)).toEqual([]);
  });

  it("a link asserted in an unreadable scope is hidden even when both endpoints are readable", () => {
    const store = new Store(path.join(dir, "v2.db"));
    const a = store.upsert(rw("client:a"), card({ name: "A" })).id;
    const b = store.upsert(rw("client:b"), card({ name: "B" })).id;
    store.link(rw("user:operator", "client:a", "client:b"), { fromContactId: a, toContactId: b, predicate: "knows" });
    const AB = ro("client:a", "client:b");
    expect(store.links(AB, a)).toEqual([]);
    expect(store.connections(AB, a, 2)).toEqual([]);
  });

  it("depth-2 A->B->C where B is unreadable does not return C", () => {
    const store = new Store(path.join(dir, "d.db"));
    const A = store.upsert(rw("client:a"), card({ name: "A" })).id;
    const B = store.upsert(rw("client:b"), card({ name: "B" })).id;
    const C = store.upsert(rw("client:a"), card({ name: "C" })).id;
    const D = store.upsert(rw("client:a"), card({ name: "D" })).id;
    const ALL = rw("user:operator", "client:a", "client:b");
    store.link(ALL, { fromContactId: A, toContactId: B, predicate: "knows" });
    store.link(ALL, { fromContactId: B, toContactId: C, predicate: "knows" });
    store.link(rw("client:a"), { fromContactId: A, toContactId: D, predicate: "knows" });
    store.link(rw("client:a"), { fromContactId: D, toContactId: C, predicate: "introduced" });

    const full = store.connections(ALL, A, 2);
    expect(full.find((h) => h.contact.id === B)).toMatchObject({ depth: 1 });
    expect(full.find((h) => h.contact.id === C)).toMatchObject({ depth: 2 });

    // Readable: user:operator + client:a. B (client:b) is unreadable, so the
    // A->B->C path is gone; C is still reached via the all-visible A->D->C.
    const noB = rw("user:operator", "client:a");
    const hits = store.connections(noB, A, 2);
    expect(hits.map((h) => h.contact.id).sort()).toEqual([C, D].sort());
    const c = hits.find((h) => h.contact.id === C)!;
    expect(c.depth).toBe(2);
    expect(c.path.map((l) => l.toContactId)).toEqual([D, C]);

    // Without the A->D->C detour, C is not returned at all.
    store.unlink(rw("client:a"), store.links(rw("client:a"), D).find((l) => l.toContactId === C)!.id);
    expect(store.connections(noB, A, 2).map((h) => h.contact.id)).toEqual([D]);
    // depth 1 stops at the first hop.
    expect(store.connections(ALL, A, 1).map((h) => h.contact.id).sort()).toEqual([B, D].sort());
  });

  it("depth must be 1 or 2", () => {
    const store = new Store(path.join(dir, "dd.db"));
    const A = store.upsert(LOCAL_SCOPE_SET, card({ name: "A" })).id;
    expect(() => store.connections(LOCAL_SCOPE_SET, A, 3)).toThrow(RangeError);
    expect(() => store.connections(LOCAL_SCOPE_SET, A, 0)).toThrow(RangeError);
    expect(store.connections(LOCAL_SCOPE_SET, A)).toEqual([]);
  });
});

describe("candidates()", () => {
  it("matches normalized email, phone, or name+org from readable scopes, excluding linked pairs; never links", () => {
    const dbPath = path.join(dir, "c.db");
    const store = new Store(dbPath);
    const me = store.upsert(
      rw("user:operator"),
      card({ name: "Jane  Doe", email: "Jane@Ex.test", phone: "+1 555 010 2000", org: "Acme Corp" }),
    ).id;
    const byEmail = store.upsert(rw("client:a"), card({ name: "J. Doe", email: " jane@ex.test" })).id;
    const byPhone = store.upsert(rw("client:a"), card({ name: "JD", phone: "15550102000" })).id;
    const byNameOrg = store.upsert(rw("client:b"), card({ name: "jane doe", org: " acme   corp" })).id;
    const nameOnly = store.upsert(rw("client:b"), card({ name: "Jane Doe", org: "Other" })).id;
    const hidden = store.upsert(rw("client:c"), card({ name: "Jane Doe", email: "jane@ex.test" })).id;
    const all = rw("user:operator", "client:a", "client:b");

    const got = store.candidates(all, me);
    expect(got.map((c) => c.contact.id).sort()).toEqual([byEmail, byPhone, byNameOrg].sort());
    expect(got.find((c) => c.contact.id === byEmail)!.reasons).toEqual(["email"]);
    expect(got.find((c) => c.contact.id === byPhone)!.reasons).toEqual(["phone"]);
    expect(got.find((c) => c.contact.id === byNameOrg)!.reasons).toEqual(["name+org"]);
    expect(JSON.stringify(got)).not.toContain(hidden);
    expect(JSON.stringify(got)).not.toContain(nameOnly);
    expect(rawLinks(dbPath)).toHaveLength(0);

    store.link(all, { fromContactId: byEmail, toContactId: me, predicate: "same_as" });
    expect(store.candidates(all, me).map((c) => c.contact.id).sort()).toEqual([byPhone, byNameOrg].sort());
    // Unreadable start card: nothing, no error.
    expect(store.candidates(ro("client:a"), me)).toEqual([]);
  });
});

describe("delete cascades to links (H9)", () => {
  it("deleting a card removes every link touching it, wherever asserted", () => {
    const dbPath = path.join(dir, "h9.db");
    const store = new Store(dbPath);
    const op = store.upsert(rw("user:operator"), card({ name: "Op" })).id;
    const a = store.upsert(rw("client:a"), card({ name: "A" })).id;
    const a2 = store.upsert(rw("client:a"), card({ name: "A2" })).id;
    const b = store.upsert(rw("client:b"), card({ name: "B" })).id;
    store.link(rw("user:operator", "client:a"), { fromContactId: op, toContactId: a, predicate: "same_as" });
    store.link(rw("client:b", "client:a"), { fromContactId: b, toContactId: a, predicate: "knows" });
    store.link(rw("client:a"), { fromContactId: a, toOrg: "Acme", predicate: "works_at" });
    store.link(rw("client:a", "user:operator"), { fromContactId: a2, toContactId: op, predicate: "knows" });
    expect(rawLinks(dbPath)).toHaveLength(4);

    expect(store.delete(rw("client:a"), a)).toBe(true);
    const rows = rawLinks(dbPath);
    expect(rows.every((r) => r.fromContactId !== a && r.toContactId !== a)).toBe(true);
    expect(rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Property test: random scopes, cards and links; random reader ScopeSets.
// For every read (links, connections at depth 1 and 2, candidates, get) no
// visible result references a card the reader cannot read, nor a link whose
// assertedIn scope it cannot read. Ground truth is a raw, unscoped read.
// ---------------------------------------------------------------------------

function mulberry32(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const POOL: Scope[] = ["user:local", "user:operator", "client:a", "client:b", "client:c"];
const PREDICATES: Link["predicate"][] = ["same_as", "knows", "introduced", "reports_to", "colleague"];
const NAMES = ["Ada", "Grace", "Linus", "Alan"];
const EMAILS = ["ada@x.test", " ADA@x.test", "grace@y.test", undefined];
const ORGS = ["Acme", " acme ", "Beta", undefined];

describe("property: no visible result references an unreadable card", () => {
  it("holds for 250 random (scopes, links, reader) cases", () => {
    const CASES = 250;
    const rand = mulberry32(0x11a5);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
    let nonEmpty = 0;
    let hiddenSomething = 0;

    for (let n = 0; n < CASES; n++) {
      const dbPath = path.join(dir, `p${n}.db`);
      const store = new Store(dbPath);
      const scopeOf = new Map<string, Scope>();
      for (const s of POOL) {
        const k = 1 + Math.floor(rand() * 3);
        for (let j = 0; j < k; j++) {
          const c = store.upsert(rw(s), card({ name: pick(NAMES), email: pick(EMAILS), org: pick(ORGS) }));
          scopeOf.set(c.id, s);
        }
      }
      const cardIds = [...scopeOf.keys()];
      const linkScope = new Map<string, Scope>();
      const linkCount = 3 + Math.floor(rand() * 12);
      for (let j = 0; j < linkCount; j++) {
        const from = pick(cardIds);
        const asserted = pick(POOL);
        const writer: ScopeSet = { read: POOL, write: asserted };
        if (rand() < 0.15) {
          const l = store.link(writer, { fromContactId: from, toOrg: "Acme", predicate: "works_at" });
          linkScope.set(l.id, asserted);
          continue;
        }
        const to = pick(cardIds);
        if (to === from) continue;
        const l = store.link(writer, { fromContactId: from, toContactId: to, predicate: pick(PREDICATES) });
        linkScope.set(l.id, asserted);
      }

      const read = POOL.filter(() => rand() < 0.45);
      const write = rand() < 0.3 ? pick(POOL) : undefined;
      const reader: ScopeSet = write ? { read, write } : { read };
      const readable = new Set<string>(write ? [...read, write] : read);
      const canRead = (id: string | undefined) => id === undefined || readable.has(scopeOf.get(id) ?? "-");
      const checkLink = (l: Link) => {
        expect(readable.has(linkScope.get(l.id)!)).toBe(true);
        expect(readable.has(l.assertedIn)).toBe(true);
        expect(canRead(l.fromContactId)).toBe(true);
        expect(canRead(l.toContactId)).toBe(true);
      };
      const totalLinks = rawLinks(dbPath).length;
      let seenLinks = new Set<string>();

      for (const id of cardIds) {
        const ls = store.links(reader, id);
        ls.forEach(checkLink);
        ls.forEach((l) => seenLinks.add(l.id));
        if (!canRead(id)) {
          expect(ls).toEqual([]);
          expect(store.get(reader, id)).toBeUndefined();
        }
        for (const depth of [1, 2]) {
          const hits = store.connections(reader, id, depth);
          if (!canRead(id)) expect(hits).toEqual([]);
          for (const h of hits) {
            expect(canRead(h.contact.id)).toBe(true);
            expect(h.depth).toBeLessThanOrEqual(depth);
            expect(h.path).toHaveLength(h.depth);
            h.path.forEach(checkLink);
          }
          if (hits.length) nonEmpty++;
        }
        for (const c of store.candidates(reader, id)) {
          expect(canRead(id)).toBe(true);
          expect(canRead(c.contact.id)).toBe(true);
          expect(c.contact.id).not.toBe(id);
        }
      }
      if (seenLinks.size < totalLinks) hiddenSomething++;
      seenLinks = new Set();
    }
    // The generator must exercise both visible and hidden graphs.
    expect(nonEmpty).toBeGreaterThan(50);
    expect(hiddenSomething).toBeGreaterThan(50);
  });
});
