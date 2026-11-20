import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { Contact, Interaction, SearchResult, Verdict } from "./types.js";
import { LOCAL_SCOPE } from "./local-scope.js";
import {
  ScopeDenied,
  parseScope,
  resolveScopeSet,
  scopeClause,
  type ParsedScope,
  type ResolvedScopeSet,
  type ScopeSet,
} from "./scope.js";

export { ScopeDenied } from "./scope.js";
export type { Scope, ScopeSet } from "./scope.js";

/** The standalone scope's kind/id, used by migrate() to backfill v0.5 rows. */
const { kind: LOCAL_KIND, id: LOCAL_ID } = parseScope(LOCAL_SCOPE);

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

/** Settings-table key for per-scope Google sync state (connected account,
 * last pull/push). One row per scope, so each bound scope has its own. */
const GOOGLE_SYNC_STATE_KEY = "google.sync";

/** Per-scope Google sync state, stored JSON-encoded under
 * GOOGLE_SYNC_STATE_KEY in that scope's settings. */
export interface GoogleSyncState {
  /** The Google account this scope's sync is connected to, when known. */
  account?: string;
  lastPullAt?: string;
  lastPushAt?: string;
}

/**
 * Owns-your-data store. SQLite with an FTS5 full-text index so search is real
 * (name/org/what/angle/tags), not a LIKE scan. The DB path defaults to a
 * user-data dir OUTSIDE the repo (never ./data/) — set ROLODEX_DB to override.
 * All access goes through this module; nothing else writes raw SQL.
 *
 * Scopes (contacts-memory cm-02): every card belongs to exactly one scope
 * (`scopeKind`/`scopeId` columns) and every public method takes a ScopeSet
 * as its first argument. Contact rows are filtered in SQL through the single
 * `scopeClause()` helper (src/lib/scope.ts); interactions are reached only
 * through a join to their card, so they inherit its scope. Writes outside
 * the ScopeSet's `write` scope throw ScopeDenied. Settings are keyed per
 * scope. Cards never move between scopes.
 *
 * The standalone app always passes `{read:[user:local], write:user:local}`
 * via src/lib/local-scope.ts; `scoped()` binds a ScopeSet once and gives back
 * the scope-free method signatures the shell/MCP/CLI were written against.
 */
export class Store {
  private db: DatabaseSync;
  constructor(path = process.env.ROLODEX_DB ?? defaultDbPath()) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 4000;");
    this.migrate();
  }

  /** Binds `scope` once, returning the scope-free API (see ScopedStore). */
  scoped(scope: ScopeSet): ScopedStore {
    return new ScopedStore(this, scope);
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS contacts (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, org TEXT, role TEXT, email TEXT, phone TEXT,
        met TEXT, what TEXT, angle TEXT, verdict TEXT NOT NULL DEFAULT 'none',
        nextStep TEXT, tags TEXT, googleResourceName TEXT, googleEtag TEXT,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
        scopeKind TEXT NOT NULL, scopeId TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS interactions (
        id TEXT PRIMARY KEY, contactId TEXT NOT NULL, at TEXT NOT NULL, note TEXT NOT NULL, channel TEXT,
        FOREIGN KEY(contactId) REFERENCES contacts(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS settings (
        scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
        PRIMARY KEY (scope, key)
      );
    `);
    // SQLite has no `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` — a database
    // file created before a column existed needs these run once to reach
    // the shape the CREATE TABLE above already gives a brand-new database.
    // Catching specifically "duplicate column" (not a broad catch-all, per
    // this file's own convention below for fts5) keeps a genuine unrelated
    // failure from being silently swallowed here.
    //
    // scopeKind/scopeId (cm-02): a pre-scopes (v0.5) database's rows all
    // belong to the standalone book, so the NOT NULL DEFAULTs backfill every
    // existing row to `user:local` as part of the ALTER itself. New rows
    // always get an explicit scope from upsert().
    for (const ddl of [
      "ALTER TABLE contacts ADD COLUMN googleEtag TEXT",
      `ALTER TABLE contacts ADD COLUMN scopeKind TEXT NOT NULL DEFAULT '${LOCAL_KIND}'`,
      `ALTER TABLE contacts ADD COLUMN scopeId TEXT NOT NULL DEFAULT '${LOCAL_ID}'`,
    ]) {
      try {
        this.db.exec(ddl);
      } catch (err) {
        if (!(err instanceof Error) || !err.message.includes("duplicate column")) throw err;
      }
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS contacts_scope ON contacts(scopeKind, scopeId)");

    // settings (cm-02): v0.5 had `key TEXT PRIMARY KEY`. A key is now unique
    // per scope, which SQLite can only express by rebuilding the table.
    // Existing rows move to `user:local`. Idempotent: skipped once the
    // `scope` column exists (a fresh DB gets it from the CREATE above).
    const settingsCols = this.db.prepare("PRAGMA table_info(settings)").all() as { name: string }[];
    if (!settingsCols.some((c) => c.name === "scope")) {
      this.db.exec("BEGIN");
      try {
        this.db.exec(`
          CREATE TABLE settings_scoped (
            scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
            PRIMARY KEY (scope, key)
          );
          INSERT INTO settings_scoped (scope, key, value) SELECT '${LOCAL_SCOPE}', key, value FROM settings;
          DROP TABLE settings;
          ALTER TABLE settings_scoped RENAME TO settings;
        `);
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
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

  /** The scope a card id currently lives in, across ALL scopes, or undefined
   * if no such card exists. This is the one deliberate unscoped read: write
   * paths must load a row before touching it so that a caller-supplied id
   * from another scope is refused instead of updated (grill H6). It never
   * returns row data, only the owning scope, and is private. */
  private ownerOf(id: string): ParsedScope | undefined {
    // scope-check: unscoped by design (see doc comment above).
    const row = this.db.prepare("SELECT scopeKind, scopeId FROM contacts WHERE id = ?").get(id) as
      | { scopeKind: string; scopeId: string }
      | undefined;
    return row ? { kind: row.scopeKind as ParsedScope["kind"], id: row.scopeId } : undefined;
  }

  /** The write scope, or ScopeDenied when the ScopeSet has none. */
  private requireWrite(r: ResolvedScopeSet): ParsedScope {
    if (!r.write) throw new ScopeDenied("this ScopeSet has no write scope");
    return r.write;
  }

  /** Checks a write against an existing card: "missing" when no card has
   * this id anywhere, "ok" when it is in the write scope, ScopeDenied
   * otherwise (including when there is no write scope at all). */
  private checkWritable(r: ResolvedScopeSet, id: string): "missing" | "ok" {
    const owner = this.ownerOf(id);
    if (!owner) return "missing";
    const w = this.requireWrite(r);
    if (owner.kind !== w.kind || owner.id !== w.id) throw new ScopeDenied("card is outside the write scope");
    return "ok";
  }

  /** The scope settings are read from/written to: the write scope, or the
   * sole readable scope of a single-scope read-only set. Undefined when the
   * set spans several scopes with no write scope — there is no single book
   * whose settings would apply. */
  private settingsScope(r: ResolvedScopeSet): string | undefined {
    const s = r.write ?? (r.readable.length === 1 ? r.readable[0] : undefined);
    return s ? `${s.kind}:${s.id}` : undefined;
  }

  private reindex() {
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
  }

  /** All contacts in the readable scopes. Minimal read used by the shell's
   * list screen. */
  list(scope: ScopeSet): Contact[] {
    const r = resolveScopeSet(scope);
    const where = scopeClause(r.readable);
    const rows = this.db
      .prepare(`SELECT * FROM contacts WHERE ${where.sql} ORDER BY name COLLATE NOCASE`)
      .all(...where.params);
    return rows.map(rowToContact);
  }

  /**
   * Creates or updates a card in the write scope.
   *
   * - A supplied `id` is loaded first, across all scopes: if that card lives
   *   in another scope, ScopeDenied is thrown and nothing changes (H6).
   * - Dedup, WITHIN the write scope only, first match wins:
   *   googleResourceName, then normalized email (trim + lowercase), then
   *   phone digits (see normalizePhone).
   * - New cards land in the write scope; existing cards never change scope
   *   (the scope columns are not in the UPDATE list, and the conflict branch
   *   refuses a row whose scope differs, as a second line of defence).
   */
  upsert(scope: ScopeSet, c: Contact): Contact {
    const r = resolveScopeSet(scope);
    const w = this.requireWrite(r);
    if (c.id) this.checkWritable(r, c.id);

    const own = scopeClause([w]);
    let existing: ContactRow | undefined;
    if (c.googleResourceName) {
      existing = this.db
        .prepare(`SELECT * FROM contacts WHERE googleResourceName = ? AND ${own.sql}`)
        .get(c.googleResourceName, ...own.params) as ContactRow | undefined;
    }
    const email = normalizeEmail(c.email);
    if (!existing && email) {
      existing = this.db
        .prepare(`SELECT * FROM contacts WHERE LOWER(TRIM(email)) = ? AND ${own.sql} ORDER BY rowid LIMIT 1`)
        .get(email, ...own.params) as ContactRow | undefined;
    }
    const phone = normalizePhone(c.phone);
    if (!existing && phone) {
      // Digit-normalization isn't expressible in portable SQLite without a
      // user-defined function (node:sqlite's db.function() is newer than this
      // repo's minimum Node), so candidates are narrowed in SQL to the write
      // scope and compared here.
      const candidates = this.db
        .prepare(`SELECT * FROM contacts WHERE phone IS NOT NULL AND ${own.sql} ORDER BY rowid`)
        .all(...own.params) as unknown as ContactRow[];
      existing = candidates.find((row) => normalizePhone(row.phone) === phone);
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
    // key collision drives the UPDATE branch, not a duplicate row. The
    // `WHERE` on the UPDATE branch refuses to touch a row in another scope.
    const info = this.db
      .prepare(
        `INSERT INTO contacts (id, name, org, role, email, phone, met, what, angle, verdict, nextStep, tags, googleResourceName, googleEtag, createdAt, updatedAt, scopeKind, scopeId)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, org = excluded.org, role = excluded.role, email = excluded.email,
           phone = excluded.phone, met = excluded.met, what = excluded.what, angle = excluded.angle,
           verdict = excluded.verdict, nextStep = excluded.nextStep, tags = excluded.tags,
           googleResourceName = excluded.googleResourceName, googleEtag = excluded.googleEtag,
           createdAt = excluded.createdAt, updatedAt = excluded.updatedAt
         WHERE contacts.scopeKind = excluded.scopeKind AND contacts.scopeId = excluded.scopeId`,
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
        w.kind,
        w.id,
      );
    if (Number(info.changes) === 0) throw new ScopeDenied("card is outside the write scope");

    this.reindex();
    return this.get(scope, id)!;
  }

  get(scope: ScopeSet, id: string): Contact | undefined {
    const r = resolveScopeSet(scope);
    const where = scopeClause(r.readable);
    const row = this.db.prepare(`SELECT * FROM contacts WHERE id = ? AND ${where.sql}`).get(id, ...where.params);
    return row ? rowToContact(row) : undefined;
  }

  /** Deletes a card and its interaction history (and, once cm-03 lands,
   * every link touching it — H9). Explicit interactions delete rather than
   * relying on the schema's `ON DELETE CASCADE` — that constraint is inert
   * unless `PRAGMA foreign_keys = ON` is set, which this class deliberately
   * doesn't do (see the constructor's PRAGMA list). Returns false when no
   * card with this id exists; throws ScopeDenied when it exists outside the
   * write scope. */
  delete(scope: ScopeSet, id: string): boolean {
    const r = resolveScopeSet(scope);
    if (this.checkWritable(r, id) === "missing") return false;
    const own = scopeClause([this.requireWrite(r)]);
    this.db
      .prepare(`DELETE FROM interactions WHERE contactId IN (SELECT id FROM contacts WHERE id = ? AND ${own.sql})`)
      .run(id, ...own.params);
    const info = this.db.prepare(`DELETE FROM contacts WHERE id = ? AND ${own.sql}`).run(id, ...own.params);
    this.reindex();
    return Number(info.changes) > 0;
  }

  /**
   * Full-text across name/org/what/angle/tags, limited to readable scopes.
   * Tries FTS5 MATCH against `contacts_fts` first (ranked via bm25) joined
   * back to `contacts` so the scope clause applies; if that throws — fts5
   * unavailable on this Node build, or the virtual table was never created
   * (see migrate()) — falls back to a manual LIKE scan across the same
   * documented fields, with the same scope clause. Empty/whitespace-only
   * queries short-circuit to [] without touching the database.
   */
  search(scope: ScopeSet, query: string, opts?: { verdict?: Verdict; limit?: number }): SearchResult[] {
    const r = resolveScopeSet(scope);
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
      const where = scopeClause(r.readable, "c");
      const verdictClause = verdict ? "AND c.verdict = ?" : "";
      const sql = `
        SELECT c.*, bm25(contacts_fts) AS rank
        FROM contacts_fts
        JOIN contacts c ON c.rowid = contacts_fts.rowid
        WHERE contacts_fts MATCH ? AND ${where.sql} ${verdictClause}
        ORDER BY rank
        LIMIT ?
      `;
      const params: (string | number)[] = [matchQuery, ...where.params, ...(verdict ? [verdict] : []), limit];
      const rows = this.db.prepare(sql).all(...params);
      return rows.map((row) => ({ contact: rowToContact(row), score: Number((row as { rank: unknown }).rank) }));
    } catch (err) {
      // fts5 unavailable (CREATE VIRTUAL TABLE never ran in migrate(), so
      // contacts_fts doesn't exist — "no such table: contacts_fts" — or, on a
      // build where it exists but something else went wrong with the MATCH
      // query) — degrade to a LIKE scan across the same fields rather than
      // crash. No ranking; matches ordered by name.
      const escaped = trimmed.replace(/[%_\\]/g, (m) => `\\${m}`);
      const like = `%${escaped}%`;
      const where = scopeClause(r.readable);
      const verdictClause = verdict ? "AND verdict = ?" : "";
      const sql = `
        SELECT * FROM contacts
        WHERE (name LIKE ? ESCAPE '\\' OR org LIKE ? ESCAPE '\\' OR what LIKE ? ESCAPE '\\' OR angle LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')
        AND ${where.sql}
        ${verdictClause}
        ORDER BY name COLLATE NOCASE
        LIMIT ?
      `;
      const params: (string | number)[] = [like, like, like, like, like, ...where.params, ...(verdict ? [verdict] : []), limit];
      const rows = this.db.prepare(sql).all(...params);
      return rows.map((row) => ({ contact: rowToContact(row) }));
    }
  }

  /** Generic settings read for the ScopeSet's settings scope (its write
   * scope, or its only readable scope): returns the persisted value for
   * `key`, or `fallback` if no row exists yet or the set has no single
   * settings scope. Never writes — callers that want lazy-seed-on-first-read
   * behavior (e.g. getFollowUpConfig()) do that themselves on top of this. */
  getSetting(scope: ScopeSet, key: string, fallback: string): string {
    const s = this.settingsScope(resolveScopeSet(scope));
    if (!s) return fallback;
    const row = this.db.prepare("SELECT value FROM settings WHERE scope = ? AND key = ?").get(s, key) as
      | { value: string }
      | undefined;
    return row ? row.value : fallback;
  }

  /** Generic settings write: upserts `key` -> `value` in the write scope's
   * settings. ScopeDenied without a write scope. */
  setSetting(scope: ScopeSet, key: string, value: string): void {
    const w = this.requireWrite(resolveScopeSet(scope));
    this.db
      .prepare(
        `INSERT INTO settings (scope, key, value) VALUES (?, ?, ?)
         ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
      )
      .run(`${w.kind}:${w.id}`, key, value);
  }

  /** Follow-up config, stored as one JSON-encoded settings row under
   * FOLLOW_UP_CONFIG_KEY in the settings scope. If no row exists yet, this
   * lazily seeds the row with the defaults (windowDays=30, graceDays=14) —
   * NOT done eagerly in migrate(), only on first read, and only when the
   * set can write — and returns those same defaults. */
  getFollowUpConfig(scope: ScopeSet): { windowDays: number; graceDays: number } {
    const raw = this.getSetting(scope, FOLLOW_UP_CONFIG_KEY, "");
    if (!raw) {
      if (scope.write !== undefined) this.setFollowUpConfig(scope, FOLLOW_UP_DEFAULTS);
      return { ...FOLLOW_UP_DEFAULTS };
    }
    return JSON.parse(raw) as { windowDays: number; graceDays: number };
  }

  setFollowUpConfig(scope: ScopeSet, cfg: { windowDays: number; graceDays: number }): void {
    this.setSetting(scope, FOLLOW_UP_CONFIG_KEY, JSON.stringify(cfg));
  }

  /** Appearance config (theme/iconId), stored as one JSON-encoded settings
   * row under APPEARANCE_CONFIG_KEY. Lazily seeds APPEARANCE_DEFAULTS on
   * first read, same as getFollowUpConfig(). Validation of theme/iconId
   * values is the caller's responsibility (server.ts's route), matching how
   * setFollowUpConfig() also persists whatever it's given unchecked. */
  getAppearance(scope: ScopeSet): AppearanceConfig {
    const raw = this.getSetting(scope, APPEARANCE_CONFIG_KEY, "");
    if (!raw) {
      if (scope.write !== undefined) this.setAppearance(scope, APPEARANCE_DEFAULTS);
      return { ...APPEARANCE_DEFAULTS };
    }
    return JSON.parse(raw) as AppearanceConfig;
  }

  setAppearance(scope: ScopeSet, cfg: AppearanceConfig): void {
    this.setSetting(scope, APPEARANCE_CONFIG_KEY, JSON.stringify(cfg));
  }

  /** Google sync state of the settings scope (H8): which account it is
   * connected to and when it last pulled/pushed. Empty object if never
   * synced. */
  getGoogleSyncState(scope: ScopeSet): GoogleSyncState {
    const raw = this.getSetting(scope, GOOGLE_SYNC_STATE_KEY, "");
    return raw ? (JSON.parse(raw) as GoogleSyncState) : {};
  }

  /** Merges `patch` into the write scope's Google sync state. */
  updateGoogleSyncState(scope: ScopeSet, patch: GoogleSyncState): GoogleSyncState {
    const next = { ...this.getGoogleSyncState({ read: [], write: scope.write }), ...patch };
    this.setSetting(scope, GOOGLE_SYNC_STATE_KEY, JSON.stringify(next));
    return next;
  }

  /**
   * Contacts in the readable scopes with a nextStep set and no recent
   * interaction — "don't let them go cold". `withinDays`/`graceDays`
   * default to the persisted getFollowUpConfig() values when omitted.
   *
   * A contact qualifies when: nextStep is non-null/non-empty AND createdAt
   * is older than `graceDays` ago (so a contact just added today isn't
   * immediately flagged before anyone's had a chance to reach out) AND
   * either it has no interactions at all, or its most recent interaction's
   * `at` is older than `withinDays` ago.
   *
   * Implemented as a single query: a LEFT JOIN against a per-contact
   * MAX(at) subquery (grouped once, not one query per contact) rather than
   * a correlated subquery run per row. The scope clause applies to the
   * outer contacts row; interactions are only reached through it.
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
  needsFollowUp(scope: ScopeSet, withinDays?: number, graceDays?: number): Contact[] {
    const r = resolveScopeSet(scope);
    const cfg = this.getFollowUpConfig(scope);
    const effectiveWithinDays = withinDays ?? cfg.windowDays;
    const effectiveGraceDays = graceDays ?? cfg.graceDays;

    const now = Date.now();
    const graceCutoff = new Date(now - effectiveGraceDays * 86_400_000).toISOString();
    const withinCutoff = new Date(now - effectiveWithinDays * 86_400_000).toISOString();

    const where = scopeClause(r.readable, "c");
    const rows = this.db
      .prepare(
        `SELECT c.* FROM contacts c
         LEFT JOIN (
           SELECT contactId, MAX(at) AS lastAt FROM interactions GROUP BY contactId
         ) li ON li.contactId = c.id
         WHERE ${where.sql}
           AND c.nextStep IS NOT NULL AND TRIM(c.nextStep) <> ''
           AND c.createdAt <= ?
           AND (li.lastAt IS NULL OR li.lastAt <= ?)
         ORDER BY (li.lastAt IS NULL) DESC, li.lastAt ASC`,
      )
      .all(...where.params, graceCutoff, withinCutoff);
    return rows.map(rowToContact);
  }

  /** No-op for an unknown id (as before scopes); ScopeDenied for a card
   * outside the write scope. */
  setVerdict(scope: ScopeSet, id: string, v: Verdict): void {
    this.updateField(scope, id, "verdict", v);
  }

  setNextStep(scope: ScopeSet, id: string, next: string): void {
    this.updateField(scope, id, "nextStep", next);
  }

  private updateField(scope: ScopeSet, id: string, column: "verdict" | "nextStep", value: string): void {
    const r = resolveScopeSet(scope);
    if (this.checkWritable(r, id) === "missing") return;
    const own = scopeClause([this.requireWrite(r)]);
    this.db
      .prepare(`UPDATE contacts SET ${column} = ?, updatedAt = ? WHERE id = ? AND ${own.sql}`)
      .run(value, new Date().toISOString(), id, ...own.params);
  }

  /** Persists a logged touchpoint against a card. Interactions belong to
   * their card's scope, so the card must exist in the write scope
   * (ScopeDenied otherwise). `note` is required (defensive re-check here
   * even though callers — e.g. the shell's log-interaction form — should
   * already validate non-empty before this is reached) and is trimmed
   * before storage. */
  logInteraction(scope: ScopeSet, i: Interaction): void {
    const note = i.note?.trim();
    if (!note) {
      throw new Error("note is required");
    }
    const r = resolveScopeSet(scope);
    if (this.checkWritable(r, i.contactId) === "missing") {
      throw new ScopeDenied("interaction's card is not in the write scope");
    }
    const id = i.id || randomUUID();
    const at = i.at || new Date().toISOString();
    this.db
      .prepare(`INSERT INTO interactions (id, contactId, at, note, channel) VALUES (?, ?, ?, ?, ?)`)
      .run(id, i.contactId, at, note, i.channel ?? null);
  }

  /** Interaction history for one card in the readable scopes, most recent
   * first. Empty when the card is not readable. */
  listInteractions(scope: ScopeSet, contactId: string): Interaction[] {
    const r = resolveScopeSet(scope);
    const where = scopeClause(r.readable, "c");
    const rows = this.db
      .prepare(
        `SELECT i.* FROM interactions i JOIN contacts c ON c.id = i.contactId
         WHERE i.contactId = ? AND ${where.sql}
         ORDER BY i.at DESC, i.rowid DESC`,
      )
      .all(contactId, ...where.params);
    return rows.map(rowToInteraction);
  }
}

/**
 * A Store with one ScopeSet bound: the scope-free method signatures the
 * standalone shell, MCP server, CLI and Google sync helpers call. Every
 * method forwards to the Store method of the same name with the bound
 * ScopeSet, so enforcement still happens in Store's SQL.
 */
export class ScopedStore {
  constructor(
    private readonly store: Store,
    readonly scope: ScopeSet,
  ) {}

  /** The binding Google sync must use (H8): read and write limited to this
   * binding's write scope, so a pull matches and a push sends only the
   * scope the Google account is bound to. ScopeDenied without a write
   * scope. */
  forSync(): ScopedStore {
    if (this.scope.write === undefined) throw new ScopeDenied("Google sync needs a write scope");
    return new ScopedStore(this.store, { read: [this.scope.write], write: this.scope.write });
  }

  list(): Contact[] {
    return this.store.list(this.scope);
  }
  upsert(c: Contact): Contact {
    return this.store.upsert(this.scope, c);
  }
  get(id: string): Contact | undefined {
    return this.store.get(this.scope, id);
  }
  delete(id: string): boolean {
    return this.store.delete(this.scope, id);
  }
  search(query: string, opts?: { verdict?: Verdict; limit?: number }): SearchResult[] {
    return this.store.search(this.scope, query, opts);
  }
  getSetting(key: string, fallback: string): string {
    return this.store.getSetting(this.scope, key, fallback);
  }
  setSetting(key: string, value: string): void {
    this.store.setSetting(this.scope, key, value);
  }
  getFollowUpConfig(): { windowDays: number; graceDays: number } {
    return this.store.getFollowUpConfig(this.scope);
  }
  setFollowUpConfig(cfg: { windowDays: number; graceDays: number }): void {
    this.store.setFollowUpConfig(this.scope, cfg);
  }
  getAppearance(): AppearanceConfig {
    return this.store.getAppearance(this.scope);
  }
  setAppearance(cfg: AppearanceConfig): void {
    this.store.setAppearance(this.scope, cfg);
  }
  getGoogleSyncState(): GoogleSyncState {
    return this.store.getGoogleSyncState(this.scope);
  }
  updateGoogleSyncState(patch: GoogleSyncState): GoogleSyncState {
    return this.store.updateGoogleSyncState(this.scope, patch);
  }
  needsFollowUp(withinDays?: number, graceDays?: number): Contact[] {
    return this.store.needsFollowUp(this.scope, withinDays, graceDays);
  }
  setVerdict(id: string, v: Verdict): void {
    this.store.setVerdict(this.scope, id, v);
  }
  setNextStep(id: string, next: string): void {
    this.store.setNextStep(this.scope, id, next);
  }
  logInteraction(i: Interaction): void {
    this.store.logInteraction(this.scope, i);
  }
  listInteractions(contactId: string): Interaction[] {
    return this.store.listInteractions(this.scope, contactId);
  }
}

/** Email dedup key: trimmed, lowercased; undefined when blank. */
export function normalizeEmail(email: string | null | undefined): string | undefined {
  const e = email?.trim().toLowerCase();
  return e ? e : undefined;
}

/** Phone dedup key, "E.164-ish": digits only, with an international `00`
 * prefix treated like `+`. Fewer than 7 digits is too short to be a
 * meaningful match key, so it yields undefined (no phone dedup). */
export function normalizePhone(phone: string | null | undefined): string | undefined {
  if (!phone) return undefined;
  let digits = phone.replace(/\D/g, "");
  if (!phone.trim().startsWith("+") && digits.startsWith("00")) digits = digits.slice(2);
  return digits.length >= 7 ? digits : undefined;
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
  scopeKind: string;
  scopeId: string;
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
