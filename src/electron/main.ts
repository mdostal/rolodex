import { app, BrowserWindow, shell } from "electron";
import { createRolodexServer } from "../shell/server.js";
import { connectGoogleAccount as realConnectGoogleAccount } from "../lib/google-oauth-flow.js";

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

let mainWindow: BrowserWindow | null = null;

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
      realConnectGoogleAccount({ ...opts, openBrowser: (url) => void shell.openExternal(url) }),
  });
  await new Promise<void>((resolve) => server.listen(PORT, resolve));
  createWindow();
}

app.whenReady().then(() => {
  void boot();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
