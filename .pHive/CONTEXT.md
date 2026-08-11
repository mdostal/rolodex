# Project CONTEXT

rolodex: an owned-data relationship rolodex. Today it's a scaffolded MCP server over SQLite; the north star is a standalone desktop app (own UI, setup wizard, login) with the MCP surface as a secondary integration layer.

## Terminology

- **Contact** — a person record (`src/lib/types.ts`): `org, role, met, what, angle, verdict, nextStep, tags, googleResourceName`. `googleResourceName` links to Google People for idempotent sync.
- **Interaction** — a logged touchpoint (`contactId, at, note, channel`) that powers follow-up detection.
- **Verdict** — one of `strong / watch / referral-only / pass / none`. Local-only field; Google sync never overwrites it.
- **Angle** — the partnership rationale for a contact (why they matter, local-only).
- **Next step** — the single next action for a contact; drives `rolodex_followups`.
- **Core vs. your layer** — the repo (`src/`) is generic and knows nothing about any specific user; DB path (`ROLODEX_DB`) and Google OAuth creds live in env / `.local/` (gitignored). See docs/ARCHITECTURE.md.
- **Pantheon** — the plugin suite this tool is designed to eventually join (alongside gigradar, allergy-locator) as an MCP tool. Per north star (`project-profile.yaml`), this integration comes *after* the standalone app, not before.

## Key paths

- `src/lib/types.ts` — Contact / Interaction data model.
- `src/lib/store.ts` — SQLite (node:sqlite, WAL) + FTS5 store; the only place SQL is written.
- `src/lib/google-sync.ts` — Google People API two-way sync adapter (owner's own OAuth).
- `src/mcp/server.ts` — stdio MCP server; registers `rolodex_upsert`, `rolodex_search`, `rolodex_followups`, `rolodex_log_interaction`, `rolodex_sync_google`.
- `docs/ARCHITECTURE.md` — layers, data model, sync design, build-out roadmap.

## Conventions

- All local-only fields (verdict/angle/nextStep) must survive a Google sync pull — never overwritten.
- No silent guesses: an agent leaves a field blank rather than inventing org/angle/verdict (docs/ARCHITECTURE.md → Data-integrity rules).
- Secrets (Google creds/token) never committed — env or local file only, gitignored.

## Canonical references

- `docs/ARCHITECTURE.md` — full architecture, data-integrity rules, build-out roadmap.
- `README.md` — pitch, install snippet, status.
- `command-center/dostal-tech/CRM-CBA.md` (owner's other repo) — the contacts cost-benefit analysis behind this build: start on Google Contacts + People API now ($0, zero ops), graduate to a self-hosted option (e.g. Twenty) only once the network is big enough to earn a dedicated relationship layer.
