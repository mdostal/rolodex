import { DatabaseSync } from "node:sqlite";
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
      CREATE VIRTUAL TABLE IF NOT EXISTS contacts_fts USING fts5(
        id UNINDEXED, name, org, role, what, angle, tags, content='contacts', content_rowid='rowid'
      );
    `);
  }

  upsert(c: Contact): Contact {
    // TODO(build): dedup against googleResourceName + email before insert.
    // Preserve createdAt on update; refresh updatedAt; reindex FTS row.
    throw new Error("not implemented — upsert contact + FTS reindex");
  }

  get(id: string): Contact | undefined { throw new Error("not implemented"); }

  /** Full-text across name/org/what/angle/tags. */
  search(_query: string, _opts?: { verdict?: Verdict; limit?: number }): SearchResult[] {
    throw new Error("not implemented — FTS5 MATCH query");
  }

  /** Contacts with a nextStep set and no recent interaction — "don't let them go cold". */
  needsFollowUp(_withinDays = 30): Contact[] { throw new Error("not implemented"); }

  setVerdict(_id: string, _v: Verdict): void { throw new Error("not implemented"); }
  setNextStep(_id: string, _next: string): void { throw new Error("not implemented"); }
  logInteraction(_i: Interaction): void { throw new Error("not implemented"); }
}

function defaultDbPath(): string {
  const home = process.env.HOME ?? ".";
  return `${home}/.local/share/rolodex/rolodex.db`;
}
