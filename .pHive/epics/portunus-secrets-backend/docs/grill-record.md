# Grill Record — portunus-secrets-backend

**Source draft:** .pHive/epics/portunus-secrets-backend/docs/design-discussion.md
**CONTEXT.md substrate:** present
**inconsistency_risk_signals:** present
**round_number:** 1
**unresolved_count:** 0 (all 12 resolved in the revision below)
**Generated:** 2026-08-14T20:00:00Z

## Summary

- Vocabulary mismatches: 2 findings (F1, F2) — resolved
- Hidden assumptions: 3 findings (F3, F4, F5) — resolved, F3 caused a real
  architecture change (sync config read, not async/lazy)
- Unresolved tensions: 2 findings (F6, F7) — resolved as required
  empirical-verification steps for the implementing story, not asserted
  answers
- Convention violations: 2 findings (F8, F9) — resolved, F8 partly as a
  required verification step
- Security-specific scrutiny: 3 findings (F10, F11, F12) — resolved

## Findings and resolutions

- **F1** — `isPortunusAvailable()` was falsely framed as "mirroring
  Keychain's own check," but no such function exists (Keychain's check is
  a zero-cost inline `process.platform` comparison, not a subprocess
  probe). **Resolved:** reframed as a genuinely new pattern, not a
  borrowed precedent — an external program's availability is a
  structurally different question than an OS platform check.

- **F2** — `classifyKeychainError()` is keychain-specific by name and
  string content, called unconditionally on any backend's failure;
  `withInMemoryFallback`'s warning text also hardcodes "keychain."
  **Resolved:** design now specifies a backend-aware error classifier
  (`classifyPortunusError()`, dispatched by which backend was actually
  probed) and backend-parameterized warning text, rather than letting a
  Portunus failure display keychain-specific language.

- **F3** — the design's central claim ("mirrors the existing lazy-Store
  pattern") is false: `secrets` has a synchronous consumer
  (`createGoogleSync({ secrets })`) immediately after construction, unlike
  `store`. Making `secrets` async/lazy would cascade into making
  `googleSync` lazy too — untouched by the original design, a real scope
  gap. **Resolved — architecture change, not a patch:** dropped the
  async/lazy approach entirely. The backend choice is now resolved via a
  **synchronous** file read (`fs.readFileSync`, not `fs/promises`) at the
  exact point `createSecretsAdapter()` is already called today
  (`server.ts:135`, unchanged call site, zero ripple into `googleSync`'s
  construction timing). A tiny local JSON read at process-boot time is a
  non-issue for blocking the event loop. This is simpler than the
  original proposal, not just a fix — the false analogy led to solving a
  harder problem than actually exists.

- **F4** — the wizard reorder was characterized as "a handful of
  `navigate()` targets," but `reachedIndex` numeric literals are coupled
  to each screen's position in `STEPS`, and a naive rename risks
  desynchronizing that counter from actual navigation, silently letting a
  user hash-jump past the reordered screen. **Resolved, then corrected
  again during collaborative review:** the first revision of the design
  spelled out an exact diff but got the corrected `reachedIndex` bump
  numbers themselves wrong (asserted all three stayed the same; a
  researcher-lens review checked against the real `render()`/
  `reachedIndex` code and found only one of three actually does — the
  other two need their literal changed, not just their target string).
  Fixed in design-discussion.md §3 with a transition-by-transition table.
  Left here as a reminder that "write it out precisely" only helps if the
  precise version is also verified against the real code, not just
  internally consistent-sounding.

- **F5** — `checkSecretsCapability`'s real signature has no parameter for
  "probe this specific backend," and `CreateSecretsAdapterOptions` has no
  `backend` field today; the wizard's `/api/wizard/secrets-check` route
  doesn't thread a choice through either. **Resolved:** design now
  specifies the concrete plumbing — `checkSecretsCapability(factory,
  backend?)`, `CreateSecretsAdapterOptions.backend`, and the route
  accepting `{ backend }` in its request body so the UI can show a live
  check result for whichever radio button is currently selected, before
  the choice is even persisted.

- **F6** — Portunus's `set()` can throw while secret material was already
  written (`state=dropped`), and whether a retry's `drop` call behaves
  safely against that stale entry was never actually verified — the
  manual test only ran the happy path once. **Resolved as a required
  verification step**, not asserted: the implementing story's acceptance
  criteria must include verifying (against the real CLI) that retrying
  `set()` after a simulated `state enable` failure succeeds and results in
  a resolvable secret — not answered by reasoning alone in this document.

- **F7** — `delete()`'s idempotency (does `portunus reg rm` on an absent
  name exit cleanly, matching this codebase's established "absent =
  success" convention?) was asserted by omission rather than checked.
  **Resolved as a required verification step**, same treatment as F6.

- **F8** — no `sanitizeSetError()`-equivalent was specified for Portunus's
  write path, and whether Portunus's own stderr could ever echo a
  stdin-piped value back on a validation failure was never checked.
  **Resolved:** design now specifies a Portunus-specific error sanitizer
  (parallel to the existing one), and flags the stderr-echo question as a
  required empirical check during implementation rather than an assumed
  "no."

- **F9** — the `name`/`sm_name` collision-safety claim was asserted
  without ever explaining what `sm_name` represents in Portunus's model,
  and the manual verification never confirmed rolodex's real dotted key
  shapes (`"google.oauth.client"`) work through the CLI, only a
  placeholder. **Resolved:** flagged as a required research step before
  the naming scheme is locked in — read Portunus's own docs/code for what
  `sm_name` actually means, and re-verify with a real dotted key during
  implementation.

- **F10** — the "looks like an absolute path" check validates syntax, not
  provenance — nothing verifies the path is under a real temp directory,
  isn't a symlink, or wasn't swapped between print and read (TOCTOU).
  **Resolved:** design now requires checking the path is absolute **and**
  resides under the OS temp directory **and** is a regular file (not a
  symlink, via `lstat`) before reading — any deviation is a hard error,
  not a soft fallback.

- **F11** — try/finally deletion was described as fully "addressing" the
  leak risk, but only covers a JS exception, not a process-level crash
  between tempfile creation and deletion. **Resolved:** reframed
  precisely — addressed for the JS-throw case; process-crash-mid-read is a
  residual, explicitly out-of-scope risk under this app's existing
  threat model (same treatment as the OAuth epic's state-nonce-in-argv
  acceptance — documented, not silently ignored).

- **F12** — `isPortunusAvailable()`'s "never throws" claim didn't
  reference this exact codebase's own prior experience with a CLI hanging
  on an interactive prompt instead of failing fast
  (`secrets-check.ts`'s `PROBE_STEP_TIMEOUT_MS`/`withTimeout()`).
  **Resolved:** design now specifies reusing/mirroring that exact
  proven mechanism (`AbortSignal`-based timeout wired into `execFile`'s
  `signal` option, not a vague "or equivalent"), and flags hang-testing
  against the real binary as a required verification step, not an
  assumption.

## Out of scope (this pass)

Grill does NOT propose solutions, score quality, gate work, or prioritize
findings — resolutions above were authored by the planner (me) in response
to each grill question, not by the grill pass itself.
