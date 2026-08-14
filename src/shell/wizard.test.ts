/**
 * Live-DOM coverage for the setup wizard's navigation state machine
 * (STEPS, reachedIndex, and every navigate() call site) after the
 * welcome -> database -> secrets -> google -> finish reorder (pfb-03).
 *
 * This loads the *real* wizard.html served by a *real* running
 * createRolodexServer() instance into jsdom, wires jsdom's window.fetch to
 * Node's real fetch so the wizard's own api() calls hit the real
 * /api/wizard/* routes (in-memory secrets adapter, a temp-dir database —
 * no mocked responses), and drives it exactly the way a user would: click
 * the primary/back buttons, edit location.hash directly to simulate a
 * hash-jump. jsdom fires real `hashchange` events on both direct
 * `location.hash =` assignment and `location.replace()`, so the wizard's
 * own hashchange listener re-runs render() exactly as it would in a real
 * browser — nothing about the state machine itself is stubbed.
 *
 * One jsdom subtlety this file works around: `location.hash = "#/x"`
 * updates the `location.hash` property synchronously, but the resulting
 * `hashchange` event (and therefore the wizard's own render()) fires
 * asynchronously, on a later task. Polling only on `location.hash` would
 * race ahead of the actual re-render and observe the *previous* screen's
 * still-live footer button. Every wait below therefore also waits for a
 * screen-specific rendered marker (its <h1> text), not the hash alone.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { createRolodexServer } from "./server.js";
import { createInMemorySecretsAdapter } from "../lib/secrets-adapter.js";

let dir: string;
let server: Server | undefined;
const originalRolodexDb = process.env.ROLODEX_DB;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "rolodex-wizard-test-"));
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

async function start(): Promise<string> {
  server = createRolodexServer({
    homeDir: dir,
    secretsCapabilityFactory: () => createInMemorySecretsAdapter(),
    secrets: createInMemorySecretsAdapter(),
  });
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  const address = server!.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return `http://127.0.0.1:${port}`;
}

/** Loads the real wizard.html from a real running server into jsdom and
 * runs its inline script, with window.fetch wired to Node's real fetch
 * (resolved against the page's own URL, since Node's fetch — unlike a
 * browser's — doesn't resolve relative URLs on its own). Uses
 * runScripts: "outside-only" so the inline <script> does NOT auto-execute
 * during parsing — that would run before window.fetch exists — and is
 * instead run explicitly via dom.window.eval() once fetch is wired,
 * exactly reproducing what a browser does when it reaches the <script>
 * tag with fetch already a global.
 */
async function loadWizard(baseUrl: string): Promise<JSDOM> {
  const html = await (await fetch(baseUrl + "/")).text();
  const dom = new JSDOM(html, { url: baseUrl + "/", runScripts: "outside-only", pretendToBeVisual: true });
  const win = dom.window as unknown as { fetch: typeof fetch; location: Location };
  win.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" || input instanceof URL ? new URL(input, win.location.href).toString() : input;
    return fetch(url as string, init);
  }) as typeof fetch;
  const script = dom.window.document.querySelector("script")!.textContent!;
  dom.window.eval(script);
  return dom;
}

function primaryBtn(dom: JSDOM): HTMLButtonElement {
  return dom.window.document.getElementById("wizard-primary") as HTMLButtonElement;
}
function backBtn(dom: JSDOM): HTMLButtonElement {
  return dom.window.document.getElementById("wizard-back") as HTMLButtonElement;
}
function hashKey(dom: JSDOM): string {
  return dom.window.location.hash.replace(/^#\/?/, "") || "welcome";
}
function h1Text(dom: JSDOM): string {
  return dom.window.document.querySelector("h1")?.textContent ?? "";
}

/** The one bit of real screen content each screen's render function sets
 * synchronously as its very first DOM write — used as proof that the
 * *actual* re-render for a given target happened, not just that
 * location.hash changed (see the file-level comment on the jsdom race). */
const SCREEN_H1: Record<string, string> = {
  welcome: "Welcome to your rolodex.",
  database: "Where should your contacts live?",
  secrets: "Checking secure storage",
  google: "Connect Google Contacts",
  finish: "You're all set.",
};

async function waitFor(fn: () => boolean, label: string, timeoutMs = 4000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor timed out: ${label}`);
}

/** Waits until the wizard has genuinely landed on and rendered `key` —
 * both the hash and that screen's own <h1> marker — regardless of what
 * triggered the transition. */
async function waitForScreen(dom: JSDOM, key: string): Promise<void> {
  await waitFor(
    () => hashKey(dom) === key && h1Text(dom).includes(SCREEN_H1[key]!),
    `screen to become #${key} (hash + rendered <h1>)`,
  );
}

async function goForward(dom: JSDOM, expectKey: string): Promise<void> {
  primaryBtn(dom).click();
  await waitForScreen(dom, expectKey);
}

async function goBack(dom: JSDOM, expectKey: string): Promise<void> {
  backBtn(dom).click();
  await waitForScreen(dom, expectKey);
}

function findButtonByLabel(dom: JSDOM, label: string): HTMLButtonElement {
  const btn = Array.from(dom.window.document.querySelectorAll("#wizard-footer-right button")).find(
    (b: Element) => b.textContent === label,
  ) as HTMLButtonElement | undefined;
  if (!btn) throw new Error(`no footer button labeled "${label}"`);
  return btn;
}

/** Drives the wizard from "welcome" through "secrets" (the new order's
 * database -> secrets leg), leaving it on the secrets screen with its
 * check having resolved and the primary button enabled. reachedIndex is
 * 2 at this point (secrets is index 2 in the new STEPS order), matching
 * this story's acceptance criterion. */
async function advanceToSecrets(dom: JSDOM): Promise<void> {
  expect(hashKey(dom)).toBe("welcome");
  await goForward(dom, "database"); // welcome -> database, reachedIndex -> 1
  await waitFor(() => !primaryBtn(dom).disabled, "database screen's write-access check to resolve");

  await goForward(dom, "secrets"); // database -> secrets, reachedIndex -> 2 (unchanged per table)
  await waitFor(() => !primaryBtn(dom).disabled, "secrets screen's keychain check to resolve");
}

describe("wizard navigation order after the pfb-03 reorder", () => {
  it("STEPS is exactly [welcome, database, secrets, google, finish], reflected in the rendered stepper", async () => {
    const baseUrl = await start();
    const dom = await loadWizard(baseUrl);
    const labels = Array.from(dom.window.document.querySelectorAll("#stepper-list .step-label")).map(
      (el: Element) => el.textContent,
    );
    expect(labels).toEqual(["Welcome", "Database", "Secrets", "Google", "Finish"]);
  });

  it("walks welcome -> database -> secrets -> google -> finish in that order, bumping reachedIndex to each new screen's new index", async () => {
    const baseUrl = await start();
    const dom = await loadWizard(baseUrl);

    await advanceToSecrets(dom);
    expect(hashKey(dom)).toBe("secrets");

    // secrets -> google (reachedIndex -> 3, the CHANGED bump from the table)
    await goForward(dom, "google");

    // google -> finish via Skip (reachedIndex -> 4, the CHANGED bump from the table)
    findButtonByLabel(dom, "Skip for now").click();
    await waitForScreen(dom, "finish");
    await waitFor(() => !!dom.window.document.getElementById("summary-list")?.children.length, "finish summary to render");
  });

  it("blocks a hash-jump straight to #finish when the user has only reached 'secrets' (reachedIndex=2) — the regression this reorder must not introduce", async () => {
    const baseUrl = await start();
    const dom = await loadWizard(baseUrl);

    await advanceToSecrets(dom);
    expect(hashKey(dom)).toBe("secrets");

    // Simulate a user editing the address bar directly to jump past both
    // "google" (not yet visited) straight to "finish".
    dom.window.location.hash = "#/finish";

    // It must NOT be let through: render()'s reachedIndex guard should
    // snap it back to the furthest screen actually reached so far, which
    // at this point is "secrets" (index 2) — not "finish" and not
    // "google" either (that would silently let the user skip a screen).
    await waitForScreen(dom, "secrets");
  });

  it("blocks a hash-jump straight to #finish right after arriving at 'google' via forward, before completing/skipping it (reachedIndex=3) — the specific gap a mutation test found missing from this file", async () => {
    const baseUrl = await start();
    const dom = await loadWizard(baseUrl);

    await advanceToSecrets(dom);
    await goForward(dom, "google"); // reachedIndex -> 3; google not yet completed/skipped

    // If secrets' forward-bump literal ever regresses back to 4 (the old,
    // pre-reorder value), this is exactly the case that would silently let
    // it through — reachedIndex would already sit at "finish"'s index
    // before the user has done anything on the google screen. Verified
    // during review that reverting that single literal makes this test
    // fail while every other test in this file still passes.
    dom.window.location.hash = "#/finish";
    await waitForScreen(dom, "google");
  });

  it("also blocks a hash-jump to #google before secrets has been reached", async () => {
    const baseUrl = await start();
    const dom = await loadWizard(baseUrl);

    expect(hashKey(dom)).toBe("welcome");
    await goForward(dom, "database"); // reachedIndex -> 1 only

    dom.window.location.hash = "#/google"; // google is index 3; reachedIndex is only 1
    await waitForScreen(dom, "database");
  });

  it("round-trips back through every screen and forward again without anything becoming unreachable or double-counted", async () => {
    const baseUrl = await start();
    const dom = await loadWizard(baseUrl);

    await advanceToSecrets(dom);
    await goForward(dom, "google");

    findButtonByLabel(dom, "Skip for now").click();
    await waitForScreen(dom, "finish");
    await waitFor(() => !!dom.window.document.getElementById("summary-list")?.children.length, "finish summary to render");

    // Now walk all the way back: finish -> google -> secrets -> database -> welcome.
    await goBack(dom, "google");
    await goBack(dom, "secrets");
    await waitFor(() => !primaryBtn(dom).disabled, "secrets re-check to resolve on the way back");

    await goBack(dom, "database");
    await waitFor(() => !primaryBtn(dom).disabled, "database screen's write-access check to resolve again");
    expect(backBtn(dom).hidden).toBe(false); // database always shows Back

    await goBack(dom, "welcome");
    expect(backBtn(dom).hidden).toBe(true); // welcome hides Back

    // Forward again, all the way to finish — every screen must still be
    // reachable (reachedIndex from the first pass persists this session,
    // so nothing should have become newly blocked) and nothing should
    // have been double-counted into skipping a screen.
    await goForward(dom, "database");
    await waitFor(() => !primaryBtn(dom).disabled, "database re-check to resolve");
    await goForward(dom, "secrets");
    await waitFor(() => !primaryBtn(dom).disabled, "secrets re-check to resolve");
    await goForward(dom, "google");
    findButtonByLabel(dom, "Skip for now").click();
    await waitForScreen(dom, "finish");

    // A hash-jump straight to #finish is now legitimate (reachedIndex is 4).
    dom.window.location.hash = "#/secrets";
    await waitForScreen(dom, "secrets");
    dom.window.location.hash = "#/finish";
    await waitForScreen(dom, "finish"); // now allowed, since it has actually been reached
  });

  it("back targets match the reorder: secrets->database, google->secrets, finish->google", async () => {
    const baseUrl = await start();
    const dom = await loadWizard(baseUrl);

    await advanceToSecrets(dom);
    await goBack(dom, "database"); // secrets' back -> database
    await waitFor(() => !primaryBtn(dom).disabled, "database re-check to resolve");

    await goForward(dom, "secrets");
    await waitFor(() => !primaryBtn(dom).disabled, "secrets re-check to resolve");
    await goForward(dom, "google");
    await goBack(dom, "secrets"); // google's back -> secrets

    await waitFor(() => !primaryBtn(dom).disabled, "secrets re-check to resolve");
    await goForward(dom, "google");
    findButtonByLabel(dom, "Skip for now").click();
    await waitForScreen(dom, "finish");
    await goBack(dom, "google"); // finish's back -> google
  });
});
