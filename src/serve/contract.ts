import { z } from "zod";

/**
 * The host's L2 contacts-slot contract, COPIED (not imported) from
 * mdostal/pantheon-v2 `contracts/l2/slots/contacts.ts` at commit
 * c6fe61da141a5706d45d811a75c98817810acff0 (PANT-1413, cm-01). rolodex never
 * imports host code; `rolodex serve` (cm-04) speaks this contract over
 * signed HTTP, one `POST /v1/<operation>` route per operation.
 *
 * Keep this file a verbatim copy of the schemas: when the host contract
 * changes, re-copy it and bump {@link CONTRACT_SCHEMA}. Only the
 * `ContactsSlot` type (the host's in-process interface) is left out.
 */

/** What `GET /v1/health` reports as `schema`: the contract this server speaks. */
export const CONTRACT_SCHEMA = "contacts-slot/1";

export const CONTACTS_SLOT = "contacts";

const Id = z.string().min(1);
const Timestamp = z.string().datetime({ offset: true });

export const SCOPE_KINDS = ["client", "user"] as const;
export const ScopeKindSchema = z.enum(SCOPE_KINDS);

export const ScopeSchema = z.object({ kind: ScopeKindSchema, id: Id });
export type Scope = z.infer<typeof ScopeSchema>;

/** `kind:id` -> Scope. The id is everything after the first colon. Throws on a malformed scope. */
export function parseScope(value: string): Scope {
  const colon = value.indexOf(":");
  if (colon < 0) throw new Error(`scope "${value}" is not kind:id`);
  return ScopeSchema.parse({ kind: value.slice(0, colon), id: value.slice(colon + 1) });
}

export function formatScope(scope: Scope): string {
  return `${scope.kind}:${scope.id}`;
}

/** A scope in its written form, `kind:id`, parsed to a {@link Scope}. */
export const ScopeStringSchema = z.string().transform((value, ctx): Scope => {
  try {
    return parseScope(value);
  } catch (error) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: (error as Error).message });
    return z.NEVER;
  }
});

export const ScopeSetSchema = z.object({
  /** The scopes a call may read. At least one. */
  read: z.array(ScopeSchema).min(1),
  /** The one scope a write lands in. Required by every write operation. */
  write: ScopeSchema.optional(),
});
export type ScopeSet = z.infer<typeof ScopeSetSchema>;

const WriteScopeSetSchema = ScopeSetSchema.refine((scopes) => scopes.write !== undefined, {
  message: "a write operation needs a write scope",
  path: ["write"],
});

export const ContactSchema = z.object({
  id: Id,
  name: z.string().min(1),
  emails: z.array(z.string().email()).default([]),
  phones: z.array(z.string().min(1)).default([]),
  org: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  notes: z.string().optional(),
  tags: z.array(z.string().min(1)).default([]),
  /** The scope the contact was written into. */
  scope: ScopeSchema,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Contact = z.infer<typeof ContactSchema>;

/** What a caller sends to upsert: no id creates, an id updates. Scope and times are the
 * implementation's. */
export const ContactInputSchema = ContactSchema.omit({ id: true, scope: true, createdAt: true, updatedAt: true }).extend({
  id: Id.optional(),
});
export type ContactInput = z.infer<typeof ContactInputSchema>;

export const InteractionSchema = z.object({
  id: Id,
  contactId: Id,
  at: Timestamp,
  /** Free-form: `email`, `call`, `meeting`, ... */
  channel: z.string().min(1),
  summary: z.string().min(1),
  scope: ScopeSchema,
  /** When set, the interaction shows in followups once due. */
  followUpAt: Timestamp.optional(),
});
export type Interaction = z.infer<typeof InteractionSchema>;

export const InteractionInputSchema = InteractionSchema.omit({ id: true, scope: true });
export type InteractionInput = z.infer<typeof InteractionInputSchema>;

export const LINK_PREDICATES = ["same_as", "knows", "introduced", "works_at", "reports_to", "colleague"] as const;
export const LinkPredicateSchema = z.enum(LINK_PREDICATES);
export type LinkPredicate = z.infer<typeof LinkPredicateSchema>;

const LinkBaseSchema = z.object({
  id: Id,
  /** A contact id. */
  from: Id,
  predicate: LinkPredicateSchema,
  /** A contact id; exactly one of `to` and `toOrg`. */
  to: Id.optional(),
  /** An organisation name; exactly one of `to` and `toOrg`. */
  toOrg: z.string().min(1).optional(),
  /** The scope the link holds in. */
  assertedIn: ScopeSchema,
  createdAt: Timestamp,
});

function oneTarget(link: { to?: string; toOrg?: string }, ctx: z.RefinementCtx): void {
  if ((link.to === undefined) === (link.toOrg === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "a link names exactly one of to and toOrg" });
  }
}

export const LinkSchema = LinkBaseSchema.superRefine(oneTarget);
export type Link = z.infer<typeof LinkSchema>;

/** What a caller sends to link; `assertedIn` is the call's write scope. */
export const LinkInputSchema = LinkBaseSchema.omit({ id: true, assertedIn: true, createdAt: true }).superRefine(oneTarget);
export type LinkInput = z.infer<typeof LinkInputSchema>;

export const VERDICTS = ["pending", "confirmed", "rejected"] as const;
export const VerdictSchema = z.enum(VERDICTS);
export type Verdict = z.infer<typeof VerdictSchema>;

/** Two contacts that may be the same person; confirming one is a same_as link. */
export const CandidateSchema = z.object({
  id: Id,
  a: Id,
  b: Id,
  score: z.number().min(0).max(1),
  reason: z.string().min(1),
  verdict: VerdictSchema,
});
export type Candidate = z.infer<typeof CandidateSchema>;

export const FollowupSchema = z.object({
  contactId: Id,
  interactionId: Id,
  dueAt: Timestamp,
  summary: z.string().optional(),
});
export type Followup = z.infer<typeof FollowupSchema>;

const Count = z.number().int().nonnegative();

const read = { scopes: ScopeSetSchema };
const write = { scopes: WriteScopeSetSchema };

export const CONTACTS_OPERATIONS = {
  search: {
    request: z.object({ ...read, query: z.string(), limit: z.number().int().positive().max(500).optional() }),
    response: z.object({ contacts: z.array(ContactSchema) }),
  },
  get: {
    request: z.object({ ...read, id: Id }),
    response: z.union([
      z.object({ contact: ContactSchema, interactions: z.array(InteractionSchema), links: z.array(LinkSchema) }),
      z.object({ contact: z.null() }).strict(),
    ]),
  },
  connections: {
    request: z.object({ ...read, id: Id, depth: z.number().int().min(1).max(2).default(1) }),
    response: z.object({ contacts: z.array(ContactSchema), links: z.array(LinkSchema) }),
  },
  candidates: {
    request: z.object({ ...read, verdict: VerdictSchema.optional(), limit: z.number().int().positive().max(500).optional() }),
    response: z.object({ candidates: z.array(CandidateSchema) }),
  },
  followups: {
    request: z.object({ ...read, dueBefore: Timestamp.optional() }),
    response: z.object({ followups: z.array(FollowupSchema) }),
  },
  summary: {
    request: z.object(read),
    response: z.object({
      verdicts: z.object({ pending: Count, confirmed: Count, rejected: Count }),
      followupsDue: Count,
      /** One entry per read scope; `at` null when the scope has never synced. */
      lastSync: z.array(z.object({ scope: ScopeSchema, at: Timestamp.nullable() })),
    }),
  },
  upsert: {
    request: z.object({ ...write, contact: ContactInputSchema }),
    response: z.object({ contact: ContactSchema, created: z.boolean() }),
  },
  log: {
    request: z.object({ ...write, interaction: InteractionInputSchema }),
    response: z.object({ interaction: InteractionSchema }),
  },
  link: {
    request: z.object({ ...write, link: LinkInputSchema }),
    response: z.object({ link: LinkSchema }),
  },
  unlink: {
    request: z.object({ ...write, linkId: Id }),
    response: z.object({ removed: z.boolean() }),
  },
  delete: {
    request: z.object({ ...write, id: Id }),
    response: z.object({ deleted: z.boolean() }),
  },
} as const;

export type ContactsOperation = keyof typeof CONTACTS_OPERATIONS;
export type ContactsRequest<Op extends ContactsOperation> = z.input<(typeof CONTACTS_OPERATIONS)[Op]["request"]>;
export type ContactsResponse<Op extends ContactsOperation> = z.infer<(typeof CONTACTS_OPERATIONS)[Op]["response"]>;
