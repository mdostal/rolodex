# Design Discussion: Google Contacts push() — real two-way sync

## Goal

Replace `GoogleSync.push()`'s stub with a real implementation, safely —
without ever creating a path where a sync can silently lose local-only
data (verdict/angle/nextStep/tags/met/what) or silently overwrite a
contact that changed on Google's side since the last sync.

## Research (verified, not assumed)

- **`createContact`** — `POST people:createContact`, body is a `Person`
  resource with the same field shape `pull()` already reads
  (`names`/`organizations`/`emailAddresses`/`phoneNumbers`). Response
  includes the new `resourceName` and `metadata.sources[].etag`.
- **`updateContact`** — `PATCH people/{id}:updateContact`, requires an
  `updatePersonFields` field-mask query param (comma-separated, same field
  names) and the person's current `etag` in the request body.
  **Etag-based optimistic concurrency is real and built into the API** — a
  stale etag gets a `400 failedPrecondition`, not silently overwritten.
  This *is* the conflict-detection mechanism; nothing custom needs
  building for it.
- **`deleteContact`** — `DELETE people/{resourceName}:deleteContact`,
  trivial.
- **Sync tokens** (`connections.list`'s `requestSyncToken`) are real but
  add real complexity (7-day expiry, several-minutes write-propagation
  delay, exact-param-repetition requirement) for a benefit (avoiding a
  full re-list) that doesn't matter at rolodex's personal scale (hundreds
  to low-thousands of contacts). **Not using them** — a full-list diff on
  every sync is simpler and sufficient.
- Google's own guidance: send mutate requests for one user **sequentially,
  not concurrently** — a "push everything" pass must be a loop, not a
  fan-out.

Sources: developers.google.com/people/api/rest/v1/people/{updateContact,createContact,deleteContact}, people.connections/list, people/v1/contacts.

## Design decisions

**1. Conflict resolution: Google's own etag mechanism, surfaced plainly.**
Every pulled contact's etag gets stored locally (new `Contact.googleEtag`
field/column). `push()` sends that etag on `updateContact`; a
`failedPrecondition` (etag mismatch — the Google-side contact changed
since the last pull) is caught and surfaced as a clear, specific error
("this contact changed on Google since your last sync — pull, then push
again"), never silently retried with a fresh overwrite. No custom
conflict UI in this epic — Google's own concurrency check is the whole
mechanism; rolodex just has to not swallow its error.

**2. What syncs, in each direction, stays exactly as documented today.**
`push()` writes only `names`/`organizations` (org→name, role→title)
/`emailAddresses`/`phoneNumbers` — the same fields `pull()` already
reads. verdict/angle/nextStep/tags/met/what/createdAt never leave the
local DB; Google has no fields for them and none are added. This is
`mergeLocalOnlyFields()`'s existing contract, applied in the outbound
direction too.

**3. New local contact (no `googleResourceName` yet) → `createContact`;
existing linked contact → `updateContact`.** Both are real, separate
code paths — `push()` branches on whether `c.googleResourceName` is set.
`createContact`'s response `resourceName`/`etag` get written back to the
local row immediately (`Store.upsert()`, not a new method).

**4. Deletes — conservative, in both directions.**
- **Local contact deleted → also delete on Google, best-effort, at
  delete time.** Not detected later via diffing (no tombstone exists to
  diff against) — if the local row has a `googleResourceName`,
  `deleteContact()` is called synchronously as part of the same delete
  action. A failure there does not block the local delete (data the user
  asked to remove locally is removed locally regardless) but is
  surfaced, not swallowed.
- **Google-side contact deleted → never auto-delete the local row.**
  Deliberately conservative: rolodex is "you own your data," and a
  disappeared remote link is not sufficient grounds to destroy local
  data (verdict/history/notes) that only exists in rolodex. Instead: if
  `push()` tries to `updateContact` a `resourceName` that 404s, it falls
  back to `createContact` (re-creates on Google, writes back the new
  `resourceName`) rather than treating the local contact as orphaned.
  Google is never treated as authoritative for *existence* — only local
  is.

**5. `Store` has no delete method at all today — a real prerequisite,
not a nice-to-have.** Decision 4 needs it directly (can't "also delete on
Google when locally deleted" without a local delete existing), and it's
independently a real CRUD gap (flagged separately by this session's
pre-release correctness review). Added as story 1, ahead of push()
itself.

**6. UX: push stays a distinct, explicit action from pull.** `POST
/api/sync/google` today always pulls. `rolodex_sync_google`'s
`direction: "pull"|"push"|"both"` parameter already exists in the
MCP/CLI surfaces (`push` currently a hard "not implemented" error) —
that's the right existing surface, not a new one. The shell UI's
existing "Sync now" stays pull-only (safe, non-destructive default); a
separate, clearly-labeled "Push to Google" action is added next to it,
since push is the more consequential direction (it can create/overwrite
data on the user's real Google account).

## Schema change

`contacts` gains a `googleEtag TEXT` column (nullable — local-only
contacts and pre-migration rows have none). `pull()`'s `mapPersonToContact`
starts reading `metadata.sources[].etag` off each `PersonLite` alongside
`resourceName`. `Store.upsert()` needs no behavior change — `googleEtag`
is just another field it writes when given, same as every other column.

## Stories

1. `Store.delete()` + `DELETE /api/contacts/:id` + MCP/CLI parity + a
   delete affordance in the UI — prerequisite for safe delete-propagation
   below, and a real standalone CRUD gap.
2. `googleEtag` schema column + `pull()` captures it from the People API
   response.
3. `push()` real implementation: create-vs-update branching, etag sent on
   update, `failedPrecondition` surfaced as a clear conflict error,
   404-on-update falls back to re-create.
4. Local-delete-also-deletes-on-Google wiring (best-effort, non-blocking).
5. Wire `direction: "push"|"both"` through the MCP tool, the CLI, and a
   new "Push to Google" UI action; sequential (not concurrent) batch push
   per Google's own guidance.
6. Tests + `docs/ARCHITECTURE.md`/README updates.

## Explicitly out of scope

- Google-side delete auto-propagating to a local delete (decision 4,
  deliberate).
- Sync tokens / incremental sync (decision above — full-diff is simpler
  and sufficient at this scale).
- A conflict-resolution UI beyond "surface the error and tell the user to
  pull first" — Google's etag check is the whole mechanism this epic
  relies on.
