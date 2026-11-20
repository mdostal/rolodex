# Design discussion: contacts-memory (revision 1, after grill round 1)

`R` = `/pantheon/code/rolodex`, `P` = `/pantheon/code/pantheon-v2`. The facts are in `research-brief.md`; the adversarial findings (V*, H*, U*, C*, P*) are in `grill-record.md`. Each revision below names the finding it answers.

## 1. What are we doing?

We are making Rolodex Pantheon's contacts memory. Mnemosyne remembers code and decisions; Rolodex remembers people: who someone is, how we know them, what was said, and what happens next.

- **Scoped.** Each contact card belongs to exactly one scope.
- **Connected.** Cards link to each other, across scopes too.
- **Agent use.** Agents reach it the way they reach memory: through core-api's generic routes, never by talking to Rolodex directly.

Rolodex keeps working as a standalone desktop app with no login, single user, unchanged. Pantheon is a second way to run it.

Done looks like this:
- An agent running a firefly-events ticket searches contacts and gets only firefly-events' contacts. This is proven by the agent's own Multica task token, not by anything the agent says about itself.
- The operator sees a Contacts card in the Janus Business hub, a focus view, and links across scopes.

## 2. What I found (plus what the grill corrected)

- **Rolodex has no scope.** All three surfaces go through `Store`.
- **Mnemosyne's isolation is the facade's doing.** The facade takes `client` from the request body (H1), and every board agent shares one `runtime-agent` token (`P/config/pantheon-callers.yaml:74-96`).
  - So "agent on a tenant's ticket" is not knowable today.
  - Multica, however, mints a **per-task token** (`task_token`: `task_id`, `agent_id`, `workspace_id`, `expires_at`). Binding a request to a client should start there.
- **Reads under `/api` carry no caller identity, and the caller registry refuses GET grants (H2).** Memory's answer is to make reads `POST` (`POST /api/memory/recall`). Contacts does the same.
- **Board agents are barred from `/mcp` (H3).** Agents use HTTP routes; MCP tools are for the operator and liaisons.
- **"Workspace" ≠ tenant (V1).** dostal-tech and Pantheon's own projects share Multica workspace `f32af269`. The host's real unit is the **client** (tenant id, or `pantheon` for the god repos), exactly as memory uses it.
- **No scope column for settings, Google sync state or push-all (H8). Upsert by caller-supplied id bypasses a WHERE clause (H6).**
- **Rolodex's Portunus backend shells out to a local `portunus` CLI (H5).** In a container it reads injected files instead.
- **Slot plumbing (C3).** A new slot touches:
  - `contracts/l2/slots/catalog.ts`;
  - the manifest schema enum;
  - `manifest.py`;
  - the two pinned slot tests.
  - Loading follows content-publisher: opt-in, 503 until selected. A personal-data service never loads by default.

## 3. Proposed approach

**A. Scope model, in Rolodex `Store` (both modes).**
- A scope is `kind:id`. The kinds:
  - **`client`**: the host's client, `client:firefly-events`, `client:dostal-tech`, `client:pantheon`. This is what the operator calls a workspace (V1, V2).
  - **`user`**: a person's own book. `user:operator` in Pantheon; `user:local` is the standalone app's only scope. The two are separate scopes; an import story copies one into the other (V3).
- No `shared` kind in this cut. Crossing between scopes is done by **links**, not by a scope everyone reads (V5).
- The kind enum is open for later additions (`org`, `project`).
- **`Store` methods take a `ScopeSet {read, write?}`, applied in SQL.**
  - `upsert` with an id first loads the row and refuses one outside `write`.
  - Dedupe uses normalized email/phone **within the write scope** only (H6).
  - `settings` gains a scope column. Google sync state is per scope, and `pushAllToGoogle` pushes only the bound scope (H8).
- **Standalone.** A single adapter supplies `{read:[user:local], write:user:local}`. A dedicated regression suite runs the old behaviour tests against that adapter; "the suite passes" alone doesn't prove standalone behaviour (H10).
- **Deletes and moves (H9).**
  - Deleting a card removes every link touching it, wherever the link was asserted.
  - Cards never move between scopes: copy plus a `same_as` link.
- `ARCHITECTURE.md` gets a "Service mode supersedes single-user for that mode only" section (C1).

**B. Links.**
- A link is `{from, to | toOrg, predicate ∈ same_as|knows|introduced|works_at|reports_to|colleague, note, assertedIn}`.
- Visible only when the caller can read `assertedIn` and both endpoints. Otherwise it is omitted: no stubs, no counts.
- `connections(depth ≤ 2)` walks only visible links.
- `same_as` candidates come only from readable scopes and are never auto-linked.
- Interactions belong to their card's scope. Writing one needs write on that scope (U2 resolves, since no shared scope exists).

**C. Rolodex service mode.**
- `rolodex serve` gives a headless `/v1` API that **implements the host's slot contract (P1)**. The contract comes first.
- **Network.**
  - Its own compose network `contacts` with core-api as the only other member. No published port, not on `default` or `pantheon_agents` (H4: removes 16 reachable neighbours).
- **Token.**
  - The service token is held only by core-api and Rolodex, in a dedicated inject dir `/pantheon-secrets/rolodex` (H4).
- **Request signing.** Each request carries `X-Rolodex-Scopes` plus an HMAC over method, path, body hash, scopes and timestamp, keyed by the service token. Rolodex rejects a missing or bad signature or a stale timestamp (V4).
- **Where the protection lies.** The Store's own scope enforcement protects against SQL slips. It is not a second authority; core-api is (U1, stated plainly).
- **Dropped:**
  - The stdio MCP's remote `ROLODEX_URL` mode (U5).
  - Proxying Rolodex's own UI in Pantheon mode (U4).
- The standalone UI, stdio MCP and CLI stay local-only.

**D. Pantheon side: the generic `contacts` slot.**
- **Contract.** `P/contracts/l2/slots/contacts.ts` plus the catalog entry (`default_implementation: "rolodex"`, opt-in).
- **Facade.** `P/core/tenants/client-contacts.ts` resolves a caller to a `ScopeSet`:
  - **Operator token or Janus session** → everything.
  - **Agent** → it must present its **Multica task token**. core-api verifies the token with Multica, reads task → issue → project, and maps project to client through the tenant registry, which gives `{read:[client:X], write:client:X}`. The body never names the client (H1). No verified task token means 403.
  - **Hermes** (liaison) → read-only on `client:*` scopes it is configured for. It never reads `user:*` (H3).
- **Routes.** All POST: `/api/contacts/{search,get,connections,candidates,followups,upsert,log,link}`.
  - Grants are added to `pantheon-callers.yaml` with call-site citations per its rules (C2).
  - `link` with `same_as` is operator-only.
- **MCP.** Tools `contacts_*` on core-api's `/mcp` for the operator and Hermes.
- **Agent access.** A small runtime helper (like the memory one) sends the task token automatically.

**E. Events and hub.**
- **core-api emits `contacts:*` events itself**, after its own successful writes. Rolodex never calls core-api (H7, no webhook type change).
- Payloads are ids and kind only (no scope id or names), because `GET /api/events` is unguarded.
- The shell renders text by calling the guarded `POST /api/contacts/get` with the operator session (U3: BIZ-11/14 text comes from that read, not from the event).
- **Follow-ups due** come from a read (hub card / needs-you aggregation), not a poll.
- **Hub card.** Built in the Janus shell from `/api/contacts` (operator session): contacts per verdict, follow-ups due, last sync per bound scope. The focus view is a shell view, not a proxied Rolodex UI.

## 4. What could go wrong

- **Cross-client leak (high).**
  - Mitigated by the task-token binding (story 0 proves it before anything is built on it).
  - SQL-level scope enforcement.
  - Property tests.
  - A live negative test: a dostal-tech task token must get 0 firefly cards.
- **Task-token verification isn't possible with Multica as it stands (high).** Story 0 is a spike with a decision gate. Fallback: per-runtime caller tokens (one runtime per client), or agents get no contacts access in this cut. Operator and Hermes access ship regardless.
- **Link existence leak (high).** Omit-don't-stub, tested both directions plus depth 2.
- **Standalone regression (medium).** A dedicated suite; the `user:local` adapter lives in one place.
- **Token custody (medium).** One dedicated inject dir, two holders, one private network.
- **Agent junk contacts (low).** Scoped dedupe, plus `source=agent:<agent-id>` on the card.

## 5. Dependencies and constraints

- `P` rules:
  - no Rolodex-named host code;
  - grants per caller-file rules;
  - `npm run verify` is the merge gate.
- `R` rules:
  - standalone keeps zero Pantheon dependency;
  - Node 24 in the image (fts5).
- Dragon: rootless podman, no buildx, Portunus-vaulted service token. GitHub CI is down under the billing lock, so local suites are the gate.

## 6. Open questions (planner's recommended answers; the operator can override)

1. **Scope kinds.** *Recommend `client` + `user`.* The operator's "workspace" is the host's client.
2. **User ids.** *Recommend `user:operator` now.* Multica member ids come after the member-user split.
3. **Agents and user scopes.** *Recommend never.*
4. **Storage.** *Recommend one SQLite file with scope columns.*
5. **`same_as` links.** *Recommend operator-only;* agents may only see candidates.
6. **If story 0 fails.** *Recommend shipping operator + Hermes access* and filing agent access as its own epic.

## 7. Verification

- **Rolodex.** Scope and link property tests, the standalone regression suite, `serve` signature tests (bad sig, stale, missing).
- **Pantheon.**
  - Facade tests (operator / verified task token / forged or expired token / Hermes).
  - Route grant test.
  - Slot plumbing tests.
  - `npm run verify`.
- **Live.** Task tokens from a firefly ticket and a dostal-tech ticket each see only their own client; a forged token gets 403. In the shell, the Business card and focus view render, and SSE carries `contacts:*` after an upsert.

## 8. Scale

**Large.**
- Two repos plus Janus. The riskiest seam (task-token binding) has no mechanism today, so it goes first as a spike with a decision gate (P2).
- Vertical order:
  1. Story 0: spike.
  2. The host contract.
  3. Store scopes.
  4. Links.
  5. Service mode.
  6. Host slot and facade.
  7. Compose and deploy.
  8. Events.
  9. Hub card.
  10. Live verification.
- Each story leaves both repos working. The slot stays opt-in until story 6 deploys it.
