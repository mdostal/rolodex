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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { createRolodexServer } from "./server.js";
import { createInMemorySecretsAdapter } from "../lib/secrets-adapter.js";
import { getSecretsBackendChoiceSync } from "./secrets-backend-config.js";

// vitest's own default per-test timeout (5s) was the actual binding
// constraint on CI, not the waitFor() helper's own internal polling budget
// below — a bumped internal budget is meaningless if vitest kills the test
// before that budget is ever reached. The secrets screen now makes two
// sequential HTTP round trips (Portunus detection, then the capability
// check) where it previously made one, which is enough added latency to
// occasionally exceed 5s on a resource-constrained CI runner during a full
// suite run, without anything actually being hung — confirmed by CI
// reporting "Test timed out in 5000ms" specifically, not a waitFor()
// message, on every failing test in this file.
//
// Bumped again (20000 -> 60000): this is a PER-TEST total budget, not a
// per-waitFor() one — "back targets match the reorder" alone drives ~11
// sequential goForward()/goBack()/waitFor() calls, each internally capped
// at 10s. 20000ms gave headroom for roughly two slow waits before hitting
// this ceiling; under real CI contention (confirmed via a genuine CI
// failure, not assumed) that's not enough slack for eleven. Real CI
// concurrency was also reduced separately (ci.yml/release.yml's
// `--maxWorkers=2`) rather than trying to fix this by raising numbers
// alone — the two mitigations are independent, not redundant.
vi.setConfig({ testTimeout: 60000 });

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

async function start(opts: { isPortunusAvailable?: () => Promise<boolean> } = {}): Promise<string> {
  server = createRolodexServer({
    homeDir: dir,
    secretsCapabilityFactory: () => createInMemorySecretsAdapter(),
    secrets: createInMemorySecretsAdapter(),
    // Deliberately defaults to false, NOT the real isPortunusAvailable()
    // probe: this file drives the wizard's real client-side JS in jsdom,
    // which really calls GET /api/wizard/secrets-backends — leaving this
    // undetermined would make every test below depend on whether the
    // machine running the suite happens to have a real `portunus` binary on
    // PATH. Every describe block in this file exercises the Portunus-absent
    // ("no choice, Keychain-only, identical to before pfb-04") path unless
    // it explicitly overrides this — the Portunus-detected choice UI has its
    // own dedicated describe block further down with `isPortunusAvailable:
    // async () => true`.
    isPortunusAvailable: opts.isPortunusAvailable ?? (async () => false),
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

/** Wraps dom.window.fetch so any request whose URL contains
 * `urlSubstring` only resolves after an artificial `delayMs` delay, while
 * every other request (the capability probe, live backend checks, etc.)
 * passes straight through untouched via the real fetch loadWizard() wired
 * up. Returns flags for whether the matching request has been issued and
 * whether it has resolved, so a test can prove *ordering* — e.g. that
 * navigate() genuinely happens only after a specific persist call
 * completes — rather than merely observing eventual state once both have
 * already finished. Polling eventual DOM state after goForward() resolves
 * can't distinguish a real `await persist()` from a fire-and-forget call
 * that just happens to be fast on localhost; widening the in-flight
 * window here makes that distinction observable. */
function delayFetch(dom: JSDOM, urlSubstring: string, delayMs: number): { hasStarted: () => boolean; hasResolved: () => boolean } {
  const win = dom.window as unknown as { fetch: typeof fetch };
  const realFetch = win.fetch;
  let started = false;
  let resolved = false;
  win.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (!url.includes(urlSubstring)) return realFetch(input, init);
    started = true;
    return new Promise<Response>((resolve, reject) => {
      setTimeout(() => {
        realFetch(input, init).then(
          (res) => { resolved = true; resolve(res); },
          (err) => { resolved = true; reject(err); },
        );
      }, delayMs);
    });
  }) as typeof fetch;
  return { hasStarted: () => started, hasResolved: () => resolved };
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

// 10s, not 4s: the secrets screen now makes two sequential HTTP round trips
// (GET /api/wizard/secrets-backends, then POST /api/wizard/secrets-check)
// where it previously made one — on a resource-constrained CI runner
// running the full suite, that's enough added latency to occasionally
// exceed a tight timeout even though nothing is actually hung.
async function waitFor(fn: () => boolean, label: string, timeoutMs = 10000): Promise<void> {
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

// pfb-04: the Secrets screen's real Keychain/Portunus choice UI, gated on
// GET /api/wizard/secrets-backends' `portunusAvailable` (itself backed by
// isPortunusAvailable(), injected here — see start()'s own docstring on why
// every OTHER describe block in this file pins this to `false`).
describe("Secrets screen choice UI (pfb-04)", () => {
  /** Drives the wizard from "welcome" through "database" and lands it on
   * "secrets" with that screen's initial capability check resolved —
   * shared setup for every test below, mirroring advanceToSecrets() but
   * stopping one step earlier since each test needs to inspect the secrets
   * screen's freshly-rendered DOM itself. */
  async function advanceToDatabaseChecked(dom: JSDOM): Promise<void> {
    expect(hashKey(dom)).toBe("welcome");
    await goForward(dom, "database");
    await waitFor(() => !primaryBtn(dom).disabled, "database screen's write-access check to resolve");
  }

  // NOT goForward(dom, "secrets") / waitForScreen(dom, "secrets") — those
  // rely on the module-level SCREEN_H1 map, which is pinned to today's
  // no-choice heading ("Checking secure storage") for the "secrets" key,
  // since every OTHER describe block in this file exercises that path. When
  // Portunus IS detected the screen's real rendered heading is "Choose your
  // secure storage" instead, so this file's Portunus-detected tests wait on
  // that heading directly rather than overloading SCREEN_H1 with a second,
  // scenario-dependent meaning for the same key.
  async function waitForSecretsChoiceScreen(dom: JSDOM): Promise<void> {
    await waitFor(
      () => hashKey(dom) === "secrets" && h1Text(dom).includes("Choose your secure storage"),
      "screen to become #secrets with the Portunus-detected choice UI rendered",
    );
  }

  it("Portunus NOT detected: the secrets screen is byte-identical to today — no visible choice, Keychain-only (the hard requirement)", async () => {
    const baseUrl = await start(); // default: isPortunusAvailable resolves false
    const dom = await loadWizard(baseUrl);
    await advanceToDatabaseChecked(dom);
    await goForward(dom, "secrets");
    await waitFor(() => !primaryBtn(dom).disabled, "secrets screen's keychain check to resolve");

    expect(h1Text(dom)).toBe("Checking secure storage");
    expect(dom.window.document.getElementById("secrets-backend-choice")).toBeNull();
    expect(dom.window.document.getElementById("secrets-backend-keychain")).toBeNull();
    expect(dom.window.document.getElementById("secrets-backend-portunus")).toBeNull();
    expect(dom.window.document.getElementById("secrets-status")?.textContent).toContain("macOS Keychain");
  });

  it("Portunus detected: a real choice is shown, defaulting to Keychain, with that backend's own live check result", async () => {
    const baseUrl = await start({ isPortunusAvailable: async () => true });
    const dom = await loadWizard(baseUrl);
    await advanceToDatabaseChecked(dom);
    primaryBtn(dom).click();
    await waitForSecretsChoiceScreen(dom);
    await waitFor(() => !primaryBtn(dom).disabled, "secrets screen's initial (Keychain) check to resolve");

    expect(h1Text(dom)).toBe("Choose your secure storage");
    const keychainRadio = dom.window.document.getElementById("secrets-backend-keychain") as HTMLInputElement | null;
    const portunusRadio = dom.window.document.getElementById("secrets-backend-portunus") as HTMLInputElement | null;
    expect(keychainRadio).toBeTruthy();
    expect(portunusRadio).toBeTruthy();
    expect(keychainRadio!.checked).toBe(true);
    expect(portunusRadio!.checked).toBe(false);
    expect(dom.window.document.getElementById("secrets-status")?.textContent).toContain("macOS Keychain");
  });

  it("selecting Portunus runs its own live, distinct capability check", async () => {
    const baseUrl = await start({ isPortunusAvailable: async () => true });
    const dom = await loadWizard(baseUrl);
    await advanceToDatabaseChecked(dom);
    primaryBtn(dom).click();
    await waitForSecretsChoiceScreen(dom);
    await waitFor(() => !primaryBtn(dom).disabled, "secrets screen's initial (Keychain) check to resolve");

    const portunusRadio = dom.window.document.getElementById("secrets-backend-portunus") as HTMLInputElement;
    portunusRadio.click();

    await waitFor(
      () => (dom.window.document.getElementById("secrets-status")?.textContent || "").includes("Portunus"),
      "secrets-status to reflect the Portunus-specific check result",
    );
    await waitFor(() => !primaryBtn(dom).disabled, "Portunus check to resolve and re-enable Next");
    expect(dom.window.document.getElementById("secrets-status")?.textContent).toContain("Portunus");
  });

  it("selecting Portunus, its check succeeding, and clicking Next persists the choice to wizard-config.json BEFORE navigating to google", async () => {
    const baseUrl = await start({ isPortunusAvailable: async () => true });
    const dom = await loadWizard(baseUrl);
    await advanceToDatabaseChecked(dom);
    primaryBtn(dom).click();
    await waitForSecretsChoiceScreen(dom);
    await waitFor(() => !primaryBtn(dom).disabled, "secrets screen's initial (Keychain) check to resolve");

    const portunusRadio = dom.window.document.getElementById("secrets-backend-portunus") as HTMLInputElement;
    portunusRadio.click();
    await waitFor(() => !primaryBtn(dom).disabled, "Portunus check to resolve and re-enable Next");

    // Nothing persisted yet — the choice only round-trips through the
    // server when the user actually proceeds (Next), not merely on
    // selection.
    expect(getSecretsBackendChoiceSync(dir)).toBe("keychain");

    // Merely asserting eventual state after goForward() resolves (which
    // itself waits for the "google" screen to render) would still pass
    // even if the real code fired navigate("google") first and persisted
    // fire-and-forget after — both the persist POST and the
    // navigation-triggered render are fast enough on localhost that a
    // reversed ordering wouldn't visibly race. To actually prove the
    // ordering the design brief calls out ("Persisted BEFORE
    // navigating... starting the next time this server resolves
    // secrets"), artificially widen the persist-choice request's
    // in-flight window and assert the screen has NOT navigated while it
    // is still pending — only once it resolves.
    const persistGate = delayFetch(dom, "/api/wizard/secrets-backend-choice", 300);

    primaryBtn(dom).click();

    await waitFor(() => persistGate.hasStarted(), "persist-choice request to have been issued");

    // Well under the 300ms artificial delay above — plenty of time for an
    // (incorrect) navigate-first implementation to have already flipped
    // the hash and rendered the google screen.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(persistGate.hasResolved()).toBe(false);
    expect(hashKey(dom)).toBe("secrets");
    expect(h1Text(dom)).toBe("Choose your secure storage");
    expect(getSecretsBackendChoiceSync(dir)).toBe("keychain"); // still not written server-side either

    await waitForScreen(dom, "google");

    expect(persistGate.hasResolved()).toBe(true);
    expect(getSecretsBackendChoiceSync(dir)).toBe("portunus");
  });

  it("selecting Keychain explicitly (the default) and proceeding persists 'keychain', not leaving it unset", async () => {
    const baseUrl = await start({ isPortunusAvailable: async () => true });
    const dom = await loadWizard(baseUrl);
    await advanceToDatabaseChecked(dom);
    primaryBtn(dom).click();
    await waitForSecretsChoiceScreen(dom);
    await waitFor(() => !primaryBtn(dom).disabled, "secrets screen's initial (Keychain) check to resolve");

    await goForward(dom, "google");
    expect(getSecretsBackendChoiceSync(dir)).toBe("keychain");
  });

  it("back from the choice screen still targets database, and the choice UI re-renders correctly on returning to secrets", async () => {
    const baseUrl = await start({ isPortunusAvailable: async () => true });
    const dom = await loadWizard(baseUrl);
    await advanceToDatabaseChecked(dom);
    primaryBtn(dom).click();
    await waitForSecretsChoiceScreen(dom);
    await waitFor(() => !primaryBtn(dom).disabled, "secrets screen's initial (Keychain) check to resolve");

    await goBack(dom, "database");
    await waitFor(() => !primaryBtn(dom).disabled, "database re-check to resolve");

    primaryBtn(dom).click();
    await waitForSecretsChoiceScreen(dom);
    await waitFor(() => !primaryBtn(dom).disabled, "secrets screen's re-check to resolve");
    expect(h1Text(dom)).toBe("Choose your secure storage");
    expect(dom.window.document.getElementById("secrets-backend-keychain")).toBeTruthy();
  });
});
