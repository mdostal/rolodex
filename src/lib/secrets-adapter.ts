import { execFile } from "node:child_process";
import { promisify } from "node:util";

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
export interface SecretsAdapter {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
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
    async get(key) {
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
        const { stdout, stderr } = await execFileAsync("security", [
          "find-generic-password",
          "-a",
          key,
          "-s",
          SERVICE,
          "-g",
        ]);
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
    async set(key, value) {
      // -U: update the existing item in place instead of erroring if it's
      // already there, so set() is a plain upsert either way.
      await execFileAsync("security", [
        "add-generic-password",
        "-a",
        key,
        "-s",
        SERVICE,
        "-w",
        value,
        "-U",
      ]);
    },
    async delete(key) {
      try {
        await execFileAsync("security", ["delete-generic-password", "-a", key, "-s", SERVICE]);
      } catch (err) {
        // Already absent — delete() is idempotent, so this isn't an error.
        if (hasCode(err) && err.code === SEC_ITEM_NOT_FOUND) return;
        throw err;
      }
    },
  };
}

/** Fake backend: plain in-memory Map. For tests, and the safe-fallback target. */
export function createInMemorySecretsAdapter(): SecretsAdapter {
  const store = new Map<string, string>();
  return {
    async get(key) {
      return store.get(key);
    },
    async set(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

/**
 * Wraps a real adapter so that if its first call ever throws (no `security`
 * binary, not macOS, sandboxed with no keychain access, etc.), the whole
 * adapter permanently swaps over to an in-memory fake for the rest of the
 * process instead of crashing the app. Warns once, on the switch.
 */
function withInMemoryFallback(real: SecretsAdapter): SecretsAdapter {
  let active: SecretsAdapter = real;
  let fellBack = false;

  async function guarded<T>(run: (adapter: SecretsAdapter) => Promise<T>): Promise<T> {
    if (fellBack) return run(active);
    try {
      return await run(active);
    } catch (err) {
      console.warn(
        `[secrets-adapter] real (keychain) backend failed on first use — falling back to an ` +
          `in-memory store for this process. Secrets will NOT persist across restarts. Cause: ${
            err instanceof Error ? err.message : String(err)
          }`,
      );
      active = createInMemorySecretsAdapter();
      fellBack = true;
      return run(active);
    }
  }

  return {
    get: (key) => guarded((a) => a.get(key)),
    set: (key, value) => guarded((a) => a.set(key, value)),
    delete: (key) => guarded((a) => a.delete(key)),
  };
}

/**
 * Factory — real (OS keychain) by default, falling back to the in-memory
 * fake automatically (with a console.warn) if the real backend isn't usable.
 * Non-macOS platforms skip straight to the fake since the real backend here
 * is Darwin-only.
 */
export function createSecretsAdapter(): SecretsAdapter {
  if (process.platform !== "darwin") {
    console.warn(
      "[secrets-adapter] no keychain backend for this platform " +
        `(${process.platform}) — using an in-memory store. Secrets will NOT persist across restarts.`,
    );
    return createInMemorySecretsAdapter();
  }
  return withInMemoryFallback(createKeychainSecretsAdapter());
}
