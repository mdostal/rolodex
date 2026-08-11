import { describe, expect, it, vi } from "vitest";
import { checkSecretsCapability, classifyKeychainError } from "./secrets-check.js";
import { createInMemorySecretsAdapter, type CreateSecretsAdapterOptions, type SecretsAdapter } from "./secrets-adapter.js";

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
