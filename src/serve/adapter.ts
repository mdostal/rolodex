import type { Scope as LocalScope, ScopeSet as LocalScopeSet } from "../lib/scope.js";
import type { Store } from "../lib/store.js";
import type { CandidatePair, Contact as LocalContact, Interaction as LocalInteraction, Link as LocalLink } from "../lib/types.js";
import type {
  Candidate,
  Contact,
  ContactsOperation,
  Followup,
  Interaction,
  Link,
  Scope,
  ScopeSet,
  Verdict,
} from "./contract.js";

/**
 * Maps the host's contacts contract onto rolodex's Store (cm-04).
 *
 * The ScopeSet each call carries is handed to the Store as-is (converted
 * from the contract's `{kind,id}` objects to rolodex's `kind:id` strings).
 * This layer never widens, narrows or second-guesses it: who may see what
 * is decided by core-api, which signs the scopes; rolodex only enforces
 * whatever set it is given (grill U1, see docs/ARCHITECTURE.md).
 *
 * Field mapping (contract ↔ rolodex card):
 *   title ↔ role, notes ↔ what, emails[0] ↔ email, phones[0] ↔ phone.
 * A rolodex card holds one email and one phone, so an upsert with more than
 * one of either is refused (400) rather than silently dropping data.
 * Rolodex-only fields (met, angle, verdict, nextStep, Google ids) are never
 * touched by an upsert; a field the request leaves out keeps its value.
 */

/** A request the contract allows but this implementation refuses (400). */
export class BadRequest extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadRequest";
  }
}

const toLocalScope = (s: Scope): LocalScope => `${s.kind}:${s.id}` as LocalScope;

function toWireScope(s: string): Scope {
  const i = s.indexOf(":");
  return { kind: s.slice(0, i) as Scope["kind"], id: s.slice(i + 1) };
}

export function toLocalScopeSet(s: ScopeSet): LocalScopeSet {
  return { read: s.read.map(toLocalScope), ...(s.write ? { write: toLocalScope(s.write) } : {}) };
}

function contactOut(c: LocalContact, scope: string): Contact {
  return {
    id: c.id,
    name: c.name,
    emails: c.email ? [c.email] : [],
    phones: c.phone ? [c.phone] : [],
    ...(c.org ? { org: c.org } : {}),
    ...(c.role ? { title: c.role } : {}),
    ...(c.what !== undefined && c.what !== null ? { notes: c.what } : {}),
    tags: c.tags ?? [],
    scope: toWireScope(scope),
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

function interactionOut(i: LocalInteraction, scope: string): Interaction {
  return {
    id: i.id,
    contactId: i.contactId,
    at: i.at,
    channel: i.channel || "other",
    summary: i.note,
    scope: toWireScope(scope),
    ...(i.followUpAt ? { followUpAt: i.followUpAt } : {}),
  };
}

function linkOut(l: LocalLink): Link {
  return {
    id: l.id,
    from: l.fromContactId,
    predicate: l.predicate,
    ...(l.toContactId ? { to: l.toContactId } : {}),
    ...(l.toOrg ? { toOrg: l.toOrg } : {}),
    assertedIn: toWireScope(l.assertedIn),
    createdAt: l.createdAt,
  };
}

/** Per-signal weights for a candidate's score: 1 - Π(1 - w). */
const REASON_WEIGHT = { email: 0.9, phone: 0.8, "name+org": 0.6 } as const;

function candidateOut(p: CandidatePair): Candidate {
  const verdict: Verdict = p.linked ? "confirmed" : "pending";
  const score = p.linked ? 1 : 1 - p.reasons.reduce((acc, r) => acc * (1 - REASON_WEIGHT[r]), 1);
  const reason = p.reasons.length ? p.reasons.map((r) => `same ${r}`).join(", ") : "same_as link";
  return { id: `cand:${p.a.id}:${p.b.id}`, a: p.a.id, b: p.b.id, score: Math.round(score * 1000) / 1000, reason, verdict };
}

/** Requests after contract validation; `raw` is the body as received (to
 * tell "field left out" from a schema default). */
type Req = Record<string, any> & { scopes: ScopeSet };

export interface AdapterDeps {
  store: Store;
  now: () => number;
}

export function createContactsAdapter({ store, now }: AdapterDeps) {
  const withScopes = (s: LocalScopeSet, contacts: LocalContact[]): Contact[] => {
    const owners = store.scopesOf(s, contacts.map((c) => c.id));
    return contacts.filter((c) => owners.has(c.id)).map((c) => contactOut(c, owners.get(c.id)!));
  };

  const followupsDue = (s: LocalScopeSet, dueBefore: string): Followup[] =>
    store.followupsDue(s, dueBefore).map((i) => ({
      contactId: i.contactId,
      interactionId: i.id,
      dueAt: i.followUpAt!,
      ...(i.note ? { summary: i.note } : {}),
    }));

  const ops: Record<ContactsOperation, (req: Req, raw: Record<string, unknown>) => unknown> = {
    search(req) {
      const s = toLocalScopeSet(req.scopes);
      const limit: number = req.limit ?? 50;
      const found = req.query.trim()
        ? store.search(s, req.query, { limit }).map((r) => r.contact)
        : store.list(s).slice(0, limit);
      return { contacts: withScopes(s, found) };
    },

    get(req) {
      const s = toLocalScopeSet(req.scopes);
      const c = store.get(s, req.id);
      const owner = c ? store.scopesOf(s, [c.id]).get(c.id) : undefined;
      if (!c || !owner) return { contact: null };
      return {
        contact: contactOut(c, owner),
        interactions: store.listInteractions(s, c.id).map((i) => interactionOut(i, owner)),
        links: store.links(s, c.id).map(linkOut),
      };
    },

    connections(req) {
      const s = toLocalScopeSet(req.scopes);
      const hits = store.connections(s, req.id, req.depth);
      const links = new Map<string, Link>();
      for (const h of hits) for (const l of h.path) links.set(l.id, linkOut(l));
      return { contacts: withScopes(s, hits.map((h) => h.contact)), links: [...links.values()] };
    },

    candidates(req) {
      const s = toLocalScopeSet(req.scopes);
      let out = store.allCandidates(s).map(candidateOut);
      if (req.verdict) out = out.filter((c) => c.verdict === req.verdict);
      return { candidates: out.slice(0, req.limit ?? 500) };
    },

    followups(req) {
      const s = toLocalScopeSet(req.scopes);
      return { followups: followupsDue(s, req.dueBefore ?? new Date(now()).toISOString()) };
    },

    summary(req) {
      const s = toLocalScopeSet(req.scopes);
      const verdicts = { pending: 0, confirmed: 0, rejected: 0 };
      for (const p of store.allCandidates(s)) verdicts[p.linked ? "confirmed" : "pending"]++;
      const lastSync = req.scopes.read.map((scope) => {
        const st = store.getGoogleSyncState({ read: [toLocalScope(scope)] });
        const times = [st.lastPullAt, st.lastPushAt].filter((t): t is string => !!t).sort();
        return { scope, at: times.length ? times[times.length - 1]! : null };
      });
      return { verdicts, followupsDue: followupsDue(s, new Date(now()).toISOString()).length, lastSync };
    },

    upsert(req, raw) {
      const s = toLocalScopeSet(req.scopes);
      const input = req.contact;
      const rawContact = (raw.contact ?? {}) as Record<string, unknown>;
      if (input.emails.length > 1) throw new BadRequest("a rolodex card holds one email");
      if (input.phones.length > 1) throw new BadRequest("a rolodex card holds one phone");
      const card = {
        id: input.id ?? "",
        name: input.name,
        email: input.emails[0],
        phone: input.phones[0],
        org: input.org,
        role: input.title,
        what: input.notes,
        // zod defaults `tags` to []; only a tags list the caller sent replaces the card's.
        tags: "tags" in rawContact ? input.tags : undefined,
      } as unknown as LocalContact;
      const { contact, created } = store.upsertDetailed(s, card, { preserveUnset: true });
      return { contact: contactOut(contact, s.write!), created };
    },

    log(req) {
      const s = toLocalScopeSet(req.scopes);
      const i = req.interaction;
      if (!i.summary.trim()) throw new BadRequest("summary must not be blank");
      const stored = store.logInteraction(s, {
        id: "",
        contactId: i.contactId,
        at: i.at,
        note: i.summary,
        channel: i.channel,
        followUpAt: i.followUpAt,
      });
      return { interaction: interactionOut(stored, s.write!) };
    },

    link(req) {
      const s = toLocalScopeSet(req.scopes);
      const l = req.link;
      if (l.toOrg !== undefined && l.predicate !== "works_at") throw new BadRequest("toOrg is only valid for works_at");
      if (l.toOrg !== undefined && !l.toOrg.trim()) throw new BadRequest("toOrg must not be blank");
      if (l.to !== undefined && l.to === l.from) throw new BadRequest("a contact cannot link to itself");
      const link = store.link(s, { fromContactId: l.from, toContactId: l.to, toOrg: l.toOrg, predicate: l.predicate });
      return { link: linkOut(link) };
    },

    unlink(req) {
      return { removed: store.unlink(toLocalScopeSet(req.scopes), req.linkId) };
    },

    delete(req) {
      return { deleted: store.delete(toLocalScopeSet(req.scopes), req.id) };
    },
  };

  return ops;
}
