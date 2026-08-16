---
name: rolodex
description: Use when the user asks you to look up, add, or update a contact in their personal/professional network, search their rolodex, find who they need to follow up with (who's gone cold), log an interaction (call/email/meeting/note), or sync from Google Contacts. Backed by rolodex's own local SQLite store via the rolodex-mcp server, not general knowledge or assumptions about who's in the user's network.
---

# rolodex

rolodex is the user's own local, single-user relationship/contacts manager
(SQLite-backed, with an optional one-way pull from Google Contacts). It is
not a hosted CRM — every install is one person's own data, on their own
machine. Repo: https://github.com/mdostal/rolodex

## When to use this

- "Who do I know at ...", "find my contact for ...", "what's the deal with
  [person]", "add so-and-so to my rolodex", "log that I talked to ...",
  "who do I need to follow up with / who have I gone cold on", "sync my
  Google contacts"

Don't use this for: general networking advice, or drafting the actual
outreach message (write that yourself — just source the facts about the
person from rolodex first). This is also not a general-purpose CRM; it's
one person's private rolodex.

## How to get real answers: use the rolodex-mcp server

If the MCP server isn't connected yet, see the "MCP server" section of
this repo's `README.md` for how to add it to an agent host. Once
connected, use these tools — never guess at a contact's info or fabricate
a match; if you don't have real data, say so:

- **`rolodex_upsert`** — add or update a contact. Only pass fields the
  user actually told you; never invent a role, org, or email they didn't
  give you. If you're not sure whether this is a new contact or an edit
  to an existing one, run `rolodex_search` first — don't guess.
- **`rolodex_search`** — full-text search by name/org/what-they-do/
  angle/tags. Always search before upserting a contact you're not certain
  is new; a silent duplicate is worse than a moment spent confirming.
- **`rolodex_followups`** — contacts with a next step set that have gone
  cold (no recent interaction, past the user's configured follow-up
  window). This is the tool for "who should I reach out to."
- **`rolodex_log_interaction`** — log a real touch (call/email/dm/
  meeting/note) against a contact. Only log something the user actually
  describes as having happened — not something merely planned or
  discussed.
- **`rolodex_sync_google`** — one-way pull from the user's Google
  Contacts into rolodex. `direction: "push"` is not implemented. If asked
  for two-way sync or to push local edits back to Google, say plainly
  that isn't supported yet — don't imply it happened.

## Deep-diving/pre-filling a contact from a web search

The user may hand you very little on purpose — e.g. "I had a work call,
liked Ezra Cohen, [company]" — and expect you to go research the rest
before filing it, not just log the bare mention. That's fine: use your own
web-search tool to look the person/company up. This is enrichment, not
fabrication, as long as it's grounded in a real search — the line to hold
is what happens with what you find:

1. Search first, `rolodex_search` too (don't duplicate an existing
   contact).
2. Propose what you found back to the user before writing it —
   role/org/what-they-do/angle from a web search are *candidates*, not
   facts to silently commit. A one-line "found: VP Eng at Acme, previously
   at Foo — want me to add that?" is enough; don't demand a full review
   cycle for something low-stakes.
3. Only `rolodex_upsert` after that confirmation (or immediately, if the
   user's framing already implied "go ahead and fill it in" — use
   judgment, don't manufacture friction for its own sake).
4. `verdict` is never set from a search — that's the user's own read on the
   relationship, stated or implied by them ("liked Ezra Cohen" → verdict
   candidate `strong`, from what *they* said, not from anything found
   online).
5. Keep what came from the user and what came from search distinguishable
   in how you talk about it back to them, even though the stored record
   itself doesn't tag provenance per-field.

## Non-negotiable

- Never fabricate a contact, an id, or a field value. A `rolodex_search`
  with no results means no results — say so, don't invent a
  plausible-sounding match.
- `verdict`, `angle`, and `nextStep` are the user's own judgment calls
  about a relationship. Never overwrite them with a guess, and never
  assume a sync will "clean them up" — a sync is designed to always
  preserve them, exactly as they are.
- `verdict` is a fixed enum (`strong` / `watch` / `referral-only` /
  `pass` / `none`) — don't invent other values.
- Search before creating. Avoid silently duplicating someone already in
  the rolodex.
- This is the user's private data about real people. Only surface what's
  relevant to what was actually asked.
