#!/usr/bin/env node
import { createServer, type IncomingMessage } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawn } from "node:child_process";
import { Store } from "../lib/store.js";
import type { Contact } from "../lib/types.js";

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
 */

const PORT = Number(process.env.ROLODEX_SHELL_PORT ?? 4173);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = path.join(HERE, "index.html");

const store = new Store();

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

function sendJson(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean); // e.g. ["api","contacts",":id"]

    if (req.method === "GET" && url.pathname === "/api/contacts") {
      sendJson(res, 200, store.list());
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/contacts") {
      const body = (await readJsonBody(req)) as Partial<Contact>;
      if (!body || typeof body.name !== "string" || body.name.trim() === "") {
        sendJson(res, 400, { error: "name is required" });
        return;
      }
      // body.id/createdAt are omitted (not sent as "") when absent, so
      // Store.upsert's `?? randomUUID()` / `?? now` fallbacks (nullish, not
      // falsy) actually trigger for brand-new contacts from the Add form.
      const saved = store.upsert({
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

    // /api/contacts/:id
    if (parts.length === 3 && parts[0] === "api" && parts[1] === "contacts") {
      const id = decodeURIComponent(parts[2]!);
      if (req.method === "GET") {
        const contact = store.get(id);
        if (!contact) {
          sendJson(res, 404, { error: "not found" });
          return;
        }
        sendJson(res, 200, contact);
        return;
      }
    }

    // /api/contacts/:id/verdict and /api/contacts/:id/next-step
    if (parts.length === 4 && parts[0] === "api" && parts[1] === "contacts") {
      const id = decodeURIComponent(parts[2]!);
      const field = parts[3];
      if (req.method === "PATCH" && (field === "verdict" || field === "next-step")) {
        if (!store.get(id)) {
          sendJson(res, 404, { error: "not found" });
          return;
        }
        const body = (await readJsonBody(req)) as { verdict?: string; nextStep?: string };
        if (field === "verdict") {
          if (typeof body.verdict !== "string") {
            sendJson(res, 400, { error: "verdict is required" });
            return;
          }
          store.setVerdict(id, body.verdict as Contact["verdict"]);
        } else {
          if (typeof body.nextStep !== "string") {
            sendJson(res, 400, { error: "nextStep is required" });
            return;
          }
          store.setNextStep(id, body.nextStep);
        }
        sendJson(res, 200, store.get(id));
        return;
      }
    }

    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      const html = await readFile(INDEX_HTML, "utf8");
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

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`rolodex shell listening at ${url}`);
  if (process.platform === "darwin" && !process.env.ROLODEX_NO_OPEN) {
    spawn("open", [url], { stdio: "ignore", detached: true }).unref();
  }
});
