# Changelog

## [Unreleased]

## [0.5.0] - 2026-08-20

### Changed

- **Release finalization.** Applied a `minor` version bump (`0.4.0` → `0.5.0`) bundling everything below — the Electron packaging, Portunus, and CLI work along with real two-way Google sync, the new Settings screen, and the toast/loading-state work, none of which had been tagged/published before this release.

### Added

- **Packaged desktop app.** rolodex now installs as a real Electron app for macOS (dmg), Windows (NSIS), and Linux (AppImage + deb) — `npm run electron` to run from source, `npm run electron:package` to build locally. Unsigned for now (Gatekeeper/SmartScreen show an "unidentified developer" warning; documented workaround in the README). A tag-triggered CI workflow (`.github/workflows/release.yml`) publishes builds to GitHub Releases.
- **Native launch-at-login**, in the packaged app's Settings screen — backed by the OS's own login-item mechanism (`app.setLoginItemSettings`), not an external launchd/systemd script.
- **A real generated app icon**, replacing the original hand-drawn placeholder favicon, plus a **selectable "Brass" appearance theme** and a 10-candidate icon picker in Settings.
- **A third, plain CLI surface** (`rolodex <command>`) for non-MCP tooling/scripts — `upsert`, `search`, `followups`, `log`, `sync-google`, `delete`, all wired to the exact same handlers the MCP server registers.
- **A real second `SecretsAdapter` backend: Portunus.** The setup wizard now offers a Keychain/Portunus choice, not just macOS Keychain — also switchable later from Settings.
- **Real two-way Google Contacts sync.** Push every local contact to Google (creating new ones, updating linked ones), with etag-based conflict detection — a contact that changed on Google since your last sync is reported clearly instead of silently overwritten. Deleting a contact (`Store`/HTTP/MCP/CLI/UI, all new: rolodex had no delete at all before this) now best-effort deletes it on Google too when it was linked.
- **A dedicated Settings screen** (`#/settings`), replacing the old gear-icon popover entirely — consolidates Follow-up window, Appearance, Autostart, and Google account status/reconnect (with a real three-state status check, not just a bare Reconnect button), plus two sections previously reachable only during first-run setup: **Database location** and **Secrets backend**.
- **A shared toast/notification component** for one-off events (sync/push results, delete failures, save confirmations) — auto-dismiss with a manual close, correct ARIA roles (errors interrupt regardless of focus). Real loading states added to the contact detail view and edit form, which previously showed nothing while their data was loading.
- MCP tool descriptions rewritten to work identically across any MCP-compatible host, not just Claude Code.
- The GitHub Pages site rebuilt to match the rest of the tool portfolio's bar (stats, tech stack, support links).
- The rolodex skill (`.claude/skills/rolodex/SKILL.md`) gained explicit guidance for filing multi-person call notes, for deep-diving/pre-filling a contact from a web search (always confirming sourced fields with the user before writing them), and for the real two-way sync and delete tools.

### Fixed

- **Security:** the packaged Electron app was binding its local HTTP server to all network interfaces instead of loopback-only, exposing the unauthenticated contacts API and Google OAuth credential routes to anyone on the same network. Fixed before any release shipped it.
- A global install (`npm link`/`npm i -g`) of the MCP server or CLI silently did nothing when invoked through the resulting symlinked bin — `isMainModule`'s path comparison didn't resolve symlinks.
- A failed verdict/next-step autosave rendered its error message in the *success* color — three near-duplicate status CSS classes, one of them with no error variant defined at all, unified into one shared component.
- Navigating to a deleted/unknown contact silently bounced back to the contact list before the "not found" message could ever actually be seen (it was set, then instantly discarded by an unconditional redirect on the very next line) — now shown for real, with a working back-link.
- The delete-contact failure path used the browser's native `alert()`, the only one anywhere in the app — replaced with the same toast every other error uses.
- The first real v0.5.0 release build failed on two platforms before anything public shipped: a tracked audit-log filename containing a colon made `git checkout` fail outright on Windows runners (NTFS reserves `:`), and the Linux `.deb` build failed for lacking an author email in `package.json`. Fixed before any release shipped it.
- `npm run dev`/`cli`/`shell`/`test` used Unix-only `NODE_OPTIONS=... <cmd>` shell syntax, which doesn't work on Windows — CI never caught it because `ci.yml` only runs on `ubuntu-latest`; the release workflow's first-ever Windows run of `npm test` did. Switched to `cross-env` for all four.

## [0.4.0] - 2026-08-12

### Changed

- **`google-oauth-flow` release finalization.** Applied the planned `minor` version bump (`0.3.0` → `0.4.0`) for the real Google OAuth consent flow.

### Added

- A real Google OAuth 2.0 "loopback IP address" consent flow (`src/lib/google-oauth-flow.ts`) — the current Google-required mechanism for a Desktop-app client, replacing the dead out-of-band flow. Google sync is now actually reachable by a real user: the wizard's Google-connect step completes a real sign-in instead of stopping at a placeholder, and a token refreshed during a routine sync is now persisted back to the keychain instead of silently re-derived every time.
- A working Cancel button on the wizard's Google-connect step, genuinely tearing down the local OAuth listener instead of running out a 120-second timeout.
- A "Reconnect Google" action in the shell's settings popover, for re-establishing a revoked/expired connection without rerunning the first-run wizard.

## [0.3.0] - 2026-08-12

First tagged release.

### Changed

- **`mcp-tool-bodies` release finalization.** Applied the planned `minor` version bump (`0.2.1` → `0.3.0`) for wiring the MCP tool bodies.
- **`followups-view` release finalization.** Applied the planned `patch` version bump (`0.2.0` → `0.2.1`) for the follow-up tracking epic.
- **`standalone-app-foundation` release finalization.** Applied the planned `minor` version bump (`0.1.0` → `0.2.0`) for the standalone-app foundation epic.

### Added

- Standalone desktop app: local shell + server hosting the SQLite store directly (`npm run shell`), superseding the MCP-only pre-1.0 shape as the primary way to run rolodex.
- Full contact CRUD (add, view, edit, verdict, next-step) through a real UI, backed by real `Store` methods.
- A pluggable `SecretsAdapter` (macOS Keychain via the `security` CLI, with an in-memory fallback) for OAuth credential storage — no environment-variable fallback, ever.
- A 5-screen first-run setup wizard (welcome, database location, Google connect, secrets check, finish) with no login/logout anywhere — this app is single-user-per-instance.
- One-shot Google Contacts sync (`pull()`), preserving local-only fields (verdict, angle, next step) across a sync.
- Full-text search (FTS5 with a LIKE-based fallback on Node builds without the fts5 module) and interaction logging with history.
- CI (typecheck + test on push/PR).

### Added (followups-view)

- `Store.needsFollowUp()` implemented for real — the last unimplemented piece of the original `Store` interface — surfacing contacts with an overdue next step.
- A configurable follow-up window and grace period, backed by a new `settings` table, rather than hardcoded numbers — editable from a settings panel in the app.

### Added (mcp-tool-bodies)

- All 5 `rolodex_*` MCP tools (`upsert`, `search`, `followups`, `log_interaction`, `sync_google`) wired to real `Store`/`GoogleSync` logic — the last unimplemented surface in the project. An agent host (Claude Desktop, another agent) can now actually read/write the owner's rolodex through MCP, not just get placeholder text back.
- A real favicon (`assets/favicon.svg`, index-card motif in the paper/brass palette) and Open Graph meta tags for the shell app.

### Documentation

- `docs/ARCHITECTURE.md` and `README.md` rewritten to describe the standalone-app-first architecture, explicitly superseding the prior MCP-first framing.
- `README.md`'s MCP section updated to reflect the tool bodies are now real, not stubbed.
