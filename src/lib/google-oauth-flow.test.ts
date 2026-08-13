import { randomUUID } from "node:crypto";
import type { Auth } from "googleapis";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectGoogleAccount, type OAuth2ClientLike } from "./google-oauth-flow.js";
import { GOOGLE_OAUTH_TOKEN_KEY } from "./google-sync.js";
import { createInMemorySecretsAdapter } from "./secrets-adapter.js";

// Mirrors this module's own 120s constant (not exported — the timeout is a
// fixed, load-bearing design decision, not something callers configure).
const TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** A minimal deferred promise — used to await "the flow has reached the
 * point of opening a browser tab" without depending on any timer. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

interface FakeOAuth2Client extends OAuth2ClientLike {
  /** Every `code` passed to getToken(), in call order. */
  tokenCalls: string[];
  /** Lets a test simulate a later, out-of-band 'tokens' event — e.g. a
   * background refresh long after the initial exchange completed. */
  emitTokens: (tokens: Auth.Credentials) => void;
}

/** A fake OAuth2Client: no network, ever. generateAuthUrl() builds a real
 * URL (mirroring the shape the real google-auth-library produces) so tests
 * exercise the same "parse the consent URL to learn the port/state" path a
 * real caller's openBrowser would. getToken() fires the 'tokens' event
 * itself, matching the real OAuth2Client's confirmed behavior (it emits
 * 'tokens' as part of getToken(), not only on background refresh). */
function createFakeOAuth2Client(): FakeOAuth2Client {
  const listeners: Array<(tokens: Auth.Credentials) => void> = [];
  const tokenCalls: string[] = [];
  const client: FakeOAuth2Client = {
    tokenCalls,
    generateAuthUrl(opts) {
      const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      for (const [key, value] of Object.entries(opts)) {
        if (value === undefined) continue;
        url.searchParams.set(key, Array.isArray(value) ? value.join(" ") : String(value));
      }
      return url.toString();
    },
    async getToken(code) {
      tokenCalls.push(code);
      const tokens: Auth.Credentials = {
        access_token: `fake-access-for-${code}`,
        refresh_token: "fake-refresh",
        token_type: "Bearer",
        expiry_date: Date.now() + 3_600_000,
      };
      for (const l of listeners) l(tokens);
      return { tokens };
    },
    on(_event, listener) {
      listeners.push(listener);
      return client;
    },
    emitTokens(tokens) {
      for (const l of listeners) l(tokens);
    },
  };
  return client;
}

function extractParam(consentUrl: string, name: string): string {
  const value = new URL(consentUrl).searchParams.get(name);
  if (!value) throw new Error(`test setup: consent URL had no "${name}" param`);
  return value;
}

/** Starts a real connectGoogleAccount() flow against a real local listener,
 * waits for the fake openBrowser to receive the generated consent URL (the
 * same signal a real caller's openBrowser would get), and returns the
 * pieces a test needs to drive the real HTTP listener directly. */
async function startFlow(overrides: { signal?: AbortSignal } = {}) {
  const secrets = createInMemorySecretsAdapter();
  const opens: string[] = [];
  const opened = deferred<void>();
  const fakeClient = createFakeOAuth2Client();
  const openBrowser = (url: string) => {
    opens.push(url);
    opened.resolve();
  };

  const promise = connectGoogleAccount({
    clientId: "cid",
    clientSecret: "csecret",
    secrets,
    openBrowser,
    createOAuth2Client: () => fakeClient,
    ...overrides,
  });
  // A real callback request can settle (reject, in most of these tests)
  // server-side before the test below gets around to attaching its own
  // `await`/`.catch` to `promise` — this pre-attached no-op keeps Node from
  // ever seeing `promise` as transiently unhandled. It doesn't interfere
  // with the caller's own `await promise` / `expect(promise).rejects...`
  // below — a promise can have any number of independent handlers.
  promise.catch(() => {});

  await opened.promise;
  const consentUrl = opens[0]!;
  const redirectUri = extractParam(consentUrl, "redirect_uri");
  const state = extractParam(consentUrl, "state");
  return { promise, secrets, opens, fakeClient, redirectUri, state, consentUrl };
}

afterEach(() => {
  // Safety net for the fake-timers test below — every other test uses real
  // timers throughout.
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Acceptance criteria
// ---------------------------------------------------------------------------

describe("connectGoogleAccount", () => {
  it("requests offline access with forced re-consent and a random state nonce, against a bare no-path-suffix redirect_uri", async () => {
    const { promise, consentUrl, redirectUri, state } = await startFlow();
    const url = new URL(consentUrl);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(state).toBeTruthy();
    // redirect_uri is the BARE http://127.0.0.1:<port> — no path suffix.
    expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    // Clean up: complete the flow so it doesn't leak into later tests via
    // the module-level concurrency guard.
    await fetch(`${redirectUri}/?code=cleanup&state=${encodeURIComponent(state)}`);
    await expect(promise).resolves.toBeUndefined();
  });

  it("exchanges the code and persists a Credentials JSON blob under GOOGLE_OAUTH_TOKEN_KEY via the injected SecretsAdapter", async () => {
    const { promise, secrets, redirectUri, state, fakeClient } = await startFlow();

    const res = await fetch(`${redirectUri}/?code=${encodeURIComponent("test-code-123")}&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Google account connected");

    await expect(promise).resolves.toBeUndefined();
    expect(fakeClient.tokenCalls).toEqual(["test-code-123"]);

    const stored = await secrets.get(GOOGLE_OAUTH_TOKEN_KEY);
    expect(stored).toBeTruthy();
    expect(JSON.parse(stored!)).toMatchObject({
      access_token: "fake-access-for-test-code-123",
      refresh_token: "fake-refresh",
    });
  });

  it("persists again when the injected OAuth2Client emits a later 'tokens' event (simulated background refresh)", async () => {
    const { promise, secrets, redirectUri, state, fakeClient } = await startFlow();
    await fetch(`${redirectUri}/?code=abc&state=${encodeURIComponent(state)}`);
    await promise;

    fakeClient.emitTokens({ access_token: "refreshed-access", refresh_token: "fake-refresh", expiry_date: Date.now() + 999 });
    // secrets.set() is async — give its microtask a turn.
    await new Promise((r) => setTimeout(r, 0));

    const stored = await secrets.get(GOOGLE_OAUTH_TOKEN_KEY);
    expect(JSON.parse(stored!)).toMatchObject({ access_token: "refreshed-access" });
  });

  it("rejects with a distinct 'consent denied' error on ?error=access_denied — not the generic timeout error", async () => {
    const { promise, redirectUri, state } = await startFlow();

    const res = await fetch(`${redirectUri}/?error=access_denied&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("canceled");

    let caught: unknown;
    try {
      await promise;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/denied/i);
    expect((caught as Error).message).not.toMatch(/timed out/i);
  });

  it("does not settle the flow on a missing or mismatched state — keeps waiting for a legitimate callback", async () => {
    const { promise, redirectUri, state } = await startFlow();

    const noState = await fetch(`${redirectUri}/?code=whatever`);
    expect(noState.status).toBe(400);
    expect(await noState.text()).toContain("Invalid request");

    const wrongState = await fetch(`${redirectUri}/?code=whatever&state=totally-wrong-nonce`);
    expect(wrongState.status).toBe(400);
    expect(await wrongState.text()).toContain("Invalid request");

    // Prove the flow is still alive: a legitimate callback now completes it.
    const legit = await fetch(`${redirectUri}/?code=real-code&state=${encodeURIComponent(state)}`);
    expect(legit.status).toBe(200);
    await expect(promise).resolves.toBeUndefined();
  });

  it("responds 404 to a request on any path other than root, and does not settle the flow", async () => {
    const { promise, redirectUri, state } = await startFlow();

    const res = await fetch(`${redirectUri}/callback?code=x&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not Found");

    const legit = await fetch(`${redirectUri}/?code=real-code&state=${encodeURIComponent(state)}`);
    expect(legit.status).toBe(200);
    await expect(promise).resolves.toBeUndefined();
  });

  it("closes the listener and rejects with an actionable error after 120s with no legitimate callback", async () => {
    vi.useFakeTimers();
    const { promise, redirectUri } = await startFlow();

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    await expect(promise).rejects.toThrow(/timed out/i);

    vi.useRealTimers();
    // The listener must actually be closed — a real connection attempt now
    // fails outright instead of hanging or succeeding.
    await expect(fetch(redirectUri)).rejects.toThrow();
  });

  it("tears the listener down immediately when the AbortSignal fires, without waiting for the 120s timeout", async () => {
    const controller = new AbortController();
    const { promise, redirectUri } = await startFlow({ signal: controller.signal });

    controller.abort();
    await expect(promise).rejects.toThrow(/cancel/i);
    await expect(fetch(redirectUri)).rejects.toThrow();
  });

  it("rejects a second concurrent call immediately, without opening a second listener or browser tab", async () => {
    const opens: string[] = [];
    const opened = deferred<void>();
    const openBrowser = (url: string) => {
      opens.push(url);
      opened.resolve();
    };
    const controller = new AbortController();

    const first = connectGoogleAccount({
      clientId: "cid",
      clientSecret: "csecret",
      secrets: createInMemorySecretsAdapter(),
      openBrowser,
      createOAuth2Client: () => createFakeOAuth2Client(),
      signal: controller.signal,
    });
    first.catch(() => {}); // see startFlow()'s comment on this pattern
    const second = connectGoogleAccount({
      clientId: "cid",
      clientSecret: "csecret",
      secrets: createInMemorySecretsAdapter(),
      openBrowser,
      createOAuth2Client: () => createFakeOAuth2Client(),
    });

    await expect(second).rejects.toThrow(/already in progress/i);

    await opened.promise;
    expect(opens).toHaveLength(1);

    // Clean up the first (still in-flight) call.
    controller.abort();
    await expect(first).rejects.toThrow(/cancel/i);
  });

  it("never echoes a raw state query-parameter value into the state-mismatch response HTML", async () => {
    const { promise, redirectUri, state } = await startFlow();
    const marker = `INJECTED_MARKER_${randomUUID()}`;

    const res = await fetch(`${redirectUri}/?state=${encodeURIComponent(marker)}`);
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain(marker);

    // Clean up: complete the flow legitimately.
    await fetch(`${redirectUri}/?code=real-code&state=${encodeURIComponent(state)}`);
    await expect(promise).resolves.toBeUndefined();
  });

  it("never echoes a raw error query-parameter value into the generic-error response HTML", async () => {
    const { promise, redirectUri, state } = await startFlow();
    const marker = `INJECTED_MARKER_${randomUUID()}`;

    const res = await fetch(`${redirectUri}/?error=${encodeURIComponent(marker)}&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain(marker);

    let caught: unknown;
    try {
      await promise;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain(marker);
  });

  it("never echoes a raw code query-parameter value into the success response HTML", async () => {
    const { promise, redirectUri, state } = await startFlow();
    const marker = `INJECTED_MARKER_${randomUUID()}`;

    const res = await fetch(`${redirectUri}/?code=${encodeURIComponent(marker)}&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain(marker);

    await expect(promise).resolves.toBeUndefined();
  });

  it("exchanges the code exactly once even when two concurrent requests race in with the same legitimate code+state", async () => {
    // Regression test for an adversarial-review finding: teardown()'s
    // (force:false) server.close() only stops NEW connections — a second
    // connection already accepted before the first legitimate request
    // settled the flow could previously still reach onRequest, pass the
    // same valid state check, and trigger a second real
    // exchangeAndPersist(code)/getToken(code) call. Firing two concurrent
    // requests with the same valid code+state must result in exactly one
    // getToken() call.
    const { promise, redirectUri, state, fakeClient } = await startFlow();
    const callbackUrl = `${redirectUri}/?code=real-code&state=${encodeURIComponent(state)}`;

    const [r1, r2] = await Promise.allSettled([fetch(callbackUrl), fetch(callbackUrl)]);
    expect(r1.status).toBe("fulfilled");
    expect(r2.status).toBe("fulfilled");

    await expect(promise).resolves.toBeUndefined();
    expect(fakeClient.tokenCalls).toEqual(["real-code"]);
  });

  it("closes the listener after a successful exchange — a subsequent request fails to connect", async () => {
    const { promise, redirectUri, state } = await startFlow();
    await fetch(`${redirectUri}/?code=real-code&state=${encodeURIComponent(state)}`);
    await expect(promise).resolves.toBeUndefined();

    await expect(fetch(redirectUri)).rejects.toThrow();
  });

  it("closes the listener after access_denied — a subsequent request fails to connect", async () => {
    const { promise, redirectUri, state } = await startFlow();
    await fetch(`${redirectUri}/?error=access_denied&state=${encodeURIComponent(state)}`);
    await expect(promise).rejects.toThrow(/denied/i);

    await expect(fetch(redirectUri)).rejects.toThrow();
  });

  it("closes the listener after a generic consent-screen error — a subsequent request fails to connect", async () => {
    const { promise, redirectUri, state } = await startFlow();
    await fetch(`${redirectUri}/?error=server_error&state=${encodeURIComponent(state)}`);
    await expect(promise).rejects.toThrow(/failed/i);

    await expect(fetch(redirectUri)).rejects.toThrow();
  });

  it("closes the listener after a malformed callback (neither code nor error) — a subsequent request fails to connect", async () => {
    const { promise, redirectUri, state } = await startFlow();
    await fetch(`${redirectUri}/?state=${encodeURIComponent(state)}`);
    await expect(promise).rejects.toThrow(/malformed/i);

    await expect(fetch(redirectUri)).rejects.toThrow();
  });
});
