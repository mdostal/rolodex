#!/usr/bin/env node
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawn } from "node:child_process";
import { Store } from "../lib/store.js";

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

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/api/contacts") {
      const contacts = store.list();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(contacts));
      return;
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
