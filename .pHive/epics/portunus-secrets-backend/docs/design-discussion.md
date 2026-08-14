# Design Discussion: portunus-secrets-backend

## 0. Prelude

No prior KG decisions found for this topic (clean slate). Directly serves
the interface boundary `SecretsAdapter` was explicitly designed for from
day one — `docs/ARCHITECTURE.md`: "The interface boundary exists
specifically so a future OSS contribution (the owner has named a Portunus
adapter...) can plug in without touching Store, the wizard, or the UI." This
epic is that contribution, plus a real install-time choice between backends.

## 1. What Are We Doing?

Adding a second real `SecretsAdapter` backend (Portunus, a separate,
independently-installed local CLI the owner already runs and dogfoods —
confirmed real, not aspirational, by cloning it and running its own
commands end to end) alongside the existing macOS Keychain backend, and a
real wizard step letting the user choose which one rolodex uses. "Done" is:
a user with Portunus installed can pick it during setup, rolodex stores the
Google OAuth client id/secret and token through it instead of the
keychain, and everything downstream (sync, reconnect) works identically
either way.

## 2. What I Found

- Portunus (`mdostal/portunus`) is real and running: cloned it, `pip install
  -e ".[test]"`, 357/357 tests passing, and personally exercised
  `portunus drop` → `portunus state enabled` → `portunus resolve` end to
  end against an isolated `PORTUNUS_HOME`.
- **It has no "get secret by key → string" API, by design.** A resolved
  value is never returned up the call stack to arbitrary caller code — only
  a tempfile-path handoff (`portunus resolve "{{secret:NAME}}"` prints a
  `0600` temp-file path; caller reads then deletes it) or exec-substitution
  (not useful here). Writing is `portunus drop <name> <sm_name> --stdin`
  (value via stdin, never argv) followed by a required
  `portunus state <name> enabled` (writes land `state=dropped`,
  fail-closed, until that second call).
- `src/lib/secrets-adapter.ts`'s existing Keychain backend is the
  structural pattern to mirror (`execFile` with an argv array; error
  sanitization before anything reaches a log) — but Portunus's actual
  shape (tempfile read + two-step write) is materially different from
  Keychain's single `-w`/`-g` calls.
- `src/lib/secrets-check.ts`'s `checkSecretsCapability(factory)` is
  reusable but currently has no way to say "probe this specific backend" —
  its only option today is `onFallback`; `SecretsCheckResult.backend` and
  `classifyKeychainError()` are both hardcoded to keychain-specific text
  regardless of what actually failed. **(Revised after grill F2, F5)**
- `src/shell/db-location.ts` is the real precedent for a wizard-set,
  non-secret preference (`wizard-config.json`, `homeDir`-parameterized for
  tests) — but it's async (`fs/promises`), and **(revised after grill F3)**
  that async shape turns out not to be the right one to copy here — see §3.
- **(Revised after grill F3)** `secrets` (`server.ts:135`) is constructed
  synchronously and immediately consumed synchronously on the very next
  line by `createGoogleSync({ secrets })` (`server.ts:139`) — unlike
  `store`, which has no eager synchronous consumer at construction time.
  An earlier draft of this document claimed making `secrets` async/lazy
  "mirrors the existing lazy-Store pattern"; that claim was checked against
  the real code during grill and found false — `store`'s laziness works
  precisely because nothing else is built eagerly from it, which isn't
  true of `secrets`. See §3 for the corrected approach.
- **(Revised after grill F4)** Confirmed the real wizard screen mechanics,
  not just the screen order: `STEPS = [welcome, database, google, secrets,
  finish]`, and `reachedIndex` (a numeric high-water-mark gating
  hash-jumping) is bumped to a specific literal by each screen's forward
  handler, tied to that screen's position in `STEPS`. A reorder isn't a
  pure string-rename — see §3 for the exact required diff.

## 3. My Proposed Approach

**New in `src/lib/secrets-adapter.ts`: `createPortunusSecretsAdapter()`,
`isPortunusAvailable()`, `classifyPortunusError()`.**
**(Revised after grill F1)** `isPortunusAvailable()` is not "the same
check as Keychain's" — no such function exists for Keychain (it's an
inline `process.platform` comparison, zero I/O). Portunus's availability
is a genuinely different, heavier question (is an external program
present and responsive) and gets its own real implementation:

1. `isPortunusAvailable()`: spawns `portunus --version` (exact real
   subcommand to be confirmed against the CLI's actual help output during
   implementation — not assumed) with the **same `AbortSignal`-based
   timeout mechanism `secrets-check.ts`'s `withTimeout()`/
   `PROBE_STEP_TIMEOUT_MS` already uses and proved necessary** — this
   codebase has direct prior experience with a CLI hanging on an
   interactive prompt instead of failing fast (that docstring's own
   empirical writeup). **(Resolves grill F12)** Whether `portunus
   --version` (or whatever the real equivalent turns out to be) actually
   can hang is a required verification step against the real binary during
   implementation, not assumed from the design alone. Returns `false` on
   ENOENT/timeout/nonzero exit; never throws.
2. `get(key)`: runs `portunus resolve "{{secret:rolodex.<key>}}"`, reads
   the printed path, reads that file, and always attempts deletion in a
   `finally` block. **(Resolves grill F10 — path provenance, not just
   format)**: before reading, verifies the printed path is absolute, lies
   under the OS temp directory (`os.tmpdir()`), and is a **regular file,
   not a symlink** (checked via `lstat`, not `stat`) — any deviation is a
   hard error, not a soft fallback. This defends against a buggy or
   malicious process printing a path to something that isn't actually a
   Portunus-owned tempfile.
3. `set(key, value)`: `portunus drop rolodex.<key> rolodex.<key> --stdin`
   (value via stdin, never argv), then `portunus state rolodex.<key>
   enabled`. **(Resolves grill F6, F9 — flagged as required verification,
   not asserted)**: whether `sm_name` (Portunus's own term, meaning
   unconfirmed by this document) being identical to `name` is safe, and
   whether retrying `set()` after a failed `state enabled` call behaves
   correctly against the now-existing `state=dropped` entry, are both
   **required empirical checks against the real CLI during implementation**
   — not resolved by reasoning here. If the second call fails, `set()`
   throws (a caller can't treat this as success) and deliberately does
   **not** attempt to roll back the `drop` (a rollback call is itself a
   new failure surface). **(Resolves grill F9)**: the exact real key
   shapes rolodex uses (`"google.oauth.client"`, `"google.oauth.token"` —
   dotted, multi-segment) must be verified through the real CLI during
   implementation, not just a placeholder key, before the naming scheme is
   locked in.
4. `delete(key)`: `portunus reg rm rolodex.<key>`. **(Resolves grill
   F7)**: whether this exits cleanly on an absent name (matching this
   codebase's established "absent = success" idempotency convention,
   exactly like Keychain's own exit-code-44 handling) is a **required
   verification step**, not asserted.
5. **(Resolves grill F8)** A new `sanitizePortunusError()`, parallel to
   the existing `sanitizeSetError()`, strips execFile argv/`.cmd` from any
   thrown error before it can reach a log sink. Whether Portunus's own
   stderr can ever echo a stdin-piped value back on some validation
   failure is a **required empirical check** during implementation — the
   research so far only confirmed the happy path, not failure-path output
   content.
6. **(Resolves grill F2)** `classifyKeychainError()` stays keychain-only in
   name and content; a new `classifyPortunusError()` handles Portunus
   failures with its own vocabulary, and `checkSecretsCapability` (below)
   dispatches to whichever classifier matches the backend actually probed.
   The `withInMemoryFallback` warning text also becomes backend-
   parameterized rather than hardcoding "keychain."

**(Resolves grill F5 — the concrete plumbing gap) `checkSecretsCapability`
and the wizard's capability-check route need real changes, not just a
label fix:**
- `checkSecretsCapability(factory, backend?)` gains a `backend` parameter,
  passed through to `factory({ backend, onFallback })`.
- `CreateSecretsAdapterOptions` gains `backend?: "keychain" | "portunus"`
  (default `"keychain"`, preserving today's exact behavior when omitted).
- The wizard's capability-check route accepts `{ backend }` in its request
  body, so the UI can show a live check result for whichever option is
  currently selected — before that choice is even persisted — rather than
  only ever checking a fixed backend.

**(Resolves grill F3 — architecture correction, not a patch) Backend
choice persistence uses a synchronous read, not async/lazy resolution.**
The original draft proposed making `secrets` lazily/async-resolved "like
`store`" — checked against the real code during grill and found false:
`googleSync` is built synchronously and immediately from `secrets`
(`server.ts:139`), so making `secrets` lazy would cascade into making
`googleSync` lazy too, an untouched scope gap in the original draft. The
corrected, simpler approach: a new `src/shell/secrets-backend-config.ts`
(mirrors `db-location.ts`'s shape — `homeDir`-parameterized,
`wizard-config.json`, a new `secretsBackendChoice` field) exposes a
**synchronous** `getSecretsBackendChoiceSync(homeDir?)` (`fs.readFileSync`,
not `fs/promises` — a tiny local JSON read at process-construction time is
a non-issue for blocking startup, and this file already needs a `try/catch`
returning a safe default on any read/parse failure, same as the existing
async reader's own error handling). `server.ts:135`'s call site stays
exactly where it is today — `createSecretsAdapter({ backend:
getSecretsBackendChoiceSync(homeDir) })` — no cascading laziness, no change
to `googleSync`'s construction timing, and `src/lib` still never touches
`wizard-config.json` directly (the shell layer resolves the choice and
passes a plain enum in, preserving the existing core/your-layer boundary).
This is simpler than the original proposal, not just corrected — solving a
real problem (F3 exposed) that turned out not to need solving at all once
the wrong assumption was removed.

**(Resolves grill F4 — the exact reorder diff, not "a handful of
targets")** New order: **welcome → database → secrets (choice + real
capability check) → google → finish**. Confirmed precisely against the
real `STEPS`/`reachedIndex` mechanics:
- `STEPS` becomes `[welcome, database, secrets, google, finish]` — indices
  `welcome=0, database=1, secrets=2, google=3, finish=4`.
- **(Corrected after researcher review — an earlier version of this exact
  paragraph asserted the wrong `reachedIndex` numbers)**. The rule is
  "bump to the *target screen's new index*," not "keep whatever number
  this handler used to have." Worked out explicitly, transition by
  transition:

  | Handler | Old target (old idx) → old bump | New target (new idx) → new bump |
  |---|---|---|
  | database's forward | `"google"` (2) → bump `2` | `"secrets"` (2) → bump `2` **(unchanged)** |
  | secrets' forward | `"finish"` (4) → bump `4` | `"google"` (3) → bump **`3`** (changed) |
  | google's skip/connect-success | `"secrets"` (3) → bump `3` | `"finish"` (4) → bump **`4`** (changed) |

  Only the *database* transition's bump number is coincidentally
  unchanged; the other two both need their literal changed, not just their
  `navigate()` target string. An earlier draft of this section claimed all
  three "stay the same numeric value" — checked directly against the real
  `render()`/`reachedIndex` mechanics (wizard.html:299) during researcher
  review and found wrong for two of the three. Getting this exact detail
  right (not just "roughly reorder it") is the entire point of writing it
  out explicitly rather than leaving it to be rediscovered under review —
  the wrong version would have silently let a user hash-jump from
  "secrets" straight to "finish," skipping "google" entirely.
- Back targets: secrets' back → `"database"` (was `"google"`); google's
  back → `"secrets"` (was `"database"`); finish's back → `"google"` (was
  `"secrets"`) — these were already correct in the original draft
  (confirmed by researcher review) and are unaffected by the forward-bump
  correction above.
- The implementing story's acceptance criteria must include verifying
  hash-jump-past-`reachedIndex` is still blocked after the reorder (e.g.
  completing "secrets" then attempting to jump straight to `#finish`
  without visiting "google" must still fail) — not just that the
  happy-path click-through works, since the happy path alone would not
  have caught the bug above.
- `isPortunusAvailable()` gates whether Portunus is even offered as a
  choice on the relocated "secrets" screen — if not detected, the screen
  behaves exactly as it does today (Keychain-only, no visible choice), so
  a user without Portunus installed sees the same screen content as
  before, just earlier in the flow.

## 4. What Could Go Wrong

- **Medium** — a `get()` that throws between reading the tempfile path and
  deleting it would leak a secret-bearing file on disk. Addressed with
  try/finally around the read+delete. **(Precision per grill F11)**: this
  addresses the JS-exception case only. A process-level crash (SIGKILL,
  OOM, power loss) between tempfile creation and deletion is a residual,
  unaddressed risk — out of scope for this epic, same treatment as the
  google-oauth-flow epic's state-nonce-in-argv acceptance (documented, not
  silently ignored, under this app's existing single-user local-machine
  threat model).
- **Medium** — path provenance: a printed "looks like a path" string isn't
  proof it's a real, Portunus-owned tempfile. Addressed with an absolute +
  under-os-tmpdir + regular-file (not symlink) check before reading (grill
  F10).
- **Medium** — the wizard reorder touches real, already-tested navigation
  with numeric-literal coupling that's easy to get subtly wrong. Addressed
  by specifying the exact diff in §3 rather than leaving it to be
  rediscovered, and requiring an explicit hash-jump-blocking test.
- **Low, requires verification not assumption** — `set()`'s two-step write
  leaving a dropped-but-disabled entry on partial failure, and whether a
  retry behaves safely against it (grill F6); `delete()`'s idempotency on
  an absent name (grill F7); whether Portunus's error output can ever echo
  a piped value back (grill F8). All three are named explicitly as
  required empirical checks in the implementing story, not resolved by
  assertion here.
- **Low** — Portunus absent on a given machine. Failed-closed by default:
  `isPortunusAvailable()` false means the choice is never offered.

## 5. Dependencies and Constraints

- No new npm dependency — `execFile`-based shell-out, same justification
  the Keychain backend already uses.
- `src/lib` stays ignorant of `wizard-config.json` — `src/shell` resolves
  the choice synchronously and passes a plain `backend` value into
  `createSecretsAdapter()` (see §3's F3 resolution).
- Portunus itself is not bundled with or installed by rolodex — detected,
  never assumed present.
- `classifyKeychainError()` and `classifyPortunusError()` stay separate,
  backend-specific functions rather than one generic classifier trying to
  cover both vocabularies (grill F2).

## 6. Open Questions

All twelve of the grill's findings are resolved above (§2/§3/§4) with an
explicit recommendation each. Three of them (F6, F7, F8's stderr-echo
question, F9's `sm_name` semantics and dotted-key verification) are
resolved as **required empirical verification steps during implementation**
rather than settled facts — flagged explicitly in the story so the
developer knows these need real CLI runs, not just code review, before
they're considered closed.

## 7. Verification Strategy

```
VERIFICATION PLAN:
  Tools: vitest — createPortunusSecretsAdapter tested via a fake
         execFile/child-process injection (mirroring the existing
         Keychain adapter test convention), never a real portunus binary
         in CI. isPortunusAvailable tested for both true/false AND
         hang/timeout paths via the same injection seam.
  Platforms: Portunus itself is cross-platform (Python) — confirm
         isPortunusAvailable() doesn't accidentally gate on
         process.platform the way the Keychain backend legitimately does.
  Automated: get() round-trip incl. tempfile deletion verified called;
         get() deletes the tempfile even when the read throws
         (try/finally proof); get() rejects a path that isn't absolute,
         isn't under the OS temp dir, or is a symlink (three separate
         provenance-check tests, per grill F10); set() happy path (drop
         then state-enabled, in order); set() throws when state-enabled
         fails without attempting a rollback drop; delete() calls reg rm
         and treats an absent-name response as success (once F7 is
         empirically confirmed); signal propagation into every execFile
         call; classifyPortunusError() never echoes a raw value; the new
         wizard-config.json field round-trips; the wizard's reordered
         navigate() targets AND reachedIndex hash-jump-blocking both
         covered by tests (per grill F4's exact diff).
  Manual (REQUIRED, not optional — see §3/§6): retry set() after a
         simulated/real state-enable failure against the actual portunus
         CLI (grill F6); delete() on a name never created, against the
         real CLI (grill F7); a real dotted key
         ("google.oauth.client"-shaped) through the full drop/state/
         resolve/reg-rm round trip (grill F9); confirm portunus --version
         (or whatever the real equivalent is) doesn't hang the way
         `security` once did (grill F12); confirm Portunus's failure-path
         stderr never contains a piped secret value (grill F8).
  Not verifying: a real Portunus install in CI (it's a separate program,
         not a rolodex dependency) — but every item in "Manual" above
         must be run against the real CLI by a human before this epic is
         considered done, not deferred indefinitely.
```

## 8. Scale Assessment

```
SCALE ASSESSMENT:
  Files affected: ~8 (src/lib/secrets-adapter.ts + test file,
    src/lib/secrets-check.ts — backend parameter + classifyPortunusError
    dispatch, new src/shell/secrets-backend-config.ts + test file,
    src/shell/server.ts — sync backend-choice read at the existing
    construction call site (not a lazy/async change, per F3's correction),
    src/shell/wizard.html — reorder + new choice UI per §3's exact diff)
  Subsystems: secrets backend (new implementation), wizard UI/navigation,
    server construction — genuinely cross-stack, comparable in shape to
    the google-oauth-flow epic, though the F3 correction keeps it from
    also touching google-sync.ts's construction timing
  Migration required: no (default backend stays "keychain" — existing
    users see zero behavior change)
  Cross-team coordination: no (solo project)
  Unknowns: several genuine ones remain (F6/F7/F8/F9's empirical
    questions) — explicitly NOT treated as blocking the plan itself, but
    as required verification gates before the epic is called done. Naming
    them precisely (rather than either guessing an answer or blocking
    planning entirely) is the resolution.

  RECOMMENDATION: Medium scope, proceeding straight to stories. The real
    slicing — core adapter+detection (with its required empirical
    verifications), then server/wizard wiring — maps directly onto
    ordered story dependencies without needing separate horizontal/
    vertical planning documents, same rationale as google-oauth-flow.
```
