# Grill Record — contacts-memory

**Source draft:** `/pantheon/code/rolodex/.pHive/epics/contacts-memory/docs/design-discussion.md`
**CONTEXT.md substrate:** present (`/pantheon/code/pantheon-v2/.pHive/CONTEXT.md`; Rolodex has no `.pHive/CONTEXT.md`, so `R/docs/ARCHITECTURE.md` and `R/README.md` stood in for Rolodex conventions)
**inconsistency_risk_signals:** present (`research-brief.md`, "Inconsistency risk signals" 1-4)
**round_number:** 1
**unresolved_count:** 25
**Generated:** 2026-11-20T13:12:55-06:00

`R` = `/pantheon/code/rolodex`, `P` = `/pantheon/code/pantheon-v2`, as in the draft. Draft line numbers refer to the draft as read for this pass.

## Summary

- Vocabulary mismatches: 5 findings
- Hidden assumptions: 10 findings
- Unresolved tensions: 5 findings
- Convention violations: 3 findings
- Posture mismatches: 2 findings

## Vocabulary mismatches

- **V1** — "workspace = one Pantheon tenant = one Multica workspace" does not match the live registry (risk signal 1).
  - Draft location: lines 14, 49 ("one Pantheon tenant = one Multica workspace"), 141.
  - Reference: `P/.pantheon-tenants.yaml` puts tenant `dostal-tech` on Multica workspace `f32af269-…`. `P/.pHive/CONTEXT.md` ("Multica project registry") lists that same workspace as the home of all 8 Pantheon projects, which is the work of the `pantheon` client (`PANTHEON_CLIENT`, `P/core/tenants/client-memory.ts:18`). One Multica workspace therefore holds two "workspaces" in the draft's sense (`workspace:dostal-tech`, and the pantheon client's scope). `P/core/tenants/registry.ts:270` requires `workspace_id` but never checks that it is unique.
  - Question for planner: Is the scope id defined by `tenant_id` alone, with the "= one Multica workspace" equivalence dropped? If not, how does a scope tell dostal-tech work apart from Pantheon-core work when both sit in `f32af269`? And which identifier will `user:<multica-member-id>` (line 142) be relative to?

- **V2** — "the Flayr workspace" uses a god's name as if it were a tenant.
  - Draft location: line 15 ("that card in the Flayr workspace").
  - Reference: Flayr is the `content-publisher` slot's implementation (`P/contracts/l2/slots/catalog.ts`). The live tenants are `dostal-tech` and `firefly-events`.
  - Question for planner: Should the example name a real tenant scope? Or does the operator mean something else by "Flayr workspace" (a brand or account) that needs its own scope kind?

- **V3** — The operator's personal book has two names: `user:local` and `user:operator`.
  - Draft location: lines 54-55 (backfill to `user:local`, standalone ScopeSet) vs lines 48, 119, 142 and 158 (`user:operator`).
  - Reference: earlier in the draft (§3A kinds list).
  - Question for planner: Are these the same scope? What scope do rows get when a desktop `user:local` database, or a Google sync made under one, is brought into the service, where the book is `user:operator`?

- **V4** — "signed-by-token request header" describes a signature that does not exist.
  - Draft location: line 80 ("in a signed-by-token request header (`X-Rolodex-Scopes`)").
  - Reference: §3C itself. A bearer token sent next to a plaintext header signs nothing, and nothing in the draft binds the header's contents to the token (no HMAC, no nonce). Any holder of the token can assert any ScopeSet, including "all scopes".
  - Question for planner: Is "signed" meant literally, with a MAC over the scope set and the request? If not, should the wording say "a header accepted only with the bearer token", and should §4 "Header trust" rate the risk as such?

- **V5** — `shared:pantheon`, and "the pantheon client → `shared:pantheon`", reverse the meaning that the memory facade gives the pantheon client's scope.
  - Draft location: lines 50 and 86-88.
  - Reference: `P/core/tenants/client-memory.ts:20-21`: `top`, "Pantheon's own cross-repo scope. Only the pantheon client may read or write it." In the draft, the pantheon client *writes* into a scope that every tenant's agents *read* (line 87).
  - Question for planner: Is `shared:pantheon` meant to be Pantheon-core's private book (memory's meaning) or a commons that every tenant reads? If it is a commons, who may write it? Is it really the pantheon client, whose agents are also board agents on `f32af269` (V1)?

## Hidden assumptions

- **H1** — The draft assumes core-api can tell "an agent on a tenant's ticket" and resolve it to that tenant's scope. Nothing identifies that today.
  - Draft location: lines 21, 87, 158.
  - Why this matters: Every board agent in both runtimes (`multica-runtime` and `multica-runtime-dostal`) shares one caller token, `runtime-agent` (`P/config/pantheon-callers.yaml:74-77`, inject dirs for both runtimes). The memory facade the draft "mirrors" takes `client` from the request body (`P/core/api/memory.ts` `recallSchema.client`; the MCP `recall` tool in `P/core/api/mcp-tools.ts` takes `client` as an argument). Its isolation is a prompt instruction (`client-memory.ts:861-866`: "never use … another client's scope"). The draft's own reasoning (line 32) says that is fine for code memory but not for PII. Copied as is, any agent can ask for `workspace:dostal-tech`. The live check on line 158 would pass only because each agent passes its own tenant, so it proves nothing about isolation.
  - Question for planner: What binds a contacts request to one tenant? Per-runtime or per-tenant caller tokens, a required ticket id that core-api resolves to project and then tenant, or something else? If the answer is "the agent says which tenant", does the epic accept that for PII, and say so in §4?

- **H2** — The draft assumes contacts reads are guarded. Reads under `/api` are unguarded by design (FCT-D3), and the caller registry refuses GET grants.
  - Draft location: lines 79, 90-91, 155.
  - Why this matters: `request.caller` is null on any unguarded request (`P/core/api/middleware/operator-token.ts:28-33`, `:408`). `caller-registry.ts:254` stops core-api at startup on any `GET /api/...` grant ("GET is only guarded on /mcp; reads under /api need no entry"). Suppose search, get, connections, candidates, followups or the hub-card counts are GETs. Then the line-91 grants cannot be written, and each route has to call `guard.identify()` itself. If one forgets, it answers with whatever ScopeSet an anonymous request resolves to, and core-api sits on the `agents` network. Suppose instead they are POSTs. Then they are "writes" to the guard, and every reader, the operator's shell included, needs a token on them.
  - Question for planner: Which HTTP method does each `/api/contacts/*` route use? Does every read route resolve the caller itself? What ScopeSet does a request with no token get (the "no scope" facade test, line 154)? Is it the empty set, and is that tested on every route?

- **H3** — The draft assumes agents can use `contacts_*` MCP tools, and it leaves Hermes's ScopeSet undefined.
  - Draft location: lines 16, 90-91, 143.
  - Why this matters: The `runtime-agent` entry says "Never: /mcp …", and `core/api/self-approval.test.ts` holds that (`pantheon-callers.yaml:109-110`). Board agents reach memory over HTTP, guided by the injected `memoryInstructions`, not over MCP. Only Hermes (a liaison that relays the operator into Slack) and the operator use `/mcp`. The facade rules on lines 86-89 cover operator, agent, pantheon client and `user:*`. They do not cover a liaison. If Hermes resolves as "operator", it reads `user:operator`, which Q3 (line 143) reserves for the operator session and token, and it carries that data into Slack.
  - Question for planner: How do board agents learn about and call contacts: an injected instructions block like `memoryInstructions`, or something else? Which ScopeSet does a liaison caller get?

- **H4** — The draft assumes "only core-api holds the service token" and that leaving the `agents` network out is enough network isolation.
  - Draft location: lines 80, 93-95, 116-118.
  - Why this matters:
    - At least four holders are implied. Rolodex needs the token to verify requests. The focus-view proxy needs credentials (U4). The stdio MCP with `ROLODEX_URL` needs it (U5). Rolodex also needs *its own* caller token to POST events, because `/api/feed/events/webhook` is a guarded write and is not on `OPERATOR_TOKEN_ALLOWLIST` (`operator-token.ts:75-82`).
    - "Through Portunus inject" names no dir. The shared `/pantheon-secrets` volume is mounted by core-api, consus, heimdall, janus, janus-shell, pantheon-app and portunus (compose).
    - On the default network, rolodex is reachable from hermes, auriga-*, hellsing, consus, heimdall, janus, janus-shell, pantheon-app, portunus, ops-checker, lavish-axi, edge, mnemosyne, argus-collector, claud-ometer and docker-events-proxy. The token is the only barrier, and per V4 a token holder can choose any ScopeSet.
  - Question for planner: Who holds which token, in which per-caller inject dir? Does Rolodex get a `pantheon-callers.yaml` entry with its own token, inject dir and webhook route? Should rolodex sit on a dedicated network shared only with core-api, rather than on `default`?

- **H5** — The draft assumes Rolodex's existing Portunus support means "a container needs no keychain".
  - Draft location: line 40.
  - Why this matters: `R/src/lib/secrets-adapter.ts` (backend #2, around lines 211-275) shells out to a locally installed `portunus` CLI (`execFile`, `portunus resolve` / `drop` / `reg`) against its own `PORTUNUS_HOME`. That is not Pantheon's Portunus service or its `/api/secrets/inject` files. Service mode needs somewhere to read the service token and to store Google OAuth tokens (`GOOGLE_OAUTH_TOKEN_KEY`, written through `SecretsAdapter.set`).
  - Question for planner: Does the service image ship the `portunus` CLI and a vault? Or does service mode need a new read-only, file-backed adapter that reads injected files, and if so, where do Google OAuth refresh tokens get written?

- **H6** — The draft assumes that "applied in SQL `WHERE`" covers writes. `Store.upsert` writes by a client-supplied primary key, and its dedupe is global.
  - Draft location: lines 56-58, 120.
  - Why this matters: `R/src/lib/store.ts:96-150` dedupes on `googleResourceName`, then on *exact* email, across the whole table. It then runs `INSERT … ON CONFLICT(id) DO UPDATE` with `existing?.id || c.id`, and `c.id` comes from the caller (MCP `UpsertArgs.id`). A `WHERE` scope clause does not apply to the conflict branch. A caller that supplies another scope's id updates that row, or moves it if the scope columns are in the `SET` list. A `ScopeDenied` raised there instead becomes an existence oracle. Contact ids are exposed to agents through the bus (H7). The "normalized email" dedupe on line 120 does not exist yet.
  - Question for planner: How does upsert treat a supplied `id` outside the write scope: ignore it, 404 it, or deny it? How does the answer avoid confirming the id exists? Do both dedupe keys, `googleResourceName` included, become scope-local, and is there a property test on the conflict path?

- **H7** — The draft assumes contacts events reach only the operator's SSE, and that core's webhook accepts them.
  - Draft location: lines 99-101, 159.
  - Why this matters: Bus events are also served by the unguarded `GET /api/events`, which returns the whole in-memory log (`P/core/api/events.ts:359-361`) and is reachable from the agents network through core-api. They are also fanned out to external subscribers registered through `POST /api/events/subscriptions`. Ids plus scope tell every agent which tenants have contact activity, and when, and they hand out contact ids (H6). Separately, `/api/feed/events/webhook` validates a discriminated union of `consus.*` types (`P/core/api/feed.ts:123-…`) and needs `?origin=`. `contacts:*` L1Events would be rejected unless a new type or route is added.
  - Question for planner: Which ingest route do contacts events use? Should events with a scope be kept off `GET /api/events` and off external subscriptions, or carry no scope and no contact id there?

- **H8** — The draft assumes the per-install state Rolodex keeps today stays meaningful when one database serves many scopes.
  - Draft location: lines 102, 119.
  - Why this matters: The `settings` table (follow-up window and grace, appearance) has no scope column (`store.ts:257-308`), so one follow-up window applies to every tenant's "follow-ups due". `pushAllToGoogle` pushes `store.list()`, which is every contact, into the connected Google account (`R/src/lib/google-sync.ts:556-575`). `applyPullToStore` matches against `store.list()` (`:466-478`). The hub card's "last sync" assumes one sync.
  - Question for planner: Which settings become per-scope? Is push restricted to the bound sync scope, and where is that binding stored? Is "last sync" per scope or global?

- **H9** — The draft says nothing about delete or move once cards are linked across scopes.
  - Draft location: §3B (lines 62-74); the route list on line 90 has no delete, while `rolodex_delete` exists (`R/src/mcp/server.ts`) and the shell has `DELETE /api/contacts/:id`.
  - Why this matters: Suppose a card in `workspace:firefly-events` is deleted. Links asserted in `user:operator` (for example `same_as`) either dangle or are cascade-deleted by a caller who cannot see them. `deleteContactEverywhere` also deletes the linked Google contact. A scope change on upsert (H6) has the same problem.
  - Question for planner: Who may delete a card that another scope's assertion depends on? What happens to those links, and is the Google-side delete limited to the sync-bound scope?

- **H10** — The draft assumes "the existing suite passes unchanged, apart from call-site updates" is a meaningful guard against standalone regressions.
  - Draft location: lines 113-115, 151.
  - Why this matters: A required `ScopeSet` on every Store method touches about 160 Store call sites in `store.test.ts`, `shell/server.test.ts`, `mcp/server.test.ts` and `google-sync.test.ts`. It also touches the structural `UpsertableStore`, `DeletableStore` and `PushableStore` interfaces in `google-sync.ts`. Once every assertion's call site is rewritten, "unchanged" no longer pins the old behaviour. Standalone mode also relies on things service mode changes: the explicit `127.0.0.1` bind (`R/src/shell/server.ts:918`), the wizard gate (`isWizardCompleted` returns 409 "setup not complete"), and `ROLODEX_DB` precedence (`R/src/shell/db-location.ts:90-94`).
  - Question for planner: What fixed, unmodified standalone check proves no regression? For example, a golden run of the shell and MCP against a pre-migration database copy, or the default-ScopeSet adapter tested on its own while Store tests take the new signature.

## Unresolved tensions

- **U1** — The draft wants Rolodex to enforce scope itself and also to trust core-api's resolution.
  - Draft location: line 32 ("must check scope inside its own Store too, not only trust the facade") vs line 80 ("Rolodex trusts core-api to have resolved it").
  - Tension: The Store enforces whatever ScopeSet the header carries. That catches a missing SQL clause, but not a wrong or forged ScopeSet (H1, V4), which is the more likely way contacts leak across tenants.
  - Question for planner: Which threat is Store-level enforcement for? Should §4 say that tenant isolation rests entirely on core-api's caller-to-scope resolution and on custody of the token?

- **U2** — Interactions inherit the contact's scope, while agents read `shared:pantheon` but write only their own workspace.
  - Draft location: lines 59, 87, 91 (runtime-agent gets `log`).
  - Tension: When a firefly-events agent logs an interaction, or changes the verdict or next step, on a `shared:pantheon` card, either the write is refused (so `contacts_log` fails on every shared card), or it lands in `shared:pantheon` and dostal-tech agents can read firefly's notes. The rule "payloads carry ids and scope" also assumes a single scope per write.
  - Question for planner: Can an interaction's scope differ from its contact's, for example a per-tenant note on a shared card? Or are agents barred from annotating shared cards, with that made visible in the tool contract?

- **U3** — The draft keeps names out of events, while the business-hub spec wants a line of text per event and per needs-you item.
  - Draft location: line 101 ("never names or emails") vs line 104 ("Follow-ups due feed the needs-you queue").
  - Tension: BIZ-11 (`P/.pHive/epics/pantheon-vision-blueprint/docs/requirements/business-hub.md:71`) requires every event to carry "one line of text" and the account tag. BIZ-14 (`:77`) makes each contact needing follow-up an item in the needs-you queue with its kind and age. Without a name those lines cannot be read. With a name, PII goes onto a bus with unguarded readers (H7).
  - Question for planner: Is the text rendered at read time by an operator-only route, from the id? Or does BIZ-11 get an explicit exception for contacts?

- **U4** — The focus view is "the Rolodex UI framed through the proxy, scoped by the operator session", while service mode requires a bearer token on every read.
  - Draft location: line 103 vs line 79; lines 77 and 96.
  - Tension:
    - The pantheon-app proxy adds a `writeCredential` only on non-read methods (`P/lib/proxy-write-auth.ts:47`).
    - It forwards client headers verbatim (`P/lib/proxy-handler.ts:109`), so a browser-sent `X-Rolodex-Scopes` passes through.
    - It checks no operator session on GETs (`P/proxy.ts`).
    - The Rolodex UI calls `/api/contacts…`, not `/v1/*`, and expects the wizard gate.
    - Making the UI's reads work means injecting the service token on reads, and then anything that can reach `pantheon-app:3013` on the default network, Hermes included, reads every scope.
  - Question for planner: Does the focus view go through core-api's `/api/contacts` with the operator's identity (a shell-native view), or is the proxy extended with session-gated read credentials and header stripping? Is that extension generic host code or Rolodex-specific code? Which UI routes does `ROLODEX_UI=1` mount, and are the wizard and `/api/wizard/database*` routes excluded?

- **U5** — The stdio MCP gets a `ROLODEX_URL` remote mode, while agents must "never talk to Rolodex directly" and only core-api holds the token.
  - Draft location: line 81 vs lines 16, 80 and 117; line 93 (rolodex on the default network only, no published port).
  - Tension: A remote stdio MCP client must hold the service token and build `X-Rolodex-Scopes` itself, which bypasses the facade. On dragon it also has no route to the service.
  - Question for planner: Who is the `ROLODEX_URL` mode for? If it is the operator's own MCP client, what token and ScopeSet does it use, and how does it reach the service? If no one needs it, is it out of scope?

## Convention violations

- **C1** — Scoped, authenticated access inside one Rolodex instance contradicts Rolodex's recorded owner decision.
  - Draft location: §3A, §3C, line 144 (Q4).
  - Convention: `R/docs/ARCHITECTURE.md:370-385`, "Single-user, no in-app login — deliberate, not an oversight". The decision says that where the machine boundary is not enough, access control "is the responsibility of whatever 'super-level' system wraps and deploys per-user instances of it — not something this app implements internally". The research brief's risk signal 3 says this must be framed as a conditional rule. The draft never states that it amends this section. Q4 rejects per-scope files only because of links, without weighing the per-instance model the doc prescribes.
  - Question for planner: Will the epic explicitly supersede the ARCHITECTURE.md decision, with a rationale and a doc story? Or will it align with it, with Pantheon deploying per-scope instances and the host owning cross-scope links?

- **C2** — The caller-route plan does not follow `pantheon-callers.yaml`'s rules, and it misstates what the route test checks.
  - Draft location: lines 91, 127, 156.
  - Convention: `P/config/pantheon-callers.yaml` header:
    - every route "cites the call site that makes it today";
    - GET grants under `/api` are rejected at load (H2);
    - `runtime-agent` never gets `/mcp`;
    - a service that posts to core needs its own entry, with a token and an inject dir.
    
    The test checks that each *listed* route exists. It does not check that every new write route is listed (line 127).
  - Question for planner: Will the plan list exact `METHOD /pattern` grants with call-site citations? Will it add a `rolodex` (or slot-generic) caller entry for the events POST? Does a new guard rule depend on "a test checks the routes exist"?

- **C3** — Adding a `contacts` slot touches more than `catalog.ts`, and the draft cites two different loading precedents.
  - Draft location: lines 34-36, 84-85, 96.
  - Convention:
    - `schemas/plugins-manifest.schema.json` must keep its slot enum equal to `SLOT_NAMES` (`schemas/plugins-manifest.schema.test.ts`), and `install/lib/manifest.py` validates against it.
    - `contracts/l2/slots/catalog.test.ts:17-31` pins the sorted slot list.
    - `core/plugins/slots.test.ts:65-67` expects every slot to resolve to its default.
    - The `memory` slot the facade "mirrors" has `contract: null`, and core-api calls Mnemosyne's HTTP API directly (`DEFAULT_MNEMOSYNE_URL` in `client-memory.ts`).
    - The `content-publisher` slot loads a god-supplied adapter from `plugins/`, and only once it is selected (`P/core/api/content.ts:156-165`); being the default alone does not load it, so the routes answer 503 until then.
  - Question for planner: Which precedent does `contacts` follow: a direct HTTP facade or a loaded adapter? Is `rolodex` active just by being the default, or opt-in like Flayr? Do the schema, `manifest.py` and test updates belong to story 5?

## Posture mismatches

- **P1** — The host's slot contract is derived from the god's wire API.
  - Draft location: line 137 ("C's route shapes are the contract D implements against"), line 85 (facade mirrors `client-memory.ts`).
  - Posture reference: `P/.pHive/CONTEXT.md`, Terminology › Adapter: "each god's own repo implements a Pantheon adapter … against Pantheon's generic hosted APIs. No god-specific code lives in Pantheon." Also the hard exclusion of god-specific code. With one implementation, and a contract whose shape is Rolodex's `/v1` called directly from core-api, the "generic" slot is Rolodex's API under another name.
  - Question for planner: Is the contract written host-first, with Rolodex adapting to it (for example a Rolodex-repo adapter module, as with content-publisher)? Or is the inverted order an accepted deviation, and if so, written down with its justification?

- **P2** — The epic is sized "medium with `--fast`, no separate H/V doc", although its riskiest seam has not been proven.
  - Draft location: lines 161-175.
  - Posture reference: `P/.pHive/CONTEXT.md`, "PoC-gate artifact templates (Large epics)". The gate asks for "the narrowest demoable slice that proves the riskiest seam … before full build-out stories are written". This epic spans two repos, nine stories, PII, a new slot, compose, events and UI. Its riskiest seam, caller-to-tenant binding (H1) with token custody (H4), has no existing mechanism. Yet the story order puts it at story 5, after the Store, links, service API and MCP are built.
  - Question for planner: Is this Large, with a PoC that proves agent-to-tenant isolation end to end before stories 1-4? Or is "Large-ish medium" kept, with a written reason why the PoC gate does not apply?

## Notes

- Link visibility as stated (line 70: read on `assertedIn` and on both endpoints, otherwise omit) holds up for `connections(depth≤2)` and for `same_as` candidates limited to readable scopes. Under that rule this pass found no leak *through the graph walk itself*. The leak paths found are next to it: unguarded reads and counts (H2), the bus (H7), the upsert conflict path (H6), notes on shared cards (U2), and the proxy (U4). `toOrg` targets are unscoped strings, so an org name typed in one scope is global by construction. That is probably fine, but it is worth saying so.
- Risk signal 4 ("like Mnemosyne") is handled for reads and the graph. It returns through the facade: the memory facade's real isolation mechanism is a caller-supplied `client` plus prompt instructions (H1).
- The research brief (line 46) says "agents reach core-api only". That is correct for networks, but core-api's unguarded GETs (`/api/events`, and any GET contacts route) are then exactly what agents can reach.

## Out of scope (this pass)

Grill does not propose solutions, score quality, gate work, or prioritize findings. Each finding ends with a question for the planner. The planner's job is to revise the draft, or document accepted deviations, before stories are written.
