import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { ScopeSetSchema, type ScopeSet } from "./contract.js";

/**
 * Request authentication for `rolodex serve` (cm-04).
 *
 * Every route except `GET /v1/health` carries:
 *   Authorization:   Bearer <service token>
 *   X-Rolodex-Scopes: <JSON ScopeSet, contract shape>
 *   X-Rolodex-Ts:     <unix ms>
 *   X-Rolodex-Sig:    hex(HMAC-SHA256(token, method \n path \n sha256hex(body) \n scopes \n ts))
 *
 * `scopes` and `ts` are signed exactly as sent (the raw header strings), so
 * a caller holding the token cannot be replayed with different scopes and
 * nothing has to agree on a JSON canonical form. Every secret-dependent
 * comparison is constant-time. Nothing here logs, and no error carries the
 * token or a signature.
 */

/** How far X-Rolodex-Ts may be from the server clock, either way. */
export const MAX_SKEW_MS = 60_000;

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** The signature a caller sends; exported for callers and docs, never used
 * by the tests (they sign independently). */
export function signRequest(
  token: string,
  parts: { method: string; path: string; body: string | Buffer; scopes: string; ts: string },
): string {
  return createHmac("sha256", token)
    .update(`${parts.method}\n${parts.path}\n${sha256Hex(parts.body)}\n${parts.scopes}\n${parts.ts}`)
    .digest("hex");
}

/** Constant-time string equality whatever the lengths: both sides are hashed
 * to a fixed 32 bytes first, so neither content nor length leaks. */
function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

export interface AuthInput {
  method: string;
  path: string;
  body: Buffer;
  authorization: string | undefined;
  scopes: string | undefined;
  ts: string | undefined;
  sig: string | undefined;
}

export type AuthResult = { ok: true; scopes: ScopeSet } | { ok: false; reason: string };

/**
 * Verifies one request. Order: bearer token, timestamp window, signature,
 * then the ScopeSet's shape — so malformed scopes are only ever parsed
 * from a request the token holder really signed. `reason` is for the
 * server's own log and never contains request secrets.
 */
export function verifyRequest(token: string, req: AuthInput, nowMs: number): AuthResult {
  const auth = req.authorization ?? "";
  const presented = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
  // Always run the compare, even for a missing header, to keep timing flat.
  const tokenOk = safeEqual(presented, token);
  if (!presented || !tokenOk) return { ok: false, reason: "bad bearer token" };

  if (req.scopes === undefined || req.ts === undefined || req.sig === undefined) {
    return { ok: false, reason: "missing signature header" };
  }
  if (!/^\d{1,16}$/.test(req.ts)) return { ok: false, reason: "malformed timestamp" };
  const ts = Number(req.ts);
  if (Math.abs(nowMs - ts) > MAX_SKEW_MS) return { ok: false, reason: "stale timestamp" };

  const expected = signRequest(token, { method: req.method, path: req.path, body: req.body, scopes: req.scopes, ts: req.ts });
  if (!safeEqual(req.sig.toLowerCase(), expected)) return { ok: false, reason: "bad signature" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(req.scopes);
  } catch {
    return { ok: false, reason: "malformed scopes" };
  }
  const scopes = ScopeSetSchema.safeParse(parsed);
  if (!scopes.success) return { ok: false, reason: "malformed scopes" };
  return { ok: true, scopes: scopes.data };
}
