import * as fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { defaultDbPath as storeDefaultDbPath } from "../lib/store.js";

/**
 * Resolves and persists WHERE the sqlite file lives, for the setup wizard's
 * Database-location screen (design brief screen 2). Deliberately shell-only,
 * not part of src/lib: `Store` (the "core" layer) must keep knowing nothing
 * about a specific user's config beyond ROLODEX_DB / its constructor arg —
 * see docs/ARCHITECTURE.md's core/your-layer split. This module is the
 * "your layer" piece that resolves to a concrete path before a `Store` is
 * ever constructed.
 *
 * Precedence, highest first: `ROLODEX_DB` env var (explicit, unambiguous,
 * matches existing Store behavior) > a wizard-set override persisted in
 * `wizard-config.json` next to the default DB location > the built-in
 * default path.
 *
 * `homeDir` is threaded through every function (defaulting to
 * `process.env.HOME ?? "."`) purely so tests can point this at a temp
 * directory instead of touching the real developer's `~/.local/share`.
 */

function resolveHomeDir(homeDir?: string): string {
  return homeDir ?? process.env.HOME ?? ".";
}

/** Same default the core Store uses — re-exported here so wizard code has
 * one import to reach for. Delegates to Store's own defaultDbPath() when no
 * explicit `homeDir` is given (the real, non-test path) so the two never
 * drift; only duplicates the one-line format when a caller (tests) needs to
 * override HOME without mutating process.env globally. */
export function defaultDbPath(homeDir?: string): string {
  if (homeDir === undefined) return storeDefaultDbPath();
  return `${homeDir}/.local/share/rolodex/rolodex.db`;
}

function configDir(homeDir?: string): string {
  return path.join(resolveHomeDir(homeDir), ".local/share/rolodex");
}

function wizardConfigPath(homeDir?: string): string {
  return path.join(configDir(homeDir), "wizard-config.json");
}

interface WizardConfig {
  /** Set when the user changes the DB location on the wizard's Database
   * screen; a path, never a secret, so it's plain JSON on disk (gitignored
   * `.local/` territory), not routed through SecretsAdapter. */
  dbPathOverride?: string;
}

async function readConfig(homeDir?: string): Promise<WizardConfig> {
  try {
    const raw = await fsp.readFile(wizardConfigPath(homeDir), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") return parsed as WizardConfig;
    return {};
  } catch {
    // Missing file, unreadable, or malformed JSON — treat all the same as
    // "no override configured yet" rather than crashing wizard boot on a
    // corrupt local config file.
    return {};
  }
}

async function writeConfig(cfg: WizardConfig, homeDir?: string): Promise<void> {
  await fsp.mkdir(configDir(homeDir), { recursive: true });
  await fsp.writeFile(wizardConfigPath(homeDir), JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

export async function getDbPathOverride(homeDir?: string): Promise<string | undefined> {
  return (await readConfig(homeDir)).dbPathOverride;
}

export async function setDbPathOverride(dbPath: string, homeDir?: string): Promise<void> {
  const cfg = await readConfig(homeDir);
  cfg.dbPathOverride = dbPath;
  await writeConfig(cfg, homeDir);
}

export async function clearDbPathOverride(homeDir?: string): Promise<void> {
  const cfg = await readConfig(homeDir);
  delete cfg.dbPathOverride;
  await writeConfig(cfg, homeDir);
}

/** ROLODEX_DB env var > wizard-set override > built-in default. */
export async function resolveDbPath(homeDir?: string): Promise<string> {
  if (process.env.ROLODEX_DB) return process.env.ROLODEX_DB;
  const override = await getDbPathOverride(homeDir);
  return override ?? defaultDbPath(homeDir);
}

export interface WritabilityResult {
  writable: boolean;
  error?: string;
}

function describeFsError(err: unknown, dir: string): string {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === "EACCES" || code === "EPERM") return `Permission denied writing to "${dir}".`;
  if (code === "ENOTDIR") return `"${dir}" is not a directory — a file already exists somewhere along that path.`;
  if (code === "EROFS") return `"${dir}" is on a read-only filesystem.`;
  if (code === "ENOSPC") return `No space left on the device backing "${dir}".`;
  return err instanceof Error ? err.message : String(err);
}

/**
 * Real (not simulated) writability check: ensures the directory containing
 * `dbPath` exists (creating it if needed) and that a throwaway file can
 * actually be written there and removed. Never touches `dbPath` itself, so
 * it's safe to call against an existing, already-populated database file.
 */
export async function checkDbPathWritable(dbPath: string): Promise<WritabilityResult> {
  const dir = path.dirname(dbPath);
  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch (err) {
    return { writable: false, error: describeFsError(err, dir) };
  }

  const probe = path.join(dir, `.rolodex-write-check-${randomUUID()}`);
  try {
    await fsp.writeFile(probe, "");
    return { writable: true };
  } catch (err) {
    return { writable: false, error: describeFsError(err, dir) };
  } finally {
    await fsp.rm(probe, { force: true }).catch(() => {});
  }
}
