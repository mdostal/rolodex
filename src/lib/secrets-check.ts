import { randomUUID } from "node:crypto";
import { createSecretsAdapter, type CreateSecretsAdapterOptions, type SecretsAdapter } from "./secrets-adapter.js";

/** Result of a real (not simulated) secrets-backend capability probe. */
export interface SecretsCheckResult {
  ok: boolean;
  /** Human-readable backend name for display, e.g. "macOS Keychain". */
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
 */
const PROBE_STEP_TIMEOUT_MS = 5000;

class SecretsCheckTimeoutError extends Error {}

/** Runs `run(signal)`, racing it against a `ms`-millisecond timer. On
 * timeout, aborts `signal` — which a SecretsAdapter backed by execFile (see
 * secrets-adapter.ts) uses to terminate the underlying `security` child
 * process, not just abandon the Promise waiting on it — before rejecting
 * with SecretsCheckTimeoutError. (That's confirmed for the child process
 * itself; whether it also dismisses any macOS auth dialog the process
 * spawned is not independently verified — see PROBE_STEP_TIMEOUT_MS's
 * docstring.) The abort's own eventual rejection is still awaited
 * internally (via the .then below) so it can't become an unhandled
 * rejection; it's simply superseded since the timeout has already settled
 * this Promise. */
function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
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
 */
export async function checkSecretsCapability(
  factory: (opts?: CreateSecretsAdapterOptions) => SecretsAdapter = createSecretsAdapter,
): Promise<SecretsCheckResult> {
  if (process.platform !== "darwin") {
    return {
      ok: false,
      backend: "none",
      error: "No secure keychain is available in this session.",
    };
  }

  let fellBack = false;
  let fallbackCause: unknown;
  const adapter = factory({
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
      return { ok: false, backend: "in-memory (fallback)", error: classifyKeychainError(fallbackCause) };
    }
    if (readBack !== value) {
      return {
        ok: false,
        backend: "macOS Keychain",
        error: "Keychain round-trip mismatch — write appeared to succeed but read-back returned a different value.",
      };
    }
    return { ok: true, backend: "macOS Keychain" };
  } catch (err) {
    if (err instanceof SecretsCheckTimeoutError) {
      return {
        ok: false,
        backend: "macOS Keychain",
        error:
          "Your keychain is locked — unlock it and retry. (A macOS authorization prompt may be waiting for a " +
          "response and timed out.)",
      };
    }
    return { ok: false, backend: "macOS Keychain", error: classifyKeychainError(err) };
  }
}
