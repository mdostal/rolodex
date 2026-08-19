import { describe, expect, it, vi } from "vitest";
import { createAutostartController, createOpenBrowserHandler } from "./server-options.js";

describe("createAutostartController", () => {
  it("reports isSupported: true, unlike the default in RolodexServerOptions", () => {
    const app = {
      getLoginItemSettings: () => ({ openAtLogin: false }),
      setLoginItemSettings: vi.fn(),
    };
    expect(createAutostartController(app).isSupported).toBe(true);
  });

  it("getEnabled reads through to app.getLoginItemSettings().openAtLogin", () => {
    const app = {
      getLoginItemSettings: () => ({ openAtLogin: true }),
      setLoginItemSettings: vi.fn(),
    };
    expect(createAutostartController(app).getEnabled()).toBe(true);
  });

  it("setEnabled calls app.setLoginItemSettings with the given value", () => {
    const setLoginItemSettings = vi.fn();
    const app = { getLoginItemSettings: () => ({ openAtLogin: false }), setLoginItemSettings };
    createAutostartController(app).setEnabled(true);
    expect(setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true });
  });
});

describe("createOpenBrowserHandler", () => {
  it("calls the given openExternal with the url and discards its promise", () => {
    const openExternal = vi.fn().mockResolvedValue(undefined);
    const handler = createOpenBrowserHandler(openExternal);
    const result = handler("https://accounts.google.com/o/oauth2/auth");
    expect(result).toBeUndefined();
    expect(openExternal).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2/auth");
  });

  it("does not throw when openExternal's promise rejects", async () => {
    const openExternal = vi.fn().mockRejectedValue(new Error("no browser available"));
    const handler = createOpenBrowserHandler(openExternal);
    expect(() => handler("https://example.com")).not.toThrow();
    // Let the rejected promise settle so it doesn't surface as an unhandled
    // rejection in a later test.
    await openExternal.mock.results[0]!.value.catch(() => {});
  });
});
