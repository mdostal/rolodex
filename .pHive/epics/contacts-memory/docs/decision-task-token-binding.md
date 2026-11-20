# Decision: binding an agent request to its client through the Multica task token

Story `cm-00-task-token-binding-spike` (PANT-1412). Date: 2026-11-20.

**Verdict: GO-FALLBACK.** Use per-client runtime caller tokens. Do not use the task token as the client binding.

Answers 1 to 3 are each half yes. The token is in the agent's environment, and it is revoked when the task ends. But:

- Multica has no endpoint that tells a third party which task a token belongs to.
- Inside one shared runtime container, any agent can read every other concurrent task's token, and the daemon owner's PAT.

So within today's shared runtime, a task token says "some task in this container", not "this client's task". Contacts gating must not rest on it.

## Sources and how they were probed

- `M` = `firefly-events/multica` at `7f7392ac610f7e38b4fad29b112e1c59dcfd4b01` (HEAD of the default branch, 2026-11-17), the source behind `plugins/multica`.
  - Not verified: whether the running `multica-backend-1` image (started 2026-11-18T00:20:34Z, `/health` reports `commit: unknown`) was built from exactly this commit.
  - The live calls below agree with this source on every point they touch.
- `P` = `mdostal/pantheon-v2` `dev` at `033d71ef04cf0d7e56d9747c748ea9fa54cb205d`.
- Live probes ran from inside `pantheon-multica-runtime-1` as the agent user (uid 1000 `node`), against `http://multica-backend-1:8080`.
  - That container sits on the same `10.89.6.0/24` network as `multica-backend-1` (10.89.6.247) and `core-api` (10.89.6.9).
  - The probes were not run from inside the `core-api` container itself.
  - All calls were read-only. No token value was printed, logged or committed: only prefixes, lengths, HTTP status codes and JSON key names.

## 1. Is the task token in the agent's environment?

**Yes.** It is in the env var `MULTICA_TOKEN`, a `mat_` token (44 chars), alongside `MULTICA_TASK_ID`, `MULTICA_AGENT_ID` and `MULTICA_WORKSPACE_ID`.

- The daemon mints the token per task at claim and refuses anything that is not a `mat_` token (`M/server/internal/daemon/daemon.go:166-176`). It injects the token as `MULTICA_TOKEN` (`daemon.go:177-185`).
- Server side, the token is `"mat_" + 40 hex` (`M/server/internal/auth/jwt.go:79-89`). Only its SHA-256 is stored, in `task_token(token_hash, task_id, agent_id, workspace_id, user_id, expires_at)` (`M/server/migrations/108_task_token.up.sql`).
- Live check: `MULTICA_TOKEN` is set in this agent's process, with prefix `mat_` and length 44.

**Isolation finding: this is what breaks the binding.** Every agent process in a runtime runs as the same uid, `node`.

- The daemon only sets `Setpgid` when it spawns an agent (`M/server/internal/daemon/execenv/isolation_unix.go:15-18`). It gives agents no separate uid.
- Live check from this agent: the `/proc/<pid>/environ` files of other processes were readable. They held **11 other concurrent tasks' `MULTICA_TOKEN=mat_…` values** (counted, not printed). Those tasks run on other issues, and other issues can belong to other clients' projects.
- Live check: the daemon's own credential file `~/.multica/config.json` is readable by the agent user. It is mode 600 but owned by `node`, the same user. It holds the operator's `mul_` PAT (prefix and length checked only).
  - The entrypoint writes it there deliberately (`P/bin/multica-runtime-entrypoint.sh:68-76`). Its comment says "the PAT is deliberately not exported", but it is not protected from agents either.

A prompt-injected agent working for client A could therefore send client B's live task token, and Multica would vouch that it is a valid task, a task of client B.

## 2. Which Multica endpoint returns the task's issue and project for a token?

**None today.**

- The `mat_` branch of the auth middleware turns the token into server-set headers: `X-User-ID` (the daemon owner), `X-Agent-ID`, `X-Task-ID` and `X-Actor-Source: task_token` (`M/server/internal/middleware/auth.go:100-135`). No handler returns those to the caller.
- `GET /api/me` (`M/server/cmd/server/router.go:1629`, `M/server/internal/handler/auth.go:473-492`) returns the owning **human user**: keys `id,email,name,…`. No task, agent or issue.
  - Live check: 200, with exactly those user keys.
- `GET /api/agent-task-snapshot` (`router.go:2332`) lists every active task in the workspace, with `id, issue_id, agent_id, status…`, but does not say which task is the caller's.
  - Live check: 200, 22 rows.
- `GET /api/issues/{id}` returns `project_id` for **any** issue in the workspace.
  - Live check: 200. So an issue id the agent supplies proves nothing.
- `GET /api/tasks/{taskId}/messages` (`router.go:2030`, `M/server/internal/handler/daemon.go:5941-5974`) checks only that the task is in the caller's workspace, not that it is the token's own task.
- Live check: `/api/me/task`, `/api/tasks/current`, `/api/task-token` and `/api/whoami` all return 404.

**Smallest Multica change (fork `firefly-events/multica`, `plugins/multica`), if this path is reopened later:** one read-only route in the authenticated group, for example `GET /api/task-token/introspect`.

- It answers 403 unless `X-Actor-Source == "task_token"`. That header is server-set (`auth.go:132-135`; guard pattern in `M/server/internal/handler/actor_guards.go`).
- It loads `GetAgentTask(X-Task-ID)` (the same lookup `issue.go:3983-3997` already does), then the issue, and returns `{task_id, agent_id, workspace_id, issue_id, project_id, status, expires_at}`.
- It answers 401 for a revoked or expired token, for free, through the middleware.
- Size: about 40 lines plus a handler test, and no migration.

This only becomes safe to use for contacts once the isolation gap in answer 1 is closed: a distinct uid per task, or a per-task PID namespace or `hidepid`, plus a daemon PAT that agents cannot read. That is a daemon change, not part of this route.

## 3. Does the token die with the task?

**Yes, best-effort on every terminal transition, with a hard 24h ceiling.**

- Minted with `expires_at = now() + 24h` (`M/server/internal/handler/daemon.go:2103`, `:2432`, `:4045`).
- Every lookup filters `expires_at > now()` (`M/server/pkg/db/queries/task_token.sql:6-8`). A miss is a 401 `{"error":"invalid token"}` (`auth.go:115-120`).
  - Live check: an unknown `mat_` token gets 401 `invalid token`.
- Revoked eagerly on:
  - completion (`daemon.go:4506-4514`, `DeleteTaskTokensByTask`);
  - failure (`daemon.go:5214-5219`);
  - cancellation (`M/server/internal/service/task.go:860-869`).
  - Rows also cascade when the task row is deleted (`108_task_token.up.sql`, `ON DELETE CASCADE`).
- Caveat: each revocation is explicitly non-fatal ("Failure here is non-fatal; the expiry / cascade are the durable guards"). A failed delete leaves a finished task's token valid for up to 24h.
  - `M/server/internal/handler/agent_access.go:205-235` closes that window only for invoke rights (a terminal task gets no originator), not for reads.
  - A consumer that wants strict replay protection must also check that the task status is non-terminal. The proposed introspect route returns `status` for that reason.
- Not live-tested: replaying a real finished task's token. That would have meant using another run's credential.

## 4. Fallback: per-client runtime caller tokens

**Chosen.** Core-api already authenticates callers by token (`P/config/pantheon-callers.yaml`). If each client's agents run in their own runtime container holding their own caller token, core-api knows the client from the caller id alone. It never trusts `body.client`, and it needs no Multica change.

The same-uid problem from answer 1 stays inside one client, because a container only runs that client's tasks.

What it takes, given today's two runtimes:

- **Today:** `multica-runtime` and `multica-runtime-dostal` (`P/docker-compose.yml:740`, `:953`) are split by Multica account (the `MULTICA_RUNTIME_*_MULTICA_TOKEN_TAGS` PATs, `:889`, `:1025`), not by client. Both share the one `runtime-agent` caller (`pantheon-callers.yaml:74-96`), and this runtime alone currently runs tasks from many projects. So neither runtime maps to a client today.
- **Callers:** add one caller entry per client that gets contacts access, e.g. `runtime-agent-<tenant>`. It carries the same routes as `runtime-agent`, plus the contacts routes and a `tenant: <tenant>` field. Mint each token in Portunus as `caller=runtime-agent-<tenant>` (`P/docs/RUNBOOK.md:853-862` shows the minting pattern).
  - The existing `runtime-agent` keeps everything it has and never gets contacts.
- **Runtimes:** add one compose service per such client, cloned from `multica-runtime-dostal`. Give each its own workspaces and state volumes and its own caller-token inject dir.
  - Multica routes a task to a runtime through the agent's runtime binding. So each client needs its own agent set (build/review lanes) bound to its runtime, and the router (`core/tenants/registry.ts` `multica_project_ids`) must assign that client's project issues to that client's agents.
- **Core-api:** the contacts facade resolves the tenant from the authenticated caller's entry. It refuses any caller entry without `tenant`, and ignores or rejects a `client` in the body.
- **Cost:** about 1 container (memory and disk for the agent CLIs) and 1 agent set per opted-in client. Clients that are not opted in keep running on the shared runtime with no contacts access.
- **Residual risk:** the operator PAT in `~/.multica/config.json` is still readable by agents in every runtime. That exposes the Multica board, not contacts, so it does not block this epic. File it separately.

## Decision

- **GO-FALLBACK.** cm-05 (agent contacts access) is built on per-client runtime caller tokens. The contacts facade takes the tenant from the caller entry, never from the body.
- The task-token path is **not** used now. Reopen it only if both of these land in the Multica fork:
  - the introspect route above;
  - per-task process isolation (no cross-task `/proc` reads, daemon PAT unreadable by agents).
  - With both, it becomes a cheaper alternative to one container per client, or a second check layered on top: introspected `project_id` must map to the caller's tenant.
- Operator and Hermes contacts access is unaffected by this decision.
