# Design Discussion: google-oauth-flow

## 0. Prelude

No prior KG decisions found for this topic (clean slate). This closes a
real, user-identified gap: "we've got to fix the google auth and sync --
that isn't there yet." Sync (`GoogleSync.pull()`) has been described as
"real" and "one-shot pull" across two prior epics, but it was never actually
reachable by a real user — this epic makes that true.

## 1. What Are We Doing?

Implementing the real Google OAuth 2.0 consent flow that the wizard's
Google-connect step has always claimed but never delivered
(`wizard.html:546`: *"Google sign-in happens the first time you sync —
coming soon"*). "Done" is: a real user can click connect, go through
Google's consent screen in their own browser, and have `GoogleSync.pull()`
actually work — no pasted tokens, no manual keychain edits.

## 2. What I Found

- `GoogleSync.pull()` (`src/lib/google-sync.ts:197-233`) is already fully
  correct for reading the token — it reads `SecretsAdapter` key
  `"google.oauth.token"`, expects a JSON-serialized `Credentials` object
  (`access_token`/`refresh_token`/`scope`/`token_type`/`expiry_date`), and
  builds a working `OAuth2Client` from it. Nothing ever writes that key
  today. **(Revised after grill T1)** — it needs one small, deliberate
  addition (not a rewrite) to persist refreshed tokens back to the
  keychain; see §3's resolution of open question 2 below.
- The wizard already saves the OAuth client id/secret correctly
  (`POST /api/wizard/google`, `src/shell/server.ts:211-233`) under
  `"google.oauth.client"` — that part is real and doesn't change.
- Google's old out-of-band ("copy this code back into the app") flow is
  **fully dead** — blocked for all clients since Jan 2023. The current,
  Google-documented mechanism for a Desktop-app OAuth client is the
  **loopback IP address flow**: a short-lived local HTTP listener on
  `127.0.0.1`, catching the redirect after the user completes consent in
  their system browser. This matches the project's own established
  "127.0.0.1-only" convention already enforced on the main shell server.
- `google-auth-library`'s `OAuth2Client` (already a transitive dependency
  via `googleapis`) does exactly what's needed: `generateAuthUrl()` to build
  the consent URL, `getToken(code)` to exchange the code, and a `'tokens'`
  event that fires on both the initial exchange and any later silent
  refresh — the single correct hook for persisting tokens back to the
  keychain.
- No new npm dependency is needed to open the browser — `server.ts:616`
  already spawns the macOS `open` CLI for the same purpose; the new flow
  reuses that exact mechanism.

## 3. My Proposed Approach

**New module: `src/lib/google-oauth-flow.ts`.** A single exported function,
`connectGoogleAccount(opts)`, taking `{ clientId, clientSecret, secrets,
openBrowser?, createOAuth2Client? }` — **(resolves grill H2)** the caller
(the new `server.ts` route) reads and parses `GOOGLE_OAUTH_CLIENT_KEY`
itself (exactly like its existing sibling route already does) and passes
plain `clientId`/`clientSecret` values in; this module never reads that key
directly, keeping it decoupled from how credentials were obtained. It:

1. Starts a plain `http.createServer` bound to `127.0.0.1` on port `0` (OS
   picks a free port) — matching the loopback-flow spec exactly and the
   project's existing loopback-only convention.
2. Builds `redirect_uri = http://127.0.0.1:<port>` — **(resolves grill H1 /
   C2)** no path suffix. Only the bare `http://127.0.0.1:<port>` form was
   actually confirmed against Google's current docs during research; a
   `/callback`-style suffix was an unconfirmed addition and has been
   dropped. The listener matches requests at the root path only.
3. Generates a random `state` nonce and calls
   `auth.generateAuthUrl({ access_type: "offline", prompt: "consent",
   scope: ["https://www.googleapis.com/auth/contacts"], state })`.
   `access_type: "offline"` is required to get a `refresh_token` at all;
   `prompt: "consent"` guarantees one is reissued even on a re-connect.
4. Opens that URL in the system browser (reusing the existing `open` CLI
   spawn pattern from `server.ts:616` — injectable for tests, see below).
   **(Security note, grill S2)**: the `state` nonce is part of that URL and
   therefore visible in the spawned `open` process's argv to other local
   accounts via `ps` for the life of the child process — see §4 for why
   this is an accepted, documented risk rather than a silent gap.
5. Listener behavior on each incoming request — **(resolves grill S1)**:
   only a request at the root path carrying the exact matching `state`
   (with either `code` or `error`) resolves/rejects the flow and closes the
   server. Anything else (wrong path, missing/mismatched `state` — e.g. a
   stray browser probe like `/favicon.ico`, or an unrelated local request)
   gets a generic 404/400 response and is otherwise ignored; the listener
   keeps waiting for a legitimate matching callback until the timeout
   fires. On a legitimate match: verify `state`, extract `code` (or
   `error`), respond with a small static HTML page, then close the server.
   **(Resolves grill S3)**: that response is always one of a small, fixed
   set of hardcoded strings (success / denied / state-mismatch /
   generic-error) selected by which case matched — it never interpolates
   any request-derived value (query params) into the HTML, by construction,
   so there is no reflected-content path to sanitize in the first place.
6. Exchanges the code via `auth.getToken(code)`.
7. Wires `auth.on("tokens", (tokens) => secrets.set(GOOGLE_OAUTH_TOKEN_KEY,
   JSON.stringify(tokens)))` **before** calling `getToken()`, so the very
   first token write and any future refresh both flow through one path.
8. **Timeout**: if no legitimate callback arrives within 120 seconds
   (consent screen abandoned, browser tab closed without completing), the
   listener closes itself and the returned promise rejects with a clear,
   actionable error. A `?error=access_denied` callback (user clicks "Deny")
   rejects immediately with a distinct, clearer message than the timeout
   case.
9. **Concurrency guard**: a second call while one is already in flight
   rejects immediately rather than opening a second listener/browser tab.
10. **(Added after researcher review)** `connectGoogleAccount` accepts an
    optional `signal?: AbortSignal` — consistent with the `{signal?:
    AbortSignal}` convention `SecretsAdapter` already uses
    (`secrets-adapter.ts`'s `SecretsAdapterCallOptions`) — so the listener
    can be torn down early instead of always running to the full 120s. The
    wizard's "Connecting…" state gets a real **Cancel** button: it aborts
    the client-side `fetch` via `AbortController` (the existing `onConnect()`
    call currently has neither, a gap the researcher review flagged — up to
    120s with no way to bail out short of closing the tab) and the server
    route forwards the request's abort down into `connectGoogleAccount`'s
    `signal`, so cancelling client-side actually stops the local listener
    rather than leaving it running in the background until timeout.

**Resolves open question 2 (token-refresh persistence) — recommend "yes,
persist on every refresh, not just the initial connect."** The `'tokens'`
event hook already has to exist for the initial exchange; wiring the same
one-line hook into `GoogleSync.pull()`'s existing `OAuth2Client`
construction (`google-sync.ts:214-215`) is a small, clearly-net-positive
addition — it avoids `pull()` silently re-refreshing from the refresh_token
on every call after the first expiry, and keeps the keychain's stored token
current. This is the one small change to `pull()` beyond "no changes
needed" — called out explicitly rather than silently expanded scope.

**Resolves open question 1 (reconnect surface) — recommend yes, but as a
separate, droppable story.** The wizard is the primary connect surface (a
new sibling route, `POST /api/wizard/google/connect`, alongside the
existing client-save route). A second addition exposes the same action from
the shell's existing settings popover (`⚙` icon) as "Reconnect Google" —
closes the real gap of a revoked/expired refresh_token with no way back in
short of rerunning the whole 5-screen wizard. **(Corrected after researcher
review)** — this is *not* a small same-pattern plug-in as originally
implied: `wireSettingsPanel()`/`settingsFormHtml()`
(`src/shell/index.html:736-797`) is a single-purpose form for two numeric
fields with its own submit handler and focus-trap logic, with no existing
action-list/menu structure to extend. Adding "Reconnect Google" means
either restructuring the popover into multiple sections or wiring a second,
parallel disclosure alongside it — real, if modest, new UI structure, sized
accordingly in its own story rather than described as trivial. Still
cleanly droppable/optional (nothing else depends on it existing).

**Testing**: mirrors the existing DI convention exactly
(`google-sync.test.ts`). `connectGoogleAccount` accepts injectable
`openBrowser`, `createOAuth2Client`, and `secrets`. **(Clarified after TPM
review)** — the injected `openBrowser(url)` receives the *full* generated
consent URL, which embeds the real `redirect_uri` (including the
OS-assigned port); a test's fake `openBrowser` parses that URL to learn the
port, then fires a real HTTP request at the real (test-bound) local
listener with a fake `code`, asserting the fake OAuth2Client's `getToken`
was called and the fake secrets adapter received the right value. No real
network call to Google, ever, in tests — same as every other module in
this codebase.

**(Clarified after TPM review)** — the `google-sync.ts` change (exporting
`GOOGLE_OAUTH_TOKEN_KEY` and wiring the `'tokens'` persistence hook into
`pull()`'s existing `OAuth2Client`, resolving open question 2) is bundled
into the same story as the new module, not split into a separate one — the
export is required for the new module to compile at all, and the `pull()`
hook is a two-line addition to the same file touched for the export. Called
out explicitly here so it isn't a surprise inside an otherwise
single-purpose-sounding "core module" story.

## 4. What Could Go Wrong

- **Medium, addressed** — a hung listener if the user abandons the consent
  flow. Addressed with an explicit 120s timeout that always closes the
  server, whether resolved, rejected, or timed out, plus (researcher
  review) a real Cancel button that tears the listener down immediately
  via `AbortSignal` rather than making the user wait out the full 120s.
- **Low** — CSRF against the brief local listener window. Addressed with a
  `state` nonce, verified on callback, plus (grill S1) non-matching
  requests never close the listener or settle the flow.
- **Low, accepted (grill S2)** — the `state` nonce is briefly visible in
  the spawned `open` process's argv to other local accounts on the same
  machine (via `ps`), unlike the app's prior `open` usage which only ever
  opened a fixed, non-sensitive URL. Accepted under this app's single-user,
  local-machine threat model — the same class of exposure the OS keychain
  CLI calls already have (see `secrets-adapter.ts`'s `sanitizeSetError`
  discussion) — and mitigated by the nonce being single-use and short-lived
  (the listener closes within 120s regardless of outcome). Documented here
  rather than silently accepted.
- **Low** — double-invocation opening two listeners on two ports and
  confusing the user with two browser tabs. Addressed with a concurrency
  guard.
- **Low** — Darwin-only browser launch. Matches an already-accepted,
  pre-existing project constraint (the whole app already assumes macOS for
  keychain access); not a new limitation introduced by this epic.

## 5. Dependencies and Constraints

- No new npm dependencies.
- **(Resolves grill V1 / C1)** `GOOGLE_OAUTH_TOKEN_KEY` stays defined in
  `google-sync.ts`, gains an `export` (a real, one-line change — not
  "unchanged"), and the new module imports it. This is deliberately
  different from `GOOGLE_OAUTH_CLIENT_KEY`'s established duplicate-the-
  literal pattern: that pattern exists specifically to keep `src/lib`
  independent of `src/shell` (per its own comment). `google-oauth-flow.ts`
  lives in `src/lib` alongside `google-sync.ts` — a same-package,
  same-directory import, not a cross-boundary one — so the rationale for
  duplication doesn't apply, and a real import is both simpler and more
  correct than adding a third duplicate literal.
- `push()` stays explicitly out of scope — this epic is about making the
  existing one-way `pull()` reachable, not two-way sync.

## 6. Open Questions

Both of the research brief's open questions are resolved above (§3) with an
explicit recommendation each. Presenting both to the user for confirmation
rather than treating them as silently decided.

## 7. Verification Strategy

```
VERIFICATION PLAN:
  Tools: vitest — connectGoogleAccount tested via real HTTP requests
         against its own (test-bound, 127.0.0.1) local listener, with a
         fake OAuth2Client/browser-opener/secrets adapter injected. No
         real network call to Google, ever.
  Platforms: Darwin (matches the rest of the app's existing assumption).
  Automated: successful flow (code -> token -> persisted to secrets,
         'tokens' event fires on refresh too); access_denied callback
         rejects with a distinct message; timeout path closes the listener
         and rejects; state-mismatch callback is rejected (CSRF check) and
         does NOT settle the flow (grill S1 — listener keeps waiting);
         non-matching-path request is ignored, also without settling the
         flow; concurrent-call guard rejects the second call; abort via
         signal tears the listener down immediately (researcher review).
  Manual: one real smoke test against the actual Google OAuth consent
         screen using a real (throwaway/test) GCP OAuth client, run
         locally by a human with real credentials — not automatable in CI,
         same category as the existing "real Google OAuth consent flow" is
         already explicitly out of scope for automated verification
         project-wide (see mcp-tool-bodies epic's design-discussion §7).
  Not verifying: real Google OAuth consent flow in CI (impossible without
         real credentials; same existing project-wide exclusion).
```

## 8. Scale Assessment

```
SCALE ASSESSMENT:
  Files affected: ~6 (new src/lib/google-oauth-flow.ts + test file,
    src/lib/google-sync.ts — export GOOGLE_OAUTH_TOKEN_KEY + wire the same
    'tokens' persistence hook into pull()'s existing OAuth2Client, per
    grill T2 — src/shell/server.ts new route, src/shell/wizard.html UI
    wiring, src/shell/index.html settings-panel addition for reconnect)
  Subsystems: local HTTP (new listener pattern), OAuth/secrets, wizard UI,
    settings UI — genuinely cross-stack
  Migration required: no
  Cross-team coordination: no (solo project)
  Unknowns: none blocking — both open questions resolved above with an
    explicit recommendation

  RECOMMENDATION: Medium scope, but proceeding straight to stories rather
    than separate horizontal/vertical planning documents. The feature is
    naturally a single, non-parallelizable vertical (a real OAuth exchange
    either works end-to-end or it doesn't — there's no meaningful "half a
    flow" to slice), which the horizontal/vertical planning phase exists to
    identify for genuinely parallel or independently-shippable work. The
    slicing that matters (core flow module -> wizard wiring -> optional
    reconnect-from-settings) maps directly onto ordered story dependencies
    instead.
```
