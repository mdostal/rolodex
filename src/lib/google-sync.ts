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
  /** Push a local Contact to Google (create or update by resourceName). */
  push(c: Contact): Promise<{ resourceName: string }>;
}

/** SecretsAdapter key for the pasted Google OAuth client credentials, stored
 * as `JSON.stringify({ clientId, clientSecret })`. Deliberately duplicated
 * here (not imported) from src/shell/server.ts's identical constant — this
 * module lives in src/lib and must not depend on src/shell, but the string
 * value has to stay byte-for-byte identical since it's the shared row key in
 * the keychain. If you rename one, rename both. */
const GOOGLE_OAUTH_CLIENT_KEY = "google.oauth.client";

/** SecretsAdapter key for the OAuth token (access/refresh token pair) minted
 * by the real consent flow. Per src/shell/server.ts's own comment: "A future
 * story adds 'google.oauth.token' alongside it once the real OAuth exchange
 * exists." That story hasn't landed yet (the wizard only saves the client
 * id/secret today — see wizard.html: "Google sign-in happens the first time
 * you sync — coming soon"), so in the current codebase this key is never
 * actually written; pull() below fails with an actionable error until it is.
 * Stored as `JSON.stringify(Credentials)` (googleapis' OAuth2Client shape:
 * access_token/refresh_token/scope/token_type/expiry_date). */
const GOOGLE_OAUTH_TOKEN_KEY = "google.oauth.token";

/** People API field mask requested on every `connections.list` call — keep in
 * sync with the fields mapPersonToContact() actually reads. */
const PERSON_FIELDS = "names,organizations,emailAddresses,phoneNumbers";

/** Max page size the People API accepts for `people.connections.list`. */
const PAGE_SIZE = 1000;

/** The slice of googleapis' OAuth2 client that pull() needs — narrowed so
 * fakes don't have to satisfy the full (huge) real class. */
type OAuth2ClientLike = InstanceType<typeof google.auth.OAuth2>;

/** A single Google People `person` result, trimmed to just the fields this
 * module reads (the real `people_v1.Schema$Person` has dozens more). */
export interface PersonLite {
  resourceName?: string | null;
  names?: { displayName?: string | null }[] | null;
  organizations?: { name?: string | null; title?: string | null }[] | null;
  emailAddresses?: { value?: string | null }[] | null;
  phoneNumbers?: { value?: string | null }[] | null;
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
  };
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
    createdAt: now,
    updatedAt: now,
  };
}

/** Factory — real impl wires googleapis with the owner's OAuth (read back
 * from SecretsAdapter, never re-collected here). */
export function createGoogleSync(opts: CreateGoogleSyncOptions = {}): GoogleSync {
  const secrets = opts.secrets ?? createSecretsAdapter();
  const createPeopleClient = opts.createPeopleClient ?? defaultPeopleClientFactory;

  return {
    async pull() {
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
      auth.setCredentials(token);
      const client = createPeopleClient(auth);

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
    async push(_c) {
      // Explicitly out of scope for this story — see structured-outline.md's
      // GoogleSync interface note: "push(c: Contact): Promise<{ resourceName:
      // string }>;  // stays a stub".
      throw new Error("not implemented — People API create/updateContact");
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
