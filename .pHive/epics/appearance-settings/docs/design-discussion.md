# Design Discussion: Appearance Settings (Theme + Icon Picker)

## Goal

Let a user change the standalone app's look — a selectable UI theme and the
active app/tab icon — from the existing settings popover, persisted locally
so it survives restarts.

## Approach

**Persistence.** One `settings` row via the existing generic
`Store.getSetting`/`setSetting` (src/lib/store.ts), same mechanism as
`getFollowUpConfig()`. New key `appearance`, JSON-encoded
`{ theme: "default" | "brass", iconId: 1-10 }`, defaulting to
`{ theme: "default", iconId: 6 }` (today's shipped default). New route
`GET/PUT /api/settings/appearance` mirrors `/api/settings/follow-up` exactly
(same wizard-completion gate, same validate-then-persist shape).

**Theme.** `src/shell/server.ts`'s `GET /` handler already reads
`index.html` fresh off disk on every request (no static-file passthrough) —
so the current theme is injected server-side: `data-theme="brass"` on
`<html>` when selected, otherwise the attribute is omitted and the existing
default palette applies unchanged. No flash-of-wrong-theme risk since
there's nothing to hydrate.

Reuses the app's existing CSS custom-property names (`--bg`, `--fg`,
`--border`, `--muted`, `--accent`, `--accent-bg`, `--row-hover`,
`--chip-bg`) rather than a parallel token vocabulary, so every existing
component rule keeps working unchanged. `--danger`/`--ok-*` stay fixed
across themes (semantic color, not accent — kept separate deliberately).

Brass token values are taken verbatim from the icon-picker artifact built
during the app-icon epic (`rolodex-icon-picker.html:8-28`), which the owner
specifically liked: a light paper palette at `:root`, and a
`@media (prefers-color-scheme: dark)` block that's a deep green
(`#1A211D`) background with warm brass-gold (`#D19B4C`) accents — "brass"
is theme-aware by itself, following the OS, exactly like that artifact did.
This is not a third selectable option; Default is unchanged (still has no
dark palette, as today).

One addition beyond the artifact's tokens: `--accent-fg` (button text
color on top of `--accent`), because the artifact never needed
button-on-accent contrast. Light brass uses a cream `--accent-fg` against
dark-gold `#92651E`; dark brass uses a near-black `--accent-fg` against
light-gold `#D19B4C` — plain white (today's fixed button text color) fails
contrast against the lighter dark-mode gold.

**Scope cut:** the artifact's display/body/mono webfonts (Fraunces /
Source Sans 3 / JetBrains Mono) are NOT ported — that would add a
network-font dependency to what's otherwise a fully local, offline app.
Brass theme changes colors only; typography is unchanged. `wizard.html`
does not participate — appearance settings require a completed wizard
(the settings table), so there's nothing to read before that point.

**Icon picker.** All 10 Nano-Banana candidates already live at
`.pHive/design/app-icon/renditions/candidate-1.png` .. `candidate-10.png`
(1024×1024, uncorrected except candidate 6). Only candidate 6 currently has
a production icon set. This epic generates the same set — `.ico` (16/32/48),
`-16.png`, `-32.png`, `-180.png` (apple-touch), `-512.png` — for all 10,
flat-named `icon-c{n}-*` under `src/shell/assets/` (the asset route is a
single flat allowlisted directory, no subdirectories — see
`server.ts:415-421`). Candidate 6's set is regenerated from the already
color-corrected `selected-master-1024.png`, matching what's already shipped;
candidates 1-5/7-10 are generated from their raw originals as-is — no
palette correction pass for alternates that aren't the default.

The settings popover's Appearance section adds a 10-thumbnail grid
(`icon-c{n}-32.png` as the thumbnail source). Picking one PUTs
`{ iconId }`, and — same as theme — applies immediately client-side by
rewriting the `<link rel="icon">`/apple-touch-icon hrefs in place, in
addition to being served correctly on the next full load. Browsers cache
favicons aggressively; a live rewrite is correct practice but some browsers
may only visibly repaint on next navigation — a known, accepted limitation,
not treated as a bug.

`shell:build`'s explicit per-file `cp` list (package.json) is replaced with
a directory copy (`cp -r src/shell/assets/. dist/shell/assets/`) — the
per-file list doesn't scale to 50 generated icon files.

## Decisions (confirmed with owner)

- Settings surface: extend the existing gear popover (not a dedicated
  settings screen).
- Theme count: two (Default, Brass) — no separate dark-mode toggle; Brass
  itself is light/dark responsive per OS preference.
- Brass palette: taken from the icon-picker artifact's actual tokens
  (owner: "the artifact had brass as a semi-darkmode... green with brass
  accents"), not the flat light-only paper palette from the app-icon design
  brief.

## Risks

- Favicon caching means a changed icon may not visibly update in an
  already-open tab until reload/reopen — documented above, not fixed (a
  browser limitation, not a bug in this app).
- `--accent-fg` is a new token with no prior art in this codebase; every
  other themed property already existed. Kept to exactly one new token to
  minimize the token-surface increase.
