import type { Contact } from "./types.js";

/**
 * Google Contacts (People API) sync — the bridge that makes this tool the
 * thing that reads/writes YOUR Gmail contacts, on YOUR credentials.
 *
 * This is how the rolodex reaches me@mdostal's contacts without anyone else
 * holding the token: it runs in the owner's own environment with the owner's
 * OAuth. Nothing here ships a secret — credentials come from the env / a local
 * token file (both gitignored). Two-way, dedup by `resourceName`.
 *
 * SETUP (per-install, documented in docs/ARCHITECTURE.md):
 *  1. Enable the People API in your GCP project (e.g. personalsites-487021).
 *  2. Create an OAuth client (Desktop) or a service account with domain-wide
 *     delegation; store creds in GOOGLE_APPLICATION_CREDENTIALS or a local
 *     token file (gitignored).
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

/** Factory — real impl wires googleapis with the owner's OAuth. */
export function createGoogleSync(): GoogleSync {
  return {
    async pull() {
      // TODO(build): googleapis People API people.connections.list, map fields.
      throw new Error("not implemented — People API pull (owner's OAuth, env-sourced)");
    },
    async push(_c) {
      throw new Error("not implemented — People API create/updateContact");
    },
  };
}
