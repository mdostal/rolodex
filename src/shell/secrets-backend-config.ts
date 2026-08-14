import { readFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import path from "node:path";

/**
 * Resolves and persists WHICH SecretsAdapter backend ("keychain" |
 * "portunus") this install uses, for the setup wizard's Secrets screen
 * (pfb-04). Mirrors db-location.ts's shape exactly — homeDir-parameterized,
 * reads/writes the SAME `wizard-config.json` file (a new
 * `secretsBackendChoice` field alongside db-location.ts's own
 * `dbPathOverride`), fail-safe defaults on any read/parse error rather than
 * throwing.
 *
 * The one deliberate divergence from db-location.ts: getSecretsBackendChoiceSync()
 * below is SYNCHRONOUS (`node:fs`'s `readFileSync`), not `fs/promises`. This
 * is a considered architecture decision, not an oversight or inconsistency —
 * see the design-discussion doc (.pHive/epics/portunus-secrets-backend/docs/
 * design-discussion.md §3) for the full writeup. Short version: an earlier
 * draft proposed making the secrets adapter's construction async/lazy "like
 * Store," on the theory that it could mirror Store's own lazy-construction
 * pattern. That analogy was checked against the real code during grill and
 * found false — `store` has no eager synchronous consumer at construction
 * time, but `secrets` does: server.ts constructs `googleSync` from it on the
 * very next line (`const googleSync = createGoogleSync({ secrets });`),
 * synchronously, and that construction must keep receiving a concrete,
 * already-resolved SecretsAdapter — not a Promise or a lazily-resolving
 * proxy — or googleSync's own construction (and every test that already
 * exercises it) would need to change shape too. A synchronous read of a tiny
 * local JSON file at process-construction time sidesteps that entire
 * cascade: `createSecretsAdapter({ backend: getSecretsBackendChoiceSync(homeDir) })`
 * slots into the exact same call site, still returns a concrete
 * SecretsAdapter synchronously, and nothing downstream (googleSync's
 * construction, its own tests) has to know this story happened at all.
 *
 * The setter (setSecretsBackendChoice) is async, matching db-location.ts's
 * own setDbPathOverride — only the wizard's read-at-startup path has the
 * synchronous requirement; persisting a new choice from an HTTP route
 * handler has no such constraint.
 */

function resolveHomeDir(homeDir?: string): string {
  return homeDir ?? process.env.HOME ?? ".";
}

function configDir(homeDir?: string): string {
  return path.join(resolveHomeDir(homeDir), ".local/share/rolodex");
}

function wizardConfigPath(homeDir?: string): string {
  return path.join(configDir(homeDir), "wizard-config.json");
}

/** Which real SecretsAdapter backend this install has chosen. Mirrors
 * CreateSecretsAdapterOptions["backend"] (src/lib/secrets-adapter.ts) —
 * kept as a separate, local type (not imported from src/lib) so this
 * shell-layer config module doesn't need to know anything about src/lib
 * beyond the two string literals themselves. */
export type SecretsBackendChoice = "keychain" | "portunus";

/** Same JSON file db-location.ts reads/writes (`wizard-config.json`) — this
 * module only ever adds/reads its own `secretsBackendChoice` field on it,
 * never touching `dbPathOverride`, so the two config readers/writers can
 * safely coexist on the same file without clobbering each other's field. */
interface WizardConfig {
  dbPathOverride?: string;
  /** Set when the user picks a non-default backend on the wizard's Secrets
   * screen (only possible when Portunus was detected — see wizard.html).
   * Absent means "keychain", the fail-safe/today's-only-option default. */
  secretsBackendChoice?: SecretsBackendChoice;
}

function isValidChoice(value: unknown): value is SecretsBackendChoice {
  return value === "keychain" || value === "portunus";
}

/**
 * Synchronous read of wizard-config.json's `secretsBackendChoice` field.
 * Deliberately uses `node:fs`'s `readFileSync`, not `fs/promises` — see this
 * module's top-of-file docstring for why that's required here specifically
 * (server.ts's synchronous createSecretsAdapter()/createGoogleSync() call
 * site) and not merely a stylistic choice.
 *
 * Fails safe to `"keychain"` — today's only real backend, and the default
 * every existing/most users implicitly rely on — on every possible error:
 * missing file (ENOENT, the common case: fresh install, or an install that
 * predates this story), missing/malformed field, corrupt/non-JSON file
 * content, or any other read error (permissions, etc). NEVER throws — a
 * throw here would crash server construction itself, since this is called
 * inline at the `const secrets = ...` call site in server.ts, before any
 * request handler's own try/catch exists to catch it.
 */
export function getSecretsBackendChoiceSync(homeDir?: string): SecretsBackendChoice {
  try {
    const raw = readFileSync(wizardConfigPath(homeDir), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      const choice = (parsed as WizardConfig).secretsBackendChoice;
      if (isValidChoice(choice)) return choice;
    }
    return "keychain";
  } catch {
    // Missing file, unreadable, or malformed JSON — same fail-safe
    // convention as db-location.ts's readConfig(): treat all of these the
    // same as "nothing configured yet" rather than crashing server
    // construction on a corrupt local config file.
    return "keychain";
  }
}

async function readConfig(homeDir?: string): Promise<WizardConfig> {
  try {
    const raw = await fsp.readFile(wizardConfigPath(homeDir), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") return parsed as WizardConfig;
    return {};
  } catch {
    return {};
  }
}

async function writeConfig(cfg: WizardConfig, homeDir?: string): Promise<void> {
  await fsp.mkdir(configDir(homeDir), { recursive: true });
  await fsp.writeFile(wizardConfigPath(homeDir), JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

/**
 * Persists the user's Secrets-screen choice. Async (unlike the getter above)
 * — matches db-location.ts's own setDbPathOverride(); only the
 * server-construction-time READ has the synchronous requirement, not this
 * write, which always runs from an HTTP route handler.
 *
 * Reads the existing config first (mirroring setDbPathOverride()) so a
 * previously-set `dbPathOverride` is preserved rather than clobbered by a
 * write that only intends to touch `secretsBackendChoice`.
 */
export async function setSecretsBackendChoice(choice: SecretsBackendChoice, homeDir?: string): Promise<void> {
  const cfg = await readConfig(homeDir);
  cfg.secretsBackendChoice = choice;
  await writeConfig(cfg, homeDir);
}
