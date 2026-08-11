import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkDbPathWritable,
  clearDbPathOverride,
  defaultDbPath,
  getDbPathOverride,
  resolveDbPath,
  setDbPathOverride,
} from "./db-location.js";

let dir: string;
const originalRolodexDb = process.env.ROLODEX_DB;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "rolodex-db-location-test-"));
  delete process.env.ROLODEX_DB;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (originalRolodexDb === undefined) delete process.env.ROLODEX_DB;
  else process.env.ROLODEX_DB = originalRolodexDb;
});

describe("defaultDbPath()", () => {
  it("resolves under <homeDir>/.local/share/rolodex/rolodex.db", () => {
    expect(defaultDbPath(dir)).toBe(`${dir}/.local/share/rolodex/rolodex.db`);
  });
});

describe("getDbPathOverride() / setDbPathOverride() / clearDbPathOverride()", () => {
  it("returns undefined before any override is set", async () => {
    expect(await getDbPathOverride(dir)).toBeUndefined();
  });

  it("round-trips a set override", async () => {
    const custom = path.join(dir, "custom", "rolodex.db");
    await setDbPathOverride(custom, dir);
    expect(await getDbPathOverride(dir)).toBe(custom);
  });

  it("clearDbPathOverride() removes a previously set override", async () => {
    const custom = path.join(dir, "custom", "rolodex.db");
    await setDbPathOverride(custom, dir);
    await clearDbPathOverride(dir);
    expect(await getDbPathOverride(dir)).toBeUndefined();
  });

  it("clearDbPathOverride() on a never-configured homeDir is a no-op, not a throw", async () => {
    await expect(clearDbPathOverride(dir)).resolves.toBeUndefined();
  });
});

describe("resolveDbPath()", () => {
  it("falls back to the default path when nothing is configured", async () => {
    expect(await resolveDbPath(dir)).toBe(defaultDbPath(dir));
  });

  it("prefers a wizard-set override over the default", async () => {
    const custom = path.join(dir, "custom", "rolodex.db");
    await setDbPathOverride(custom, dir);
    expect(await resolveDbPath(dir)).toBe(custom);
  });

  it("ROLODEX_DB env var wins over a wizard-set override", async () => {
    const custom = path.join(dir, "custom", "rolodex.db");
    await setDbPathOverride(custom, dir);
    process.env.ROLODEX_DB = "/env/wins/rolodex.db";
    expect(await resolveDbPath(dir)).toBe("/env/wins/rolodex.db");
  });
});

describe("checkDbPathWritable()", () => {
  it("reports writable:true for a fresh, creatable directory", async () => {
    const target = path.join(dir, "nested", "rolodex.db");
    const result = await checkDbPathWritable(target);
    expect(result).toEqual({ writable: true });
  });

  it("reports writable:true for a directory that already exists", async () => {
    const target = path.join(dir, "rolodex.db");
    await checkDbPathWritable(target); // creates dir (which is just `dir`, already exists)
    const result = await checkDbPathWritable(target);
    expect(result.writable).toBe(true);
  });

  // Real (not simulated) failure: /etc/hosts exists as a regular file on
  // every macOS/Linux box, so treating it as a directory component
  // deterministically fails with ENOTDIR — no root/special permissions
  // needed, and no mocking of fs required.
  it("reports writable:false with a real, specific error for a genuinely unwritable path", async () => {
    const result = await checkDbPathWritable("/etc/hosts/rolodex.db");
    expect(result.writable).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
