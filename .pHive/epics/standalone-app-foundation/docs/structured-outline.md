# Structured Outline: standalone-app-foundation

Input: design-discussion.md (revised) + horizontal-plan.md + vertical-plan.md (both revised post-H/V-review) + research-brief.md + grill-record.md + owner feedback across all three gates.

## Part 1: Executive Summary

**What we're building and why.** rolodex today is a headless MCP-server scaffold — real types, a real SQLite+FTS5 store, a real Google-sync interface, all method bodies stubbed, zero UI. This epic turns it into a standalone desktop app: a first-run setup wizard, a working contact list/detail/add UI backed by the real store, and a one-shot Google Contacts pull — the foundation the owner actually wants to run day to day. The MCP server stays untouched except for continuing to share the same `Store`.

**How feedback changed the plan.**
- At the design-discussion gate, the owner picked OS keychain over a SQLite session table for credential storage, and specifically asked for a **pluggable `SecretsAdapter`** (not a hardcoded keychain call) so a future OSS contribution (a named `Portunus` adapter, or any other secret manager) can plug in without touching core. This became Phase 3.
- At the design-discussion gate, the owner also stated a general principle: **capability over coverage** — ship exactly one working integration per extension point (Google Contacts for sync, OS keychain for secrets) and leave the interface open for the OSS community to add more. This governs scope throughout this outline; resist "also support X" during story writing.
- At the H/V gate, the team's collaborative review surfaced and the owner then **descoped login/logout entirely**: this app is single-user-per-instance, and any access gating happens in an outer "super-level" system that manages per-user instances (each with its own contact adapter wiring) — not inside this app. This removed an entire layer and one full vertical slice from the original plan (see Part 8, Decision 1, for the full before/after).
- The H/V collaborative review also surfaced and resolved: a missing `Store.list()` method (grill finding H1), an unassigned `setVerdict`/`setNextStep` UI gap (ui-designer), a critical-path compounding risk across the secrets→wizard→sync chain (tpm), and five security gaps in credential handling (security-reviewer) — all folded into the phases below rather than left as loose findings.

**Key decisions now locked** (see Part 8 for the full sign-off list):
1. No in-app login/logout — single-user-per-instance (owner, post-H/V-review).
2. Session/credential storage is OS keychain via a pluggable `SecretsAdapter` interface, not a SQLite table (owner, design-discussion gate).
3. Exactly one concrete implementation per adapter this epic (Google Contacts sync, OS-keychain secrets) — no multi-provider build-out now (owner, design-discussion gate).
4. This epic explicitly supersedes `docs/ARCHITECTURE.md`'s prior build-out roadmap, which ranked a UI last/optional (grill finding C1, resolved).
5. A minimal CI (typecheck + lint) workflow is in scope for this epic, not deferred (grill finding U1, resolved).

**Implementation strategy in brief:** build the desktop shell and prove it reads the real `Store` first (Phase 1, the riskiest unknown — shell choice — gets settled here); prove the core CRUD loop works end to end (Phase 2); build the pluggable secrets layer (Phase 3); wrap it in a setup wizard that hands off directly into the working contact UI (Phase 4, no login gate); wire Google Contacts sync (Phase 5) and search/interaction-logging (Phase 6) in parallel since neither depends on the other; close with a documentation rewrite and CI (Phase 7).

```
PRODUCT GOALS:
  Success metrics:
    - A first-run user reaches a working, populated contact list without
      touching a config file or the CLI (wizard-only setup)
    - Zero secrets (OAuth client secret, tokens) ever touch a committed file,
      an environment variable, or a log line
    - `docs/ARCHITECTURE.md` and `README.md` contain zero references to the
      superseded "UI is optional/last" framing after Phase 7
  Non-goals:
    - Multi-user / multi-tenant support of any kind
    - Full two-way Google sync (push + conflict resolution)
    - A Portunus (or any second) secrets backend
    - MCP tool body implementation
    - Cross-platform packaging/distribution
  Stakeholders: single owner/single-user tool — no cross-team sign-off needed
    beyond the owner's own review at each gate (already exercised during
    planning).
```

## Part 2: Detailed Approach

### Phase 1: Desktop shell boots, reads the real store

**Goal:** Settle the desktop-shell choice (open question #1) by building the thinnest real proof: an app window that boots and renders a real (empty) contact count read from actual SQLite via a new `Store.list()`.
**Depends on:** Nothing — first phase.

#### Changes

1. **New: app shell entry point** (path depends on shell choice — see Interfaces below for the three candidates; architect review rated local-server-plus-browser and Electron as sound fits, Tauri as the weakest given the hard `node:sqlite` requirement)
   - App bootstrap, window creation, single-instance lock (prevents two copies fighting over one SQLite file)
   - Store bridge: in-process import if the shell runs Node directly (local-server, Electron main), or an IPC/RPC layer if not
   - **If Electron is chosen:** `contextIsolation: true`, `nodeIntegration: false` on the renderer from this phase forward — later phases carry OAuth tokens across this same bridge (Phase 4-5), so the secure-IPC posture must be right from the start, not retrofitted.
   - **`node:sqlite` runtime flag — applies to EVERY shell candidate, not just Tauri (revised after architect review, verified by running `node -e "require('node:sqlite')"` against this repo's Node 22.12: throws `ERR_UNKNOWN_BUILTIN_MODULE` without it).** `node:sqlite` is experimental and requires `--experimental-sqlite` (via `NODE_OPTIONS` or a launch flag) on whichever process actually runs `Store` — Electron main, the local-server process, or Tauri's Node sidecar all need this set explicitly. `package.json` currently sets none of this. Add it to whichever script launches the shell's Node process this phase creates.
   - **UI architecture, not just process/IPC model (revised after ui-designer review):** the shell choice also determines the UI component framework and how mutations from later phases (Phase 2's upsert, Phase 5's sync) propagate back to already-rendered screens (routing between list/detail/add/wizard). This decision should be made alongside the shell choice in this phase, not left implicit — name the UI framework/state-management approach in the same story that resolves open question #1.

2. **`src/lib/store.ts`**
   - Add `list(): Contact[]` — minimal `SELECT * FROM contacts` (no pagination needed yet at foundation scale; can be added later without an interface break since callers just get more items)
   - Expected behavior before: method doesn't exist. After: returns all contacts, empty array when none exist.

3. **New: Contact UI list screen (empty state)**
   - Renders "0 contacts" from a real `Store.list()` call, not a hardcoded string or fixture

#### Interfaces

Desktop shell candidates (open question #1 — resolved by whichever this phase actually builds):

```
Option A — Electron:
  Main process: Node, imports Store directly
  Renderer: contextBridge-exposed IPC to main for all Store/SecretsAdapter calls
  Pro: mature desktop packaging; Con: bundle size, need contextIsolation discipline

Option B — Local server + browser tab:
  A local Node HTTP server hosts Store/SecretsAdapter behind a small REST/RPC
  surface; the UI is a browser tab pointed at localhost
  Pro: Store runs in an ordinary Node process, cleanest fit; Con: "is this
  really a desktop app" perception, needs a way to auto-launch a browser tab

Option C — Tauri:
  Rust core, Node sidecar process required to reach node:sqlite (Store can't
  run in the Rust core without a rewrite)
  Con (architect review): sidecar reintroduces an IPC layer functionally
  equivalent to Option B, minus its simplicity — weakest technical fit
```

`Store.list()` contract:
```typescript
list(): Contact[]  // no args in this phase; filter/pagination params can be
                    // added later as optional params without breaking callers
```

#### Validation

- Unit test (vitest): `Store.list()` against a temp SQLite file — empty array on fresh DB, returns inserted rows when present (seed directly via `upsert` once Phase 2 lands, or via raw SQL for this phase's isolated test)
- Manual: launch the app, confirm the empty-state renders from a real (not mocked) `Store` call — verify by temporarily inserting a row via `sqlite3` CLI against `ROLODEX_DB` and confirming it appears without a code change
- What could silently break: choosing a shell that can't cleanly reach `node:sqlite` — this is exactly what Phase 1 is designed to catch immediately, not later

---

### Phase 2: Add and view a contact end-to-end

**Goal:** Prove the core CRUD loop — add a contact through real UI, see it persist through a real restart.
**Depends on:** Phase 1 (shell + Store bridge must exist).

#### Changes

1. **`src/lib/store.ts`**
   - `upsert(c: Contact): Contact` — real implementation: dedup by `googleResourceName` first, then `email`; preserve `createdAt` on update, refresh `updatedAt`; reindex the `contacts_fts` row (the TODO comment at store.ts:37-38 already documents this exact contract)
   - `get(id: string): Contact | undefined` — real implementation
   - `setVerdict(id: string, v: Verdict): void` — real implementation (added after H/V review: ui-designer flagged this was named in the horizontal scan but unassigned to a slice)
   - `setNextStep(id: string, next: string): void` — real implementation (same review finding)

2. **New: Contact UI — add/edit form, detail screen, list screen (real rows)**
   - Add/edit form → `Store.upsert()`
   - Detail screen → `Store.get()`, includes the verdict picker (calls `setVerdict`) and next-step editor (calls `setNextStep`) — not just display
   - List screen now renders real rows returned by `Store.list()` (Phase 1)

#### Interfaces

```typescript
upsert(c: Contact): Contact       // dedup by googleResourceName, then email
get(id: string): Contact | undefined
setVerdict(id: string, v: Verdict): void
setNextStep(id: string, next: string): void
```

Error conditions: `get()` on an unknown id returns `undefined` (not a throw) — UI must handle the not-found case explicitly (e.g., navigating back to the list with a message), not assume every navigated-to id resolves.

#### Validation

- Unit tests (vitest): `upsert` dedup-by-googleResourceName, dedup-by-email fallback, `createdAt` preserved across an update, `updatedAt` refreshed, FTS row reindexed after upsert; `get` returns `undefined` for unknown id
- Manual: add a contact through the UI, restart the app, confirm it's still there; set a verdict and next-step, confirm they persist
- What could silently break: dedup logic edge cases (e.g., a contact with neither `googleResourceName` nor `email` set) — Phase 5 (Google sync) depends on this dedup behavior being correct, so get it right here, not there

---

### Phase 3: Secrets Adapter (interface + OS keychain + CI fake)

**Goal:** A pluggable secrets-storage layer that works, is testable in CI, and leaves room for future backends (Portunus, others) without touching this app's core.
**Depends on:** Phase 1 (same shell process/bridge shape, no UI dependency).

#### Changes

1. **New: `src/lib/secrets-adapter.ts`** (mirrors the existing `GoogleSync` interface + factory pattern in `src/lib/google-sync.ts:24-42`)
   - `SecretsAdapter` interface: `get(key: string): Promise<string | undefined>`, `set(key: string, value: string): Promise<void>`, `delete(key: string): Promise<void>`
   - `createSecretsAdapter(): SecretsAdapter` factory — real implementation selects the OS-keychain backend

2. **New: OS-keychain concrete implementation.** **Revised after architect review:** do NOT default to `keytar` — it is archived/unmaintained and, as a native module, is prone to Electron ABI-rebuild breakage. **If Electron is chosen (Phase 1), prefer Electron's built-in `safeStorage` API** — it fits the `SecretsAdapter` interface directly and avoids both the maintenance and native-module-rebuild risk. For the local-server or Tauri candidates, use the platform-native credential-store binding appropriate to that runtime, resolved at story-writing time once Phase 1 settles the shell.

3. **New: in-memory fake implementation** (added after security-reviewer review — this is what CI actually exercises, since headless CI can't reach a real OS keychain; without it, Phase 4's credential-handling tests would be silently uncovered)

#### Interfaces

```typescript
interface SecretsAdapter {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

function createSecretsAdapter(): SecretsAdapter;  // real (keychain) in production,
                                                     // fake (in-memory) in test env
```

No session/login use of this interface anywhere — it exists solely to hold this instance's Google OAuth client credentials/tokens (Phase 4-5). Login/logout is out of this app's scope entirely (Part 8, Decision 1).

#### Validation

- Unit test: `set()` then `get()` round-trips a value via the fake adapter (CI)
- Manual/local-only: same round-trip against the real OS keychain — documented as a manual pre-release check, not a CI gate, precisely because CI can't reach a real keychain headlessly
- What could silently break: a real OS-keychain regression that the fake adapter can't catch — flagged explicitly as a residual risk in Part 5 (Risk Registry), not hidden

---

### Phase 4: Setup wizard

**Goal:** A first-run user reaches a fully configured, working app — DB location confirmed, Google OAuth credentials collected and stored — landing directly in Phase 2's contact UI (no login gate).
**Depends on:** Phase 2 (contact UI to hand off into), Phase 3 (SecretsAdapter to write into).

#### Changes

1. **New: Wizard UI — 5 screens**
   - Welcome
   - Database location (confirm/override `ROLODEX_DB`; default `~/.local/share/rolodex/rolodex.db` per `store.ts:57-60` is already correct and needs no code change, just wizard-level confirmation UI)
   - Google connect (walks OAuth setup; scope resolved per open question #3 at story-writing time — guided GCP project creation vs. paste-existing-credentials; either way, writes through `SecretsAdapter.set()`, never to an env var or a tracked file)
   - Secrets check (calls `SecretsAdapter.set()`/`get()` to confirm write access before proceeding — fail fast, not silently)
   - Finish → hands off directly to the Phase 2 contact list (no login screen)

2. **First-run detection** — has setup already completed? (checked via a `SecretsAdapter.get()` sentinel key or a marker file outside the tracked repo, decided at story-writing time)

#### Interfaces

Wizard-to-core contract:
```
Wizard writes:
  ROLODEX_DB          → resolved as an env var (path, not a secret — the one
                         exception to "everything through SecretsAdapter")
  google.oauth.client  → SecretsAdapter key, OAuth client id/secret
  google.oauth.token   → SecretsAdapter key, written after Phase 5's consent flow
```

Security constraints (security-reviewer review, revised into this phase):
- No environment-variable fallback for OAuth client secret/token — an env-var fallback would undermine the entire keychain migration (visible in process listings, shell history, crash dumps). `ROLODEX_DB` stays env-var-configurable since it's a path, not a secret.
- The paste-existing-credentials form field (if that OAuth scope is chosen) must not be logged or transiently persisted to disk/app state beyond the in-memory wizard step — written straight to `SecretsAdapter` and cleared from UI state immediately after.

#### Validation

- E2E test (tool pinned to the Phase 1 shell choice): full wizard flow, welcome → finish → lands in populated-or-empty contact list
- Manual: real Google OAuth consent screen (can't be fully automated)
- What could silently break: OAuth-per-installer onboarding UX (each OSS installer needs their own GCP OAuth client) — this is a real UX risk named in the design discussion, not just a technical one; watch first-run drop-off if this phase ships without clear guidance text

---

### Phase 5: Google Contacts sync (one-shot pull)

**Goal:** The user's real Google Contacts appear in the rolodex, deduped against anything already added manually.
**Depends on:** Phase 4 (OAuth credentials must exist to call the API).

#### Changes

1. **`src/lib/google-sync.ts`**
   - `pull(): Promise<Contact[]>` — real implementation: `people.connections.list` with pagination via `pageToken`, map People API fields to `Contact` per the existing doc comments (google-sync.ts:19-21)
   - Credential retrieval via `SecretsAdapter.get()`, not env var (Phase 4's decision)
   - `push()` — remains a stub; explicitly out of scope this epic (two-way sync deferred)

2. **`package.json`** — add `googleapis` (or equivalent) dependency

3. **Contact UI** — "Sync now" action (or automatic trigger at the end of the wizard's finish step)

#### Interfaces

```typescript
interface GoogleSync {
  pull(): Promise<Contact[]>;              // real this phase
  push(c: Contact): Promise<{ resourceName: string }>;  // stays a stub
}
```

Pulled contacts flow through the existing `Store.upsert()` (Phase 2) — `resourceName` maps to `Contact.googleResourceName` for dedup, per `docs/ARCHITECTURE.md`'s documented mapping.

#### Validation

- Integration test against a test Google account/fixture data if feasible; otherwise manual verification with the owner's real account
- Manual: confirm `verdict`/`angle`/`nextStep` on a manually-added contact survive a subsequent Google pull unchanged — this is the "local fields survive sync" invariant from `docs/ARCHITECTURE.md`, and it needs a real test, not an assumption
- What's NOT being verified: conflict/merge resolution beyond simple dedup (out of scope), Google API rate-limit/quota edge cases beyond basic error surfacing

---

### Phase 6: Search and interaction logging

**Goal:** The user can search contacts and log interactions against them — the two remaining pain-point-serving capabilities from the north star.
**Depends on:** Phase 2 (contact UI + Store foundation). Independent of Phase 5 — can run in parallel.

#### Changes

1. **`src/lib/store.ts`**
   - `search(query: string, opts?: { verdict?: Verdict; limit?: number }): SearchResult[]` — real FTS5 `MATCH` query against `contacts_fts` (name/org/role/what/angle/tags, per the schema already defined in `store.ts:30-32`)
   - `logInteraction(i: Interaction): void` — real implementation, inserts into the `interactions` table

2. **Contact UI**
   - Search box on the list screen
   - Log-interaction action/form on the detail screen

#### Interfaces

```typescript
search(query: string, opts?: { verdict?: Verdict; limit?: number }): SearchResult[]
logInteraction(i: Interaction): void
```

#### Validation

- Unit tests (vitest): FTS5 search returns expected matches across name/org/what/angle/tags; `logInteraction` persists and appears in the detail view's interaction history
- Manual: search across a few contacts, log an interaction, confirm it shows up
- What's NOT being verified: `needsFollowUp()` — remains a stub, not wired to any UI this epic (see Deferred Items, vertical-plan.md §4)

---

### Phase 7: Documentation rewrite + CI

**Goal:** Docs and code agree; future PRs get automated guardrails.
**Depends on:** All prior phases (describes what was actually built).

#### Changes

1. **`docs/ARCHITECTURE.md`** — rewrite stating the standalone-app-first architecture, an explicit statement that this epic **supersedes** the prior build-out roadmap's UI-last ordering (grill finding C1), the `SecretsAdapter` pattern documented alongside the existing `GoogleSync` pattern, and an explicit single-user/no-in-app-gating statement (post-H/V-review descope)

2. **`README.md`** — rewrite: install/run instructions for the actual standalone app, not just the MCP server snippet; MCP mentioned as the secondary integration surface

3. **New: `.github/workflows/ci.yml`** — `npm run typecheck` + whatever linter gets picked for the new UI code (decision from design-discussion §5, grill finding U1)

#### Interfaces

None — documentation and CI config only.

#### Validation

- CI itself passing on the PR that adds it (self-verifying)
- Manual doc review: confirm no remaining references to the superseded "UI optional/last" framing anywhere in `README.md` or `docs/ARCHITECTURE.md`

## Part 3: Verification Plan

**Per-phase verification:**

```
Phase 1 verification:
  Automated:
    - Unit test: Store.list() against a temp SQLite file (vitest)
  Manual:
    - Launch confirms real empty-state, verified via direct sqlite3 insert
  Tools: vitest
  Platforms: owner's development OS (macOS) only — cross-platform packaging
    out of scope

Phase 2 verification:
  Automated:
    - Unit tests: upsert dedup (googleResourceName, then email fallback),
      createdAt preservation, updatedAt refresh, FTS reindex, get() undefined
      case (vitest)
  Manual:
    - Add → restart → still there; set verdict/next-step → persists
  Tools: vitest
  Platforms: macOS

Phase 3 verification:
  Automated:
    - Unit test: set()/get() round-trip via the fake adapter (vitest, CI)
  Manual:
    - Same round-trip against the real OS keychain (local-only, documented as
      a pre-release check, NOT a CI gate — CI cannot reach a real keychain)
  Tools: vitest (fake adapter only)
  Platforms: macOS (real-keychain manual check)

Phase 4 verification:
  Automated:
    - E2E test: full wizard flow welcome → finish (tool pinned once Phase 1's
      shell choice is made — e.g. Playwright for Electron)
  Manual:
    - Real Google OAuth consent screen (cannot be automated)
  Tools: TBD per shell choice (Phase 1), manual for OAuth consent
  Platforms: macOS

Phase 5 verification:
  Automated:
    - Integration test against test account/fixture data if feasible
  Manual:
    - Owner's real Google account pull; local-fields-survive-sync check
  Tools: vitest (integration), manual for the real-account check
  Platforms: macOS

Phase 6 verification:
  Automated:
    - Unit tests: FTS5 search matches, logInteraction persistence (vitest)
  Manual:
    - Search + log-interaction spot check
  Tools: vitest
  Platforms: macOS

Phase 7 verification:
  Automated:
    - CI workflow passing on its own introducing PR
  Manual:
    - Doc review for stale "UI optional/last" references
  Tools: GitHub Actions
  Platforms: N/A
```

**Verification coverage matrix:**

```
| Acceptance Criterion                          | Test Type          | Tool          | Phase |
|------------------------------------------------|---------------------|---------------|-------|
| Shell renders real (empty) store                | Unit + Manual       | vitest        | 1     |
| Add/view contact persists across restart        | Unit + Manual       | vitest        | 2     |
| Verdict/next-step editable and persist          | Manual              | —             | 2     |
| Secrets round-trip via fake adapter (CI)        | Unit                | vitest        | 3     |
| Secrets round-trip via real OS keychain         | Manual (local-only) | —             | 3     |
| Full wizard flow completes                      | E2E                 | TBD (Phase 1) | 4     |
| OAuth consent screen                            | Manual              | —             | 4     |
| Google Contacts pull populates rolodex          | Integration + Manual| vitest/manual | 5     |
| Local fields survive a Google pull              | Manual              | —             | 5     |
| FTS5 search returns expected matches            | Unit                | vitest        | 6     |
| Interaction logging persists and displays        | Unit + Manual       | vitest        | 6     |
| CI passes on its own introducing PR             | Automated            | GH Actions    | 7     |
```

**What's NOT being verified and why:**
- Cross-platform behavior (Windows/Linux) — verification strategy scopes to the owner's macOS development environment only; a future packaging epic would need its own verification pass.
- Google API quota/rate-limit edge cases beyond basic error surfacing — real quota testing needs sustained volume this epic's scope doesn't produce.
- Multi-user/concurrent access of any kind — explicitly not a scenario this app supports (single-user-per-instance).
- Full at-rest database encryption — not attempted this epic (see Part 3b, Security).
- `needsFollowUp()` behavior — the method stays stubbed; no UI calls it, so nothing to verify yet.

## Part 3b: Cross-Cutting Concerns

**Error handling strategy.** Store methods that previously threw `not implemented` now throw only on genuine failure (SQLite errors, constraint violations); `get()` on a missing id returns `undefined`, not a throw (Part 2, Phase 2). Google Sync failures (network, auth expiry) surface as a UI-level error state on the "Sync now" action, not a crash. Wizard failures (OAuth denial, keychain write failure) are retryable within the wizard flow, not fatal.

**Migration plan.** No schema migration needed — `contacts`/`interactions`/`contacts_fts` already exist via `Store.migrate()` (store.ts:18-33); this epic adds methods, not tables. No data migration since there's no pre-existing UI/data to migrate from (purely additive).

**Rollback plan.** Each phase is an independent, working commit (per vertical-plan.md's slice invariant) — reverting any single phase's commit leaves the app in the prior phase's working state, not a broken intermediate one. No production deployment/rollback concept applies (local desktop app, not a hosted service).

**Performance implications.** `Store.list()` (Phase 1) has no pagination — acceptable at foundation scale (a personal rolodex, not a CRM with thousands of records); if this becomes a real bottleneck, pagination can be added to `list()`'s signature later without breaking existing callers (optional params). FTS5 search (Phase 6) is already the schema's answer to "search shouldn't be a LIKE scan" — no additional perf work needed this epic.

**Documentation impact.** `README.md` and `docs/ARCHITECTURE.md` both require rewrites (Phase 7) — this is a first-class phase, not an afterthought, precisely because grill finding C1 flagged the risk of a self-contradictory repo.

**Security considerations.** This is the epic's largest cross-cutting concern, given the new OAuth/credential surface. Consolidated from the security-reviewer's H/V-gate findings:
- No secret (OAuth client secret, tokens) is ever written to an env var, a log line, or a tracked file — `SecretsAdapter` (OS keychain) is the only path (Phase 3-4).
- CI cannot exercise the real OS keychain — mitigated by the fake adapter (Phase 3), with a residual manual-verification gap tracked explicitly in Part 5 (Risk Registry), not hidden.
- If Electron is the chosen shell (Phase 1), `contextIsolation`/`nodeIntegration` must be locked down from Phase 1 onward, since Phase 4-5 carry secrets across that same bridge.
- **Explicit accepted-risk statement:** with login descoped, there is no in-app access control over the SQLite file at all — whatever protection exists is OS-account/filesystem-level, entirely outside this app. This must be stated explicitly in the Phase 7 documentation rewrite, not left implicit.
- The pre-exec security escalation raised by the architect during H/V review (`.pHive/cycle-state/standalone-app-foundation.yaml`) remains open — recommend a security-focused review of the `SecretsAdapter`/OAuth implementation specifically before Phase 3-4 stories are marked done, not just at final PR review.

## Part 4: File Change Manifest

```
FILES:

CREATE:
  - <shell-entry-point> (path depends on Phase 1 shell choice, e.g.
    electron/main.ts + electron/preload.ts, or server/index.ts for the
    local-server option) — desktop shell bootstrap + Store/SecretsAdapter bridge
  - <ui-app-directory>/ (structure depends on shell/UI-framework choice,
    resolved at Phase 1 story-writing time) — Contact UI, Wizard UI components
  - src/lib/secrets-adapter.ts — SecretsAdapter interface, factory, OS-keychain
    implementation, in-memory fake implementation
  - src/lib/secrets-adapter.test.ts — round-trip tests against the fake adapter
  - src/lib/store.test.ts — unit tests for list/upsert/get/setVerdict/
    setNextStep/search/logInteraction
  - src/lib/google-sync.test.ts — integration/unit tests for pull()
  - .github/workflows/ci.yml — typecheck + lint

MODIFY:
  - src/lib/store.ts — implement list() [new], upsert(), get(), setVerdict(),
    setNextStep(), search(), logInteraction() (needsFollowUp() stays stubbed)
  - src/lib/google-sync.ts — implement pull() (push() stays stubbed)
  - package.json — add googleapis, OS-keychain library (NOT keytar — see
    Phase 3 revision; prefer Electron safeStorage if Electron is chosen), UI
    framework/shell dependencies, new build/dev scripts for the desktop app
    with `--experimental-sqlite` set via NODE_OPTIONS or a launch flag
    (revised after architect review — required for every shell candidate);
    add a `lint` script if not already present
  - tsconfig.json — add `"DOM"` to `lib` (revised after architect review: no
    UI candidate works with the current Node-only `lib` config)
  - README.md — standalone-app-first rewrite
  - docs/ARCHITECTURE.md — standalone-app-first rewrite, roadmap supersession
    statement, SecretsAdapter pattern documentation, single-user/no-gating
    statement

DELETE:
  - (none)

UNCHANGED (but affected):
  - src/mcp/server.ts — continues to construct Store and GoogleSync; not
    wired to real implementations this epic, but now sits alongside a second
    surface using the same Store instance shape. Worth a smoke-check that the
    MCP server still starts cleanly after Store's real implementations land
    (it already imports Store — behavior for its own stub handlers doesn't
    change, but confirm no import-time regression).
  - src/lib/types.ts — consumed as-is by every new layer; no changes needed.
```

## Part 5: Risk Registry

| # | Risk | Severity | Likelihood | Mitigation | Owner |
|---|------|----------|------------|------------|-------|
| 1 | Desktop shell choice (Phase 1) turns out unable to reach `node:sqlite` cleanly | High | Low (architect review already ruled out the weakest option, Tauri) | Phase 1 is deliberately the thinnest possible slice — this is caught immediately, day one, not after other phases are built on top of a bad choice | Phase 1 implementer |
| 2 | OS-keychain library regression not caught by CI (fake adapter only exercised in CI) | Medium | Medium | Manual pre-release keychain check documented as a required step before any release, not optional; consider a lightweight local-CI or pre-release script that runs the real-adapter test on a maintainer's machine | Phase 3/4 implementer + release process |
| 3 | Secrets→wizard→sync critical path (Phases 3→4→5) compounds — a slip in Phase 3 or 4 delays every downstream phase | Medium | Medium | Sequence Phase 3 and Phase 4 with buffer; do not start Phase 5 story work until Phase 4 is demonstrably complete, not just "mostly done" | TPM / story sequencing at execution time |
| 4 | OAuth-per-installer onboarding UX (Phase 4) — every OSS installer needs their own GCP OAuth client | Medium | Medium | Wizard links to clear external setup steps rather than attempting to automate GCP project creation; write onboarding copy carefully, user-test with a fresh installer if possible before calling Phase 4 done | Phase 4 implementer |
| 5 | Google API quota/auth edge cases (Phase 5) surface only against a real account, not fully testable in CI | Low-Medium | Low | Manual verification with the owner's real account is the explicit verification plan (Part 3) — accepted, not a gap to close | Phase 5 implementer |
| 6 | No at-rest encryption or in-app access control at all, now that login is descoped | Medium | N/A (accepted risk, not a bug) | Explicit accepted-risk statement required in Phase 7's documentation rewrite — must not be silent | Phase 7 implementer |
| 7 | `Store.list()`'s lack of pagination becomes a real bottleneck if the rolodex grows large | Low | Low | Design the signature to allow optional pagination params later without a breaking change; not needed at foundation scale | Deferred — no action this epic |
| 8 | Electron IPC (if chosen in Phase 1) leaks secrets if `contextIsolation`/`nodeIntegration` aren't locked down before Phase 4-5 carry credentials across it | High (if it occurs) | Low (explicitly called out in Phase 1's Changes) | Locked down from Phase 1, not retrofitted — see Part 2 Phase 1 | Phase 1 implementer |
| 9 | Documentation rewrite (Phase 7) slips or is deprioritized, leaving the repo self-contradictory (grill finding C1) | Medium | Low-Medium | Phase 7 is a first-class phase with its own commit, not a "nice to have at the end" — track it as a real story, not a footnote | Phase 7 implementer / epic owner |
| 10 | The H/V-gate architect escalation (pre-exec security review of SecretsAdapter/OAuth design, logged in `.pHive/cycle-state/standalone-app-foundation.yaml`) gets silently dropped during execution | Medium | Medium (added after security-reviewer review of this outline — the escalation existed only as prose, with no registry row/owner until now) | Track as its own explicit item (this row) with Part 8 Decision 7 requiring the security review actually happen before Phase 3-4 stories are marked done, not just referenced once in prose | Epic owner — schedule the pre-exec security review before Phase 4 story sign-off |

**Detailed mitigation for Risk 3 (highest compounding risk, Medium severity but affects the whole epic's timeline):** treat Phases 3→4→5 as a single planning unit even though they're separate stories/commits. Don't parallelize story assignment across this chain — a developer picking up Phase 5 before Phase 4 is verified-complete risks building against an unstable credential-storage contract. Phase 6 (search/logging) and Phase 7 (docs/CI, partially) can run in parallel with this chain since they don't depend on it, which is where any spare capacity should go instead.

## Part 6: Dependency Map

```
INTERNAL DEPENDENCIES:
  Phase 2 depends on Phase 1 (Store bridge + shell must exist to demo add/view)
  Phase 3 depends on Phase 1 (same bridge shape, no UI dependency)
  Phase 4 depends on Phase 2 (hands off into the contact UI) and Phase 3
    (writes OAuth creds via SecretsAdapter)
  Phase 5 depends on Phase 4 (needs OAuth credentials to call the People API)
  Phase 6 depends on Phase 2 only (independent of Phases 3-5 — can run in
    parallel with the 3→4→5 chain)
  Phase 7 depends on all prior phases (documents what was actually built)

EXTERNAL DEPENDENCIES:
  Library: desktop UI/shell framework (Electron, or a local-server + browser
    setup) — pinned once Phase 1 resolves open question #1
  Library: OS-keychain access (e.g. keytar, or the shell's native credential
    binding) — pinned once Phase 1/3 resolve
  Library: googleapis (or equivalent) — Phase 5, People API client
  Service: Google People API — Phase 4-5; what happens if it's down: pull
    fails gracefully with a retryable UI error state, does not crash the app
    or block Phase 2's already-working core CRUD loop

BLOCKING QUESTIONS:
  - Open question #1 (desktop shell) blocks the concrete file paths and
    exact IPC contract for Phase 1 — this outline gives three candidate
    shapes (Part 2, Phase 1, Interfaces) rather than one, pending that choice
  - Open question #3 (wizard OAuth scope: guided GCP setup vs.
    paste-existing) blocks the exact screen count/copy for Phase 4's Google
    connect screen — doesn't block starting Phase 4 story-writing, just its
    final copy/flow detail
```

## Part 7: Elicitation — Stress-Testing This Plan

#### Why Won't This Work?

1. **Failure:** The chosen desktop shell can't cleanly host `node:sqlite`.
   **Trigger:** Picking Tauri (or an equivalent non-Node-native shell) without accepting the sidecar-process cost.
   **Impact:** Phase 1 stalls; every later phase is blocked since they all build on the Store bridge.
   **Signal:** Phase 1's own unit test (`Store.list()` against a temp file) plus the manual launch check fail or require unreasonable workarounds within the first day of implementation.
   **Our answer:** Architect review already ranked the three candidates by fit; Phase 1 is deliberately the thinnest slice specifically to surface this immediately rather than after investment. We're not choosing Tauri unless there's a strong non-technical reason to accept its cost knowingly.

2. **Failure:** OAuth-per-installer onboarding is confusing enough that first-run users abandon setup.
   **Trigger:** Wizard's Google-connect screen (Phase 4) under-explains the GCP OAuth client creation steps.
   **Impact:** The app's actual value (Google Contacts sync) never gets reached by real users; worse first-run experience than the current zero-UI state.
   **Signal:** Manual first-run testing (ideally with someone other than the owner) stalls or gets confused at the Google-connect screen.
   **Our answer:** This is a named, accepted UX risk (Risk 4) with mitigation (clear external-linked instructions, not an attempted GCP-automation). If it proves too hard in practice, a fast-follow could add guided GCP project creation — deferred, not solved, this epic.

3. **Failure:** A real OS-keychain regression ships because CI only ever exercises the fake `SecretsAdapter`.
   **Trigger:** A platform-specific keychain library bug that the fake adapter's simple in-memory behavior doesn't reproduce.
   **Impact:** Phase 4's credential storage silently breaks for real users despite green CI.
   **Signal:** Manual pre-release keychain round-trip check (Part 3, Phase 3 verification) catches it before release — but only if that manual step is actually run every time, which is a process discipline risk, not a technical one.
   **Our answer:** Named explicitly as Risk 2 with a required (not optional) manual step. If this proves unreliable in practice, a next step would be a local-only CI job runnable on a maintainer's machine — not attempted this epic since it adds real setup complexity for a single-user tool.

4. **Failure:** The secrets→wizard→sync critical path (Phases 3-5) takes longer than any individual phase's risk rating suggests because of compounding delay.
   **Trigger:** Any rework in Phase 3 or 4 (e.g., the OAuth scope decision, open question #3, resolving differently than expected).
   **Impact:** Phase 5 (the phase that delivers the north star's core promise — Google Contacts sync) slips.
   **Signal:** Phase 4 taking meaningfully longer than Phase 1-2 combined, or requiring a second pass after Phase 5 work has already started.
   **Our answer:** Named explicitly as Risk 3 with a sequencing mitigation (don't parallelize story assignment across this chain). Phase 6 exists precisely so there's productive parallel work available if this chain does slip.

5. **Failure:** Descoping login/logout turns out to be wrong — the "super-level" wrapping system the owner described doesn't materialize, or single-instance isolation isn't actually sufficient access control in some future deployment.
   **Trigger:** A future deployment scenario (e.g., a shared machine, a hosted multi-instance deploy) that assumed external gating exists.
   **Impact:** Data exposure risk if the app is ever run somewhere the OS-account boundary isn't real isolation.
   **Signal:** Would surface at whatever future point someone tries to deploy this outside a fully single-user, single-machine context.
   **Our answer:** Explicit accepted-risk statement required in Phase 7's docs (not silent). If this assumption breaks, Phase 3's `SecretsAdapter` is already the right place to add a credential for an in-app login later — Moldability note in vertical-plan.md §6 already flags this as additive, not a rework.

#### What Assumptions Are We Making?

- **VERIFIED** — `Store`'s method signatures and SQLite/FTS5 schema are real and don't need redesign (confirmed by direct source read during research, research-brief.md §"Key files & surfaces").
- **VERIFIED** — No UI framework, auth library, or desktop-shell dependency exists in `package.json` today (confirmed by research-brief.md; this is genuinely new dependency surface, not a wiring task).
- **VERIFIED** — The owner wants OS keychain over a SQLite session table, and wants it pluggable (adapter interface), specifically naming a future `Portunus` adapter (owner's direct feedback at the design-discussion gate).
- **VERIFIED** — Login/logout is out of scope; single-user-per-instance is the model (owner's direct feedback at the H/V gate).
- **ASSUMED** — A minimal, single Store-backed `list()` without pagination is sufficient for foundation scale (a personal rolodex). Reasonable because the north star describes a personal-scale tool, not a CRM with thousands of contacts; if wrong, the fix is additive (optional pagination params), not a rewrite.
- **ASSUMED** — One-shot Google Contacts pull (no push, no conflict resolution) is enough to "prove the loop end to end" per the design discussion. Reasonable because full two-way sync is explicitly named as future scope in the north star ("expand to other systems... going forward"), not required now.
- **RISKY** — Which desktop shell will be chosen is still open (open question #1). This outline gives three candidate shapes rather than one concrete file manifest for Phase 1 — if the eventual choice differs meaningfully from all three sketched here (e.g., a framework not considered), Phase 1's file manifest specifically (not the rest of the plan) would need updating. Flagged, not hidden.
- **RISKY** — Whether the wizard's OAuth scope (open question #3) is "guided GCP setup" or "paste-existing-credentials" changes Phase 4's screen count and copy meaningfully. Both variants fit within Phase 4 as scoped, but the story-level detail differs — this should be resolved before Phase 4 stories are written, not during.

#### What's the Simplest Version?

- **Must have:** Phase 1 (real shell + Store), Phase 2 (real CRUD), Phase 3 (SecretsAdapter), Phase 4 (wizard) — without these four, there is no standalone app at all, just the current headless scaffold. Phase 5 (Google sync) is also must-have — it's the north star's explicitly named first integration ("Google Contacts as the current login/interaction method"); without it, the app doesn't deliver the owner's stated success criterion.
- **Should have:** Phase 6 (search + interaction logging) — both directly serve the stated pain points (follow-up discipline, niche tracking) but the app is still a genuinely working foundation without them; they could slip to an immediate fast-follow without the epic feeling incomplete architecturally, only feature-incomplete.
- **Could cut:** Phase 7's CI portion specifically (the docs rewrite should NOT be cut — grill finding C1 makes that a coherence issue, not a nice-to-have) — CI is valuable but the app works without it; if scope needs to shrink under time pressure, CI is the safest single item to defer to an immediate follow-up PR without leaving the epic in a contradictory state.

#### What Will We Wish We Had Thought Of?

- **Technical debt knowingly taken on:** `Store.list()` with no pagination, no filtering beyond what `search()` provides — acceptable now, would need revisiting if the rolodex grows into the thousands of contacts.
- **Edge cases being deferred:** `needsFollowUp()` stays a stub with zero UI — safe to defer since nothing calls it, but it directly serves the stated pain point ("who's gone cold"), so it's likely to be the very next thing requested after this epic ships.
- **Integration points not fully validated:** the real OS-keychain path is only manually verified, never in CI (Risk 2) — likely to be the first place a platform-specific bug surfaces in the wild.
- **User workflows not fully considered:** re-running the wizard after first-run (e.g., to reconnect Google after a revoked token) has no dedicated flow — Deferred Items (vertical-plan.md §4) already names a settings screen as future work; likely the first "why can't I just—" moment a real user hits.

#### Where Are We Over-Engineering?

- **Abstractions with only one consumer:** the `SecretsAdapter` interface currently has exactly one production consumer (Google OAuth credentials) and one implementation (OS keychain) — this looks like premature abstraction, but it's explicitly the owner's requested design (capability-over-coverage principle, named at the design-discussion gate, with a specific future consumer — Portunus — already identified). Kept as designed, not flagged as over-engineering.
- **Error handling for unlikely scenarios:** none identified as excessive — the error-handling strategy (Part 3b) stays close to what each phase actually needs (retryable UI states for network/auth failures), nothing speculative added beyond that.
- **Configurability that wasn't requested:** none added — `ROLODEX_DB` env-var configurability already existed pre-epic; nothing new introduced here.
- **Backward compatibility for things with few consumers:** N/A — this is additive work on a v0.1.0 scaffold with no external consumers yet; no backward-compatibility burden exists to over-engineer around.

## Part 8: Decision Points for Sign-Off

```
DECISIONS REQUIRING SIGN-OFF:

1. [SCOPE] Login/logout removed entirely from this epic — single-user-per-
   instance, access gating (if any) is an outer "super-level" system's job.
   This was decided by the owner at the H/V gate (after the collaborative
   review's original 3-layer sequence included a login gate) and is already
   reflected throughout this outline (Phase 4 hands off directly to Phase 2's
   UI; no Login/Auth UI phase exists).
   → Affirm / Change direction

2. [APPROACH] Desktop shell choice remains open (open question #1) — this
   outline gives three candidate shapes (Electron, local-server+browser,
   Tauri) rather than picking one, because the choice materially changes
   Phase 1's concrete file manifest and the outline shouldn't guess. The
   architect's review already ranked Tauri as the technically weakest fit
   given the hard node:sqlite requirement.
   → Affirm proceeding with Phase 1 as a shell-choice spike / Pick a shell now
     to lock Phase 1's file manifest before story-writing

3. [SCOPE] **Corrected after tpm review of this outline (original wording
   contradicted Part 7):** Phases 1-5 are must-have per Part 7's "simplest
   version" analysis — without them there is no standalone app, and Phase 5
   (Google sync) is the north star's explicitly named first integration.
   Phase 6 (search + interaction logging) is **should-have**: valuable and
   pain-point-serving, but the epic is architecturally complete without it
   and it can slip to an immediate fast-follow if scope needs to shrink.
   Phase 7's CI portion (not its docs portion, which is must-have per grill
   finding C1) is the other safely-cuttable item.
   → Affirm / Adjust scope

4. [RISK ACCEPTANCE] No at-rest database encryption, no in-app access control
   of any kind, now that login is descoped (Risk 6). Accepted as a stated,
   explicit tradeoff — not an oversight — to be documented plainly in Phase
   7's rewrite.
   → Accept / Require mitigation (e.g., revisit at-rest encryption in a
     future epic)

5. [RISK ACCEPTANCE] CI cannot exercise the real OS keychain; a fake adapter
   covers CI, with a required (not optional) manual pre-release check as the
   only safeguard against a real-keychain regression (Risk 2).
   → Accept / Require mitigation (e.g., a maintainer-run local CI job)

6. [TRADE-OFF] Exactly one concrete adapter implementation per extension
   point this epic (Google Contacts for sync, OS keychain for secrets) —
   explicitly not building Portunus or any second sync provider now, per the
   owner's capability-over-coverage principle from the design-discussion gate.
   → Affirm / Reconsider

7. [RISK ACCEPTANCE] The architect's H/V-gate pre-exec security escalation
   (SecretsAdapter/OAuth design review, `.pHive/cycle-state/
   standalone-app-foundation.yaml`) is now tracked as Risk Registry row 10,
   owned by the epic owner, required to happen before Phase 3-4 stories are
   marked done — not deferred to final PR review only.
   → Accept as scheduled / Require it complete before Phase 3 starts instead
```
