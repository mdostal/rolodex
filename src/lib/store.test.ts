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
