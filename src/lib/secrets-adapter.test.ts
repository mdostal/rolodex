import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Partial-mocks node:fs/promises so ONE test below can force readFile() to
// reject (to prove get()'s try/finally still deletes the tempfile) without
// a real filesystem-permission trick (unreliable across OS/users, e.g. root
// bypasses permission bits entirely). Every other fs function keeps its
// real implementation via `importOriginal` — this only ever affects
// `readFile`, and only when a test explicitly configures a one-time
// rejection via `mockRejectedValueOnce`. vi.spyOn() can't be used here
// directly ("Module namespace is not configurable in ESM"), so this
// pre-wraps readFile in a vi.fn() at mock-setup time instead.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
import {
  classifyPortunusError,
  createInMemorySecretsAdapter,
  createPortunusSecretsAdapter,
  createSecretsAdapter,
  isPortunusAvailable,
  type PortunusRunner,
  type PortunusRunOptions,
} from "./secrets-adapter.js";
import { PROBE_STEP_TIMEOUT_MS } from "./secrets-check.js";

describe("in-memory SecretsAdapter", () => {
  it("round-trips a value through set() then get()", async () => {
    const adapter = createInMemorySecretsAdapter();
    await adapter.set("google-refresh-token", "hunter2");
    expect(await adapter.get("google-refresh-token")).toBe("hunter2");
  });

  it("delete() removes a previously set value", async () => {
    const adapter = createInMemorySecretsAdapter();
    await adapter.set("google-refresh-token", "hunter2");
    await adapter.delete("google-refresh-token");
    expect(await adapter.get("google-refresh-token")).toBeUndefined();
  });

  it("get() on a missing key returns undefined", async () => {
    const adapter = createInMemorySecretsAdapter();
    expect(await adapter.get("does-not-exist")).toBeUndefined();
  });

  it("delete() on a missing key is a no-op, not a throw", async () => {
    const adapter = createInMemorySecretsAdapter();
    await expect(adapter.delete("does-not-exist")).resolves.toBeUndefined();
  });

  it("keeps separate adapters isolated from each other", async () => {
    const a = createInMemorySecretsAdapter();
    const b = createInMemorySecretsAdapter();
    await a.set("key", "a-value");
    expect(await b.get("key")).toBeUndefined();
  });

  // Regression coverage for a real macOS keychain bug: `security`'s `-w`
  // output gets hex-encoded whenever the stored value contains a newline,
  // tab, or non-ASCII byte, with no marker distinguishing that from the
  // password legitimately looking like hex. The in-memory fake can't
  // reproduce that shell-level quirk, but it does guard the value shape the
  // real adapter's decoding logic (see parseSecurityPasswordLine() in
  // secrets-adapter.ts) must round-trip losslessly. See the
  // "keychain backend (live)" describe block below for a test against the
  // real `security` CLI covering the actual encoding bug.
  it("round-trips a value with an embedded newline", async () => {
    const adapter = createInMemorySecretsAdapter();
    const value = "-----BEGIN TOKEN-----\nline one\nline two\n-----END TOKEN-----";
    await adapter.set("multiline-secret", value);
    expect(await adapter.get("multiline-secret")).toBe(value);
  });

  it("round-trips a value with non-ASCII characters (emoji)", async () => {
    const adapter = createInMemorySecretsAdapter();
    const value = "café-token-🎉-日本語";
    await adapter.set("emoji-secret", value);
    expect(await adapter.get("emoji-secret")).toBe(value);
  });
});

// These exercise the real macOS Keychain via the `security` CLI directly
// (not the in-memory fake), because the bug this guards against is entirely
// in how `createKeychainSecretsAdapter()` decodes `security`'s output —
// specifically its hex-encoding of newline/tab/non-ASCII values, which the
// fake has no equivalent of. Skipped on non-macOS since the real backend is
// Darwin-only (see createSecretsAdapter()'s platform check).
//
// Uses a keychain item under a name unlikely to collide with anything real,
// and deletes it in `afterEach` — including on assertion failure — so a
// failed run doesn't leave junk in the developer's login keychain.
describe.skipIf(process.platform !== "darwin")("keychain backend (live)", () => {
  const KEY = "__secrets-adapter-test__";

  afterEach(async () => {
    const { createSecretsAdapter } = await import("./secrets-adapter.js");
    await createSecretsAdapter().delete(KEY);
  });

  it("round-trips a value with an embedded newline through the real keychain", async () => {
    const { createSecretsAdapter } = await import("./secrets-adapter.js");
    const adapter = createSecretsAdapter();
    const value = "line1\nline2";
    await adapter.set(KEY, value);
    expect(await adapter.get(KEY)).toBe(value);
  });

  it("round-trips a value with non-ASCII characters (emoji) through the real keychain", async () => {
    const { createSecretsAdapter } = await import("./secrets-adapter.js");
    const adapter = createSecretsAdapter();
    const value = "hello🎉world";
    await adapter.set(KEY, value);
    expect(await adapter.get(KEY)).toBe(value);
  });

  it("round-trips a plain value that happens to look like hex (regression for the ambiguous case)", async () => {
    const { createSecretsAdapter } = await import("./secrets-adapter.js");
    const adapter = createSecretsAdapter();
    const value = "deadbeef";
    await adapter.set(KEY, value);
    expect(await adapter.get(KEY)).toBe(value);
  });

  // Regression guard for CreateSecretsAdapterOptions gaining `backend`:
  // passing "keychain" explicitly must behave identically to the pre-story
  // default (omitting the option entirely, exercised by every test above).
  it("passing { backend: \"keychain\" } explicitly round-trips identically to the default", async () => {
    const { createSecretsAdapter } = await import("./secrets-adapter.js");
    const adapter = createSecretsAdapter({ backend: "keychain" });
    const value = "explicit-keychain-backend-value";
    await adapter.set(KEY, value);
    expect(await adapter.get(KEY)).toBe(value);
  });
});

// Covers createSecretsAdapter()'s `backend` dispatch and withInMemoryFallback's
// per-backend warning text (this story's requirement: the console.warn on
// fallback must name whichever real backend actually failed, "keychain" or
// "portunus", never a hardcoded "keychain"). Deterministic and safe on any
// platform/machine (including one with a real `portunus` CLI dogfooded and
// installed, or a real macOS keychain available): temporarily emptying
// PATH guarantees execFile can't find `security`/`portunus` on PATH, so
// both backends fail with a real, genuine ENOENT — without ever reaching a
// real keychain item or a real Portunus vault. Restores PATH (and PATH-
// dependent env only) in `finally` even on assertion failure.
describe("createSecretsAdapter() backend dispatch / fallback warning text", () => {
  async function withEmptyPath<T>(run: () => Promise<T>): Promise<T> {
    const originalPath = process.env.PATH;
    process.env.PATH = "";
    try {
      return await run();
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  }

  it.skipIf(process.platform !== "darwin")(
    "keychain: falls back to in-memory and warns naming \"keychain\", not \"portunus\", when the real backend is unreachable",
    async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await withEmptyPath(async () => {
          const adapter = createSecretsAdapter({ backend: "keychain" });
          const key = `__dispatch-test-keychain-${Date.now()}__`;
          await adapter.set(key, "value"); // must resolve (fallback), not throw
          expect(await adapter.get(key)).toBe("value"); // now served by the in-memory fallback
        });
        const warnedText = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
        expect(warnedText).toContain("real (keychain) backend failed");
        expect(warnedText.toLowerCase()).not.toContain("portunus");
      } finally {
        warnSpy.mockRestore();
      }
    },
  );

  it("portunus: dispatches to the Portunus backend, falls back to in-memory, and warns naming \"portunus\", not \"keychain\", when the real backend is unreachable — not platform-restricted", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let fallbackErr: unknown;
    try {
      await withEmptyPath(async () => {
        const adapter = createSecretsAdapter({
          backend: "portunus",
          onFallback: (err) => { fallbackErr = err; },
        });
        const key = `__dispatch-test-portunus-${Date.now()}__`;
        await adapter.set(key, "value"); // must resolve (fallback), not throw
        expect(await adapter.get(key)).toBe("value"); // now served by the in-memory fallback
      });
      const warnedText = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(warnedText).toContain("real (portunus) backend failed");
      expect(warnedText.toLowerCase()).not.toContain("keychain");
      // The classified cause embedded in the warning must come from
      // classifyPortunusError() — asserted by construction (not by
      // hardcoding its exact text, which depends on precisely how execFile
      // reports a missing "portunus" binary on this machine) by checking the
      // warning embeds classifyPortunusError()'s own output for the actual
      // captured cause, never classifyKeychainError()'s.
      expect(fallbackErr).toBeInstanceOf(Error);
      expect(warnedText).toContain(classifyPortunusError(fallbackErr));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("onFallback fires with the raw cause for the portunus dispatch path too (not only keychain), and it's genuinely Portunus-related", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let fallbackErr: unknown;
    try {
      await withEmptyPath(async () => {
        const adapter = createSecretsAdapter({
          backend: "portunus",
          onFallback: (err) => { fallbackErr = err; },
        });
        await adapter.set(`__dispatch-test-onfallback-${Date.now()}__`, "value");
      });
      expect(fallbackErr).toBeInstanceOf(Error);
      expect((fallbackErr as Error).message.toLowerCase()).toContain("portunus");
      expect(classifyPortunusError(fallbackErr).toLowerCase()).not.toContain("keychain");
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// Portunus backend: unlike the Keychain suite above (which either exercises
// the in-memory fake or the real `security` CLI directly), this exercises
// createPortunusSecretsAdapter() via a fake `run` (PortunusRunner)
// injection — no real portunus binary in the automated suite, per this
// story's verification plan. The REQUIRED EMPIRICAL CHECK acceptance
// criteria (retry-after-failed-state-enable safety, reg-rm-on-absent-name
// idempotency, dotted-key round trip, stderr-echo, --version hang/latency)
// were separately run against the real, installed `portunus 0.14.0` CLI —
// see this file's sibling docstring in secrets-adapter.ts and the PR
// description for the exact commands/output observed. What's covered here
// is the code's *logic* against those confirmed real behaviors, via fakes.
describe("Portunus SecretsAdapter", () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(cleanupPaths.splice(0).map((p) => fs.rm(p, { recursive: true, force: true })));
  });

  /** Builds a fake PortunusRunner from a handler, recording every call
   * (argv + opts) in order for assertions. */
  function fakeRun(
    handler: (args: string[], opts: PortunusRunOptions, callIndex: number) => Promise<{ stdout: string; stderr: string }>,
  ): { run: PortunusRunner; calls: Array<{ args: string[]; opts: PortunusRunOptions }> } {
    const calls: Array<{ args: string[]; opts: PortunusRunOptions }> = [];
    const run: PortunusRunner = async (args, opts) => {
      calls.push({ args, opts });
      return handler(args, opts, calls.length - 1);
    };
    return { run, calls };
  }

  /** Builds an error shaped like what Node's execFile/promisify throws on a
   * nonzero exit (`.cmd`/`.code`/`.stderr`/`.stdout`), so sanitizePortunusError()
   * has real argv/.cmd to strip. */
  function execFileError(o: { message: string; cmd?: string; stderr?: string; stdout?: string; code?: number | string }) {
    const err = new Error(o.message) as NodeJS.ErrnoException & { cmd?: string; stderr?: string; stdout?: string };
    err.cmd = o.cmd;
    err.stderr = o.stderr;
    err.stdout = o.stdout;
    err.code = o.code as string | undefined;
    return err;
  }

  it("set() then get() round-trips the exact value, and get() deletes the resolved tempfile afterward", async () => {
    const value = "s3cr3t-value-🔑\nwith-a-newline";
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "portunus-test-"));
    cleanupPaths.push(dir);
    const tmpFile = path.join(dir, "portunus-faketmp");

    const { run, calls } = fakeRun(async (args, opts) => {
      if (args[0] === "drop") {
        // Stands in for portunus persisting the stdin-piped value.
        await fs.writeFile(tmpFile, opts.input ?? "", { mode: 0o600 });
        return { stdout: "dropped ...\n", stderr: "" };
      }
      if (args[0] === "state") return { stdout: "rolodex.mykey: state=enabled\n", stderr: "" };
      if (args[0] === "resolve") return { stdout: `${tmpFile}\n`, stderr: "" };
      throw new Error(`unexpected call: ${args.join(" ")}`);
    });
    const adapter = createPortunusSecretsAdapter({ run });

    await adapter.set("mykey", value);
    const result = await adapter.get("mykey");

    expect(result).toBe(value);
    expect(calls.map((c) => c.args[0])).toEqual(["drop", "state", "resolve"]);
    expect(calls[0]?.args).toEqual(["drop", "rolodex.mykey", "rolodex.mykey", "--stdin"]);
    expect(calls[1]?.args).toEqual(["state", "rolodex.mykey", "enabled"]);
    expect(calls[2]?.args).toEqual(["resolve", "{{secret:rolodex.mykey}}"]);
    // The tempfile portunus "printed" a path to must be gone afterward.
    await expect(fs.stat(tmpFile)).rejects.toThrow();
  });

  it("deletes the tempfile even when the read itself throws (try/finally proof)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "portunus-test-"));
    cleanupPaths.push(dir);
    const tmpFile = path.join(dir, "portunus-faketmp");
    await fs.writeFile(tmpFile, "irrelevant-content", { mode: 0o600 });

    vi.mocked(fs.readFile).mockRejectedValueOnce(new Error("simulated read failure"));
    const { run } = fakeRun(async () => ({ stdout: `${tmpFile}\n`, stderr: "" }));
    const adapter = createPortunusSecretsAdapter({ run });

    await expect(adapter.get("mykey")).rejects.toThrow("simulated read failure");
    await expect(fs.stat(tmpFile)).rejects.toThrow();
  });

  it("get() rejects a printed path that is not absolute, and never touches any file", async () => {
    const { run } = fakeRun(async () => ({ stdout: "relative/path/to/secret\n", stderr: "" }));
    const adapter = createPortunusSecretsAdapter({ run });
    await expect(adapter.get("mykey")).rejects.toThrow(/non-absolute/i);
  });

  it("get() rejects a printed path that is absolute but NOT under the OS temp directory, and leaves the file untouched", async () => {
    const dir = await fs.mkdtemp(path.join(process.cwd(), "portunus-outside-tmp-test-"));
    cleanupPaths.push(dir);
    const outsideFile = path.join(dir, "not-a-portunus-tempfile");
    await fs.writeFile(outsideFile, "should-never-be-read", { mode: 0o600 });

    const { run } = fakeRun(async () => ({ stdout: `${outsideFile}\n`, stderr: "" }));
    const adapter = createPortunusSecretsAdapter({ run });

    await expect(adapter.get("mykey")).rejects.toThrow(/outside the OS temp directory/i);
    // Never opened/deleted — still there with its original content.
    expect(await fs.readFile(outsideFile, "utf8")).toBe("should-never-be-read");
  });

  it("get() rejects a printed path under the temp dir that is a symlink (not a regular file), and leaves it untouched", async () => {
    const outsideDir = await fs.mkdtemp(path.join(process.cwd(), "portunus-symlink-target-test-"));
    cleanupPaths.push(outsideDir);
    const targetFile = path.join(outsideDir, "real-target");
    await fs.writeFile(targetFile, "should-never-be-read-via-symlink", { mode: 0o600 });

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "portunus-test-"));
    cleanupPaths.push(tmpDir);
    const symlinkPath = path.join(tmpDir, "portunus-faketmp-symlink");
    await fs.symlink(targetFile, symlinkPath);

    const { run } = fakeRun(async () => ({ stdout: `${symlinkPath}\n`, stderr: "" }));
    const adapter = createPortunusSecretsAdapter({ run });

    await expect(adapter.get("mykey")).rejects.toThrow(/not a regular file/i);
    // lstat-checked, not stat-checked: the symlink itself (and its target)
    // must still exist afterward — never opened, never deleted.
    const stat = await fs.lstat(symlinkPath);
    expect(stat.isSymbolicLink()).toBe(true);
    expect(await fs.readFile(targetFile, "utf8")).toBe("should-never-be-read-via-symlink");
  });

  // Regression coverage for the specific "sibling directory" foolable-by-
  // string-prefix case assertPortunusTempFilePath()'s own docstring cites
  // as the reason it uses path.relative()/realpath comparison instead of a
  // naive string-prefix check: a real directory that lives right next to
  // the OS temp dir and merely starts with the same characters (e.g.
  // `/tmp-evil-sibling` vs `/tmp`) is NOT "under" the temp dir, and a naive
  // `p.startsWith(tmpDir)` check would be fooled into treating it as if it
  // were. This constructs that exact sibling directory for real and proves
  // get() still rejects a path inside it.
  it("get() rejects a printed path under a real sibling directory whose name merely starts with the temp dir's name, and leaves it untouched", async () => {
    const siblingDir = `${os.tmpdir()}-evil-sibling`;
    await fs.mkdir(siblingDir, { recursive: true });
    cleanupPaths.push(siblingDir);
    const siblingFile = path.join(siblingDir, "somefile");
    await fs.writeFile(siblingFile, "should-never-be-read-sibling-dir", { mode: 0o600 });

    const { run } = fakeRun(async () => ({ stdout: `${siblingFile}\n`, stderr: "" }));
    const adapter = createPortunusSecretsAdapter({ run });

    await expect(adapter.get("mykey")).rejects.toThrow(/outside the OS temp directory/i);
    expect(await fs.readFile(siblingFile, "utf8")).toBe("should-never-be-read-sibling-dir");
  });

  // Regression coverage (PoC) for the intermediate-symlinked-directory
  // provenance bypass: assertPortunusTempFilePath() used to `lstat` only
  // the TERMINAL path component, which correctly rejects a symlink at the
  // very end but does nothing about a symlink earlier in the path — an
  // intermediate directory symlink placed directly inside os.tmpdir() is
  // followed transparently during normal path traversal (lstat only
  // refuses to follow the FINAL symlink in a path), so the old
  // `path.relative(os.tmpdir(), p)` check saw a clean relative path with no
  // `..` and the old lstat-on-basename saw a plain regular file — both
  // checks passed even though the real, resolved location of the file is
  // OUTSIDE the temp dir entirely. This builds that exact real symlinked
  // directory (via fs.symlink, cross-platform on macOS/Linux) and proves
  // get() rejects the resulting "printed path" and never reads the
  // linked-to file's content.
  it("get() rejects a printed path that traverses an intermediate symlinked directory inside the OS temp dir pointing outside it (PoC for the intermediate-symlink provenance bypass), and never reads the linked-to file", async () => {
    const outsideDir = await fs.mkdtemp(path.join(process.cwd(), "portunus-evil-outside-test-"));
    cleanupPaths.push(outsideDir);
    const secretOutsideFile = path.join(outsideDir, "realfile");
    await fs.writeFile(secretOutsideFile, "SHOULD-NEVER-LEAK-VIA-INTERMEDIATE-SYMLINK", { mode: 0o600 });

    // evil-subdir lives DIRECTLY inside os.tmpdir() (not a subdirectory
    // several levels down), matching the exact PoC shape: a symlinked
    // directory placed right inside the temp dir, pointing at `outsideDir`
    // entirely outside it.
    const evilSubdir = path.join(os.tmpdir(), `portunus-evil-subdir-${process.pid}-${Date.now()}`);
    await fs.symlink(outsideDir, evilSubdir, "dir");
    cleanupPaths.push(evilSubdir);

    // The "printed path" portunus resolve returns: os.tmpdir()/evil-subdir/realfile.
    // Lexically this looks like a clean path under the temp dir with no
    // `..` segments, and lstat() on its final component ("realfile")
    // reports a plain regular file — exactly the two facts the old,
    // pre-fix checks relied on.
    const printedPath = path.join(evilSubdir, "realfile");

    const { run } = fakeRun(async () => ({ stdout: `${printedPath}\n`, stderr: "" }));
    const adapter = createPortunusSecretsAdapter({ run });

    await expect(adapter.get("mykey")).rejects.toThrow(/outside the OS temp directory/i);
    // Never read: the linked-to file's distinctive content must still be
    // exactly as written, and get() must not have returned it.
    expect(await fs.readFile(secretOutsideFile, "utf8")).toBe("SHOULD-NEVER-LEAK-VIA-INTERMEDIATE-SYMLINK");
  });

  it("get() returns undefined for a name with no matching registry entry ('unknown reference'), matching every other method's absence contract", async () => {
    const { run } = fakeRun(async () => {
      throw execFileError({
        message: "Command failed",
        stderr: "portunus: unknown reference {{secret:rolodex.mykey}}",
        code: 1,
      });
    });
    const adapter = createPortunusSecretsAdapter({ run });
    await expect(adapter.get("mykey")).resolves.toBeUndefined();
  });

  it("get() throws (does NOT return undefined) when the reference exists but is still state=dropped", async () => {
    const { run } = fakeRun(async () => {
      throw execFileError({
        message: "Command failed",
        stderr: "portunus: rolodex.mykey is dropped — not injectable (re-enable it)",
        code: 1,
      });
    });
    const adapter = createPortunusSecretsAdapter({ run });
    await expect(adapter.get("mykey")).rejects.toThrow();
  });

  it("set() throws when the state-enabled call fails, and does NOT attempt a rollback drop", async () => {
    const { run, calls } = fakeRun(async (args) => {
      if (args[0] === "drop") return { stdout: "dropped\n", stderr: "" };
      if (args[0] === "state") {
        throw execFileError({
          message: "Command failed: portunus state rolodex.mykey enabled",
          cmd: "portunus state rolodex.mykey enabled",
          stderr: "boom",
          code: 1,
        });
      }
      throw new Error(`unexpected call: ${args.join(" ")}`);
    });
    const adapter = createPortunusSecretsAdapter({ run });

    await expect(adapter.set("mykey", "value")).rejects.toThrow();
    // Exactly drop + the failed state call — no third (rollback) call.
    expect(calls.map((c) => c.args[0])).toEqual(["drop", "state"]);
  });

  it("handles a real dotted, multi-segment key shape identically to a simple key (name/sm_name construction)", async () => {
    const { run, calls } = fakeRun(async () => ({ stdout: "ok\n", stderr: "" }));
    const adapter = createPortunusSecretsAdapter({ run });
    await adapter.set("google.oauth.client", "cid-secret-value");
    expect(calls[0]?.args).toEqual(["drop", "rolodex.google.oauth.client", "rolodex.google.oauth.client", "--stdin"]);
    expect(calls[1]?.args).toEqual(["state", "rolodex.google.oauth.client", "enabled"]);
  });

  it("delete() runs `portunus reg rm <ref>`", async () => {
    const { run, calls } = fakeRun(async () => ({ stdout: "removed\n", stderr: "" }));
    const adapter = createPortunusSecretsAdapter({ run });
    await adapter.delete("mykey");
    expect(calls[0]?.args).toEqual(["reg", "rm", "rolodex.mykey"]);
  });

  it("delete() treats an absent-reference error as success (idempotent) — defensive normalization even though the real CLI already exits 0 for this case", async () => {
    const { run } = fakeRun(async () => {
      throw execFileError({
        message: "Command failed",
        cmd: "portunus reg rm rolodex.never-existed",
        stderr: "no such reference",
        code: 1,
      });
    });
    const adapter = createPortunusSecretsAdapter({ run });
    await expect(adapter.delete("never-existed")).resolves.toBeUndefined();
  });

  it("delete() still throws on a genuine, non-absence error", async () => {
    const { run } = fakeRun(async () => {
      throw execFileError({ message: "Command failed", cmd: "portunus reg rm rolodex.mykey", stderr: "vault is corrupted", code: 1 });
    });
    const adapter = createPortunusSecretsAdapter({ run });
    await expect(adapter.delete("mykey")).rejects.toThrow();
  });

  it("propagates opts.signal into every underlying call for get/set/delete", async () => {
    const controller = new AbortController();
    const seenSignals: Array<AbortSignal | undefined> = [];
    const { run } = fakeRun(async (args, opts) => {
      seenSignals.push(opts.signal);
      if (args[0] === "resolve") {
        // Absolute but outside tmpdir — deliberately fails provenance so
        // get() throws right after this call, which is fine: we only care
        // that the signal reached this call.
        return { stdout: "/definitely-not-a-real-tempfile-path\n", stderr: "" };
      }
      return { stdout: "ok\n", stderr: "" };
    });
    const adapter = createPortunusSecretsAdapter({ run });

    await adapter.set("mykey", "value", { signal: controller.signal });
    await adapter.get("mykey", { signal: controller.signal }).catch(() => {});
    await adapter.delete("mykey", { signal: controller.signal });

    expect(seenSignals).toHaveLength(4); // drop, state, resolve, reg rm
    expect(seenSignals.every((s) => s === controller.signal)).toBe(true);
  });

  it("sanitizePortunusError() strips execFile argv/.cmd before an error can reach a log — verified via classifyPortunusError() and the thrown error's own shape", async () => {
    const secretValue = "top-secret-marker-should-never-appear-anywhere";
    const { run } = fakeRun(async (args) => {
      if (args[0] === "drop") {
        throw execFileError({
          message: `Command failed: portunus drop rolodex.mykey rolodex.mykey --stdin`,
          cmd: `portunus drop rolodex.mykey rolodex.mykey --stdin`,
          stderr: "some real, secret-free stderr",
          code: 1,
        });
      }
      throw new Error(`unexpected call: ${args.join(" ")}`);
    });
    const adapter = createPortunusSecretsAdapter({ run });

    let caught: unknown;
    try {
      await adapter.set("mykey", secretValue);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    const err = caught as NodeJS.ErrnoException & { cmd?: string };
    expect(err.message).not.toContain(secretValue);
    expect(err.cmd).toBeUndefined(); // .cmd stripped entirely, not just the value redacted
    expect(classifyPortunusError(caught)).not.toContain(secretValue);
  });

  it("classifyPortunusError() recognizes the real CLI's confirmed failure-text shapes", () => {
    expect(classifyPortunusError(new Error("spawn portunus ENOENT"))).toMatch(/install|PATH/i);
    expect(classifyPortunusError(new Error("portunus: rolodex.mykey is dropped — not injectable (re-enable it)"))).toMatch(/enabled/i);
    expect(classifyPortunusError(new Error("portunus: unknown reference {{secret:rolodex.mykey}}"))).toMatch(/no matching/i);
  });

  it("isPortunusAvailable() returns true when `portunus --version` succeeds", async () => {
    const { run, calls } = fakeRun(async () => ({ stdout: "portunus 0.14.0\n", stderr: "" }));
    await expect(isPortunusAvailable({ run })).resolves.toBe(true);
    expect(calls[0]?.args).toEqual(["--version"]);
  });

  it("isPortunusAvailable() returns false, and never throws, when the binary is absent", async () => {
    const { run } = fakeRun(async () => {
      throw execFileError({ message: "spawn portunus ENOENT", code: "ENOENT" });
    });
    await expect(isPortunusAvailable({ run })).resolves.toBe(false);
  });

  it("isPortunusAvailable() returns false, and never throws, on a hang/timeout — reusing secrets-check.ts's withTimeout()/PROBE_STEP_TIMEOUT_MS", async () => {
    vi.useFakeTimers();
    try {
      const { run } = fakeRun(() => new Promise(() => {})); // never resolves — simulates a hang
      const resultPromise = isPortunusAvailable({ run });
      await vi.advanceTimersByTimeAsync(PROBE_STEP_TIMEOUT_MS);
      await expect(resultPromise).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("isPortunusAvailable() never throws even on a synchronous throw from the runner", async () => {
    const run: PortunusRunner = () => {
      throw new Error("synchronous boom");
    };
    await expect(isPortunusAvailable({ run })).resolves.toBe(false);
  });
});
