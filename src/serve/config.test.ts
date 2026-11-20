import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFileSecretsAdapter } from "../lib/secrets-adapter.js";
import { loadServeConfig } from "./config.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "rolodex-serve-config-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function tokenFile(contents: string): string {
  const p = path.join(tmp, "service-token");
  writeFileSync(p, contents);
  return p;
}

describe("loadServeConfig", () => {
  it("applies the documented defaults", () => {
    const file = tokenFile("a-long-enough-service-token-value\n");
    const cfg = loadServeConfig({ ROLODEX_SERVICE_TOKEN_FILE: file });
    expect(cfg).toMatchObject({
      dbPath: "/data/rolodex.db",
      port: 4180,
      host: "0.0.0.0",
      token: "a-long-enough-service-token-value",
      secretsDir: "/pantheon-secrets/rolodex",
    });
  });

  it("honours ROLODEX_DB, PORT and ROLODEX_SECRETS_DIR", () => {
    const file = tokenFile("a-long-enough-service-token-value");
    const cfg = loadServeConfig({
      ROLODEX_SERVICE_TOKEN_FILE: file,
      ROLODEX_DB: "/tmp/x.db",
      PORT: "5000",
      ROLODEX_SECRETS_DIR: "/s",
    });
    expect(cfg).toMatchObject({ dbPath: "/tmp/x.db", port: 5000, secretsDir: "/s" });
  });

  it("refuses to start without a readable token file", () => {
    expect(() => loadServeConfig({ ROLODEX_SERVICE_TOKEN_FILE: path.join(tmp, "missing") })).toThrow(/token file/);
  });

  it("refuses an empty or too-short token", () => {
    expect(() => loadServeConfig({ ROLODEX_SERVICE_TOKEN_FILE: tokenFile("  \n") })).toThrow(/token/);
    expect(() => loadServeConfig({ ROLODEX_SERVICE_TOKEN_FILE: tokenFile("short") })).toThrow(/token/);
  });

  it("refuses a token passed as an env value, never reading it", () => {
    const file = tokenFile("a-long-enough-service-token-value");
    expect(() =>
      loadServeConfig({ ROLODEX_SERVICE_TOKEN_FILE: file, ROLODEX_SERVICE_TOKEN: "a-long-enough-service-token-value" }),
    ).toThrow(/ROLODEX_SERVICE_TOKEN_FILE/);
  });

  it("refuses a bad PORT", () => {
    const file = tokenFile("a-long-enough-service-token-value");
    expect(() => loadServeConfig({ ROLODEX_SERVICE_TOKEN_FILE: file, PORT: "nope" })).toThrow(/PORT/);
  });

  it("never puts the token value in an error message", () => {
    const secret = "a-long-enough-service-token-value";
    const file = tokenFile(secret);
    try {
      loadServeConfig({ ROLODEX_SERVICE_TOKEN_FILE: file, PORT: "nope" });
    } catch (err) {
      expect(String(err)).not.toContain(secret);
    }
  });
});

describe("createFileSecretsAdapter (injected secrets, serve mode)", () => {
  it("reads a secret from <dir>/<key>, trimming one trailing newline", async () => {
    writeFileSync(path.join(tmp, "google-oauth-token"), '{"refresh_token":"r"}\n');
    const s = createFileSecretsAdapter({ dir: tmp });
    expect(await s.get("google-oauth-token")).toBe('{"refresh_token":"r"}');
  });

  it("returns undefined for a missing secret", async () => {
    expect(await createFileSecretsAdapter({ dir: tmp }).get("absent")).toBeUndefined();
  });

  it("refuses keys that could escape the directory", async () => {
    const s = createFileSecretsAdapter({ dir: tmp });
    for (const key of ["../etc/passwd", "a/b", "..", ".", "", "a\\b"]) {
      await expect(s.get(key), key).rejects.toThrow(/invalid secret key/);
    }
  });

  it("is read-only: set and delete throw without writing", async () => {
    const s = createFileSecretsAdapter({ dir: tmp });
    await expect(s.set("k", "v")).rejects.toThrow(/read-only/);
    await expect(s.delete("k")).rejects.toThrow(/read-only/);
    expect(await s.get("k")).toBeUndefined();
  });
});
