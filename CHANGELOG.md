# Changelog

## [Unreleased]

### Changed

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

### Documentation

- `docs/ARCHITECTURE.md` and `README.md` rewritten to describe the standalone-app-first architecture, explicitly superseding the prior MCP-first framing.
