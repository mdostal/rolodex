import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { z } from "zod";
import { NotFound, ScopeDenied } from "../lib/scope.js";
import type { Store } from "../lib/store.js";
import { BadRequest, createContactsAdapter } from "./adapter.js";
import { verifyRequest } from "./auth.js";
import { CONTACTS_OPERATIONS, CONTRACT_SCHEMA, ScopeSetSchema, type ContactsOperation, type ScopeSet } from "./contract.js";

/**
 * `rolodex serve` (cm-04): the contacts contract over signed HTTP.
 *
 *   GET  /v1/health        open; {ok, version, schema}
 *   POST /v1/<operation>   one route per contract operation; signed (see ./auth.ts)
 *
 * No wizard, no static UI, no MCP: this mode is a backend for core-api.
 *
 * The verified X-Rolodex-Scopes header is THE ScopeSet of the call and goes
 * to the Store unchanged. A body may repeat it as `scopes` (the contract's
 * request shape) but must then say exactly the same thing, or the call is
 * refused — the unsigned body can never change what is read.
 *
 * Status codes: 401 any auth failure (body always {error:"unauthorized"}),
 * 400 invalid request, 403 outside the write scope / no write scope,
 * 404 unknown route or unreadable card, 405 wrong method, 413 body too
 * large, 500 anything else (no detail). The log sink gets method, path,
 * status and the auth-failure reason — never headers, the token, the
 * signature or bodies.
 */

export const MAX_BODY_BYTES = 1024 * 1024;

const WRITE_OPS: ReadonlySet<ContactsOperation> = new Set(["upsert", "log", "link", "unlink", "delete"]);

export interface ServeServerOptions {
  store: Store;
  /** The service token. Held in memory only; never logged or echoed. */
  token: string;
  version: string;
  now?: () => number;
  log?: (line: string) => void;
}

export type ServeServer = Server;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on("data", (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        done = true;
        reject(new HttpError(413, "body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!done) resolve(Buffer.concat(chunks));
    });
    req.on("error", (err) => {
      if (!done) {
        done = true;
        reject(err);
      }
    });
  });
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? undefined : v; // a repeated auth header is refused, not merged
}

/** Order-insensitive comparison of two validated ScopeSets. */
function sameScopes(a: ScopeSet, b: ScopeSet): boolean {
  const key = (s: ScopeSet) =>
    JSON.stringify({
      read: [...new Set(s.read.map((x) => `${x.kind}:${x.id}`))].sort(),
      write: s.write ? `${s.write.kind}:${s.write.id}` : null,
    });
  return key(a) === key(b);
}

export function createServeServer(opts: ServeServerOptions): ServeServer {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((line: string) => process.stderr.write(line + "\n"));
  const ops = createContactsAdapter({ store: opts.store, now });

  async function handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<number> {
    if (path === "/v1/health") {
      if (req.method !== "GET" && req.method !== "HEAD") return reply(res, 405, { error: "method not allowed" });
      return reply(res, 200, { ok: true, version: opts.version, schema: CONTRACT_SCHEMA });
    }

    const opName = path.startsWith("/v1/") ? path.slice(4) : undefined;
    const op = opName && Object.hasOwn(CONTACTS_OPERATIONS, opName) ? (opName as ContactsOperation) : undefined;
    if (op && req.method !== "POST") return reply(res, 405, { error: "method not allowed" });

    const body = await readBody(req);
    const auth = verifyRequest(
      opts.token,
      {
        method: req.method ?? "",
        path,
        body,
        authorization: header(req, "authorization"),
        scopes: header(req, "x-rolodex-scopes"),
        ts: header(req, "x-rolodex-ts"),
        sig: header(req, "x-rolodex-sig"),
      },
      now(),
    );
    if (!auth.ok) {
      log(`rolodex serve: 401 ${req.method} ${path} (${auth.reason})`);
      return reply(res, 401, { error: "unauthorized" });
    }
    if (!op) return reply(res, 404, { error: "not found" });

    let raw: unknown;
    try {
      raw = body.length ? JSON.parse(body.toString("utf8")) : {};
    } catch {
      return reply(res, 400, { error: "body is not JSON" });
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return reply(res, 400, { error: "body must be a JSON object" });
    const rawObj = raw as Record<string, unknown>;

    if ("scopes" in rawObj) {
      const bodyScopes = ScopeSetSchema.safeParse(rawObj.scopes);
      if (!bodyScopes.success || !sameScopes(bodyScopes.data, auth.scopes)) {
        return reply(res, 400, { error: "body scopes differ from the signed X-Rolodex-Scopes header" });
      }
    }
    if (WRITE_OPS.has(op) && !auth.scopes.write) return reply(res, 403, { error: "a write operation needs a write scope" });

    const parsed = CONTACTS_OPERATIONS[op].request.safeParse({ ...rawObj, scopes: auth.scopes });
    if (!parsed.success) {
      return reply(res, 400, {
        error: "invalid request",
        issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    const result = ops[op](parsed.data as never, rawObj);
    return reply(res, 200, result);
  }

  function reply(res: ServerResponse, status: number, body: unknown): number {
    send(res, status, body);
    return status;
  }

  const server = createServer((req, res) => {
    let path = "/";
    try {
      path = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      /* keep "/" */
    }
    handle(req, res, path)
      .catch((err: unknown) => {
        if (res.headersSent) return 0;
        if (err instanceof HttpError) return reply(res, err.status, { error: err.message });
        if (err instanceof BadRequest) return reply(res, 400, { error: err.message });
        if (err instanceof z.ZodError) return reply(res, 400, { error: "invalid request" });
        if (err instanceof ScopeDenied) return reply(res, 403, { error: err.message });
        if (err instanceof NotFound) return reply(res, 404, { error: err.message });
        log(`rolodex serve: 500 ${req.method} ${path}: ${err instanceof Error ? `${err.name}: ${err.message}` : "error"}`);
        return reply(res, 500, { error: "internal error" });
      })
      .then((status) => {
        if (status === 413) req.resume();
      });
  });
  return server;
}
