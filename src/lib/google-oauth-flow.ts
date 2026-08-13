import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { google, type Auth } from "googleapis";
// Imported (not duplicated) — unlike GOOGLE_OAUTH_CLIENT_KEY's deliberate
// duplication across the src/lib -> src/shell boundary, this is a
// same-package (src/lib) import, so that duplication rationale doesn't
// apply here. See google-sync.ts's own comment on this constant.
import { GOOGLE_OAUTH_TOKEN_KEY } from "./google-sync.js";
import type { SecretsAdapter } from "./secrets-adapter.js";

/**
 * Real Google OAuth 2.0 "loopback IP address" consent flow for a Desktop-app
 * client — the mechanism Google's docs require today (the old
 * out-of-band/copy-paste-code flow has been dead since Jan 2023).
 *
 * `connectGoogleAccount()` starts a short-lived `http.createServer` bound to
 * `127.0.0.1` on an OS-assigned port, opens the consent URL in the system
 * browser, and waits for Google to redirect back to that same loopback
 * address. Every behavior below traces to a specific finding from this
 * story's adversarial ("grill") design review — see
 * .pHive/epics/google-oauth-flow/docs/design-discussion.md §3/§4 and
 * grill-record.md (S1/S2/S3, H1/H2) for the full writeup. In short:
 *
 *  - redirect_uri is the BARE `http://127.0.0.1:<port>`, no path suffix
 *    (H1) — only that exact form is confirmed against Google's current
 *    loopback-flow docs.
 *  - A request that doesn't match (wrong path, missing/wrong `state`) is
 *    answered and ignored WITHOUT settling the flow or closing the listener
 *    (S1) — otherwise a stray probe (e.g. `/favicon.ico`) could kill the
 *    real callback before it ever arrives.
 *  - The callback HTML response is always one of a small, fixed set of
 *    hardcoded strings, chosen by which case matched — it never
 *    interpolates any request-derived value (S3), so there's no
 *    reflected-content path to sanitize in the first place.
 *  - The `state` nonce is briefly visible via `ps` to other local accounts
 *    on this machine, through the spawned `open` process's argv (S2) — an
 *    accepted, documented risk under this app's single-user/local-machine
 *    threat model, mitigated by the nonce being single-use and short-lived.
 */

/** Scope requested for the consent screen — read+write access to Google
 * Contacts, matching google-sync.ts's People API usage. */
const SCOPE = ["https://www.googleapis.com/auth/contacts"];

/** How long to wait for a legitimate callback before giving up. Chosen as a
 * generous-but-bounded window for a human to complete the consent screen in
 * their browser without leaving a listener open indefinitely if they
 * abandon it. */
const TIMEOUT_MS = 120_000;

/**
 * The slice of googleapis' OAuth2 client this module needs: build the
 * consent URL, exchange a code for tokens, and subscribe to the `tokens`
 * event googleapis fires both on that initial exchange and on any later
 * silent refresh (confirmed on-disk in
 * node_modules/google-auth-library/build/src/auth/oauth2client.js — the
 * same `this.emit('tokens', tokens)` call appears in both the initial
 * getToken() exchange path and the background refreshToken() path). Kept
 * narrow, like google-sync.ts's own `OAuth2ClientLike`, so a test fake only
 * has to implement exactly this surface instead of the full real class.
 */
export interface OAuth2ClientLike {
  generateAuthUrl(opts: Auth.GenerateAuthUrlOpts): string;
  getToken(code: string): Promise<{ tokens: Auth.Credentials }>;
  on(event: "tokens", listener: (tokens: Auth.Credentials) => void): this;
}

export interface ConnectGoogleAccountOptions {
  /** OAuth client id, as saved by the wizard's Google-connect step (read
   * and parsed by the caller — this module never reads GOOGLE_OAUTH_CLIENT_KEY
   * itself, keeping it decoupled from how credentials were obtained). */
  clientId: string;
  clientSecret: string;
  /** Where the minted token gets persisted. Real callers pass the real
   * OS-keychain-backed adapter; tests inject an in-memory one. */
  secrets: SecretsAdapter;
  /** Opens a URL in the system browser. Defaults to the real Darwin `open`
   * CLI spawn already used by src/shell/server.ts. Injectable so tests never
   * spawn a real browser — the fake receives the full generated consent URL
   * (including the OS-assigned port embedded in its `redirect_uri` query
   * param and the CSRF `state` nonce), which is how a test learns both the
   * port to call back on and the state value a legitimate callback needs. */
  openBrowser?: (url: string) => void;
  /** Builds the OAuth2 client used for the exchange. Defaults to the real
   * `new google.auth.OAuth2(clientId, clientSecret, redirectUri)`.
   * Injectable so tests substitute a fake and never touch the network. */
  createOAuth2Client?: (clientId: string, clientSecret: string, redirectUri: string) => OAuth2ClientLike;
  /** Tears the listener down immediately (rather than waiting out the full
   * 120s timeout) when aborted. Mirrors SecretsAdapter's own
   * `{signal?: AbortSignal}` convention (secrets-adapter.ts). */
  signal?: AbortSignal;
}

// Fixed, hardcoded HTML strings for every callback outcome. NONE of these
// ever interpolate a request-derived value (query param, header, etc.) —
// that's the whole point (grill S3): there is no reflected-content path to
// sanitize because nothing from the request is ever placed into the
// response body, by construction.
const SUCCESS_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>rolodex — Google connected</title></head>
<body>
<h1>Google account connected</h1>
<p>You can close this tab and return to rolodex.</p>
</body>
</html>
`;

const DENIED_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>rolodex — Google sign-in canceled</title></head>
<body>
<h1>Google sign-in canceled</h1>
<p>You chose not to grant access. Close this tab and try again from rolodex if you'd like.</p>
</body>
</html>
`;

const STATE_MISMATCH_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>rolodex — Invalid request</title></head>
<body>
<h1>Invalid request</h1>
<p>This request couldn't be verified and was ignored. If you're trying to connect Google, return to rolodex and try again.</p>
</body>
</html>
`;

const GENERIC_ERROR_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>rolodex — Google sign-in failed</title></head>
<body>
<h1>Google sign-in failed</h1>
<p>Something went wrong completing sign-in. Close this tab and try again from rolodex.</p>
</body>
</html>
`;

const NOT_FOUND_BODY = "Not Found";

/** Real browser-opener: the exact Darwin `open` CLI spawn pattern already
 * used by src/shell/server.ts (see its `isMainModule` block). Non-Darwin
 * can't auto-open a browser here, so — matching this project's own
 * established degraded-platform pattern (secrets-adapter.ts's
 * createSecretsAdapter() console.warns on non-Darwin instead of silently
 * degrading; src/shell/server.ts unconditionally console.logs the URL it
 * would have opened, regardless of platform, so a user can open it
 * manually) — warn clearly and log the actual consent URL, rather than
 * silently doing nothing and leaving the flow to hang for the full 120s
 * timeout with zero indication anything is wrong. */
function defaultOpenBrowser(url: string): void {
  if (process.platform === "darwin") {
    spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    return;
  }
  console.warn(
    `[google-oauth-flow] no auto-open support for this platform (${process.platform}) — ` +
      `open this URL manually to finish connecting your Google account: ${url}`,
  );
}

/** Real OAuth2Client factory. Narrowed to OAuth2ClientLike the same way
 * google-sync.ts's defaultPeopleClientFactory narrows the real People
 * client — the real class has a much wider surface than this module needs. */
function defaultCreateOAuth2Client(clientId: string, clientSecret: string, redirectUri: string): OAuth2ClientLike {
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri) as unknown as OAuth2ClientLike;
}

/** Module-level concurrency guard: a second `connectGoogleAccount()` call
 * while one is already in flight must reject immediately, before opening a
 * second listener or a second browser tab. Scoped at module level (not per
 * some session/instance object) because there is exactly one local user and
 * exactly one system browser to confuse — a second concurrent flow is never
 * legitimate. */
let inFlight = false;

/**
 * Runs the full loopback OAuth consent flow once: opens the consent URL in
 * the system browser, waits for Google's redirect back to the local
 * listener, exchanges the code, and persists the resulting Credentials via
 * `secrets`. Resolves once the token has been durably persisted; rejects
 * with a distinct, actionable error for every failure case (denied,
 * timeout, abort, malformed callback, exchange failure).
 */
export function connectGoogleAccount(opts: ConnectGoogleAccountOptions): Promise<void> {
  if (inFlight) {
    return Promise.reject(
      new Error("A Google connect flow is already in progress — wait for it to finish (or cancel it) before starting another."),
    );
  }
  inFlight = true;
  return runFlow(opts).finally(() => {
    inFlight = false;
  });
}

function runFlow(opts: ConnectGoogleAccountOptions): Promise<void> {
  const { clientId, clientSecret, secrets } = opts;
  const openBrowser = opts.openBrowser ?? defaultOpenBrowser;
  const createOAuth2Client = opts.createOAuth2Client ?? defaultCreateOAuth2Client;
  const signal = opts.signal;

  // The CSRF nonce (grill S1's precondition): generated once per flow,
  // verified byte-for-byte on every callback request before anything else
  // about that request is trusted.
  const state = randomUUID();

  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      // Never even start a listener/browser tab for an already-aborted call.
      reject(new Error("Google connect canceled."));
      return;
    }

    let auth: OAuth2ClientLike | undefined;
    let torn = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const server: Server = createServer(onRequest);

    function onAbort() {
      teardown({ force: true });
      reject(new Error("Google connect canceled."));
    }

    /** Closes the listener exactly once, from any exit path. `force` also
     * kills any still-open sockets immediately (safe for timeout/abort,
     * where no legitimate response is in flight) rather than waiting for
     * them to close on their own — guarantees the server always actually
     * ends up closed, per this story's own acceptance criteria. Non-force
     * teardown (used right after sending a real callback response) relies
     * on every response this module sends carrying `Connection: close`
     * (see onRequest) so the socket closes itself once that response is
     * flushed, without risking truncating it mid-flight. */
    function teardown(teardownOpts: { force: boolean }) {
      if (torn) return;
      torn = true;
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      if (signal) signal.removeEventListener("abort", onAbort);
      if (teardownOpts.force) server.closeAllConnections();
      server.close();
    }

    function respond(res: ServerResponse, status: number, body: string) {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8", connection: "close" });
      res.end(body);
    }

    function onRequest(req: IncomingMessage, res: ServerResponse) {
      // Closes a race an adversarial review found: teardown()'s
      // (force:false) server.close() only stops *new* connections — a
      // second connection that was ALREADY ACCEPTED before the first
      // legitimate request settled the flow can still reach onRequest and,
      // without this guard, pass the same valid state check and trigger a
      // second real exchangeAndPersist(code)/getToken(code) call. `torn`
      // only ever flips true synchronously inside teardown() (itself only
      // reached from onRequest's own synchronous execution below, or from
      // the timeout/abort callbacks), and Node dispatches HTTP request
      // callbacks single-threaded/one-at-a-time — so whichever request's
      // onRequest runs first synchronously settles the flow and sets
      // `torn = true` before the event loop ever gets to invoke onRequest
      // for a second, already-accepted connection. Checking `torn` first,
      // before any path/state/code parsing, guarantees at most one request
      // per flow ever reaches a settling branch.
      if (torn) {
        res.writeHead(404, { "content-type": "text/plain", connection: "close" });
        res.end(NOT_FOUND_BODY);
        return;
      }

      let url: URL;
      try {
        url = new URL(req.url ?? "/", "http://127.0.0.1");
      } catch {
        res.writeHead(400, { "content-type": "text/plain", connection: "close" });
        res.end(NOT_FOUND_BODY);
        return;
      }

      // Grill S1: only the bare root path is ever a legitimate callback
      // target (matches the no-path-suffix redirect_uri, grill H1). Any
      // other path (stray browser probes like /favicon.ico, unrelated local
      // requests) gets a generic 404 and is otherwise ignored — it must
      // NOT settle the flow or close the listener.
      if (url.pathname !== "/") {
        res.writeHead(404, { "content-type": "text/plain", connection: "close" });
        res.end(NOT_FOUND_BODY);
        return;
      }

      // Grill S1: a missing or mismatched state is never trusted, and never
      // settles the flow — the listener keeps waiting for the real
      // callback. This also covers a bare GET to "/" with no query at all.
      const receivedState = url.searchParams.get("state");
      if (receivedState === null || receivedState !== state) {
        respond(res, 400, STATE_MISMATCH_HTML);
        return;
      }

      const errorParam = url.searchParams.get("error");
      const code = url.searchParams.get("code");

      if (errorParam !== null) {
        if (errorParam === "access_denied") {
          respond(res, 200, DENIED_HTML);
          teardown({ force: false });
          reject(new Error("Google sign-in was canceled: consent was denied."));
          return;
        }
        // Any other error value: a distinct, generic failure — not the
        // access_denied message, not the timeout message, and (grill S3)
        // never echoing the actual error value back into the page or the
        // thrown Error's message.
        respond(res, 200, GENERIC_ERROR_HTML);
        teardown({ force: false });
        reject(new Error("Google sign-in failed: the consent screen returned an error."));
        return;
      }

      if (code !== null) {
        respond(res, 200, SUCCESS_HTML);
        teardown({ force: false });
        void exchangeAndPersist(code);
        return;
      }

      // Correct path + correct state, but neither `code` nor `error` —
      // a malformed callback. Still a legitimate match on path+state (so it
      // does settle, per the design), just not a case with any content to
      // exchange.
      respond(res, 400, GENERIC_ERROR_HTML);
      teardown({ force: false });
      reject(new Error("Google sign-in callback was malformed (missing both code and error)."));
    }

    async function exchangeAndPersist(code: string) {
      // `auth` is assigned synchronously in the `listening` callback below,
      // before openBrowser() is ever called — by the time any HTTP
      // request (real or test-simulated) reaches onRequest(), it is always
      // set.
      const client = auth;
      if (!client) {
        reject(new Error("Internal error: OAuth client was not initialized before the callback arrived."));
        return;
      }
      try {
        // Wired BEFORE getToken() is called: googleapis' OAuth2Client fires
        // 'tokens' as part of getToken() itself (confirmed on-disk — see
        // this module's top-of-file comment), not only on later background
        // refreshes, so this single hook persists both the initial exchange
        // and any later silent refresh through the same path.
        let persisted: Promise<void> = Promise.resolve();
        client.on("tokens", (tokens) => {
          persisted = secrets.set(GOOGLE_OAUTH_TOKEN_KEY, JSON.stringify(tokens));
        });
        await client.getToken(code);
        // Wait for the persistence write itself to finish (not just for it
        // to have been *started*) before resolving, so a caller that awaits
        // connectGoogleAccount() can rely on the token already being
        // durably persisted.
        await persisted;
        resolve();
      } catch (err) {
        reject(err instanceof Error ? err : new Error(`Failed to complete the Google OAuth exchange: ${String(err)}`));
      }
    }

    server.on("error", (err) => {
      teardown({ force: true });
      reject(new Error(`Failed to start the local OAuth listener: ${err instanceof Error ? err.message : String(err)}`));
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        teardown({ force: true });
        reject(new Error("Failed to determine the local OAuth listener's port."));
        return;
      }

      const redirectUri = `http://127.0.0.1:${address.port}`;
      auth = createOAuth2Client(clientId, clientSecret, redirectUri);

      const authUrl = auth.generateAuthUrl({
        // Required to get a refresh_token at all.
        access_type: "offline",
        // Guarantees a refresh_token is reissued even on a re-connect.
        prompt: "consent",
        scope: SCOPE,
        state,
        redirect_uri: redirectUri,
      });

      timeoutHandle = setTimeout(() => {
        teardown({ force: true });
        reject(
          new Error(
            "Timed out waiting for Google sign-in (120s) — the consent screen may have been abandoned or the browser tab closed without completing. Try connecting again.",
          ),
        );
      }, TIMEOUT_MS);

      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }

      // grill S2: `state` is part of this URL and therefore briefly visible
      // in the spawned `open` process's argv (via `ps`) to other local
      // accounts on this machine for the life of that child process —
      // an accepted, documented risk under this app's single-user,
      // local-machine threat model (see this file's top-of-file comment),
      // mitigated by `state` being single-use and short-lived.
      openBrowser(authUrl);
    });
  });
}
