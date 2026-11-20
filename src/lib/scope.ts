// Scope model for the Rolodex Store (contacts-memory cm-02).
//
// Every contact card belongs to exactly one scope, written `kind:id`. The
// shape mirrors the host contract (mdostal/pantheon-v2
// contracts/l2/slots/contacts.ts, cm-01) but is deliberately duplicated here:
// rolodex never imports Pantheon code.

/** Scope kinds. Extensible: add a member here and every parser/validator
 * below picks it up. */
export const ScopeKind = {
  /** A host client's book (Pantheon's "workspace"). */
  Client: "client",
  /** A person's own book. The standalone app's only scope is `user:local`. */
  User: "user",
} as const;
export type ScopeKind = (typeof ScopeKind)[keyof typeof ScopeKind];

/** `kind:id`, e.g. `user:local`, `client:acme`. */
export type Scope = `${ScopeKind}:${string}`;

/** What a caller may touch. `read` scopes are visible; `write` (at most one)
 * is the scope new cards land in and the only scope that may be mutated.
 * The write scope is always readable too, even if `read` omits it — writing
 * a card you could not read back would make upsert()'s return value a lie. */
export interface ScopeSet {
  read: readonly Scope[];
  write?: Scope;
}

/** Thrown when a write targets a card (or settings) outside the caller's
 * write scope, or when a write is attempted with no write scope at all. */
export class ScopeDenied extends Error {
  constructor(message = "scope denied") {
    super(message);
    this.name = "ScopeDenied";
  }
}

/** Thrown when a referenced card or link is not visible to the caller. It is
 * deliberately the same error, with the same message, whether the thing is
 * missing or merely unreadable, so a caller cannot probe for existence
 * (contacts-memory cm-03). */
export class NotFound extends Error {
  constructor(message = "not found") {
    super(message);
    this.name = "NotFound";
  }
}

const KINDS: ReadonlySet<string> = new Set(Object.values(ScopeKind));

export interface ParsedScope {
  kind: ScopeKind;
  id: string;
}

/** Parses `kind:id` (split at the FIRST colon, so ids may contain colons).
 * Throws on an unknown kind or an empty id — a malformed scope must never
 * silently widen or narrow what a query sees. */
export function parseScope(scope: string): ParsedScope {
  const i = scope.indexOf(":");
  const kind = i < 0 ? "" : scope.slice(0, i);
  const id = i < 0 ? "" : scope.slice(i + 1);
  if (!KINDS.has(kind) || !id) {
    throw new Error(`invalid scope ${JSON.stringify(scope)}: expected one of ${[...KINDS].join("|")}:<id>`);
  }
  return { kind: kind as ScopeKind, id };
}

export function isScope(value: unknown): value is Scope {
  if (typeof value !== "string") return false;
  try {
    parseScope(value);
    return true;
  } catch {
    return false;
  }
}

export function formatScope(kind: ScopeKind, id: string): Scope {
  const s = `${kind}:${id}`;
  parseScope(s);
  return s as Scope;
}

/** A ScopeSet after validation: parsed, de-duplicated readable scopes (write
 * included) and the parsed write scope, if any. */
export interface ResolvedScopeSet {
  readable: ParsedScope[];
  write?: ParsedScope;
}

export function resolveScopeSet(set: ScopeSet): ResolvedScopeSet {
  if (!set || !Array.isArray(set.read)) throw new Error("ScopeSet.read must be an array of scopes");
  const write = set.write !== undefined ? parseScope(set.write) : undefined;
  const seen = new Set<string>();
  const readable: ParsedScope[] = [];
  for (const s of write ? [...set.read, set.write as string] : set.read) {
    const p = parseScope(s);
    const key = `${p.kind}:${p.id}`;
    if (!seen.has(key)) {
      seen.add(key);
      readable.push(p);
    }
  }
  return { readable, write };
}

/**
 * THE scope filter. Every Store query that touches contacts (and, through a
 * join, interactions) builds its WHERE clause from this one helper, so there
 * is exactly one place where "which rows may this caller see/touch" is
 * turned into SQL. An empty scope list yields a clause that matches nothing.
 *
 * `alias` is the table alias in the surrounding query ("" for none).
 * `columns` names the scope columns: contacts' `scopeKind`/`scopeId` by
 * default, or e.g. links' `assertedInKind`/`assertedInId` (cm-03).
 */
export function scopeClause(
  scopes: readonly ParsedScope[],
  alias = "",
  columns: { kind: string; id: string } = { kind: "scopeKind", id: "scopeId" },
): { sql: string; params: string[] } {
  if (scopes.length === 0) return { sql: "(0)", params: [] };
  const col = alias ? `${alias}.` : "";
  const sql = scopes.map(() => `(${col}${columns.kind} = ? AND ${col}${columns.id} = ?)`).join(" OR ");
  const params = scopes.flatMap((s) => [s.kind, s.id]);
  return { sql: `(${sql})`, params };
}
