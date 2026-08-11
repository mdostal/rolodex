#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Store } from "../lib/store.js";
import type { Contact, Interaction } from "../lib/types.js";
import { createSecretsAdapter, type CreateSecretsAdapterOptions, type SecretsAdapter } from "../lib/secrets-adapter.js";
import { checkSecretsCapability } from "../lib/secrets-check.js";
import { applyPullToStore, createGoogleSync } from "../lib/google-sync.js";
import {
  checkDbPathWritable,
  clearDbPathOverride,
  defaultDbPath,
  resolveDbPath,
  setDbPathOverride,
} from "./db-location.js";

/**
 * Desktop shell, chosen (saf-01) as: a local Node HTTP server hosting `Store`
 * in-process, with a plain browser tab as the UI.
 *
 * Why not Electron or Tauri: Store already runs as ordinary Node, so an
 * ordinary Node process serving it needs no IPC bridge, no renderer
 * sandboxing story, and no native-module rebuild risk — Electron's
 * contextIsolation/preload wiring and Tauri's Node sidecar (it can't reach
 * node:sqlite from Rust directly) both solve problems this shell doesn't
 * have. A browser tab is a genuinely real window against the real SQLite
 * file, not a fake/mocked stand-in — this story's whole point is proving
 * that, as thinly as possible. Electron remains a reasonable future upgrade
 * if a truly native window (tray icon, native menus, offline-from-file://)
 * is ever required; nothing here forecloses it since Store itself is
 * untouched by this choice.
 *
 * First-run setup wizard (saf-04): this server no longer opens the SQLite
 * file at import time. Until the wizard's Finish screen calls
 * POST /api/wizard/complete, `getStore()` is never invoked, so a first-run
 * user gets to confirm/change the DB location BEFORE the file is created —
 * `Store` is constructed exactly once, at whatever path was actually
 * resolved (env > wizard override > default), either at that moment or (for
 * an already-configured install) lazily on first use after boot.
 */

/** SecretsAdapter key for the first-run-complete sentinel — its value is the
 * ISO timestamp the wizard was finished at. Presence alone gates first-run
 * detection; the timestamp is just useful metadata if it's ever inspected. */
const WIZARD_COMPLETED_KEY = "wizard.completed";

/** SecretsAdapter key for the pasted Google OAuth client credentials, stored
 * as `JSON.stringify({ clientId, clientSecret })`. Matches the key name the
 * setup-wizard design brief documents. A future story adds
 * "google.oauth.token" alongside it once the real OAuth exchange exists. */
const GOOGLE_OAUTH_CLIENT_KEY = "google.oauth.client";

export interface RolodexServerOptions {
  /** Pre-built Store to use instead of resolving/constructing one lazily —
   * mainly for tests that want a Store pointed at a throwaway temp file. */
  store?: Store;
  /** General-purpose SecretsAdapter for persisted wizard state (the
   * completion sentinel, Google credentials). Defaults to the real
   * OS-keychain-backed adapter. */
  secrets?: SecretsAdapter;
  /** Factory used ONLY by the Secrets-check probe, which needs a FRESH
   * adapter per call to detect a first-call keychain fallback (see
   * secrets-check.ts). Defaults to the real createSecretsAdapter. Injectable
   * separately from `secrets` so tests can make the persisted-state adapter
   * and the probe behave differently without touching a real keychain. */
  secretsCapabilityFactory?: (opts?: CreateSecretsAdapterOptions) => SecretsAdapter;
  /** Home directory used to resolve the default DB path and the wizard's
   * local (non-secret) config file. Defaults to process.env.HOME. Tests
   * override this to a temp dir instead of touching a real ~/.local/share. */
  homeDir?: string;
  indexHtmlPath?: string;
  wizardHtmlPath?: string;
}

/** Reads and JSON-parses a request body. Rejects on malformed JSON. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Builds the HTTP server. Does not call `.listen()` — the caller (either
 * this module's own bottom-of-file bootstrap, or a test) decides that. */
export function createRolodexServer(opts: RolodexServerOptions = {}): Server {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const indexHtmlPath = opts.indexHtmlPath ?? path.join(HERE, "index.html");
  const wizardHtmlPath = opts.wizardHtmlPath ?? path.join(HERE, "wizard.html");
  const homeDir = opts.homeDir;
  const secrets = opts.secrets ?? createSecretsAdapter();
  const secretsCapabilityFactory = opts.secretsCapabilityFactory ?? createSecretsAdapter;
  // Shares this server's `secrets` adapter so a one-shot sync reads the same
  // OAuth client credentials the wizard's Google-connect step wrote.
  const googleSync = createGoogleSync({ secrets });

  let store: Store | undefined = opts.store;
  // Once true, wizard completion can never revert within a process's
  // lifetime (there's no "un-complete setup" feature), so a cached `true` is
  // always safe to reuse without re-asking the SecretsAdapter.
  let wizardCompletedCache = false;

  async function isWizardCompleted(): Promise<boolean> {
    if (wizardCompletedCache) return true;
    const val = await secrets.get(WIZARD_COMPLETED_KEY);
    if (val !== undefined) wizardCompletedCache = true;
    return wizardCompletedCache;
  }

  /** Resolves the real DB path and constructs Store on first use, whenever
   * that happens to be (already-configured install: at boot's first
   * request; first-run install: at wizard-complete time). Idempotent.
   *
   * `node:sqlite`'s DatabaseSync does NOT create missing parent
   * directories, so this ensures the directory exists first — mirroring
   * what checkDbPathWritable() already does for the Database screen's
   * check, but needed here too since a caller can reach wizard-complete
   * (or, for an already-configured install, any /api/contacts route)
   * without ever having hit that screen's check in this process. */
  async function getStore(): Promise<Store> {
    if (store) return store;
    const dbPath = await resolveDbPath(homeDir);
    await mkdir(path.dirname(dbPath), { recursive: true });
    store = new Store(dbPath);
    return store;
  }

  async function handleWizardRoute(
    req: IncomingMessage,
    res: ServerResponse,
    segs: string[],
    _url: URL,
  ): Promise<void> {
    if (req.method === "GET" && segs.length === 1 && segs[0] === "status") {
      sendJson(res, 200, { completed: await isWizardCompleted() });
      return;
    }

    if (segs.length === 1 && segs[0] === "database") {
      if (req.method === "GET") {
        const dbPath = await resolveDbPath(homeDir);
        const check = await checkDbPathWritable(dbPath);
        sendJson(res, 200, { path: dbPath, isDefault: dbPath === defaultDbPath(homeDir), ...check });
        return;
      }
      if (req.method === "POST") {
        const body = (await readJsonBody(req)) as { path?: unknown };
        const candidate = typeof body.path === "string" ? body.path.trim() : "";
        if (!candidate) {
          sendJson(res, 400, { error: "path is required" });
          return;
        }
        const check = await checkDbPathWritable(candidate);
        // Soft gate (per design brief): only persist the override if it's
        // actually usable. A rejected candidate never overwrites a
        // previously-good override, so "Reset to default" always stays a
        // working escape hatch.
        if (check.writable) await setDbPathOverride(candidate, homeDir);
        sendJson(res, 200, { path: candidate, isDefault: candidate === defaultDbPath(homeDir), ...check });
        return;
      }
    }

    if (req.method === "POST" && segs.length === 2 && segs[0] === "database" && segs[1] === "reset") {
      await clearDbPathOverride(homeDir);
      const dbPath = defaultDbPath(homeDir);
      const check = await checkDbPathWritable(dbPath);
      sendJson(res, 200, { path: dbPath, isDefault: true, ...check });
      return;
    }

    if (req.method === "POST" && segs.length === 1 && segs[0] === "google") {
      const body = (await readJsonBody(req)) as { clientId?: unknown; clientSecret?: unknown };
      const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
      const clientSecret = typeof body.clientSecret === "string" ? body.clientSecret : "";
      if (!clientId || !clientSecret) {
        sendJson(res, 400, { error: "Client ID and Client Secret are both required" });
        return;
      }
      // FUTURE OAUTH EXCHANGE PLUGS IN HERE: this story only validates the
      // two fields are non-empty and writes them through SecretsAdapter —
      // per the design brief and this epic's explicit scope boundary, it
      // does NOT open the system browser for consent or talk to Google at
      // all. A later story (see google-sync.ts) replaces this with the real
      // exchange: open the OS-default browser for consent, receive the
      // redirect, swap the code for tokens via googleapis, and additionally
      // write the resulting refresh token under a "google.oauth.token" key.
      // Nothing above this line — not even a log line — ever sees
      // `clientSecret` except this one SecretsAdapter.set() call; it is
      // never written to disk, an env var, or a log outside that call.
      await secrets.set(GOOGLE_OAUTH_CLIENT_KEY, JSON.stringify({ clientId, clientSecret }));
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && segs.length === 2 && segs[0] === "google" && segs[1] === "skip") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && segs.length === 1 && segs[0] === "secrets-check") {
      const result = await checkSecretsCapability(secretsCapabilityFactory);
      sendJson(res, result.ok ? 200 : 422, result);
      return;
    }

    if (req.method === "GET" && segs.length === 1 && segs[0] === "summary") {
      const dbPath = await resolveDbPath(homeDir);
      const googleConfigured = (await secrets.get(GOOGLE_OAUTH_CLIENT_KEY)) !== undefined;
      const secretsResult = await checkSecretsCapability(secretsCapabilityFactory);
      sendJson(res, 200, { dbPath, googleConfigured, secrets: secretsResult });
      return;
    }

    if (req.method === "POST" && segs.length === 1 && segs[0] === "complete") {
      try {
        // Forces real Store construction (opens/creates the sqlite file,
        // runs migrations) at whatever path the Database screen resolved to
        // — the actual commit point for a first-run install, not just a
        // sentinel flip.
        await getStore();
      } catch (err) {
        sendJson(res, 500, {
          error: `Couldn't open the database: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }
      const completedAt = new Date().toISOString();
      await secrets.set(WIZARD_COMPLETED_KEY, completedAt);
      wizardCompletedCache = true;
      sendJson(res, 200, { completed: true, completedAt });
      return;
    }

    sendJson(res, 404, { error: "not found" });
  }

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean); // e.g. ["api","contacts",":id"]

      if (parts[0] === "api" && parts[1] === "wizard") {
        await handleWizardRoute(req, res, parts.slice(2), url);
        return;
      }

      // POST /api/sync/google — one-shot Google Contacts pull. Reuses
      // Store.upsert()'s own dedup (googleResourceName, then email); the
      // only thing done here first is re-attaching each pulled contact's
      // pre-existing local-only fields (verdict/nextStep/angle/...) so a
      // resync can't clobber them — see google-sync.ts's applyPullToStore().
      if (req.method === "POST" && parts.length === 3 && parts[0] === "api" && parts[1] === "sync" && parts[2] === "google") {
        if (!(await isWizardCompleted())) {
          sendJson(res, 409, { error: "setup not complete" });
          return;
        }
        const s = await getStore();
        try {
          const pulled = await googleSync.pull();
          const summary = applyPullToStore(pulled, s);
          sendJson(res, 200, summary);
        } catch (err) {
          sendJson(res, 502, { error: err instanceof Error ? err.message : String(err) });
        }
        return;
      }

      if (parts[0] === "api" && parts[1] === "contacts") {
        // Main app routes are only meaningful once setup has resolved a real
        // DB location — refuse rather than silently constructing Store
        // against a not-yet-confirmed path.
        if (!(await isWizardCompleted())) {
          sendJson(res, 409, { error: "setup not complete" });
          return;
        }
        const s = await getStore();

        if (req.method === "GET" && parts.length === 2) {
          sendJson(res, 200, s.list());
          return;
        }

        if (req.method === "POST" && parts.length === 2) {
          const body = (await readJsonBody(req)) as Partial<Contact>;
          if (!body || typeof body.name !== "string" || body.name.trim() === "") {
            sendJson(res, 400, { error: "name is required" });
            return;
          }
          // body.id/createdAt are omitted (not sent as "") when absent, so
          // Store.upsert's `?? randomUUID()` / `?? now` fallbacks (nullish, not
          // falsy) actually trigger for brand-new contacts from the Add form.
          const saved = s.upsert({
            id: body.id || undefined,
            name: body.name,
            org: body.org,
            role: body.role,
            email: body.email,
            phone: body.phone,
            met: body.met,
            what: body.what,
            angle: body.angle,
            verdict: body.verdict ?? "none",
            nextStep: body.nextStep,
            tags: body.tags,
            googleResourceName: body.googleResourceName,
            createdAt: body.createdAt || undefined,
            updatedAt: body.updatedAt || undefined,
          } as Contact);
          sendJson(res, 200, saved);
          return;
        }

        // GET /api/contacts/search?q=...&verdict=...&limit=... — checked
        // ahead of the generic /api/contacts/:id block below so a literal
        // contact id of "search" (never produced by randomUUID(), but
        // worth being explicit about) can't shadow this route.
        if (req.method === "GET" && parts.length === 3 && parts[2] === "search") {
          const q = url.searchParams.get("q") ?? "";
          const verdictParam = url.searchParams.get("verdict");
          const limitParam = url.searchParams.get("limit");
          const searchOpts: { verdict?: Contact["verdict"]; limit?: number } = {};
          if (verdictParam) searchOpts.verdict = verdictParam as Contact["verdict"];
          if (limitParam !== null) {
            const n = Number(limitParam);
            if (Number.isFinite(n) && n > 0) searchOpts.limit = n;
          }
          sendJson(res, 200, s.search(q, searchOpts));
          return;
        }

        // GET/POST /api/contacts/:id/interactions — logging + history, kept
        // as its own standalone check (additive, alongside the existing
        // parts.length === 4 verdict/next-step block below, not merged into
        // it) so that block's PATCH logic stays untouched.
        if (parts.length === 4 && parts[3] === "interactions") {
          const id = decodeURIComponent(parts[2]!);
          if (!s.get(id)) {
            sendJson(res, 404, { error: "not found" });
            return;
          }

          if (req.method === "GET") {
            sendJson(res, 200, s.listInteractions(id));
            return;
          }

          if (req.method === "POST") {
            const body = (await readJsonBody(req)) as {
              at?: unknown;
              note?: unknown;
              channel?: unknown;
            };
            const note = typeof body.note === "string" ? body.note.trim() : "";
            if (!note) {
              sendJson(res, 400, { error: "note is required" });
              return;
            }
            const validChannels = ["call", "email", "dm", "meeting", "other"];
            const channel =
              typeof body.channel === "string" && validChannels.includes(body.channel)
                ? (body.channel as Interaction["channel"])
                : undefined;
            const at = typeof body.at === "string" && body.at.trim() ? body.at : new Date().toISOString();
            const interaction: Interaction = {
              id: randomUUID(),
              contactId: id,
              at,
              note,
              channel,
            };
            s.logInteraction(interaction);
            sendJson(res, 200, interaction);
            return;
          }
        }

        // /api/contacts/:id
        if (parts.length === 3) {
          const id = decodeURIComponent(parts[2]!);
          if (req.method === "GET") {
            const contact = s.get(id);
            if (!contact) {
              sendJson(res, 404, { error: "not found" });
              return;
            }
            sendJson(res, 200, contact);
            return;
          }
        }

        // /api/contacts/:id/verdict and /api/contacts/:id/next-step
        if (parts.length === 4) {
          const id = decodeURIComponent(parts[2]!);
          const field = parts[3];
          if (req.method === "PATCH" && (field === "verdict" || field === "next-step")) {
            if (!s.get(id)) {
              sendJson(res, 404, { error: "not found" });
              return;
            }
            const body = (await readJsonBody(req)) as { verdict?: string; nextStep?: string };
            if (field === "verdict") {
              if (typeof body.verdict !== "string") {
                sendJson(res, 400, { error: "verdict is required" });
                return;
              }
              s.setVerdict(id, body.verdict as Contact["verdict"]);
            } else {
              if (typeof body.nextStep !== "string") {
                sendJson(res, 400, { error: "nextStep is required" });
                return;
              }
              s.setNextStep(id, body.nextStep);
            }
            sendJson(res, 200, s.get(id));
            return;
          }
        }
      }

      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        const htmlPath = (await isWizardCompleted()) ? indexHtmlPath : wizardHtmlPath;
        const html = await readFile(htmlPath, "utf8");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    } catch (err) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(String(err));
    }
  });
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  const PORT = Number(process.env.ROLODEX_SHELL_PORT ?? 4173);
  const server = createRolodexServer();

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      // Binding a fixed port doubles as the single-instance lock: a second
      // launch can't take the port, so it can't stand up a second server
      // fighting the first over the same SQLite file.
      console.error(
        `rolodex is already running at http://localhost:${PORT} (port in use) — not starting a second instance.`,
      );
      process.exit(1);
    }
    throw err;
  });

  // Bind explicitly to loopback: this server carries OAuth secrets during
  // the wizard flow and full contact data afterward, with zero
  // authentication, so it must never be reachable from other devices on the
  // same network. Without a host argument Node defaults to binding all
  // interfaces (0.0.0.0/::), which is the wrong default here.
  server.listen(PORT, "127.0.0.1", () => {
    const url = `http://localhost:${PORT}`;
    console.log(`rolodex shell listening at ${url}`);
    if (process.platform === "darwin" && !process.env.ROLODEX_NO_OPEN) {
      spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    }
  });
}
