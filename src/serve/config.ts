import { readFileSync } from "node:fs";

/**
 * Configuration for `rolodex serve` (cm-04), from the environment only:
 *
 *   ROLODEX_DB                  SQLite path            (default /data/rolodex.db)
 *   ROLODEX_SERVICE_TOKEN_FILE  file holding the token (default /pantheon-secrets/rolodex/service-token)
 *   ROLODEX_SECRETS_DIR         injected secret files  (default /pantheon-secrets/rolodex)
 *   PORT                        listen port            (default 4180)
 *
 * The service token is ALWAYS read from a file, never from an env value
 * (env leaks into process listings, crash dumps and child processes): a
 * set ROLODEX_SERVICE_TOKEN is refused rather than read. Serve mode binds
 * 0.0.0.0 so the container port is reachable; standalone mode is
 * unchanged. No error message ever includes the token.
 */

export const DEFAULT_DB = "/data/rolodex.db";
export const DEFAULT_SECRETS_DIR = "/pantheon-secrets/rolodex";
export const DEFAULT_TOKEN_FILE = `${DEFAULT_SECRETS_DIR}/service-token`;
export const DEFAULT_PORT = 4180;
/** Shortest token accepted; anything shorter is a misconfiguration. */
export const MIN_TOKEN_LENGTH = 16;

export interface ServeConfig {
  dbPath: string;
  port: number;
  host: string;
  token: string;
  secretsDir: string;
}

export function loadServeConfig(env: NodeJS.ProcessEnv = process.env): ServeConfig {
  if (env.ROLODEX_SERVICE_TOKEN !== undefined) {
    throw new Error(
      "ROLODEX_SERVICE_TOKEN is not read: pass the service token as a file via ROLODEX_SERVICE_TOKEN_FILE",
    );
  }

  const portRaw = env.PORT?.trim() || String(DEFAULT_PORT);
  const port = /^\d+$/.test(portRaw) ? Number(portRaw) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer between 1 and 65535 (got ${JSON.stringify(portRaw)})`);
  }

  const tokenFile = env.ROLODEX_SERVICE_TOKEN_FILE?.trim() || DEFAULT_TOKEN_FILE;
  let token: string;
  try {
    token = readFileSync(tokenFile, "utf8").trim();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "error";
    throw new Error(`cannot read the service token file ${tokenFile} (${code})`);
  }
  if (token.length < MIN_TOKEN_LENGTH) {
    // Deliberately no length or content in the message.
    throw new Error(`the service token in ${tokenFile} is empty or shorter than ${MIN_TOKEN_LENGTH} characters`);
  }

  return {
    dbPath: env.ROLODEX_DB?.trim() || DEFAULT_DB,
    port,
    host: "0.0.0.0",
    token,
    secretsDir: env.ROLODEX_SECRETS_DIR?.trim() || DEFAULT_SECRETS_DIR,
  };
}
