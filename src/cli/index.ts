#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { createRolodexMcpServer, type RolodexMcpHandlers } from "../mcp/server.js";

/**
 * A third, plain-scriptable integration surface alongside the standalone app
 * and the MCP server — for harnesses/scripts that shell out to a command
 * rather than speaking MCP. Deliberately thin: every command is a straight
 * argv-to-args mapping onto the exact same `RolodexMcpHandlers` the MCP
 * server registers (`src/mcp/server.ts`) — same Store/GoogleSync logic, same
 * validation, same error shape, nothing reimplemented here. Output is always
 * JSON on stdout (or stderr + a non-zero exit code on error), since the
 * audience is other tooling, not a human reading a table.
 */

const USAGE = `rolodex <command> [options]

Commands:
  upsert     Add or update a contact
             --id <id>            update this contact instead of creating one
             --name <name>        required
             --org <org>
             --role <role>
             --email <email>
             --met <how-you-met>
             --what <what-they-do>
             --angle <partnership-angle>
             --verdict <strong|watch|referral-only|pass|none>
             --next-step <text>
             --tags <comma,separated,tags>

  search <query>
             Full-text search by name/org/what/angle/tags
             --verdict <strong|watch|referral-only|pass|none>
             --limit <n>

  followups  Contacts with an open next step that have gone cold
             --within-days <n>

  log <contactId> <note>
             Log a real touch against a contact
             --channel <call|email|dm|meeting|other>
             --at <ISO-8601 timestamp>   defaults to now

  sync-google
             One-way pull from Google Contacts (push is not implemented)
             --direction <pull|push|both>   defaults to both

Every command prints its JSON result to stdout on success, or a JSON
{"error": "..."} to stderr with a non-zero exit code on failure. Uses the
same ROLODEX_DB env var as the standalone app and the MCP server — unset,
all three share ~/.local/share/rolodex/rolodex.db automatically.
`;

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string>;
}

/** Splits a command's remaining argv into positionals (query text, contact
 * ids, note text) and `--flag value` pairs. No boolean flags exist in this
 * command set, so every `--flag` always consumes the next token as its
 * value — simple enough that a hand-rolled parser beats a dependency. */
export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`--${key} requires a value`);
      flags[key] = value;
      i++;
    } else {
      positionals.push(token);
    }
  }
  return { positionals, flags };
}

function parseTags(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const tags = raw.split(",").map((t) => t.trim()).filter(Boolean);
  return tags.length ? tags : undefined;
}

function parseIntFlag(raw: string | undefined, flagName: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`--${flagName} must be a number`);
  return n;
}

const VALID_VERDICTS = ["strong", "watch", "referral-only", "pass", "none"] as const;
function parseVerdict(raw: string | undefined): (typeof VALID_VERDICTS)[number] | undefined {
  if (raw === undefined) return undefined;
  if (!(VALID_VERDICTS as readonly string[]).includes(raw)) {
    throw new Error(`--verdict must be one of ${VALID_VERDICTS.join(", ")}`);
  }
  return raw as (typeof VALID_VERDICTS)[number];
}

const VALID_CHANNELS = ["call", "email", "dm", "meeting", "other"] as const;
function parseChannel(raw: string | undefined): (typeof VALID_CHANNELS)[number] | undefined {
  if (raw === undefined) return undefined;
  if (!(VALID_CHANNELS as readonly string[]).includes(raw)) {
    throw new Error(`--channel must be one of ${VALID_CHANNELS.join(", ")}`);
  }
  return raw as (typeof VALID_CHANNELS)[number];
}

/** Runs one CLI invocation against a set of handlers (real or test-injected)
 * and returns the exit code — kept separate from process.argv/process.exit
 * so tests can drive it directly, same pattern as createRolodexMcpServer's
 * isMainModule split in src/mcp/server.ts. */
export async function run(
  argv: string[],
  handlers: RolodexMcpHandlers,
  stdout: (s: string) => void,
  stderr: (s: string) => void,
): Promise<number> {
  const [command, ...rest] = argv;

  if (!command || command === "--help" || command === "-h" || command === "help") {
    stdout(USAGE);
    return command ? 0 : 1;
  }

  try {
    let result;
    switch (command) {
      case "upsert": {
        const { flags } = parseArgs(rest);
        if (!flags.name) throw new Error("upsert requires --name");
        result = await handlers.rolodex_upsert({
          id: flags.id,
          name: flags.name,
          org: flags.org,
          role: flags.role,
          email: flags.email,
          met: flags.met,
          what: flags.what,
          angle: flags.angle,
          verdict: parseVerdict(flags.verdict),
          nextStep: flags["next-step"],
          tags: parseTags(flags.tags),
        });
        break;
      }
      case "search": {
        const { positionals, flags } = parseArgs(rest);
        const query = positionals[0];
        if (query === undefined) throw new Error("search requires a query, e.g. rolodex search \"acme\"");
        result = await handlers.rolodex_search({
          query,
          verdict: parseVerdict(flags.verdict),
          limit: parseIntFlag(flags.limit, "limit"),
        });
        break;
      }
      case "followups": {
        const { flags } = parseArgs(rest);
        result = await handlers.rolodex_followups({ withinDays: parseIntFlag(flags["within-days"], "within-days") });
        break;
      }
      case "log": {
        const { positionals, flags } = parseArgs(rest);
        const [contactId, note] = positionals;
        if (!contactId || !note) throw new Error('log requires <contactId> <note>, e.g. rolodex log abc123 "called, left voicemail"');
        result = await handlers.rolodex_log_interaction({
          contactId,
          note,
          at: flags.at,
          channel: parseChannel(flags.channel),
        });
        break;
      }
      case "sync-google": {
        const { flags } = parseArgs(rest);
        const direction = flags.direction ?? "both";
        if (direction !== "pull" && direction !== "push" && direction !== "both") {
          throw new Error("--direction must be one of pull, push, both");
        }
        result = await handlers.rolodex_sync_google({ direction });
        break;
      }
      default:
        stderr(`Unknown command: ${command}\n\n${USAGE}`);
        return 2;
    }

    const first = result.content[0];
    // Every handler (see textResult()/errorResult() in src/mcp/server.ts)
    // always returns a single { type: "text" } content item — CallToolResult
    // itself allows other content kinds (image, etc.), so this narrows
    // rather than asserting past the SDK's own union type.
    if (!first || first.type !== "text") throw new Error("unexpected tool result shape (not text content)");
    const payload = JSON.parse(first.text);
    if (result.isError) {
      stderr(JSON.stringify(payload));
      return 1;
    }
    stdout(JSON.stringify(payload, null, 2));
    return 0;
  } catch (err) {
    stderr(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    return 1;
  }
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  const { handlers } = createRolodexMcpServer();
  const code = await run(
    process.argv.slice(2),
    handlers,
    (s) => process.stdout.write(s + "\n"),
    (s) => process.stderr.write(s + "\n"),
  );
  process.exit(code);
}
