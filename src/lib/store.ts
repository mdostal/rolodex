import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { Contact, Interaction, SearchResult, Verdict } from "./types.js";

/** Settings-table key under which the follow-up config (windowDays/graceDays)
 * is stored, JSON-encoded as a single row. */
const FOLLOW_UP_CONFIG_KEY = "followUp.config";

/** Defaults getFollowUpConfig() lazily seeds when no settings row exists yet. */
const FOLLOW_UP_DEFAULTS = { windowDays: 30, graceDays: 14 } as const;

/** Settings-table key for the appearance config (theme/iconId), JSON-encoded
 * as a single row — same pattern as FOLLOW_UP_CONFIG_KEY. */
const APPEARANCE_CONFIG_KEY = "appearance.config";

/** Defaults getAppearance() lazily seeds when no settings row exists yet.
 * iconId 6 / theme "default" is what's actually shipped today (candidate 6,
 * the plain blue/gray palette) — this is a no-op default, not a new look. */
const APPEARANCE_DEFAULTS: AppearanceConfig = { theme: "default", iconId: 6 };

export type AppearanceTheme = "default" | "brass";

export interface AppearanceConfig {
  theme: AppearanceTheme;
  iconId: number;
}

/**
 * Owns-your-data store. SQLite with an FTS5 full-text index so search is real
 * (name/org/what/angle/tags), not a LIKE scan. The DB path defaults to a
 * user-data dir OUTSIDE the repo (never ./data/) — set ROLODEX_DB to override.
 * All access goes through this module; nothing else writes raw SQL.
 */
export class Store {
  private db: DatabaseSync;
  constructor(path = process.env.ROLODEX_DB ?? defaultDbPath()) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 4000;");
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS contacts (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, org TEXT, role TEXT, email TEXT, phone TEXT,
        met TEXT, what TEXT, angle TEXT, verdict TEXT NOT NULL DEFAULT 'none',
        nextStep TEXT, tags TEXT, googleResourceName TEXT, googleEtag TEXT,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS interactions (
        id TEXT PRIMARY KEY, contactId TEXT NOT NULL, at TEXT NOT NULL, note TEXT NOT NULL, channel TEXT,
        FOREIGN KEY(contactId) REFERENCES contacts(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY, value TEXT NOT NULL
      );
    `);
    // SQLite has no `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` — a database
    // file created before googleEtag existed needs this run once to reach
    // the shape the CREATE TABLE above already gives a brand-new database.
    // Catching specifically "duplicate column" (not a broad catch-all, per
    // this file's own convention below for fts5) keeps a genuine unrelated
    // failure from being silently swallowed here.
    try {
      this.db.exec("ALTER TABLE contacts ADD COLUMN googleEtag TEXT");
    } catch (err) {
      if (!(err instanceof Error) || !err.message.includes("duplicate column")) throw err;
    }
    // FTS5 is a separate statement, in a separate try/catch, deliberately:
    // node:sqlite's bundled SQLite build on this repo's Node (22.12) has no
    // fts5 module compiled in at all ("no such module: fts5", confirmed even
    // with --experimental-sqlite; newer Node — 23+/25 — does have it and no
    // longer needs the flag). Contacts/interactions must always exist for
    // list()/get()/upsert() to work; search() (saf-06, FTS5-dependent) is
    // simply unavailable until this process runs on a Node build with fts5.
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS contacts_fts USING fts5(
          id UNINDEXED, name, org, role, what, angle, tags, content='contacts', content_rowid='rowid'
        );
      `);
    } catch (err) {
      console.warn(
        "rolodex: node:sqlite has no fts5 module on this Node build — full-text search will be unavailable.",
        err,
      );
    }
  }

  /** All contacts, unfiltered. Minimal read used by the shell's list screen. */
  list(): Contact[] {
    const rows = this.db.prepare("SELECT * FROM contacts ORDER BY name COLLATE NOCASE").all();
    return rows.map(rowToContact);
  }

  upsert(c: Contact): Contact {
    // Dedup: googleResourceName first, then email — first match wins.
    let existing: ContactRow | undefined;
    if (c.googleResourceName) {
      existing = this.db
        .prepare("SELECT * FROM contacts WHERE googleResourceName = ?")
        .get(c.googleResourceName) as ContactRow | undefined;
    }
    if (!existing && c.email) {
      existing = this.db.prepare("SELECT * FROM contacts WHERE email = ?").get(c.email) as
        | ContactRow
        | undefined;
    }

    // `|| ` (not `??`) on purpose: Contact's `id`/`createdAt` are typed as
    // required strings, so a caller that doesn't have one yet (a brand-new
    // contact) reaches for "" as the sentinel rather than omitting the key —
    // treat that the same as undefined/missing.
    const id = existing?.id || c.id || randomUUID();
    const now = new Date().toISOString();
    const createdAt = existing?.createdAt || c.createdAt || now;
    const tags = c.tags ? JSON.stringify(c.tags) : null;

    // INSERT .. ON CONFLICT(id) covers both the dedup-matched row above and a
    // direct edit (client round-trips the same id) — either way the primary
    // key collision drives the UPDATE branch, not a duplicate row.
    this.db
      .prepare(
        `INSERT INTO contacts (id, name, org, role, email, phone, met, what, angle, verdict, nextStep, tags, googleResourceName, googleEtag, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, org = excluded.org, role = excluded.role, email = excluded.email,
           phone = excluded.phone, met = excluded.met, what = excluded.what, angle = excluded.angle,
           verdict = excluded.verdict, nextStep = excluded.nextStep, tags = excluded.tags,
           googleResourceName = excluded.googleResourceName, googleEtag = excluded.googleEtag,
           createdAt = excluded.createdAt, updatedAt = excluded.updatedAt`,
      )
      .run(
        id,
        c.name,
        c.org ?? null,
        c.role ?? null,
        c.email ?? null,
        c.phone ?? null,
        c.met ?? null,
        c.what ?? null,
        c.angle ?? null,
        c.verdict ?? "none",
        c.nextStep ?? null,
        tags,
        c.googleResourceName ?? null,
        c.googleEtag ?? null,
        createdAt,
        now,
      );

    // Best-effort FTS reindex, same try/catch posture as migrate(): fts5 may
    // not exist on this Node build at all. A full rebuild (rather than a
    // delete+insert of just this row) sidesteps external-content fts5's
    // requirement that a 'delete' command supply the exact old indexed
    // values — simplest correct option at rolodex's personal-scale row counts.
    try {
      this.db.exec("INSERT INTO contacts_fts(contacts_fts) VALUES('rebuild')");
    } catch (err) {
      console.warn("rolodex: FTS reindex skipped (fts5 unavailable)", err);
    }

    return this.get(id)!;
  }

  get(id: string): Contact | undefined {
    const row = this.db.prepare("SELECT * FROM contacts WHERE id = ?").get(id);
    return row ? rowToContact(row) : undefined;
  }

  /** Deletes a contact and its interaction history. Explicit interactions
   * delete rather than relying on the schema's `ON DELETE CASCADE` — that
   * constraint is inert unless `PRAGMA foreign_keys = ON` is set, which this
   * class deliberately doesn't do (see the constructor's PRAGMA list); doing
   * the delete explicitly here avoids a global FK-enforcement change just for
   * this one method. Returns whether a contact was actually found and
   * deleted, so callers (the DELETE route) can tell a real delete apart from
   * a no-op on an already-gone/never-existed id. */
  delete(id: string): boolean {
    this.db.prepare("DELETE FROM interactions WHERE contactId = ?").run(id);
    const info = this.db.prepare("DELETE FROM contacts WHERE id = ?").run(id);

    try {
      this.db.exec("INSERT INTO contacts_fts(contacts_fts) VALUES('rebuild')");
    } catch (err) {
      console.warn("rolodex: FTS reindex skipped (fts5 unavailable)", err);
    }

    return info.changes > 0;
  }

  /**
   * Full-text across name/org/what/angle/tags. Tries FTS5 MATCH against
   * `contacts_fts` first (ranked via bm25); if that throws — fts5 unavailable
   * on this Node build, or the virtual table was never created (see migrate())
   * — falls back to a manual LIKE scan across the same documented fields so
   * search still works, just without ranking. Empty/whitespace-only queries
   * short-circuit to [] without touching the database.
   */
  search(query: string, opts?: { verdict?: Verdict; limit?: number }): SearchResult[] {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const limit = opts?.limit ?? 50;
    const verdict = opts?.verdict;

    try {
      // Each whitespace-separated token becomes a quoted prefix match
      // ("tok"*), ANDed together (FTS5's default for space-separated terms) —
      // this supports search-as-you-type (partial trailing word) while
      // keeping arbitrary punctuation in the query from being interpreted as
      // FTS5 query-syntax operators (quoting neutralizes that; embedded
      // quotes are doubled to escape them per FTS5 string-literal rules).
      const matchQuery = trimmed
        .split(/\s+/)
        .map((tok) => `"${tok.replace(/"/g, '""')}"*`)
        .join(" ");
      const verdictClause = verdict ? "AND c.verdict = ?" : "";
      const sql = `
        SELECT c.*, bm25(contacts_fts) AS rank
        FROM contacts_fts
        JOIN contacts c ON c.rowid = contacts_fts.rowid
        WHERE contacts_fts MATCH ? ${verdictClause}
        ORDER BY rank
        LIMIT ?
      `;
      const params: (string | number)[] = verdict ? [matchQuery, verdict, limit] : [matchQuery, limit];
      const rows = this.db.prepare(sql).all(...params);
      return rows.map((r) => ({ contact: rowToContact(r), score: Number((r as { rank: unknown }).rank) }));
    } catch (err) {
      // fts5 unavailable (CREATE VIRTUAL TABLE never ran in migrate(), so
      // contacts_fts doesn't exist — "no such table: contacts_fts" — or, on a
      // build where it exists but something else went wrong with the MATCH
      // query) — degrade to a LIKE scan across the same fields rather than
      // crash. No ranking; matches ordered by name.
      const escaped = trimmed.replace(/[%_\\]/g, (m) => `\\${m}`);
      const like = `%${escaped}%`;
      const verdictClause = verdict ? "AND verdict = ?" : "";
      const sql = `
        SELECT * FROM contacts
        WHERE (name LIKE ? ESCAPE '\\' OR org LIKE ? ESCAPE '\\' OR what LIKE ? ESCAPE '\\' OR angle LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')
        ${verdictClause}
        ORDER BY name COLLATE NOCASE
        LIMIT ?
      `;
      const params: (string | number)[] = verdict
        ? [like, like, like, like, like, verdict, limit]
        : [like, like, like, like, like, limit];
      const rows = this.db.prepare(sql).all(...params);
      return rows.map((r) => ({ contact: rowToContact(r) }));
    }
  }

  /** Generic settings read: returns the persisted value for `key`, or
   * `fallback` if no row exists yet. Never writes — callers that want
   * lazy-seed-on-first-read behavior (e.g. getFollowUpConfig()) do that
   * themselves on top of this. */
  getSetting(key: string, fallback: string): string {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row ? row.value : fallback;
  }

  /** Generic settings write: upserts `key` -> `value`. */
  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  /** Follow-up config, stored as one JSON-encoded settings row under
   * FOLLOW_UP_CONFIG_KEY. If no row exists yet (fresh DB, or a settings
   * table that's never had this key written), this lazily seeds the row
   * with the defaults (windowDays=30, graceDays=14) — NOT done eagerly in
   * migrate(), only on first read — and returns those same defaults. */
  getFollowUpConfig(): { windowDays: number; graceDays: number } {
    const raw = this.getSetting(FOLLOW_UP_CONFIG_KEY, "");
    if (!raw) {
      this.setFollowUpConfig(FOLLOW_UP_DEFAULTS);
      return { ...FOLLOW_UP_DEFAULTS };
    }
    return JSON.parse(raw) as { windowDays: number; graceDays: number };
  }

  setFollowUpConfig(cfg: { windowDays: number; graceDays: number }): void {
    this.setSetting(FOLLOW_UP_CONFIG_KEY, JSON.stringify(cfg));
  }

  /** Appearance config (theme/iconId), stored as one JSON-encoded settings
   * row under APPEARANCE_CONFIG_KEY. Lazily seeds APPEARANCE_DEFAULTS on
   * first read, same as getFollowUpConfig(). Validation of theme/iconId
   * values is the caller's responsibility (server.ts's route), matching how
   * setFollowUpConfig() also persists whatever it's given unchecked. */
  getAppearance(): AppearanceConfig {
    const raw = this.getSetting(APPEARANCE_CONFIG_KEY, "");
    if (!raw) {
      this.setAppearance(APPEARANCE_DEFAULTS);
      return { ...APPEARANCE_DEFAULTS };
    }
    return JSON.parse(raw) as AppearanceConfig;
  }

  setAppearance(cfg: AppearanceConfig): void {
    this.setSetting(APPEARANCE_CONFIG_KEY, JSON.stringify(cfg));
  }

  /**
   * Contacts with a nextStep set and no recent interaction — "don't let them
   * go cold". `withinDays`/`graceDays` default to the persisted
   * getFollowUpConfig() values when omitted.
   *
   * A contact qualifies when: nextStep is non-null/non-empty AND createdAt
   * is older than `graceDays` ago (so a contact just added today isn't
   * immediately flagged before anyone's had a chance to reach out) AND
   * either it has no interactions at all, or its most recent interaction's
   * `at` is older than `withinDays` ago.
   *
   * Implemented as a single query: a LEFT JOIN against a per-contact
   * MAX(at) subquery (grouped once, not one query per contact) rather than
   * a correlated subquery run per row — node:sqlite (SQLite proper) supports
   * both equally well, but the grouped-subquery join reads more directly as
   * "each contact's most recent interaction" and keeps the WHERE/ORDER BY
   * clauses simple boolean/string comparisons against a single `lastAt`
   * column instead of repeating the subquery in multiple places.
   *
   * ISO-8601 timestamps sort correctly as plain strings, so cutoffs are
   * computed in JS and compared with <=/>= rather than reaching for
   * SQLite's julianday()/datetime() functions.
   *
   * Sort: contacts with zero interactions ever rank above (more urgent
   * than) any contact with a real last-interaction date, regardless of how
   * old that date is; among contacts that do have interactions, oldest
   * last-interaction first. `(li.lastAt IS NULL)` evaluates to 1/0 in
   * SQLite, so ordering it DESC puts the "never touched" rows first.
   */
  needsFollowUp(withinDays?: number, graceDays?: number): Contact[] {
    const cfg = this.getFollowUpConfig();
    const effectiveWithinDays = withinDays ?? cfg.windowDays;
    const effectiveGraceDays = graceDays ?? cfg.graceDays;

    const now = Date.now();
    const graceCutoff = new Date(now - effectiveGraceDays * 86_400_000).toISOString();
    const withinCutoff = new Date(now - effectiveWithinDays * 86_400_000).toISOString();

    const rows = this.db
      .prepare(
        `SELECT c.* FROM contacts c
         LEFT JOIN (
           SELECT contactId, MAX(at) AS lastAt FROM interactions GROUP BY contactId
         ) li ON li.contactId = c.id
         WHERE c.nextStep IS NOT NULL AND TRIM(c.nextStep) <> ''
           AND c.createdAt <= ?
           AND (li.lastAt IS NULL OR li.lastAt <= ?)
         ORDER BY (li.lastAt IS NULL) DESC, li.lastAt ASC`,
      )
      .all(graceCutoff, withinCutoff);
    return rows.map(rowToContact);
  }

  setVerdict(id: string, v: Verdict): void {
    this.db
      .prepare("UPDATE contacts SET verdict = ?, updatedAt = ? WHERE id = ?")
      .run(v, new Date().toISOString(), id);
  }

  setNextStep(id: string, next: string): void {
    this.db
      .prepare("UPDATE contacts SET nextStep = ?, updatedAt = ? WHERE id = ?")
      .run(next, new Date().toISOString(), id);
  }
  /** Persists a logged touchpoint against a contact. `note` is required
   * (defensive re-check here even though callers — e.g. the shell's
   * log-interaction form — should already validate non-empty before this is
   * reached) and is trimmed before storage. */
  logInteraction(i: Interaction): void {
    const note = i.note?.trim();
    if (!note) {
      throw new Error("note is required");
    }
    const id = i.id || randomUUID();
    const at = i.at || new Date().toISOString();
    this.db
      .prepare(`INSERT INTO interactions (id, contactId, at, note, channel) VALUES (?, ?, ?, ?, ?)`)
      .run(id, i.contactId, at, note, i.channel ?? null);
  }

  /** Interaction history for one contact, most recent first. Not part of the
   * two methods this task's scope names explicitly (search/logInteraction),
   * but added because the paired server route (GET .../interactions) and the
   * "a subsequent query/list call returns it" test have no other way to read
   * back what logInteraction() persists without either reaching into Store's
   * private db from outside (which the module's own header comment rules
   * out: "nothing else writes raw SQL") or expanding logInteraction's return
   * type. Worth a second look if that tradeoff should go a different way. */
  listInteractions(contactId: string): Interaction[] {
    const rows = this.db
      .prepare("SELECT * FROM interactions WHERE contactId = ? ORDER BY at DESC, rowid DESC")
      .all(contactId);
    return rows.map(rowToInteraction);
  }
}

/** Exported so the shell (src/shell/db-location.ts) can resolve/display this
 * same default without duplicating the path logic — Store itself still only
 * ever consults ROLODEX_DB / its constructor arg, never wizard-local config. */
export function defaultDbPath(): string {
  const home = process.env.HOME ?? ".";
  return `${home}/.local/share/rolodex/rolodex.db`;
}

/**
 * Row shape as returned by node:sqlite for the `contacts` table (all columns
 * are TEXT/NULL at the SQLite layer; `tags` is stored as a JSON array string
 * — this is the convention `upsert()` (saf-02) must also follow).
 */
interface ContactRow {
  id: string;
  name: string;
  org: string | null;
  role: string | null;
  email: string | null;
  phone: string | null;
  met: string | null;
  what: string | null;
  angle: string | null;
  verdict: Verdict;
  nextStep: string | null;
  tags: string | null;
  googleResourceName: string | null;
  googleEtag: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Row shape as returned by node:sqlite for the `interactions` table. */
interface InteractionRow {
  id: string;
  contactId: string;
  at: string;
  note: string;
  channel: string | null;
}

function rowToInteraction(row: unknown): Interaction {
  const r = row as InteractionRow;
  return {
    id: r.id,
    contactId: r.contactId,
    at: r.at,
    note: r.note,
    channel: (r.channel ?? undefined) as Interaction["channel"],
  };
}

function rowToContact(row: unknown): Contact {
  const r = row as ContactRow;
  return {
    id: r.id,
    name: r.name,
    org: r.org ?? undefined,
    role: r.role ?? undefined,
    email: r.email ?? undefined,
    phone: r.phone ?? undefined,
    met: r.met ?? undefined,
    what: r.what ?? undefined,
    angle: r.angle ?? undefined,
    verdict: r.verdict,
    nextStep: r.nextStep ?? undefined,
    tags: r.tags ? (JSON.parse(r.tags) as string[]) : undefined,
    googleResourceName: r.googleResourceName ?? undefined,
    googleEtag: r.googleEtag ?? undefined,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}
