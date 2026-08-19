# rolodex — architecture

## This doc supersedes the old MCP-first framing

Earlier versions of this document (and of README.md) described rolodex as
"a Pantheon plugin / MCP tool" first, with a UI listed as an optional,
last-priority line in a build-out roadmap. **That framing is no longer
accurate and this document explicitly supersedes it**, not just reorders it
quietly. As of the `standalone-app-foundation` epic, the primary interface to
rolodex is the **standalone local app** — a desktop shell + local server
hosting a real SQLite store, a first-run setup wizard, and a browser-tab UI.
The MCP server (`src/mcp/server.ts`) still exists and remains a secondary
integration surface — it is not, and is no longer treated as, the thing this
repo builds first. Its tool bodies are wired to the same real `Store`/
`GoogleSync` logic the standalone app uses (see "MCP surface" below); it just
isn't the primary way to use rolodex.

## What's actually built today

- A local Node HTTP server (`src/shell/server.ts`) that hosts `Store`
  in-process and serves a browser-tab UI (`src/shell/index.html`) plus a
  first-run setup wizard (`src/shell/wizard.html`).
- A real `Store` (`src/lib/store.ts`, `node:sqlite`/WAL) with working
  `list`, `upsert`, `get`, `setVerdict`, `setNextStep`, `logInteraction`,
  `listInteractions`, `search`, and `needsFollowUp` (surfaced as a "Needs
  follow-up" view in the UI, with a configurable follow-up window/grace
  period).
- A pluggable `SecretsAdapter` (`src/lib/secrets-adapter.ts`) backed by the
  macOS keychain, used by the wizard and by Google sync.
- A one-shot Google Contacts pull (`src/lib/google-sync.ts`), connected
  through a real OAuth 2.0 consent flow (`src/lib/google-oauth-flow.ts`) run
  from the setup wizard or re-triggered from Settings, that seeds the
  rolodex from the owner's Google Contacts, with local-only fields preserved
  across the merge.
- All 5 MCP tools (`src/mcp/server.ts`) wired to that same real `Store`/
  `GoogleSync` logic.
- A third, plain CLI surface (`src/cli/index.ts`, `rolodex <command>`) for
  non-MCP tooling/scripts — a thin argv wrapper around the exact same
  `RolodexMcpHandlers` the MCP server registers, not a separate
  implementation. JSON in, JSON out, same `ROLODEX_DB` env var as the other
  two surfaces.
- A packaged desktop app (`src/electron/main.ts`, the `electron-packaging`
  epic) — installable/downloadable builds for macOS (dmg), Windows (NSIS),
  and Linux (AppImage + deb), unsigned for now, published to GitHub
  Releases on a `v*` tag push. Electron's main process boots
  `src/shell/server.ts` in-process (unmodified — see "Desktop shell + local
  server" below) and points a `BrowserWindow` at its loopback URL; no
  preload script, no IPC bridge — the web UI is unaware it's inside
  Electron. A native launch-at-login toggle lives in Settings, backed by
  `app.setLoginItemSettings`.
- Search (FTS5-backed, with a LIKE-scan fallback) and interaction logging,
  reachable from the UI and the HTTP API.
- No login, no logout, no in-app access control of any kind. See below.

## Why standalone-app-first (not MCP-first)

The owner's north star (`.pHive/project-profile.yaml`) is a standalone
desktop app — own UI, own install/setup wizard — with the MCP/Pantheon
integration as a secondary layer added *after* the app exists, not before.
The planning trail for this (`.pHive/epics/standalone-app-foundation/docs/design-discussion.md`)
is explicit that shipping UI code without updating these docs would leave the
repo self-contradictory for new contributors — hence this rewrite.

## Layers
| Layer | Lives where | Contains |
|---|---|---|
| **Core (generic OSS)** | this repo, `src/` | types, SQLite store + FTS, SecretsAdapter, Google-sync adapter, desktop shell/server, wizard + UI, MCP server/tools, CLI, Electron packaging |
| **Your layer** | OS keychain + `~/.local/share/rolodex/` (outside the repo, gitignored) | resolved `ROLODEX_DB` path, your Google OAuth client credentials/token, your data |

The core knows nothing about any specific user. Adding your credentials or
moving your DB requires zero core edits — it's all resolved through the
wizard, the DB-path resolver, and `SecretsAdapter`, never hardcoded or
tracked in source.

## Data model (`src/lib/types.ts`)
- **Contact** — `name, org, role, email, phone, met, what, angle, verdict, nextStep, tags, googleResourceName, timestamps`. `verdict` = strong / watch / referral-only / pass / none. `googleResourceName` links to Google People for idempotent sync. `met`/`what`/`angle`/`nextStep`/`tags`/`verdict` are **local-only** — Google has no equivalent fields for any of them.
- **Interaction** — `contactId, at, note, channel` — the touch log that (eventually) powers follow-up detection.

## Desktop shell + local server (`src/shell/server.ts`)

Chosen shape (saf-01): a local Node HTTP server hosting `Store` in-process,
with an ordinary browser tab as the UI. `Store` already runs as ordinary
Node (it needs `node:sqlite`), so an ordinary Node process serving it needs
no IPC bridge, no renderer sandboxing story, and no native-module rebuild
risk. This file itself stays framework-agnostic — it's still exactly what
`npm run shell` runs today, unmodified.

The packaged desktop app (below) is Electron precisely *because* of this
shape: Electron's main process IS Node, so it imports and boots this exact
server in-process with zero changes here, no sidecar, no IPC. See
"Packaged desktop app" below for the full reasoning (including why not
Tauri) and what's actually built.

Run it with `npm run shell`. It:
- Binds to **127.0.0.1 only** — never `0.0.0.0`/all interfaces. This server
  carries OAuth secrets during the wizard flow and full contact data
  afterward, with zero authentication, so it must never be reachable from
  other devices on the network.
- Uses a fixed port (`ROLODEX_SHELL_PORT`, default 4173) as a de facto
  single-instance lock: a second launch can't bind the port, so it can't
  stand up a second server racing the first over the same SQLite file.
- Serves the setup wizard until `POST /api/wizard/complete` has run, then
  serves the main contact UI on every subsequent request. `Store` is not
  constructed — the SQLite file is not opened or created — until wizard
  completion (or, on an already-configured install, first request after
  boot), so a first-run user gets to confirm/change the DB location before
  any file is created.
- Opens the OS default browser automatically on macOS (`open <url>`) unless
  `ROLODEX_NO_OPEN` is set.

## First-run setup wizard (`src/shell/wizard.html`, saf-04)

Five screens, in order: **Welcome → Database location → Connect Google
Contacts → Checking secure storage (SecretsAdapter capability probe) →
Finish.** The Finish screen is what actually calls
`POST /api/wizard/complete`, which is the real commit point — it constructs
`Store` (opening/creating the SQLite file, running migrations) at whatever
path the Database screen resolved, and writes a `wizard.completed` sentinel
through `SecretsAdapter`. There is no "un-complete setup" affordance; once
the sentinel is set, wizard mode never comes back for that install.

The wizard's Google-connect step collects and stores the OAuth client
id/secret via `SecretsAdapter` (key `google.oauth.client`), then runs the
real OAuth exchange: `src/lib/google-oauth-flow.ts`'s `connectGoogleAccount()`
opens Google's consent screen in the system browser, catches the redirect on
a short-lived local `127.0.0.1` listener (Google's current "loopback IP
address" flow for a Desktop-app client), exchanges the code, and writes the
resulting token — and every later silent refresh — to `SecretsAdapter` (key
`google.oauth.token`). A working Cancel button tears the listener down
immediately rather than waiting out its 120s timeout. The same flow is
reachable again later from Settings ("Reconnect Google") if a connection is
ever revoked or expires, without rerunning the whole wizard.

## Packaged desktop app (`src/electron/main.ts`, `electron-packaging` epic)

Installable/downloadable builds — macOS (dmg), Windows (NSIS), Linux
(AppImage + deb) — as a real alternative to `npm run shell`, not a
replacement for it. Electron, not Tauri: Tauri's Rust core cannot reach
`node:sqlite` directly and would need `src/shell/server.ts` bundled and
spawned as a separate sidecar process; Electron's main process IS Node, so
`main.ts` imports and boots that exact server in-process instead — no
sidecar, no IPC bridge, no preload script. The web UI (`index.html`/
`wizard.html`) is unaware it's running inside Electron at all; `main.ts` is
the only file in this repo that imports `electron`.

**Electron 43.4.0, verified not assumed.** `node:sqlite` is a Node *core*
module, not an npm native addon, so the usual `asarUnpack` fix for native
deps doesn't apply to it — what actually matters is which Node version
Electron bundles (see the Node-version caveat below). Electron 43.4.0
bundles Node 24.18.1, confirmed via `ELECTRON_RUN_AS_NODE=1 electron -e
'...'` and a real `DatabaseSync` write/read inside the actual Electron
binary before this version was committed to.

Two platform-specific behaviors from the dev-server phase are handled at
the Electron call site, not by changing their source: `server.ts`'s own
"open the OS browser" step is suppressed (`ROLODEX_NO_OPEN=1`, the window
replaces it), and the real Google OAuth consent screen's browser-open is
redirected to Electron's own `shell.openExternal` via
`connectGoogleAccount`'s already-injectable `openBrowser` option — which
also fixes Windows/Linux for free, since the default opener
(`google-oauth-flow.ts`) is Darwin-`open`-only and silently no-ops
elsewhere.

**Native launch-at-login**, not an external launchd/systemd/registry
script: `GET/PUT /api/settings/autostart` on the shell server, backed by an
injectable `{isSupported, getEnabled, setEnabled}` pair on
`RolodexServerOptions` (same DI shape as `connectGoogleAccount`). Reports
unsupported outside the packaged app (a plain dev server has no OS concept
of autostart); `main.ts` injects the real implementation via
`app.setLoginItemSettings`/`getLoginItemSettings`. A toggle in the Settings
popover only renders when the route reports it's supported.

**Packaging (`package.json`'s `build` key, electron-builder):** targets
macOS dmg, Windows NSIS, Linux AppImage + deb. Icons committed under
`build/` (generated from the app-icon epic's 1024px master via `iconutil`/
PIL). **Explicitly unsigned** — `mac.identity: null`, set deliberately
after discovering electron-builder auto-signs with whatever Apple
Development identity it finds in the local keychain otherwise, which would
silently differ between a local dev build and CI (which has no such
identity) and contradict the "unsigned for now" decision. `asar: true`
needs no `asarUnpack`, per the `node:sqlite` note above.

**Release publishing (`.github/workflows/release.yml`):** new, tag-
triggered (`v*`) — there was no release automation before this (version
bumps and `git tag` have been fully manual). A 3-runner matrix
(macos-latest/windows-latest/ubuntu-latest) each builds and publishes its
own native target via `electron-builder --publish always`, no
cross-compiling. electron-builder derives the expected tag from
`package.json`'s version by default, matching the existing manual-tag
convention — cutting a release is still "bump the version, tag `vX.Y.Z`,"
this workflow just does the packaging + upload that didn't exist.

**Verified for real**, beyond typecheck/tests: launched the actual
asar-packaged, unsigned `.app` binary (not `electron .` dev mode) against a
scratch `$HOME` and confirmed its in-process server booted and served the
real wizard UI; round-tripped the autostart toggle through the real
`app.setLoginItemSettings` call. Windows/Linux targets are configured but
not build-verified on this (macOS) development machine — real per-platform
verification happens the first time the release workflow actually runs on
a pushed tag, one native CI runner per OS.

## Store (`src/lib/store.ts`)
SQLite (`node:sqlite`, WAL) with an **FTS5** virtual table over
name/org/what/angle/tags so search is real, not just a LIKE scan — except see
the Node-version caveat below. DB defaults to
`~/.local/share/rolodex/rolodex.db` (outside the repo); override with
`ROLODEX_DB`, or let the wizard's Database screen resolve/persist a
different path. All access goes through the `Store` class — nothing else
writes SQL. `upsert` dedups by `googleResourceName` then email, and preserves
`createdAt`.

**Node-version caveat:** `node:sqlite`'s bundled SQLite build on Node 22.x
has no `fts5` module compiled in (`no such module: fts5`, even with
`--experimental-sqlite`). Node 23+ does have it. `Store` handles this
gracefully: `contacts`/`interactions` tables and every non-search method
(`list`, `get`, `upsert`, `setVerdict`, `setNextStep`, `logInteraction`,
`listInteractions`) work identically either way. `search()` tries an FTS5
`MATCH` query first and, if that throws (fts5 unavailable), transparently
falls back to a `LIKE`-based scan across the same fields — unranked, but
functionally complete. No feature is actually lost on Node 22.x; search just
degrades from ranked to unranked.

## SecretsAdapter (`src/lib/secrets-adapter.ts`)

Pluggable storage for this instance's Google OAuth credentials, shaped to
mirror the `GoogleSync` pattern below: **an interface, a factory, and a
swappable concrete implementation.**

```ts
export interface SecretsAdapter {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
export function createSecretsAdapter(opts?: CreateSecretsAdapterOptions): SecretsAdapter;
export function createInMemorySecretsAdapter(): SecretsAdapter; // fake, and the fallback target
```

**Two real backends ship**, chosen via `createSecretsAdapter({ backend: "keychain" | "portunus" })`
(defaults to `"keychain"` for byte-identical behavior against every caller
that predates the `backend` option) — the setup wizard's Secrets screen
lets the user pick between them at install time, not just macOS Keychain:

- **Keychain:** macOS Keychain via the `security` CLI
  (`add/find/delete-generic-password`), invoked through
  `child_process.execFile` with an argv array (never a shell string).
  Deliberately **not** `keytar` (archived/unmaintained) and not a compiled
  native module like `@napi-rs/keyring` (per-platform prebuilds are an
  install-time risk this factory needs to avoid) — `security` ships with
  every macOS install and needs no dependency or compilation. Darwin-only —
  `createSecretsAdapter()` falls back to the in-memory fake immediately on
  any other platform (with a `console.warn`).
- **Portunus:** `createPortunusSecretsAdapter()` shells out to the real
  `portunus` CLI the same way (`execFile`, argv array, no shell string) —
  no `process.platform` guard, since Portunus itself is a cross-platform
  Python CLI rather than an OS-specific credential store. Whether Portunus
  is actually installed and working on a given machine is checked at wizard
  time (`isPortunusAvailable()`), and is outside this repo's control to
  guarantee on Windows/Linux.
- **Fake backend:** a plain in-memory `Map`, used by tests and as the
  automatic fallback target for both real backends.
- Either real backend, if it throws on its very first call (no `security`/
  `portunus` binary, sandboxed environment, wrong platform, etc.), makes the
  whole adapter permanently swap to the in-memory fake for the rest of the
  process rather than crashing the app — `withInMemoryFallback()` wraps
  both real backends identically, warning once with whichever backend
  actually failed named in the message.
- Errors thrown from either backend's `set()` path are deliberately
  sanitized before they can reach a log line — the underlying CLI's own
  error object can embed the full invoked argv (including the plaintext
  secret) in `.message`/`.cmd`; `sanitizeSetError()` (keychain) and
  `sanitizePortunusError()` (Portunus) both strip that before anything
  downstream (including the wizard's own error UI) can see it.
- The interface boundary that made adding Portunus possible without
  touching `Store`, the wizard's other screens, or the main UI is exactly
  why it was scoped as "swap the adapter," not a rewrite — same pattern any
  future third backend would follow.

## Google sync (`src/lib/google-sync.ts`)

Runs in *your* environment on *your* OAuth, so no third party ever holds your
token. Shape mirrors `SecretsAdapter`: an interface, a factory, one real
implementation.

```ts
export interface GoogleSync {
  pull(): Promise<Contact[]>;
  push(c: Contact): Promise<{ resourceName: string }>; // stub — see Remaining Gaps
}
export function createGoogleSync(opts?: CreateGoogleSyncOptions): GoogleSync;
```

1. Enable the People API in your GCP project.
2. Create an OAuth client (Desktop); the wizard's Google-connect screen
   saves the client id/secret under `SecretsAdapter` key `google.oauth.client`.
3. Scope: `https://www.googleapis.com/auth/contacts`.
4. `pull()` reads the stored client credentials and OAuth token (key
   `google.oauth.token`) from `SecretsAdapter`, then pages through
   `people.connections.list`, mapping each `resourceName` to
   `Contact.googleResourceName` for idempotent re-sync.

**One-shot pull only, today.** `POST /api/sync/google` on the shell server
calls `pull()`, then merges each pulled contact with any existing local match
(by `googleResourceName`, then email) before handing it to `Store.upsert()` —
this merge (`mergeLocalOnlyFields()`) is what actually protects
verdict/angle/nextStep/tags/met/what/createdAt from being clobbered by a
resync; `Store.upsert()` itself has no notion of "leave this column alone"
and always writes every field it's given. `push()` remains an explicit stub
(`throw new Error("not implemented")`) — two-way sync is out of scope for
this epic.

**Real OAuth exchange is built** (`src/lib/google-oauth-flow.ts`,
`connectGoogleAccount()`) — see "First-run setup wizard" above for the full
flow. `pull()` only fails with an actionable error if a real user genuinely
hasn't connected Google yet (or a refresh token was revoked and needs
reconnecting), not because the exchange doesn't exist.

## MCP surface (`src/mcp/server.ts`) — secondary, wired to the real logic

Stdio MCP server exposing `rolodex_upsert`, `rolodex_search`,
`rolodex_followups`, `rolodex_log_interaction`, `rolodex_sync_google`. Every
tool is wired to the same `Store`/`GoogleSync` logic the standalone app
uses — JSON-stringified responses, `isError: true` on any thrown error
instead of crashing the stdio process, and `rolodex_sync_google`'s `push`
direction returning a clear not-implemented response rather than a silent
no-op (two-way sync is still a genuine gap, see below). This remains a
secondary integration surface, not the primary way to use rolodex — the
standalone app is that. Run it with `npm run dev`. If you use Claude Code,
`.claude/skills/rolodex/SKILL.md` teaches an agent how to use these tools
well.

## Single-user, no in-app login — deliberate, not an oversight

**This app has no login/logout screen, no PIN gate, no session model, and no
in-app access control of any kind.** It is single-user-per-instance: each
person runs their own installation against their own SQLite file. Whatever
protection exists is **OS-account/filesystem-level** — i.e., outside this
app entirely. If rolodex is ever run somewhere the local machine/account
boundary isn't sufficient access control on its own (e.g. a shared host),
that is the responsibility of whatever "super-level" system wraps and
deploys per-user instances of it — not something this app implements
internally. This was a deliberate decision made by the owner during this
epic's planning (see
`.pHive/epics/standalone-app-foundation/docs/design-discussion.md` §3), not
an oversight or a placeholder for a later login feature. `SecretsAdapter`
exists purely to store this instance's Google OAuth credentials — it is not,
and does not become, a session/login mechanism.

One consequence: there is no at-rest database encryption either. The SQLite
file at `~/.local/share/rolodex/rolodex.db` (or wherever `ROLODEX_DB`/the
wizard resolved it to) is plain, unencrypted SQLite, protected only by
normal filesystem permissions.

## Data-integrity and security posture (non-negotiable)
1. **You own the data** — local SQLite, exportable, no lock-in.
2. **OAuth secrets only ever go through `SecretsAdapter`** — the OS keychain
   via the macOS `security` CLI (not `keytar`, not a compiled native
   module). They are never written to an environment variable, a log line,
   or a file. `server.ts`'s wizard-Google route and `secrets-adapter.ts`'s
   own error-sanitization both exist specifically to hold this line even on
   the error path.
3. **The local server binds to `127.0.0.1` only** — never reachable from
   another device on the network, since it has zero authentication of its
   own.
4. **Local-only fields survive a Google sync** — `verdict`/`angle`/
   `nextStep`/`tags`/`met`/`what`/`createdAt` are never overwritten by a
   Google pull; `google-sync.ts`'s `mergeLocalOnlyFields()` re-attaches them
   before every `Store.upsert()` call a sync makes.
5. **No silent guesses** — a sync or the UI leaves a field blank rather than
   inventing org/angle/verdict.
6. **No in-app access control** — see above; this is deliberate, not a gap.

## Build-out status

Done (across `standalone-app-foundation`, `followups-view`,
`mcp-tool-bodies`, and `google-oauth-flow`):
- [x] Desktop shell + local server, bound to loopback, real `Store` wired in.
- [x] `Store` bodies: `list`, `upsert`, `get`, `setVerdict`, `setNextStep`,
      `logInteraction`, `listInteractions`, `search` (FTS5 + LIKE fallback),
      `needsFollowUp` — with a "Needs follow-up" UI view and a configurable
      follow-up window/grace period.
- [x] `SecretsAdapter`: interface + factory + **two** real backends
      (macOS Keychain and Portunus, user-selectable in the wizard's Secrets
      screen) + in-memory fake, with automatic fallback and error
      sanitization for both.
- [x] Five-screen first-run setup wizard, no login/logout anywhere.
- [x] A real Google OAuth 2.0 consent flow (loopback IP address flow,
      `src/lib/google-oauth-flow.ts`), reachable from the wizard and from a
      "Reconnect Google" action in Settings, with a working Cancel button.
- [x] One-shot Google Contacts pull, with local-only-fields-survive-sync
      guarantee, and a refreshed token now persisted back to the keychain.
- [x] All 5 MCP tools wired to the same real `Store`/`GoogleSync` logic.
- [x] A third plain CLI surface (`rolodex <command>`) wrapping the same
      handlers, for non-MCP tooling/scripts — including a fix for the
      `isMainModule` symlink bug that made a global `npm link`/`npm i -g`
      install of the CLI (or the MCP server) silently do nothing.
- [x] Search (UI + API) and interaction logging (UI + API).
- [x] Docs rewrite (this file + README.md) and CI.
- [x] A packaged, installable Electron desktop app for macOS/Windows/Linux
      (unsigned), native launch-at-login, and a tag-triggered CI release
      workflow publishing to GitHub Releases (`electron-packaging` epic) —
      see "Packaged desktop app" above.
- [x] A pre-release security/correctness review (this section reflects its
      output) — caught and fixed a critical bug where the packaged
      Electron app bound its server to all network interfaces instead of
      loopback-only, plus a missing single-instance lock and unhandled
      boot-error path in the same file.

Remaining gaps:
- [ ] Code signing / notarization — explicitly deferred as part of the
      `electron-packaging` epic's confirmed scope, not an oversight.
      Unsigned installs show a Gatekeeper "unidentified developer" warning
      on macOS (right-click → Open works around it) and a Windows
      SmartScreen equivalent.
- [ ] An auto-updater for the packaged app — a real product decision on its
      own, not decided as part of `electron-packaging`.
- [ ] Real per-platform verification of the Windows/Linux packaged builds —
      configured and CI-wired, but only the macOS build has actually been
      launched and smoke-tested so far (no cross-build tooling on the
      development machine); this resolves the first time the release
      workflow runs on a real pushed tag.
- [ ] Google `push()` / full two-way sync — pull-only today; the OAuth
      exchange itself is real, `push()` remains an explicit stub.
- [ ] Enrichment-on-add as a *product feature* (a built-in public-info
      lookup) is still deferred. What exists today is a skill-level
      reconciliation instead: `.claude/skills/rolodex/SKILL.md` tells an
      agent it MAY use its own web-search tool to deep-dive a person/company
      on request, but must always propose sourced fields back to the user
      for confirmation before `rolodex_upsert` — the "no silent guesses"
      convention holds because the write step still requires a human yes,
      not because enrichment doesn't happen. No new Store/MCP/CLI code
      backs this; it's agent behavior on top of the existing tools.
- [ ] A dedicated settings/account screen beyond the current Follow-up/
      Appearance/Google/Autostart popover sections (e.g. changing
      `ROLODEX_DB` after first run, re-running the wizard).
- [ ] Full at-rest database encryption — see "Single-user, no in-app login"
      above; not planned as an in-app feature.
- [ ] Comprehensive loading/error/toast state coverage across the Contact UI
      beyond each slice's basic error handling.
- [ ] Pantheon plugin integration — a dormant, unwired stub exists (see
      [`docs/PANTHEON.md`](PANTHEON.md)) with no real wiring into either
      repo; explicitly deferred until Pantheon's own plugin system settles.

## Owner note (Mathew)
This is the "DIY, owns-your-data" answer from the contacts CBA
(`command-center/dostal-tech/CRM-CBA.md`) — cheaper and more integrable than
a hosted CRM, and it doubles as the People-API bridge to me@mdostal's Google
Contacts. Run `npm run shell`, complete the wizard, then use "Sync now" (or
`POST /api/sync/google`) to pull in your Google Contacts once Google sign-in
is connected.
