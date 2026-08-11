// Core domain types for the rolodex. One place; everything imports from here.

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
