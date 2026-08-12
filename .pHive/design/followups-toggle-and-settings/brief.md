# Design Brief: Follow-up Filter Toggle + Settings Panel

**Scope:** `fu-02-followup-ui` — additive to the existing list view in `src/shell/index.html`. Frame0 CLI unavailable, text-based fallback per wireframe-protocol.

**Visual language source:** read directly from `src/shell/index.html` — no invented components. Every element below maps to an existing CSS rule or interaction pattern already implemented in this file.

---

## 1. Layout description

**Header row (list view).** The existing `.header-actions` flex container currently holds `.search` → `#sync-now`. Insert the new toggle button between them: `.search` → `#followup-toggle` (NEW) → `#sync-now`. No layout restructuring — a third flex child with the same `gap: 10px` rhythm.

**Topbar.** Add the gear icon button to the left of `+ Add contact`, list view only. Order: `(⚙) [+ Add contact]` — utility action before primary action, matching how Cancel/Save already order (secondary-then-primary, left-to-right).

**Empty state (new, third variant).** Renders inside `#list-body`, same `.empty-state` class and 360px min-height flex-centered box as the two that exist. A third branch in the same decision tree, distinguished by which fetch produced the empty list.

**Settings panel.** Not a route, not a full-page overlay. A small absolutely-positioned popover anchored to the gear button — structurally identical to the existing `#log-interaction-form-wrap` disclosure pattern (empty when closed, populated with a form's innerHTML when open).

## 2. Component list + positioning rationale

| Component | Position | Maps to existing pattern |
|---|---|---|
| `#followup-toggle` | Header row, between search and Sync now | OFF = `button.secondary` (outline); ON = default `button` (filled/accent) — toggle by adding/removing the `secondary` class |
| Count in label | Inside the button's own text, not a separate badge | Always visible per design-discussion §3 step 5; keeping it in the button label (not a sibling badge) keeps one focusable, one accessible-name unit |
| Third empty state | `#list-body`, same slot as the other two | `.empty-state` class reused as-is (icon + h2 + p, no CTA) |
| `#settings-toggle` (gear) | `#topbar-right`, left of `+ Add contact`, list view only | New icon-only button, needs `aria-label` since there's no visible text |
| Settings panel | Absolutely positioned, anchored under-right of gear | Clones `wireInteractionsPanel()`'s open/close/focus logic; `.form-field` for inputs, `.form-actions` for Cancel/Save, `.form-error-banner` for failures |

## 3. Interaction notes

**Toggle click behavior.**
- OFF → click → filled/primary, `aria-pressed="true"`, re-fetches from `GET /api/contacts/needs-follow-up` (not client-side filtered — the client has no per-contact last-interaction data to filter with locally).
- ON → click → reverts to outline, `aria-pressed="false"`, re-fetches from the normal contacts endpoint.
- The count badge needs to be accurate even while OFF — fetch `needs-follow-up` once on list-view load (in parallel with the normal contacts fetch), use its length for the always-visible count, and reuse that data if the user then toggles ON (avoids a double-fetch on the common load-then-toggle path).

**Search + toggle composition.** Two independent, non-resetting filters:
- Toggle ON + search → intersection (needs-follow-up ∩ matches search). `runSearch()`'s notion of "current base list" becomes toggle-aware (`allContacts` vs. the needs-follow-up list) rather than hardcoded — this is the real data-flow change the story's risk section flags, not cosmetic.
- Toggling OFF while a search term is present → search stays active, scoped back to the full list. Neither control clears the other.

**Empty-state precedence (three-way branch).** Evaluated in this order: empty DB (truly zero contacts, beats everything) → toggle-ON-zero-results → search-zero-results. "The whole rolodex is empty" is more fundamental than "nothing needs follow-up right now" and should never be masked by it.

**Settings panel open/close/save/cancel.**
- Click gear → panel opens, focus moves to the first input, gear gets `aria-expanded="true"`.
- Click outside, Escape, or Cancel → closes without persisting, focus returns to gear (mirrors `closeForm()`'s existing `toggleBtn.focus()` behavior exactly).
- Save → `PUT /api/settings/follow-up` with `{ windowDays, graceDays }`; success closes the panel and returns focus to gear. Failure keeps the panel open with an inline error (reuse `.form-error-banner`), preserving the user's edits.
- **Recommendation beyond the bare acceptance criteria:** if the toggle is ON when settings are saved, immediately re-fetch `needs-follow-up` so the visible list/count reflect the new values right away rather than waiting for the next toggle click.
- Client-side validation: both fields positive integers (matches the server's 400-on-invalid rule) — inline field errors on bad input, same `.field-error` pattern as the contact form's required-field validation.

## 4. Accessibility notes

- Toggle is a real `<button>` with `aria-pressed` kept in sync — the standard toggle-button ARIA pattern. State isn't color-only: the unchanged, always-visible text label plus `aria-pressed` already satisfies this (consistent with the app's existing icon+text verdict-badge convention of never relying on color alone).
- Both the toggle and the gear button sit in normal tab order — no special keyboard handling needed.
- Gear button needs `aria-label="Follow-up settings"` (icon-only, no visible text) and `aria-expanded` reflecting panel state, matching the existing `#log-interaction-toggle` convention (`aria-expanded`, `aria-controls`).
- Panel focus management: first input on open, gear button on any close path — reuse `wireInteractionsPanel()`'s existing open/close focus contract rather than writing new logic.
- Number inputs get real, visible `<label for="...">` elements, not placeholder-only labels — consistent with every other labeled input in this file.
- Empty-state icon is `aria-hidden="true"` (decorative, matches the existing two empty states); heading + paragraph carry the meaning.
- Non-modal panel: outside-click + Escape to dismiss, no focus trap or backdrop — consistent with the rest of the app's disclosure UI (nothing else uses a modal/backdrop pattern; this is two number fields, not a case for a heavier interaction model).

## 5. Implementation cross-reference

No new CSS classes required beyond, at most, one for panel positioning (`position: absolute` anchor):
- Toggle fill/outline → toggle the `secondary` class on an existing `<button>`.
- Empty state → third branch reusing `.empty-state` CSS as-is.
- Settings panel → structurally clone `wireInteractionsPanel()`'s open/close/focus logic, `.log-interaction-form` CSS, `.form-field` CSS, `.form-error-banner` for failures.

**Linked story:** fu-02-followup-ui
