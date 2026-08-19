import type { RolodexServerOptions } from "../shell/server.js";

/**
 * The pieces of createRolodexServer()'s options that main.ts builds from
 * real Electron APIs — pulled out into pure functions so they're testable
 * without a real BrowserWindow/app event loop. main.ts's own top-level code
 * (the single-instance lock, window creation, app lifecycle events) stays
 * untested boilerplate, same as server.ts's own isMainModule bootstrap
 * block; the actual logic lives here instead.
 */

/** Minimal surface this module needs from Electron's `app` — narrowed so
 * tests can pass a plain fake object instead of importing real `electron`. */
export interface LoginItemController {
  getLoginItemSettings(): { openAtLogin: boolean };
  setLoginItemSettings(settings: { openAtLogin: boolean }): void;
}

export function createAutostartController(app: LoginItemController): NonNullable<RolodexServerOptions["autostart"]> {
  return {
    isSupported: true,
    getEnabled: () => app.getLoginItemSettings().openAtLogin,
    setEnabled: (enabled) => app.setLoginItemSettings({ openAtLogin: enabled }),
  };
}

/** Wraps Electron's shell.openExternal into the plain `(url) => void` shape
 * connectGoogleAccount's `openBrowser` option expects. */
export function createOpenBrowserHandler(openExternal: (url: string) => Promise<void>): (url: string) => void {
  return (url) => void openExternal(url);
}
