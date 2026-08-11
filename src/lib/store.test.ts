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
  // This suite runs on Node 22.12 (the repo's pinned build, per store.ts's
  // migrate() comment), which genuinely has no fts5 module compiled into
  // node:sqlite — confirmed independently by the "no such module: fts5"
  // warning migrate() logs when constructing any Store in this file. So
  // every search() call below is, in this environment, actually exercising
  // the manual LIKE-scan fallback branch (the try{} FTS5 path throws at
  // `.prepare()` since contacts_fts was never created), not just a
  // theoretical code path guarded by a mock.

  it("has no fts5 module on this Node build (sanity check that the fallback below is real, not theoretical)", () => {
    const raw = new DatabaseSync(dbPath);
    expect(() => raw.exec("CREATE VIRTUAL TABLE t USING fts5(x)")).toThrow(/no such module: fts5/);
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
