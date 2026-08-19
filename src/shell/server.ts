#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Store } from "../lib/store.js";
import type { Contact, Interaction } from "../lib/types.js";
import { createSecretsAdapter, isPortunusAvailable as defaultIsPortunusAvailable, type CreateSecretsAdapterOptions, type SecretsAdapter } from "../lib/secrets-adapter.js";
import { checkSecretsCapability } from "../lib/secrets-check.js";
import { applyPullToStore, createGoogleSync } from "../lib/google-sync.js";
import { connectGoogleAccount as defaultConnectGoogleAccount, type ConnectGoogleAccountOptions } from "../lib/google-oauth-flow.js";
import {
  checkDbPathWritable,
  clearDbPathOverride,
  defaultDbPath,
  resolveDbPath,
  setDbPathOverride,
} from "./db-location.js";
import {
  getSecretsBackendChoiceSync,
  setSecretsBackendChoice,
  type SecretsBackendChoice,
} from "./secrets-backend-config.js";

/**
 * Desktop shell, chosen (saf-01) as: a local Node HTTP server hosting `Store`
 * in-process, with a plain browser tab as the UI.
 *
 * This file itself stays framework-agnostic on purpose: Store runs as
 * ordinary Node, so an ordinary Node process serving it needs no IPC
 * bridge, no renderer sandboxing story, and no native-module rebuild risk —
 * a plain browser tab is a genuinely real window against the real SQLite
 * file, not a fake/mocked stand-in. That's still true, and still exactly
 * how `npm run shell` runs today.
 *
 * The packaged desktop app (src/electron/main.ts, the electron-packaging
 * epic) is Electron, not Tauri, precisely BECAUSE of the shape above:
 * Electron's main process IS Node, so it imports and boots this exact
 * server in-process with zero changes here — no sidecar, no IPC. Tauri's
 * Rust core can't reach node:sqlite directly and would need this server
 * spawned as a separate bundled sidecar process instead; real added
 * complexity for zero benefit given this file already runs as plain Node.
 * main.ts is the only file that imports `electron` at all — this module
 * neither knows nor cares whether its caller is a browser tab or an
 * Electron BrowserWindow.
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

/** The real `Verdict` enum values (src/lib/types.ts), duplicated here as a
 * runtime list — `body.verdict as Contact["verdict"]` was a compile-time-only
 * cast that let any string through to Store.setVerdict() unvalidated. */
const VALID_VERDICTS: ReadonlyArray<Contact["verdict"]> = ["strong", "watch", "referral-only", "pass", "none"];

function isValidVerdict(value: string): value is Contact["verdict"] {
  return (VALID_VERDICTS as readonly string[]).includes(value);
}

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
  /** Factory used to construct the persistent `secrets` adapter itself (only
   * when `opts.secrets` isn't given) — defaults to the real
   * createSecretsAdapter. Distinct from `secretsCapabilityFactory` (which is
   * for the wizard's fresh-per-call capability probe, see above): this one
   * backs the SAME long-lived `secrets` instance `googleSync` and every
   * other route below is constructed from. Injectable so tests can verify
   * exactly which `backend` this server resolved (via
   * getSecretsBackendChoiceSync(homeDir)) and passed into it, without a real
   * keychain or Portunus install. */
  secretsAdapterFactory?: (opts?: CreateSecretsAdapterOptions) => SecretsAdapter;
  /** Home directory used to resolve the default DB path and the wizard's
   * local (non-secret) config file. Defaults to process.env.HOME. Tests
   * override this to a temp dir instead of touching a real ~/.local/share. */
  homeDir?: string;
  indexHtmlPath?: string;
  wizardHtmlPath?: string;
  /** Runs the real Google OAuth loopback consent flow (src/lib/google-oauth-flow.ts).
   * Defaults to the real `connectGoogleAccount`. Injectable so tests can
   * substitute a fake and never open a real browser tab or talk to Google. */
  connectGoogleAccount?: (opts: ConnectGoogleAccountOptions) => Promise<void>;
  /** Probes whether the real `portunus` CLI is available (src/lib/secrets-
   * adapter.ts's isPortunusAvailable), used only by the wizard's Secrets
   * screen to decide whether to show a Keychain/Portunus choice at all.
   * Defaults to the real probe. Injectable so tests can simulate "Portunus
   * is installed" without a real binary on the test machine. */
  isPortunusAvailable?: () => Promise<boolean>;
  /** Native launch-at-login control — only meaningful when this server is
   * booted inside the Electron app (src/electron/main.ts), which injects
   * the real implementation backed by Electron's app.setLoginItemSettings/
   * getLoginItemSettings. There is no OS concept of "autostart" for a plain
   * `npm run shell` dev server, so the default below reports unsupported
   * rather than pretending a toggle exists. Kept as a plain get/set pair
   * (not a class) so this file — a `Store`-adjacent HTTP layer — never
   * imports `electron` itself; only src/electron/main.ts does. */
  autostart?: {
    isSupported: boolean;
    getEnabled: () => boolean;
    setEnabled: (enabled: boolean) => void;
  };
}

const UNSUPPORTED_AUTOSTART = {
  isSupported: false,
  getEnabled: () => false,
  setEnabled: () => {},
};

/** Thrown by readJsonBody() when the request body isn't valid JSON — a
 * distinct type so the top-level request handler can tell "client sent a
 * bad request" (400) apart from a genuine server-side failure (500), rather
 * than letting JSON.parse's SyntaxError fall through to the generic
 * catch-all below. */
class MalformedJsonError extends Error {
  constructor(cause: unknown) {
    super(`request body is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "MalformedJsonError";
  }
}

/** Reads and JSON-parses a request body. Throws MalformedJsonError on
 * malformed JSON, which every route parses bodies through, so that error is
 * handled consistently (as a 400) in exactly one place. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new MalformedJsonError(err);
  }
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
  const assetsDir = path.join(HERE, "assets");
  const autostart = opts.autostart ?? UNSUPPORTED_AUTOSTART;
  const homeDir = opts.homeDir;
  // Backend choice (keychain vs. portunus) is resolved via a SYNCHRONOUS
  // local-file read (getSecretsBackendChoiceSync) at this exact call site —
  // deliberately, not an async/lazy adapter — so `secrets` below is still a
  // concrete, already-resolved SecretsAdapter the moment createGoogleSync()
  // is constructed from it two lines down. See secrets-backend-config.ts's
  // top-of-file docstring for the full rationale (grill finding F3): an
  // earlier "make secrets async/lazy like Store" proposal was checked
  // against the real code and found architecturally wrong, since — unlike
  // Store — `secrets` has an eager synchronous consumer (`googleSync`)
  // immediately after it right here.
  const secretsAdapterFactory = opts.secretsAdapterFactory ?? createSecretsAdapter;
  const secrets = opts.secrets ?? secretsAdapterFactory({ backend: getSecretsBackendChoiceSync(homeDir) });
  const secretsCapabilityFactory = opts.secretsCapabilityFactory ?? createSecretsAdapter;
  // Shares this server's `secrets` adapter so a one-shot sync reads the same
  // OAuth client credentials the wizard's Google-connect step wrote.
  const googleSync = createGoogleSync({ secrets });
  const connectGoogleAccount = opts.connectGoogleAccount ?? defaultConnectGoogleAccount;
  const isPortunusAvailable = opts.isPortunusAvailable ?? (() => defaultIsPortunusAvailable());

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

    // POST /api/wizard/google/connect — runs the real OAuth loopback consent
    // flow (src/lib/google-oauth-flow.ts) against whatever client id/secret
    // POST /api/wizard/google already saved. Reads+parses GOOGLE_OAUTH_CLIENT_KEY
    // the same way that route's own body-parsing does (typeof-guarded string
    // fields, trimmed, both required) rather than inventing a new parsing
    // convention for the read side.
    if (req.method === "POST" && segs.length === 2 && segs[0] === "google" && segs[1] === "connect") {
      const clientRaw = await secrets.get(GOOGLE_OAUTH_CLIENT_KEY);
      let clientId = "";
      let clientSecret = "";
      if (clientRaw !== undefined) {
        try {
          const parsed = JSON.parse(clientRaw) as { clientId?: unknown; clientSecret?: unknown };
          clientId = typeof parsed.clientId === "string" ? parsed.clientId.trim() : "";
          clientSecret = typeof parsed.clientSecret === "string" ? parsed.clientSecret : "";
        } catch {
          // Corrupt stored value — treated the same as "nothing saved yet"
          // below, via the empty clientId/clientSecret it leaves in place.
        }
      }
      if (!clientId || !clientSecret) {
        sendJson(res, 400, {
          error: "Google isn't configured yet — save a Client ID and Client Secret first.",
        });
        return;
      }

      // Propagates a client-side cancel (the wizard's real Cancel button,
      // which aborts its in-flight fetch) through to connectGoogleAccount's
      // own AbortSignal, so the local OAuth listener is torn down
      // immediately instead of sitting open for the full 120s timeout. The
      // request's `close` event is Node's non-deprecated signal for "this
      // request ended, however that happened" (the older `aborted` event is
      // deprecated) — it also fires on ordinary completion, but aborting an
      // already-settled connectGoogleAccount() call is a harmless no-op (see
      // its own teardown()/torn guard).
      const controller = new AbortController();
      req.on("close", () => controller.abort());

      try {
        await connectGoogleAccount({ clientId, clientSecret, secrets, signal: controller.signal });
        if (!res.writableEnded) sendJson(res, 200, { connected: true });
      } catch (err) {
        if (!res.writableEnded) {
          sendJson(res, 502, { error: err instanceof Error ? err.message : String(err) });
        }
      }
      return;
    }

    if (req.method === "POST" && segs.length === 2 && segs[0] === "google" && segs[1] === "skip") {
      sendJson(res, 200, { ok: true });
      return;
    }

    // GET /api/wizard/secrets-backends — tells the wizard's Secrets screen
    // whether Portunus is available on this machine at all, so it knows
    // whether to render a real Keychain/Portunus choice (per this story's
    // hard requirement: no visible choice, Keychain-only, when Portunus
    // isn't detected). A lightweight `portunus --version` probe
    // (isPortunusAvailable), NOT the round-trip capability check that
    // POST .../secrets-check performs — those stay separate routes/concerns:
    // this one only answers "does the choice UI exist at all", the other
    // answers "does whichever backend is currently selected actually work".
    if (req.method === "GET" && segs.length === 1 && segs[0] === "secrets-backends") {
      sendJson(res, 200, { portunusAvailable: await isPortunusAvailable() });
      return;
    }

    // POST /api/wizard/secrets-backend-choice — persists the user's pick
    // from the Secrets screen's Keychain/Portunus choice (only reachable
    // when GET .../secrets-backends reported Portunus as available) via
    // setSecretsBackendChoice(), BEFORE the wizard is allowed to navigate on
    // to "google" — see wizard.html's renderSecrets(). Does NOT reconstruct
    // this server's own long-lived `secrets` adapter (that was already
    // resolved once, synchronously, at construction time above) — the
    // effect of this choice on THIS process is limited to whatever this
    // route itself does with `backend` afterward (nothing, currently); it
    // takes effect for real the next time the server process starts, which
    // for a first-run wizard is the very next launch after setup completes.
    if (req.method === "POST" && segs.length === 1 && segs[0] === "secrets-backend-choice") {
      const body = (await readJsonBody(req)) as { backend?: unknown };
      if (body.backend !== "keychain" && body.backend !== "portunus") {
        sendJson(res, 400, { error: 'backend must be "keychain" or "portunus"' });
        return;
      }
      const backend: SecretsBackendChoice = body.backend;
      await setSecretsBackendChoice(backend, homeDir);
      sendJson(res, 200, { ok: true, backend });
      return;
    }

    if (req.method === "POST" && segs.length === 1 && segs[0] === "secrets-check") {
      // Optional body: `{ backend: "keychain" | "portunus" }`, so the wizard
      // UI can request a probe of whichever backend it currently has
      // selected instead of always the default. Absent/malformed/unknown
      // `backend` all fall back to "keychain" — checkSecretsCapability()'s
      // own default and today's exact (pre-this-parameter) behavior.
      const body = (await readJsonBody(req)) as { backend?: unknown };
      const backend = body.backend === "portunus" ? "portunus" : "keychain";
      const result = await checkSecretsCapability(secretsCapabilityFactory, backend);
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

      // GET /assets/* — static assets (currently just the favicon) shared by
      // both the wizard and the main app shells. Deliberately NOT gated
      // behind isWizardCompleted(): the favicon has to load on both
      // wizard.html and index.html regardless of setup state. This is a
      // single flat directory with an extension allowlist, not a
      // general-purpose static file server — no subdirectories are expected.
      if (req.method === "GET" && parts[0] === "assets" && parts.length === 2) {
        const ASSET_CONTENT_TYPES: Record<string, string> = {
          ".svg": "image/svg+xml",
          ".png": "image/png",
          ".ico": "image/x-icon",
        };
        let assetName: string;
        try {
          assetName = decodeURIComponent(parts[1]!);
        } catch {
          // Malformed percent-encoding (e.g. a lone invalid "%ff") — treat
          // like any other not-found asset rather than letting it fall
          // through to the outer catch as a 500.
          res.writeHead(404, { "content-type": "text/plain" });
          res.end("not found");
          return;
        }
        const contentType = ASSET_CONTENT_TYPES[path.extname(assetName)];
        // Reject anything without a recognized extension or containing ".."
        // (defense in depth — decodeURIComponent can turn an encoded
        // traversal segment into one that would otherwise resolve outside
        // assetsDir; a literal "/" can't reach here since `parts` is already
        // split on "/").
        if (contentType && !assetName.includes("..")) {
          try {
            const data = await readFile(path.join(assetsDir, assetName));
            res.writeHead(200, { "content-type": contentType, "cache-control": "public, max-age=3600" });
            res.end(data);
            return;
          } catch {
            // fall through to 404 below
          }
        }
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }

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

      // GET/PUT /api/settings/follow-up — persisted config (windowDays,
      // graceDays) that drives GET /api/contacts/needs-follow-up when its own
      // query params are omitted. Gated behind wizard completion, same as
      // the /api/contacts and /api/sync/google routes, since it needs a real
      // Store.
      if (parts[0] === "api" && parts[1] === "settings" && parts.length === 3 && parts[2] === "follow-up") {
        if (!(await isWizardCompleted())) {
          sendJson(res, 409, { error: "setup not complete" });
          return;
        }
        const s = await getStore();

        if (req.method === "GET") {
          sendJson(res, 200, s.getFollowUpConfig());
          return;
        }

        if (req.method === "PUT") {
          const body = (await readJsonBody(req)) as { windowDays?: unknown; graceDays?: unknown };
          const isPositiveInt = (v: unknown): v is number =>
            typeof v === "number" && Number.isInteger(v) && v > 0;
          if (!isPositiveInt(body.windowDays) || !isPositiveInt(body.graceDays)) {
            sendJson(res, 400, { error: "windowDays and graceDays must both be positive integers" });
            return;
          }
          s.setFollowUpConfig({ windowDays: body.windowDays, graceDays: body.graceDays });
          sendJson(res, 200, s.getFollowUpConfig());
          return;
        }
      }

      // GET/PUT /api/settings/autostart — native launch-at-login, backed by
      // Electron's app.setLoginItemSettings when running inside the app
      // (see the `autostart` RolodexServerOptions doc comment above). Not
      // wizard-gated (touches no Store data at all) and not persisted here
      // — Electron's own login-item registration IS the persisted state,
      // there's nothing else to remember.
      if (parts[0] === "api" && parts[1] === "settings" && parts.length === 3 && parts[2] === "autostart") {
        if (req.method === "GET") {
          sendJson(res, 200, { supported: autostart.isSupported, enabled: autostart.getEnabled() });
          return;
        }

        if (req.method === "PUT") {
          if (!autostart.isSupported) {
            sendJson(res, 501, { error: "autostart is only available in the packaged app" });
            return;
          }
          const body = (await readJsonBody(req)) as { enabled?: unknown };
          if (typeof body.enabled !== "boolean") {
            sendJson(res, 400, { error: "enabled must be a boolean" });
            return;
          }
          autostart.setEnabled(body.enabled);
          sendJson(res, 200, { supported: true, enabled: autostart.getEnabled() });
          return;
        }
      }

      // GET/PUT /api/settings/appearance — persisted {theme, iconId}, read by
      // GET / to server-side-inject the active theme attribute and favicon
      // links into index.html on every request (see below). Same
      // wizard-completion gate and validate-then-persist shape as
      // /api/settings/follow-up above.
      if (parts[0] === "api" && parts[1] === "settings" && parts.length === 3 && parts[2] === "appearance") {
        if (!(await isWizardCompleted())) {
          sendJson(res, 409, { error: "setup not complete" });
          return;
        }
        const s = await getStore();

        if (req.method === "GET") {
          sendJson(res, 200, s.getAppearance());
          return;
        }

        if (req.method === "PUT") {
          const body = (await readJsonBody(req)) as { theme?: unknown; iconId?: unknown };
          const isValidTheme = (v: unknown): v is "default" | "brass" => v === "default" || v === "brass";
          const isValidIconId = (v: unknown): v is number =>
            typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 10;
          if (!isValidTheme(body.theme) || !isValidIconId(body.iconId)) {
            sendJson(res, 400, { error: "theme must be 'default' or 'brass', iconId must be an integer 1-10" });
            return;
          }
          s.setAppearance({ theme: body.theme, iconId: body.iconId });
          sendJson(res, 200, s.getAppearance());
          return;
        }
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

        // GET /api/contacts/needs-follow-up?withinDays=N&graceDays=N — same
        // "checked ahead of the generic :id block" reasoning as search above:
        // a literal contact id can't collide with this route (never produced
        // by randomUUID(), but worth being explicit), so this is safe to
        // match before parts.length===3 falls through to the :id GET below.
        // Both query params are optional and, when given, override the
        // persisted settings for THIS call only — Store.needsFollowUp()
        // itself falls back to getFollowUpConfig() for whichever is omitted,
        // and neither is ever written back to settings here.
        if (req.method === "GET" && parts.length === 3 && parts[2] === "needs-follow-up") {
          const withinParam = url.searchParams.get("withinDays");
          const graceParam = url.searchParams.get("graceDays");
          let withinDays: number | undefined;
          let graceDays: number | undefined;
          if (withinParam !== null) {
            const n = Number(withinParam);
            if (Number.isFinite(n) && n > 0) withinDays = n;
          }
          if (graceParam !== null) {
            const n = Number(graceParam);
            if (Number.isFinite(n) && n > 0) graceDays = n;
          }
          sendJson(res, 200, s.needsFollowUp(withinDays, graceDays));
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

          if (req.method === "DELETE") {
            const contact = s.get(id);
            if (!contact) {
              sendJson(res, 404, { error: "not found" });
              return;
            }
            s.delete(id);
            // 204 genuinely has no body — bypassing sendJson() here rather
            // than sending it JSON.stringify(null)'s "null" text, which
            // would violate the no-body requirement of a 204 response.
            res.writeHead(204);
            res.end();
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
              if (!isValidVerdict(body.verdict)) {
                sendJson(res, 400, {
                  error: `verdict must be one of: ${VALID_VERDICTS.join(", ")}`,
                });
                return;
              }
              s.setVerdict(id, body.verdict);
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
        const completed = await isWizardCompleted();
        const htmlPath = completed ? indexHtmlPath : wizardHtmlPath;
        let html = await readFile(htmlPath, "utf8");
        // index.html is read fresh off disk on every request (no caching),
        // so the active appearance settings are injected here rather than
        // hydrated client-side — no flash-of-wrong-theme/icon is possible.
        // wizard.html never gets this treatment: appearance settings live in
        // the settings table, which doesn't exist meaningfully before the
        // wizard itself has run.
        if (completed) {
          const s = await getStore();
          const { theme, iconId } = s.getAppearance();
          if (theme === "brass") {
            html = html.replace('<html lang="en">', '<html lang="en" data-theme="brass">');
          }
          html = html
            .replace("/assets/favicon.ico", `/assets/icon-c${iconId}.ico`)
            .replace("/assets/favicon-32.png", `/assets/icon-c${iconId}-32.png`)
            .replace("/assets/favicon-16.png", `/assets/icon-c${iconId}-16.png`)
            .replace("/assets/apple-touch-icon.png", `/assets/icon-c${iconId}-180.png`);
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    } catch (err) {
      if (err instanceof MalformedJsonError) {
        sendJson(res, 400, { error: err.message });
        return;
      }
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(String(err));
    }
  });
}

// realpathSync matters here: a global/symlinked invocation would leave
// process.argv[1] as the symlink path while import.meta.url is always the
// resolved real file — see the identical fix in src/mcp/server.ts and
// src/cli/index.ts. Not currently reachable via a `bin` entry, but this
// keeps the pattern correct everywhere it appears rather than only where
// npm link happened to expose the bug.
const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

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
