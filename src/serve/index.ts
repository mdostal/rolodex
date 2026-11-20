import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { createFileSecretsAdapter, type SecretsAdapter } from "../lib/secrets-adapter.js";
import { Store } from "../lib/store.js";
import { loadServeConfig, type ServeConfig } from "./config.js";
import { createServeServer, type ServeServer } from "./server.js";

/**
 * Entry point for `rolodex serve` (cm-04). Loads config from the
 * environment, opens the store, and listens on 0.0.0.0:PORT. Standalone
 * mode (app, stdio MCP, CLI commands) is untouched: nothing here runs
 * unless `serve` is the command.
 *
 * Secrets: in serve mode Google OAuth material comes from files injected
 * under ROLODEX_SECRETS_DIR (default /pantheon-secrets/rolodex) through
 * createFileSecretsAdapter() — never from the keychain or the portunus CLI,
 * which a container does not have (grill H5).
 */

/** rolodex's version, from package.json (two levels up from src/serve and dist/serve). */
export function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export interface StartedServe {
  server: ServeServer;
  store: Store;
  secrets: SecretsAdapter;
  config: Omit<ServeConfig, "token">;
  close(): Promise<void>;
}

export async function startServe(
  env: NodeJS.ProcessEnv = process.env,
  log: (line: string) => void = (line) => process.stderr.write(line + "\n"),
): Promise<StartedServe> {
  const { token, ...config } = loadServeConfig(env);
  const store = new Store(config.dbPath);
  const secrets = createFileSecretsAdapter({ dir: config.secretsDir });
  const version = packageVersion();
  const server = createServeServer({ store, token, version, log });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const addr = server.address() as AddressInfo;
  log(`rolodex serve ${version} listening on ${addr.address}:${addr.port} (db ${config.dbPath})`);

  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    }));
  return { server, store, secrets, config, close };
}

/** Runs serve mode until SIGTERM/SIGINT; used by the CLI. */
export async function runServe(): Promise<void> {
  const started = await startServe();
  const stop = (signal: string) => {
    process.stderr.write(`rolodex serve: ${signal}, shutting down\n`);
    void started.close().then(() => process.exit(0));
  };
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.once("SIGINT", () => stop("SIGINT"));
}
