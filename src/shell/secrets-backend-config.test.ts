import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSecretsBackendChoiceSync, setSecretsBackendChoice } from "./secrets-backend-config.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "rolodex-secrets-backend-config-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function configPath(homeDir: string): string {
  return path.join(homeDir, ".local/share/rolodex/wizard-config.json");
}

describe("getSecretsBackendChoiceSync()", () => {
  it("returns 'keychain' when no wizard-config.json exists yet (fresh install)", () => {
    expect(getSecretsBackendChoiceSync(dir)).toBe("keychain");
  });

  it("returns 'keychain' when wizard-config.json exists but has no secretsBackendChoice field (e.g. only dbPathOverride, from an install that predates this story)", () => {
    mkdirSync(path.dirname(configPath(dir)), { recursive: true });
    writeFileSync(configPath(dir), JSON.stringify({ dbPathOverride: "/some/path/rolodex.db" }));
    expect(getSecretsBackendChoiceSync(dir)).toBe("keychain");
  });

  it("returns 'portunus' when that was persisted", async () => {
    await setSecretsBackendChoice("portunus", dir);
    expect(getSecretsBackendChoiceSync(dir)).toBe("portunus");
  });

  it("returns 'keychain' when that was persisted explicitly", async () => {
    await setSecretsBackendChoice("portunus", dir);
    await setSecretsBackendChoice("keychain", dir);
    expect(getSecretsBackendChoiceSync(dir)).toBe("keychain");
  });

  it("returns 'keychain', not a throw, when wizard-config.json is corrupt (not valid JSON)", () => {
    mkdirSync(path.dirname(configPath(dir)), { recursive: true });
    writeFileSync(configPath(dir), "{ not valid json at all");
    expect(() => getSecretsBackendChoiceSync(dir)).not.toThrow();
    expect(getSecretsBackendChoiceSync(dir)).toBe("keychain");
  });

  it("returns 'keychain', not a throw, when secretsBackendChoice holds an unrecognized value", () => {
    mkdirSync(path.dirname(configPath(dir)), { recursive: true });
    writeFileSync(configPath(dir), JSON.stringify({ secretsBackendChoice: "not-a-real-backend" }));
    expect(getSecretsBackendChoiceSync(dir)).toBe("keychain");
  });

  it("returns 'keychain', not a throw, when the config file is a JSON array (not an object)", () => {
    mkdirSync(path.dirname(configPath(dir)), { recursive: true });
    writeFileSync(configPath(dir), "[1,2,3]");
    expect(getSecretsBackendChoiceSync(dir)).toBe("keychain");
  });

  it("returns 'keychain', not a throw, when the config file is genuinely unreadable (permission denied)", () => {
    mkdirSync(path.dirname(configPath(dir)), { recursive: true });
    writeFileSync(configPath(dir), JSON.stringify({ secretsBackendChoice: "portunus" }));
    chmodSync(configPath(dir), 0o000);
    try {
      expect(() => getSecretsBackendChoiceSync(dir)).not.toThrow();
      expect(getSecretsBackendChoiceSync(dir)).toBe("keychain");
    } finally {
      // Restore so afterEach's rmSync can actually remove it.
      chmodSync(configPath(dir), 0o600);
    }
  });

  it("preserves a previously-set dbPathOverride when secretsBackendChoice is written alongside it", async () => {
    mkdirSync(path.dirname(configPath(dir)), { recursive: true });
    writeFileSync(configPath(dir), JSON.stringify({ dbPathOverride: "/keep/me/rolodex.db" }));
    await setSecretsBackendChoice("portunus", dir);
    const raw = JSON.parse(readFileSync(configPath(dir), "utf8"));
    expect(raw).toEqual({ dbPathOverride: "/keep/me/rolodex.db", secretsBackendChoice: "portunus" });
  });
});

describe("setSecretsBackendChoice()", () => {
  it("round-trips through getSecretsBackendChoiceSync()", async () => {
    await setSecretsBackendChoice("portunus", dir);
    expect(getSecretsBackendChoiceSync(dir)).toBe("portunus");
  });

  it("creates the config directory if it doesn't exist yet", async () => {
    await expect(setSecretsBackendChoice("portunus", dir)).resolves.toBeUndefined();
    expect(getSecretsBackendChoiceSync(dir)).toBe("portunus");
  });
});
