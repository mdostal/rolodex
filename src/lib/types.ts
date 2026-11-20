// Core domain types for the rolodex. One place; everything imports from here.

import type { Scope } from "./scope.js";

/** How you rate a contact's partnering/relationship potential. */
export type Verdict = "strong" | "watch" | "referral-only" | "pass" | "none";

/** A person in the rolodex. */
export interface Contact {
  id: string;                 // stable id (uuid or google resourceName)
  name: string;
  org?: string;
  role?: string;
  email?: string;
  phone?: string;
  /** how + when you met them */
  met?: string;
  /** what they do / capability */
  what?: string;
  /** the specific partnership/relationship angle */
  angle?: string;
  verdict: Verdict;
  /** the ONE next step, so nobody good goes cold */
  nextStep?: string;
  tags?: string[];
  /** external source id, e.g. Google People `resourceName`, for sync/dedup */
  googleResourceName?: string;
  /** The People API's per-person `metadata.sources[].etag` from the last
   * pull() of this contact — required by push()'s updateContact call for
   * Google's own optimistic-concurrency check (a stale etag is rejected
   * with 400 failedPrecondition, the real conflict-detection mechanism;
   * see the google-two-way-sync epic's design discussion). Unset for
   * local-only contacts that have never been pulled from/pushed to Google. */
  googleEtag?: string;
  createdAt: string;          // ISO
  updatedAt: string;          // ISO
}

/** A logged touch: call, email, note. */
export interface Interaction {
  id: string;
  contactId: string;
  at: string;                 // ISO date of the interaction
  note: string;
  channel?: "call" | "email" | "dm" | "meeting" | "other";
}

/** What the MCP layer returns for a search hit. */
export interface SearchResult {
  contact: Contact;
  snippet?: string;           // matched text
  score?: number;
}

/** Link predicates (contacts-memory cm-03). `same_as`, `knows` and
 * `colleague` are symmetric; the rest read "from <predicate> to". */
export type LinkPredicate = "same_as" | "knows" | "introduced" | "works_at" | "reports_to" | "colleague";

/** A connection between two cards (or a card and an org), possibly across
 * scopes. Visible only when the caller can read `assertedIn` AND both
 * endpoint cards' scopes; otherwise the Store omits it entirely. */
export interface Link {
  id: string;
  fromContactId: string;
  /** Set for card-to-card links; exactly one of toContactId/toOrg is set. */
  toContactId?: string;
  /** Normalized org name (see normalizeOrg); only for `works_at`. */
  toOrg?: string;
  predicate: LinkPredicate;
  note?: string;
  /** The scope this link was asserted in (`kind:id`). */
  assertedIn: Scope;
  createdAt: string;          // ISO
  createdBy?: string;
}

/** One card reached by Store.connections(): its hop count from the start
 * card and the visible links walked to reach it (path.length === depth). */
export interface ConnectionHit {
  contact: Contact;
  depth: number;
  path: Link[];
}

/** A possible same_as match from Store.candidates(), with why it matched. */
export interface LinkCandidate {
  contact: Contact;
  reasons: Array<"email" | "phone" | "name+org">;
}
