import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRolodexServer, type RolodexServerOptions } from "./server.js";
import { createInMemorySecretsAdapter } from "../lib/secrets-adapter.js";
import type { SecretsAdapter } from "../lib/secrets-adapter.js";

let dir: string;
let server: Server | undefined;
const originalRolodexDb = process.env.ROLODEX_DB;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "rolodex-server-test-"));
  delete process.env.ROLODEX_DB;
});

afterEach(async () => {
  if (server) {
    await new Promise((resolve) => server!.close(resolve));
    server = undefined;
  }
  rmSync(dir, { recursive: true, force: true });
  if (originalRolodexDb === undefined) delete process.env.ROLODEX_DB;
  else process.env.ROLODEX_DB = originalRolodexDb;
});

async function start(
  opts: Partial<RolodexServerOptions> = {},
): Promise<{ baseUrl: string; secrets: SecretsAdapter }> {
  const secrets = opts.secrets ?? createInMemorySecretsAdapter();
  server = createRolodexServer({
    homeDir: dir,
    secretsCapabilityFactory: () => createInMemorySecretsAdapter(),
    ...opts,
    secrets, // always the resolved value, so the test can read back what the server actually uses
  });
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  const address = server!.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { baseUrl: `http://127.0.0.1:${port}`, secrets };
}

async function getJson(url: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url);
  const body = await res.json().catch(() => undefined);
  return { status: res.status, body };
}

async function postJson(url: string, payload?: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, {
    method: "POST",
    headers: payload !== undefined ? { "content-type": "application/json" } : undefined,
    body: payload !== undefined ? JSON.stringify(payload) : undefined,
  });
  const body = await res.json().catch(() => undefined);
  return { status: res.status, body };
}

describe("first-run detection", () => {
  it("serves the wizard at / when wizard.completed is unset", async () => {
    const { baseUrl } = await start();
    const res = await fetch(baseUrl + "/");
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("Rolodex Setup");
  });

  it("serves the main app at / once wizard.completed is set", async () => {
    const secrets = createInMemorySecretsAdapter();
    await secrets.set("wizard.completed", new Date().toISOString());
    const { baseUrl } = await start({ secrets });
    const res = await fetch(baseUrl + "/");
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).not.toContain("Rolodex Setup");
  });

  it("GET /api/wizard/status reflects completion state", async () => {
    const { baseUrl } = await start();
    expect(await getJson(baseUrl + "/api/wizard/status")).toEqual({ status: 200, body: { completed: false } });

    await postJson(baseUrl + "/api/wizard/complete");
    expect(await getJson(baseUrl + "/api/wizard/status")).toEqual({ status: 200, body: { completed: true } });
  });
});

describe("main app routes gated behind wizard completion", () => {
  it("GET /api/contacts returns 409 before the wizard is complete", async () => {
    const { baseUrl } = await start();
    const { status, body } = await getJson(baseUrl + "/api/contacts");
    expect(status).toBe(409);
    expect(body).toEqual({ error: "setup not complete" });
  });

  it("GET /api/contacts works once the wizard is complete", async () => {
    const { baseUrl } = await start();
    await postJson(baseUrl + "/api/wizard/complete");
    const { status, body } = await getJson(baseUrl + "/api/contacts");
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });
});

describe("POST /api/wizard/database and friends", () => {
  it("GET reports the default path as writable", async () => {
    const { baseUrl } = await start();
    const { status, body } = await getJson(baseUrl + "/api/wizard/database");
    expect(status).toBe(200);
    expect(body).toMatchObject({ path: `${dir}/.local/share/rolodex/rolodex.db`, isDefault: true, writable: true });
  });

  it("POST with a writable candidate path persists it as the new resolved path", async () => {
    const { baseUrl } = await start();
    const candidate = path.join(dir, "custom-location", "rolodex.db");
    const post = await postJson(baseUrl + "/api/wizard/database", { path: candidate });
    expect(post.status).toBe(200);
    expect(post.body).toMatchObject({ path: candidate, isDefault: false, writable: true });

    const get = await getJson(baseUrl + "/api/wizard/database");
    expect(get.body).toMatchObject({ path: candidate, isDefault: false, writable: true });
  });

  it("POST with a genuinely unwritable candidate path reports writable:false and does NOT persist it", async () => {
    const { baseUrl } = await start();
    const post = await postJson(baseUrl + "/api/wizard/database", { path: "/etc/hosts/rolodex.db" });
    expect(post.status).toBe(200);
    expect(post.body).toMatchObject({ writable: false });
    expect((post.body as { error?: string }).error).toBeTruthy();

    // Rejected candidate must not have clobbered the (still-default) resolved path.
    const get = await getJson(baseUrl + "/api/wizard/database");
    expect(get.body).toMatchObject({ path: `${dir}/.local/share/rolodex/rolodex.db`, isDefault: true });
  });

  it("POST /api/wizard/database/reset clears a previously-set override", async () => {
    const { baseUrl } = await start();
    const candidate = path.join(dir, "custom-location", "rolodex.db");
    await postJson(baseUrl + "/api/wizard/database", { path: candidate });

    const reset = await postJson(baseUrl + "/api/wizard/database/reset");
    expect(reset.status).toBe(200);
    expect(reset.body).toMatchObject({ path: `${dir}/.local/share/rolodex/rolodex.db`, isDefault: true });

    const get = await getJson(baseUrl + "/api/wizard/database");
    expect(get.body).toMatchObject({ path: `${dir}/.local/share/rolodex/rolodex.db` });
  });

  it("POST without a path returns 400", async () => {
    const { baseUrl } = await start();
    const { status, body } = await postJson(baseUrl + "/api/wizard/database", {});
    expect(status).toBe(400);
    expect(body).toEqual({ error: "path is required" });
  });
});

describe("POST /api/wizard/google", () => {
  it("rejects an empty clientId or clientSecret with 400, and writes nothing", async () => {
    const { baseUrl, secrets } = await start();
    const r1 = await postJson(baseUrl + "/api/wizard/google", { clientId: "", clientSecret: "s3cr3t" });
    expect(r1.status).toBe(400);
    const r2 = await postJson(baseUrl + "/api/wizard/google", { clientId: "abc", clientSecret: "" });
    expect(r2.status).toBe(400);
    expect(await secrets.get("google.oauth.client")).toBeUndefined();
  });

  it("writes clientId/clientSecret through SecretsAdapter.set() only — never anywhere else", async () => {
    const { baseUrl, secrets } = await start();
    const { status, body } = await postJson(baseUrl + "/api/wizard/google", {
      clientId: "client-123.apps.googleusercontent.com",
      clientSecret: "GOCSPX-supersecret",
    });
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });

    const stored = await secrets.get("google.oauth.client");
    expect(stored).toBeDefined();
    expect(JSON.parse(stored!)).toEqual({
      clientId: "client-123.apps.googleusercontent.com",
      clientSecret: "GOCSPX-supersecret",
    });
  });

  it("POST /api/wizard/google/skip succeeds without requiring credentials", async () => {
    const { baseUrl, secrets } = await start();
    const { status, body } = await postJson(baseUrl + "/api/wizard/google/skip");
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(await secrets.get("google.oauth.client")).toBeUndefined();
  });
});

describe("POST /api/wizard/secrets-check", () => {
  it("reflects a successful probe (200, ok:true)", async () => {
    const { baseUrl } = await start({ secretsCapabilityFactory: () => createInMemorySecretsAdapter() });
    const { status, body } = await postJson(baseUrl + "/api/wizard/secrets-check");
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, backend: "macOS Keychain" });
  });

  it("reflects a failing probe (422, ok:false, with an error message) — real, not simulated success", async () => {
    const failingFactory = () => {
      const failing: SecretsAdapter = {
        async get() { return undefined; },
        async set() { throw new Error("EACCES: permission denied"); },
        async delete() {},
      };
      return failing;
    };
    const { baseUrl } = await start({ secretsCapabilityFactory: failingFactory });
    const { status, body } = await postJson(baseUrl + "/api/wizard/secrets-check");
    expect(status).toBe(422);
    expect(body).toMatchObject({ ok: false, backend: "macOS Keychain" });
    expect((body as { error?: string }).error).toContain("permission");
  });
});

describe("GET /api/wizard/summary", () => {
  it("reports dbPath, googleConfigured, and the secrets probe result", async () => {
    const { baseUrl } = await start();
    await postJson(baseUrl + "/api/wizard/google", { clientId: "id", clientSecret: "secret" });
    const { status, body } = await getJson(baseUrl + "/api/wizard/summary");
    expect(status).toBe(200);
    expect(body).toMatchObject({
      dbPath: `${dir}/.local/share/rolodex/rolodex.db`,
      googleConfigured: true,
      secrets: { ok: true, backend: "macOS Keychain" },
    });
  });
});

describe("POST /api/wizard/complete", () => {
  it("sets the wizard.completed sentinel to an ISO timestamp and flips first-run detection", async () => {
    const { baseUrl, secrets } = await start();
    const before = await secrets.get("wizard.completed");
    expect(before).toBeUndefined();

    const { status, body } = await postJson(baseUrl + "/api/wizard/complete");
    expect(status).toBe(200);
    expect((body as { completed: boolean }).completed).toBe(true);

    const stored = await secrets.get("wizard.completed");
    expect(stored).toBeDefined();
    expect(new Date(stored!).toISOString()).toBe(stored);

    const { body: statusBody } = await getJson(baseUrl + "/api/wizard/status");
    expect(statusBody).toEqual({ completed: true });
  });

  it("returns 500 with a real error (not a crash) when the resolved DB path genuinely can't be opened", async () => {
    process.env.ROLODEX_DB = "/etc/hosts/subdir/rolodex.db";
    const { baseUrl, secrets } = await start();
    const { status, body } = await postJson(baseUrl + "/api/wizard/complete");
    expect(status).toBe(500);
    expect((body as { error?: string }).error).toBeTruthy();
    // Must not have flipped the sentinel on a failed completion.
    expect(await secrets.get("wizard.completed")).toBeUndefined();
  });
});
