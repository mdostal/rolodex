# Research brief: contacts-memory

Requirement (operator, 2026-11-20): "tie in and get the rolodex as a solid plugin so that it has its own version of a memory like mnemosyne, it is purely contacts and can be specific to a workspace, to a user, etc and can cross or have connections".

Two codebases are involved: `R` = `/pantheon/code/rolodex` (mdostal/rolodex, branch `dev`, v0.5.0) and `P` = `/pantheon/code/pantheon-v2` (mdostal/pantheon-v2, branch `dev`).

## Rolodex today (R)

- **Store.** `R/src/lib/store.ts:44-81`, `node:sqlite` in WAL mode, a single file (`ROLODEX_DB`, otherwise a user-data dir). The tables:
  - `contacts(id, name, org, role, email, phone, met, what, angle, verdict DEFAULT 'none', nextStep, tags, googleResourceName, googleEtag, createdAt, updatedAt)`
  - `interactions(id, contactId FK CASCADE, at, note, channel)`
  - `settings(key, value)`
  - `contacts_fts` (fts5). It exists only when the Node build has fts5, and falls back to a LIKE scan otherwise. Node 24, which is on dragon, has fts5.
  - **No scope, owner or tenant column exists anywhere.** "Single-user-per-instance" is a deliberate rule (`R/README.md`, `R/docs/ARCHITECTURE.md`).
- **Surfaces.** Three, all over the same `Store`:
  - a loopback HTTP shell (`R/src/shell/server.ts`, port 4173: `/api/contacts`, search, needs-follow-up, interactions, verdict/next-step PATCH, Google sync, plus a first-run wizard under `/setup/*`);
  - an MCP server over stdio (`R/src/mcp/server.ts:144-297`): `rolodex_upsert`, `rolodex_search`, `rolodex_followups`, `rolodex_log_interaction`, `rolodex_sync_google`, `rolodex_delete`;
  - a CLI (`R/src/cli/index.ts`) wrapping the same handlers.
  - Electron wraps the shell unchanged.
- **Secrets.** `SecretsAdapter` (`R/src/lib/secrets-adapter.ts`) has keychain, Portunus and in-memory backends (epic `portunus-secrets-backend`). Google OAuth tokens live there.
- **No auth, health route or events.** The shell has no auth and no `/health`, and emits no events (`P/.pHive/epics/pantheon-vision-blueprint/docs/requirements/business-hub.md`, BIZ-10, BIZ-13).
- **Dormant Pantheon stub.** `R/src/integrations/pantheon.ts` and `R/docs/PANTHEON.md` sketch a `service` descriptor and a `proxy` web-plugin entry. Nothing imports either.
- **Tests.** vitest (`npm test`, with `NODE_OPTIONS=--experimental-sqlite`). There are co-located `*.test.ts` files for store, sync, secrets and MCP, so methodology auto-detects as **tdd**.

## Mnemosyne, the pattern to mirror (P)

- **Mnemosyne owns no store.** It wraps the `swarm-memory` CLI over Qdrant. A "scope" is a named collection (`P/plugins/mnemosyne/src/engine.mjs:157-170`), and Mnemosyne itself does not check who is asking.
- **Isolation lives in core-api, in the memory facade** (`P/core/tenants/client-memory.ts`):
  - client scope = tenant id (`:32`), repo scope = `<tenant>--<repo>` (`:37`);
  - recall queries each allowed scope separately with no escalation, then drops any hit outside the allowed set (`:503-523`).
- **Agents use core-api's generic routes, never the god directly.** They call `POST /api/memory/{recall,remember,ingest}` (`P/core/api/memory.ts:6-15`), also exposed as core-api MCP tools `recall`/`remember` (`P/core/api/mcp-tools.ts:615-645`).
- **Slot.** Memory is a slot: `P/contracts/l2/slots/catalog.ts:111`, `default_implementation: "mnemosyne"`.
- **Wiring:**
  - `P/pantheon.gods.yaml:247-257`;
  - `P/plugins.manifest.yaml:141-156`: kind god, slot memory, port 8477;
  - `P/pantheon.web-plugins.json:94-103`: a proxy;
  - compose `P/docker-compose.yml:1500-1590`.
- **Writes** are gated by `MNEMOSYNE_ADMIN_TOKEN` (`P/plugins/mnemosyne/src/server.mjs:332-346`). **Reads are open**, which is acceptable for code memory and not for contacts (PII).
- **Graph.** Mnemosyne has one global, scope-less edge store with no visibility check (`engine.mjs:684-694`). Rolodex must design scoped links itself; there is nothing to reuse.

## Host rules that constrain the design (P)

- **No god-specific code in the host** (`P/.pHive/CONTEXT.md` hard exclusions). The business-hub requirement already flags `core/api/gigradar.ts` as violating it. Rolodex must therefore enter as the implementation of a **new generic slot**, not as a Rolodex-named core module.
- **Callers.** Named callers live in `P/config/pantheon-callers.yaml`. Each has a Portunus-vaulted token (`provider=pantheon,kind=caller-token,caller=<id>`) and an explicit route list, and the guard is enforce-only (first-cut-trust).
- **Networks.** The agents network `pantheon_agents` is `isolate:strict`, and agents reach core-api only.
- **Events.** Cross-process events are `L1Event` envelopes POSTed to a core webhook, then fanned out fire-and-forget (`R/docs/PANTHEON.md`; `P/docs/cross-god-event-flow.md`). The shell's SSE `/api/events/stream` carries bus events to Janus.
- **Tenants** (`P/core/tenants/registry.ts`). Each tenant = one Multica workspace (`multica.workspace_id`, `:20`, `:270`). Today, "workspace" and "tenant" are 1:1 in practice.
- **No per-user identity in core-api.** The operator token and named callers exist. Janus pairs one operator session (`__Host-janus_session`). There is no per-human user id.

## Inconsistency risk signals

1. **"Workspace" vs "tenant."** The operator said workspace. The host keys everything by tenant, and a tenant owns one Multica workspace. If a story picks one word without fixing the mapping, the scope keys drift.
2. **"User."** The operator said user, but core-api has no per-human identity. A user scope needs an id source: the operator now, Multica members later.
3. **Standalone vs plugin.** The standalone app's "no auth, single user" rule must stay true for desktop users while service mode adds auth. This is a conditional rule, not a reversal.
4. **"Like Mnemosyne."** Mnemosyne's reads are open and its graph is unscoped. Copying it literally would leak contacts across tenants.
