# rolodex

<!-- shared:tagline -->
> A local-first contact manager with an MCP server. Free & open source.
<!-- /shared:tagline -->
<!-- shared:byline -->
Built by [Mathew Dostal](https://mdostal.com) — fractional CTO, Dostal Technology.
<!-- /shared:byline -->

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

## Download the app

rolodex packages as a real installable desktop app (Electron) for macOS,
Windows, and Linux — `.dmg` / `.exe` / `.AppImage`+`.deb` respectively,
published to [GitHub Releases](https://github.com/mdostal/rolodex/releases)
on a tagged release going forward.

**No packaged build has been published yet as of this writing.** The
current latest release predates the Electron-packaging work — check the
Releases page for whether a newer tag with real desktop binaries has
landed since. Until then, build from source below.

Of the three platforms, only **macOS** has actually been built and
launch-tested end to end so far; Windows and Linux are configured
identically but haven't been verified on real hardware yet (see
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)'s "Remaining gaps" for the
current status).

**Builds are currently unsigned.** That means:
- **macOS:** Gatekeeper will say the app is from an "unidentified
  developer." Right-click the app → **Open** (once) instead of
  double-clicking, and it'll launch normally from then on.
- **Windows:** SmartScreen will show "Windows protected your PC." Click
  **More info** → **Run anyway**.

This is a known, deliberate tradeoff for now (see
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)'s "Remaining gaps") — not a
bug, and not a sign anything's wrong with the download.

Prefer to build it yourself instead of trusting a binary? Same repo, same
code:
```sh
npm install
npm run electron          # runs the app from source (same code the packaged build ships)
npm run electron:package  # builds an installable .dmg/.exe/.AppImage locally, unsigned
```

## Run it (dev server, no app install)
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
  by default (changeable any time from Settings, not just during first-run
  setup, or via `ROLODEX_DB`). Export any time; no lock-in. Full-text search
  (FTS5) needs **Node 23+**; on Node 22.x it degrades gracefully to a slower
  but fully functional LIKE-based scan — contacts and interactions work
  identically either way.
- **Google Contacts sync, two-way** — pull, or push every local contact back
  to Google (create new, update linked ones), deduped by resource name/email.
  A real edit conflict (the contact changed on Google since your last sync)
  is reported clearly rather than silently overwritten. Verdict/angle/
  next-step are local-only and always survive a sync. Connects through a
  real OAuth 2.0 consent flow in your own browser (Google's current
  "loopback" mechanism for a desktop app), with the resulting token — and
  every later refresh — stored via the OS keychain (`SecretsAdapter`) and
  never an env var, log, or file.
- **Search + interaction logging** — find a contact by name/org/what-they-do/
  angle/tags, and log calls/emails/meetings against them.
- **Launch at login** — the packaged app (not the dev server) has a native
  "start at login" toggle in Settings, backed by the OS's own login-item
  mechanism, not a launchd/systemd script bolted on from outside.
- **A real Settings screen** — follow-up window, appearance, autostart,
  Google account status, database location, and secrets backend (Keychain
  vs Portunus, when available) all live in one place, reachable any time
  from the gear icon — not just during first-run setup.

### Relationship model
Each contact carries: `org`, `role`, how you `met` them, `what` they do, the
partnership `angle`, a **verdict** (`strong` / `watch` / `referral-only` /
`pass` / `none`), and a **next step**. Interactions are logged so you can see
the full touch history per contact.

## MCP server (secondary integration surface)
`src/mcp/server.ts` is a stdio MCP server exposing `rolodex_upsert`,
`rolodex_search`, `rolodex_followups`, `rolodex_log_interaction`,
`rolodex_sync_google`, and `rolodex_delete` — add it to **any MCP-compatible
agent host** (Claude Desktop, Claude Code, or your own harness — this is the
standard `@modelcontextprotocol/sdk` stdio transport, nothing
Claude-specific) and the agent has a real rolodex it can read, search, and
update. Every tool's own description carries the guardrails an agent needs
(search before creating, never fabricate a match, delete is destructive and
permanent) directly in the MCP protocol response — not tucked away in a
Claude-specific file — so this works the same regardless of which host is
calling it. Every tool is wired to the same `Store`/`GoogleSync` logic the
standalone app uses — verdict/angle/next-step stay local-only through a
sync, and `rolodex_sync_google`'s `direction: "pull" | "push" | "both"` is
real two-way sync, not a stub. This remains a secondary integration surface,
not the primary way to use rolodex — the standalone app is that.

Run it directly with `npm run dev`, or point any MCP host's config at it:

```json
{
  "mcpServers": {
    "rolodex": {
      "command": "node",
      "args": ["--experimental-sqlite", "/path/to/rolodex/dist/mcp/server.js"],
      "env": { "ROLODEX_DB": "/path/to/your/rolodex.db" }
    }
  }
}
```

If your host supports Claude Code-style skills,
`.claude/skills/rolodex/SKILL.md` adds a bit more depth on top of the tool
descriptions above — but nothing here depends on it.

## CLI (third integration surface, for non-MCP tooling)

`rolodex <command>` (`src/cli/index.ts`) is a plain, scriptable command for
harnesses/scripts that shell out instead of speaking MCP — same
`Store`/`GoogleSync` logic as the app and the MCP server (it's a thin argv
wrapper around the exact same handlers `src/mcp/server.ts` registers, not a
separate implementation), same `ROLODEX_DB` env var, JSON on stdout,
`{"error": "..."}` on stderr with a non-zero exit code on failure:

```sh
rolodex upsert --name "Ezra Cohen" --org "Fieldnote Labs" --role Founder --verdict strong
rolodex search "Fieldnote"
rolodex log <contactId> "Had a work call, liked him a lot." --channel call
rolodex followups
rolodex sync-google --direction both
rolodex delete <contactId>
rolodex --help
```

## Development
```sh
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run build        # compile to dist/
```

## Status
`v0.4.0` — the standalone app is the primary, working surface: shell +
server, setup wizard, contact CRUD, search, interaction logging, a real
two-way Google Contacts sync, and a "who's gone cold" follow-up view all
work end to end. The MCP server's tool bodies are wired to that same real
logic, and a plain CLI (`rolodex <command>`) wraps the same handlers for
non-MCP tooling. The app also packages as a real installable Electron
desktop app for macOS/Windows/Linux (unsigned for now), with a
tag-triggered CI workflow publishing releases. See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full architecture
and the list of remaining gaps (enrichment-on-add as a built-in feature,
code signing/notarization, an auto-updater).

A future Pantheon plugin tie-in exists only as a dormant, unwired stub —
see [`docs/PANTHEON.md`](docs/PANTHEON.md). Rolodex has zero Pantheon
dependency today and always will be usable standalone.

<!-- shared:support -->
## Support this project

Free and open source, always. A few ways to help — or just say hi:

- **Use it, star it, file an issue.** Honestly the best support an open-source project can get. → [this project](https://github.com/mdostal/rolodex)
- **Hire me.** I do fractional-CTO and consulting work — fixing and scaling tech stacks. → [mdostal.com/contact](https://mdostal.com/contact)
- **[Buy me a coffee](https://www.buymeacoffee.com/mdostal)** if it saved you time.
- **More tools like this** → [tools.mdostal.com](https://tools.mdostal.com)
- **Life outside the terminal** → [life.mdostal.com](https://life.mdostal.com)
- **What we're building at Firefly Events** — event discovery, 8,000+ events/day from 7+ sources → [ff.events](https://ff.events)

Always up for a conversation if any of it's useful to you.
<!-- /shared:support -->
## License
MIT © 2026 Mathew Dostal
