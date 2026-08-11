# Vertical Plan — standalone-app-foundation

Input: horizontal-plan.md (layer map + cross-layer dependencies) + design-discussion.md + owner feedback (Q6 decided; Q2/login descoped post-H/V-review — single-user-per-instance, no in-app login/logout).

## 1. Slicing Strategy

```
STRATEGY:
  Total horizontal items: ~26 (per horizontal-plan.md §5)
  Planned slices: 7
  First slice goal: prove the desktop shell reads the REAL SQLite store (not
    a mock) — the thinnest possible non-fake proof of concept.
  Final slice goal: a first-run user can install, set up (wizard), see their
    Google Contacts pulled in, add/search/log interactions on contacts, and
    the repo's docs + CI accurately reflect all of it. No login/logout — this
    app is single-user-per-instance; access gating is an outer system's job.

  Slicing rationale: core domain value (a working contact list backed by the
  real store) is proven BEFORE the onboarding wrapper (secrets adapter,
  wizard) is built around it. This lets slice 1-2 validate the riskiest
  technical unknown (shell <-> Store bridge, open question #1) as early as
  possible, before investing in wizard UX around it. Google Sync and
  search/logging are later slices because sync depends on the Secrets Adapter
  (for OAuth tokens) and neither blocks proving core CRUD works.
```

## 2. Vertical Slice Plan

```
## Step 1: Shell boots, reads the real (empty) store

WHAT WORKS AFTER THIS STEP:
  The desktop app opens a window and shows "0 contacts" — read from the
  actual SQLite database via a new Store.list() method, not a mock or
  fixture.

LAYERS TOUCHED:
  Desktop UI Shell:
    - App bootstrap/window (shell choice from open question #1 decided here —
      this slice IS the shell decision's proof point)
    - Store bridge (in-process or IPC, per shell choice). **If the chosen
      shell is Electron (revised after security-reviewer review):** the
      renderer must run with `contextIsolation: true` and
      `nodeIntegration: false`, since later slices carry OAuth
      tokens/credentials across this same bridge (Steps 4-5) — get the
      secure-IPC posture right in Step 1 rather than retrofitting it once
      secrets are flowing through it.
  Store/Data:
    - list() — new method, minimal (SELECT * FROM contacts)
  Contact UI:
    - List screen — empty-state rendering only

NOT YET:
  - Add/edit, search, wizard, sync — everything else

VERIFIED BY:
  - Unit test (vitest): Store.list() against a temp SQLite file
  - Manual: launch the app, confirm it shows the real empty-state, not a
    hardcoded string

COMMIT REPRESENTS: Desktop shell wired to the real Store — shell choice
  (open question #1) is settled by this commit existing.

---

## Step 2: Add and view a contact end-to-end

BUILDS ON: Step 1
WHAT WORKS AFTER THIS STEP:
  A user can open the app, fill out an add-contact form, see it appear in the
  list, click into it, and see the detail screen — and it's still there after
  restarting the app.

LAYERS TOUCHED:
  Store/Data:
    - upsert() — real implementation (dedup by googleResourceName/email,
      preserve createdAt, refresh updatedAt, FTS reindex per store.ts:37-38)
    - get() — real implementation
    - setVerdict(), setNextStep() — real implementation (revised after H/V
      review: ui-designer flagged these were named in the horizontal scan but
      unassigned to any slice)
  Contact UI:
    - Add/edit contact form
    - Contact detail screen — includes the verdict picker and next-step
      editor (not just display), wired to setVerdict/setNextStep
    - List screen — now renders real rows, not just empty state

NOT YET:
  - Search, interaction logging, wizard, sync
  - Loading/error/toast states beyond the basics (flagged by ui-designer;
    deferred per §4)

VERIFIED BY:
  - Unit tests (vitest): Store.upsert dedup + preserve-createdAt behavior,
    Store.get
  - Manual: add a contact, restart the app, confirm it persisted

COMMIT REPRESENTS: Core CRUD loop works end to end through real UI and real
  storage — this is the first slice that delivers the app's actual job.

---

## Step 3: Secrets Adapter (interface + OS keychain)

BUILDS ON: Step 1 (uses the same shell process/bridge shape)
WHAT WORKS AFTER THIS STEP:
  A value can be written to and read back from the OS keychain through the
  new SecretsAdapter interface — verifiable via an internal dev command or
  test harness, no UI screen needed yet.

LAYERS TOUCHED:
  Secrets Adapter:
    - SecretsAdapter interface (get/set/delete), mirroring GoogleSync's
      interface+factory shape (google-sync.ts:24-42)
    - OS-keychain concrete implementation (library choice per chosen shell)
    - **In-memory fake implementation, shipped alongside the real one**
      (revised after security-reviewer review: this is what CI actually
      exercises against, given headless CI can't reach a real OS keychain —
      the fake must satisfy the same interface so Step 4's tests aren't
      silently uncovered in CI)

NOT YET:
  - Any UI screen that uses it (that's step 4)
  - Portunus or any other backend (interface stays open, not built)
  - Any session/login use — this adapter stores this instance's Google OAuth
    credentials only; login/logout is descoped from this app entirely

VERIFIED BY:
  - Unit test: set() then get() round-trips a value via the fake adapter (CI)
  - Manual/local-only: same round-trip against the real OS keychain
    (documented as a manual pre-release check, not a CI gate)

COMMIT REPRESENTS: Pluggable secrets storage exists and works — the
  foundation the wizard's Google-connect step builds on next.

---

## Step 4: Setup wizard

BUILDS ON: Steps 2, 3
WHAT WORKS AFTER THIS STEP:
  A first-run user goes from a fresh install to a fully configured app:
  confirms DB location, is walked through Google OAuth credential setup
  (scope per open question #3), and lands directly in the working contact UI
  from Step 2 — no login gate to land on (descoped, see design-discussion §3).

LAYERS TOUCHED:
  Wizard UI:
    - Welcome, DB location, Google connect, secrets check, finish screens
    - **Decision (revised after security-reviewer review):** OAuth
      credentials go through the SecretsAdapter only — no environment-variable
      fallback for the OAuth client secret/token (an env var fallback would
      undermine the keychain migration: visible in process listings, shell
      history, crash dumps). `ROLODEX_DB` remains env-var-configurable since
      it's a path, not a secret.
    - Pasted-credential form field (open question #3's paste-existing path)
      must not be logged or transiently persisted to disk/app state beyond
      the in-memory wizard step — written straight to the SecretsAdapter and
      cleared from UI state immediately after.
  Secrets Adapter:
    - Write path exercised for real (OAuth client creds/token)
  Store/Data:
    - ROLODEX_DB path resolution/creation on first run

NOT YET:
  - Actual Google Contacts pull (wizard collects/validates credentials; the
    pull itself is step 5)

VERIFIED BY:
  - E2E test (tool per open question #1's shell choice): full wizard flow
  - Manual: OAuth consent screen (can't fully automate a real Google consent)

COMMIT REPRESENTS: First-run experience is complete — zero to configured app.

---

## Step 5: Google Contacts sync (one-shot pull)

BUILDS ON: Step 4
WHAT WORKS AFTER THIS STEP:
  The user's real Google Contacts get pulled in and appear in the rolodex
  contact list, deduped against anything already added manually.

LAYERS TOUCHED:
  Google Sync:
    - pull() — real implementation (people.connections.list, pagination,
      field mapping)
  Store/Data:
    - upsert() exercised for dedup-by-googleResourceName/email against pulled
      contacts
  Contact UI:
    - "Sync now" action (or automatic trigger at end of wizard)

NOT YET:
  - push() (two-way sync) — explicitly out of scope for this epic
  - Conflict/merge resolution beyond simple dedup

VERIFIED BY:
  - Integration test against a test Google account/fixture data if feasible;
    otherwise manual verification with the owner's real account
  - Manual: confirm verdict/angle/nextStep on a manually-added contact survive
    a subsequent Google pull unchanged (per docs/ARCHITECTURE.md's
    local-fields-survive-sync rule)

COMMIT REPRESENTS: The core promise from the north star — "integrate with
  Google Contacts as the current login/interaction method" — works.

---

## Step 6: Search and interaction logging

BUILDS ON: Step 2
WHAT WORKS AFTER THIS STEP:
  The user can search their contacts (name/org/what/angle/tags) and log an
  interaction (call/email/meeting/note) against a contact, both from real UI
  wired to real Store methods.

LAYERS TOUCHED:
  Store/Data:
    - search() — real FTS5 MATCH query implementation
    - logInteraction() — real implementation
  Contact UI:
    - Search box
    - Log-interaction action/form on the detail screen

NOT YET:
  - needsFollowUp() / a dedicated "who's gone cold" view — candidate for a
    fast-follow epic if not reached within this one (see Deferred Items)

VERIFIED BY:
  - Unit tests (vitest): FTS5 search returns expected matches;
    logInteraction persists and appears in detail view
  - Manual: search across a few contacts, log an interaction, confirm it
    shows in the interaction history

COMMIT REPRESENTS: The two remaining pain-point-serving capabilities from the
  north star (fast search, logged touchpoints) work.

---

## Step 7: Documentation rewrite + CI

BUILDS ON: All prior steps (describes what was actually built)
WHAT WORKS AFTER THIS STEP:
  README.md and docs/ARCHITECTURE.md accurately describe the standalone-app
  architecture (with the explicit roadmap-supersession statement from grill
  finding C1, and the single-user/no-in-app-login constraint stated
  explicitly per the H/V review descope), and a CI workflow runs typecheck +
  lint on every PR.

LAYERS TOUCHED:
  Documentation:
    - docs/ARCHITECTURE.md rewrite (standalone-app-first framing, Secrets
      Adapter pattern documented alongside GoogleSync pattern, explicit
      single-user/no-in-app-gating statement)
    - README.md rewrite (install/run instructions for the actual app, not
      just the MCP server snippet)
  CI/Infra:
    - GitHub Actions workflow: typecheck + lint

NOT YET:
  - Nothing — this is the epic's closing slice

VERIFIED BY:
  - CI itself passing on the PR that adds it
  - Manual doc review

COMMIT REPRESENTS: The epic is done — code and docs agree, and future PRs get
  automated guardrails.
```

## 3. Overlay Diagram

```
VERTICAL SLICE OVERLAY
──────────────────────────────────────────────────────────────────────────────────

              │ Step 1    │ Step 2     │ Step 3    │ Step 4   │ Step 5  │ Step 6  │ Step 7
              │ (shell)   │ (CRUD)     │ (secrets) │ (wizard) │ (sync)  │ (search)│ (docs/CI)
──────────────┼───────────┼────────────┼───────────┼──────────┼─────────┼─────────┼──────────
Desktop Shell │ bootstrap │            │           │          │         │         │
              │ + bridge  │            │           │          │         │         │
──────────────┼───────────┼────────────┼───────────┼──────────┼─────────┼─────────┼──────────
Wizard UI     │           │            │           │ 5 screens│         │         │
              │           │            │           │ (→ Contact UI, no login)      │
──────────────┼───────────┼────────────┼───────────┼──────────┼─────────┼─────────┼──────────
Contact UI    │ list      │ add/edit + │           │          │ sync-now│ search +│
              │ (empty)   │ detail     │           │          │ action  │ log-int │
──────────────┼───────────┼────────────┼───────────┼──────────┼─────────┼─────────┼──────────
Secrets       │           │            │ interface │ write    │         │         │
Adapter       │           │            │ + keychain│ path     │         │         │
              │           │            │ + fake    │          │         │         │
──────────────┼───────────┼────────────┼───────────┼──────────┼─────────┼─────────┼──────────
Google Sync   │           │            │           │          │ pull()  │         │
──────────────┼───────────┼────────────┼───────────┼──────────┼─────────┼─────────┼──────────
Store/Data    │ list()    │ upsert()   │           │ DB path  │ upsert  │ search()│
              │ (new)     │ get()      │           │ resolve  │ dedup   │ logInt()│
              │           │ setVerdict/│           │          │         │         │
              │           │ setNextStep│           │          │         │         │
──────────────┼───────────┼────────────┼───────────┼──────────┼─────────┼─────────┼──────────
Docs/CI       │           │            │           │          │         │         │ rewrite +
              │           │            │           │          │         │         │ CI wf
──────────────────────────────────────────────────────────────────────────────────

Each column is a commit-worthy, working state. No Login/Auth column — descoped
post-H/V-review (single-user-per-instance, no in-app login/logout).
```

## 4. Deferred Items

```
DEFERRED (not in current slice plan):
  - Login/logout UI — descoped entirely (owner decision, post-H/V-review):
    single-user-per-instance; access gating is an outer "super-level"
    system's responsibility, not this app's.
  - Enrichment-on-add (public-lookup auto-fill for org/role/what-they-do) —
    open question #4, explicitly deferred to a fast-follow epic per the
    design discussion; also needs to reconcile with the "no silent guesses"
    convention (grill finding C2) before it's designed.
  - needsFollowUp() / a dedicated "who's gone cold" view — Store method
    exists as a stub; not wired to any UI in this plan. Candidate for the
    same fast-follow epic as enrichment, or its own small epic, since it
    directly serves the north star's stated pain point.
  - Google push() / full two-way sync — one-shot pull only this epic (design
    discussion §3); conflict/merge resolution beyond dedup is out of scope.
  - MCP tool bodies (rolodex_upsert etc.) — explicitly out of scope per the
    north star; a future epic wires them to the same Store once the
    standalone app foundation exists.
  - Portunus secrets adapter / any other secrets backend — interface exists
    (step 3), no second implementation ships in this epic.
  - Cross-platform packaging/distribution — verification strategy (design
    discussion §7) scopes this to the owner's development OS only.
  - A dedicated settings/account screen — re-triggering Google OAuth on token
    expiry, changing `ROLODEX_DB` location after first run, and manually
    re-running the wizard are all real needs (flagged by ui-designer review)
    but not required for the foundation to be genuinely working.
  - Full at-rest database encryption — with login also descoped, there is no
    in-app access control of any kind over the SQLite file; whatever
    protection exists is OS-account/filesystem-level, outside this epic.
  - Comprehensive loading/error/toast state coverage across Contact UI beyond
    each slice's own basic error handling (flagged by ui-designer review) —
    worth a UI-polish pass once the foundation slices are all in.

RATIONALE: each deferred item either has an existing stub that isn't wired to
anything user-facing (safe to leave stubbed — nothing regresses), is
explicitly named as future OSS-contribution surface (Portunus, other secrets
backends) that the adapter boundaries in this epic exist specifically to
enable without requiring it now, or (login/logout) is explicitly out of this
app's architectural boundary per the owner's post-review decision.
```

## 5. Risk by Slice

```
RISK PER SLICE:
  Step 1: High — this is where open question #1 (shell choice) gets settled
    for real; the riskiest unknown in the whole epic lands here.
  Step 2: Medium — first real Store method implementations; dedup logic
    (googleResourceName/email) has edge cases worth getting right early since
    step 5 (Google sync) depends on it.
  Step 3: Medium — OS keychain libraries vary in reliability across
    platforms/shells; also the first place CI-environment limitations
    (headless, no real keychain) may bite — mitigated by the fake adapter CI
    exercises instead.
  Step 4: Medium — most cross-layer fan-out of any single slice (touches
    Wizard UI, Secrets Adapter, Store); OAuth-per-installer onboarding UX
    (design discussion §4) is a real UX risk here, not just a technical one.
  Step 5: Medium — first live external API integration; Google API quota/auth
    edge cases, and the "local fields survive sync" invariant needs a real
    test, not just an assumption.
  Step 6: Low — FTS5 is already schema-defined; this is implementation, not
    design, work.
  Step 7: Low — docs and CI, no functional risk, but skipping it would leave
    the repo self-contradictory (grill finding C1) — don't let this slice
    slip.

  CROSS-SLICE RISK (added after tpm review; updated post-descope): Steps
  3→4→5 form a three-slice serial critical path (secrets adapter → wizard →
  sync) — shorter than the original 3→4→5→6 chain now that the login slice is
  gone, but the same compounding logic applies: a slip or rework in Step 3 or
  4 delays every downstream slice, not just itself. This still compounds with
  Step 3's fake vs. real SecretsAdapter split: CI only ever exercises the
  fake, so a real OS-keychain regression in Step 4 (the heaviest-fan-out
  slice) won't surface until manual verification, not automatically. Treat
  this chain as the epic's actual critical path when sequencing work.
```

## 6. Moldability Notes

- Step 3 (secrets adapter) and Step 4 (wizard) are tightly coupled — Step 4
  can't demo anything real without Step 3 existing first. They could be
  merged into one slice if the team prefers fewer, larger commits; kept
  separate here because Step 3 has its own clean verification story (the
  fake-adapter round-trip test) independent of any UI.
- Step 5 (Google sync) and Step 6 (search/logging) have no dependency on each
  other and could run in either order, or in parallel if resourcing allows —
  both only depend on Step 2's Store/Contact-UI foundation.
- Step 7 (docs/CI) could move earlier (e.g. right after Step 1) if the team
  wants CI guardrails in place before more code lands, at the cost of a
  smaller, less-representative first CI run. Kept last here so the docs
  rewrite reflects the actually-shipped architecture rather than predicting it.
- If Step 1 reveals the chosen shell can't reach `node:sqlite` as cleanly as
  expected (architect's review flagged Tauri specifically), that's a Step-1
  blocker, not a later rework — confirming this is exactly why Step 1 is
  first and thinnest.
- If a future epic decides this app DOES need in-app login after all (e.g.
  the "super-level" wrapping system never materializes and single-instance
  isolation isn't enough), Step 3's SecretsAdapter is already the right place
  to store that credential — re-adding a login slice would be additive, not
  a rework of anything built here.
