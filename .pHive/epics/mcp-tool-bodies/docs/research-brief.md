# Research Brief: mcp-tool-bodies

## Summary

`src/mcp/server.ts` registers all 5 originally-designed `rolodex_*` MCP tools with real zod schemas, but every handler is a stub returning "not implemented yet" text. Every `Store`/`GoogleSync` method these tools need now exists and is real (built across the last two epics): `upsert`, `get`, `search`, `needsFollowUp`, `logInteraction`, `setVerdict`, `setNextStep`, `getFollowUpConfig`, and `GoogleSync.pull()`. This epic wires the tool bodies to those real methods — no new backend logic, pure integration.

## Key files & surfaces

- `src/mcp/server.ts` (70 lines) — the whole surface. Constructs `Store` and `GoogleSync` at module scope (`const store = new Store()`, `const google = createGoogleSync()`) but every handler discards them (`void store` / `void google`) instead of calling them.
- `src/lib/store.ts` — every method this epic needs already exists and is tested: `upsert(c): Contact`, `get(id): Contact | undefined`, `search(query, opts?): SearchResult[]`, `needsFollowUp(withinDays?, graceDays?): Contact[]`, `logInteraction(i): void`, `setVerdict`/`setNextStep`.
- `src/lib/google-sync.ts` — `pull(): Promise<Contact[]>` is real (implemented in `saf-05`, reads OAuth creds from `SecretsAdapter`, paginated People API call, preserves local-only fields via `applyPullToStore`/`mergeLocalOnlyFields`). `push()` is still an unimplemented stub — explicitly out of scope for the whole project (design-discussion.md from `standalone-app-foundation` scoped one-shot pull only).
- `src/lib/secrets-adapter.ts` — `google.oauth.client`/`google.oauth.token` keys already established by the wizard/sync work; `pull()` already reads them internally, nothing new needed here.

## Patterns & conventions

- `Store` is the single point of SQL access — MCP handlers call `Store` methods, never touch SQLite directly (already true of every other consumer: `src/shell/server.ts`).
- MCP tool responses use `{ content: [{ type: "text", text: ... }] }` — the existing stub bodies show the shape; real bodies need to return meaningful text (e.g., JSON-stringified results, or a human-readable summary) rather than a placeholder string.
- `node:sqlite` requires `--experimental-sqlite` on this repo's Node 22.x — already true for every other entry point (`shell`, `test`); `package.json`'s `dev` script (which runs `src/mcp/server.ts`) already has this flag wired (fixed during `saf-01`'s optimize pass).
- Same-process concern: the MCP server and the shell server both construct their own `Store` instance against the same `ROLODEX_DB` file. `node:sqlite`'s WAL mode (already configured in `Store`'s constructor) is what makes concurrent access from two separate processes safe — no new work needed, just worth confirming this is understood, not accidentally broken.

## Constraints

- `rolodex_sync_google`'s existing schema accepts `direction: "pull" | "push" | "both"` (default `"both"`) — but `push()` doesn't exist. The tool body needs to handle `push`/`both` gracefully (a clear "not implemented" response for the push half) rather than crashing, while `pull` works for real.
- MCP tool handlers should follow the codebase's existing "no silent guesses" convention (`.pHive/CONTEXT.md`) — e.g., `rolodex_upsert` should not invent values for fields the agent didn't provide.
- No UI-facing change — this epic is backend/protocol wiring only, so the UI Step Detection keywords (screen/form/button/etc.) don't apply; no `/design` delegation needed.

## Risks

- **Low** — every method being wired is already implemented and unit-tested; this is integration, not new logic. The main risk is response-shape ergonomics (what should `rolodex_search` return — raw JSON, a formatted list?) rather than correctness.
- **Low** — `rolodex_sync_google`'s partial-push-support UX (see Constraints) needs a clear, non-crashing answer but isn't architecturally risky.

## Open questions

1. **Response format**: should tool responses return JSON-stringified data (machine-friendly, lets the calling agent parse fields) or human-readable summaries (friendlier if a human is reading the agent's tool-call transcript)? Given these tools are meant for *agents* to consume and act on (not primarily for human reading), I'd lean JSON — but worth confirming.
2. **`rolodex_sync_google` with `direction: "push"` or `"both"`**: return an error, or silently only do the pull half and note push isn't available yet?

## Inconsistency risk signals

**present** — for the grill pass to focus on:

- The tool schema for `rolodex_sync_google` already commits to a 3-way `direction` enum including `"push"`, which doesn't have a real implementation to call — the design needs to explicitly reconcile this rather than silently ignoring the schema's stated capability.
