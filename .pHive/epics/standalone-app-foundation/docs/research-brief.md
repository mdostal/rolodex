# Research Brief: standalone-app-foundation

## Summary

rolodex is a v0.1.0 scaffold: a generic-core/user-layer TypeScript project with a
fully-typed data model, a SQLite+FTS5 store, a Google People sync adapter, and an
MCP stdio server — but every method body across `Store`, `google-sync`, and the
five `rolodex_*` MCP tools throws `not implemented`. There is currently **no UI
of any kind, no auth/login, and no install/setup flow** — the only way to run the
project today is `tsx src/mcp/server.ts` as a stdio process for an MCP host. The
north star (`.pHive/project-profile.yaml → north_star`, captured at kickoff)
calls for a standalone desktop app with its own UI, setup wizard, and login,
with the MCP surface becoming a secondary interface into the same store. This
brief grounds that gap in the actual code.

## Key files & surfaces

- `src/lib/types.ts` — `Contact` (id/name/org/role/email/phone/met/what/angle/verdict/nextStep/tags/googleResourceName/createdAt/updatedAt), `Interaction` (id/contactId/at/note/channel), `SearchResult`. Single source of the domain model; the future UI's data layer should consume these types directly rather than duplicating them.
- `src/lib/store.ts` — `Store` class wrapping `node:sqlite` (WAL mode). `migrate()` creates `contacts`, `interactions`, and an FTS5 virtual table `contacts_fts` on `(name, org, role, what, angle, tags)`. Every public method (`upsert`, `get`, `search`, `needsFollowUp`, `setVerdict`, `setNextStep`, `logInteraction`) is a stub that throws `not implemented`. DB path resolves from `ROLODEX_DB` env var, defaulting to `~/.local/share/rolodex/rolodex.db` (outside the repo).
- `src/lib/google-sync.ts` — `GoogleSync` interface (`pull`/`push`) and a `createGoogleSync()` factory whose returned methods both throw `not implemented`. Comments document the intended setup (People API enablement, OAuth Desktop client or service account, `contacts` scope) but no `googleapis` dependency exists yet in `package.json`.
- `src/mcp/server.ts` — stdio `McpServer` registering `rolodex_upsert`, `rolodex_search`, `rolodex_followups`, `rolodex_log_interaction`, `rolodex_sync_google` via zod-validated tool schemas. Every handler returns a hardcoded "not implemented yet" text response and never calls into `Store` or `GoogleSync` (both are constructed but discarded with `void store` / `void google`).
- `package.json` — `bin: { "rolodex-mcp": "dist/mcp/server.js" }`, scripts `build` (tsc), `dev` (tsx), `typecheck`, `test` (vitest run). No UI framework, no bundler for a desktop shell (no Electron/Tauri/Wails), no auth library, in dependencies or devDependencies.
- `docs/ARCHITECTURE.md` — the only existing design doc. States the "core knows nothing about any specific user" separation and a build-out roadmap that is MCP/store-focused; does not mention a standalone UI app anywhere. This is the document most in tension with the north star (see Constraints below).
- `.pHive/project-profile.yaml → north_star` — goal/audience/success/avoid fields captured at kickoff (2026-08-11), the authoritative statement of the standalone-app direction for this epic.

## Patterns & conventions

- **Generic core / user layer split** (`docs/ARCHITECTURE.md`): the repo (`src/`) must stay ignorant of any specific user's data or credentials; per-install config lives in env vars and `.local/` (gitignored). Any new UI/wizard/login work should preserve this — e.g., wizard-collected config still resolves to `ROLODEX_DB` / OAuth env vars, not new source-tracked config files.
- **Single write path to SQL**: `Store` is documented as the only module allowed to write raw SQL. A UI/desktop shell should call into `Store` (or a thin service layer above it), not open its own DB connection.
- **Local-field sync-safety rule**: `verdict`/`angle`/`nextStep` are local-only and must survive a Google pull (documented in `docs/ARCHITECTURE.md`, not yet enforced by any implemented code since sync is unimplemented). Any UI/enrichment feature that writes these fields must respect the same rule once sync is implemented.
- **No-silent-guess rule**: agents/tools should leave a field blank rather than invent org/angle/verdict. Relevant if the UI adds an auto-enrichment step (see Open Questions).
- **Stub convention**: every unimplemented method throws `new Error("not implemented — <what it needs to do>")` with a `TODO(build):` comment above it describing the exact remaining work — a clear, consistent marker for what "finish the scaffold" means, independent of the UI question.

## Constraints

- **No UI runtime exists in dependencies.** Adding a standalone desktop UI requires picking and adding a UI shell (Electron/Tauri/other) and a rendering stack — a real new dependency surface, not a config toggle. `tsconfig.json` currently only targets `src/**/*.ts` (Node/ESNext, `Bundler` resolution) with no DOM lib.
- **`node:sqlite` is a Node built-in** (Node 22+, per `@types/node: ^22.0.0`) — a desktop shell needs a Node runtime available to it (Electron's main process, or a sidecar process) to keep using the same `Store` without a rewrite. If a UI framework requires a non-Node runtime for its main process, `Store`'s `node:sqlite` dependency becomes a porting decision, not just a wiring one.
- **Architectural framing conflict**: README and `docs/ARCHITECTURE.md` currently describe this project primarily as "a Pantheon plugin / MCP tool" with the MCP surface as the main interface. The north star inverts that priority (standalone app first, MCP second). Both docs will need to be rewritten as part of this epic, not just the code — otherwise the docs actively mislead future contributors about the project's shape.
- **Zero auth/login code exists.** `verdict`/credentials handling has no session or login concept anywhere in `src/`. A "login" per the north star (gating a per-install app) is new surface, not an extension of something present.
- **No CI, no linter, no pre-commit hooks** (confirmed at kickoff) — any new UI code lands without automated guardrails until those are set up, which raises the risk of drift once a second surface (UI) is added alongside the MCP surface.

## Risks

- **High** — Scope collision between "finish the existing MCP/store stubs" and "build a new standalone UI app" if not sequenced explicitly. The north star's `avoid` field explicitly warns against letting the plugin/MCP integration become the primary focus before the UI exists — the epic must sequence UI-and-setup-wizard-first, store/MCP-implementation as enabling work underneath it, not the other way around.
- **Medium** — Choosing a desktop UI framework is itself an architecture decision with long-term lock-in (Electron bundle size/update story vs. Tauri's Rust toolchain requirement vs. a lighter local-web-server + browser UI approach). This should be an explicit design-discussion decision point, not an implicit default.
- **Medium** — `Store` is currently fully synchronous (`node:sqlite`'s `DatabaseSync`) with no implemented methods yet — safe to design the UI's data-access contract now (sync or thin async wrapper) before real method bodies exist, but changing the sync/async contract *after* implementation lands would be a bigger rewrite.
- **Low** — Google People API scope (`.../auth/contacts`, full read+write) requires an OAuth consent screen; for a distributable OSS "each person installs their own" tool, every installer needs their own GCP OAuth client (the doc references the owner's specific project `personalsites-487021` as an example, not a shared client) — the setup wizard must walk a new user through creating their own OAuth credentials, which is a real onboarding UX problem, not just a code path.

## Open questions

1. Desktop shell choice (Electron / Tauri / local-server-plus-browser / other) — blocks UI stack decisions in design discussion.
2. Does "login" mean local-only (a password/PIN gating the local app + local data) or does it mean "sign in with Google" doubling as both the People-API auth grant and the app gate? The north star says "logins... behind a login" but doesn't specify local vs. Google-backed.
3. Should the setup wizard collect Google OAuth credentials interactively (guided GCP project creation) or expect the user to arrive with credentials already provisioned?
4. Scope for this epic specifically: does "foundation" include implementing the `Store`/`google-sync`/MCP stub bodies, or only the new UI shell + wizard + login shell with the stubs remaining as follow-up epics? (Affects H/V slicing.)
5. The "quick enrichment on add" capability surfaced during kickoff (auto-populate org/role/what-they-do from a quick public lookup when adding a contact) — is this in scope for this epic's MVP wizard/add-contact flow, or a fast-follow epic? It directly serves the stated pain point (niche/context tracking) but adds a new external-lookup dependency not present anywhere in the current scaffold.

## Inconsistency risk signals

**present** — for the grill pass to focus on:

- README.md and docs/ARCHITECTURE.md both frame this project as MCP/Pantheon-plugin-first; the design discussion this epic produces will assert the opposite priority (standalone-app-first). This is a direct, documented contradiction between existing repo docs and the new plan, not a hypothetical risk.
- The existing build-out roadmap in `docs/ARCHITECTURE.md` ("Implement Store bodies", "Implement Google sync", "Wire MCP tool bodies", "CSV importer", "Optional: read-only web/board view") ranks a UI as an *optional, last* item. The north star ranks it first-and-required. Any plan that doesn't explicitly reconcile or supersede that roadmap risks silently contradicting it.
- No `has_ui` signal existed anywhere in the codebase (no UI deps, no frontend dir) before this kickoff — `has_ui: true` in the project profile is a forward-looking classification, not a description of current state. Grill should check that the design discussion doesn't conflate "classified as consumer-app with UI" with "already has UI."
