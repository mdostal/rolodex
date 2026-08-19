# Design Discussion: UI Visual Cleanup (Full UI Buildup Pass)

## Goal

The broader "full styling and cleanup" pass: align the two shell HTML
files' divergent CSS token sets, eliminate hardcoded colors that should be
tokens, and normalize `aria-label`/focus-management coverage across the
app. Concrete and bounded to real findings from a full-file inventory —
not a speculative redesign.

This is the second of two paired epics. It depends on `ui-feedback-states`
landing first — that epic unifies `.status-line`/`.sync-status`/
`.autosave-status` into one CSS component; this epic's token-alignment
work builds on that unified shape instead of duplicating it. Don't start
this epic's stories until `ui-feedback-states` is merged.

## Current state (real findings from a full-file inventory of
`src/shell/index.html` and `src/shell/wizard.html` — not assumptions)

**The two shell files maintain separate, divergent token sets.** There is
no shared CSS file between them (each is a self-contained static HTML
document with its own inline `<style>` — introducing a build step /
external stylesheet purely to deduplicate ~12 CSS custom properties is a
real architectural change, and out of scope here; see Decision 1 below for
what "alignment" means without one).
`index.html`'s `:root` defines 12 tokens: `--border`, `--muted`, `--bg`,
`--fg`, `--accent`, `--accent-bg`, `--danger`, `--ok-bg`, `--ok-fg`,
`--row-hover`, `--chip-bg`, `--accent-fg`. `wizard.html`'s `:root` defines
11: `--border`, `--muted`, `--bg`, `--fg`, `--accent`, `--accent-bg`,
`--danger`, `--danger-bg`, `--ok-bg`, `--ok-fg`, `--card-bg`. Six tokens
are shared by name; each file has tokens the other lacks
(`--danger-bg`/`--card-bg` only in wizard; `--row-hover`/`--chip-bg`/
`--accent-fg` only in index), and even the shared ones aren't guaranteed
to carry identical values since each file hand-maintains its own copy.

**A handful of hardcoded values sit outside the token system, some of them
literally duplicating what a token in the *other* file would already
name**: `#c9c9d1` (the disabled-button color) is hardcoded identically in
both `index.html:112` and `wizard.html:192` instead of a shared
`--disabled` token either file could define. `#fdecea` (an error-banner
background) is hardcoded twice in `index.html` (`.not-found-banner:317`,
`.form-error-banner:357`) even though `wizard.html` already has a
`--danger-bg` token naming exactly this color — index.html just doesn't
have that token yet. The brass theme's `--accent-bg` values are inline
`rgba()` literals (`index.html:46`, `58`) rather than following the same
custom-property pattern as everything else in that block.

**`wizard.html` has no brass-theme support at all** — `data-theme` is
never injected there, by construction (the wizard runs during first-run
setup, before Appearance is even a configurable option — there's no
settings row yet to read a theme preference from).

**Accessibility/consistency gaps**, all confirmed by reading the actual
markup: `aria-label` coverage is inconsistent (`settings-toggle` and
`search-clear` have one; `sync-now`/`push-google`/`followup-toggle`/
`db-change-toggle`/`db-reset` don't — though all of those have visible
text labels already, so this is a normalization question, not a missing-
label bug). Focus management after an action is inconsistent: the verdict
picker explicitly refocuses its chosen option, the log-interaction form
explicitly manages focus on open/close and refocuses the note field after
a successful submit — but Follow-up/Appearance/Database/Secrets-backend
saves move focus nowhere after completing.

## Design decisions (confirmed with owner)

Scope and sequencing (starts only after `ui-feedback-states` merges)
confirmed as proposed.

**1. "Alignment" means identical token names and values copy-pasted into
both files' `:root` blocks, not a shared stylesheet.** No build step is
being introduced for this. Add the missing tokens to whichever file lacks
them (`--danger-bg`/`--card-bg` into `index.html`; `--row-hover`/
`--chip-bg`/`--accent-fg` into `wizard.html` if wizard.html actually needs
them — audit before adding unused tokens) so both files define the same
superset, then replace the hardcoded duplicates (`#c9c9d1` → `--disabled`,
`#fdecea` → `--danger-bg`, brass `rgba()` literals → named tokens) with
references to it.

**2. `wizard.html` stays theme-neutral — brass support is explicitly out
of scope.** The wizard runs before any theme preference can exist (no
settings row to read from yet); building brass support for a screen that
can never actually be shown in brass mode would be speculative, not a
real gap.

**3. `aria-label` normalization**: add labels only where a button's
purpose is genuinely ambiguous without one (icon-only controls — the
`⚙` gear, the search `×` clear) — already covered. Text-labeled buttons
(`Sync now`, `Push to Google`, etc.) are not missing anything; don't add
redundant `aria-label`s that just repeat visible text.

**4. Focus-management rule, applied consistently**: after an action that
keeps the user on the same view (a save that doesn't navigate away), leave
focus wherever the user's interaction put it — don't forcibly move it.
Only move focus explicitly when a disclosure opens/closes (matching the
log-interaction form's existing pattern) or when refocusing a
just-selected option matters for immediate re-selection (matching the
verdict picker's existing pattern). Follow-up/Appearance/Database/
Secrets-backend saves already match this rule as-is (they don't move
focus) — this decision documents the rule explicitly rather than changing
behavior, so future sections have a stated convention to follow instead of
re-deriving it each time.

## Risks

- **Token rename ripple.** Adding `--danger-bg` to `index.html` and
  swapping the two `#fdecea` literals touches shared, well-exercised CSS
  (contact-form and log-interaction error banners) — needs real visual
  verification (screenshot or live check), not just "the value is the
  same so it must look the same."
- **Scope discipline, again.** This is the "full UI buildup" epic — the
  vaguest-named of the two. Its scope here is deliberately the concrete
  list above, grounded in the actual research pass. If more gaps surface
  during implementation, they get their own follow-up story/epic rather
  than silently expanding this one.

## Stories

1. Add the missing tokens to each file (`--danger-bg`/`--card-bg` into
   index.html; audit wizard.html for the reverse before adding anything
   unused) so both files define the same named superset.
2. Replace hardcoded values with the new/existing tokens: `#c9c9d1` →
   `--disabled` (both files), `#fdecea` → `--danger-bg` (index.html), the
   brass `rgba()` accent-bg literals → named tokens.
3. `aria-label` normalization pass on icon-only/ambiguous controls
   site-wide (audit first, only add where genuinely needed).
4. Document and apply the focus-management rule (Decision 4) — confirm
   existing sections already comply, fix any that don't.
5. Real visual verification (screenshots/live check) that the token swaps
   didn't change how anything actually looks, tests, and docs update.
