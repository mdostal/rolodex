/**
 * Live-DOM coverage for the main app shell's #/settings screen
 * (settings-account-screen epic). Loads the *real* index.html served by a
 * *real* running createRolodexServer() instance into jsdom, same pattern as
 * wizard.test.ts: window.fetch wired to Node's real fetch so the page's own
 * api() calls hit the real /api/* routes (in-memory secrets adapter, a
 * temp-dir database — no mocked responses), and driven exactly the way a
 * user would: click buttons, fill inputs, edit location.hash directly to
 * simulate navigation.
 *
 * Scope: the Settings screen and its six sections — the new client-side
 * surface this epic added. The pre-existing list/detail/form views have no
 * jsdom coverage of their own yet (this file doesn't change that); Settings
 * gets it here because this epic is what built it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { createRolodexServer } from "./server.js";
import { createInMemorySecretsAdapter } from "../lib/secrets-adapter.js";

// Same rationale as wizard.test.ts: a per-test total budget, not a
// per-waitFor() one — several tests below drive multiple sequential real
// HTTP round trips through jsdom.
vi.setConfig({ testTimeout: 30000 });

let dir: string;
let server: Server | undefined;
const originalRolodexDb = process.env.ROLODEX_DB;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "rolodex-index-test-"));
  delete process.env.ROLODEX_DB;
});

afterEach(async () => {
  if (server) {
    await new Promise((resolve) => server!.close(resolve));
    server = undefined;
  }
  rmSync(dir, { recursive: true, force: true });
  if (originalRolodexDb === undefined) delete process.env.ROLODEX_DB;
  else process.env.ROLODEX_DB = originalRolodexDb;
});

async function start(opts: { isPortunusAvailable?: () => Promise<boolean> } = {}): Promise<string> {
  server = createRolodexServer({
    homeDir: dir,
    secretsCapabilityFactory: () => createInMemorySecretsAdapter(),
    secrets: createInMemorySecretsAdapter(),
    // Deterministic regardless of what's actually installed on the machine
    // running the suite — same rationale as wizard.test.ts's own default.
    isPortunusAvailable: opts.isPortunusAvailable ?? (async () => false),
  });
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  const address = server!.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;
  // The real app (index.html) is only served once the wizard is complete —
  // before that, GET / serves wizard.html instead. Every test in this file
  // wants the real app.
  await fetch(baseUrl + "/api/wizard/complete", { method: "POST" });
  return baseUrl;
}

/** Loads the real index.html from a real running server into jsdom and runs
 * its inline script — same technique as wizard.test.ts's loadWizard(). */
async function loadApp(baseUrl: string): Promise<JSDOM> {
  const html = await (await fetch(baseUrl + "/")).text();
  const dom = new JSDOM(html, { url: baseUrl + "/", runScripts: "outside-only", pretendToBeVisual: true });
  const win = dom.window as unknown as { fetch: typeof fetch; location: Location; confirm: () => boolean };
  win.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" || input instanceof URL ? new URL(input, win.location.href).toString() : input;
    return fetch(url as string, init);
  }) as typeof fetch;
  // jsdom's window.confirm has no real implementation (returns false and
  // warns) — tests that need a specific answer override this directly.
  win.confirm = () => true;
  const script = dom.window.document.querySelector("script")!.textContent!;
  dom.window.eval(script);
  return dom;
}

async function waitFor(fn: () => boolean, label: string, timeoutMs = 10000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor timed out: ${label}`);
}

function byId(dom: JSDOM, id: string): HTMLElement {
  const el = dom.window.document.getElementById(id);
  if (!el) throw new Error(`no element with id="${id}"`);
  return el as HTMLElement;
}

/** Navigates via a real hashchange (not a direct render() call) — jsdom
 * fires hashchange asynchronously on a later task, same subtlety
 * wizard.test.ts documents, so callers must waitFor() a rendered marker
 * afterward rather than assuming the DOM already reflects the new route. */
function goToSettings(dom: JSDOM): void {
  dom.window.location.hash = "#/settings";
}

async function waitForSettingsScreen(dom: JSDOM): Promise<void> {
  await waitFor(
    () => dom.window.document.querySelector("h1")?.textContent === "Settings",
    "settings screen rendered",
  );
  // renderSettings() awaits its sections' fetches sequentially (Follow-up,
  // Appearance, Autostart, Google, then Secrets-backends) — waiting only on
  // the first (Follow-up) leaves later sections still showing their
  // "Loading…" placeholder. Google's real status text is the last section
  // with content every start() config produces (Secrets-backends renders
  // nothing at all unless Portunus is available), so waiting for it proves
  // the whole sequential chain has actually settled.
  await waitFor(() => byId(dom, "settings-window").getAttribute("value") !== null, "follow-up section populated");
  await waitFor(() => byId(dom, "google-section-body").textContent !== "Loading…", "google section populated");
}

describe("Settings screen — navigation", () => {
  it("clicking the gear button navigates to #/settings and renders it; the back link returns to the list", async () => {
    const baseUrl = await start();
    const dom = await loadApp(baseUrl);
    await waitFor(() => !!dom.window.document.getElementById("settings-toggle"), "list view rendered");

    byId(dom, "settings-toggle").dispatchEvent(new dom.window.Event("click", { bubbles: true }));
    await waitForSettingsScreen(dom);
    expect(dom.window.location.hash).toBe("#/settings");

    byId(dom, "back-link").dispatchEvent(new dom.window.Event("click", { bubbles: true }));
    await waitFor(() => dom.window.document.querySelector("h1")?.textContent === "Contacts", "back to list");
    expect(dom.window.location.hash).toBe("#/");
  });

  it("renders every migrated/new section: Follow-up, Appearance, Google account, Database location (Secrets backend omitted — Portunus unavailable)", async () => {
    const baseUrl = await start();
    const dom = await loadApp(baseUrl);
    goToSettings(dom);
    await waitForSettingsScreen(dom);

    expect(byId(dom, "follow-up-section-body").textContent).toContain("Follow-up window (days)");
    expect(byId(dom, "appearance-section-body").textContent).toContain("Appearance");
    expect(byId(dom, "google-section-body").textContent).toContain("Not configured");
    expect(byId(dom, "database-section").textContent).toContain("Database location");
    // No injected Portunus availability in this describe block's start() ->
    // the section body stays empty, not a disabled placeholder.
    expect(byId(dom, "secrets-backend-section-body").innerHTML).toBe("");
  });
});

describe("Settings screen — Follow-up window", () => {
  it("Save persists real values via PUT, and a GET reflects them", async () => {
    const baseUrl = await start();
    const dom = await loadApp(baseUrl);
    goToSettings(dom);
    await waitForSettingsScreen(dom);

    const windowInput = byId(dom, "settings-window") as unknown as HTMLInputElement;
    const graceInput = byId(dom, "settings-grace") as unknown as HTMLInputElement;
    windowInput.value = "45";
    graceInput.value = "10";
    byId(dom, "settings-form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));

    await waitFor(() => byId(dom, "follow-up-save-status").textContent === "Saved.", "save confirmation shown");

    const result = await (await fetch(baseUrl + "/api/settings/follow-up")).json();
    expect(result).toEqual({ windowDays: 45, graceDays: 10 });
  });

  it("Cancel reverts unsaved edits to the last-saved values without persisting them", async () => {
    const baseUrl = await start();
    const dom = await loadApp(baseUrl);
    goToSettings(dom);
    await waitForSettingsScreen(dom);

    const windowInput = byId(dom, "settings-window") as unknown as HTMLInputElement;
    expect(windowInput.value).toBe("30");
    windowInput.value = "999";
    byId(dom, "settings-cancel").dispatchEvent(new dom.window.Event("click", { bubbles: true }));

    await waitFor(() => windowInput.value === "30", "reverted to last-saved value");
    const result = await (await fetch(baseUrl + "/api/settings/follow-up")).json();
    expect(result).toEqual({ windowDays: 30, graceDays: 14 });
  });
});

describe("Settings screen — Database location", () => {
  it("Change... + Check this location persists a writable override and shows the restart-to-apply note", async () => {
    const baseUrl = await start();
    const dom = await loadApp(baseUrl);
    goToSettings(dom);
    await waitForSettingsScreen(dom);
    await waitFor(() => byId(dom, "db-status").textContent === "✓ This location is writable.", "initial db status loaded");

    byId(dom, "db-change-toggle").dispatchEvent(new dom.window.Event("click", { bubbles: true }));
    const candidate = path.join(dir, "custom-location", "rolodex.db");
    (byId(dom, "db-path-input") as unknown as HTMLInputElement).value = candidate;
    byId(dom, "db-path-apply").dispatchEvent(new dom.window.Event("click", { bubbles: true }));

    await waitFor(() => !byId(dom, "db-apply-note").hasAttribute("hidden"), "apply note shown");
    expect(byId(dom, "db-path-display").textContent).toBe(candidate);

    const result = await (await fetch(baseUrl + "/api/wizard/database")).json();
    expect(result).toMatchObject({ path: candidate, isDefault: false, writable: true });
  });

  it("Reset to default is gated behind confirm() — declining it leaves the override untouched", async () => {
    const baseUrl = await start();
    const dom = await loadApp(baseUrl);
    const candidate = path.join(dir, "custom-location", "rolodex.db");
    await fetch(baseUrl + "/api/wizard/database", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: candidate }),
    });

    goToSettings(dom);
    await waitForSettingsScreen(dom);
    await waitFor(() => byId(dom, "db-path-display").textContent === candidate, "custom path loaded");

    let confirmCalled = false;
    (dom.window as unknown as { confirm: () => boolean }).confirm = () => {
      confirmCalled = true;
      return false;
    };
    byId(dom, "db-reset").dispatchEvent(new dom.window.Event("click", { bubbles: true }));
    await waitFor(() => confirmCalled, "confirm() was invoked");

    // Declining must not have fired the reset request — give any accidental
    // async call a moment to land, then assert the override is unchanged.
    await new Promise((r) => setTimeout(r, 50));
    const result = await (await fetch(baseUrl + "/api/wizard/database")).json();
    expect(result).toMatchObject({ path: candidate, isDefault: false });
  });

  it("Reset to default, once confirmed, really clears the override", async () => {
    const baseUrl = await start();
    const dom = await loadApp(baseUrl);
    const candidate = path.join(dir, "custom-location", "rolodex.db");
    await fetch(baseUrl + "/api/wizard/database", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: candidate }),
    });

    goToSettings(dom);
    await waitForSettingsScreen(dom);
    await waitFor(() => byId(dom, "db-path-display").textContent === candidate, "custom path loaded");

    byId(dom, "db-reset").dispatchEvent(new dom.window.Event("click", { bubbles: true })); // win.confirm defaults to true (loadApp)
    await waitFor(() => byId(dom, "db-path-display").textContent !== candidate, "path reset");

    const result = await (await fetch(baseUrl + "/api/wizard/database")).json();
    expect(result).toMatchObject({ isDefault: true });
  });
});

describe("Settings screen — Secrets backend", () => {
  it("is omitted entirely when Portunus isn't available", async () => {
    const baseUrl = await start({ isPortunusAvailable: async () => false });
    const dom = await loadApp(baseUrl);
    goToSettings(dom);
    await waitForSettingsScreen(dom);
    await new Promise((r) => setTimeout(r, 50)); // let the async fetch settle either way
    expect(byId(dom, "secrets-backend-section-body").innerHTML).toBe("");
  });

  it("shows macOS Keychain pressed by default, and clicking Portunus persists the real choice", async () => {
    const baseUrl = await start({ isPortunusAvailable: async () => true });
    const dom = await loadApp(baseUrl);
    goToSettings(dom);
    await waitForSettingsScreen(dom);
    await waitFor(() => !!dom.window.document.querySelector('[data-backend-option="portunus"]'), "backend section rendered");

    const keychainBtn = dom.window.document.querySelector('[data-backend-option="keychain"]')!;
    const portunusBtn = dom.window.document.querySelector('[data-backend-option="portunus"]')!;
    expect(keychainBtn.getAttribute("aria-pressed")).toBe("true");

    portunusBtn.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
    await waitFor(() => portunusBtn.getAttribute("aria-pressed") === "true", "portunus becomes pressed");
    expect(keychainBtn.getAttribute("aria-pressed")).toBe("false");
    await waitFor(() => !byId(dom, "secrets-backend-apply-note").hasAttribute("hidden"), "apply note shown");

    const result = await (await fetch(baseUrl + "/api/wizard/secrets-backends")).json();
    expect(result).toMatchObject({ currentBackend: "portunus" });
  });
});
