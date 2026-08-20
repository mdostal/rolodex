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
 * Scope: the Settings screen and its six sections (settings-account-screen
 * epic), plus the shared toast component and the loading/error-state fixes
 * built on top of it (ui-feedback-states epic) — the toast component
 * itself, the flows migrated onto it, the previously-silent failures now
 * surfaced through it, the detail/edit-form loading states, and the
 * not-found dead-code fix. Not a claim of exhaustive list/detail/form
 * coverage beyond what each epic actually touched.
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
 * its inline script — same technique as wizard.test.ts's loadWizard().
 *
 * `wrapFetch`, when given, wraps the real fetch *before* the page's own
 * boot-time render() call fires — the only way to affect its very first
 * requests, since page-script globals (render/renderList/showToast/...)
 * don't attach to `dom.window` the way DOM elements and event listeners
 * do (dom.window.eval() runs as indirect eval, whose top-level function
 * declarations don't become window properties the way a real <script> tag
 * would) — every test in this file drives the page through real DOM
 * events and real HTTP instead of calling page-script functions directly. */
async function loadApp(baseUrl: string, wrapFetch?: (real: typeof fetch) => typeof fetch): Promise<JSDOM> {
  const html = await (await fetch(baseUrl + "/")).text();
  const dom = new JSDOM(html, { url: baseUrl + "/", runScripts: "outside-only", pretendToBeVisual: true });
  const win = dom.window as unknown as { fetch: typeof fetch; location: Location; confirm: () => boolean };
  const passthroughFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" || input instanceof URL ? new URL(input, win.location.href).toString() : input;
    return fetch(url as string, init);
  }) as typeof fetch;
  win.fetch = wrapFetch ? wrapFetch(passthroughFetch) : passthroughFetch;
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
    // A predicate built on byId() (throws if the element doesn't exist yet)
    // must be able to fail transiently without aborting the poll early — on
    // a slower/more contended runner the gap between "the container renders"
    // and "the section's fetch fills it" is real, not just local-machine
    // noise (this exact race only surfaced on CI, never locally).
    try {
      if (fn()) return;
    } catch {
      // not ready yet — keep polling
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor timed out: ${label}`);
}

function byId(dom: JSDOM, id: string): HTMLElement {
  const el = dom.window.document.getElementById(id);
  if (!el) throw new Error(`no element with id="${id}"`);
  return el as HTMLElement;
}

async function createContact(baseUrl: string, name: string): Promise<{ id: string }> {
  const res = await fetch(baseUrl + "/api/contacts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return (await res.json()) as { id: string };
}

/** Temporarily makes every request whose URL contains `urlSubstring` reject
 * (or resolve after `delayMs`, if given) — used to exercise real failure
 * and loading-state paths without a fake/mocked server. Returns a restore()
 * that must be called to put the real fetch back. */
function interceptFetch(dom: JSDOM, urlSubstring: string, opts: { reject?: boolean; delayMs?: number } = {}): { restore: () => void } {
  const win = dom.window as unknown as { fetch: typeof fetch };
  const realFetch = win.fetch;
  win.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (!url.includes(urlSubstring)) return realFetch(input, init);
    if (opts.reject) return Promise.reject(new Error("simulated network failure"));
    if (opts.delayMs) return new Promise((resolve) => setTimeout(() => resolve(realFetch(input, init)), opts.delayMs));
    return realFetch(input, init);
  }) as typeof fetch;
  return { restore: () => { win.fetch = realFetch; } };
}

function toasts(dom: JSDOM): HTMLElement[] {
  return Array.from(dom.window.document.querySelectorAll("#toast-region .toast")) as HTMLElement[];
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

describe("Toast component", () => {
  it("error kind: role=alert, supports manual dismiss", async () => {
    const baseUrl = await start();
    const dom = await loadApp(baseUrl);
    await waitFor(() => !!dom.window.document.getElementById("sync-now"), "list rendered");

    // Sync now with no Google connected is a real, reliable error trigger —
    // see loadApp()'s docstring for why this file drives toasts through
    // real UI actions rather than calling showToast() directly.
    byId(dom, "sync-now").dispatchEvent(new dom.window.Event("click", { bubbles: true }));
    await waitFor(() => toasts(dom).length === 1, "error toast appears");
    const toast = toasts(dom)[0]!;
    expect(toast.getAttribute("role")).toBe("alert");
    expect(toast.className).toContain("error");

    toast.querySelector(".toast-close")!.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
    await waitFor(() => toasts(dom).length === 0, "manually dismissed");
  });

  it("success kind: role=status, and auto-dismisses on its own after a few seconds", async () => {
    const baseUrl = await start();
    const contact = await createContact(baseUrl, "Ada Lovelace");
    const dom = await loadApp(baseUrl);
    dom.window.location.hash = "#/contact/" + contact.id;
    await waitFor(() => !!dom.window.document.getElementById("verdict-picker"), "detail rendered");

    dom.window.document.querySelector('[data-value="strong"]')!.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
    await waitFor(() => toasts(dom).length === 1, "success toast appears");
    const toast = toasts(dom)[0]!;
    expect(toast.getAttribute("role")).toBe("status");
    expect(toast.className).toContain("success");
    expect(toast.querySelector(".toast-body")!.textContent).toBe("Saved.");

    // No manual dismiss this time — proves the ~4s auto-dismiss timer for
    // real, not just that a close button works.
    await waitFor(() => toasts(dom).length === 0, "auto-dismissed", 6000);
  });
});

describe("List view — toast-migrated flows", () => {
  it("Sync now failure (no Google connected) surfaces as an error toast and resets the button", async () => {
    const baseUrl = await start();
    const dom = await loadApp(baseUrl);
    await waitFor(() => !!dom.window.document.getElementById("sync-now"), "list rendered");

    byId(dom, "sync-now").dispatchEvent(new dom.window.Event("click", { bubbles: true }));
    await waitFor(() => toasts(dom).length === 1, "sync error toast appears");
    expect(toasts(dom)[0]!.getAttribute("role")).toBe("alert");
    expect(toasts(dom)[0]!.querySelector(".toast-body")!.textContent).toMatch(/Sync failed/);
    await waitFor(() => (byId(dom, "sync-now") as HTMLButtonElement).disabled === false, "button re-enabled");
    expect(byId(dom, "sync-now").textContent).toBe("Sync now");
  });

  it("a delete failure surfaces as an error toast, not a native alert()", async () => {
    const baseUrl = await start();
    const contact = await createContact(baseUrl, "Ada Lovelace");
    const dom = await loadApp(baseUrl);
    dom.window.location.hash = "#/contact/" + contact.id;
    await waitFor(() => dom.window.document.querySelector("h1")?.textContent === "Ada Lovelace", "detail rendered");

    // jsdom's window.alert is unimplemented (throws/warns by default) — if
    // the old alert() path were still reachable this test would fail loudly
    // rather than silently, which is exactly what we want to prove it isn't.
    let alertCalled = false;
    (dom.window as unknown as { alert: () => void; confirm: () => boolean }).alert = () => { alertCalled = true; };
    (dom.window as unknown as { confirm: () => boolean }).confirm = () => true;

    // Reject only the DELETE call specifically — a plain substring match on
    // the contact's URL would also catch the GET this page already made.
    const win = dom.window as unknown as { fetch: typeof fetch };
    const realFetch = win.fetch;
    win.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      if (url.includes("/api/contacts/" + contact.id) && init?.method === "DELETE") return Promise.reject(new Error("simulated delete failure"));
      return realFetch(input, init);
    }) as typeof fetch;

    byId(dom, "delete-top").dispatchEvent(new dom.window.Event("click", { bubbles: true }));
    await waitFor(() => toasts(dom).length === 1, "delete-failure toast appears");
    expect(toasts(dom)[0]!.getAttribute("role")).toBe("alert");
    expect(toasts(dom)[0]!.querySelector(".toast-body")!.textContent).toMatch(/Couldn't delete/);
    expect(alertCalled).toBe(false);
    win.fetch = realFetch;
  });

  it("the previously-silent needs-follow-up fetch failure now surfaces as an error toast", async () => {
    const baseUrl = await start();
    // Injected before boot (loadApp's wrapFetch), so the page's own very
    // first render()->renderList() call is what hits the failure — the
    // real first-load scenario this fix targets, not a synthetic re-render.
    const dom = await loadApp(baseUrl, (real) => ((input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      if (url.includes("needs-follow-up")) return Promise.reject(new Error("simulated network failure"));
      return real(input, init);
    }));

    await waitFor(() => toasts(dom).length === 1, "follow-up error toast appears");
    expect(toasts(dom)[0]!.querySelector(".toast-body")!.textContent).toMatch(/Couldn't load follow-up count/);
    // Degrades gracefully — the toggle keeps its unknown-count label rather
    // than crashing the rest of the list render.
    expect(byId(dom, "followup-toggle").textContent).toBe("Needs follow-up");
  });
});

describe("Contact detail/edit — loading state and not-found fix", () => {
  it("shows a real loading placeholder while the detail fetch is in flight, then the real content", async () => {
    const baseUrl = await start();
    const contact = await createContact(baseUrl, "Ada Lovelace");
    const dom = await loadApp(baseUrl);

    const { restore } = interceptFetch(dom, "/api/contacts/" + contact.id, { delayMs: 300 });
    dom.window.location.hash = "#/contact/" + contact.id;
    await waitFor(() => {
      const html = dom.window.document.getElementById("content")!.innerHTML;
      return html.includes("spinner") && html.includes("Loading");
    }, "loading placeholder shown");

    await waitFor(() => dom.window.document.querySelector("h1")?.textContent === "Ada Lovelace", "real content rendered", 6000);
    restore();
  });

  it("navigating to an unknown contact shows the not-found banner without auto-navigating away, and the back-link works", async () => {
    const baseUrl = await start();
    const dom = await loadApp(baseUrl);

    dom.window.location.hash = "#/contact/does-not-exist";
    await waitFor(
      () => dom.window.document.querySelector(".not-found-banner")?.textContent === "Contact not found — it may have been removed.",
      "not-found banner rendered",
    );
    // The old bug auto-navigated away before this could ever be observed —
    // asserting the hash is unchanged is the regression check.
    expect(dom.window.location.hash).toBe("#/contact/does-not-exist");

    byId(dom, "back-link").dispatchEvent(new dom.window.Event("click", { bubbles: true }));
    await waitFor(() => dom.window.document.querySelector("h1")?.textContent === "Contacts", "back to list");
  });

  it("the same not-found fix applies to the edit-form route", async () => {
    const baseUrl = await start();
    const dom = await loadApp(baseUrl);

    dom.window.location.hash = "#/contact/does-not-exist/edit";
    await waitFor(
      () => dom.window.document.querySelector(".not-found-banner")?.textContent === "Contact not found — it may have been removed.",
      "not-found banner rendered",
    );
    expect(dom.window.location.hash).toBe("#/contact/does-not-exist/edit");
  });
});
