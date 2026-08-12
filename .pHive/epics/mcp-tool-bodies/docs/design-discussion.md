# Design Discussion: mcp-tool-bodies

## 0. Prelude

No prior KG decisions found for this topic (clean slate). This directly serves the north star's MCP framing: "MCP is a secondary integration surface, letting your AI agents read, search, and update the same rolodex" (`package.json` description, rewritten in `standalone-app-foundation`).

## 1. What Are We Doing?

Wiring the 5 already-scaffolded `rolodex_*` MCP tools to the real `Store`/`GoogleSync` methods that now exist. This is the last unimplemented surface in the whole project — every tool's zod schema is real, every backend method it needs is real and tested; only the glue between them is missing. "Done" is: an MCP host (Claude Desktop, another agent) can add this server and actually read/write the owner's rolodex through it, not get "not implemented yet" strings back.

## 2. What I Found

- All 5 tools (`rolodex_upsert`, `rolodex_search`, `rolodex_followups`, `rolodex_log_interaction`, `rolodex_sync_google`) have real, already-correct zod input schemas — no schema changes needed, just handler bodies.
- Every `Store` method these tools need is implemented and tested across the last two epics (`upsert`, `get`, `search`, `needsFollowUp`, `logInteraction`, `setVerdict`, `setNextStep`).
- `GoogleSync.pull()` is real; `push()` is still a stub — a real, existing gap between the tool schema's `direction: "push"|"both"|"pull"` option and what's actually implemented.
- Both the MCP server and the shell server construct independent `Store` instances against the same SQLite file; WAL mode (already configured) makes this safe.

## 3. My Proposed Approach

1. **`rolodex_upsert`** → call `store.upsert(args)`, return the saved contact as JSON. No new validation needed — the zod schema already enforces types; `Store.upsert()` already has its own dedup/timestamp logic.
2. **`rolodex_search`** → call `store.search(query, { verdict, limit })`, return the `SearchResult[]` as JSON.
3. **`rolodex_followups`** → call `store.needsFollowUp(withinDays)`, return the `Contact[]` as JSON. (`graceDays` isn't in this tool's existing schema — leaving it out of scope for this epic rather than silently expanding the schema; it already has a sensible persisted default via `getFollowUpConfig()`, same as the UI.)
4. **`rolodex_log_interaction`** → call `store.logInteraction({ id: randomUUID(), contactId, note, at: at ?? new Date().toISOString(), channel })`, return the created interaction as JSON.
5. **`rolodex_sync_google`** → for `direction: "pull"` or `"both"`, call `google.pull()` then route each result through `Store.upsert()` (reusing the exact `applyPullToStore`/local-fields-preserving merge logic already built for the shell's "Sync now" button — not reimplementing it). **Confirmed (revised after grill H1):** `applyPullToStore`, `mergeLocalOnlyFields`, and `findExistingMatch` are already exported from `google-sync.ts` (verified directly — `export function applyPullToStore(...)` etc.) — no visibility change needed, this is a straight import. For `direction: "push"`, return a clear, structured "not implemented — push is out of scope for this project" response rather than crashing or silently no-op-ing; `"both"` performs the pull half and notes push wasn't performed.

**Response format (resolves open question #1): JSON-stringified data**, not human-prose summaries. These tools exist for an agent to parse and act on programmatically — that's the whole point of the north star's "let your AI agents read, search, and update" framing. `{ content: [{ type: "text", text: JSON.stringify(result) }] }` matches the MCP SDK's text-content shape while giving the calling agent structured data to work with.

## 4. What Could Go Wrong

- **Low** — this is thin integration over already-tested logic; the main way to get it wrong is a response-shape mismatch (e.g., forgetting to `JSON.stringify`, or returning the wrong field), not a logic bug.
- **Low** — `rolodex_sync_google`'s pull path reusing `applyPullToStore` avoids re-implementing the local-fields-survive-sync invariant a second time (which would be a real risk if duplicated instead of reused).
- **Medium, resolved (revised after grill H2)** — error handling: none of the 5 handlers currently have a try/catch. `Store.upsert()` etc. can throw (e.g., a genuine SQLite error). **Concrete mechanism confirmed:** the `@modelcontextprotocol/sdk`'s tool-result type has an optional `isError: boolean` field (verified directly in the SDK's type definitions) — the standard pattern is `{ content: [{ type: "text", text: <error message> }], isError: true }` on failure, same content shape as success but flagged. Every one of the 5 handlers wraps its body in try/catch and returns this shape on error, so a thrown Store/GoogleSync error surfaces as a clean, structured MCP error response rather than crashing the stdio process (which would take down every other tool with it, mid-session, for whatever host is connected).

## 5. Dependencies and Constraints

- No new dependencies — `randomUUID` is already used elsewhere (`node:crypto`, already imported in `store.ts`).
- No schema changes to the tool definitions themselves.
- `rolodex_sync_google` reuses `google-sync.ts`'s local-fields-preserving merge logic rather than duplicating it — confirmed already exported (`applyPullToStore`, `mergeLocalOnlyFields`, `findExistingMatch`), a straight import, no visibility change needed.

## 6. Open Questions

Both resolved above (§3): response format is JSON, `push`/`both` return a clear not-implemented note for the push half rather than crashing.

No blocking open questions remain.

## 7. Verification Strategy

```
VERIFICATION PLAN:
  Tools: vitest — the MCP SDK's server can be tested by calling tool handlers
         directly against a test Store instance (no real stdio transport
         needed for unit tests), following the same pattern already used for
         src/shell/server.test.ts (real Store, temp SQLite file, no mocks).
  Platforms: same as the rest of the app.
  Automated: unit tests per tool — upsert persists and returns the contact;
         search returns real matches; followups reflects real overdue
         contacts; log_interaction persists and appears in history; sync
         pull populates contacts and preserves local fields (reusing the
         same invariant test pattern from saf-05); sync push returns the
         not-implemented response without crashing.
  Manual: one real end-to-end smoke test — start the MCP server via `npm run
         dev`, connect a real MCP client (or use the SDK's stdio client
         directly in a scratch script) and call each tool once against a
         scratch ROLODEX_DB.
  Not verifying: real Google OAuth consent flow (already out of scope
         project-wide, no real credentials in this environment).
```

## 8. Scale Assessment

```
SCALE ASSESSMENT:
  Files affected: ~2 (src/mcp/server.ts + 1 new test file) — google-sync.ts
    needs no change, its helpers are already exported (§3, §5)
  Subsystems: MCP protocol surface only — no Store/GoogleSync logic changes,
    pure integration
  Migration required: no
  Cross-team coordination: no
  Unknowns: none blocking

  RECOMMENDATION: Proceed to stories (Small)
  RATIONALE: Every piece of logic this epic needs already exists and is
    tested elsewhere in the codebase. This is wiring, not design work —
    design-discussion alone is sufficient context.
```
