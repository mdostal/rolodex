# rolodex

**Your relationship rolodex, as a standalone app you run locally.** Own your
contacts (local SQLite), sync them with your Google Contacts, and keep track
of who you met, the verdict, and the next step — searchable, with a logged
history of every touchpoint.

## Why this exists
A static contacts file is a goldfish — nothing maintains it. Rolodex gives
you a working contact list you actually use: log who you met, set a verdict
and next step, search it, and see who's gone cold. Because it syncs
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
lives, optionally connect Google Contacts (paste an OAuth client id/secret,
then sign in through Google's real consent screen in your browser), a quick
check that secure credential storage works, and finish — no account to
create, no login screen, straight into your (empty) contact list. From
there: add a contact, search, log interactions, and pull in your Google
Contacts once connected. A "Reconnect Google" action lives in Settings if a
connection ever needs re-establishing without rerunning the wizard.

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
  local-only and always survive a sync. Connects through a real OAuth 2.0
  consent flow in your own browser (Google's current "loopback" mechanism
  for a desktop app), with the resulting token — and every later refresh —
  stored via the OS keychain (`SecretsAdapter`) and never an env var, log,
  or file.
- **Search + interaction logging** — find a contact by name/org/what-they-do/
  angle/tags, and log calls/emails/meetings against them.

### Relationship model
Each contact carries: `org`, `role`, how you `met` them, `what` they do, the
partnership `angle`, a **verdict** (`strong` / `watch` / `referral-only` /
`pass` / `none`), and a **next step**. Interactions are logged so you can see
the full touch history per contact.

## MCP server (secondary integration surface)
`src/mcp/server.ts` is a stdio MCP server exposing `rolodex_upsert`,
`rolodex_search`, `rolodex_followups`, `rolodex_log_interaction`, and
`rolodex_sync_google` — add it to any agent host (Claude, your own agent
swarm) and the agent has a real rolodex it can read, search, and update.
Every tool is wired to the same `Store`/`GoogleSync` logic the standalone
app uses — verdict/angle/next-step still stay local-only through a sync,
and `rolodex_sync_google`'s `push` direction returns a clear
not-implemented error rather than a silent no-op (two-way sync is still a
planned follow-up). This remains a secondary integration surface, not the
primary way to use rolodex — the standalone app is that. Run it with
`npm run dev`.

If you use Claude Code, `.claude/skills/rolodex/SKILL.md` teaches an agent
how to use these tools well (when to search before upserting, what never
to fabricate, how to handle the still-unimplemented push direction).

## Development
```sh
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run build        # compile to dist/
```

## Status
`v0.4.0` — the standalone app is the primary, working surface: shell +
server, setup wizard, contact CRUD, search, interaction logging, a real
Google Contacts connect-and-pull flow, and a "who's gone cold" follow-up
view all work end to end. The MCP server's tool bodies are wired to that
same real logic. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the
full architecture and the list of remaining gaps (Google push/two-way sync,
enrichment-on-add).

A future Pantheon plugin tie-in exists only as a dormant, unwired stub —
see [`docs/PANTHEON.md`](docs/PANTHEON.md). Rolodex has zero Pantheon
dependency today and always will be usable standalone.

## License
MIT © 2026 Mathew Dostal
