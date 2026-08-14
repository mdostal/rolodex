import { randomUUID } from "node:crypto";
import { classifyPortunusError, createSecretsAdapter, type CreateSecretsAdapterOptions, type SecretsAdapter } from "./secrets-adapter.js";

/** Which real backend checkSecretsCapability() is probing — mirrors
 * CreateSecretsAdapterOptions's `backend` field (secrets-adapter.ts).
 * Defaults to `"keychain"` wherever it's optional, matching that same
 * default, so every existing caller that never mentions a backend keeps
 * probing the keychain exactly as before this parameter existed. */
export type SecretsCheckBackend = "keychain" | "portunus";

/** Human-readable backend label for display (SecretsCheckResult.backend),
 * per probed backend — the single source of truth both the "ok" and "not
 * ok" result branches below pull from, so the two paths can never disagree
 * about what to call the backend being probed. */
const BACKEND_LABELS: Record<SecretsCheckBackend, string> = {
  keychain: "macOS Keychain",
  portunus: "Portunus",
};

/** Error classifier for a given backend — mirrors BACKEND_LABELS. Ensures a
 * Portunus probe's error text always comes from classifyPortunusError(),
 * never classifyKeychainError(), and vice versa. */
const BACKEND_CLASSIFIERS: Record<SecretsCheckBackend, (err: unknown) => string> = {
  keychain: classifyKeychainError,
  portunus: classifyPortunusError,
};

/** Round-trip-mismatch message per backend. The keychain string is preserved
 * verbatim from before `backend` existed (byte-identical default-path
 * requirement); Portunus gets its own, not a generic "Keychain"-prefixed one. */
const ROUND_TRIP_MISMATCH_ERROR: Record<SecretsCheckBackend, string> = {
  keychain: "Keychain round-trip mismatch — write appeared to succeed but read-back returned a different value.",
  portunus: "Portunus round-trip mismatch — write appeared to succeed but read-back returned a different value.",
};

/** Timeout message per backend. The keychain string is preserved verbatim
 * from before `backend` existed (byte-identical default-path requirement);
 * Portunus gets its own text that doesn't reference macOS/keychain-specific
 * concepts (no "keychain locked", no "macOS authorization prompt"). */
const TIMEOUT_ERROR: Record<SecretsCheckBackend, string> = {
  keychain:
    "Your keychain is locked — unlock it and retry. (A macOS authorization prompt may be waiting for a " +
    "response and timed out.)",
  portunus: "Portunus didn't respond in time — retry, and check that the `portunus` CLI isn't hung or waiting on input.",
};

/** Result of a real (not simulated) secrets-backend capability probe. */
export interface SecretsCheckResult {
  ok: boolean;
  /** Human-readable backend name for display, e.g. "macOS Keychain" or
   * "Portunus" — see BACKEND_LABELS below. */
  backend: string;
  /** Present only when ok is false — one of the setup wizard's documented
   * error-catalog messages (design brief §4), or a generic-but-real fallback. */
  error?: string;
}

/**
 * Maps a raw error from the `security` CLI (surfaced via execFile, see
 * secrets-adapter.ts's createKeychainSecretsAdapter) to one of the setup
 * wizard's documented failure messages. This is best-effort text
 * classification of a genuine error — not a simulated failure — so anything
 * unrecognized falls back to a generic message that still includes the raw
 * cause, rather than guessing wrong with confidence.
 */
export function classifyKeychainError(err: unknown): string {
  const text = errorText(err).toLowerCase();
  if (
    text.includes("interaction is not allowed") ||
    text.includes("keychain is locked") ||
    text.includes("errsecinteractionnotallowed") ||
    text.includes("-25308")
  ) {
    return "Your keychain is locked — unlock it and retry.";
  }
  if (
    text.includes("permission denied") ||
    text.includes("eacces") ||
    text.includes("eperm") ||
    text.includes("errsecauthfailed") ||
    text.includes("not permitted")
  ) {
    return "Rolodex doesn't have permission to access the keychain. Check your OS privacy/security settings.";
  }
  if (text.includes("enoent") || text.includes("command not found")) {
    return "No secure keychain is available in this session.";
  }
  return `Couldn't write to your system keychain (${errorText(err)}).`;
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    const withStd = err as Error & { stderr?: string; stdout?: string };
    return [err.message, withStd.stderr, withStd.stdout].filter(Boolean).join(" | ");
  }
  return String(err);
}

/** Bounds how long a single get/set/delete call in the probe below is
 * allowed to take. Empirically necessary, not defensive paranoia: on a
 * session with no interactive GUI to approve a keychain-access prompt (e.g.
 * a sandboxed/headless dev environment), `security add-generic-password`
 * can hang indefinitely waiting for an authorization dialog nobody can
 * click through, rather than failing fast — confirmed live against the real
 * `security` CLI during this story's own manual verification. Without this,
 * the wizard's "Checking keychain access…" spinner would never resolve and
 * Retry would never even become reachable, which defeats the whole point of
 * this being the wizard's one hard, retryable gate. This bounds both the
 * PROMISE this module waits on AND the underlying `security` child process
 * itself: withTimeout() below aborts an AbortSignal on timeout, which
 * secrets-adapter.ts's execFile-based backend threads straight through to
 * execFile's own `signal` option, so a timed-out call actually terminates
 * the `security` child process rather than merely abandoning it to run in
 * the background indefinitely. Whether that also dismisses any macOS
 * authorization *dialog* is a separate, unverified question: if the prompt
 * is owned by a system daemon (e.g. SecurityAgent) rather than being a
 * direct child of `security` itself, killing `security` unblocks this
 * Promise but the dialog could still be left on screen. Confirmed here is
 * only that the child process is torn down.
 *
 * Exported so secrets-adapter.ts's isPortunusAvailable() can reuse this
 * exact value/mechanism for its own `portunus --version` probe instead of
 * reinventing a weaker one — this codebase already has direct, documented
 * experience with a CLI hanging on an interactive prompt instead of failing
 * fast (see above), and there's no reason to assume Portunus is immune.
 */
export const PROBE_STEP_TIMEOUT_MS = 5000;

class SecretsCheckTimeoutError extends Error {}

/** Runs `run(signal)`, racing it against a `ms`-millisecond timer. On
 * timeout, aborts `signal` — which a SecretsAdapter backed by execFile (see
 * secrets-adapter.ts) uses to terminate the underlying child process, not
 * just abandon the Promise waiting on it — before rejecting with
 * SecretsCheckTimeoutError. (That's confirmed for the child process itself;
 * whether it also dismisses any macOS auth dialog the process spawned is
 * not independently verified — see PROBE_STEP_TIMEOUT_MS's docstring.) The
 * abort's own eventual rejection is still awaited internally (via the .then
 * below) so it can't become an unhandled rejection; it's simply superseded
 * since the timeout has already settled this Promise.
 *
 * Exported so secrets-adapter.ts's isPortunusAvailable() reuses this same
 * proven mechanism rather than reinventing a weaker one (see
 * PROBE_STEP_TIMEOUT_MS's docstring). */
export function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new SecretsCheckTimeoutError(`keychain call did not respond within ${ms}ms`));
    }, ms);
    run(controller.signal).then(
      (v) => { clearTimeout(timer); resolve(v); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/**
 * Real (not simulated) capability probe for the setup wizard's Secrets-check
 * screen: writes, reads back, and deletes a throwaway key through a FRESH
 * SecretsAdapter instance — deliberately bypassing whatever shared adapter
 * the rest of the app already has running, so a first-call keychain failure
 * can't be masked by that adapter's own automatic in-memory fallback (see
 * secrets-adapter.ts's withInMemoryFallback). Per the design brief this is
 * the wizard's one true hard gate: if the real backend can't be used, the
 * user needs to know, not have it silently degrade to a store that won't
 * survive a restart.
 *
 * `factory` defaults to the real createSecretsAdapter but is injectable so
 * tests (and the wizard server's own tests) can exercise both outcomes
 * without touching a real OS keychain.
 *
 * `backend` selects which real backend to probe (keychain vs. Portunus),
 * defaulting to `"keychain"` — matching CreateSecretsAdapterOptions's own
 * default — so every existing caller that never passes this argument probes
 * exactly what it always has, with byte-identical results, labels, and
 * error text. It's threaded straight through to `factory({ backend,
 * onFallback })`, and also picks which backend-specific label
 * (BACKEND_LABELS) and error classifier (BACKEND_CLASSIFIERS) this function
 * itself uses below — a Portunus probe's `SecretsCheckResult.backend` and
 * `.error` never use keychain vocabulary, and vice versa.
 *
 * The non-darwin platform short-circuit below only applies to the keychain
 * backend, which is genuinely Darwin-only (see secrets-adapter.ts's
 * createKeychainSecretsAdapter()) — Portunus is a plain CLI with no such
 * platform restriction, so a Portunus probe runs the real set/get/delete
 * round trip on every platform.
 */
export async function checkSecretsCapability(
  factory: (opts?: CreateSecretsAdapterOptions) => SecretsAdapter = createSecretsAdapter,
  backend: SecretsCheckBackend = "keychain",
): Promise<SecretsCheckResult> {
  const backendLabel = BACKEND_LABELS[backend];
  const classifyError = BACKEND_CLASSIFIERS[backend];

  if (backend === "keychain" && process.platform !== "darwin") {
    return {
      ok: false,
      backend: "none",
      error: "No secure keychain is available in this session.",
    };
  }

  let fellBack = false;
  let fallbackCause: unknown;
  const adapter = factory({
    backend,
    onFallback: (err) => {
      fellBack = true;
      fallbackCause = err;
    },
  });

  const key = `wizard.secrets-check.${randomUUID()}`;
  const value = randomUUID();
  try {
    await withTimeout((signal) => adapter.set(key, value, { signal }), PROBE_STEP_TIMEOUT_MS);
    const readBack = await withTimeout((signal) => adapter.get(key, { signal }), PROBE_STEP_TIMEOUT_MS);
    // Best-effort cleanup: if delete() itself hangs/fails, that shouldn't
    // flip an otherwise-successful set+get round trip to a failure.
    await withTimeout((signal) => adapter.delete(key, { signal }), PROBE_STEP_TIMEOUT_MS).catch(() => {});

    if (fellBack) {
      return { ok: false, backend: "in-memory (fallback)", error: classifyError(fallbackCause) };
    }
    if (readBack !== value) {
      return {
        ok: false,
        backend: backendLabel,
        error: ROUND_TRIP_MISMATCH_ERROR[backend],
      };
    }
    return { ok: true, backend: backendLabel };
  } catch (err) {
    if (err instanceof SecretsCheckTimeoutError) {
      return {
        ok: false,
        backend: backendLabel,
        error: TIMEOUT_ERROR[backend],
      };
    }
    return { ok: false, backend: backendLabel, error: classifyError(err) };
  }
}
