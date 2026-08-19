import { randomUUID } from "node:crypto";
import { google } from "googleapis";
import type { Contact } from "./types.js";
import { createSecretsAdapter, type SecretsAdapter } from "./secrets-adapter.js";

/**
 * Google Contacts (People API) sync — the bridge that makes this tool the
 * thing that reads/writes YOUR Gmail contacts, on YOUR credentials.
 *
 * This is how the rolodex reaches me@mdostal's contacts without anyone else
 * holding the token: it runs in the owner's own environment with the owner's
 * OAuth. Nothing here ships a secret — credentials come from SecretsAdapter
 * (OS keychain), the same store the setup wizard writes to (see
 * src/shell/server.ts's `GOOGLE_OAUTH_CLIENT_KEY`). Two-way, dedup by
 * `resourceName`.
 *
 * SETUP (per-install, documented in docs/ARCHITECTURE.md):
 *  1. Enable the People API in your GCP project (e.g. personalsites-487021).
 *  2. Create an OAuth client (Desktop) or a service account with domain-wide
 *     delegation; the setup wizard's Google-connect screen saves the client
 *     id/secret under SecretsAdapter key "google.oauth.client".
 *  3. Scopes: https://www.googleapis.com/auth/contacts (read+write).
 *
 * API surface used:
 *  - people.connections.list  -> pull contacts (paginate via pageToken)
 *  - people.createContact / people.updateContact -> push
 * Map People `resourceName` <-> Contact.googleResourceName for idempotent sync.
 */
export interface GoogleSync {
  /** Pull all connections into normalized Contacts (verdict/angle stay local). */
  pull(): Promise<Contact[]>;
  /** Push a local Contact to Google (create or update by resourceName).
   * Returns the resourceName/etag the caller must persist back onto the
   * local row via Store.upsert() — using the OLD etag for a second push
   * without saving the new one would spuriously fail the next call's
   * conflict check against Google's now-updated etag. */
  push(c: Contact): Promise<{ resourceName: string; etag?: string }>;
  /** Deletes a contact on Google's side by resourceName. Used by
   * deleteContactEverywhere() below when a local delete's contact was
   * linked to Google — never called directly against a contact that
   * doesn't have a googleResourceName. */
  deleteContact(resourceName: string): Promise<void>;
}

/** SecretsAdapter key for the pasted Google OAuth client credentials, stored
 * as `JSON.stringify({ clientId, clientSecret })`. Deliberately duplicated
 * here (not imported) from src/shell/server.ts's identical constant — this
 * module lives in src/lib and must not depend on src/shell, but the string
 * value has to stay byte-for-byte identical since it's the shared row key in
 * the keychain. If you rename one, rename both. */
const GOOGLE_OAUTH_CLIENT_KEY = "google.oauth.client";

/** SecretsAdapter key for the OAuth token (access/refresh token pair) minted
 * by the real consent flow. Written by src/lib/google-oauth-flow.ts's
 * `connectGoogleAccount()` (the real loopback OAuth exchange) and refreshed
 * in place by this file's own `pull()` below whenever googleapis silently
 * refreshes the access token — see the `auth.on("tokens", ...)` hook in
 * `pull()`. Exported (not duplicated, unlike `GOOGLE_OAUTH_CLIENT_KEY`) so
 * that same-package `src/lib` import can share this exact literal. Stored as
 * `JSON.stringify(Credentials)` (googleapis' OAuth2Client shape:
 * access_token/refresh_token/scope/token_type/expiry_date). */
export const GOOGLE_OAUTH_TOKEN_KEY = "google.oauth.token";

/** People API field mask requested on every `connections.list` call — keep in
 * sync with the fields mapPersonToContact() actually reads. `metadata` is
 * requested explicitly (not assumed to come back for free) since it's what
 * carries `sources[].etag` — the value push()'s updateContact call needs for
 * Google's own optimistic-concurrency check. */
const PERSON_FIELDS = "names,organizations,emailAddresses,phoneNumbers,metadata";

/** Max page size the People API accepts for `people.connections.list`. */
const PAGE_SIZE = 1000;

/** The slice of googleapis' OAuth2 client that pull() needs — narrowed so
 * fakes don't have to satisfy the full (huge) real class. */
type OAuth2ClientLike = InstanceType<typeof google.auth.OAuth2>;

/** A single Google People `person` result, trimmed to just the fields this
 * module reads (the real `people_v1.Schema$Person` has dozens more). */
export interface PersonLite {
  resourceName?: string | null;
  /** `displayName` is read-only on the real API (computed server-side from
   * the structured name parts) — pull() reads it, but a write must set
   * `givenName`/`familyName` instead; see contactToPersonBody()'s doc
   * comment for how this repo splits (or deliberately doesn't split) a
   * single Contact.name string across them. */
  names?: { displayName?: string | null; givenName?: string | null; familyName?: string | null }[] | null;
  organizations?: { name?: string | null; title?: string | null }[] | null;
  emailAddresses?: { value?: string | null }[] | null;
  phoneNumbers?: { value?: string | null }[] | null;
  /** Carries `sources[].etag` — the per-person concurrency token push()'s
   * updateContact call sends back to Google. A person can in principle have
   * more than one `sources` entry; mapPersonToContact() takes the first one
   * that actually has an etag rather than assuming a specific source count
   * or exact `type` value to match on. */
  metadata?: { sources?: { type?: string | null; etag?: string | null }[] | null } | null;
}

/** The slice of the real `people_v1.People` client (as returned by
 * `google.people({version:"v1", auth})`) that pull() calls — narrowed to a
 * minimal, easily-fakeable shape for dependency injection in tests. Matches
 * the real client's `{ data }`-wrapped response shape (a GaxiosResponse) so
 * a real client can be passed here unmodified. */
export interface PeopleApiClient {
  people: {
    connections: {
      list(params: {
        resourceName: string;
        personFields: string;
        pageSize?: number;
        pageToken?: string;
      }): Promise<{ data: { connections?: PersonLite[] | null; nextPageToken?: string | null } }>;
    };
    /** Real googleapis method is people.people.createContact — sibling of
     * `connections`, not nested under it. */
    createContact(params: { requestBody: PersonLite }): Promise<{ data: PersonLite }>;
    /** Real googleapis method is people.people.updateContact.
     * `updatePersonFields` is the field-mask naming exactly which top-level
     * fields this call overwrites; fields the mask doesn't name are left
     * untouched server-side even if the request body happens to omit them. */
    updateContact(params: {
      resourceName: string;
      updatePersonFields: string;
      requestBody: PersonLite;
    }): Promise<{ data: PersonLite }>;
    /** Real googleapis method is people.people.deleteContact — params shape
     * confirmed against node_modules/googleapis/build/src/apis/people/v1.d.ts
     * (Params$Resource$People$Deletecontact: { resourceName?: string }). */
    deleteContact(params: { resourceName: string }): Promise<unknown>;
  };
}

/** The subset of a real googleapis error's shape push() needs to
 * distinguish "etag mismatch, real conflict" (400) from "resourceName no
 * longer exists on Google's side" (404) from anything else (rethrown
 * as-is). Real GaxiosError instances expose the HTTP status under one of
 * several property names depending on googleapis version — checked in
 * order rather than assumed, so this isn't pinned to one exact shape. */
function httpStatusOf(err: unknown): number | undefined {
  const e = err as { code?: unknown; status?: unknown; response?: { status?: unknown } };
  const candidate = e.code ?? e.status ?? e.response?.status;
  return typeof candidate === "number" ? candidate : undefined;
}

/** Same source mapPersonToContact() reads googleEtag from, reused here for
 * push()'s createContact/updateContact responses — the fresh etag those
 * calls return has to be persisted back onto the local row (by the caller,
 * via Store.upsert()) or the next push() will send a now-stale value. */
function extractEtag(person: PersonLite): string | undefined {
  return person.metadata?.sources?.find((s) => s.etag)?.etag ?? undefined;
}

export interface CreateGoogleSyncOptions {
  /** Where the OAuth client id/secret and token are read from. Defaults to
   * the real OS-keychain-backed adapter. */
  secrets?: SecretsAdapter;
  /** Builds the People API client from an authenticated OAuth2 client.
   * Injectable so tests can substitute a fake and never touch the network.
   * Defaults to the real `google.people({ version: "v1", auth })`. */
  createPeopleClient?: (auth: OAuth2ClientLike) => PeopleApiClient;
}

function defaultPeopleClientFactory(auth: OAuth2ClientLike): PeopleApiClient {
  // The real people_v1.People client has a much wider surface than
  // PeopleApiClient declares; this narrows it down to what pull() actually
  // uses. The cast is safe because connections.list's real response is
  // always `{ data: Schema$ListConnectionsResponse, ... }`, a superset of
  // what PeopleApiClient's list() return type declares.
  return google.people({ version: "v1", auth }) as unknown as PeopleApiClient;
}

interface StoredGoogleClient {
  clientId: string;
  clientSecret: string;
}

/** Parses+validates the JSON blob stored under GOOGLE_OAUTH_CLIENT_KEY. */
function parseStoredClient(raw: string): StoredGoogleClient {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      "Stored Google OAuth client credentials are corrupt (not valid JSON) — reconnect Google from the wizard's Google-connect step.",
    );
  }
  const obj = parsed as Partial<StoredGoogleClient> | null;
  if (!obj || typeof obj.clientId !== "string" || typeof obj.clientSecret !== "string" || !obj.clientId || !obj.clientSecret) {
    throw new Error(
      "Stored Google OAuth client credentials are incomplete — reconnect Google from the wizard's Google-connect step.",
    );
  }
  return { clientId: obj.clientId, clientSecret: obj.clientSecret };
}

/** Parses+validates the JSON blob stored under GOOGLE_OAUTH_TOKEN_KEY. Kept
 * loose (just needs to be a non-null object) since googleapis' Credentials
 * shape has no single field that's always present (a refresh_token-only
 * token is legitimate, as is an access_token-only one right after consent). */
function parseStoredToken(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Stored Google OAuth token is corrupt (not valid JSON) — reconnect Google and sign in again.");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Stored Google OAuth token is malformed — reconnect Google and sign in again.");
  }
  return parsed as Record<string, unknown>;
}

/** Maps one People API `person` result to a Contact. `id`/`googleResourceName`
 * come from `resourceName` (the People API's stable per-contact id) so a
 * fresh pull with no local match yet gets a stable, non-random id — see
 * Contact.id's doc comment ("stable id (uuid or google resourceName)").
 * `met`/`what`/`angle`/`nextStep`/`tags` are left unset: Google has no
 * equivalent field for any of them, and they're local-only per
 * docs/ARCHITECTURE.md ("Verdict/angle/next-step are local-only ... never
 * lost on sync") — `verdict` defaults to "none" (Store's own default) for
 * the same reason. */
export function mapPersonToContact(person: PersonLite): Contact {
  const resourceName = person.resourceName ?? undefined;
  const name = person.names?.[0]?.displayName?.trim();
  const email = person.emailAddresses?.[0]?.value ?? undefined;
  const etag = extractEtag(person);
  const now = new Date().toISOString();
  return {
    // Falls back to a fresh uuid only in the (real-world-never-happens)
    // case the API returns a connection with no resourceName at all — keeps
    // Contact.id a always-present string without pretending an absent
    // resourceName is a real one.
    id: resourceName ?? randomUUID(),
    // Google always has *a* name field on a real contact; email is a
    // reasonable second choice for a bare/malformed entry, and "(no name)"
    // keeps Contact.name (required, non-empty by the /api/contacts route's
    // own validation) satisfiable in the rare case neither is present.
    name: name || email || "(no name)",
    org: person.organizations?.[0]?.name ?? undefined,
    role: person.organizations?.[0]?.title ?? undefined,
    email,
    phone: person.phoneNumbers?.[0]?.value ?? undefined,
    verdict: "none",
    googleResourceName: resourceName,
    googleEtag: etag,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Inverse of mapPersonToContact() — builds the write-side Person body
 * push() sends to createContact/updateContact. Only ever writes the same
 * fields pull() reads (names/organizations/emailAddresses/phoneNumbers) —
 * verdict/angle/nextStep/tags/met/what never leave the local DB, matching
 * mergeLocalOnlyFields()'s contract in the outbound direction too.
 *
 * Name-splitting decision: Google's `names[].displayName` is read-only:
 * writes must go through `givenName`/`familyName` instead, and rolodex's
 * Contact model has no such split — it's one `name` string. Rather than
 * guess where to split it (naive last-space splitting mangles multi-word
 * family names, suffixes, single names, etc. — a real "no silent guesses"
 * violation), the whole string goes into `givenName` alone, leaving
 * `familyName` unset. Google renders a person's displayName correctly from
 * givenName alone; the only real cost is that Google Contacts' own
 * family-name-based sorting/grouping won't have anything to key off for a
 * contact pushed from here.
 */
export function contactToPersonBody(c: Contact): PersonLite {
  const body: PersonLite = {
    names: [{ givenName: c.name }],
  };
  if (c.org || c.role) body.organizations = [{ name: c.org ?? undefined, title: c.role ?? undefined }];
  if (c.email) body.emailAddresses = [{ value: c.email }];
  if (c.phone) body.phoneNumbers = [{ value: c.phone }];
  return body;
}

/** Shared auth bootstrap for both pull() and push() — reads the stored
 * OAuth client/token, wires the same "persist a silent refresh back to the
 * keychain" hook either call might trigger, and returns a ready-to-use
 * People API client. Pulled out of pull() (unchanged behavior/error
 * messages) so push() doesn't duplicate it. */
async function getAuthenticatedClient(
  secrets: SecretsAdapter,
  createPeopleClient: (auth: OAuth2ClientLike) => PeopleApiClient,
): Promise<PeopleApiClient> {
  const clientRaw = await secrets.get(GOOGLE_OAUTH_CLIENT_KEY);
  if (!clientRaw) {
    throw new Error(
      "Google isn't connected yet — save an OAuth client from the setup wizard's Google-connect step (or Settings) before syncing.",
    );
  }
  const { clientId, clientSecret } = parseStoredClient(clientRaw);

  const tokenRaw = await secrets.get(GOOGLE_OAUTH_TOKEN_KEY);
  if (!tokenRaw) {
    throw new Error(
      "Google sign-in hasn't happened yet — no OAuth token is stored (the consent flow is coming soon). Complete Google sign-in, then sync again.",
    );
  }
  const token = parseStoredToken(tokenRaw);

  const auth = new google.auth.OAuth2(clientId, clientSecret);
  // Persist a token refreshed during this call back to the keychain (not
  // just kept in-memory for this one call) — otherwise every call after the
  // stored access_token expires would silently re-derive a fresh one from
  // refresh_token without ever updating what's stored, and the keychain's
  // copy would drift stale forever. Wired before setCredentials()/use so it
  // also covers a refresh triggered by the very first request this client
  // makes.
  auth.on("tokens", (tokens) => {
    void secrets.set(GOOGLE_OAUTH_TOKEN_KEY, JSON.stringify(tokens));
  });
  auth.setCredentials(token);
  return createPeopleClient(auth);
}

/** Factory — real impl wires googleapis with the owner's OAuth (read back
 * from SecretsAdapter, never re-collected here). */
export function createGoogleSync(opts: CreateGoogleSyncOptions = {}): GoogleSync {
  const secrets = opts.secrets ?? createSecretsAdapter();
  const createPeopleClient = opts.createPeopleClient ?? defaultPeopleClientFactory;

  return {
    async pull() {
      const client = await getAuthenticatedClient(secrets, createPeopleClient);

      const contacts: Contact[] = [];
      let pageToken: string | undefined;
      do {
        const { data } = await client.people.connections.list({
          resourceName: "people/me",
          personFields: PERSON_FIELDS,
          pageSize: PAGE_SIZE,
          pageToken,
        });
        for (const person of data.connections ?? []) {
          contacts.push(mapPersonToContact(person));
        }
        pageToken = data.nextPageToken ?? undefined;
      } while (pageToken);

      return contacts;
    },
    async push(c) {
      const client = await getAuthenticatedClient(secrets, createPeopleClient);
      const body = contactToPersonBody(c);

      const create = async (): Promise<{ resourceName: string; etag?: string }> => {
        const { data } = await client.people.createContact({ requestBody: body });
        // A created contact always gets a real resourceName back from a
        // successful call — treated as a genuine invariant, not silently
        // cast past, since a caller trusting an empty resourceName would
        // then write a broken link into the local row.
        if (!data.resourceName) {
          throw new Error(`Google's createContact response for "${c.name}" didn't include a resourceName.`);
        }
        return { resourceName: data.resourceName, etag: extractEtag(data) };
      };

      if (!c.googleResourceName) return create();

      try {
        const { data } = await client.people.updateContact({
          resourceName: c.googleResourceName,
          updatePersonFields: "names,organizations,emailAddresses,phoneNumbers",
          requestBody: { ...body, metadata: { sources: [{ etag: c.googleEtag ?? undefined }] } },
        });
        return { resourceName: data.resourceName ?? c.googleResourceName, etag: extractEtag(data) };
      } catch (err) {
        const status = httpStatusOf(err);
        if (status === 400) {
          throw new Error(
            `"${c.name}" changed on Google since your last sync (its saved version no longer matches) — pull, then push again.`,
          );
        }
        if (status === 404) {
          // The linked Google contact is gone — re-create rather than
          // treat the local row as orphaned. Google is never authoritative
          // for existence here; only the local row is (see the
          // google-two-way-sync epic's design discussion, decision 4).
          return create();
        }
        throw err;
      }
    },
    async deleteContact(resourceName) {
      const client = await getAuthenticatedClient(secrets, createPeopleClient);
      try {
        await client.people.deleteContact({ resourceName });
      } catch (err) {
        // Already-gone is a successful outcome for a delete, not a failure
        // to surface — the caller wanted this resourceName to not exist on
        // Google, and it doesn't.
        if (httpStatusOf(err) === 404) return;
        throw err;
      }
    },
  };
}

/**
 * Local-only fields (never sourced from Google — see docs/ARCHITECTURE.md's
 * "Verdict/angle/next-step are local-only ... never lost on sync") that a
 * sync must carry forward from whatever local row already matched `pulled`,
 * rather than letting `pulled`'s always-blank defaults for them clobber the
 * real, user-set values. `Store.upsert()` itself does its own id-and-dedup
 * resolution (googleResourceName, then email) and always writes every field
 * it's handed — it has no notion of "leave this column alone" — so this
 * pre-merge step is what actually protects those columns; upsert()'s own
 * dedup logic (which id gets written to) is untouched/reused as-is.
 */
export function mergeLocalOnlyFields(pulled: Contact, existing: Contact | undefined): Contact {
  if (!existing) return pulled;
  return {
    ...pulled,
    id: existing.id,
    met: existing.met,
    what: existing.what,
    angle: existing.angle,
    verdict: existing.verdict,
    nextStep: existing.nextStep,
    tags: existing.tags,
    createdAt: existing.createdAt,
  };
}

/** Finds the local contact a pulled contact would dedup against, mirroring
 * `Store.upsert()`'s own documented priority ("Dedup: googleResourceName
 * first, then email — first match wins.") without reaching into Store's
 * private matching logic — just a read over the already-implemented
 * `Store.list()`, safe at rolodex's personal-scale row counts. */
export function findExistingMatch(pulled: Contact, existingContacts: readonly Contact[]): Contact | undefined {
  if (pulled.googleResourceName) {
    const byResourceName = existingContacts.find((c) => c.googleResourceName === pulled.googleResourceName);
    if (byResourceName) return byResourceName;
  }
  if (pulled.email) {
    return existingContacts.find((c) => c.email === pulled.email);
  }
  return undefined;
}

export interface ApplyPullSummary {
  pulled: number;
  created: number;
  updated: number;
}

/** Minimal shape this needs from Store — just `list()`/`upsert()`, so tests
 * can pass a real Store (temp-file backed) or a hand-rolled fake. */
export interface UpsertableStore {
  list(): Contact[];
  upsert(c: Contact): Contact;
}

/**
 * Applies a batch of pulled Contacts to `store`: for each, finds any existing
 * local match (findExistingMatch), merges the existing row's local-only
 * fields onto the pulled one (mergeLocalOnlyFields) so verdict/nextStep/etc.
 * survive the sync, then hands the merged Contact to the already-implemented
 * `Store.upsert()` — which owns the actual dedup-and-write. Snapshots
 * `store.list()` once up front rather than re-querying per contact.
 */
export function applyPullToStore(pulled: Contact[], store: UpsertableStore): ApplyPullSummary {
  const existingContacts = store.list();
  let created = 0;
  let updated = 0;
  for (const contact of pulled) {
    const existing = findExistingMatch(contact, existingContacts);
    const merged = mergeLocalOnlyFields(contact, existing);
    store.upsert(merged);
    if (existing) updated++;
    else created++;
  }
  return { pulled: pulled.length, created, updated };
}

/** Minimal shape this needs from Store — get()+delete(), so tests can pass
 * a real Store or a hand-rolled fake, matching UpsertableStore's shape
 * above. */
export interface DeletableStore {
  get(id: string): Contact | undefined;
  delete(id: string): boolean;
}

export interface DeleteContactSummary {
  /** False only when no contact with this id existed locally to begin with
   * — the Google side is never even attempted in that case. */
  deleted: boolean;
  /** Set when the local delete succeeded but the best-effort Google-side
   * delete failed — the local delete is NOT rolled back for this (data the
   * user asked to remove locally is removed locally regardless), but the
   * caller gets the failure to decide how to surface it (see the
   * google-two-way-sync epic's design discussion, decision 4). */
  googleDeleteError?: string;
}

/**
 * Deletes a contact locally, then — only if it was actually linked to
 * Google and the local delete genuinely happened — best-effort deletes it
 * on Google's side too. The single place both the HTTP DELETE route and the
 * rolodex_delete MCP tool call, so this exact contract (local delete always
 * wins, Google delete is best-effort and non-blocking, a 404-already-gone
 * on Google's side is not an error) lives in one place instead of two
 * drifting copies.
 */
export async function deleteContactEverywhere(
  id: string,
  store: DeletableStore,
  google: Pick<GoogleSync, "deleteContact">,
): Promise<DeleteContactSummary> {
  const contact = store.get(id);
  if (!contact) return { deleted: false };

  const googleResourceName = contact.googleResourceName;
  const deleted = store.delete(id);

  if (deleted && googleResourceName) {
    try {
      await google.deleteContact(googleResourceName);
    } catch (err) {
      return { deleted, googleDeleteError: err instanceof Error ? err.message : String(err) };
    }
  }

  return { deleted };
}
