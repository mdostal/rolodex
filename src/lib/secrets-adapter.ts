import { execFile, type PromiseWithChild } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { classifyKeychainError, PROBE_STEP_TIMEOUT_MS, withTimeout } from "./secrets-check.js";

/**
 * Storage for this app's Google OAuth credentials (client secret, refresh
 * token, etc.) — pluggable so the real backend (OS keychain) and a fake
 * (in-memory) can share one call site. Mirrors the shape of
 * `GoogleSync`/`createGoogleSync()` in ./google-sync.ts: an interface plus a
 * factory, real-by-default, fake available on demand for tests.
 *
 * Backend choice: shelling out to the macOS `security` CLI
 * (add/find/delete-generic-password), not a native npm module.
 *
 *  - `keytar` (the historical default for this) is archived/unmaintained —
 *    explicitly ruled out.
 *  - `@napi-rs/keyring` is actively maintained (as of this writing) and
 *    would work, but it's still a compiled native module distributed as
 *    per-platform prebuilds: `npm install` has to fetch the right binary for
 *    this OS/arch/Node ABI, which can fail in exactly the kind of offline/
 *    sandboxed environment this factory needs to degrade gracefully in (see
 *    below), and it adds a dependency + install-time risk for something one
 *    CLI call already does.
 *  - `security` ships with every macOS install, takes no dependency, and
 *    needs no compilation — `child_process.execFile` (argv array, not a
 *    shell string) calling it directly is the most robust option available
 *    for this macOS-only shell (see src/shell/server.ts's own
 *    `process.platform === "darwin"` assumption). Exit code 44 means
 *    "item not found" for both `find-generic-password` and
 *    `delete-generic-password` (verified locally) and is treated as a
 *    non-error "absent" result rather than a thrown error.
 *
 * If this ever needs to run on Windows/Linux, swap in a platform-specific
 * real backend behind the same interface — nothing above this layer cares.
 */
/** Per-call options threaded through to the underlying `security` child
 * process (real backend only — the in-memory fake ignores this). Lets a
 * caller that imposes its own timeout (see secrets-check.ts's
 * checkSecretsCapability()) actually terminate a hung child process instead
 * of merely abandoning the Promise that's waiting on it. */
export interface SecretsAdapterCallOptions {
  signal?: AbortSignal;
}

export interface SecretsAdapter {
  get(key: string, opts?: SecretsAdapterCallOptions): Promise<string | undefined>;
  set(key: string, value: string, opts?: SecretsAdapterCallOptions): Promise<void>;
  delete(key: string, opts?: SecretsAdapterCallOptions): Promise<void>;
}

const execFileAsync = promisify(execFile);

/** Keychain "service" all rolodex secrets are filed under; `key` is the account. */
const SERVICE = "rolodex";

/** Exit code `security` uses for "no matching keychain item" on find/delete. */
const SEC_ITEM_NOT_FOUND = 44;

function hasCode(err: unknown): err is { code: number } {
  return typeof err === "object" && err !== null && "code" in err && typeof (err as { code: unknown }).code === "number";
}

/**
 * Strips argv from an execFile error thrown by `set()`.
 *
 * Node's execFile/promisify, on a nonzero exit, builds an error whose
 * `.message` embeds `Command failed: <full argv>` and whose `.cmd` holds
 * that same argv string. `set()`'s argv is `security add-generic-password
 * ... -w <value> -U` — i.e. it contains the plaintext secret being stored.
 * If that error were ever allowed to reach a log sink as-is (directly, or
 * via a helper that echoes `.message`/`.cmd` back out — see
 * classifyKeychainError()'s own generic-fallback branch in
 * secrets-check.ts, which deliberately includes the raw error text), the
 * secret would print in plaintext. This rebuilds a clean error carrying
 * only the genuine diagnostic fields (`.code`, `.stderr`, `.stdout`) that
 * `security` itself produced and which do not echo `-w`'s value back —
 * deliberately dropping `.cmd` and the argv-laden `.message`. Anything
 * downstream of `set()` (console.warn in withInMemoryFallback below,
 * classifyKeychainError(), etc.) only ever sees this sanitized error.
 */
function sanitizeSetError(err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  const withStd = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; cmd?: string };
  if (withStd.cmd === undefined) return err; // no argv was embedded (e.g. spawn ENOENT) — already safe
  const detail = [withStd.stderr, withStd.stdout].map((s) => s?.trim()).filter(Boolean).join(" | ");
  const sanitized = new Error(
    `security add-generic-password failed${detail ? `: ${detail}` : " (no diagnostic output)"}`,
  ) as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
  sanitized.code = withStd.code;
  sanitized.stderr = withStd.stderr;
  sanitized.stdout = withStd.stdout;
  return sanitized;
}

/**
 * Parse one `password: ...` line from `security find-generic-password -g`
 * output back into the original secret text. Empirically verified on this
 * machine (see secrets-adapter.test.ts / task notes — undocumented in
 * `man security`, which only says `-w` "display[s] the password(only)"):
 *
 *  - If the stored value is "safe" — pure ASCII with no control characters
 *    (no \n, \t, etc.), no backslash, and nothing above 0x7F — `security`
 *    prints it completely unescaped, wrapped in one literal pair of double
 *    quotes: `password: "<value>"`. Any quote characters *inside* the value
 *    are reproduced byte-for-byte, unescaped, so the value is recovered by
 *    stripping only the outermost quote character on each end — not by
 *    matching quote pairs, which would break on a value like `a "b" c`.
 *  - Otherwise (embedded newline/tab, other control chars, backslash, or
 *    multi-byte/non-ASCII text) `security` hex-encodes the raw bytes and
 *    prints both forms: `password: 0x<HEX>  "<escaped display copy>"`. The
 *    hex is the reliable part (raw bytes, unambiguous); the quoted copy is
 *    only for human eyeballing (control bytes shown as octal escapes like
 *    `\012`, but e.g. embedded `"`/`\` are NOT escaped there either) so it
 *    is not parsed.
 *  - An empty string is `password: ` with nothing after — no quotes, no hex.
 *
 * This is the same ambiguity `-w`'s bare output can't resolve on its own:
 * `-w` for the 4 raw bytes 0xDE 0xAD 0xBE 0xEF and `-w` for the literal
 * 8-character ASCII string "deadbeef" both print `deadbeef\n`, because both
 * get hex-encoded to (coincidentally) the same digits. `-g`'s explicit `0x`
 * marker on the hex form (present only when hex-encoding actually happened)
 * is what makes the two cases distinguishable.
 */
function parseSecurityPasswordLine(line: string): string {
  const prefix = "password: ";
  if (!line.startsWith(prefix)) {
    throw new Error(`secrets-adapter: unrecognized "security" password line: ${JSON.stringify(line)}`);
  }
  const rest = line.slice(prefix.length);
  if (rest === "") return "";
  if (rest[0] === '"') {
    if (rest.length < 2 || rest[rest.length - 1] !== '"') {
      throw new Error(`secrets-adapter: unrecognized "security" password line: ${JSON.stringify(line)}`);
    }
    return rest.slice(1, -1);
  }
  const hexMatch = /^0x([0-9A-Fa-f]+)\s/.exec(rest);
  if (hexMatch?.[1] !== undefined) {
    return Buffer.from(hexMatch[1], "hex").toString("utf8");
  }
  throw new Error(`secrets-adapter: unrecognized "security" password line: ${JSON.stringify(line)}`);
}

/** Real backend: macOS Keychain via the `security` CLI. Darwin-only. */
function createKeychainSecretsAdapter(): SecretsAdapter {
  return {
    async get(key, opts) {
      try {
        // Deliberately `-g`, not `-w`: `-w` prints only the raw password,
        // but macOS hex-encodes that raw output whenever the stored value
        // contains a newline/tab/control character or any non-ASCII byte —
        // with no marker distinguishing "this is hex" from "the password
        // legitimately looks like hex digits". `-g` prints an explicit `0x`
        // prefix only when it actually hex-encoded, which is what lets
        // parseSecurityPasswordLine() decode losslessly. See its docstring
        // for the full empirical writeup.
        //
        // Also note: the `password:` line `-g` produces lands on stderr,
        // not stdout (the rest of `-g`'s item dump — keychain, attributes,
        // etc. — goes to stdout). That's undocumented and easy to miss, so
        // this checks both streams for it rather than assuming stderr.
        const { stdout, stderr } = await execFileAsync(
          "security",
          ["find-generic-password", "-a", key, "-s", SERVICE, "-g"],
          { signal: opts?.signal },
        );
        const line = `${stderr}${stdout}`.split("\n").find((l) => l.startsWith("password: "));
        if (line === undefined) {
          throw new Error('secrets-adapter: "security find-generic-password -g" produced no "password:" line');
        }
        return parseSecurityPasswordLine(line);
      } catch (err) {
        if (hasCode(err) && err.code === SEC_ITEM_NOT_FOUND) return undefined;
        throw err;
      }
    },
    async set(key, value, opts) {
      try {
        // -U: update the existing item in place instead of erroring if it's
        // already there, so set() is a plain upsert either way.
        await execFileAsync(
          "security",
          ["add-generic-password", "-a", key, "-s", SERVICE, "-w", value, "-U"],
          { signal: opts?.signal },
        );
      } catch (err) {
        // See sanitizeSetError()'s docstring: this argv contains `value`
        // (the secret) itself, so any error thrown here must never leave
        // this function with that argv still attached.
        throw sanitizeSetError(err);
      }
    },
    async delete(key, opts) {
      try {
        await execFileAsync("security", ["delete-generic-password", "-a", key, "-s", SERVICE], {
          signal: opts?.signal,
        });
      } catch (err) {
        // Already absent — delete() is idempotent, so this isn't an error.
        if (hasCode(err) && err.code === SEC_ITEM_NOT_FOUND) return;
        throw err;
      }
    },
  };
}

/**
 * Real backend #2: Portunus (github.com/mdostal/portunus), a separate,
 * independently-installed local CLI ("OSTIARIUS — the `portunus` engine
 * tool agents call") — confirmed real and dogfooded, not aspirational (see
 * .pHive/epics/portunus-secrets-backend/docs/design-discussion.md).
 *
 * Portunus's contract is materially different from Keychain's single
 * `-w`/`-g` calls, and deliberately has **no** "get secret by key -> string"
 * API — a resolved value is only ever handed back via a tempfile-path
 * printed to stdout (0600, caller reads then deletes it), never returned
 * directly. Writing is a required two-step: `drop` lands the value
 * `state=dropped` (fail-closed — not yet resolvable), and a separate
 * `state <name> enabled` call is what actually makes it resolvable.
 *
 * All of the following was confirmed empirically against the real,
 * installed `portunus 0.14.0` CLI (isolated `PORTUNUS_HOME`, never rolodex's
 * real one) before writing this — see the PR description for the exact
 * commands/output:
 *
 *  - `portunus --version` returns in well under 100ms, exit 0, with no
 *    interactive prompt — same "doesn't hang" property `withTimeout()` below
 *    still defends against, mirroring secrets-check.ts's own documented
 *    prior experience with a *different* CLI (`security`) that does hang.
 *  - `portunus resolve "{{secret:NAME}}"` prints an absolute path under the
 *    OS temp dir (`/var/folders/.../T/portunus-XXXXXXXX` on this machine,
 *    matching `os.tmpdir()` exactly), mode 0600, a plain regular file.
 *    Portunus does NOT delete it itself — the caller must, which is exactly
 *    why get() below wraps the read in try/finally.
 *  - Retrying set() after a failed `state enabled` call is safe: re-running
 *    `drop` with the same `name`/`sm_name` overwrites the still-`dropped`
 *    entry with the new value, and a subsequent `state enabled` call then
 *    makes *that* (the retried) value resolvable. Verified end-to-end
 *    (drop → simulated state-enable failure → drop again with a different
 *    value → state enabled → resolve) that the final resolved value is the
 *    retried one, not the first.
 *  - `portunus reg rm <name>` on a name that was never registered exits 0
 *    with "no such reference" on stdout — already idempotent by default, no
 *    special-case error-code handling needed (unlike Keychain's exit-44
 *    convention). delete() below still defensively treats a
 *    "no such reference"/"unknown reference" *error* text the same way, in
 *    case a future/older Portunus version reports this case as a nonzero
 *    exit instead.
 *  - A real dotted, multi-segment key (`rolodex.google.oauth.client`) round-
 *    trips through drop/state/resolve/reg-rm identically to a simple key —
 *    dots are not special. Per `portunus drop --help`, `name` is "reference
 *    name, e.g. shared-anthropic" (the `{{secret:NAME}}` template alias)
 *    and `sm_name` is "vault key, e.g. dostal-shared-anthropic" (the
 *    underlying storage key, which for other backends/scopes can genuinely
 *    differ from `name`). `portunus reg json`'s output confirms `name` and
 *    `sm_name` as parallel-but-separate fields. rolodex uses the same
 *    string for both — there's no reason for them to diverge for a local,
 *    single-purpose vault entry, and Portunus does not require they match.
 *  - Attempted to trigger real Portunus failure paths with a distinctive
 *    marker piped via `--stdin` (argparse mutual-exclusion errors; a forced
 *    backend-init failure by corrupting the vault's Fernet key, which dumps
 *    a full Python traceback to stderr; and a genuine permission-denied
 *    failure via `chmod 000` directly on the vault's `master.key` file
 *    itself inside a real, isolated `PORTUNUS_HOME` — not merely the
 *    containing directory, which Portunus normalizes back to a writable
 *    mode on each invocation and which in-place writes to already-open
 *    files don't require write access to anyway; `chmod 000` on the key
 *    file itself does trigger a genuine Python `PermissionError` traceback
 *    from the real process) — the marker never appeared on stdout or stderr
 *    in any case tried, including the permission-denied one, and
 *    classifyPortunusError()'s output was also confirmed marker-free for
 *    it. sanitizePortunusError() below still strips execFile argv/`.cmd`
 *    from every thrown error regardless, as defense in depth — not solely
 *    because a leak was observed.
 *  - `portunus resolve` on a name with no matching registry entry at all
 *    prints `unknown reference ...` (exit 1) — mapped to `undefined` by
 *    get(), matching every other method's idempotent-absence contract. A
 *    name that *is* registered but still `state=dropped` (never enabled)
 *    prints a different message (`... is dropped — not injectable`) and is
 *    deliberately NOT treated as absent — that's a real, broken-config
 *    error, not "never set", so get() still throws for it.
 */

/** Per-call context passed to the injectable Portunus CLI runner. Mirrors
 * the argv-array + AbortSignal execFile pattern the Keychain backend uses,
 * plus optional `input` (piped to the child's stdin for `drop --stdin`) —
 * unlike Keychain's `-w <value>` argv, Portunus's write path deliberately
 * never puts the secret value on argv, so the runner has to support stdin
 * piping instead. */
export interface PortunusRunOptions {
  signal?: AbortSignal;
  input?: string;
}

/** Injectable stand-in for `execFile("portunus", args, opts)`, so tests can
 * fake the real CLI's behavior (argv assertions, thrown errors shaped like
 * Node's own execFile errors — `.code`/`.cmd`/`.stderr`/`.stdout` — and
 * stdout/stderr content) without a real portunus binary in the automated
 * suite. Mirrors secrets-check.ts's checkSecretsCapability() `factory`
 * injection seam, same rationale. Defaults to the real portunus binary. */
export type PortunusRunner = (args: string[], opts: PortunusRunOptions) => Promise<{ stdout: string; stderr: string }>;

async function runPortunus(args: string[], opts: PortunusRunOptions): Promise<{ stdout: string; stderr: string }> {
  const result: PromiseWithChild<{ stdout: string; stderr: string }> = execFileAsync("portunus", args, { signal: opts.signal });
  if (opts.input !== undefined) {
    // Swallow stdin stream errors (e.g. EPIPE if the child exits before/
    // while we're writing) here — execFileAsync's own rejection (nonzero
    // exit, signal, etc.) is always the real, complete error; an unhandled
    // 'error' event on the stdin stream itself would otherwise crash the
    // process independently of that rejection.
    result.child.stdin?.on("error", () => {});
    result.child.stdin?.end(opts.input, "utf8");
  }
  return result;
}

/** Reference-name prefix all rolodex secrets are filed under in Portunus's
 * registry (mirrors Keychain's `SERVICE` constant). Used as both the
 * `name` (reference alias) and `sm_name` (vault key) argument to `drop` —
 * see this section's docstring for why that's safe for rolodex's usage. */
const PORTUNUS_REF_PREFIX = "rolodex.";

function portunusRefName(key: string): string {
  return `${PORTUNUS_REF_PREFIX}${key}`;
}

function portunusErrorText(err: unknown): string {
  if (err instanceof Error) {
    const withStd = err as Error & { stderr?: string; stdout?: string };
    return [err.message, withStd.stderr, withStd.stdout].filter(Boolean).join(" | ");
  }
  return String(err);
}

/** `portunus resolve` on a name with no matching registry entry at all
 * (never dropped) prints `unknown reference ...` and exits 1 — confirmed
 * against the real CLI (see this section's docstring). Treated as "absent",
 * matching every other SecretsAdapter method's idempotent-absence contract.
 * Deliberately NOT matched by this: a name that exists but is still
 * `state=dropped` (never enabled) — that prints a different message
 * ("... is dropped — not injectable") and is a genuinely different, broken-
 * config error that get() still throws for instead of hiding as "absent". */
function isPortunusUnknownReference(err: unknown): boolean {
  return /unknown reference/i.test(portunusErrorText(err));
}

/** `portunus reg rm` on a name that was never registered exits 0 with "no
 * such reference" on the real CLI (confirmed empirically — see this
 * section's docstring), so this regex match is a defensive normalization
 * for any Portunus version that instead reports it as a thrown/nonzero-exit
 * error, per this story's required "absent = success" idempotency contract
 * for delete(). */
function isPortunusAbsentReference(err: unknown): boolean {
  return /no such reference|unknown reference/i.test(portunusErrorText(err));
}

/**
 * Strips argv/`.cmd` from a Portunus execFile error before it can reach a
 * log sink — parallel to sanitizeSetError() above, but Portunus-specific
 * and reused across all three operations (`label` names which one failed:
 * "resolve"/"drop"/"state"/"reg rm"). Applied as defense-in-depth on every
 * thrown error from this backend, not only where a secret value could
 * plausibly appear in argv (Portunus's own write path never puts the value
 * there — see this section's docstring on the stderr-echo empirical check).
 */
function sanitizePortunusError(err: unknown, label: string): unknown {
  if (!(err instanceof Error)) return err;
  const withStd = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; cmd?: string };
  if (withStd.cmd === undefined) return err; // no argv was embedded (e.g. spawn ENOENT) — already safe
  const detail = [withStd.stderr, withStd.stdout].map((s) => s?.trim()).filter(Boolean).join(" | ");
  const sanitized = new Error(
    `portunus ${label} failed${detail ? `: ${detail}` : " (no diagnostic output)"}`,
  ) as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
  sanitized.code = withStd.code;
  sanitized.stderr = withStd.stderr;
  sanitized.stdout = withStd.stdout;
  return sanitized;
}

/**
 * Maps a raw error from the `portunus` CLI to a human-readable summary —
 * parallel to but separate from classifyKeychainError() (different backend,
 * different error vocabulary; deliberately not merged into one generic
 * classifier, matching this story's design decision). Best-effort text
 * classification of a genuine error, not a simulated one — anything
 * unrecognized falls back to a generic message that still includes the raw
 * (already-sanitized, if this is called on a sanitizePortunusError() result)
 * cause rather than guessing wrong with confidence.
 */
export function classifyPortunusError(err: unknown): string {
  const text = portunusErrorText(err).toLowerCase();
  if (text.includes("enoent") || text.includes("command not found") || text.includes("spawn portunus")) {
    return "Portunus isn't installed, or isn't on PATH.";
  }
  if (text.includes("not injectable") || text.includes("is dropped")) {
    return "That Portunus reference exists but isn't enabled yet (state=dropped) — run `portunus state <name> enabled`.";
  }
  if (text.includes("unknown reference") || text.includes("no such reference")) {
    return "No matching Portunus reference was found.";
  }
  if (text.includes("permission denied") || text.includes("eacces") || text.includes("eperm")) {
    return "Rolodex doesn't have permission to run Portunus or access its vault.";
  }
  return `Couldn't complete the Portunus operation (${portunusErrorText(err)}).`;
}

/**
 * Validates that a path `portunus resolve` printed is provably a
 * Portunus-owned tempfile before get() ever opens it (grill finding F10) —
 * a printed "looks like a path" string is not proof of provenance. Checks,
 * all required: absolute, lies under the OS temp directory, and the file
 * itself is a regular file, not a symlink.
 *
 * The "lies under the OS temp directory" check is done on the REALPATH of
 * the path's DIRECTORY portion, not the printed path's directory as
 * written — `fs.realpath()` resolves every symlink component in that
 * directory chain, which is required because an INTERMEDIATE symlinked
 * directory placed directly inside `os.tmpdir()` (e.g.
 * `os.tmpdir()/evil-subdir -> /elsewhere`, with the printed path being
 * `os.tmpdir()/evil-subdir/realfile`) would otherwise sail through both a
 * naive string-prefix check AND a lexical `path.relative()`-based check:
 * neither inspects the filesystem, so neither notices that `evil-subdir` is
 * a symlink pointing outside the temp dir. `os.tmpdir()` itself is also
 * resolved via `fs.realpath()` before comparing (not compared as written),
 * so a symlinked temp-dir root (e.g. macOS's `/tmp -> /private/tmp`)
 * doesn't cause a false rejection when the printed path is already
 * expressed via the resolved form. `path.relative()` (rather than a naive
 * string-prefix check) is still used for the actual comparison once both
 * sides are resolved, since a prefix check would be foolable by a sibling
 * directory that merely starts with the same characters, e.g. `/tmp-evil`
 * vs `/tmp`.
 *
 * The terminal path component (the basename) is deliberately checked
 * separately, via `lstat` — which (unlike `stat`) does NOT follow
 * symlinks — against the RESOLVED directory, closing the TOCTOU-ish "path
 * got swapped for a symlink between print and read" risk for the final
 * component. This is intentionally NOT folded into the `fs.realpath()` call
 * above: resolving the full path (directory + basename) in one shot would
 * transparently follow a symlink at the final component too, silently
 * defeating this exact protection.
 *
 * Returns the fully-resolved path (resolved directory + original
 * basename). Callers (get()) MUST perform the actual read/unlink against
 * *this* returned path, not the original printed path — validating a path
 * and then still operating on the original, potentially symlink-traversing
 * path would leave the intermediate-symlink gap open even after this
 * function's checks pass.
 *
 * Any violation throws and neither this function nor get() ever calls
 * fs.readFile/fs.unlink on the offending path.
 */
async function assertPortunusTempFilePath(p: string): Promise<string> {
  if (!path.isAbsolute(p)) {
    throw new Error(`secrets-adapter: portunus resolve printed a non-absolute path — refusing to read it: ${JSON.stringify(p)}`);
  }
  const dir = path.dirname(p);
  const base = path.basename(p);
  let resolvedDir: string;
  let resolvedTmpDir: string;
  try {
    [resolvedDir, resolvedTmpDir] = await Promise.all([fs.realpath(dir), fs.realpath(os.tmpdir())]);
  } catch {
    throw new Error(`secrets-adapter: portunus resolve printed a path that doesn't exist — refusing to read it: ${JSON.stringify(p)}`);
  }
  const rel = path.relative(resolvedTmpDir, resolvedDir);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(
      `secrets-adapter: portunus resolve printed a path outside the OS temp directory — refusing to read it: ${JSON.stringify(p)}`,
    );
  }
  const resolvedPath = path.join(resolvedDir, base);
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(resolvedPath);
  } catch {
    throw new Error(`secrets-adapter: portunus resolve printed a path that doesn't exist — refusing to read it: ${JSON.stringify(p)}`);
  }
  if (!stat.isFile()) {
    throw new Error(
      `secrets-adapter: portunus resolve printed a path that is not a regular file (symlinks are rejected via lstat, not ` +
        `followed) — refusing to read it: ${JSON.stringify(p)}`,
    );
  }
  return resolvedPath;
}

/**
 * Probes whether the real `portunus` CLI is present and responsive, via
 * `portunus --version` — confirmed empirically (see this section's
 * docstring) to return in well under 100ms with no interactive prompt on
 * this machine, but this still uses the exact same AbortSignal-based
 * timeout mechanism as secrets-check.ts's withTimeout()/
 * PROBE_STEP_TIMEOUT_MS (not a weaker or reinvented one) per this story's
 * design decision — this codebase has direct prior experience with a
 * *different* CLI (`security`) hanging on an interactive prompt instead of
 * failing fast, and there's no guarantee every Portunus install/environment
 * behaves like this one. Never throws: ENOENT (not installed), a timeout,
 * or a nonzero exit all resolve to `false`.
 */
export async function isPortunusAvailable(deps?: { run?: PortunusRunner }): Promise<boolean> {
  const run = deps?.run ?? runPortunus;
  try {
    await withTimeout((signal) => run(["--version"], { signal }), PROBE_STEP_TIMEOUT_MS);
    return true;
  } catch {
    return false;
  }
}

/**
 * Real backend #2: Portunus, via the `portunus` CLI. See this section's
 * top-of-block docstring for the full empirical writeup this implementation
 * is built against. `deps.run` is test-only injection (defaults to the real
 * `portunus` binary via execFile) — see PortunusRunner's docstring.
 */
export function createPortunusSecretsAdapter(deps?: { run?: PortunusRunner }): SecretsAdapter {
  const run = deps?.run ?? runPortunus;
  return {
    async get(key, opts) {
      const ref = portunusRefName(key);
      let stdout: string;
      try {
        ({ stdout } = await run(["resolve", `{{secret:${ref}}}`], { signal: opts?.signal }));
      } catch (err) {
        if (isPortunusUnknownReference(err)) return undefined;
        throw sanitizePortunusError(err, "resolve");
      }
      const printedPath = stdout.trim();
      // Provenance check happens BEFORE any filesystem read — see
      // assertPortunusTempFilePath()'s docstring. If it throws, get()
      // returns here without ever having opened (or attempted to delete)
      // the offending path. The read/delete below deliberately use the
      // RESOLVED path this returns, not `printedPath` itself — operating on
      // the original, potentially symlink-traversing path after validating
      // a *different* (resolved) path would reopen the intermediate-symlink
      // gap the validation exists to close.
      const resolvedPath = await assertPortunusTempFilePath(printedPath);
      try {
        return await fs.readFile(resolvedPath, "utf8");
      } finally {
        // Always attempt deletion, even if the read above throws — a
        // secret-bearing tempfile must never be left behind on an error
        // path. Best-effort: if the delete itself fails, that shouldn't
        // mask the original read outcome (success or throw).
        await fs.unlink(resolvedPath).catch(() => {});
      }
    },
    async set(key, value, opts) {
      const ref = portunusRefName(key);
      try {
        // Value goes via stdin, never argv — see PortunusRunOptions's
        // docstring on why this backend's runner supports piping at all.
        await run(["drop", ref, ref, "--stdin"], { signal: opts?.signal, input: value });
      } catch (err) {
        throw sanitizePortunusError(err, "drop");
      }
      try {
        // Required second step — `drop` alone lands state=dropped, which
        // is NOT resolvable. If this fails, set() throws and deliberately
        // does NOT attempt to roll back the drop above (a rollback call is
        // itself a new failure surface) — confirmed empirically that a
        // plain retry of set() is safe against the resulting
        // dropped-but-disabled entry (see this section's docstring).
        await run(["state", ref, "enabled"], { signal: opts?.signal });
      } catch (err) {
        throw sanitizePortunusError(err, "state");
      }
    },
    async delete(key, opts) {
      const ref = portunusRefName(key);
      try {
        await run(["reg", "rm", ref], { signal: opts?.signal });
      } catch (err) {
        // Already absent — delete() is idempotent, matching every other
        // SecretsAdapter method's contract. (On the real CLI this branch is
        // currently unreachable — `reg rm` on an absent name exits 0 — but
        // kept as a defensive normalization; see isPortunusAbsentReference().)
        if (isPortunusAbsentReference(err)) return;
        throw sanitizePortunusError(err, "reg rm");
      }
    },
  };
}

/** Fake backend: plain in-memory Map. For tests, and the safe-fallback target. */
export function createInMemorySecretsAdapter(): SecretsAdapter {
  const store = new Map<string, string>();
  return {
    // `opts`/`signal` accepted for interface compatibility only — a plain
    // Map access is synchronous and has no child process to abort.
    async get(key, _opts) {
      return store.get(key);
    },
    async set(key, value, _opts) {
      store.set(key, value);
    },
    async delete(key, _opts) {
      store.delete(key);
    },
  };
}

export interface CreateSecretsAdapterOptions {
  /**
   * Called at most once, if the real backend throws on its very first call
   * and this adapter permanently swaps over to an in-memory store for the
   * rest of the process. Exists so a caller that cares about the
   * distinction (the setup wizard's Secrets-check probe, specifically) can
   * tell "genuinely wrote to the keychain" apart from "silently degraded to
   * a non-persistent store" — the normal `SecretsAdapter` interface can't
   * expose that on its own since get/set/delete still resolve successfully
   * either way.
   */
  onFallback?: (err: unknown) => void;
}

/**
 * Wraps a real adapter so that if its first call ever throws (no `security`
 * binary, not macOS, sandboxed with no keychain access, etc.), the whole
 * adapter permanently swaps over to an in-memory fake for the rest of the
 * process instead of crashing the app. Warns once, on the switch, and
 * invokes `onFallback` (if given) with the triggering error.
 */
function withInMemoryFallback(real: SecretsAdapter, onFallback?: (err: unknown) => void): SecretsAdapter {
  let active: SecretsAdapter = real;
  let fellBack = false;

  async function guarded<T>(run: (adapter: SecretsAdapter) => Promise<T>): Promise<T> {
    if (fellBack) return run(active);
    try {
      return await run(active);
    } catch (err) {
      // Deliberately NOT `err.message`/`err instanceof Error ? err.message :
      // ...` here: a raw execFile error's `.message` (and `.cmd`) can embed
      // full argv, which for set() includes the plaintext secret value
      // itself (see sanitizeSetError() above). classifyKeychainError()
      // returns a pattern-classified, human-safe summary instead — never
      // the raw error text — so this can't leak a secret to the console/log
      // on a keychain write failure.
      console.warn(
        `[secrets-adapter] real (keychain) backend failed on first use — falling back to an ` +
          `in-memory store for this process. Secrets will NOT persist across restarts. Cause: ${classifyKeychainError(err)}`,
      );
      active = createInMemorySecretsAdapter();
      fellBack = true;
      onFallback?.(err);
      return run(active);
    }
  }

  return {
    get: (key, opts) => guarded((a) => a.get(key, opts)),
    set: (key, value, opts) => guarded((a) => a.set(key, value, opts)),
    delete: (key, opts) => guarded((a) => a.delete(key, opts)),
  };
}

/**
 * Factory — real (OS keychain) by default, falling back to the in-memory
 * fake automatically (with a console.warn) if the real backend isn't usable.
 * Non-macOS platforms skip straight to the fake since the real backend here
 * is Darwin-only.
 */
export function createSecretsAdapter(opts?: CreateSecretsAdapterOptions): SecretsAdapter {
  if (process.platform !== "darwin") {
    console.warn(
      "[secrets-adapter] no keychain backend for this platform " +
        `(${process.platform}) — using an in-memory store. Secrets will NOT persist across restarts.`,
    );
    return createInMemorySecretsAdapter();
  }
  return withInMemoryFallback(createKeychainSecretsAdapter(), opts?.onFallback);
}
