import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "./store.js";

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "rolodex-store-test-"));
  dbPath = path.join(dir, "rolodex.db");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("Store.list()", () => {
  it("returns an empty array against a fresh database", () => {
    const store = new Store(dbPath);
    expect(store.list()).toEqual([]);
  });

  it("returns inserted rows, mapped to Contact shape", () => {
    // upsert() isn't implemented yet (saf-02) — insert directly against the
    // schema, same as the story's manual sqlite3-CLI verification.
    const store = new Store(dbPath);
    const now = "2026-08-11T00:00:00.000Z";
    const raw = new DatabaseSync(dbPath);
    raw.prepare(
      `INSERT INTO contacts (id, name, org, role, email, phone, met, what, angle, verdict, nextStep, tags, googleResourceName, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      "Ada Lovelace",
      "Analytical Engines",
      "Mathematician",
      "ada@example.com",
      null,
      "1843 conference",
      "Writes the first algorithm",
      "potential collaborator",
      "strong",
      "Send follow-up notes",
      JSON.stringify(["historical", "math"]),
      null,
      now,
      now,
    );
    raw.close();

    const contacts = store.list();
    expect(contacts).toHaveLength(1);
    expect(contacts[0]).toMatchObject({
      name: "Ada Lovelace",
      org: "Analytical Engines",
      role: "Mathematician",
      email: "ada@example.com",
      verdict: "strong",
      nextStep: "Send follow-up notes",
      tags: ["historical", "math"],
      createdAt: now,
      updatedAt: now,
    });
  });
});

function baseContact(overrides: Partial<Parameters<Store["upsert"]>[0]> = {}) {
  return {
    id: "",
    name: "Grace Hopper",
    verdict: "none" as const,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

describe("Store.upsert()", () => {
  it("dedups by the first identifier (googleResourceName) — a second upsert with the same googleResourceName updates, not inserts", () => {
    const store = new Store(dbPath);
    const first = store.upsert(baseContact({ googleResourceName: "people/c123", name: "Grace Hopper" }));
    const second = store.upsert(
      baseContact({ googleResourceName: "people/c123", name: "Grace Murray Hopper" }),
    );

    expect(second.id).toBe(first.id);
    const all = store.list();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ name: "Grace Murray Hopper", googleResourceName: "people/c123" });
  });

  it("falls back to the second identifier (email) when googleResourceName is absent", () => {
    const store = new Store(dbPath);
    const first = store.upsert(baseContact({ email: "grace@example.com", name: "Grace Hopper" }));
    const second = store.upsert(baseContact({ email: "grace@example.com", name: "G. Hopper" }));

    expect(second.id).toBe(first.id);
    const all = store.list();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ name: "G. Hopper", email: "grace@example.com" });
  });

  it("preserves the original createdAt across an update", async () => {
    const store = new Store(dbPath);
    const first = store.upsert(baseContact({ email: "grace@example.com" }));
    await new Promise((r) => setTimeout(r, 5));
    const second = store.upsert(baseContact({ email: "grace@example.com", name: "Updated Name" }));

    expect(second.createdAt).toBe(first.createdAt);
  });

  it("refreshes updatedAt across an update", async () => {
    const store = new Store(dbPath);
    const first = store.upsert(baseContact({ email: "grace@example.com" }));
    await new Promise((r) => setTimeout(r, 5));
    const second = store.upsert(baseContact({ email: "grace@example.com", name: "Updated Name" }));

    expect(second.updatedAt).not.toBe(first.updatedAt);
    expect(new Date(second.updatedAt).getTime()).toBeGreaterThan(new Date(first.updatedAt).getTime());
  });
});

describe("Store.get()", () => {
  it("returns undefined (not a throw) for an unknown id", () => {
    const store = new Store(dbPath);
    expect(store.get("does-not-exist")).toBeUndefined();
  });

  it("returns the contact for a known id", () => {
    const store = new Store(dbPath);
    const saved = store.upsert(baseContact({ name: "Ada Lovelace" }));
    expect(store.get(saved.id)).toMatchObject({ name: "Ada Lovelace" });
  });
});

describe("Store.setVerdict() / Store.setNextStep()", () => {
  it("setVerdict persists the new verdict", () => {
    const store = new Store(dbPath);
    const saved = store.upsert(baseContact({ verdict: "none" }));
    store.setVerdict(saved.id, "strong");
    expect(store.get(saved.id)).toMatchObject({ verdict: "strong" });
  });

  it("setNextStep persists the new next step", () => {
    const store = new Store(dbPath);
    const saved = store.upsert(baseContact());
    store.setNextStep(saved.id, "Send intro email");
    expect(store.get(saved.id)).toMatchObject({ nextStep: "Send intro email" });
  });
});

describe("Store.search()", () => {
  // Whether node:sqlite's bundled SQLite has fts5 compiled in is a property
  // of the exact Node build running these tests, not something this repo
  // controls — store.ts's migrate() comment notes it was absent on the
  // 22.12 build this suite was originally written against, but a later
  // 22.x patch (e.g. what `actions/setup-node`'s "22.x" resolves to in CI)
  // can differ, and has: CI on Linux was observed to have fts5 available
  // where local macOS dev builds didn't. So don't hardcode which branch is
  // "real" here — detect it live and assert only what that implies, so this
  // test documents current reality on whatever build runs it instead of
  // pinning one platform's outcome. Either way, Store.search() itself must
  // produce correct results — that's what the tests below actually verify,
  // and they hold regardless of which internal branch search() takes.

  it("documents whether this Node build has fts5 (informational — search() must work either way, see tests below)", () => {
    const raw = new DatabaseSync(dbPath);
    try {
      raw.exec("CREATE VIRTUAL TABLE t USING fts5(x)");
      // fts5 is available on this build — Store.search() will use the real
      // MATCH/bm25 path rather than the LIKE-scan fallback. Nothing further
      // to assert here; this branch just documents that fact.
    } catch (err) {
      // fts5 unavailable on this build — Store.search() falls back to the
      // manual LIKE scan (see its try/catch). Confirm it fails the way we
      // expect, so a change in the error text wouldn't silently mean
      // something else broke.
      expect(String(err)).toMatch(/no such module: fts5/);
    }
    raw.close();
  });

  it("matches across name/org/what/angle/tags without crashing when fts5 is unavailable", () => {
    const store = new Store(dbPath);
    store.upsert(baseContact({ name: "Ada Lovelace", org: "Analytical Engines" }));
    store.upsert(baseContact({ name: "Grace Hopper", what: "Compiler pioneer" }));
    store.upsert(baseContact({ name: "Margaret Hamilton", angle: "Apollo guidance software" }));
    store.upsert(baseContact({ name: "Katherine Johnson", tags: ["orbital-mechanics", "nasa"] }));
    store.upsert(baseContact({ name: "Irrelevant Person", org: "Nothing Corp" }));

    expect(store.search("Analytical").map((r) => r.contact.name)).toEqual(["Ada Lovelace"]);
    expect(store.search("Compiler").map((r) => r.contact.name)).toEqual(["Grace Hopper"]);
    expect(store.search("Apollo").map((r) => r.contact.name)).toEqual(["Margaret Hamilton"]);
    expect(store.search("nasa").map((r) => r.contact.name)).toEqual(["Katherine Johnson"]);
    expect(store.search("Hopper").map((r) => r.contact.name)).toEqual(["Grace Hopper"]);
  });

  it("respects the verdict filter", () => {
    const store = new Store(dbPath);
    store.upsert(baseContact({ name: "Strong Match", org: "Rolodex Inc", verdict: "strong" }));
    store.upsert(baseContact({ name: "Watch Match", org: "Rolodex Inc", verdict: "watch" }));

    const results = store.search("Rolodex", { verdict: "strong" });
    expect(results.map((r) => r.contact.name)).toEqual(["Strong Match"]);
  });

  it("respects the limit option", () => {
    const store = new Store(dbPath);
    for (let i = 0; i < 5; i++) {
      store.upsert(baseContact({ name: `Match ${i}`, org: "SharedOrgTerm" }));
    }
    const results = store.search("SharedOrgTerm", { limit: 2 });
    expect(results).toHaveLength(2);
  });

  it("returns no results for a query that matches nothing", () => {
    const store = new Store(dbPath);
    store.upsert(baseContact({ name: "Ada Lovelace" }));
    expect(store.search("zzznomatchzzz")).toEqual([]);
  });

  it("returns [] for an empty or whitespace-only query without touching the database", () => {
    const store = new Store(dbPath);
    store.upsert(baseContact({ name: "Ada Lovelace" }));
    expect(store.search("")).toEqual([]);
    expect(store.search("   ")).toEqual([]);
  });
});

describe("Store.logInteraction() / Store.listInteractions()", () => {
  it("persists an interaction and a subsequent listInteractions() call returns it", () => {
    const store = new Store(dbPath);
    const contact = store.upsert(baseContact({ name: "Ada Lovelace" }));

    store.logInteraction({
      id: "int-1",
      contactId: contact.id,
      at: "2026-08-01T00:00:00.000Z",
      note: "Had a great call about the algorithm.",
      channel: "call",
    });

    const history = store.listInteractions(contact.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      id: "int-1",
      contactId: contact.id,
      at: "2026-08-01T00:00:00.000Z",
      note: "Had a great call about the algorithm.",
      channel: "call",
    });
  });

  it("returns history most-recent-first", () => {
    const store = new Store(dbPath);
    const contact = store.upsert(baseContact({ name: "Ada Lovelace" }));

    store.logInteraction({ id: "int-1", contactId: contact.id, at: "2026-01-01", note: "First touch" });
    store.logInteraction({ id: "int-2", contactId: contact.id, at: "2026-06-01", note: "Second touch" });
    store.logInteraction({ id: "int-3", contactId: contact.id, at: "2026-03-01", note: "Third touch" });

    const history = store.listInteractions(contact.id);
    expect(history.map((i) => i.id)).toEqual(["int-2", "int-3", "int-1"]);
  });

  it("scopes history to the given contact", () => {
    const store = new Store(dbPath);
    const a = store.upsert(baseContact({ name: "Ada Lovelace" }));
    const b = store.upsert(baseContact({ name: "Grace Hopper" }));

    store.logInteraction({ id: "int-a", contactId: a.id, at: "2026-01-01", note: "About Ada" });
    store.logInteraction({ id: "int-b", contactId: b.id, at: "2026-01-01", note: "About Grace" });

    expect(store.listInteractions(a.id).map((i) => i.note)).toEqual(["About Ada"]);
    expect(store.listInteractions(b.id).map((i) => i.note)).toEqual(["About Grace"]);
  });

  it("rejects an empty note", () => {
    const store = new Store(dbPath);
    const contact = store.upsert(baseContact({ name: "Ada Lovelace" }));
    expect(() =>
      store.logInteraction({ id: "int-1", contactId: contact.id, at: "2026-01-01", note: "" }),
    ).toThrow(/note is required/);
  });

  it("rejects a whitespace-only note", () => {
    const store = new Store(dbPath);
    const contact = store.upsert(baseContact({ name: "Ada Lovelace" }));
    expect(() =>
      store.logInteraction({ id: "int-1", contactId: contact.id, at: "2026-01-01", note: "   " }),
    ).toThrow(/note is required/);
  });
});
