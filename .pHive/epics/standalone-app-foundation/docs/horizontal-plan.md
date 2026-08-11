# Horizontal Planning Scan: standalone-app-foundation

Input: design-discussion.md (revised) + research-brief.md + owner feedback (Q6
decided: OS keychain via a pluggable `SecretsAdapter`; design principle: one
working integration per extension point now, adapter boundary for the rest).

## 1. Layer Inventory

- **Desktop UI Shell** — does not exist today. New: app bootstrap/window, and (shell-dependent) an IPC bridge between the UI and the Node process holding `Store`.
- **Wizard UI** — does not exist. New: first-run screens taking the user from zero to a working, logged-in app.
- ~~**Login/Auth UI**~~ — **descoped** (owner decision, post-H/V-review): this app is single-user-per-instance with no in-app login/logout; access gating, if any, is an outer "super-level" system's responsibility, not this epic's. Removed as a layer.
- **Contact UI** — does not exist. New: list / detail / add-edit / interaction-log screens, the actual day-to-day surface.
- **Secrets Adapter** — does not exist. New: pluggable interface + one concrete OS-keychain implementation, used by both the wizard (to store OAuth creds) and login/sync (to read them back).
- **Google Sync** (`src/lib/google-sync.ts`) — exists as an interface + stub factory. Modified: real `pull`/`push` implementation.
- **Store / Data layer** (`src/lib/store.ts`) — exists with real schema, stub methods. Modified: real method bodies, plus one new method (`list`/count) surfaced in the design discussion.
- **MCP surface** (`src/mcp/server.ts`) — exists, fully stubbed. **Explicitly excluded from this epic** except for staying wired to the same `Store` instance — listed here only to mark the boundary.
- **Documentation** (`README.md`, `docs/ARCHITECTURE.md`) — exists, describes the pre-pivot MCP-first framing. Modified: rewritten to state the standalone-app-first architecture and the explicit roadmap supersession.
- **CI/Infra** — does not exist. New: minimal lint + typecheck workflow (decided in design discussion §5).

## 2. Per-Layer Requirements

```
## Layer: Desktop UI Shell

BOOTSTRAP:
  - App entry point / main process (shape depends on shell choice — open question #1)
  - Window creation, app lifecycle (launch, quit, single-instance lock so two
    copies don't fight over the same SQLite file)

DATA ACCESS:
  - A bridge from the UI process to `Store` — either in-process (if the shell
    runs Node directly, e.g. Electron main / local-server) or an IPC/RPC layer
    if the UI and Store live in different processes.

BUILD/PACKAGING:
  - Whatever the chosen shell needs to produce a runnable local app (not full
    cross-platform distribution — see design-discussion §7, out of scope)

---

## Layer: Wizard UI

SCREENS:
  - Welcome — first-run entry point
  - Database location — confirm/override ROLODEX_DB (default already correct,
    per store.ts:57-60)
  - Google connect — walks OAuth setup (scope per open question #3: guided
    GCP project creation vs. paste-existing-credentials)
  - Secrets check — confirms the SecretsAdapter can write to the OS keychain
    before proceeding (fail fast, not silently)
  - Finish — hands off directly to Contact UI (no login gate — descoped, see
    below)

FLOW LOGIC:
  - First-run detection (has setup already completed?)
  - Error/retry handling for OAuth failures, keychain write failures

---

## Layer: Login/Auth UI (DESCOPED)

Removed after H/V review: owner decision is single-user-per-instance with no
in-app login/logout. Any access gating happens in an outer "super-level"
system that manages per-user instances, not in this app. No screens, no flow
logic, no cross-layer dependencies from this layer.

---

## Layer: Contact UI

SCREENS:
  - Contact list — reads via `Store.list()` (new method)
  - Contact detail — reads via `Store.get(id)`, shows interaction history
  - Add/edit contact form — writes via `Store.upsert()`
  - Log-interaction action — writes via `Store.logInteraction()`
  - Followups view — reads via `Store.needsFollowUp()` (stretch within this
    epic; see Deferred Items in vertical-plan.md)

COMPONENTS:
  - Contact row/card (name, org, verdict badge, next-step snippet)
  - Verdict picker (strong/watch/referral-only/pass/none)
  - Search box — wired to `Store.search()` once FTS query is implemented

STATE:
  - Local UI state for the currently-selected contact, search query, filter

---

## Layer: Secrets Adapter

INTERFACE:
  - `SecretsAdapter` — `get(key)`, `set(key, value)`, `delete(key)` (exact
    shape TBD at story level; mirrors `GoogleSync`'s interface + factory
    pattern in google-sync.ts:24-42)

IMPLEMENTATIONS:
  - OS-keychain adapter (one concrete implementation this epic ships —
    library choice depends on shell: e.g. `keytar` for Electron/Node, or the
    shell's native credential-store binding)

NOT BUILT THIS EPIC (interface left open for):
  - Portunus adapter (owner-named future integration: key injection/fetching
    via API from an encrypted, secure external store)
  - Any other secret-manager adapter an OSS contributor adds later

---

## Layer: Google Sync

IMPLEMENTATION:
  - `pull()` — `people.connections.list` with pagination, map to `Contact[]`
    (google-sync.ts:19-21 documents the intended API surface)
  - `push()` — `people.createContact` / `people.updateContact`, map
    `resourceName` <-> `Contact.googleResourceName`
  - Credential retrieval via the new SecretsAdapter (not env-var-only, per
    the Q6 decision — env var may remain a fallback/override, TBD at story
    level)

SCOPE FOR THIS EPIC:
  - One-shot pull sufficient to seed the rolodex (per design-discussion §3) —
    full two-way conflict/merge resolution explicitly deferred

DEPENDENCY:
  - New `googleapis` package dependency (not in package.json today)

---

## Layer: Store / Data

NEW METHOD:
  - `list()` (or count/all) — needed by Contact UI's list screen and by the
    wizard/shell's "0 contacts" working-state proof (grill finding H1)

IMPLEMENTED METHODS (bodies only — schema already exists):
  - `upsert` — dedup by googleResourceName/email, preserve createdAt, refresh
    updatedAt, reindex FTS row (per the TODO comment at store.ts:37-38)
  - `get`, `search` (FTS5 MATCH query), `setVerdict`, `setNextStep`,
    `logInteraction`
  - `needsFollowUp` — only if in scope per design-discussion open question #5
    (narrower-scope option leaves this for a later epic)

NO SCHEMA CHANGES:
  - Session/credential state moves to the OS keychain (Q6 decision) — no new
    SQLite table for it, so `contacts`/`interactions`/`contacts_fts` stay as-is

---

## Layer: Documentation

CHANGES:
  - `docs/ARCHITECTURE.md` — new section stating the standalone-app-first
    architecture, explicit statement that this epic supersedes the prior
    build-out roadmap's UI-last ordering (per grill finding C1), and
    documentation of the SecretsAdapter pattern alongside the existing
    GoogleSync pattern
  - `README.md` — rewritten pitch/status reflecting the standalone app as the
    primary way to run rolodex, MCP as secondary

---

## Layer: CI/Infra

CHANGES:
  - One GitHub Actions workflow: `npm run typecheck` + whatever linter is
    picked for the new UI code (design-discussion §5 decision)
```

## 3. Cross-Layer Dependencies

```
DEPENDENCIES:

Wizard UI (Google connect screen)   → Secrets Adapter (write OAuth creds/token)
Wizard UI (Google connect screen)   → Google Sync (trigger initial consent + one-shot pull)
Wizard UI (Database location screen)→ Store (resolve/create ROLODEX_DB path)
Wizard UI (Secrets check screen)    → Secrets Adapter (verify write access before proceeding)
Wizard UI (Finish screen)           → Contact UI (direct hand-off, no login gate — descoped)
Contact UI (list/detail/add/log)    → Store (list/get/upsert/logInteraction — all real bodies)
Contact UI (search box)             → Store.search (FTS5 MATCH implementation)
Google Sync (pull/push)             → Secrets Adapter (retrieve OAuth token per call)
Google Sync (pull)                  → Store.upsert (write pulled contacts, local fields preserved)
Desktop UI Shell                    → Store (in-process or IPC, shell-dependent — open question #1)
Desktop UI Shell                    → Secrets Adapter (same in-process/IPC question applies)
Documentation                       → every other layer (must describe what actually got built)
CI/Infra                            → every code layer (typecheck/lint coverage)
```

These are what vertical planning uses to decide slice boundaries — e.g. the
Wizard UI's Google-connect screen can't be built until the Secrets Adapter
interface (even a minimal one) exists, and Contact UI's list screen can't
demo anything real until `Store.list()` + `Store.upsert()` are implemented.

## 4. Layer Map Diagram

```
HORIZONTAL LAYER MAP
──────────────────────────────────────────────────────────────────────────────

Desktop UI  │ App bootstrap  │ Store bridge   │                │
Shell       │ + window       │ (IPC/in-proc)  │                │
────────────┼────────────────┼────────────────┼────────────────┼──────────────
Wizard UI   │ Welcome + DB   │ Google connect │ Secrets check  │ Finish (→
            │ location       │ screen         │ screen         │ Contact UI)
────────────┼────────────────┼────────────────┼────────────────┼──────────────
Contact UI  │ List screen    │ Detail screen  │ Add/edit form  │ Log-interaction
            │                │                │                │ action
────────────┼────────────────┼────────────────┼────────────────┼──────────────
Secrets     │ Adapter        │ OS-keychain    │                │
Adapter     │ interface      │ implementation │                │
────────────┼────────────────┼────────────────┼────────────────┼──────────────
Google Sync │ pull()         │ push()         │                │
            │ (real)         │ (real)         │                │
────────────┼────────────────┼────────────────┼────────────────┼──────────────
Store/Data  │ list() (new)   │ upsert/get/    │ search (FTS5)  │ needsFollowUp
            │                │ logInteraction │                │ (maybe deferred)
────────────┼────────────────┼────────────────┼────────────────┼──────────────
Docs / CI   │ ARCHITECTURE.md│ README.md      │ lint/typecheck │
            │ rewrite        │ rewrite        │ workflow       │
──────────────────────────────────────────────────────────────────────────────
```

## 5. Scope Summary

```
HORIZONTAL SCOPE:
  Layers affected: 8 (Desktop UI Shell, Wizard UI, Contact UI, Secrets
    Adapter, Google Sync, Store/Data, Documentation, CI/Infra — Login/Auth UI
    removed post-H/V-review, single-user-per-instance with no in-app gating)
  Total items: ~26 (screens + methods + adapter implementations + doc/CI items)
  New vs modified: ~20 new, ~6 modified (Store methods, Google Sync methods,
    README.md, docs/ARCHITECTURE.md)
  Estimated total effort: large

  LARGEST LAYER: Contact UI (4 screens/actions, each depending on a different
    real Store method) and Wizard UI (5 screens with the most cross-layer
    fan-out) are roughly tied for largest.
  RISKIEST LAYER: Desktop UI Shell — still gated on open question #1 (shell
    choice), and it's the layer every other UI layer depends on for its
    Store/Secrets Adapter bridge shape.
```
