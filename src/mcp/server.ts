#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Store } from "../lib/store.js";
import { createGoogleSync } from "../lib/google-sync.js";

/**
 * The rolodex, exposed as an MCP tool. Add this server to any agent host
 * (Claude, your Pantheon swarm) and the agent simply *has* a rolodex it can
 * read, search, and update — no bespoke integration each time. Config + data
 * live per-install (ROLODEX_DB, the owner's Google OAuth); the code is generic.
 */
const store = new Store();
const google = createGoogleSync();

const server = new McpServer({ name: "rolodex", version: "0.1.0" });

server.tool(
  "rolodex_upsert",
  "Add or update a contact (partner/network). Provide any known fields.",
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
  async (args) => {
    // TODO(build): normalize -> store.upsert; return the saved contact id.
    void store;
    return { content: [{ type: "text", text: `upsert not implemented yet: ${args.name}` }] };
  },
);

server.tool(
  "rolodex_search",
  "Full-text search contacts by name/org/what-they-do/angle/tags.",
  { query: z.string(), verdict: z.enum(["strong", "watch", "referral-only", "pass", "none"]).optional(), limit: z.number().optional() },
  async ({ query }) => ({ content: [{ type: "text", text: `search not implemented yet: ${query}` }] }),
);

server.tool(
  "rolodex_followups",
  "List contacts with a next step set that have gone cold (no recent interaction).",
  { withinDays: z.number().optional() },
  async () => ({ content: [{ type: "text", text: "followups not implemented yet" }] }),
);

server.tool(
  "rolodex_log_interaction",
  "Log a touch (call/email/meeting/note) against a contact.",
  { contactId: z.string(), note: z.string(), at: z.string().optional(), channel: z.enum(["call", "email", "dm", "meeting", "other"]).optional() },
  async ({ contactId }) => ({ content: [{ type: "text", text: `log not implemented yet: ${contactId}` }] }),
);

server.tool(
  "rolodex_sync_google",
  "Two-way sync with the owner's Google Contacts (People API). Verdict/angle/next-step stay local.",
  { direction: z.enum(["pull", "push", "both"]).default("both") },
  async () => { void google; return { content: [{ type: "text", text: "google sync not implemented yet" }] }; },
);

await server.connect(new StdioServerTransport());
