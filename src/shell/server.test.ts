import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRolodexServer, type RolodexServerOptions } from "./server.js";
import { createInMemorySecretsAdapter } from "../lib/secrets-adapter.js";
import type { CreateSecretsAdapterOptions, SecretsAdapter } from "../lib/secrets-adapter.js";
import { getSecretsBackendChoiceSync, setSecretsBackendChoice } from "./secrets-backend-config.js";
import { Store } from "../lib/store.js";

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

async function patchJson(url: string, payload?: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, {
    method: "PATCH",
    headers: payload !== undefined ? { "content-type": "application/json" } : undefined,
    body: payload !== undefined ? JSON.stringify(payload) : undefined,
  });
  const body = await res.json().catch(() => undefined);
  return { status: res.status, body };
}

async function putJson(url: string, payload?: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, {
    method: "PUT",
    headers: payload !== undefined ? { "content-type": "application/json" } : undefined,
    body: payload !== undefined ? JSON.stringify(payload) : undefined,
  });
  const body = await res.json().catch(() => undefined);
  return { status: res.status, body };
}

async function deleteRequest(url: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, { method: "DELETE" });
  // A real 204 has no body at all — res.json() on an empty body throws,
  // which the .catch() here treats the same as "no body", matching every
  // other helper's shape rather than needing a special case at call sites.
  const body = await res.json().catch(() => undefined);
  return { status: res.status, body };
}

/** Sends a raw, deliberately-malformed JSON body (not run through
 * JSON.stringify — postJson()/patchJson() can only ever send valid JSON). */
async function postRawBody(
  url: string,
  method: string,
  rawBody: string,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: rawBody,
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

/** A minimal deferred promise — same shape as google-oauth-flow.test.ts's own
 * helper — used below to await "the fake connectGoogleAccount has actually
 * been invoked" / "the signal it received actually fired abort" without
 * depending on any arbitrary sleep/poll. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("POST /api/wizard/google/connect", () => {
  it("returns 400 and never calls connectGoogleAccount when no client credentials are saved yet", async () => {
    let called = false;
    const fakeConnect = async () => {
      called = true;
    };
    const { baseUrl } = await start({ connectGoogleAccount: fakeConnect });

    const { status, body } = await postJson(baseUrl + "/api/wizard/google/connect");
    expect(status).toBe(400);
    expect((body as { error?: string }).error).toBeTruthy();
    expect(called).toBe(false);
  });

  it("on success, calls connectGoogleAccount with the saved credentials + this server's secrets adapter, and returns {connected:true}", async () => {
    let calledWith: { clientId?: string; clientSecret?: string; secrets?: unknown } | undefined;
    const fakeConnect = async (opts: { clientId: string; clientSecret: string; secrets: unknown }) => {
      calledWith = opts;
    };
    const { baseUrl, secrets } = await start({ connectGoogleAccount: fakeConnect });
    await postJson(baseUrl + "/api/wizard/google", { clientId: "client-abc", clientSecret: "s3cret" });

    const { status, body } = await postJson(baseUrl + "/api/wizard/google/connect");
    expect(status).toBe(200);
    expect(body).toEqual({ connected: true });
    expect(calledWith).toMatchObject({ clientId: "client-abc", clientSecret: "s3cret" });
    expect(calledWith?.secrets).toBe(secrets);
  });

  it("returns a clear JSON error with a 5xx status when connectGoogleAccount rejects (denied/timeout/malformed)", async () => {
    const fakeConnect = async () => {
      throw new Error("Google sign-in was canceled: consent was denied.");
    };
    const { baseUrl } = await start({ connectGoogleAccount: fakeConnect });
    await postJson(baseUrl + "/api/wizard/google", { clientId: "id", clientSecret: "secret" });

    const { status, body } = await postJson(baseUrl + "/api/wizard/google/connect");
    expect(status).toBeGreaterThanOrEqual(500);
    expect(status).toBeLessThan(600);
    expect((body as { error?: string }).error).toBe("Google sign-in was canceled: consent was denied.");
  });

  it("aborting the HTTP request mid-flight really propagates to connectGoogleAccount's AbortSignal", async () => {
    const started = deferred();
    const aborted = deferred<void>();
    let capturedSignal: AbortSignal | undefined;
    const fakeConnect = (opts: { signal?: AbortSignal }) => {
      capturedSignal = opts.signal;
      started.resolve();
      return new Promise<void>((_resolve, reject) => {
        // Proves the signal actually fires — not just that it's present —
        // by hanging until (and only until) an 'abort' event really reaches
        // this fake, mirroring how the real connectGoogleAccount tears its
        // listener down on abort instead of running out the full 120s.
        opts.signal?.addEventListener("abort", () => {
          aborted.resolve();
          reject(new Error("Google connect canceled."));
        });
      });
    };
    const { baseUrl } = await start({ connectGoogleAccount: fakeConnect });
    await postJson(baseUrl + "/api/wizard/google", { clientId: "id", clientSecret: "secret" });

    const controller = new AbortController();
    const fetchPromise = fetch(baseUrl + "/api/wizard/google/connect", {
      method: "POST",
      signal: controller.signal,
    });
    fetchPromise.catch(() => {}); // client-side abort rejects this — expected, asserted below

    // Wait for the server to have actually reached connectGoogleAccount
    // before cancelling, so the abort is a genuine mid-flight cancel.
    await started.promise;
    expect(capturedSignal?.aborted).toBe(false);

    controller.abort();

    await expect(fetchPromise).rejects.toThrow();
    // The real proof of propagation: the fake's own listener on the signal
    // it was handed actually fired.
    await aborted.promise;
    expect(capturedSignal?.aborted).toBe(true);
  });
});

// The settings popover's "Reconnect Google" action (src/shell/index.html's
// wireSettingsPanel()/runReconnect()) is a second UI entry point into this
// exact same route — no new server-side route or OAuth logic was added for
// it. That means: (1) the served main-app HTML must actually contain the new
// action wired to this route, and (2) since the server has no notion of
// "which UI called me", the abort-propagation contract already proven above
// for the wizard's call site is the same contract this call site depends on
// — proven again here specifically against a server in the *post-wizard*
// state (wizard.completed already set), i.e. the state the settings popover
// actually runs in, rather than only ever exercising this route mid-wizard.
describe("Settings popover 'Reconnect Google' entry point", () => {
  it("the served main app HTML includes a Reconnect Google action wired to POST /api/wizard/google/connect", async () => {
    const secrets = createInMemorySecretsAdapter();
    await secrets.set("wizard.completed", new Date().toISOString());
    const { baseUrl } = await start({ secrets });

    const res = await fetch(baseUrl + "/");
    const html = await res.text();
    expect(res.status).toBe(200);
    // The settings popover's Google section and its idle action button.
    expect(html).toContain('id="google-section"');
    expect(html).toContain("Reconnect Google");
    // The exact same route the wizard's Google-connect step uses — proves
    // this is a second entry point into the existing flow, not a new one.
    expect(html).toContain("/api/wizard/google/connect");
    // The follow-up settings form must still be present, completely
    // untouched, alongside the new Google section.
    expect(html).toContain('id="settings-form"');
    expect(html).toContain('id="settings-window"');
    expect(html).toContain('id="settings-grace"');
  });

  it("on success, works identically when called after the wizard is already complete (the settings popover's real-world state)", async () => {
    let calledWith: { clientId?: string; clientSecret?: string; secrets?: unknown } | undefined;
    const fakeConnect = async (opts: { clientId: string; clientSecret: string; secrets: unknown }) => {
      calledWith = opts;
    };
    const secrets = createInMemorySecretsAdapter();
    await secrets.set("wizard.completed", new Date().toISOString());
    const { baseUrl } = await start({ secrets, connectGoogleAccount: fakeConnect });
    await postJson(baseUrl + "/api/wizard/google", { clientId: "client-abc", clientSecret: "s3cret" });

    const { status, body } = await postJson(baseUrl + "/api/wizard/google/connect");
    expect(status).toBe(200);
    expect(body).toEqual({ connected: true });
    expect(calledWith).toMatchObject({ clientId: "client-abc", clientSecret: "s3cret" });
    expect(calledWith?.secrets).toBe(secrets);
  });

  it("aborting the HTTP request mid-flight (the settings popover's Cancel button / panel-close behavior) really propagates to connectGoogleAccount's AbortSignal, after the wizard is already complete", async () => {
    const started = deferred();
    const aborted = deferred<void>();
    let capturedSignal: AbortSignal | undefined;
    const fakeConnect = (opts: { signal?: AbortSignal }) => {
      capturedSignal = opts.signal;
      started.resolve();
      return new Promise<void>((_resolve, reject) => {
        // Same real proof as the wizard's own abort test: hangs until (and
        // only until) an 'abort' event genuinely reaches this fake.
        opts.signal?.addEventListener("abort", () => {
          aborted.resolve();
          reject(new Error("Google connect canceled."));
        });
      });
    };
    const secrets = createInMemorySecretsAdapter();
    await secrets.set("wizard.completed", new Date().toISOString());
    const { baseUrl } = await start({ secrets, connectGoogleAccount: fakeConnect });
    await postJson(baseUrl + "/api/wizard/google", { clientId: "id", clientSecret: "secret" });

    // Mirrors exactly what runReconnect()'s `api("/api/wizard/google/connect",
    // { method: "POST", signal: controller.signal })` does, and what
    // clicking the popover's Cancel button (or closing the panel mid-flight)
    // does to that same controller.
    const controller = new AbortController();
    const fetchPromise = fetch(baseUrl + "/api/wizard/google/connect", {
      method: "POST",
      signal: controller.signal,
    });
    fetchPromise.catch(() => {});

    await started.promise;
    expect(capturedSignal?.aborted).toBe(false);

    controller.abort();

    await expect(fetchPromise).rejects.toThrow();
    await aborted.promise;
    expect(capturedSignal?.aborted).toBe(true);
  });
});

// checkSecretsCapability() (src/lib/secrets-check.ts) short-circuits to
// `{ ok: false, backend: "none", error: "No secure keychain is available in
// this session." }` on a non-Darwin platform ONLY when using the real,
// unconfigured default factory (i.e. genuine production usage with no
// injection) — see secrets-check.ts's own comment on this. Every test below
// explicitly injects its own secretsCapabilityFactory (or relies on
// start()'s own default injection of createInMemorySecretsAdapter()), so
// the platform short-circuit never applies to any of them — behavior is
// deterministic regardless of which platform the suite happens to run on.
// (An earlier version of this file's tests branched on process.platform
// here, working around a real bug where the short-circuit fired even for
// injected factories, defeating dependency injection on non-Darwin CI —
// fixed in secrets-check.ts; these tests now assert the corrected,
// platform-independent behavior directly.)
describe("POST /api/wizard/secrets-check", () => {
  it("reflects a successful probe (200, ok:true) against the injected backend", async () => {
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

  // This story's addition: the route now reads `backend` out of the POST
  // body and threads it through to checkSecretsCapability(). "portunus" is
  // deliberately used for most of these (rather than "keychain") because
  // checkSecretsCapability() only applies the non-Darwin "no secure
  // keychain" short-circuit to the keychain backend — a Portunus probe runs
  // the real factory/round-trip logic on every platform the suite happens
  // to run on, so these assertions don't need to branch on
  // process.platform the way the keychain-probing tests above do.
  it("passes body.backend through to the capability factory, and the response reflects the Portunus-specific label", async () => {
    let seenBackend: unknown;
    const factory = (opts?: CreateSecretsAdapterOptions) => {
      seenBackend = opts?.backend;
      return createInMemorySecretsAdapter();
    };
    const { baseUrl } = await start({ secretsCapabilityFactory: factory });
    const { status, body } = await postJson(baseUrl + "/api/wizard/secrets-check", { backend: "portunus" });
    expect(seenBackend).toBe("portunus");
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, backend: "Portunus" });
  });

  it("a failing probe against the portunus backend (via body.backend) returns the Portunus label and Portunus-specific error text, never keychain vocabulary", async () => {
    const failingFactory = () => {
      const failing: SecretsAdapter = {
        async get() { return undefined; },
        async set() { throw new Error("portunus: unknown reference {{secret:x}}"); },
        async delete() {},
      };
      return failing;
    };
    const { baseUrl } = await start({ secretsCapabilityFactory: failingFactory });
    const { status, body } = await postJson(baseUrl + "/api/wizard/secrets-check", { backend: "portunus" });
    expect(status).toBe(422);
    expect(body).toMatchObject({ ok: false, backend: "Portunus" });
    const err = (body as { error?: string }).error ?? "";
    expect(err.toLowerCase()).not.toContain("keychain");
    expect(err).toBe("No matching Portunus reference was found.");
  });

  it("omitting backend from the request body defaults the factory call to \"keychain\" — byte-identical to before this parameter existed", async () => {
    let seenBackend: unknown = "(factory never called)";
    const factory = (opts?: CreateSecretsAdapterOptions) => {
      seenBackend = opts?.backend;
      return createInMemorySecretsAdapter();
    };
    const { baseUrl } = await start({ secretsCapabilityFactory: factory });
    await postJson(baseUrl + "/api/wizard/secrets-check");
    expect(seenBackend).toBe("keychain");
  });

  it("an unrecognized body.backend value falls back to \"keychain\" rather than crashing", async () => {
    const { baseUrl } = await start({ secretsCapabilityFactory: () => createInMemorySecretsAdapter() });
    const { status, body } = await postJson(baseUrl + "/api/wizard/secrets-check", { backend: "not-a-real-backend" });
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, backend: "macOS Keychain" });
  });
});

// pfb-04: GET /api/wizard/secrets-backends tells the wizard's Secrets screen
// whether Portunus is available at all (a lightweight `portunus --version`
// probe, injectable via RolodexServerOptions.isPortunusAvailable so these
// tests don't depend on whether the machine running them happens to have a
// real `portunus` binary on PATH).
describe("GET /api/wizard/secrets-backends", () => {
  it("reports portunusAvailable:true when the injected probe resolves true", async () => {
    const { baseUrl } = await start({ isPortunusAvailable: async () => true });
    const { status, body } = await getJson(baseUrl + "/api/wizard/secrets-backends");
    expect(status).toBe(200);
    expect(body).toEqual({ portunusAvailable: true });
  });

  it("reports portunusAvailable:false when the injected probe resolves false", async () => {
    const { baseUrl } = await start({ isPortunusAvailable: async () => false });
    const { status, body } = await getJson(baseUrl + "/api/wizard/secrets-backends");
    expect(status).toBe(200);
    expect(body).toEqual({ portunusAvailable: false });
  });

  it("defaults to the real isPortunusAvailable() probe when not injected, and never throws regardless of what's actually installed on this machine", async () => {
    const { baseUrl } = await start();
    const { status, body } = await getJson(baseUrl + "/api/wizard/secrets-backends");
    expect(status).toBe(200);
    expect(typeof (body as { portunusAvailable: unknown }).portunusAvailable).toBe("boolean");
  });
});

// pfb-04: POST /api/wizard/secrets-backend-choice persists the wizard's
// Secrets-screen choice via setSecretsBackendChoice(), which
// getSecretsBackendChoiceSync(homeDir) later reads back synchronously at the
// next `secrets` construction (see secrets-backend-config.ts).
describe("POST /api/wizard/secrets-backend-choice", () => {
  it("persists 'portunus' and it's readable back via getSecretsBackendChoiceSync()", async () => {
    const { baseUrl } = await start();
    const { status, body } = await postJson(baseUrl + "/api/wizard/secrets-backend-choice", { backend: "portunus" });
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, backend: "portunus" });
    expect(getSecretsBackendChoiceSync(dir)).toBe("portunus");
  });

  it("persists 'keychain' explicitly (e.g. switching back) and it's readable back too", async () => {
    const { baseUrl } = await start();
    await postJson(baseUrl + "/api/wizard/secrets-backend-choice", { backend: "portunus" });
    const { status, body } = await postJson(baseUrl + "/api/wizard/secrets-backend-choice", { backend: "keychain" });
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, backend: "keychain" });
    expect(getSecretsBackendChoiceSync(dir)).toBe("keychain");
  });

  it("rejects an unrecognized backend value with 400 and does not persist it", async () => {
    const { baseUrl } = await start();
    const { status, body } = await postJson(baseUrl + "/api/wizard/secrets-backend-choice", { backend: "not-a-real-backend" });
    expect(status).toBe(400);
    expect((body as { error?: string }).error).toBeTruthy();
    expect(getSecretsBackendChoiceSync(dir)).toBe("keychain");
  });

  it("rejects a missing backend field with 400", async () => {
    const { baseUrl } = await start();
    const { status } = await postJson(baseUrl + "/api/wizard/secrets-backend-choice", {});
    expect(status).toBe(400);
  });

  it("with malformed JSON returns 400, not 500", async () => {
    const { baseUrl } = await start();
    const { status } = await postRawBody(baseUrl + "/api/wizard/secrets-backend-choice", "POST", "{not valid json");
    expect(status).toBe(400);
  });
});

// pfb-04: server.ts's `secrets` construction call site
// (`opts.secrets ?? secretsAdapterFactory({ backend: getSecretsBackendChoiceSync(homeDir) })`).
// These tests bypass the shared `start()` helper above (which always forces
// an explicit `secrets` value, short-circuiting this call site entirely) and
// call createRolodexServer() directly, so the factory/backend wiring is
// actually exercised.
describe("`secrets` construction: backend resolution via getSecretsBackendChoiceSync (pfb-04)", () => {
  async function startBare(opts: Partial<RolodexServerOptions> = {}): Promise<{ baseUrl: string; server: Server }> {
    const s = createRolodexServer({
      homeDir: dir,
      secretsCapabilityFactory: () => createInMemorySecretsAdapter(),
      ...opts,
    });
    await new Promise<void>((resolve) => s.listen(0, resolve));
    const address = s.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { baseUrl: `http://127.0.0.1:${port}`, server: s };
  }

  it("defaults to 'keychain' when nothing has been persisted (fresh install)", async () => {
    let seenBackend: unknown;
    const factory = (opts?: CreateSecretsAdapterOptions) => {
      seenBackend = opts?.backend;
      return createInMemorySecretsAdapter();
    };
    const { server } = await startBare({ secretsAdapterFactory: factory });
    try {
      expect(seenBackend).toBe("keychain");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("resolves to 'portunus' once that choice has been persisted for this homeDir", async () => {
    await setSecretsBackendChoice("portunus", dir);
    let seenBackend: unknown;
    const factory = (opts?: CreateSecretsAdapterOptions) => {
      seenBackend = opts?.backend;
      return createInMemorySecretsAdapter();
    };
    const { server } = await startBare({ secretsAdapterFactory: factory });
    try {
      expect(seenBackend).toBe("portunus");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("falls back to 'keychain' and does NOT crash server construction when wizard-config.json is corrupt", async () => {
    mkdirSync(path.join(dir, ".local/share/rolodex"), { recursive: true });
    writeFileSync(path.join(dir, ".local/share/rolodex/wizard-config.json"), "{ not valid json at all");
    let seenBackend: unknown;
    const factory = (opts?: CreateSecretsAdapterOptions) => {
      seenBackend = opts?.backend;
      return createInMemorySecretsAdapter();
    };
    let result: { baseUrl: string; server: Server } | undefined;
    await expect(
      (async () => {
        result = await startBare({ secretsAdapterFactory: factory });
      })(),
    ).resolves.toBeUndefined();
    try {
      expect(seenBackend).toBe("keychain");
    } finally {
      if (result) await new Promise((resolve) => result!.server.close(resolve));
    }
  });

  it("opts.secrets, when given, bypasses secretsAdapterFactory entirely (unaffected by this story)", async () => {
    let called = false;
    const factory = () => {
      called = true;
      return createInMemorySecretsAdapter();
    };
    const { server } = await startBare({ secrets: createInMemorySecretsAdapter(), secretsAdapterFactory: factory });
    try {
      expect(called).toBe(false);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // The core acceptance criterion: "User selects Portunus, check succeeds,
  // proceeds -> choice persisted to wizard-config.json BEFORE navigating to
  // 'google', and the subsequent Google-connect screen's secrets.set()
  // calls are verified (via a real or injected check) to actually use the
  // Portunus backend." Per this story's deliberate synchronous-read-at-
  // construction-time design (secrets-backend-config.ts's top-of-file
  // docstring, resolving grill finding F3), the persisted choice takes
  // effect starting at the NEXT time `secrets` is constructed for this
  // homeDir — not as a live hot-swap mid-process — so this test genuinely
  // exercises that exact contract: persist through the real wizard route,
  // then construct a fresh server for the same homeDir and prove ITS
  // Google-connect route's secrets.set() call lands on the Portunus-
  // resolved adapter, via a tagged fake that both records which `backend`
  // secretsAdapterFactory was asked for AND is independently readable back.
  it("a Portunus choice persisted via the real wizard route is what the next `secrets` construction for this homeDir resolves to — and that adapter is what the Google-connect route's secrets.set() call actually uses", async () => {
    const { baseUrl } = await start({ isPortunusAvailable: async () => true });
    const avail = await getJson(baseUrl + "/api/wizard/secrets-backends");
    expect(avail.body).toEqual({ portunusAvailable: true });

    const choice = await postJson(baseUrl + "/api/wizard/secrets-backend-choice", { backend: "portunus" });
    expect(choice.status).toBe(200);
    expect(choice.body).toEqual({ ok: true, backend: "portunus" });
    expect(getSecretsBackendChoiceSync(dir)).toBe("portunus");

    function taggedAdapter(tag: string): SecretsAdapter & { tag: string } {
      const store = new Map<string, string>();
      return {
        tag,
        async get(key) {
          return store.get(key);
        },
        async set(key, value) {
          store.set(key, value);
        },
        async delete(key) {
          store.delete(key);
        },
      };
    }

    let builtBackend: unknown;
    let capturedAdapter: (SecretsAdapter & { tag: string }) | undefined;
    const { server, baseUrl: baseUrl2 } = await startBare({
      secretsAdapterFactory: (opts?: CreateSecretsAdapterOptions) => {
        builtBackend = opts?.backend;
        capturedAdapter = taggedAdapter(opts?.backend ?? "keychain");
        return capturedAdapter;
      },
    });
    try {
      expect(builtBackend).toBe("portunus");
      expect(capturedAdapter?.tag).toBe("portunus");

      const saved = await postJson(baseUrl2 + "/api/wizard/google", { clientId: "gid", clientSecret: "gsecret" });
      expect(saved.status).toBe(200);

      // Definitive proof: read the value back directly off the exact tagged
      // adapter instance secretsAdapterFactory returned — not some other
      // adapter — confirming the Google-connect route's secrets.set() call
      // really went through the Portunus-resolved `secrets`.
      const stored = await capturedAdapter!.get("google.oauth.client");
      expect(stored).toBeDefined();
      expect(JSON.parse(stored!)).toEqual({ clientId: "gid", clientSecret: "gsecret" });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
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
    });
    // start()'s own default injects createInMemorySecretsAdapter() (see this
    // file's start() helper), so this is deterministic regardless of
    // platform — no real Darwin-only keychain involved.
    const secrets = (body as { secrets: { ok: boolean; backend: string } }).secrets;
    expect(secrets).toMatchObject({ ok: true, backend: "macOS Keychain" });
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

/** Boots a server with setup already complete and returns its baseUrl —
 * shared setup for the search/interactions route suites below, which all
 * need working /api/contacts routes. */
async function startReady(): Promise<{ baseUrl: string }> {
  const { baseUrl } = await start();
  await postJson(baseUrl + "/api/wizard/complete");
  return { baseUrl };
}

describe("GET /api/contacts/search", () => {
  it("returns matches for a query hitting name/org/what/angle/tags", async () => {
    const { baseUrl } = await startReady();
    await postJson(baseUrl + "/api/contacts", { name: "Ada Lovelace", org: "Analytical Engines" });
    await postJson(baseUrl + "/api/contacts", { name: "Grace Hopper", org: "US Navy" });

    const { status, body } = await getJson(baseUrl + "/api/contacts/search?q=Analytical");
    expect(status).toBe(200);
    const results = body as Array<{ contact: { name: string } }>;
    expect(results.map((r) => r.contact.name)).toEqual(["Ada Lovelace"]);
  });

  it("respects the verdict filter and limit query params", async () => {
    const { baseUrl } = await startReady();
    await postJson(baseUrl + "/api/contacts", { name: "Strong One", org: "SharedTerm", verdict: "strong" });
    await postJson(baseUrl + "/api/contacts", { name: "Watch One", org: "SharedTerm", verdict: "watch" });

    const filtered = await getJson(baseUrl + "/api/contacts/search?q=SharedTerm&verdict=strong");
    const filteredResults = filtered.body as Array<{ contact: { name: string } }>;
    expect(filteredResults.map((r) => r.contact.name)).toEqual(["Strong One"]);

    const limited = await getJson(baseUrl + "/api/contacts/search?q=SharedTerm&limit=1");
    expect((limited.body as unknown[]).length).toBe(1);
  });

  it("returns 409 before the wizard is complete, same gate as the other /api/contacts routes", async () => {
    const { baseUrl } = await start();
    const { status } = await getJson(baseUrl + "/api/contacts/search?q=anything");
    expect(status).toBe(409);
  });

  it("returns an empty array for a query matching nothing", async () => {
    const { baseUrl } = await startReady();
    await postJson(baseUrl + "/api/contacts", { name: "Ada Lovelace" });
    const { status, body } = await getJson(baseUrl + "/api/contacts/search?q=zzznomatchzzz");
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });
});

describe("POST/GET /api/contacts/:id/interactions", () => {
  it("logs an interaction and returns the created record", async () => {
    const { baseUrl } = await startReady();
    const created = await postJson(baseUrl + "/api/contacts", { name: "Ada Lovelace" });
    const id = (created.body as { id: string }).id;

    const { status, body } = await postJson(baseUrl + `/api/contacts/${id}/interactions`, {
      note: "Great call about follow-up.",
      channel: "call",
      at: "2026-08-01T00:00:00.000Z",
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({
      contactId: id,
      note: "Great call about follow-up.",
      channel: "call",
      at: "2026-08-01T00:00:00.000Z",
    });
    expect((body as { id?: string }).id).toBeTruthy();
  });

  it("a subsequent GET .../interactions returns what was logged, most recent first", async () => {
    const { baseUrl } = await startReady();
    const created = await postJson(baseUrl + "/api/contacts", { name: "Ada Lovelace" });
    const id = (created.body as { id: string }).id;

    await postJson(baseUrl + `/api/contacts/${id}/interactions`, { note: "First", at: "2026-01-01" });
    await postJson(baseUrl + `/api/contacts/${id}/interactions`, { note: "Second", at: "2026-06-01" });

    const { status, body } = await getJson(baseUrl + `/api/contacts/${id}/interactions`);
    expect(status).toBe(200);
    const notes = (body as Array<{ note: string }>).map((i) => i.note);
    expect(notes).toEqual(["Second", "First"]);
  });

  it("rejects an empty note with 400 and does not persist anything", async () => {
    const { baseUrl } = await startReady();
    const created = await postJson(baseUrl + "/api/contacts", { name: "Ada Lovelace" });
    const id = (created.body as { id: string }).id;

    const { status, body } = await postJson(baseUrl + `/api/contacts/${id}/interactions`, { note: "   " });
    expect(status).toBe(400);
    expect(body).toEqual({ error: "note is required" });

    const history = await getJson(baseUrl + `/api/contacts/${id}/interactions`);
    expect(history.body).toEqual([]);
  });

  it("defaults `at` to today when omitted", async () => {
    const { baseUrl } = await startReady();
    const created = await postJson(baseUrl + "/api/contacts", { name: "Ada Lovelace" });
    const id = (created.body as { id: string }).id;

    const { body } = await postJson(baseUrl + `/api/contacts/${id}/interactions`, { note: "No date given" });
    const at = (body as { at: string }).at;
    expect(new Date(at).toISOString().slice(0, 10)).toBe(new Date().toISOString().slice(0, 10));
  });

  it("returns 404 for an unknown contact id on both GET and POST", async () => {
    const { baseUrl } = await startReady();
    const getRes = await getJson(baseUrl + "/api/contacts/does-not-exist/interactions");
    expect(getRes.status).toBe(404);
    const postRes = await postJson(baseUrl + "/api/contacts/does-not-exist/interactions", { note: "x" });
    expect(postRes.status).toBe(404);
  });
});

describe("DELETE /api/contacts/:id", () => {
  it("deletes an existing contact and returns 204 with no body", async () => {
    const { baseUrl } = await startReady();
    const created = await postJson(baseUrl + "/api/contacts", { name: "Ada Lovelace" });
    const id = (created.body as { id: string }).id;

    const { status, body } = await deleteRequest(baseUrl + `/api/contacts/${id}`);
    expect(status).toBe(204);
    expect(body).toBeUndefined();

    const after = await getJson(baseUrl + `/api/contacts/${id}`);
    expect(after.status).toBe(404);
  });

  it("also deletes the contact's interaction history", async () => {
    const { baseUrl } = await startReady();
    const created = await postJson(baseUrl + "/api/contacts", { name: "Ada Lovelace" });
    const id = (created.body as { id: string }).id;
    await postJson(baseUrl + `/api/contacts/${id}/interactions`, { note: "Called once" });

    await deleteRequest(baseUrl + `/api/contacts/${id}`);

    const historyRes = await getJson(baseUrl + `/api/contacts/${id}/interactions`);
    expect(historyRes.status).toBe(404);
  });

  it("returns 404 for an unknown contact id", async () => {
    const { baseUrl } = await startReady();
    const { status } = await deleteRequest(baseUrl + "/api/contacts/does-not-exist");
    expect(status).toBe(404);
  });

  it("does not remove other contacts", async () => {
    const { baseUrl } = await startReady();
    const keep = await postJson(baseUrl + "/api/contacts", { name: "Grace Hopper" });
    const gone = await postJson(baseUrl + "/api/contacts", { name: "Ada Lovelace" });
    const keepId = (keep.body as { id: string }).id;
    const goneId = (gone.body as { id: string }).id;

    await deleteRequest(baseUrl + `/api/contacts/${goneId}`);

    const stillThere = await getJson(baseUrl + `/api/contacts/${keepId}`);
    expect(stillThere.status).toBe(200);
  });
});

describe("malformed JSON request bodies", () => {
  it("POST /api/contacts with malformed JSON returns 400, not 500", async () => {
    const { baseUrl } = await startReady();
    const { status, body } = await postRawBody(baseUrl + "/api/contacts", "POST", "{not valid json");
    expect(status).toBe(400);
    expect((body as { error?: string }).error).toBeTruthy();
  });

  it("PATCH .../verdict with malformed JSON returns 400, not 500", async () => {
    const { baseUrl } = await startReady();
    const created = await postJson(baseUrl + "/api/contacts", { name: "Ada Lovelace" });
    const id = (created.body as { id: string }).id;
    const { status } = await postRawBody(baseUrl + `/api/contacts/${id}/verdict`, "PATCH", "{not valid json");
    expect(status).toBe(400);
  });

  it("POST .../interactions with malformed JSON returns 400, not 500", async () => {
    const { baseUrl } = await startReady();
    const created = await postJson(baseUrl + "/api/contacts", { name: "Ada Lovelace" });
    const id = (created.body as { id: string }).id;
    const { status } = await postRawBody(baseUrl + `/api/contacts/${id}/interactions`, "POST", "{not valid json");
    expect(status).toBe(400);
  });

  it("POST /api/wizard/google with malformed JSON returns 400, not 500", async () => {
    const { baseUrl } = await start();
    const { status, body } = await postRawBody(baseUrl + "/api/wizard/google", "POST", "{not valid json");
    expect(status).toBe(400);
    expect((body as { error?: string }).error).toBeTruthy();
  });
});

describe("PATCH /api/contacts/:id/verdict validation", () => {
  it("rejects a value that isn't a real Verdict with 400 and does not persist it", async () => {
    const { baseUrl } = await startReady();
    const created = await postJson(baseUrl + "/api/contacts", { name: "Ada Lovelace" });
    const id = (created.body as { id: string }).id;

    const { status, body } = await patchJson(baseUrl + `/api/contacts/${id}/verdict`, { verdict: "maybe-later" });
    expect(status).toBe(400);
    expect((body as { error?: string }).error).toBeTruthy();

    const after = await getJson(baseUrl + `/api/contacts/${id}`);
    expect((after.body as { verdict?: string }).verdict).toBe("none");
  });

  it("accepts all 5 valid Verdict values", async () => {
    const { baseUrl } = await startReady();
    const created = await postJson(baseUrl + "/api/contacts", { name: "Ada Lovelace" });
    const id = (created.body as { id: string }).id;

    for (const verdict of ["strong", "watch", "referral-only", "pass", "none"]) {
      const { status, body } = await patchJson(baseUrl + `/api/contacts/${id}/verdict`, { verdict });
      expect(status).toBe(200);
      expect((body as { verdict?: string }).verdict).toBe(verdict);
    }
  });
});

const DAY_MS = 86_400_000;
function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

describe("GET/PUT /api/settings/follow-up", () => {
  it("GET returns 409 before the wizard is complete", async () => {
    const { baseUrl } = await start();
    const { status } = await getJson(baseUrl + "/api/settings/follow-up");
    expect(status).toBe(409);
  });

  it("GET returns the lazily-seeded 30/14 defaults on a fresh store", async () => {
    const { baseUrl } = await startReady();
    const { status, body } = await getJson(baseUrl + "/api/settings/follow-up");
    expect(status).toBe(200);
    expect(body).toEqual({ windowDays: 30, graceDays: 14 });
  });

  it("PUT persists a new config and GET reflects it afterward", async () => {
    const { baseUrl } = await startReady();
    const put = await putJson(baseUrl + "/api/settings/follow-up", { windowDays: 45, graceDays: 7 });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ windowDays: 45, graceDays: 7 });

    const get = await getJson(baseUrl + "/api/settings/follow-up");
    expect(get.body).toEqual({ windowDays: 45, graceDays: 7 });
  });

  it("PUT rejects non-positive-integer values with 400 and does not persist them", async () => {
    const { baseUrl } = await startReady();

    const cases: unknown[] = [
      { windowDays: 0, graceDays: 14 },
      { windowDays: 30, graceDays: -1 },
      { windowDays: 1.5, graceDays: 14 },
      { windowDays: "30", graceDays: 14 },
      { windowDays: 30 },
      {},
    ];
    for (const payload of cases) {
      const { status, body } = await putJson(baseUrl + "/api/settings/follow-up", payload);
      expect(status).toBe(400);
      expect((body as { error?: string }).error).toBeTruthy();
    }

    // None of the rejected payloads should have clobbered the defaults.
    const get = await getJson(baseUrl + "/api/settings/follow-up");
    expect(get.body).toEqual({ windowDays: 30, graceDays: 14 });
  });

  it("PUT with malformed JSON returns 400, not 500", async () => {
    const { baseUrl } = await startReady();
    const { status } = await postRawBody(baseUrl + "/api/settings/follow-up", "PUT", "{not valid json");
    expect(status).toBe(400);
  });
});

describe("GET/PUT /api/settings/autostart", () => {
  it("GET reports unsupported by default (no autostart option injected), even before the wizard is complete", async () => {
    const { baseUrl } = await start();
    const { status, body } = await getJson(baseUrl + "/api/settings/autostart");
    expect(status).toBe(200);
    expect(body).toEqual({ supported: false, enabled: false });
  });

  it("PUT returns 501 when unsupported and does not call any setter", async () => {
    const { baseUrl } = await start();
    const { status, body } = await putJson(baseUrl + "/api/settings/autostart", { enabled: true });
    expect(status).toBe(501);
    expect((body as { error?: string }).error).toBeTruthy();
  });

  it("GET/PUT reflect an injected autostart controller (the Electron-main-process shape)", async () => {
    let enabled = false;
    const setEnabled = vi.fn((v: boolean) => {
      enabled = v;
    });
    server = createRolodexServer({
      homeDir: dir,
      secretsCapabilityFactory: () => createInMemorySecretsAdapter(),
      autostart: { isSupported: true, getEnabled: () => enabled, setEnabled },
    });
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    const address = server!.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const baseUrl = `http://127.0.0.1:${port}`;

    const before = await getJson(baseUrl + "/api/settings/autostart");
    expect(before.body).toEqual({ supported: true, enabled: false });

    const put = await putJson(baseUrl + "/api/settings/autostart", { enabled: true });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ supported: true, enabled: true });
    expect(setEnabled).toHaveBeenCalledWith(true);

    const after = await getJson(baseUrl + "/api/settings/autostart");
    expect(after.body).toEqual({ supported: true, enabled: true });
  });

  it("PUT rejects a non-boolean enabled with 400", async () => {
    server = createRolodexServer({
      homeDir: dir,
      secretsCapabilityFactory: () => createInMemorySecretsAdapter(),
      autostart: { isSupported: true, getEnabled: () => false, setEnabled: () => {} },
    });
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    const address = server!.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const baseUrl = `http://127.0.0.1:${port}`;

    const { status, body } = await putJson(baseUrl + "/api/settings/autostart", { enabled: "yes" });
    expect(status).toBe(400);
    expect((body as { error?: string }).error).toBeTruthy();
  });

  it("PUT with malformed JSON on an unsupported server still returns 501, not 400 or 500 — isSupported is checked before the body is even read", async () => {
    const { baseUrl } = await start();
    const { status } = await postRawBody(baseUrl + "/api/settings/autostart", "PUT", "{not valid json");
    expect(status).toBe(501);
  });

  it("PUT with malformed JSON on a supported server returns 400, not 500", async () => {
    server = createRolodexServer({
      homeDir: dir,
      secretsCapabilityFactory: () => createInMemorySecretsAdapter(),
      autostart: { isSupported: true, getEnabled: () => false, setEnabled: () => {} },
    });
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    const address = server!.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const baseUrl = `http://127.0.0.1:${port}`;

    const { status } = await postRawBody(baseUrl + "/api/settings/autostart", "PUT", "{not valid json");
    expect(status).toBe(400);
  });
});

describe("GET/PUT /api/settings/appearance", () => {
  it("GET returns 409 before the wizard is complete", async () => {
    const { baseUrl } = await start();
    const { status } = await getJson(baseUrl + "/api/settings/appearance");
    expect(status).toBe(409);
  });

  it("GET returns the lazily-seeded default/6 defaults on a fresh store", async () => {
    const { baseUrl } = await startReady();
    const { status, body } = await getJson(baseUrl + "/api/settings/appearance");
    expect(status).toBe(200);
    expect(body).toEqual({ theme: "default", iconId: 6 });
  });

  it("PUT persists a new config and GET reflects it afterward", async () => {
    const { baseUrl } = await startReady();
    const put = await putJson(baseUrl + "/api/settings/appearance", { theme: "brass", iconId: 3 });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ theme: "brass", iconId: 3 });

    const get = await getJson(baseUrl + "/api/settings/appearance");
    expect(get.body).toEqual({ theme: "brass", iconId: 3 });
  });

  it("PUT rejects invalid theme/iconId values with 400 and does not persist them", async () => {
    const { baseUrl } = await startReady();

    const cases: unknown[] = [
      { theme: "sepia", iconId: 3 },
      { theme: "brass", iconId: 0 },
      { theme: "brass", iconId: 11 },
      { theme: "brass", iconId: 1.5 },
      { theme: "brass", iconId: "3" },
      { theme: "brass" },
      {},
    ];
    for (const payload of cases) {
      const { status, body } = await putJson(baseUrl + "/api/settings/appearance", payload);
      expect(status).toBe(400);
      expect((body as { error?: string }).error).toBeTruthy();
    }

    const get = await getJson(baseUrl + "/api/settings/appearance");
    expect(get.body).toEqual({ theme: "default", iconId: 6 });
  });

  it("PUT with malformed JSON returns 400, not 500", async () => {
    const { baseUrl } = await startReady();
    const { status } = await postRawBody(baseUrl + "/api/settings/appearance", "PUT", "{not valid json");
    expect(status).toBe(400);
  });
});

describe("GET / — appearance injection", () => {
  it("serves the default theme/icon (no data-theme attribute, favicon.ico links) with no settings row", async () => {
    const { baseUrl } = await startReady();
    const res = await fetch(baseUrl + "/");
    const html = await res.text();
    // The CSS itself legitimately contains the literal substring
    // data-theme="brass" as an attribute-selector — assert on the actual
    // <html> opening tag, not a bare substring match.
    expect(html).toContain('<html lang="en">');
    expect(html).not.toContain('<html lang="en" data-theme="brass">');
    expect(html).toContain("/assets/icon-c6.ico");
    expect(html).toContain("/assets/icon-c6-32.png");
    expect(html).toContain("/assets/icon-c6-16.png");
    expect(html).toContain("/assets/icon-c6-180.png");
  });

  it("injects data-theme and the selected icon's asset paths once appearance is saved", async () => {
    const { baseUrl } = await startReady();
    await putJson(baseUrl + "/api/settings/appearance", { theme: "brass", iconId: 4 });

    const res = await fetch(baseUrl + "/");
    const html = await res.text();
    expect(html).toContain('<html lang="en" data-theme="brass">');
    expect(html).toContain("/assets/icon-c4.ico");
    expect(html).toContain("/assets/icon-c4-32.png");
    expect(html).toContain("/assets/icon-c4-16.png");
    expect(html).toContain("/assets/icon-c4-180.png");
  });

  it("does not inject appearance into wizard.html before setup is complete", async () => {
    const { baseUrl } = await start();
    const res = await fetch(baseUrl + "/");
    const html = await res.text();
    expect(html).not.toContain('<html lang="en" data-theme="brass">');
  });
});

describe("GET /api/contacts/needs-follow-up", () => {
  it("returns 409 before the wizard is complete", async () => {
    const { baseUrl } = await start();
    const { status } = await getJson(baseUrl + "/api/contacts/needs-follow-up");
    expect(status).toBe(409);
  });

  it("uses the persisted settings when no query params are given", async () => {
    // Uses a store built directly against a known temp file (rather than
    // startReady()'s implicit one) so the test can backdate a contact's
    // createdAt through the SAME Store instance the server queries against —
    // the HTTP API has no route for setting createdAt directly.
    const dbStore = new Store(path.join(dir, "rolodex.db"));
    const { baseUrl } = await start({ store: dbStore });
    await postJson(baseUrl + "/api/wizard/complete");
    await putJson(baseUrl + "/api/settings/follow-up", { windowDays: 30, graceDays: 14 });

    dbStore.upsert({
      id: "",
      name: "Stale Contact",
      verdict: "none",
      nextStep: "Send intro",
      createdAt: daysAgoIso(40),
      updatedAt: daysAgoIso(40),
    });

    const { status, body } = await getJson(baseUrl + "/api/contacts/needs-follow-up");
    expect(status).toBe(200);
    expect((body as Array<{ name: string }>).map((c) => c.name)).toEqual(["Stale Contact"]);
  });

  it("query params override the persisted settings for this call only, without persisting them", async () => {
    const dbStore = new Store(path.join(dir, "rolodex.db"));
    const { baseUrl } = await start({ store: dbStore });
    await postJson(baseUrl + "/api/wizard/complete");
    // Persisted config is wide enough that nothing qualifies by default.
    await putJson(baseUrl + "/api/settings/follow-up", { windowDays: 365, graceDays: 365 });

    const created = dbStore.upsert({
      id: "",
      name: "Moderately Stale",
      verdict: "none",
      nextStep: "Follow up",
      createdAt: daysAgoIso(20),
      updatedAt: daysAgoIso(20),
    });

    // Against the persisted config (365/365) this contact is excluded.
    const defaultResult = await getJson(baseUrl + "/api/contacts/needs-follow-up");
    expect((defaultResult.body as Array<{ id: string }>).map((c) => c.id)).not.toContain(created.id);

    // A tighter override (withinDays/graceDays small) picks it up...
    const overridden = await getJson(baseUrl + "/api/contacts/needs-follow-up?withinDays=5&graceDays=5");
    expect(overridden.status).toBe(200);
    expect((overridden.body as Array<{ id: string }>).map((c) => c.id)).toEqual([created.id]);

    // ...but must not have persisted: the settings are unchanged afterward.
    const settings = await getJson(baseUrl + "/api/settings/follow-up");
    expect(settings.body).toEqual({ windowDays: 365, graceDays: 365 });
  });
});
