# rolodex — architecture

## Layers (keep them separate — same rule as gigradar)
| Layer | Lives where | Contains |
|---|---|---|
| **Core (generic OSS)** | this repo, `src/` | types, SQLite store + FTS, Google-sync adapter, MCP server/tools |
| **Your layer** | env + `.local/` (gitignored) | `ROLODEX_DB` path, your Google OAuth creds/token, your data |

The core knows nothing about any specific user. Adding your credentials or moving your DB requires zero core edits.

## Data model (`src/lib/types.ts`)
- **Contact** — `name, org, role, email, phone, met, what, angle, verdict, nextStep, tags, googleResourceName, timestamps`. `verdict` = strong / watch / referral-only / pass / none. `googleResourceName` links to Google People for idempotent sync.
- **Interaction** — `contactId, at, note, channel` — the touch log that powers follow-up detection.

## Store (`src/lib/store.ts`)
SQLite (`node:sqlite`, WAL) with an **FTS5** virtual table over name/org/what/angle/tags so search is real, not a LIKE scan. DB defaults to `~/.local/share/rolodex/rolodex.db` (outside the repo); override with `ROLODEX_DB`. All access through the `Store` class — nothing else writes SQL. `upsert` dedups by `googleResourceName`/email and preserves `createdAt`.

## Google sync (`src/lib/google-sync.ts`) — this is how it reaches your Gmail contacts
Runs in *your* environment on *your* OAuth, so no third party ever holds your token.
1. Enable **People API** in your GCP project (e.g. `personalsites-487021`).
2. OAuth client (Desktop) or service account; creds via `GOOGLE_APPLICATION_CREDENTIALS` or a local token file (both gitignored).
3. Scope: `https://www.googleapis.com/auth/contacts`.
4. Pull via `people.connections.list` (paginate); push via `people.createContact` / `people.updateContact`. Map `resourceName` ↔ `Contact.googleResourceName`. **Verdict/angle/next-step are local-only** (Google has no field for them) — never lost on sync.

## MCP surface (`src/mcp/server.ts`)
Stdio MCP server exposing: `rolodex_upsert`, `rolodex_search`, `rolodex_followups`, `rolodex_log_interaction`, `rolodex_sync_google`. Add it to any agent host and the agent operates the rolodex directly.

## Data-integrity rules (non-negotiable)
1. **You own the data** — local SQLite, exportable, no lock-in.
2. **Secrets never in the repo** — Google creds/token from env/local file, gitignored.
3. **Local fields survive sync** — verdict/angle/next-step are never overwritten by a Google pull.
4. **No silent guesses** — an agent leaves a field blank rather than inventing org/angle/verdict.

## Build-out roadmap
- [ ] Implement `Store` bodies (upsert+FTS reindex, search MATCH, needsFollowUp, setters, logInteraction) + tests.
- [ ] Implement Google People pull/push (googleapis) with owner OAuth + dedup.
- [ ] Wire the MCP tool bodies to the store + sync.
- [ ] CSV importer for a LinkedIn/Google Contacts export (seed the rolodex).
- [ ] Optional: a tiny read-only web/board view rendered from the DB.

## Owner note (Mathew)
This is the "DIY + MCP, owns-your-data" answer from the contacts CBA (`command-center/dostal-tech/CRM-CBA.md`) — cheaper and more integrable than a hosted CRM, and it doubles as the People-API bridge to me@mdostal's Google Contacts. Seed it from your Google Contacts via `rolodex_sync_google` once the sync is implemented.
