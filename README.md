# rolodex

**Your relationship rolodex, as a standalone app you run locally.** Own your
contacts (local SQLite), sync them with your Google Contacts, and keep track
of who you met, the verdict, and the next step — searchable, with a logged
history of every touchpoint.

## Why this exists
A static contacts file is a goldfish — nothing maintains it. Rolodex gives
you a working contact list you actually use: log who you met, set a verdict
and next step, search it, and (soon) see who's gone cold. Because it syncs
with Google Contacts on *your* credentials, it also reaches your Gmail
contacts without anyone else holding your token.

## Run it
```sh
npm install
npm run shell
```
This starts a local server on `http://localhost:4173` (loopback only — never
reachable from other devices) and opens it in your browser. On first run
you'll walk through a five-screen setup wizard: pick where your database
lives, optionally connect Google Contacts (paste an OAuth client id/secret),
a quick check that secure credential storage works, and finish — no account
to create, no login screen, straight into your (empty) contact list. From
there: add a contact, search, log interactions, and pull in your Google
Contacts once connected.

**There is no login/logout in this app.** It's single-user-per-instance —
whatever access control you need is your OS account / filesystem
permissions, not anything rolodex enforces itself. See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for why that's a deliberate
decision, not a gap.

### The shape
- **You own the data** — SQLite, stored at `~/.local/share/rolodex/rolodex.db`
  by default (or wherever the wizard's Database screen points it, or
  `ROLODEX_DB`). Export any time; no lock-in. Full-text search (FTS5) needs
  **Node 23+**; on Node 22.x it degrades gracefully to a slower but fully
  functional LIKE-based scan — contacts and interactions work identically
  either way.
- **Google Contacts sync** — one-shot pull today (push/two-way is a planned
  follow-up), deduped by resource name/email. Verdict/angle/next-step are
  local-only and always survive a sync. Runs on *your* OAuth, stored via the
  OS keychain (`SecretsAdapter`) — never an env var, log, or file.
- **Search + interaction logging** — find a contact by name/org/what-they-do/
  angle/tags, and log calls/emails/meetings against them.

### Relationship model
Each contact carries: `org`, `role`, how you `met` them, `what` they do, the
partnership `angle`, a **verdict** (`strong` / `watch` / `referral-only` /
`pass` / `none`), and a **next step**. Interactions are logged so you can see
the full touch history per contact.

## MCP server (secondary, not yet wired up)
`src/mcp/server.ts` is a stdio MCP server exposing `rolodex_upsert`,
`rolodex_search`, `rolodex_followups`, `rolodex_log_interaction`,
`rolodex_sync_google` — meant for adding rolodex as a tool to an agent host.
Every tool body is still a stub today; this is a secondary integration
surface planned for after the standalone app, not the primary way to use
rolodex right now. Run it (once implemented) with `npm run dev`.

## Development
```sh
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run build        # compile to dist/
```

## Status
`v0.1.0` — the standalone app is the primary, working surface: shell +
server, setup wizard, contact CRUD, search, interaction logging, and a
one-shot Google Contacts pull all work end to end. See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full architecture and
the list of remaining gaps (Google push/two-way sync, the MCP tool bodies,
enrichment-on-add, a "who's gone cold" view).

## License
MIT © 2026 Mathew Dostal
