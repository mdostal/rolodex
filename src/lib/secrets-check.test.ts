import { describe, expect, it, vi } from "vitest";
import { checkSecretsCapability, classifyKeychainError } from "./secrets-check.js";
import { classifyPortunusError, createInMemorySecretsAdapter, type CreateSecretsAdapterOptions, type SecretsAdapter } from "./secrets-adapter.js";

describe("checkSecretsCapability()", () => {
  it("reports ok:true against a working backend, using a throwaway key it cleans up after itself", async () => {
    const adapter = createInMemorySecretsAdapter();
    const setSpy = vi.spyOn(adapter, "set");
    const deleteSpy = vi.spyOn(adapter, "delete");
    const factory = () => adapter;

    // Force darwin so the platform short-circuit doesn't take over — the
    // capability probe itself is what's under test here, not process.platform.
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    try {
      const result = await checkSecretsCapability(factory);
      expect(result).toEqual({ ok: true, backend: "macOS Keychain" });
      expect(setSpy).toHaveBeenCalledTimes(1);
      expect(deleteSpy).toHaveBeenCalledTimes(1);
      const usedKey = setSpy.mock.calls[0]?.[0];
      expect(typeof usedKey).toBe("string");
      expect(usedKey?.startsWith("wizard.secrets-check.")).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("reports ok:false with a classified error when the backend throws", async () => {
    const failing: SecretsAdapter = {
      async get() { return undefined; },
      async set() { throw new Error("SecKeychainAddGenericPassword: Permission denied"); },
      async delete() {},
    };
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    try {
      const result = await checkSecretsCapability(() => failing);
      expect(result.ok).toBe(false);
      expect(result.backend).toBe("macOS Keychain");
      expect(result.error).toBe(
        "Rolodex doesn't have permission to access the keychain. Check your OS privacy/security settings.",
      );
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("reports ok:false when the adapter silently fell back to in-memory (masks the real failure otherwise)", async () => {
    const factory = (opts?: CreateSecretsAdapterOptions) => {
      // Simulate what createSecretsAdapter()'s withInMemoryFallback does: the
      // real backend fails once, onFallback fires, and the caller still gets
      // a perfectly working (in-memory) adapter back.
      opts?.onFallback?.(new Error("keychain is locked"));
      return createInMemorySecretsAdapter();
    };
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    try {
      const result = await checkSecretsCapability(factory);
      expect(result.ok).toBe(false);
      expect(result.backend).toBe("in-memory (fallback)");
      expect(result.error).toBe("Your keychain is locked — unlock it and retry.");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("reports ok:false with the 'no keychain' message on a non-darwin platform, without touching the factory", async () => {
    const factory = vi.fn();
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    try {
      const result = await checkSecretsCapability(factory as unknown as () => SecretsAdapter);
      expect(result).toEqual({ ok: false, backend: "none", error: "No secure keychain is available in this session." });
      expect(factory).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("on timeout, actually aborts the in-flight call's signal — not just abandoning the promise", async () => {
    // Regression test for withTimeout()'s interaction with a hung backend
    // call: a naive "race a timer against the promise" implementation would
    // let the timer settle checkSecretsCapability()'s returned Promise
    // without ever telling the still-running call to stop. This simulates a
    // hung `set()` (standing in for a real hung `security` child process/
    // auth-dialog wait) that only ever resolves in response to its signal's
    // "abort" event, then asserts both that the signal is actually flipped
    // to aborted AND that the hung call observably reacts to it — not
    // merely that the overall promise eventually rejects with the timeout
    // error (a separate, already-easy property to get right even without
    // wiring the signal through at all).
    vi.useFakeTimers();
    try {
      let capturedSignal: AbortSignal | undefined;
      let sawAbortEvent = false;
      const hungOnFirstCall: SecretsAdapter = {
        async get() {
          return undefined;
        },
        set(_key, _value, opts) {
          capturedSignal = opts?.signal;
          return new Promise<void>((_resolve, reject) => {
            opts?.signal?.addEventListener("abort", () => {
              sawAbortEvent = true;
              reject(new Error("aborted"));
            });
          });
        },
        async delete() {},
      };
      vi.spyOn(process, "platform", "get").mockReturnValue("darwin");

      const resultPromise = checkSecretsCapability(() => hungOnFirstCall);

      // Let the microtask queue drain so set() actually runs and captures
      // its signal before the timeout fires.
      await vi.advanceTimersByTimeAsync(0);
      expect(capturedSignal).toBeInstanceOf(AbortSignal);
      expect(capturedSignal?.aborted).toBe(false);
      expect(sawAbortEvent).toBe(false);

      // Advance past PROBE_STEP_TIMEOUT_MS (5000ms, not exported — this
      // deliberately clears it with margin rather than importing the
      // constant, so the test doesn't just echo the implementation).
      await vi.advanceTimersByTimeAsync(6000);

      expect(capturedSignal?.aborted).toBe(true);
      expect(sawAbortEvent).toBe(true);

      const result = await resultPromise;
      expect(result.ok).toBe(false);
      expect(result.backend).toBe("macOS Keychain");
      expect(result.error).toContain("unlock it and retry");
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });
});

// The `backend` parameter (default "keychain") added by this story. Every
// test above passes no second argument at all — that's the byte-identical
// regression check for the default path — these cover the new explicit
// "keychain" and "portunus" cases.
describe("checkSecretsCapability(factory, backend)", () => {
  it("passing backend explicitly as \"keychain\" behaves identically to omitting it", async () => {
    const adapter = createInMemorySecretsAdapter();
    const factory = () => adapter;
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    try {
      const result = await checkSecretsCapability(factory, "keychain");
      expect(result).toEqual({ ok: true, backend: "macOS Keychain" });
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("threads backend through to factory({ backend, onFallback })", async () => {
    let seenBackend: unknown;
    const factory = (opts?: CreateSecretsAdapterOptions) => {
      seenBackend = opts?.backend;
      return createInMemorySecretsAdapter();
    };
    const result = await checkSecretsCapability(factory, "portunus");
    expect(seenBackend).toBe("portunus");
    expect(result).toEqual({ ok: true, backend: "Portunus" });
  });

  it("does NOT apply the non-darwin 'no secure keychain' short-circuit when probing portunus", async () => {
    const adapter = createInMemorySecretsAdapter();
    const factory = vi.fn(() => adapter);
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    try {
      const result = await checkSecretsCapability(factory, "portunus");
      expect(factory).toHaveBeenCalled();
      expect(result).toEqual({ ok: true, backend: "Portunus" });
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("a probed Portunus failure reports the Portunus label and classifyPortunusError() text, never keychain vocabulary", async () => {
    const failing: SecretsAdapter = {
      async get() { return undefined; },
      async set() { throw new Error("portunus: unknown reference {{secret:wizard.secrets-check.x}}"); },
      async delete() {},
    };
    const result = await checkSecretsCapability(() => failing, "portunus");
    expect(result.ok).toBe(false);
    expect(result.backend).toBe("Portunus");
    expect(result.backend).not.toBe("macOS Keychain");
    expect(result.error).toBe(classifyPortunusError(new Error("portunus: unknown reference {{secret:wizard.secrets-check.x}}")));
    expect(result.error?.toLowerCase()).not.toContain("keychain");
  });

  it("a Portunus in-memory-fallback result uses classifyPortunusError(), not classifyKeychainError()", async () => {
    const cause = new Error("spawn portunus ENOENT");
    const factory = (opts?: CreateSecretsAdapterOptions) => {
      opts?.onFallback?.(cause);
      return createInMemorySecretsAdapter();
    };
    const result = await checkSecretsCapability(factory, "portunus");
    expect(result.ok).toBe(false);
    expect(result.backend).toBe("in-memory (fallback)");
    expect(result.error).toBe(classifyPortunusError(cause));
    expect(result.error).not.toBe(classifyKeychainError(cause));
    expect(result.error?.toLowerCase()).not.toContain("keychain");
  });

  it("a Portunus round-trip mismatch reports Portunus-specific text, not the keychain-worded message", async () => {
    const mismatched: SecretsAdapter = {
      async get() { return "a-completely-different-value"; },
      async set() {},
      async delete() {},
    };
    const result = await checkSecretsCapability(() => mismatched, "portunus");
    expect(result.ok).toBe(false);
    expect(result.backend).toBe("Portunus");
    expect(result.error).toContain("Portunus round-trip mismatch");
    expect(result.error).not.toContain("Keychain round-trip mismatch");
  });
});

describe("classifyKeychainError()", () => {
  it("maps a locked-keychain error", () => {
    expect(classifyKeychainError(new Error("SecKeychainItemCopyContent: Interaction is not allowed"))).toBe(
      "Your keychain is locked — unlock it and retry.",
    );
  });

  it("maps a permission-denied error", () => {
    expect(classifyKeychainError(new Error("EACCES: permission denied"))).toBe(
      "Rolodex doesn't have permission to access the keychain. Check your OS privacy/security settings.",
    );
  });

  it("maps a missing-binary error", () => {
    expect(classifyKeychainError(new Error("spawn security ENOENT"))).toBe(
      "No secure keychain is available in this session.",
    );
  });

  it("falls back to a generic-but-real message for an unrecognized error", () => {
    const msg = classifyKeychainError(new Error("something completely unexpected happened"));
    expect(msg).toContain("Couldn't write to your system keychain");
    expect(msg).toContain("something completely unexpected happened");
  });
});
