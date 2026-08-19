#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { Store } from "../lib/store.js";
import {
  applyPullToStore,
  createGoogleSync,
  deleteContactEverywhere,
  pushAllToGoogle,
  type GoogleSync,
} from "../lib/google-sync.js";
import type { Contact, Interaction, Verdict } from "../lib/types.js";

/**
 * The rolodex, exposed as an MCP tool. Add this server to any agent host
 * (Claude, your Pantheon swarm) and the agent simply *has* a rolodex it can
 * read, search, and update — no bespoke integration each time. Config + data
 * live per-install (ROLODEX_DB, the owner's Google OAuth); the code is generic.
 */

// ---------------------------------------------------------------------------
// Tool arg shapes (mirrors each server.tool()'s zod schema below) — kept as
// plain interfaces rather than z.infer<> so the handler functions below have
// a stable, explicit type independent of the zod call sites.
// ---------------------------------------------------------------------------

interface UpsertArgs {
  id?: string;
  name: string;
  org?: string;
  role?: string;
  email?: string;
  met?: string;
  what?: string;
  angle?: string;
  verdict?: Verdict;
  nextStep?: string;
  tags?: string[];
}

interface SearchArgs {
  query: string;
  verdict?: Verdict;
  limit?: number;
}

interface FollowupsArgs {
  withinDays?: number;
}

interface LogInteractionArgs {
  contactId: string;
  note: string;
  at?: string;
  channel?: Interaction["channel"];
}

interface SyncGoogleArgs {
  direction: "pull" | "push" | "both";
}

interface DeleteArgs {
  contactId: string;
}

/** Handlers exposed alongside the McpServer they're registered on, so tests
 * can call them directly (in-process, no transport) rather than round-tripping
 * through stdio JSON-RPC just to exercise the logic. See createRolodexMcpServer's
 * doc comment for why this shape was chosen over reaching into the SDK's
 * internal tool registry. */
export interface RolodexMcpHandlers {
  rolodex_upsert: (args: UpsertArgs, extra?: unknown) => Promise<CallToolResult>;
  rolodex_search: (args: SearchArgs, extra?: unknown) => Promise<CallToolResult>;
  rolodex_followups: (args: FollowupsArgs, extra?: unknown) => Promise<CallToolResult>;
  rolodex_log_interaction: (args: LogInteractionArgs, extra?: unknown) => Promise<CallToolResult>;
  rolodex_sync_google: (args: SyncGoogleArgs, extra?: unknown) => Promise<CallToolResult>;
  rolodex_delete: (args: DeleteArgs, extra?: unknown) => Promise<CallToolResult>;
}

export interface RolodexMcpServerOptions {
  /** Pre-built Store to use instead of the real, env-configured default —
   * mainly for tests that want a Store pointed at a throwaway temp file. */
  store?: Store;
  /** Pre-built GoogleSync to use instead of the real, keychain-backed
   * default — mainly for tests that want to inject a fake People API client
   * (or one that just throws) without touching the OS keychain or network. */
  google?: GoogleSync;
}

function textResult(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function errorResult(err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
}

/** Wraps a tool handler so any thrown error (a Store method throwing, a
 * GoogleSync call rejecting, etc.) turns into a `{ isError: true }`
 * CallToolResult instead of an uncaught rejection — letting one bad call
 * escape here would crash the whole stdio server process, taking down every
 * tool for whatever host is connected, not just the one call that failed. */
function withErrorHandling<Args>(
  fn: (args: Args, extra: unknown) => CallToolResult | Promise<CallToolResult>,
): (args: Args, extra?: unknown) => Promise<CallToolResult> {
  return async (args, extra) => {
    try {
      return await fn(args, extra);
    } catch (err) {
      return errorResult(err);
    }
  };
}

/**
 * Builds the McpServer and registers all 5 rolodex tools against it, wiring
 * each straight to the already-implemented, already-tested Store/GoogleSync
 * methods — this layer is integration (arg shaping + error wrapping), not
 * new logic.
 *
 * Returns `{ server, handlers }` rather than just `server`: the MCP SDK's
 * `server.tool(...)` registers a callback internally but doesn't expose a
 * simple "get me the callback for tool X" lookup on McpServer itself (only
 * on the `RegisteredTool` each individual `.tool()` call returns, and even
 * that's typed as a client/task-handler union rather than a plain callback).
 * Since this function already builds each handler as its own named/typed
 * const before handing it to `server.tool(...)`, collecting those same
 * consts into `handlers` costs nothing extra and gives tests a directly
 * callable, precisely-typed handle on each tool's logic — no fake transport,
 * no reaching into SDK internals.
 */
export function createRolodexMcpServer(
  opts: RolodexMcpServerOptions = {},
): { server: McpServer; handlers: RolodexMcpHandlers } {
  const store = opts.store ?? new Store();
  const google = opts.google ?? createGoogleSync();

  const server = new McpServer({ name: "rolodex", version: "0.1.0" });

  const upsertHandler = withErrorHandling<UpsertArgs>(async (args) => {
    // id/createdAt/updatedAt are left for Store.upsert() to fill in
    // (`c.id || randomUUID()`, `c.createdAt || now`) — same pattern as the
    // shell's POST /api/contacts route (src/shell/server.ts).
    const saved = store.upsert({
      id: args.id || undefined,
      name: args.name,
      org: args.org,
      role: args.role,
      email: args.email,
      met: args.met,
      what: args.what,
      angle: args.angle,
      verdict: args.verdict ?? "none",
      nextStep: args.nextStep,
      tags: args.tags,
    } as Contact);
    return textResult(saved);
  });

  server.tool(
    "rolodex_upsert",
    "Add or update a contact. Only pass fields you actually know — never invent a role, org, or email. If unsure whether this is a new contact or an edit to an existing one, call rolodex_search first rather than guessing.",
    {
      id: z.string().optional(),
      name: z.string(),
      org: z.string().optional(),
      role: z.string().optional(),
      email: z.string().optional(),
      met: z.string().optional(),
      what: z.string().optional(),
      angle: z.string().optional(),
      verdict: z.enum(["strong", "watch", "referral-only", "pass", "none"]).optional(),
      nextStep: z.string().optional(),
      tags: z.array(z.string()).optional(),
    },
    upsertHandler,
  );

  const searchHandler = withErrorHandling<SearchArgs>(async (args) => {
    const results = store.search(args.query, { verdict: args.verdict, limit: args.limit });
    return textResult(results);
  });

  server.tool(
    "rolodex_search",
    "Full-text search contacts by name/org/what-they-do/angle/tags. Call this before rolodex_upsert whenever you're not certain a contact is new, to avoid creating a duplicate. No results means no results — never invent a plausible-sounding match.",
    { query: z.string(), verdict: z.enum(["strong", "watch", "referral-only", "pass", "none"]).optional(), limit: z.number().optional() },
    searchHandler,
  );

  const followupsHandler = withErrorHandling<FollowupsArgs>(async (args) => {
    const results = store.needsFollowUp(args.withinDays);
    return textResult(results);
  });

  server.tool(
    "rolodex_followups",
    "List contacts with an open next step that have gone cold — no interaction within the owner's configured follow-up window. Use this to answer \"who should I reach out to.\"",
    { withinDays: z.number().optional() },
    followupsHandler,
  );

  const logInteractionHandler = withErrorHandling<LogInteractionArgs>(async (args) => {
    const interaction: Interaction = {
      id: randomUUID(),
      contactId: args.contactId,
      note: args.note,
      at: args.at ?? new Date().toISOString(),
      channel: args.channel,
    };
    store.logInteraction(interaction);
    return textResult(interaction);
  });

  server.tool(
    "rolodex_log_interaction",
    "Log a real touch (call/email/dm/meeting/note) against a contact. Only log something the user describes as having actually happened — not something merely planned or discussed.",
    { contactId: z.string(), note: z.string(), at: z.string().optional(), channel: z.enum(["call", "email", "dm", "meeting", "other"]).optional() },
    logInteractionHandler,
  );

  const syncHandler = withErrorHandling<SyncGoogleArgs>(async (args) => {
    if (args.direction === "push") {
      return textResult(await pushAllToGoogle(store, google));
    }

    const pulled = await google.pull();
    const pullSummary = applyPullToStore(pulled, store);

    if (args.direction === "both") {
      const pushSummary = await pushAllToGoogle(store, google);
      return textResult({ pull: pullSummary, push: pushSummary });
    }
    return textResult(pullSummary);
  });

  server.tool(
    "rolodex_sync_google",
    "Two-way sync with the owner's Google Contacts (People API). 'pull' brings Google's contacts in (verdict/angle/next-step are local-only and never overwritten by a pull). 'push' sends every local contact to Google, one at a time — creating new ones, updating linked ones, and reporting per-contact failures in the result's `errors` array rather than aborting the whole batch (the most common failure is a genuine conflict: the contact changed on Google since the last pull — pull again before retrying that one). 'both' runs pull then push and returns { pull, push } — both summaries.",
    { direction: z.enum(["pull", "push", "both"]).default("both") },
    syncHandler,
  );

  const deleteHandler = withErrorHandling<DeleteArgs>(async (args) => {
    const existing = store.get(args.contactId);
    if (!existing) {
      return errorResult(`no contact found with id ${args.contactId}`);
    }
    const summary = await deleteContactEverywhere(args.contactId, store, google);
    // Unlike the HTTP DELETE route's 204 (which genuinely can't carry a
    // body), this response has room — surface a best-effort Google-delete
    // failure directly in it rather than only logging server-side.
    return textResult({
      deleted: true,
      id: args.contactId,
      name: existing.name,
      ...(summary.googleDeleteError ? { googleDeleteWarning: summary.googleDeleteError } : {}),
    });
  });

  server.tool(
    "rolodex_delete",
    "Permanently delete a contact and its interaction history. This is destructive and cannot be undone — there is no undo, no trash/archive. Only call this when the user has explicitly and unambiguously asked to delete or remove a specific contact, never as a side effect of a search, an update, or your own inference. If you're unsure which contact they mean, or whether they actually want it gone (as opposed to just deprioritized — that's what verdict is for), ask first rather than guessing.",
    { contactId: z.string() },
    deleteHandler,
  );

  return {
    server,
    handlers: {
      rolodex_upsert: upsertHandler,
      rolodex_search: searchHandler,
      rolodex_followups: followupsHandler,
      rolodex_log_interaction: logInteractionHandler,
      rolodex_sync_google: syncHandler,
      rolodex_delete: deleteHandler,
    },
  };
}

// realpathSync matters here: a global install (`npm link`, `npm i -g`) runs
// this file through a symlinked bin — process.argv[1] stays the symlink
// path while import.meta.url is always the resolved real file, so a plain
// string comparison silently fails (isMainModule false, the server never
// starts, exit 0) the moment this isn't invoked by its literal dist path.
const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (isMainModule) {
  const { server } = createRolodexMcpServer();
  await server.connect(new StdioServerTransport());
}
