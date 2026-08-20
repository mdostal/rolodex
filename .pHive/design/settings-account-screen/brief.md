# Design Brief: Settings/Account Screen

## Surface

A new `#/settings` screen in the existing shell router (`src/shell/index.html`),
replacing the gear-icon popover entirely. Single column, six section cards,
max-width ~720px, using the app's real CSS custom properties
(`--bg`/`--fg`/`--border`/`--accent`/`--muted`/`--chip-bg`/etc.) so it reads
as the same app, not a new visual language.

## Layout

- Topbar: `← Contacts` back-link (same style as the existing detail/form
  views' back link) + `rolodex` brand. No right-side actions.
- Page header: "Settings" title + one-line subtitle.
- Six section cards, each a bordered rounded box with a heading, an
  optional one-line description, and its controls:
  1. **Follow-up window** — two number inputs (window/grace days) + Save.
     Migrated as-is from the popover.
  2. **Appearance** — theme picker (Default/Brass) + icon thumbnail grid.
     Migrated as-is.
  3. **Launch at login** — toggle row with label/sub-label. Migrated as-is.
  4. **Google account** — status chip (Signed in / Client configured, not
     signed in / Not configured — new three-state check) + Reconnect
     button. Status computation is new; the button is migrated.
  5. **Database location** *(new)* — monospace current-path chip, "Change…"
     and "Reset to default" buttons, and a persistent "Applies next
     launch — restart rolodex to switch" note once a change succeeds.
  6. **Secrets backend** *(new)* — Keychain/Portunus picker (only rendered
     when Portunus is actually available, same as the wizard), same
     "restart to apply" note.

## Interactions

- Gear button (topbar, list view) navigates to `#/settings` instead of
  toggling a popover — instant client-side nav via the existing router,
  no server round trip.
- Every section's save/change action calls the same GET/PUT/POST routes
  the popover or wizard already use — no new persistence model, this is a
  UI relocation plus two screens' worth of previously-wizard-only routes
  getting a second caller.
- Database/secrets-backend sections never claim to apply live — the
  "restart to apply" note is not a toast that disappears, it stays visible
  once shown so a user who navigates away and back still sees it.

## Accessibility notes

- Toggle switch needs a real `role="switch"`/`aria-checked` (the wireframe's
  visual-only `.switch` div is illustrative, not the real markup).
- Theme/backend picker "chip" options need real radio-group semantics
  (`role="radiogroup"`, each option `role="radio"` + `aria-checked`), not
  just click handlers on divs.
- Back link needs a real destination (`navigate("#/")`), same focus-visible
  outline the rest of the app already applies via `:focus-visible`.

## Open questions for review

1. Six sections on one scroll vs. a left-nav/tabs split (Google's own
   Settings pattern) — given rolodex is a small personal tool, one scroll
   was chosen over introducing sub-navigation. Confirm this reads as
   "enough," not "too long."
2. Should "Reset to default" (database) show a confirm dialog, matching
   the destructive-action pattern already used for delete/push? Leaning
   yes since it changes where the app looks for data, but it's not
   destructive to the data itself.
