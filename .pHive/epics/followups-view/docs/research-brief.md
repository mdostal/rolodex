# Research Brief: followups-view

## Summary

`Store.needsFollowUp()` has been a stub since the project's original scaffold and was never picked up by any of the 7 stories in `standalone-app-foundation` — it's explicitly listed as a Deferred Item in that epic's `vertical-plan.md` §4. This is the last unimplemented piece of the original `Store` interface, and it's a direct hit on the north star's stated pain point ("poor personal follow-up discipline — losing track of who to reach back out to and when"). This brief grounds a small, focused epic to implement it and surface it in the UI.

## Key files & surfaces

- `src/lib/store.ts:194` — `needsFollowUp(_withinDays = 30): Contact[] { throw new Error("not implemented"); }`. Docstring context above the method (from the original scaffold's intent, preserved in `docs/ARCHITECTURE.md`'s prior history): "Contacts with a nextStep set and no recent interaction — 'don't let them go cold'."
- `src/lib/store.ts:231` — `listInteractions(contactId): Interaction[]`, already implemented (ordered `at DESC`), the natural building block for "most recent interaction per contact."
- `src/lib/store.ts:20-27` — schema: `contacts.nextStep` (nullable TEXT), `interactions.at` (TEXT, ISO date), `interactions.contactId` (FK to `contacts.id`, cascade delete).
- `src/shell/index.html` — 1161 lines, hash-routed single-file app (`#/`, `#/new`, `#/contact/:id`, `#/contact/:id/edit`). No sidebar/nav menu — flat topbar (app name, `+ Add contact`, search box, `Sync now`) per the original design brief's stated IA (`"flat, single-purpose app... top bar + content area, not a sidebar app"`, `.pHive/design/contact-list-and-detail/brief.md` §0).
- `src/shell/server.ts` — 517 lines, plain `http.createServer`, manual path-segment routing, JSON body helpers, `MalformedJsonError`/validation patterns already established (from the `api-hardening-followups` fix).

## Patterns & conventions

- **Store owns all SQL**; no other module writes raw SQL. `needsFollowUp()` must be implemented as a real prepared-statement query, following `list()`/`search()`'s style (plain `SELECT`, mapped via `rowToContact`).
- **API route style**: `server.ts` uses manual path-segment parsing (`parts.length === N && parts[k] === "..."`), a shared `sendJson`/`readJsonBody` pair, and `MalformedJsonError` → 400 handling already in place — a new `GET /api/contacts/needs-follow-up` (or similar) route should match this exactly, not introduce a new pattern.
- **UI style**: flat hash-routed views, vanilla JS, inline `<style>` block, no framework. Existing verdict-badge pattern (icon + text, e.g. `● Strong`) is the established way to encode state visually without relying on color alone — a "needs follow-up" surface should reuse this vocabulary, not invent a new one.
- **No sidebar/nav today.** The only entry points into different views are the topbar buttons/links and row clicks. A new "Follow-ups" surface needs its own entry point decision (open question, see below) — the app has no established pattern for a second top-level view yet (this would be the first).

## Constraints

- `needsFollowUp(withinDays = 30)` takes a day-window parameter already in its (unimplemented) signature — the real implementation should honor it, not hardcode 30.
- A contact only "needs follow-up" if it actually has a `nextStep` set (per the docstring) — a contact with no next step isn't something to chase, it's just an unclassified contact.
- "No recent interaction" needs a definition for contacts with **zero** logged interactions ever — are they immediately "needs follow-up" (never touched), or excluded (nothing to compare against)? This is a real open question, not obvious from the stub signature alone.
- Must stay consistent with `verdict`/`nextStep` being local-only, sync-protected fields (`docs/ARCHITECTURE.md`) — follow-up logic reads local data only, no interaction with Google sync.

## Risks

- **Low** — this is almost entirely additive: one new `Store` method (real SQL, no schema change), one new API route (matches an established pattern), and either a new view or a filter on the existing list view. No existing behavior needs to change.
- **Medium** — the "first second-level nav surface" question (open question below) is a small but real IA decision that shapes the whole feature's shape; getting it wrong costs a UI rework, not a backend rework.

## Open questions

1. **Entry point**: does "Follow-ups" get its own hash route (`#/followups`) with a topbar link/button (the app's first second-level nav surface), or is it a filter/tab on the existing list view (e.g., a "Needs follow-up" toggle next to the search box)? The existing IA is deliberately flat (single list + detail + form) — adding a fully separate view is the bigger structural change.
2. **Zero-interaction contacts**: does a contact with a `nextStep` set but zero logged interactions count as "needs follow-up" immediately, or does it need at least one interaction to have a baseline to compare against?
3. **Definition of "recent"**: `withinDays` default is 30 in the existing stub signature — confirm this default (or change it) and whether the UI ever lets the user adjust it, or it's a fixed backend default for v1.

## Inconsistency risk signals

**present** — for the grill pass to focus on:

- The existing stub signature `needsFollowUp(_withinDays = 30)` already commits to a specific parameter shape (a day-window number) that the design should honor rather than redesign, unless there's a good reason to change it — a plan that silently drops or renames this parameter would be inconsistent with the established interface.
- No second-level nav pattern exists anywhere in the app today — whatever this epic decides for the "Follow-ups" entry point becomes the *first* precedent for that pattern; the design should be explicit that it's setting precedent, not just solving this one case.
