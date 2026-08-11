# rolodex — Wireframe Design Brief

**Screens:** Contact List (empty + populated) · Contact Detail · Add/Edit Contact Form
**Format:** Text-based layout spec + ASCII mockups (Frame0 CLI unavailable in this environment — using the documented fallback)
**Context sources:** `.pHive/CONTEXT.md`, `structured-outline.md` Part 2 Phases 1–2, `src/lib/types.ts`
**Shell assumption:** Electron/local-server-style desktop window, resizable, default ~1200×800, min-width ~960px. No brand system exists yet — this brief uses neutral, functional desktop-app conventions (system font stack, generous whitespace, no color values prescribed beyond semantic roles) so a future `brand-system.yaml` can skin it without layout rework.

---

## 0. Information architecture — why these three screens, this shape

This is a flat, single-purpose app right now (Phases 1–2: no wizard, no settings, no login — those arrive later per the outline). A left nav rail would be premature IA for one section, so the shell is a simple **top bar + content area**, not a sidebar app. When Phase 4 (wizard) and a future settings screen land, a rail can be added additively without restructuring these three screens.

A load-bearing data-model distinction drives the Detail screen's layout: `store.ts` gives `setVerdict` and `setNextStep` their own mutation methods, separate from `upsert`. That's not incidental — it means **verdict and next-step are meant to be edited in place, autosaving, directly on the Detail screen**, while every other field (`name/org/role/email/phone/met/what/angle/tags`) only changes through the Add/Edit form. The wireframe encodes this as two visually distinct zones on Detail: a read-only profile side and a live "working fields" side.

---

## 1. Screen: Contact List

### Layout description
Top bar (fixed, 56px): app mark + name (left), primary action `+ Add contact` (right, always visible — the one global write action). Below it, a page header: title "Contacts," a live count driven by `Store.list().length` (never a hardcoded string — matches Phase 1's explicit "not a fixture" requirement), and a search field (right-aligned, wired in Phase 6 — see `search-and-logging` topic). Below that, either the empty state or the row table, filling remaining height, internally scrollable.

### Components & positioning rationale
| Component | Position | Rationale |
|---|---|---|
| `+ Add contact` button | Top-right, persistent | Primary action stays reachable regardless of scroll/state; top-right is the desktop-app convention. |
| Contact count | Directly under page title | Ties the number to its source (Store.list()) visually; also the fastest sanity-check surface during Phase 1 dev/QA. |
| Row: Name / Org / Verdict / Next-step snippet | 4-column table, full-width rows | Exactly the four fields specified — no extra columns. Verdict uses icon+word (not color alone). Next-step is truncated with ellipsis at ~40 chars; full text lives on Detail. |
| Empty-state block | Vertically + horizontally centered in content area | Empty states should never look like a loading/broken screen — center it, give it a clear single CTA that mirrors the top-bar action. |

### Interaction notes
- **Row → Detail:** entire row is the click target — cursor pointer on hover, subtle hover background. Minimum row height 40px.
- **Keyboard:** rows individually focusable, visible focus ring, `Enter`/`Space` navigates to Detail.
- **Add button → Add/Edit form** (blank). Cancel returns to List unchanged; Save inserts via `upsert()` and navigates to the new contact's **Detail** screen.
- **Empty → populated transition:** count and rows update from the same `Store.list()` call — no separate "refresh" affordance needed.

### Accessibility notes
- Row table uses semantic markup (`<table>`/`role="table"` with `<th scope="col">`, or `role="grid"` for arrow-key nav) — never a div soup.
- Verdict is encoded with an icon **and** a text label (`● Strong`, `○ Watch`, etc.) — color is never the only signal (WCAG 1.4.1).
- Contact count region is `aria-live="polite"` so screen-reader users hear the count change after an add.
- Search input has a visible `<label>` (may be visually hidden via `.sr-only`).
- Empty-state icon is decorative (`aria-hidden="true"`); the heading "No contacts yet" carries the semantic content.

---

## 2. Screen: Contact Detail

### Layout description
Top bar: `← Back to contacts` (left), `Edit` button (right, opens the Add/Edit form pre-filled). Below it, an identity header — name (large), then `role · org` as a single subordinate line. Below the header, a **two-column split**:
- **Left column — profile (read-only here):** Contact Info (email/phone/met), About (what/angle), Tags. Edited only via the Add/Edit form.
- **Right column — working fields (live/editable here):** Verdict picker, Next-step field, and a reserved Interactions area for the `search-and-logging` topic.

### Components & positioning rationale
| Component | Position | Rationale |
|---|---|---|
| Edit button | Top-right, opposite Back | Standard desktop "escape hatch left, commit/act right" convention. |
| Two-column split (profile vs. working fields) | Left = static, right = live | Mirrors the actual data-layer split (`upsert` vs. `setVerdict`/`setNextStep`) — reduces the cognitive load of "can I just click this field?" |
| Verdict picker | Top of right column | Highest-value single field in the whole model — drives the rolodex's purpose. |
| Next-step field | Directly below verdict | Verdict and next-step are the two fields `store.ts` gives dedicated setters. |
| Interactions (reserved) | Bottom of right column, visibly present but disabled/empty | Not in saf-01/saf-02's build scope — the layout reserves its slot now so the `search-and-logging` topic doesn't require a redesign. |
| Tags | Bottom of left column | Lowest-priority scannable info; pill/chip treatment. |

### Interaction notes
- **Verdict picker** is a segmented control (5 options, one always selected — `verdict` is non-optional, default `"none"`). Selecting a new option calls `setVerdict()` immediately — no separate Save/Cancel. Brief non-blocking confirmation (1–2s highlight/toast) so the autosave is perceptible.
- **Next-step field** is an always-editable inline `<input>` — visible affordance at all times, `Enter`/blur commits via `setNextStep()`, `Escape` reverts.
- **Edit → Add/Edit form:** opens pre-filled with all upsert-owned fields. Verdict/next-step are not duplicated into the form's primary write path.
- **Not-found handling** (explicit outline requirement): if `Store.get()` returns `undefined`, redirect to List with an inline message: *"Contact not found — it may have been removed."* Never render a blank/broken Detail screen.

### Accessibility notes
- Heading hierarchy: contact name is `<h1>`, section labels are `<h2>`.
- Verdict segmented control uses `role="radiogroup"` with each option `role="radio"`; arrow keys move selection, `aria-checked` reflects state.
- Next-step input has a visible `<label>`, plus an `aria-live="polite"` status region announcing "Saved" after a successful `setNextStep()` call.
- Two-column layout collapses to a single stacked column below ~800px window width — never hide the working-fields column.
- Tags are also announced as a comma-separated list via `aria-label` on the container.

---

## 3. Screen: Add/Edit Contact Form

### Layout description
Top bar: `Cancel` (left, always returns without writing), screen title reflecting mode ("Add contact" / "Edit contact"), `Save` (right — mirrored at the bottom as a sticky footer button). Body is a single scrollable column, grouped into four labeled sections: Identity → Contact Info → Context → Classification → Next Step.

### Components & positioning rationale
| Component | Position | Rationale |
|---|---|---|
| Name field | First, marked required (`*`) | Only required field in the `Contact` type. |
| Org / Role | Directly under Name | Together with Name, how a person is identified at a glance elsewhere. |
| Email / Phone | Own section, second | Contact-mechanics, separate from identity. |
| Met / What / Angle | "Context" section, textareas for What/Angle | These are the local-only, sync-protected fields — multi-line inputs signal "write a sentence or two." |
| Verdict + Tags | "Classification" section | Both are how the user categorizes/filters this contact later. |
| Next step | Own section, last, right above Save | Deliberately the last field filled in — its value is often decided only after writing the angle above it. |
| Cancel / Save (top + bottom) | Top persistent, bottom sticky-footer duplicate | Long-form desktop pattern; commit action always reachable. |

### Interaction notes
- **Validation:** only `name` is required. Submitting blank keeps focus on Name, inline error, does not clear other fields.
- **Tags input:** chip/token pattern — `Enter`/`,` commits a chip; `Backspace` on empty input removes last chip; chips have an explicit `✕` remove control.
- **Verdict in this form:** included (radio group, defaults to current value or `"none"`) so a first-time add doesn't force a second trip to Detail. This is the *only* other place besides Detail's live picker where verdict can change (see Open Items).
- **Save:** calls `Store.upsert()`. Add → navigate to new contact's Detail. Edit → navigate back to Detail. Failure → stay on form, non-blocking error banner, preserve entered values.
- **Cancel / dirty-state:** if changes were made, confirm ("Discard changes?") rather than silently dropping edits.

### Accessibility notes
- Every field has a real `<label for>` association — placeholders are hint text only.
- Required field (`Name`) has `aria-required="true"`, not just a visual `*`.
- Section headings are real `<h2>`/`<legend>` elements.
- Tag chip removal targets are independently focusable and labeled ("Remove tag: investor").
- Tab order follows reading order; `Cmd/Ctrl+S`/`Esc` accelerators are additive, never the only path.
- Color is never the sole error indicator — invalid fields get a border change *and* inline text *and* an icon.

---

## 4. Cross-screen navigation & state flow

- **List → Detail:** row click, one hop.
- **Detail → Form:** only via explicit `Edit`.
- **Form → Detail (Save) / List (Cancel from Add) / Detail (Cancel from Edit):** Cancel always returns to where the user came from.
- **Verdict/next-step edits never leave Detail** — the one place state changes without a screen transition, hence the dedicated autosave-confirmation affordance.

---

## 5. Global notes

### Accessibility summary (applies across all three screens)
- **Keyboard:** every interactive element reachable via Tab in visual order, visible focus indicator (2px outline minimum).
- **Contrast:** body text/labels meet WCAG AA 4.5:1; verdict badges pair icon + text.
- **Semantic structure:** real headings, real `<label>`/`<fieldset>`/`<legend>`, real `<table>` semantics — no div-only layouts.
- **Live regions:** count updates and autosave confirmations use `aria-live="polite"`.
- **Desktop tap targets:** rows ≥40px tall, buttons ~32–36px min height.

### Open items / forward-compat notes (not blocking, flagged for story-writing)
1. **Verdict editable in two places** (Detail's live picker and the Add/Edit form) is a deliberate small redundancy — first-add convenience vs. single-source-of-truth purity. If confusing in practice, drop verdict from the Add/Edit form.
2. **Search box** (List) and **Log interaction** (Detail) are visually reserved in this brief but functionally belong to the `search-and-logging` topic — laid out now so their eventual wiring doesn't force a relayout.
3. **Tags autocomplete** isn't specified here — worth a fast-follow once there's real tag data.

---

**Files referenced (no files written by this brief):**
- `src/lib/types.ts` — Contact/Interaction/Verdict shapes
- `.pHive/CONTEXT.md` — terminology
- `.pHive/epics/standalone-app-foundation/docs/structured-outline.md` — Phase 1/2

**Linked stories:** saf-01-shell-store-bridge (empty-state List), saf-02-core-crud (populated List, Detail, Add/Edit Form)
