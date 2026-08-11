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
