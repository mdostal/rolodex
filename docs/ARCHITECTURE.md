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
| **Core (generic OSS)** | this repo, `src/` | types, SQLite store + FTS, SecretsAdapter, Google-sync adapter, desktop shell/server, wizard + UI, MCP server/tools |
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
with an ordinary browser tab as the UI — not Electron, not Tauri. `Store`
already runs as ordinary Node (it needs `node:sqlite`), so an ordinary Node
process serving it needs no IPC bridge, no renderer sandboxing story, and no
native-module rebuild risk. Electron/Tauri remain reasonable future upgrades
if a truly native window (tray icon, offline-from-`file://`) is ever
required; nothing here forecloses that since `Store` itself is untouched by
this choice.

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

- **Real backend:** macOS Keychain via the `security` CLI
  (`add/find/delete-generic-password`), invoked through
  `child_process.execFile` with an argv array (never a shell string).
  Deliberately **not** `keytar` (archived/unmaintained) and not a compiled
  native module like `@napi-rs/keyring` (per-platform prebuilds are an
  install-time risk this factory needs to avoid) — `security` ships with
  every macOS install and needs no dependency or compilation.
- **Fake backend:** a plain in-memory `Map`, used by tests and as the
  automatic fallback target.
- `createSecretsAdapter()` auto-detects: non-Darwin platforms get the
  in-memory fake immediately (with a `console.warn`); on Darwin, if the real
  keychain backend throws on its first call (no `security` binary, sandboxed
  environment, etc.) the whole adapter permanently swaps to the in-memory
  fake for the rest of the process rather than crashing the app.
- Errors thrown from the keychain `set()` path are deliberately sanitized
  before they can reach a log line — `security`'s own error object embeds
  the full invoked argv (including the plaintext secret) in `.message`/`.cmd`;
  `secrets-adapter.ts`'s `sanitizeSetError()` strips that before anything
  downstream (including the wizard's own error UI) can see it.
- The interface boundary exists specifically so a future OSS contribution
  (the owner has named a `Portunus` adapter — key injection from an
  encrypted external store) can plug in without touching `Store`, the wizard,
  or the UI. This epic ships exactly one real backend (OS keychain); no
  second backend is implemented yet.

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
- [x] `SecretsAdapter`: interface + factory + macOS-keychain implementation +
      in-memory fake, with automatic fallback and error sanitization.
- [x] Five-screen first-run setup wizard, no login/logout anywhere.
- [x] A real Google OAuth 2.0 consent flow (loopback IP address flow,
      `src/lib/google-oauth-flow.ts`), reachable from the wizard and from a
      "Reconnect Google" action in Settings, with a working Cancel button.
- [x] One-shot Google Contacts pull, with local-only-fields-survive-sync
      guarantee, and a refreshed token now persisted back to the keychain.
- [x] All 5 MCP tools wired to the same real `Store`/`GoogleSync` logic.
- [x] Search (UI + API) and interaction logging (UI + API).
- [x] Docs rewrite (this file + README.md) and CI.

Remaining gaps:
- [ ] Google `push()` / full two-way sync — pull-only today; the OAuth
      exchange itself is real, `push()` remains an explicit stub.
- [ ] Enrichment-on-add (public-info lookup to speed up capturing
      org/role/what-they-do) — deferred; needs to reconcile with the
      "no silent guesses" convention before it's designed.
- [ ] A dedicated settings/account screen beyond the current "Reconnect
      Google" + follow-up-window popover (e.g. changing `ROLODEX_DB` after
      first run, re-running the wizard).
- [ ] Portunus (or any second) `SecretsAdapter` backend — interface is open,
      only one real implementation ships.
- [ ] Cross-platform packaging/distribution — developed and verified on
      macOS only so far (the OAuth flow's browser-opening step degrades to a
      logged URL + manual open on non-Darwin, but is otherwise untested
      there).
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
