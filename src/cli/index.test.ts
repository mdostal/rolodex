import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run, parseArgs } from "./index.js";
import { createRolodexMcpServer, type RolodexMcpHandlers } from "../mcp/server.js";
import { Store } from "../lib/store.js";

let dir: string;
let handlers: RolodexMcpHandlers;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "rolodex-cli-test-"));
  const store = new Store(path.join(dir, "rolodex.db"));
  ({ handlers } = createRolodexMcpServer({ store }));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Runs the CLI, capturing stdout/stderr into arrays instead of the real
 * process streams — same in-process, no-subprocess approach as the MCP
 * server's own tests calling handlers directly. */
async function runCli(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, handlers, (s) => out.push(s), (s) => err.push(s));
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

describe("parseArgs", () => {
  it("splits positionals from --flag value pairs", () => {
    expect(parseArgs(["acme", "--verdict", "strong", "--limit", "5"])).toEqual({
      positionals: ["acme"],
      flags: { verdict: "strong", limit: "5" },
    });
  });

  it("throws when a flag is missing its value", () => {
    expect(() => parseArgs(["--verdict"])).toThrow("--verdict requires a value");
  });
});

describe("rolodex upsert", () => {
  it("creates a contact and prints it as JSON", async () => {
    const { code, stdout } = await runCli([
      "upsert",
      "--name",
      "Ada Lovelace",
      "--org",
      "Analytical Engines",
      "--verdict",
      "strong",
      "--tags",
      "math, pioneer",
    ]);
    expect(code).toBe(0);
    const contact = JSON.parse(stdout);
    expect(contact).toMatchObject({ name: "Ada Lovelace", org: "Analytical Engines", verdict: "strong", tags: ["math", "pioneer"] });
  });

  it("requires --name", async () => {
    const { code, stderr } = await runCli(["upsert", "--org", "Acme"]);
    expect(code).toBe(1);
    expect(JSON.parse(stderr).error).toContain("--name");
  });

  it("rejects an invalid --verdict", async () => {
    const { code, stderr } = await runCli(["upsert", "--name", "X", "--verdict", "maybe"]);
    expect(code).toBe(1);
    expect(JSON.parse(stderr).error).toContain("--verdict");
  });
});

describe("rolodex search", () => {
  it("finds a previously-upserted contact", async () => {
    await runCli(["upsert", "--name", "Grace Hopper", "--org", "US Navy"]);
    const { code, stdout } = await runCli(["search", "Navy"]);
    expect(code).toBe(0);
    const results = JSON.parse(stdout);
    expect(results.map((r: { contact: { name: string } }) => r.contact.name)).toEqual(["Grace Hopper"]);
  });

  it("requires a query", async () => {
    const { code, stderr } = await runCli(["search"]);
    expect(code).toBe(1);
    expect(JSON.parse(stderr).error).toContain("query");
  });
});

describe("rolodex followups", () => {
  it("returns an empty array on a fresh store", async () => {
    const { code, stdout } = await runCli(["followups"]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual([]);
  });
});

describe("rolodex log", () => {
  it("logs an interaction against a contact", async () => {
    const { stdout: created } = await runCli(["upsert", "--name", "Ada Lovelace"]);
    const id = JSON.parse(created).id;

    const { code, stdout } = await runCli(["log", id, "First call — went well.", "--channel", "call"]);
    expect(code).toBe(0);
    const interaction = JSON.parse(stdout);
    expect(interaction).toMatchObject({ contactId: id, note: "First call — went well.", channel: "call" });
  });

  it("requires both a contactId and a note", async () => {
    const { code, stderr } = await runCli(["log", "some-id"]);
    expect(code).toBe(1);
    expect(JSON.parse(stderr).error).toContain("log requires");
  });
});

describe("unknown command / help", () => {
  it("exits 2 with a usage message on an unknown command", async () => {
    const { code, stderr } = await runCli(["frobnicate"]);
    expect(code).toBe(2);
    expect(stderr).toContain("Unknown command: frobnicate");
  });

  it("prints usage and exits 0 on --help", async () => {
    const { code, stdout } = await runCli(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("Commands:");
  });

  it("prints usage and exits 1 with no command", async () => {
    const { code, stdout } = await runCli([]);
    expect(code).toBe(1);
    expect(stdout).toContain("Commands:");
  });
});
