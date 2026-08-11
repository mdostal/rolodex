# Changelog

## [Unreleased]

### Changed

- **`standalone-app-foundation` release finalization.** Applied the planned `minor` version bump (`0.1.0` → `0.2.0`) for the standalone-app foundation epic.

### Added

- Standalone desktop app: local shell + server hosting the SQLite store directly (`npm run shell`), superseding the MCP-only pre-1.0 shape as the primary way to run rolodex.
- Full contact CRUD (add, view, edit, verdict, next-step) through a real UI, backed by real `Store` methods.
- A pluggable `SecretsAdapter` (macOS Keychain via the `security` CLI, with an in-memory fallback) for OAuth credential storage — no environment-variable fallback, ever.
- A 5-screen first-run setup wizard (welcome, database location, Google connect, secrets check, finish) with no login/logout anywhere — this app is single-user-per-instance.
- One-shot Google Contacts sync (`pull()`), preserving local-only fields (verdict, angle, next step) across a sync.
- Full-text search (FTS5 with a LIKE-based fallback on Node builds without the fts5 module) and interaction logging with history.
- CI (typecheck + test on push/PR).

### Documentation

- `docs/ARCHITECTURE.md` and `README.md` rewritten to describe the standalone-app-first architecture, explicitly superseding the prior MCP-first framing.
