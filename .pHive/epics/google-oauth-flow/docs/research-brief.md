# Research Brief: google-oauth-flow

## Summary

`GoogleSync.pull()` (`src/lib/google-sync.ts`) already reads an OAuth token
from `SecretsAdapter` key `"google.oauth.token"` and uses it correctly — but
nothing in the codebase ever writes that key. The setup wizard's
Google-connect step only saves the OAuth **client id/secret**
(`"google.oauth.client"`); the actual sign-in/consent exchange is a literal
placeholder string in `wizard.html:546` ("Google sign-in happens the first
time you sync — coming soon"). Sync is non-functional for a real user today.
This epic implements the real OAuth 2.0 consent flow.

## Key files & surfaces

- `src/lib/google-sync.ts:53` — `GOOGLE_OAUTH_TOKEN_KEY = "google.oauth.token"`.
  `pull()` (lines 197-233) already does `new google.auth.OAuth2(clientId,
  clientSecret)` + `auth.setCredentials(token)` and works correctly once that
  key holds a real `Credentials` JSON blob — **no changes needed to `pull()`
  itself**.
- `src/lib/secrets-adapter.ts:45-49` — `SecretsAdapter { get(key, opts?),
  set(key, value, opts?), delete(...) }`, all take optional `{ signal?:
  AbortSignal }`. `createSecretsAdapter()` is the real keychain-backed
  factory; `createInMemorySecretsAdapter()` is the existing test fake.
- `src/shell/server.ts:55` — `GOOGLE_OAUTH_CLIENT_KEY`. The wizard's
  `POST /api/wizard/google` route (lines 211-233) is where a sibling route
  for starting the consent flow belongs — the code already has a comment at
  this exact spot flagging it as the plug-in point. The server binds
  strictly to `127.0.0.1` (lines 607-618) with an explicit comment on why;
  any new local OAuth-callback listener must follow the same convention.
  Routing is raw `http.createServer` with manual path/method switching
  (`handleWizardRoute`) — no router library.
- `src/shell/server.ts:616` — already does
  `spawn("open", [url], {stdio:"ignore", detached:true}).unref()` (macOS
  `open` CLI) to launch the shell in the browser. The same mechanism can
  open the Google consent URL without adding a new dependency — though it's
  Darwin-only, matching the rest of the app's existing OS assumption.
- `src/shell/wizard.html:511-554` (`onConnect()`) — currently POSTs
  clientId/secret, then shows the hardcoded "coming soon" success message
  and auto-navigates after 700ms. Needs to become a real multi-step flow:
  save client creds → trigger consent → await a real "connected" result →
  show real success/error.
- `src/lib/google-sync.test.ts:103-152` — the existing DI pattern
  (`createGoogleSync({ secrets: fakeAdapter, createPeopleClient: () => ... })`,
  no real network) that the new OAuth-exchange code should mirror.
- `package.json` — no browser-opener dependency exists beyond the `open` CLI
  spawn already used in `server.ts`; no new npm dependency needed.

## Patterns & conventions

- Local-only, single-user app; every new server-side listener must bind to
  `127.0.0.1` only, matching the already-enforced convention
  (`src/shell/server.ts`'s explicit host argument and comment).
- Secrets never touch a file, env var, or log — always `SecretsAdapter`.
- Tests never make real network calls — dependency injection (factory
  functions accepting overrides) is the established pattern in both
  `google-sync.test.ts` and `secrets-adapter.test.ts`.
- "No silent guesses" (`.pHive/CONTEXT.md` convention) — the exact OAuth
  mechanics below were confirmed against current external docs, not assumed
  from possibly-stale training knowledge.

## Confirmed external facts (current, verified via web research)

- Google's old **out-of-band (OOB) flow is fully dead** — blocked for new
  clients Feb 28, 2022, and for *all* clients (including previously
  grandfathered ones) since Jan 31, 2023. Not usable at all today.
  ([source](https://developers.google.com/identity/protocols/oauth2/resources/oob-migration))
- The current, Google-recommended mechanism for a Desktop-app OAuth client
  is the **loopback IP address flow**: start a local HTTP listener on
  `127.0.0.1` (a random available port is fine — Google's own docs say to
  bind port 0 and read back the OS-assigned port), open the system browser
  to the consent URL, and catch the redirect (`?code=...` or `?error=...`)
  on that listener.
  ([source](https://developers.google.com/identity/protocols/oauth2/native-app),
  [migration guide](https://developers.google.com/identity/protocols/oauth2/resources/loopback-migration))
- The redirect URI must be `http://127.0.0.1:<port>` (or `http://[::1]:<port>`);
  `localhost` is technically accepted but Google's own docs warn it "may
  cause issues with client firewalls." The port does **not** need to be
  pre-registered in the GCP Console for a Desktop-app client — it can float
  per-request.
- `googleapis`/`google-auth-library` (confirmed from the real on-disk types
  in `node_modules/google-auth-library/build/src/auth/`):
  - `auth.generateAuthUrl({ access_type: "offline", scope, prompt: "consent",
    redirect_uri })` — `access_type: "offline"` is required to get a
    `refresh_token` at all; `prompt: "consent"` forces the consent screen so
    a refresh_token is reliably reissued even on a re-auth (Google only
    issues one on a user's *first* authorization for a given client
    otherwise).
  - `auth.getToken(code): Promise<{ tokens: Credentials }>` — `tokens` is
    exactly the `Credentials` shape (`access_token`, `refresh_token?`,
    `scope`, `token_type`, `expiry_date`) that `GOOGLE_OAUTH_TOKEN_KEY`
    already expects.
  - `OAuth2Client` auto-refreshes an expired access token from a stored
    `refresh_token` internally on the next API call.
  - It emits a `'tokens'` event (`authclient.d.ts:162`,
    `on(event: 'tokens', listener: (tokens: Credentials) => void)`) both
    after the initial exchange and after any silent refresh — this is the
    correct single hook to persist both the first token and every later
    refresh back to the keychain.

## Risks

- **Medium** — this is genuinely new logic (the codebase's first real local
  HTTP redirect listener + real OAuth token exchange), not integration over
  already-tested code like the mcp-tool-bodies epic was. Warrants careful
  design of the listener's lifecycle (must not hang forever if the user
  closes the browser tab without completing consent; must not leave a
  stray listener running).
- **Low** — scope creep risk: this epic is about making `pull()` reachable
  by a real user, not adding `push()` or two-way sync. Must stay bounded.
- **Low** — Darwin-only browser-opening (via the already-used `open` CLI)
  matches an existing, already-accepted project constraint, not a new one.

## Open questions

1. Should the flow also be reachable outside the first-run wizard (e.g. a
   "reconnect Google" action in Settings) for a user whose refresh_token
   gets revoked, or is wizard-only acceptable for this epic's scope?
2. Should a successfully-refreshed access token (captured via the `'tokens'`
   event) be persisted back to the keychain after every `pull()`, or is
   relying on the refresh_token to silently re-derive a fresh access token
   on each call (never persisting the refreshed one) an acceptable simpler
   choice for a personal-scale, infrequently-run sync?

## Inconsistency risk signals

**present** — for the grill pass to focus on:

- The exact lifecycle/timeout behavior of the local OAuth-callback HTTP
  listener (when does it stop listening, what happens if the user never
  completes consent) is not yet specified anywhere and needs an explicit,
  reasoned answer rather than an implicit assumption.
- Whether the wizard is the only surface that can (re)trigger this flow is
  an open, not-yet-resolved scope boundary (see open question 1).
