# rolodex

**Your relationship rolodex, as an MCP tool.** Own your contacts (local SQLite), sync them with your Google Contacts, and give your AI agents a rolodex they can read, search, and keep warm. Configure it once per install; add it as a tool and it's *yours* — no bespoke integration each time.

Built to be a Pantheon plugin / MCP tool in the same spirit as the rest of the suite (gigradar, allergy-locator): a **generic core** you configure, not a script you edit.

## Why this exists
A static contacts file is a goldfish — nothing maintains it. This makes the rolodex a **tool your agents operate**: they log who you met, set the verdict + next step, search it, and surface who's gone cold — so nobody good slips. And because it syncs to Google Contacts on *your* credentials, it's also how an agent reaches your Gmail contacts without anyone else holding your token.

## The shape
- **You own the data** — SQLite (FTS5 full-text search), path outside the repo (`ROLODEX_DB`). Export any time; no lock-in.
- **Google People API sync** — two-way with your Google Contacts (verdict/angle/next-step stay local; name/email/phone sync). Runs on *your* OAuth, sourced from env/local token (gitignored).
- **MCP tools** — `rolodex_upsert`, `rolodex_search`, `rolodex_followups`, `rolodex_log_interaction`, `rolodex_sync_google`. Add the server to any agent host and it just works.
- **Config per-install** — nothing about any one user lives in the core; your DB path + Google creds are your layer.

## Relationship model (partner/network focused)
Each contact carries: `org`, `role`, how you `met` them, `what` they do, the partnership `angle`, a **verdict** (`strong` / `watch` / `referral-only` / `pass`), and the ONE **next step**. Interactions are logged so `rolodex_followups` can surface anyone with a next step who's gone quiet.

## Install (add it as a tool)
```jsonc
// in your MCP host config (Claude Desktop, Pantheon, etc.)
{ "mcpServers": { "rolodex": { "command": "npx", "args": ["-y", "rolodex-mcp"] } } }
```
Set `ROLODEX_DB` and your Google OAuth (see docs/ARCHITECTURE.md → Google sync setup).

## Status
`v0.1.0` — scaffold. Types, the SQLite/FTS store contract, the Google People sync adapter, and the MCP tool surface are defined and wired; the method bodies are the build-out (marked `not implemented`). See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## License
MIT © 2026 Mathew Dostal
