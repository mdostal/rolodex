# Design Discussion: Package rolodex as an Electron desktop app

## Goal

Ship rolodex as a real installable, downloadable desktop app for macOS,
Windows, and Linux — not just a `npm run shell` dev server — with native
launch-at-login, unsigned for now, distributed as GitHub Release artifacts.
The MCP server, CLI, and Claude Code skill are untouched — this epic is
about the standalone app's distribution, not its integration surfaces.

## Framework decision: Electron, not Tauri

Confirmed still actively maintained (OpenJS Foundation, v43 stable,
8-week release cadence, powers VS Code/Slack/Discord/Figma) — not
discontinued, contrary to an initial assumption. Chosen over Tauri
specifically because rolodex's backend (`src/shell/server.ts`) is already
plain Node (`node:sqlite`, the OAuth loopback flow, keychain access) —
Electron's main process IS Node, so it `require()`/`import`s the existing
server directly, in-process, with no sidecar/IPC bridge. Tauri's Rust core
cannot reach `node:sqlite` directly and would need the Node server bundled
and spawned as a separate sidecar — real added complexity for zero benefit
here. This reverses (for the packaged-distribution phase only) the
"not Electron, not Tauri" call `docs/ARCHITECTURE.md` and
`src/shell/server.ts`'s own doc comment made for the dev-server phase; both
get updated as part of this epic (docs story) rather than left
contradicting the new reality.

Packager: **electron-builder**, not Forge — ~3.5M vs ~2,450 weekly
downloads, and first-class `publish: { provider: "github" }` built for
exactly this "build dmg/nsis/AppImage, attach to a release" shape.

## Electron version: 43.4.0, verified not assumed

`node:sqlite` is a Node **core** module, not an npm native addon — the
usual `asarUnpack` fix for native modules doesn't apply to it at all. What
actually matters is which Node version Electron bundles: this repo's own
`store.ts` already documents Node 22.x needing `--experimental-sqlite` and
lacking FTS5, vs. 23+/24+ working flag-free.

Electron 43.4.0 bundles **Node 24.18.1** — confirmed via
`ELECTRON_RUN_AS_NODE=1 electron -e '...'`, not just the release notes.
Verified for real (not just asserted): a `node:sqlite` `DatabaseSync`
created, written to, and read back inside the actual Electron binary,
zero flags. No blocking risk here.

## Architecture: a thin host, not a rewrite

`src/electron/main.ts` boots `createRolodexServer()` (unmodified) in the
Electron main process and points a `BrowserWindow` at its loopback URL.
Two existing platform-specific behaviors are handled at the Electron call
site, not by changing their source:

- `server.ts`'s own "open the OS browser" step (gated on `ROLODEX_NO_OPEN`)
  is suppressed (`process.env.ROLODEX_NO_OPEN = "1"`) — Electron's window
  replaces it, nothing to open.
- The real Google OAuth consent screen still needs a genuine external
  browser (Google disallows embedded-webview sign-in). `connectGoogleAccount`
  already takes an injectable `openBrowser` option
  (`src/lib/google-oauth-flow.ts:84`) — wired to Electron's own
  `shell.openExternal` in `main.ts`. This is also the real Windows/Linux
  win: today's default opener is Darwin-`open`-only and silently
  `console.warn`s elsewhere; `shell.openExternal` is cross-platform for
  free, no per-OS branching needed.

No preload script, no IPC bridge for v1 — the renderer is the exact same
web UI hitting the exact same HTTP API, unaware it's inside Electron. The
one thing that genuinely needs a native API (login-item autostart) gets
its own small addition in a later story; it doesn't change this shape.

Verified for real: launched the actual built app (`electron .`) against a
scratch `$HOME`, confirmed the in-process server came up and served the
real `wizard.html` on `curl localhost:4173/` while the app was running.

## Secrets cross-platform status

`src/lib/secrets-adapter.ts`'s Portunus backend shells out via
`execFileAsync("portunus", ...)` with **zero `process.platform` guard**
(`secrets-adapter.ts:306`) — unlike the Keychain backend, explicitly
commented Darwin-only. Portunus itself (a Python CLI, confirmed
`portunus 0.25.2` installed here) is plausibly already the real
Windows/Linux answer, contingent only on Portunus running on those
platforms — outside this repo's control to verify, and explicitly NOT
re-verified as part of this epic. Flagged as a real open question for
non-macOS testing, not silently assumed solved.

## Release mechanics: none exist today

`.github/workflows/ci.yml` is the only workflow — `npm ci && typecheck &&
test` on `ubuntu-latest`, every push/PR. Version bumps and `git tag` have
been fully manual (`v0.3.0`, `v0.4.0`). A packaging-and-publish workflow
has nothing to hook into — it's new, tag-triggered (`v*`), not an
extension of something that already runs.

## Scope

**In:** macOS (dmg), Windows (NSIS), Linux (AppImage + deb) — unsigned.
Native `app.setLoginItemSettings()` autostart toggle in the existing
Settings popover. Tag-triggered CI build+publish to GitHub Releases.

**Explicitly out:** code signing/notarization (deferred — Gatekeeper
"unidentified developer" / SmartScreen warnings are a documented, accepted
consequence for now, not a bug). An auto-updater (a real product decision
on its own, not decided here). Any change to `src/mcp/server.ts`,
`src/cli/index.ts`, or `.claude/skills/rolodex/` — those three integration
surfaces already point at `dist/*.js` directly and are untouched by this
epic.

## Stories

1. ✅ Electron version + `node:sqlite` spike
2. ✅ Main process scaffold (`src/electron/main.ts`, `npm run electron`)
3. Native autostart toggle (Settings popover + `app.setLoginItemSettings()`)
4. Packaging config (electron-builder targets, unsigned)
5. CI release workflow (tag-triggered, 3-platform build + publish)
6. Docs (`ARCHITECTURE.md`/README reflect Electron distribution; unsigned-install instructions)
