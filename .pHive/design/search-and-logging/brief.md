# Rolodex — Search & Interaction Logging: Wireframe Design Brief

**Tool discovery note:** Frame0 CLI not available. Text-based layout spec with ASCII mockups per the documented fallback.

Grounded against `.pHive/CONTEXT.md` and `structured-outline.md` Phase 6 (`src/lib/types.ts` `Contact`/`Interaction`, `Store.search()`, `Store.logInteraction()`). Scope is additive only — the existing list/detail screens and fields (from the `contact-list-and-detail` topic) are treated as fixed.

---

## 1. Search box — contact list screen

**Layout**
- Directly below the screen header, above the contact list, full content width.
- Single-line text input, leading search icon, placeholder `Search name, org, notes, tags…`, trailing clear (×) button (renders only once populated).
- One-line result-count string (`Showing 12 of 47 contacts for "…"`) between search box and list, omitted when query is empty.

**Components**
- `SearchInput` — text field + leading icon + clear button
- `ResultSummary` — text row, conditional
- `EmptyResultsState` — centered message + icon, replaces list body on zero matches
- Existing `ContactListRow` — unchanged, fed filtered data

**Interaction notes**
- Search-as-you-type, debounced ~250ms after last keystroke — not submit-on-Enter-only (this is a personal recall tool; instant scanning matters more than formal query submission). Enter still triggers an immediate search; Escape clears and refocuses.
- Maps directly to `Store.search(query, opts)` — full text across name/org/what/angle/tags per the FTS5 schema. `opts.verdict` filter exists in the store but is not exposed in this UI scope — flag as a follow-up if wanted.
- Clearing the query restores the unfiltered list.
- No loading spinner for typical local-SQLite latency (sub-50ms expected); only show a subtle affordance if a search exceeds ~300ms.
- Query string resets on navigating away from and back to the list (not persisted).

**Empty / edge states**
- No contacts in the DB at all: search box still renders (discoverable) but the list's "0 contacts" empty state takes precedence.
- Query matches nothing: `EmptyResultsState` as mocked, search box stays populated so the user can adjust rather than being dumped to blank.
- Whitespace-only query: treat as empty, don't hit the store.

**Accessibility**
- `<input type="search">` with a visible `<label>` or `aria-label="Search contacts"`.
- Result count is `aria-live="polite"`.
- Clear button is a real button, `aria-label="Clear search"`, ≥32×32px hit target.
- `/` to focus search is a nice-to-have, not required this scope.

---

## 2. Log-interaction action + history — contact detail screen

**Layout**
- New section below the existing contact-field block, separated by a rule.
- Header `Interactions` (with live count once history exists, e.g. `Interactions (3)`) + `+ Log interaction` button right-aligned — a disclosure trigger, not a page navigation or modal (logging is a quick, frequent core-loop action; inline avoids a context switch).
- Expanding the form pushes the history list down (no overlay/scrim) — form renders directly above the history list it's about to prepend to.
- History reverse-chronological (newest first): channel icon + label, date, note text. Initially 5 most recent; `Show N more` link (not pagination) reveals the rest in place.

**Components**
- `LogInteractionButton` — disclosure trigger, label swaps to `Cancel` when expanded
- `LogInteractionForm`:
  - `ChannelPicker` — segmented control/radio group, 5 options (`call`/`email`/`dm`/`meeting`/`other`) matching `Interaction.channel` exactly, icon + text label each
  - `DateField` — defaults to today, editable (for backfilling)
  - `NoteField` — multi-line textarea, required
  - `Save`/`Cancel` buttons
- `InteractionHistoryList` → `InteractionRow` → `ChannelBadge`
- `EmptyHistoryState` — centered message, zero-interactions case
- `ShowMoreLink` — only renders when >5 rows exist

**Interaction notes**
- **Submit-based, not autosave.** Logging is a discrete, meaningful record (feeds `needsFollowUp` later) — autosaving partial notes on blur risks half-written junk entries.
- Maps to `Store.logInteraction({ contactId, at, note, channel })`.
- **Validation:** `note` required (non-empty after trim), inline error + focus on submit-empty. `at` defaults to today, future dates allowed (useful for pre-logging a scheduled call — no downstream invariant broken). `channel` defaults to `other` pre-selected (optimizes for the "log this in 5 seconds" case — flagged as a design call the owner could reverse to force-no-default if preferred).
- **On successful save:** form clears and **stays open** (supports logging two things back-to-back); new row appears at the top of the history list (optimistic UI, local SQLite, no network round-trip).
- **Cancel** discards in-progress content, collapses the section. No confirmation dialog needed at this scope (short note field).
- Focus management: expanding moves focus to the first form control; collapsing returns focus to the `+ Log interaction` button.

**Empty / edge states**
- Zero interactions ever: `EmptyHistoryState` ("No interactions logged yet. Record your first touchpoint above.") instead of a blank section.
- Exactly one interaction: no `Show more` link, header reads `Interactions (1)`.
- Save fails: inline error banner above the form, form contents preserved (nothing typed is lost).

**Accessibility**
- `ChannelPicker` is a real `<fieldset>`/`<legend>` with radio inputs — icon + visible text together, never icon-only or color-only.
- Form fields have real `<label>` elements, not placeholder-as-label.
- Validation error wired via `aria-describedby` + `aria-invalid`.
- `+ Log interaction`/`Cancel` toggle has `aria-expanded`; form container has an accessible name via `aria-labelledby`.
- History rows: `ChannelBadge` pairs icon + visible text.
- Interactive targets ≥32×32px with adequate spacing (desktop context, not the 44px mobile minimum).
- Keyboard: Tab order Channel → Date → Note → Cancel → Save; Enter inside single-line controls doesn't prematurely submit; Enter inside the Note textarea inserts a newline, only the Save button (or Cmd/Ctrl+Enter) submits.

---

## 3. Cross-cutting notes

- Both additions reuse the existing screen chrome from the `contact-list-and-detail` topic — zero new color tokens or type-scale changes.
- Neither introduces a new route/screen — small, in-planning-scale change.
- Both map cleanly to Phase 6's store interfaces (`search()`, `logInteraction()`) — no new backend surface implied beyond what's already scoped.

**Linked story:** saf-06-search-logging
