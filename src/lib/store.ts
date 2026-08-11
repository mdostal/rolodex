import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { Contact, Interaction, SearchResult, Verdict } from "./types.js";

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
        nextStep TEXT, tags TEXT, googleResourceName TEXT,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS interactions (
        id TEXT PRIMARY KEY, contactId TEXT NOT NULL, at TEXT NOT NULL, note TEXT NOT NULL, channel TEXT,
        FOREIGN KEY(contactId) REFERENCES contacts(id) ON DELETE CASCADE
      );
    `);
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
        `INSERT INTO contacts (id, name, org, role, email, phone, met, what, angle, verdict, nextStep, tags, googleResourceName, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, org = excluded.org, role = excluded.role, email = excluded.email,
           phone = excluded.phone, met = excluded.met, what = excluded.what, angle = excluded.angle,
           verdict = excluded.verdict, nextStep = excluded.nextStep, tags = excluded.tags,
           googleResourceName = excluded.googleResourceName, createdAt = excluded.createdAt, updatedAt = excluded.updatedAt`,
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

  /** Full-text across name/org/what/angle/tags. */
  search(_query: string, _opts?: { verdict?: Verdict; limit?: number }): SearchResult[] {
    throw new Error("not implemented — FTS5 MATCH query");
  }

  /** Contacts with a nextStep set and no recent interaction — "don't let them go cold". */
  needsFollowUp(_withinDays = 30): Contact[] { throw new Error("not implemented"); }

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
  logInteraction(_i: Interaction): void { throw new Error("not implemented"); }
}

function defaultDbPath(): string {
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
  createdAt: string;
  updatedAt: string;
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
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}
