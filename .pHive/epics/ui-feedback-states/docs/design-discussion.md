# Design Discussion: Comprehensive Loading/Error/Toast UI States

## Goal

Fix the real, found gaps in how rolodex tells the user what's happening:
missing loading states, silently-swallowed failures, one native `alert()`
that doesn't match anything else in the app, and a genuine (if small) bug
where a "failed to save" message renders in the *success* color. Introduce
one shared toast component for transient events, replacing ad-hoc
per-section status lines and the bespoke cross-render bridging hack they
required.

This epic is the first of two paired epics — see `ui-visual-cleanup`
(planned alongside this one) for the broader styling/token/accessibility
pass. That epic is scoped to build *on* this one's unified `.status-line`
component rather than duplicate the work, so this epic ships first.

## Current state (real findings, not assumptions — full inventory read of
`src/shell/index.html` and `src/shell/wizard.html`)

**No shared toast/notification component exists.** Every transient message
today is a persistent inline element scoped to its own section:
`#sync-status` (Sync/Push results), `#follow-up-save-status`,
`#appearance-error`, `#db-status`/`#db-apply-note`,
`#secrets-backend-apply-note`, `#google-account-status`/
`#google-reconnect-status`. Only `#verdict-status`/`#next-step-status` have
any auto-dismiss behavior today (a bespoke `setTimeout(…, 2000)` each,
guarded so it only clears if still showing "Saved").

**A real cross-render hack exists because there's no toast.**
`lastSyncMessage` (`index.html:487`) is a module-level variable that
bridges a Sync/Push result across a full `renderList()` re-render — because
`renderList()` wipes `#content` (including `#sync-status`) before the
message would otherwise be written, the message has to be stashed in a
plain variable and re-injected into the *next* render's fresh
`#sync-status` node. A toast, appended once to `<body>` (not `#content`),
never has this problem — it survives navigation naturally.

**Real loading-state gaps.** The contact detail view (`renderDetail`) and
the add/edit form (`renderForm`, edit mode) show **nothing** while their
fetch is in flight — the page just displays whatever the previous view was
until the fetch resolves, which flashes blank or stale on a slow load. The
list view's own loading state is a bare `"Loading…"` text placeholder — no
reuse of the app's own `.spinner` CSS class, which today is used in exactly
one place (Google reconnect).

**Real silent-failure gaps** (the user sees nothing, only `console.error`):
- The initial "needs follow-up" count fetch failing (`index.html:876-879`)
  — the toggle just shows an "unknown count" state with no visible
  explanation.
- Autostart toggle save failing (`1054-1059`) — the checkbox silently
  reverts with no visible error text at all.
- Secrets-backend choice save failing (`1300-1305`) — same: silent
  revert, no visible text.

**A real, small visual bug**: `.autosave-status` (used by the verdict and
next-step pickers) has no `.error` CSS variant defined — so the "Failed to
save" text shown on a genuine save failure renders in the *success* color
(`--ok-fg`), because that's the class's only defined color rule. Not
something a user would necessarily notice consciously, but it's backwards.

**A real dead-code UX bug**: `renderDetail` sets `.not-found-banner`'s
content for an unknown/deleted contact, then *immediately* calls
`navigate("#/")` on the next line (`index.html:1480-1482`) — replacing
`#content` before the banner can ever actually be seen. The "not found"
message is written and then instantly discarded, unseen, every time.

**The one native `alert()` in the app** is the delete-contact failure path
(`index.html:1505`) — jarring and inconsistent with every other error
surface in the app, which are all inline/styled elements.

**Three near-duplicate status CSS classes** do the same job with
inconsistent capabilities: `.status-line` (has `.error`/`.success`, no
`.checking`), `.sync-status` (has `.sync-error`, defaults to
`--ok-fg`), `.autosave-status` (no error variant at all — the bug above).
`wizard.html`'s own `.status-line` additionally has a `.checking` variant
that none of index.html's status classes have.

## Design decisions (confirmed with owner)

Toast wireframe approved as-is:
https://claude.ai/code/artifact/e7acf8e4-dc52-4f00-8861-a18135574566

**1. One shared toast component, appended to `<body>` once at boot.**
`showToast(message, kind)` (`kind: "success" | "error" | "info"`) — a
fixed-position container (bottom-right, stacking, most-recent on top),
auto-dismiss after ~4s, a manual close (×) button per toast, and correct
ARIA (`role="status"`/`aria-live="polite"` for success/info,
`role="alert"` for errors, so screen readers announce them appropriately
without needing the user to be focused on the toast region).

**2. What moves to toast vs. what stays inline — a real distinction, not
"replace everything."** Toast is for *transient one-off events*: Sync/Push
results and failures (replacing `#sync-status` and the `lastSyncMessage`
bridge hack entirely), delete-contact failure (replacing the `alert()`),
the previously-silent Autostart/Secrets-backend/needs-follow-up failures,
and verdict/next-step save success (replacing the bespoke `setTimeout`
auto-clear with the toast's own built-in one). Inline stays for *standing
state*: form validation errors while actively editing (still needs to sit
next to the field it's about), the Database and Secrets-backend "restart
to apply" notes (persist deliberately, not one-off events), and the
Google account status line (shows current state, not an event). Appearance
save errors move to toast (they're one-off click events, not standing
state tied to a field).

**3. Unify the three status CSS classes into one `.status-line`**, with
`.success`/`.error`/`.checking` variants shared everywhere — this fixes the
success/error color bug as a natural side effect of consolidation, not a
special-cased patch. `wizard.html` is NOT touched by this consolidation
(separate file, separate scope, no shared stylesheet mechanism between two
static HTML documents without introducing a build step — explicitly out of
scope, see `ui-visual-cleanup`'s design doc for the token-alignment
discussion).

**4. Real loading states for detail/form views.** Both `renderDetail` and
`renderForm` (edit mode) show a `.spinner` + "Loading…" placeholder in
`#content` immediately, before their fetch starts, replaced once the real
content arrives — reusing the existing `.spinner` class instead of adding
a new one.

**5. Fix the not-found dead-code bug for real.** Decision: stop
auto-navigating away. Show the not-found banner with an explicit "Back to
contacts" link and let the user act on it, instead of silently bouncing
them to the list before they can ever read why. This is a real (if small)
UX improvement, not just a bug fix — today a stale/bookmarked link to a
deleted contact just silently dumps you back on the list with zero
explanation.

## Risks

- **Toast fatigue / stacking.** Multiple rapid actions (e.g. several quick
  saves) could stack several toasts. Mitigated by auto-dismiss (~4s) and
  keeping the max visible count reasonable — not solving this with a
  complex queue/throttle system, which would be over-engineering for a
  single-user local app.
- **Migrating `#sync-status`'s consumers.** `lastSyncMessage`'s removal
  touches both the Sync-now and Push-to-Google handlers — needs care to
  confirm no other code path still reads that variable after migration.
- **Scope discipline.** "Comprehensive" could balloon into a much bigger
  UI audit. This design doc's scope is the concrete list above — findings
  from the actual research pass, not a speculative expansion.

## Stories

1. Toast component: `showToast(message, kind)` + container + CSS
   (success/error/info variants, ARIA-correct), wired once at boot.
2. Unify `.status-line`/`.sync-status`/`.autosave-status` into one CSS
   component; migrate Sync/Push results, delete-contact failure (replacing
   `alert()`), and verdict/next-step save success to the toast — removing
   `lastSyncMessage` and the bespoke `setTimeout` auto-clear.
3. Surface the three previously-silent failures via toast: needs-follow-up
   fetch failure, Autostart save failure, Secrets-backend save failure.
4. Add real loading states (spinner + placeholder) to the contact detail
   view and the add/edit form's edit-mode fetch.
5. Fix the not-found dead-code bug: stop auto-navigating away, show the
   banner with an explicit back link.
6. Tests + docs update.
