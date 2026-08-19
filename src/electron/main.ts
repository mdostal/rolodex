import { app, BrowserWindow, dialog, shell } from "electron";
import { createRolodexServer } from "../shell/server.js";
import { connectGoogleAccount as realConnectGoogleAccount } from "../lib/google-oauth-flow.js";
import { createAutostartController, createOpenBrowserHandler } from "./server-options.js";

/**
 * Electron main process — a thin host around the existing standalone-app
 * server (src/shell/server.ts), not a rewrite of it. Store, the wizard, the
 * HTTP API, and index.html/wizard.html are all untouched; this file's only
 * job is booting that same server in-process (Electron's main process IS
 * Node, so createRolodexServer() is called directly, no IPC/sidecar) and
 * pointing a native BrowserWindow at its loopback URL instead of a browser
 * tab.
 *
 * Two behaviors from the dev-server phase need to be suppressed or
 * redirected here, not changed at their source:
 * - server.ts's own "open the OS default browser" step (gated on
 *   ROLODEX_NO_OPEN) would otherwise ALSO pop a real browser tab alongside
 *   this window — suppressed below, since Electron's window replaces it.
 * - The real Google OAuth consent screen still needs a REAL external
 *   browser (Google disallows embedded-webview sign-in) — connectGoogleAccount's
 *   already-injectable `openBrowser` option is wired to Electron's own
 *   shell.openExternal here, which is also what makes this work on Windows/
 *   Linux for free: the default opener (google-oauth-flow.ts's
 *   defaultOpenBrowser) is Darwin-`open`-only and silently no-ops elsewhere.
 */

process.env.ROLODEX_NO_OPEN = "1";

const PORT = Number(process.env.ROLODEX_SHELL_PORT ?? 4173);

// Electron's own single-instance lock, not the dev server's "de facto lock
// via a fixed port" trick (server.ts:840-851's EADDRINUSE handler) — a
// second launch loses the lock immediately and quits before ever trying to
// listen, so it can't race the first instance for the port at all. The
// EADDRINUSE handler below stays anyway as defense-in-depth (e.g. `npm run
// shell` happens to already be running on the same port).
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

let mainWindow: BrowserWindow | null = null;
// Guards against app.on("activate") firing (macOS: clicking the dock icon)
// while boot() is still awaiting server.listen() — without this a second
// createWindow() could run before the server is even up, pointing a window
// at a URL that isn't serving yet.
let bootComplete = false;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: "rolodex",
  });
  mainWindow.loadURL(`http://localhost:${PORT}/`);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

async function boot(): Promise<void> {
  const server = createRolodexServer({
    connectGoogleAccount: (opts) =>
      realConnectGoogleAccount({ ...opts, openBrowser: createOpenBrowserHandler(shell.openExternal) }),
    autostart: createAutostartController(app),
  });

  await new Promise<void>((resolve, reject) => {
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(new Error(`rolodex is already running at http://localhost:${PORT} (port in use)`));
        return;
      }
      reject(err);
    });
    // The host argument is not optional in practice: server.listen(port, cb)
    // with no host binds ALL interfaces (0.0.0.0), not loopback — silently
    // contradicting the 127.0.0.1-only invariant server.ts and
    // google-oauth-flow.ts's own .listen() calls both already get right.
    // Caught by a real security review before this shipped.
    server.listen(PORT, "127.0.0.1", resolve);
  });

  bootComplete = true;
  createWindow();
}

if (gotLock) {
  app.whenReady().then(async () => {
    try {
      await boot();
    } catch (err) {
      dialog.showErrorBox("rolodex failed to start", err instanceof Error ? err.message : String(err));
      app.quit();
      return;
    }

    app.on("activate", () => {
      if (bootComplete && BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
