# Design Discussion: standalone-app-foundation

## 0. Prelude

**NORTH STAR** (`.pHive/project-profile.yaml`, captured at kickoff 2026-08-11):
- Goal: standalone desktop app — own UI, own install/setup wizard, own login — with the MCP/Pantheon integration as a secondary layer added after the app exists, not before.
- Audience: single user per install/deploy; each person runs their own instance against their own data, gated behind login.
- Pain points: poor personal follow-up discipline; hard to track a contact's niche/context without day-to-day proximity.

No prior KG decisions were found for this topic (`kg_why` query returned zero results) — clean slate, no PRIOR DECISIONS section.

## 1. What Are We Doing?

Today rolodex is a headless MCP server scaffold: real types, a real SQLite+FTS5
schema, a real Google-sync interface — and every method body throws `not
implemented`. There is no UI, no login, no install flow. This epic is the
foundation for turning it into what the owner actually wants to run day to day:
a standalone desktop app they open, set up once through a wizard, log into, and
then use directly to manage their rolodex — log calls, see who's gone quiet,
capture a contact's niche and next step. The MCP server becomes a second way to
reach the same data later, not the thing we build first.

"Done" for this epic specifically is the **foundation**, not the full feature
set: a working desktop shell with a setup wizard that gets a first-run user from
zero to a logged-in, working contact list backed by the real `Store`, with
Google Contacts as the first sync source. Deep enrichment-on-add, multi-provider
sync beyond Google, and the MCP tool bodies are explicitly follow-on scope (see
§6).

## 2. What I Found

- `src/lib/types.ts` already has the right domain model (`Contact`, `Interaction`) — the UI's data layer should consume these directly, no duplication.
- `src/lib/store.ts`'s `Store` class is real (SQLite WAL + FTS5 schema is migrated on construction) but every method (`upsert`, `search`, `needsFollowUp`, etc.) is a stub. This is good news structurally: the UI can be built against `Store`'s existing method *signatures* even before the bodies are implemented, and "implement the store" becomes parallelizable, bounded work underneath the UI.
- `docs/ARCHITECTURE.md`'s "core / your layer" split (repo is generic, credentials/DB path are env-driven) is a constraint I want to keep, not fight — the setup wizard should still resolve to `ROLODEX_DB` + OAuth env/token files, not invent a second config system.
- Nothing in `package.json` supports a desktop UI today — no Electron/Tauri, no DOM lib in `tsconfig.json`, no auth library. This is genuinely new dependency surface, not wiring existing pieces together.
- `docs/ARCHITECTURE.md` and `README.md` both currently frame the project as "a Pantheon plugin / MCP tool" first, with a UI listed as an *optional, last* line in the build-out roadmap. That's the opposite of what we're building now — those docs need rewriting as part of this epic, not left to drift out of sync with the code.
- No auth/session/login concept exists anywhere in `src/` — "login" is 100% new surface.

## 3. My Proposed Approach

I'd sequence this in three layers, each producing a genuinely working state.

**Login/logout — DESCOPED from this epic (owner decision, post-H/V-review):** this app assumes a **single user per instance**. Any access gating (login/logout, multi-tenant boundaries) happens **around** this app, at a "super-level" system that manages per-user instances and wires each one to its own contact adapter(s) — not inside this app. This epic builds **no login/logout UI, no PIN gate, no session model**. That resolves what was open question #2 outright (not "PIN vs. OAuth-as-gate" — neither; there's no in-app gate at all) and removes the layer-2/3 boundary ambiguity the earlier draft flagged. The `SecretsAdapter` (below) still exists, but purely to store this instance's Google OAuth credentials — not any session/login state.

1. **Shell + data layer wiring.** Pick a desktop shell (see open question #1) and stand up the minimal app window that boots, imports `Store` from `src/lib/store.ts` directly (same process or a thin IPC bridge, shell-dependent), and renders *something* real from it — even just "0 contacts" is a real working state because it proves the UI is reading the actual SQLite store, not a mock. **Note (revised after grill H1):** `Store` currently has no list/count method — only `get(id)`, `search(query)`, `upsert`, `needsFollowUp`, and the setters. A `list()` (or equivalent count/all) method is new surface that belongs in this slice's `Store` scope alongside `upsert`; without it there's nothing for the UI to render even in the empty case.
2. **Setup wizard.** First-run flow: choose/confirm `ROLODEX_DB` location (default already exists — `~/.local/share/rolodex/rolodex.db`), walk the user through Google OAuth credential setup (this is the awkward part — each installer needs their own GCP OAuth client; the wizard should link out to clear steps rather than automate GCP project creation itself), and land directly in the working contact UI — no login gate to land on.
3. **Core contact UI.** The actual contact list / detail / add-contact UI wired to `Store`'s real methods (which get implemented as part of this same slice, since the UI can't demo anything real against stubs). **Session/credential storage — DECIDED (owner):** an OS keychain/credential-store, accessed through a new `SecretsAdapter` interface (mirroring the existing `GoogleSync` interface pattern in `src/lib/google-sync.ts`: interface + factory + swappable concrete implementation). This epic ships exactly one concrete adapter (OS keychain, via a library like `keytar` or the platform-native equivalent for the chosen shell) storing this instance's Google OAuth credentials; the interface boundary is what lets a future OSS contribution add a `Portunus` adapter (or any other secret manager) without touching `Store` or the UI. SQLite stays credential-free.

Google sync (`src/lib/google-sync.ts`) plugs in as the wizard's "connect Google Contacts" step and as a sync action inside the app — but the full two-way sync engine doesn't have to be perfect for this epic; a working one-shot pull to seed the rolodex is enough to prove the loop end to end.

The MCP server (`src/mcp/server.ts`) is explicitly **not** touched by this epic beyond making sure `Store` stays the single source of truth both surfaces can eventually share.

**Team-review note on layer 3 weight (TPM):** layer 3 as scoped bundles several converging pieces of work — the new session/credential-adapter decision (Q6), the bulk of `Store`'s real method implementations, and the one-shot Google sync — while layer 1 is a comparatively thin demo. That imbalance is real and should be named explicitly (and likely re-sliced) in the structured outline / H-V planning that follows this document, not discovered mid-execution.

**Team-review note on UI screen specification (ui-designer):** this document names the UI surfaces (wizard, contact list/detail/add) but does not specify a screen inventory, navigation model, per-screen field content, or state coverage (loading/error/empty beyond "0 contacts") — that level of detail is out of scope for a design discussion and belongs to the `/design` wireframe delegation that story decomposition triggers for UI-shaped stories (per `/plan` step 16). Flagging here so it isn't lost: the stories this epic produces for the wizard/list/detail/add surfaces should each route through that delegation before implementation, not skip straight to code.

## 4. What Could Go Wrong

- **High** — Scope collision: it's easy for "build the UI" to quietly turn into "also finish implementing Store/sync/MCP" without an explicit boundary. I'm drawing that boundary at "the store methods the UI's first working slice actually calls" — not the full stub list. `needsFollowUp`, full FTS `search`, and MCP tool bodies can lag behind the UI's initial needs.
- **High** — Desktop shell choice is a real lock-in decision (bundle size, update mechanism, Node-runtime access for `node:sqlite`) made under real uncertainty right now — see open question #1. Getting this wrong costs a rewrite, not a refactor.
- **Medium** — OAuth-per-installer is a genuine onboarding UX problem for an OSS "everyone runs their own instance" tool; if the wizard doesn't handle this gracefully, first-run experience could be worse than the current zero-UI state. **Also a security surface, not just UX (added after security-reviewer review):** the wizard is a new secret-input surface (OAuth client secret, later tokens) and must inherit `docs/ARCHITECTURE.md`'s "secrets never committed" rule explicitly — every wizard field that touches a credential needs a stated destination (env var / gitignored local file) at design time, not left implicit via the general core/your-layer separation in §5.
- **Medium** — `docs/ARCHITECTURE.md` and `README.md` actively describe the old MCP-first framing; if this epic ships UI code without updating those docs, the repo will contradict itself for new contributors (flagged by the cross-cutting documentation concern). **Decision (revised after grill C1):** this epic explicitly **supersedes** `docs/ARCHITECTURE.md`'s existing build-out roadmap ordering (which lists a UI as an optional, last-priority item) — not just a docs-sync nice-to-have. The doc-rewrite story should say this outright, not merely update the roadmap's item order silently.
- **Low** — `Store` is fully synchronous today (`DatabaseSync`); if the UI shell requires the store calls to happen off a main/UI thread, we may need a thin async wrapper. Worth deciding the data-access contract before, not after, implementing the stub bodies.

## 5. Dependencies and Constraints

- New external dependency: a desktop UI framework (decision pending, §6 Q1) and, per that choice, possibly a bundler/build pipeline distinct from the current `tsc`-only build.
- New external dependency: `googleapis` (or equivalent) for the People API calls `google-sync.ts` currently only documents.
- New external dependency: an OS-keychain access library (shell-dependent — e.g. `keytar` or the desktop framework's native credential-store binding) for the `SecretsAdapter`'s default implementation.
- **Design principle (owner, post-review):** this epic's job is capability, not coverage — ship Google Contacts as the one working sync integration and OS keychain as the one working secrets backend, each behind an adapter interface (matching the existing `GoogleSync` pattern). Do not build out multiple sync providers or multiple secrets backends now; the adapter boundary is what lets the OSS community add more later (Portunus, other CRMs/contact sources, etc.) without core changes. This governs scope for §8 as much as any single file — resist scope growth toward "also support X" during story decomposition.
- Constraint: must preserve the "core knows nothing about a specific user" separation — wizard-collected config still resolves through env vars / `.local/`, never gets written into tracked source.
- Constraint (added post-H/V-review): this app is **single-user-per-instance** with **no in-app access gating**. If it's ever run somewhere the local machine/account boundary isn't sufficient access control on its own, that's the responsibility of whatever "super-level" system wraps this instance — not this epic. State this explicitly in the docs rewrite (§4) so it isn't mistaken for an oversight later.
- Constraint: must preserve "local fields survive sync" (`verdict`/`angle`/`nextStep` never overwritten by a Google pull) once sync bodies are implemented.
- No CI/lint/pre-commit exists yet (per kickoff). **Decision (revised after grill U1):** since this epic adds a second surface (UI) on top of the existing MCP surface, a minimal lint + typecheck CI step is IN SCOPE for this foundation epic — not deferred. It doesn't need to be elaborate (one GitHub Actions job running `npm run typecheck` plus whatever linter gets picked for the new UI code is enough), but shipping a second surface with zero guardrails is the kind of gap that compounds silently.

## 6. Open Questions

1. **Desktop shell**: Electron, Tauri, or a local-server-plus-browser-tab approach? **Not a coequal three-way trade-off (revised after architect review):** `Store` hard-requires `node:sqlite`, i.e. a Node runtime. Electron's main process runs Node natively — `Store` imports cleanly with a standard contextBridge IPC to the renderer. Local-server-plus-browser is the cleanest technical fit (`Store` just runs in an ordinary Node process). Tauri's core is Rust — reusing `Store` without a rewrite means shelling out to a Node sidecar process, which erodes Tauri's main selling points (small bundle, no bundled runtime) and reintroduces an IPC layer functionally equivalent to the local-server option, minus its simplicity. Tauri is the technically weakest fit given the no-rewrite constraint; still worth a conscious decision (there may be non-technical reasons to prefer it), but it shouldn't win by default.
2. ~~**Login semantics**~~ — **DECIDED (owner, post-H/V-review):** no in-app login/logout at all. Single-user-per-instance; access gating (if any) lives in an outer "super-level" system that manages per-user instances and their contact-adapter wiring, not in this app. See §3.
3. **Setup wizard scope for OAuth**: does the wizard walk the user through creating their own GCP OAuth client interactively, or assume credentials are already provisioned and just ask the user to paste them in?
4. **Enrichment-on-add**: real usage signal (surfaced during kickoff) is wanting a quick public-info lookup when adding a new contact, to speed up capturing org/role/what-they-do/niche. Is that in this epic's MVP add-contact flow, or explicitly deferred to a fast-follow epic? I'd lean **defer** — it's a genuinely new external-lookup dependency, and the foundation epic is already large without it (see §8). **Carried forward (revised after grill C2):** whichever epic eventually designs this must explicitly reconcile it with CONTEXT.md's "no silent guesses" convention (agents leave a field blank rather than inventing org/angle/verdict) — auto-filled fields from a lookup need a clear provenance/confidence marker, not silent overwrite. Noting this now so it isn't lost between this epic and that one.
5. Does this epic's "foundation" include implementing the full `Store` stub surface, or only the subset the first UI slice actually calls? I've proposed the narrower scope in §3/§4 (now explicitly including a new `list()`/count method per Q6-adjacent finding H1) — confirm or override.
6. ~~**Session persistence**~~ — **DECIDED (owner, post-review):** OS keychain/credential-store, not a SQLite table — matches the security-reviewer's recommendation. Further: this is built as a **pluggable secrets adapter**, not a hardcoded keychain call — same shape as the existing `GoogleSync` interface (`src/lib/google-sync.ts`: an interface + a factory + one concrete implementation). Ship one real backend (OS keychain) for this epic; leave the interface open for future backends. The owner specifically named an eventual `Portunus` adapter (key injection/fetching via API from an encrypted, secure external store) as a future OSS contribution — this epic does not build Portunus, but the adapter boundary must exist so it *can* be built without touching core. See §3 and §5 for what this adds to scope.

## 7. Verification Strategy

```
VERIFICATION PLAN:
  Tools: vitest (already configured; unit tests for Store methods as they're
         implemented), plus whatever the chosen desktop shell's standard E2E
         tool is (e.g. Playwright for Electron, or the shell's native option) —
         to be pinned once §6 Q1 is decided.
  Platforms: desktop OS the owner develops on first (macOS, per this session's
         environment); cross-platform packaging is explicitly out of scope for
         this foundation epic.
  Automated: Store method bodies (unit), setup wizard happy-path (E2E once shell
         is chosen).
  Manual: OAuth consent flow (can't fully automate a real Google consent
         screen), first-run wizard experience end to end.
  Not verifying: Google sync conflict/merge edge cases (sync is a one-shot pull
         for this epic, not the full two-way engine); multi-user/concurrent
         access (north star is explicitly single-user-per-install).
```

## 8. Scale Assessment

```
SCALE ASSESSMENT:
  Files affected: ~15-25+ (new UI app directory/package, wizard flow, new
    SecretsAdapter interface + OS-keychain implementation, Store method
    implementations incl. a new list()/count method, google-sync
    implementation, rewritten README.md + docs/ARCHITECTURE.md with explicit
    roadmap supersession, new package.json dependencies/scripts, a minimal CI
    lint/typecheck workflow)
  Subsystems: new desktop UI shell, setup/config flow, new pluggable
    secrets-adapter layer for Google OAuth credentials (OS keychain now,
    Portunus/others later — no session/login use), existing SQLite store
    (implementation, not just wiring, including new list surface), existing
    Google sync adapter (implementation), documentation, CI. No auth/login
    subsystem — descoped, see §3.
  Migration required: no (no existing UI/data to migrate — this is additive)
  Cross-team coordination: no (single owner/single-user tool)
  Unknowns: 4 open questions remain (Q1, Q3, Q4, Q5; Q2 login semantics and
    Q6 session/secrets storage are both resolved — no in-app login, OS
    keychain via a pluggable SecretsAdapter for OAuth creds only). The
    biggest remaining unknown is desktop shell choice (Q1), which materially
    changes the file manifest and dependency list.

  RECOMMENDATION: Needs structured outline (Large)
  RATIONALE: This is a multi-system foundation (new UI layer + auth + wizard +
    two existing-but-unimplemented subsystems, plus a documentation rewrite to
    resolve the standing architecture-framing conflict) with a genuine
    long-horizon lock-in decision (shell choice) still open. Horizontal/vertical
    slicing plus a full structured outline with elicitation is warranted before
    story decomposition — this is exactly the kind of plan where getting the
    first vertical slice wrong (e.g. picking a shell that can't reach
    node:sqlite cleanly) is expensive to unwind.
```
