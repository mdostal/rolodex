import { afterEach, describe, expect, it } from "vitest";
import { createInMemorySecretsAdapter } from "./secrets-adapter.js";

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
});
