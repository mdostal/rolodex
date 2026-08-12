# Design Discussion: followups-view

## 0. Prelude

No prior KG decisions found for this topic (`kg_why` query returned zero exact matches — clean slate). North star pain point directly relevant: "poor personal follow-up discipline — losing track of who to reach back out to and when" (`.pHive/project-profile.yaml`).

## 1. What Are We Doing?

`Store.needsFollowUp()` has been an unimplemented stub since the original scaffold and is the last piece of the originally-designed `Store` interface nobody's touched — every other method (`list`, `upsert`, `get`, `setVerdict`, `setNextStep`, `search`, `logInteraction`) is real. This epic implements it for real and gives it a UI surface: a way to see "who's gone cold" — contacts with a next step set that haven't been touched recently. "Done" is: the query is correct and tested, and there's a real place in the UI to see the results, not just an API endpoint nobody calls.

## 2. What I Found

- `needsFollowUp(_withinDays = 30)`'s stub signature already commits to a day-window parameter — I'm keeping that shape, not redesigning it.
- `listInteractions(contactId)` is already implemented and ordered `at DESC` — the natural building block ("most recent interaction per contact"), but I'd rather write `needsFollowUp` as its own direct SQL query (a correlated subquery or `LEFT JOIN` against `MAX(interactions.at)` grouped by contact) than N+1 it through `listInteractions` per contact — that's the kind of thing that's fine at personal-rolodex scale either way, but a single query is barely more code and avoids setting a bad pattern.
- The app has **no second-level nav today** — everything is topbar buttons + row clicks into `#/contact/:id`. Whatever this epic does for a "Follow-ups" entry point is the first precedent for a second top-level view.
- Server routing (`server.ts`) and API validation patterns (`MalformedJsonError`, 400 handling) are already established and just need to be matched, not invented.

## 3. My Proposed Approach

1. **`Store.needsFollowUp(withinDays?, graceDays?): Contact[]`** — one real SQL query: contacts where `nextStep` is set (non-null, non-empty) AND `createdAt` is older than `graceDays` ago AND (no interaction exists OR the most recent interaction's `at` is older than `withinDays` days ago). Both parameters are now optional — when omitted, `Store` reads them from the new `settings` table (§9), falling back to the quorum defaults (30 / 14) if no setting row exists yet. Zero-interaction contacts count as needing follow-up once past the grace period — a contact with a next step and zero logged interactions has, by definition, gone longer without contact than any window, so excluding them would hide exactly the people most likely to be forgotten; the grace period (not exclusion) is what protects brand-new contacts from immediate noise. **Sort order — DECIDED (revised after grill H1):** never-touched contacts (no interaction row at all) always sort above every contact with a real last-interaction date, regardless of how old that date is — "I've genuinely never followed up" is more urgent than "it's been a while," so a `NULL`/no-interaction contact is treated as the oldest-possible value for ordering purposes, then real dates sort oldest-first beneath that.
2. **`GET /api/contacts/needs-follow-up?withinDays=N&graceDays=N`** — new route in `server.ts`, matching the existing manual-routing style; both query params optional, override the persisted settings (§9) for this call only when present (does not change the stored default). **Data flow — DECIDED:** toggling on re-fetches from this endpoint rather than filtering the already-fetched `allContacts` client-side — the client doesn't have per-contact last-interaction data cached (that lives server-side across the `interactions` table), so client-side filtering isn't actually possible without also fetching every contact's interaction history up front, which is more data movement, not less.
3. **Entry point (resolves open question #1): a filter toggle on the existing list view**, not a separate route/second-level nav. Something like a small "Needs follow-up (N)" pill/button next to the search box that, when active, swaps the list's data source from `Store.list()` to `Store.needsFollowUp()` and shows a count badge. I'm picking this over a separate `#/followups` route because: the app's IA is deliberately flat by design (per the original contact-list-and-detail brief), and this feature is fundamentally "the same list, differently filtered" rather than a distinct surface with its own fields/actions. **Precision on the "no new precedent" claim (revised after grill H2):** a filter toggle IS new UI on the list view — the only existing control there is the search box, a text input, not a toggle. What this choice actually avoids is a *second-level route* (a whole new nav surface); it doesn't avoid introducing a new control type. That's still the right tradeoff, just stated accurately. If this needs to grow into something richer later (e.g. a dashboard), that's a bigger, separate design decision — not something to back into here.
4. Each row in the filtered view shows the same 4 columns as today (name/org/verdict/next-step) — no new columns needed, since "why they're here" is just "next step + stale interaction," both already visible.
5. **Toggle specifics — resolved after team review (TPM + ui-designer):**
   - **Position:** the toggle sits between the search box and "Sync now" in the header row (search → follow-up toggle → sync).
   - **Visual states:** off = outline/ghost button (matches the existing `.btn` style already used elsewhere); on = filled/solid (matches the existing `.btn.primary` style) — reusing established button vocabulary, no new component.
   - **Count badge — DECIDED (resolves former open question #3):** always visible in the label, e.g. `Needs follow-up (3)`, regardless of on/off state — this surfaces the pain point proactively (you see the number without having to toggle), which serves the north star better than a badge that only appears once you've already found the thing it's telling you about.
   - **Search + toggle compose, not reset each other:** if the follow-up toggle is on and the user searches, results are filtered to the intersection (needs-follow-up AND matches search) — this matches how a user would expect two active filters to behave, rather than one silently clearing the other.
   - **Empty state when toggled on with zero matches:** a distinct message from the two empty states that already exist (no contacts at all; search with no matches) — something like "Nobody needs a follow-up right now." with a check/calm icon, not the existing "add your first contact" CTA (which would be wrong/confusing here — the rolodex isn't empty, nothing's just overdue).

## 4. What Could Go Wrong

- **Low** — SQL correctness: getting the "most recent interaction per contact" comparison right (correlated subquery vs. `LEFT JOIN` + `GROUP BY` vs. window function) needs care but isn't architecturally risky — `node:sqlite` supports all three approaches.
- **Medium (revised after tpm review — was understated as Low)** — the toggle isn't zero-friction wiring: `index.html`'s `renderList()` closes over a single fetched `allContacts`/`totalCount`, and `runSearch()` already branches across two existing states (empty-DB, empty-search-results). Adding a third axis (follow-up-filtered) means real changes to that data-flow, not just a new button — specifically: whether `allContacts` gets re-fetched per toggle (via the new `needsFollowUp()` endpoint) vs. filtered client-side from data already in memory, and adding the third empty-state (§3 step 5) alongside the two that exist. Sequencing this correctly in one story (not two half-finished ones) matters — see stories below.
- **Medium** — "days since last interaction" has an edge case worth being explicit about: a contact who was just added (has a `nextStep` but the record itself is brand new, seconds old) with zero interactions would immediately show as "needs follow-up" under the "zero-interaction contacts count" resolution above. That's arguably correct (nothing's happened yet, so nothing to compare against), but it means every freshly-added contact with a next step shows up immediately, which could feel noisy on a small rolodex. Flagging as an open question rather than deciding unilaterally.

## 5. Dependencies and Constraints

- No new external dependencies — this is pure `Store`/`server.ts`/`index.html` work using patterns already in the codebase.
- One schema addition (revised — was "no schema changes"): a new `settings` key-value table (§9). Additive only, `CREATE TABLE IF NOT EXISTS`, no change to any existing table.
- Must not touch Google-sync logic, verdict/tag handling, or any other already-shipped surface beyond adding the filter toggle to the list view's header and the new settings entry point (§9).

## 6. Open Questions — RESOLVED via configurable defaults (owner directive, post-gate)

Both former open questions (#1 grace period, #2 default window) are resolved the same way: **neither is hardcoded — both become real, user-editable settings**, with shipped defaults set by quorum rather than my own single guess. See §7 "Configuration" below for the mechanism and the defaults.

No remaining open questions block story decomposition.

## 7. Configuration (new, owner-directed)

The owner's directive: don't hardcode judgment calls like these — make them configurable, and set the shipped defaults from a quorum of differing opinions rather than one guess.

### Mechanism

- **New `settings` table** in `store.ts`'s `migrate()`: `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`. Plain key-value, matches the existing "Store owns all SQL" convention — no new storage layer, just one more table in the same SQLite file.
- **`Store.getSetting(key, fallback)` / `Store.setSetting(key, value)`** — small generic get/set pair, plus two typed convenience wrappers `getFollowUpConfig(): { windowDays: number; graceDays: number }` and `setFollowUpConfig({ windowDays, graceDays })` that `needsFollowUp()` and the new settings API route both use, so the fallback-to-default logic lives in exactly one place.
- **`GET /api/settings/follow-up`** / **`PUT /api/settings/follow-up`** — new routes in `server.ts`, matching the established manual-routing + `readJsonBody`/validation style (reject non-positive-integer values with 400, same pattern as the verdict-enum validation already in place).
- **Settings UI — a real config area, minimal by design.** A small gear/settings entry point in the topbar opens a lightweight panel (not a full page navigation — this doesn't need to be a whole new route given it's two number fields) showing "Follow-up window (days)" and "Grace period (days)" as editable number inputs, with Save/Cancel. **This is explicitly the first, narrow seed of the fuller settings screen already named as a Deferred Item in the original epic's `vertical-plan.md`** (which also wants Google reconnect and DB-location change) — not a competing pattern. Scoping it to just these two fields now, rather than building the full settings screen, keeps this epic Small.

### Defaults — set by quorum, not by me alone

Per the owner's directive, five differing-opinion personas each proposed values independently, with real, distinct rationale (sales-urgency, high-volume-networker, notification-fatigue-averse, relationship-gardener, and GTD-review-cadence perspectives). Medians, not my own pick:

| Persona | Window (days) | Grace (days) |
|---|---|---|
| The Closer (sales urgency, no such thing as too soon) | 7 | 0 |
| The Systems Person (GTD tri-weekly review cadence) | 21 | 3 |
| The Community Builder (relationship-gardener, monthly rhythm) | 30 | 21 |
| The Minimalist (notification-fatigue-averse, rare-but-meaningful) | 45 | 14 |
| The Connector (high-volume networker, quarterly rhythm) | 120 | 30 |
| **Quorum (median)** | **30** | **14** |

Shipped defaults: **`windowDays: 30`**, **`graceDays: 14`** — used to seed the `settings` table on first read if no row exists yet (not written eagerly at migration time, so a future default change doesn't silently overwrite a value nobody explicitly set... actually it does need an explicit seed row so `GET /api/settings/follow-up` has something concrete to show; seed lazily on first `getFollowUpConfig()` call if absent). Notably, the quorum window (30) matches the value already baked into the original stub signature (`needsFollowUp(_withinDays = 30)`) — continuity with the interface as originally scaffolded, not a coincidence worth over-reading, but a good sign the median lands somewhere reasonable.

## 8. Verification Strategy

```
VERIFICATION PLAN:
  Tools: vitest (unit tests for Store.needsFollowUp() — the query correctness
         is the part most worth locking in with tests: overdue contacts
         included, recently-touched contacts excluded, zero-interaction
         contacts included, contacts with no nextStep excluded, grace period
         respected, withinDays/graceDays parameters respected; plus
         getFollowUpConfig/setFollowUpConfig round-trip and lazy-seed-on-
         first-read behavior).
  Platforms: same as the rest of the app — local desktop, macOS primary.
  Automated: Store.needsFollowUp() unit tests; settings get/set unit tests;
         server route tests (needs-follow-up 200 + query-param overrides;
         settings GET/PUT 200 + 400 on invalid values).
  Manual: toggle the filter in a live browser session, confirm the list
         genuinely swaps and the count matches; open the settings panel,
         change both values, confirm they persist across a reload and
         actually change what needsFollowUp() returns.
  Not verifying: any new UI framework/pattern (there isn't one — settings
         panel and toggle both reuse existing button/form styling).
```

## 9. Scale Assessment

```
SCALE ASSESSMENT:
  Files affected: ~3 (src/lib/store.ts, src/shell/server.ts, src/shell/index.html)
    + 2 test files (store.test.ts extended, server.test.ts extended) — still
    the same three source files even with the settings addition, since this
    is a single-file shell app and settings piggyback on the existing
    get/set-pair + route-table conventions rather than introducing new files
  Subsystems: Store/Data (needsFollowUp + settings table/get/set), API (two
    new routes: needs-follow-up, settings/follow-up), Contact UI (filter
    toggle + filtered rendering path + a minimal settings panel)
  Migration required: no (additive settings table only)
  Cross-team coordination: no
  Unknowns: none blocking — both original open questions resolved via the
    configuration mechanism + quorum defaults (§7)

  RECOMMENDATION: Proceed to stories (Small)
  RATIONALE: Real work spread across the same three already-established
    files; the settings addition is one more table + a get/set pair,
    following an existing pattern, not a new subsystem. Team review (tpm)
    correctly flagged the list view's data-flow integration as more than
    trivial wiring — real, but still contained to one file's existing
    render/search logic. This stays Small: two careful, well-scoped stories
    (config + query logic; UI wiring), not H/V slicing or a structured
    outline.
```
