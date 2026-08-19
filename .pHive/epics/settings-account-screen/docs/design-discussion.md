# Design Discussion: Settings/Account Screen

## Goal

Replace the scattered gear-icon popover (Follow-up window, Appearance,
Autostart, Google reconnect) with a real, dedicated Settings screen, and use
it to finally expose two config choices that today are wizard-only and
otherwise unreachable after first run: the database location and the
secrets backend (Keychain vs Portunus).

## Current state (read before designing)

- `src/shell/index.html` already has a real client-side router:
  `parseRoute()` maps `location.hash` to `{ view: "list" | "detail" | "form" }`,
  and `render()` dispatches to `renderList()` / `renderDetail()` /
  `renderForm()`, all sharing `setTopbar()` and the single `#content` mount
  point (`index.html:513-545`). There is no `settings` view today — settings
  live in a popover (`#settings-panel-wrap`, wired by `wireSettingsPanel()`
  at `index.html:994`) anchored under the gear button in the list view's
  topbar, rebuilt every time `renderList()` runs.
- The popover currently holds four sections, each backed by a real
  GET/PUT route: Follow-up window/grace period (`/api/settings/follow-up`),
  Appearance theme+icon (`/api/settings/appearance`), Autostart
  (`/api/settings/autostart`), and a "Reconnect Google" action
  (`POST /api/wizard/google/connect`, reused from the wizard).
- The five-screen first-run wizard (`src/shell/wizard.html`) additionally
  makes two choices that have **no** post-wizard UI at all today:
  database location (`GET/POST /api/wizard/database`,
  `POST /api/wizard/database/reset`) and secrets backend
  (`GET /api/wizard/secrets-backends`, `POST /api/wizard/secrets-backend-choice`).
  Both routes already exist and are fully implemented — they're just never
  called from anywhere except `wizard.html`.
- **Critical finding that shapes the whole DB-location design below:**
  `createRolodexServer()` resolves `secrets` once, synchronously, at server
  construction, and memoizes `store` in a closure variable the first time
  `getStore()` is called (`server.ts:202-231`) — never re-resolved for the
  life of the process. `POST /api/wizard/secrets-backend-choice`'s own code
  comment already says this in plain words: the choice "takes effect for
  real the next time the server process starts." The exact same is true of
  `POST /api/wizard/database` — it only ever writes a path *override*
  (`setDbPathOverride`), never touches an already-open `Store`. There is no
  live-migration problem to solve here: a location/backend change literally
  cannot take effect mid-process, by construction, regardless of what UI we
  build.
- `GET /api/wizard/summary` reports `googleConfigured` by checking only
  `GOOGLE_OAUTH_CLIENT_KEY` (client id/secret saved) — it does not check
  `GOOGLE_OAUTH_TOKEN_KEY` (whether sign-in actually happened). Today's
  popover doesn't surface connection status at all, just a bare "Reconnect
  Google" button, so this gap has never mattered until now.

## Design questions, answered

**1. Screen architecture: a real `#/settings` route, not a new served page.**
Add `{ view: "settings" }` to `parseRoute()` and a `renderSettings()`
alongside the existing three render functions, using the same
`setTopbar()`/`content.innerHTML` pattern. The gear button changes from
`aria-expanded` popover-toggle to `navigate("#/settings")` — same instant,
server-round-trip-free navigation the list/detail/form views already get
for free. A separate served HTML page (`wizard.html`'s pattern) was
considered and rejected: that pattern exists specifically because the
wizard runs *before* `index.html`'s app shell/router are meaningful
(pre-wizard-completion, no store, no contacts) — Settings runs entirely
post-wizard, inside the same shell, so reusing the router is strictly
simpler and keeps one app, one router, one topbar.

**2. Database location change after first run: no migration UI, because
there's nothing to migrate live.** Per the memoization finding above, a
location change literally can't affect the running process. So: Settings'
Database section reuses `GET/POST /api/wizard/database` and
`POST /api/wizard/database/reset` verbatim (identical request/response
shapes to `wizard.html`'s Database screen — writable-check gate included,
so a rejected candidate never clobbers a working override), and after a
successful `POST`, shows an explicit **"Applies next launch — restart
rolodex to switch"** notice instead of attempting (or implying) any live
reopen, copy, or migration. This is not a new behavior invented for
Settings — it's the exact same contract `wizard.html`'s Database screen
already has, just with the messaging made explicit instead of implicit
(the wizard gets away with silence here because the user immediately hits
"Complete" and the very next launch *is* effectively "now"; Settings can't
rely on that).

**3. Re-running the wizard: explicitly out of scope, not needed.** The
wizard makes exactly three ongoing choices: database location, secrets
backend, and Google client credentials. All three are now individually
reachable from Settings (database and secrets backend are net-new this
epic; Google reconnect already exists in the popover today). The wizard's
other two screens (Welcome, Complete) have no standing settings meaning —
replaying them adds ceremony, not capability. A "redo setup" entry point
would just be a worse, less-direct path to the same three sections
Settings already exposes directly. Not building it.

**4. Consolidation: migrate all four existing sections in, don't leave a
second settings surface behind.** Follow-up, Appearance, Autostart, and
Google reconnect all move from the popover into the new screen — the
popover and `wireSettingsPanel()` are retired entirely, not left as a
parallel "quick settings" surface (two places to change the same four
things is worse than one, and nothing about them needs quick-access-without-
navigating; the whole point of this epic is that Settings deserves a real
home). Database location and secrets backend are added as two genuinely new
sections. Google's section gains a real status line — "Signed in" /
"Client configured, not signed in yet" / "Not configured" — computed from
both `GOOGLE_OAUTH_CLIENT_KEY` and `GOOGLE_OAUTH_TOKEN_KEY`, not just the
client key `GET /api/wizard/summary` already checks (that route's
`googleConfigured` field undersells "configured but never signed in" as
identical to "not configured" — a real gap, small enough to fix inline
here rather than carry into a screen whose whole purpose is honest status
reporting).

## Decisions (confirmed with owner)

- New `#/settings` view in the existing router, one scroll of six section
  cards (no tabs/left-nav split) — approved as wireframed:
  https://claude.ai/code/artifact/1f96e8fc-3b07-4ae5-8ef4-ecb4a97cfbbb
- Popover and `wireSettingsPanel()` are deleted, not kept alongside the
  new screen.
- Database-location and secrets-backend changes reuse the wizard's exact
  existing routes; both show a "restart to apply" notice on success and
  never attempt a live store/secrets reopen.
- No "redo setup wizard" entry point — each of the wizard's ongoing
  choices is reachable directly from Settings instead.
- Google's status line is upgraded to distinguish "configured" from
  "signed in" (checks both stored keys, not just the client key).
- "Reset to default" on the Database section shows a `confirm()` dialog
  before applying, same pattern as the existing delete/push confirmations
  — changing where the app looks for data warrants the pause even though
  it doesn't touch data directly.

## Risks

- **Losing the "no navigation needed" popover convenience.** Mitigated by
  the fact that `#/settings` navigation is client-side and instant (same
  router that already makes list→detail→form feel like one page) — the
  cost is "one more click," not a server round trip or a real context
  switch.
- **Silent behavior-change risk while migrating four working sections.**
  The Follow-up/Appearance/Autostart fetch-and-render logic is
  well-tested today; this epic should *move* that logic to the new mount
  point rather than rewrite it, to avoid reintroducing bugs in code that
  already works.
- **"Restart to apply" being missed by the user** if the notice isn't
  prominent — both Database and Secrets-backend sections need the exact
  same wording/placement so the pattern is learned once, not per-section.

## Stories

1. `#/settings` route + `renderSettings()` scaffold; gear button navigates
   there; migrate the Follow-up section as the first proof the new screen
   works end to end. Popover trigger removed from the list view's topbar.
2. Migrate Appearance (theme + icon picker) into the new screen.
3. Migrate Autostart and Google reconnect into the new screen; add the
   real client-vs-signed-in status check.
4. Add the Database-location section (reuses `/api/wizard/database` +
   `/reset`), with the "restart to apply" notice.
5. Add the Secrets-backend section (reuses `/api/wizard/secrets-backends` +
   `/secrets-backend-choice`), with the same "restart to apply" notice.
6. Delete the retired popover code (`wireSettingsPanel()` and its CSS),
   tests for every migrated/new section and the route itself, and docs
   updates (README/ARCHITECTURE.md's "dedicated settings/account screen"
   remaining-gap line moves to done).
