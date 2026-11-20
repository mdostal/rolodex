import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyPullToStore, deleteContactEverywhere, pushAllToGoogle } from "./google-sync.js";
import { Store } from "./store.js";
import type { Contact } from "./types.js";

/**
 * Standalone regression suite (contacts-memory grill H10).
 *
 * Runs a fixed scenario (list, upsert, search, follow-ups, interactions,
 * settings, Google pull/push/delete with fakes) and compares the normalized
 * transcript against `__fixtures__/standalone-v0.5.json`, which was captured
 * by running this exact scenario against the v0.5 Store BEFORE scopes were
 * added. `__fixtures__/standalone-v0.5.db` is the database file that same
 * pre-change run left behind; the new Store must open it and show the same
 * contacts.
 *
 * Re-capturing (`ROLODEX_CAPTURE_FIXTURES=1`) defeats the point of the suite;
 * only do it for a deliberate, reviewed behaviour change.
 */

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const TRANSCRIPT_FIXTURE = path.join(FIXTURE_DIR, "standalone-v0.5.json");
const DB_FIXTURE = path.join(FIXTURE_DIR, "standalone-v0.5.db");
const CAPTURE = process.env.ROLODEX_CAPTURE_FIXTURES === "1";

/** The standalone surface: the Store API exactly as the shell, MCP server
 * and CLI call it, with no scope argument in sight. */
type StandaloneStore = Pick<
  Store,
  | "list"
  | "upsert"
  | "get"
  | "delete"
  | "search"
  | "getSetting"
  | "setSetting"
  | "getFollowUpConfig"
  | "setFollowUpConfig"
  | "getAppearance"
  | "setAppearance"
  | "needsFollowUp"
  | "setVerdict"
  | "setNextStep"
  | "logInteraction"
  | "listInteractions"
>;

function openStandalone(dbPath: string): StandaloneStore {
  return new Store(dbPath);
}

const OLD = "2020-01-01T00:00:00.000Z";
const OLD_INTERACTION = "2020-02-01T00:00:00.000Z";

function contact(fields: Partial<Contact> & { name: string }): Contact {
  return { id: "", verdict: "none", createdAt: "", updatedAt: "", ...fields };
}

/** Replaces run-dependent values (random uuids, "now" timestamps) with stable
 * tokens so two runs of the same scenario produce byte-identical output. */
function makeNormalizer(runStart: number) {
  const ids = new Map<string, string>();
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const iso = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      if (uuid.test(v)) {
        if (!ids.has(v)) ids.set(v, `<id#${ids.size + 1}>`);
        return ids.get(v);
      }
      if (iso.test(v) && Math.abs(Date.parse(v) - runStart) < 86_400_000 * 2) return "<now>";
      return v;
    }
    if (typeof v === "number") return Number.isInteger(v) ? v : Number(v.toFixed(6));
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) if (val !== undefined) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return walk;
}

async function runScenario(s: StandaloneStore): Promise<Record<string, unknown>> {
  const t: Record<string, unknown> = {};
  const recentAt = new Date(Date.now() - 86_400_000).toISOString();

  t.emptyList = s.list();

  const ada = s.upsert(
    contact({
      name: "Ada Lovelace",
      org: "Analytical Engines",
      role: "Mathematician",
      email: "ada@example.com",
      what: "computing pioneer",
      angle: "engine programming",
      tags: ["math", "history"],
      nextStep: "send notes",
      createdAt: OLD,
    }),
  );
  const grace = s.upsert(
    contact({
      name: "Grace Hopper",
      org: "Navy",
      phone: "+1 (555) 010-2000",
      what: "compilers",
      verdict: "strong",
      nextStep: "invite to talk",
      createdAt: OLD,
    }),
  );
  const linus = s.upsert(contact({ name: "linus", email: "linus@example.com", verdict: "watch", createdAt: OLD }));
  const barbara = s.upsert(contact({ name: "Barbara Liskov", email: "barbara@example.com", nextStep: "follow up" }));
  t.created = [ada, grace, linus, barbara];

  // Dedup by exact email (same email, different name) updates the same row.
  t.dedupByEmail = s.upsert(contact({ name: "Ada King", email: "ada@example.com", createdAt: OLD }));
  // Direct edit by id.
  t.editById = s.upsert({ ...grace, role: "Rear Admiral", tags: ["navy"] });
  t.listAfterUpserts = s.list();
  t.getMissing = s.get("does-not-exist") ?? null;

  t.searchAda = s.search("ada");
  t.searchPrefix = s.search("comp");
  t.searchVerdict = s.search("navy", { verdict: "strong" });
  t.searchVerdictMiss = s.search("navy", { verdict: "pass" });
  t.searchLimit = s.search("e", { limit: 1 });
  t.searchEmpty = s.search("   ");
  t.searchPunct = s.search('"quoted" %_');

  s.logInteraction({ id: "", contactId: grace.id, at: OLD_INTERACTION, note: "  first call  ", channel: "call" });
  s.logInteraction({ id: "int-fixed", contactId: grace.id, at: "2020-03-01T00:00:00.000Z", note: "email", channel: "email" });
  s.logInteraction({ id: "", contactId: linus.id, at: recentAt, note: "recent dm" });
  let emptyNoteError = "";
  try {
    s.logInteraction({ id: "", contactId: grace.id, at: OLD, note: "   " });
  } catch (err) {
    emptyNoteError = (err as Error).message;
  }
  t.emptyNoteError = emptyNoteError;
  t.interactionsGrace = s.listInteractions(grace.id);
  t.interactionsLinus = s.listInteractions(linus.id);
  t.interactionsNone = s.listInteractions("does-not-exist");

  t.followUpConfigDefault = s.getFollowUpConfig();
  t.followUpsDefault = s.needsFollowUp();
  t.followUpsExplicit = s.needsFollowUp(10_000, 0);
  s.setFollowUpConfig({ windowDays: 7, graceDays: 0 });
  t.followUpConfigSet = s.getFollowUpConfig();
  t.followUpsAfterConfig = s.needsFollowUp();

  t.appearanceDefault = s.getAppearance();
  s.setAppearance({ theme: "brass", iconId: 3 });
  t.appearanceSet = s.getAppearance();
  t.settingFallback = s.getSetting("custom.key", "fallback");
  s.setSetting("custom.key", "v1");
  s.setSetting("custom.key", "v2");
  t.settingSet = s.getSetting("custom.key", "fallback");

  s.setVerdict(linus.id, "pass");
  s.setNextStep(linus.id, "ping in spring");
  t.afterVerdictAndNext = s.get(linus.id);

  // Google pull: one matches Ada by email (local-only fields must survive),
  // one is brand new.
  const pulled: Contact[] = [
    contact({
      id: "people/c1",
      name: "Ada Lovelace (Google)",
      email: "ada@example.com",
      phone: "555-1111",
      googleResourceName: "people/c1",
      googleEtag: "etag-c1",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }),
    contact({
      id: "people/c2",
      name: "Edsger Dijkstra",
      email: "edsger@example.com",
      googleResourceName: "people/c2",
      googleEtag: "etag-c2",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }),
  ];
  t.pullSummary = applyPullToStore(pulled, s);
  t.listAfterPull = s.list();
  // A second identical pull is idempotent.
  t.pullSummaryAgain = applyPullToStore(pulled, s);
  t.listAfterSecondPull = s.list();

  const pushed: string[] = [];
  t.pushSummary = await pushAllToGoogle(s, {
    push: async (c) => {
      pushed.push(c.name);
      if (c.name === "linus") throw new Error("etag conflict for linus");
      return { resourceName: c.googleResourceName ?? `people/new-${c.name.replace(/\s+/g, "-")}`, etag: `etag-pushed-${c.name.length}` };
    },
  });
  t.pushedOrder = pushed;
  t.listAfterPush = s.list();

  const googleDeletes: string[] = [];
  const google = {
    deleteContact: async (rn: string) => {
      googleDeletes.push(rn);
    },
  };
  t.deleteGraceEverywhere = await deleteContactEverywhere(grace.id, s, google);
  t.deleteMissingEverywhere = await deleteContactEverywhere("does-not-exist", s, google);
  t.googleDeletes = googleDeletes;
  t.interactionsAfterDelete = s.listInteractions(grace.id);
  t.deleteAgain = s.delete(grace.id);
  t.deleteBarbara = s.delete(barbara.id);
  t.finalList = s.list();
  t.finalSearch = s.search("example");
  t.finalFollowUps = s.needsFollowUp(10_000, 0);
  return t;
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "rolodex-regression-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function checkpoint(dbPath: string) {
  const raw = new DatabaseSync(dbPath);
  raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  raw.close();
}

describe("standalone regression (v0.5 fixtures)", () => {
  it("the scenario's transcript is identical to the pre-scopes fixture", async () => {
    const dbPath = path.join(dir, "rolodex.db");
    const runStart = Date.now();
    const transcript = makeNormalizer(runStart)(await runScenario(openStandalone(dbPath)));

    if (CAPTURE) {
      mkdirSync(FIXTURE_DIR, { recursive: true });
      writeFileSync(TRANSCRIPT_FIXTURE, JSON.stringify(transcript, null, 2) + "\n");
      checkpoint(dbPath);
      copyFileSync(dbPath, DB_FIXTURE);
      return;
    }
    const expected = JSON.parse(readFileSync(TRANSCRIPT_FIXTURE, "utf8"));
    expect(transcript).toEqual(expected);
  });

  it("opening the pre-scopes database shows the same contacts as the fixture", () => {
    if (CAPTURE) return;
    expect(existsSync(DB_FIXTURE)).toBe(true);
    const dbPath = path.join(dir, "v05.db");
    copyFileSync(DB_FIXTURE, dbPath);
    const s = openStandalone(dbPath);
    const expected = JSON.parse(readFileSync(TRANSCRIPT_FIXTURE, "utf8")) as Record<string, unknown>;
    // The fixture db's timestamps were "now" when it was captured, so
    // compare with timestamps masked rather than with the time-relative
    // normalizer.
    const mask = (v: unknown) =>
      JSON.parse(
        JSON.stringify(v, (_k, val) => {
          if (typeof val === "string" && (val === "<now>" || /^\d{4}-\d\d-\d\dT/.test(val))) return "<ts>";
          if (typeof val === "string" && /^(<id#\d+>|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(val)) return "<id>";
          if (typeof val === "number" && !Number.isInteger(val)) return Number(val.toFixed(6));
          return val;
        }),
      );
    expect(mask(s.list())).toEqual(mask(expected.finalList));
    expect(mask(s.search("example"))).toEqual(mask(expected.finalSearch));
    expect(s.getFollowUpConfig()).toEqual(expected.followUpConfigSet);
    expect(s.getAppearance()).toEqual(expected.appearanceSet);
    expect(s.getSetting("custom.key", "fallback")).toBe("v2");
  });
});
