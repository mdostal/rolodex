# Pantheon integration (future, stub only)

This document — and the dormant, unwired stub at
[`src/integrations/pantheon.ts`](../src/integrations/pantheon.ts) — is
deliberately **not a real integration**. Nothing in rolodex imports or
registers this file today; rolodex runs entirely standalone with zero
Pantheon dependency, and always will be usable that way. This exists so a
future pass has a concrete, accurate starting point instead of a blank page,
per the owner's explicit direction: research the real `mdostal/pantheon`
plugin contract, stub against it, and defer full implementation.

## What's real (confirmed by a full audit of `mdostal/pantheon`, 2026-08-12)

Pantheon's actual plugin system, as it exists today on `main` (checked
against every branch and tag — no "v2" of the plugin architecture, no
numbered integration tiers, and no lifecycle-event mechanism exist anywhere
in that repo as of this writing):

- **`PantheonPlugin`** (`src/lib/pantheon/registry.ts`) — the bare
  registry entry that drives the sidebar/mount page:
  ```ts
  export type PluginMount =
    | { kind: 'route'; href: string }
    | { kind: 'iframe'; port: number; path?: string }
    | { kind: 'placeholder'; note: string };

  export interface PantheonPlugin {
    id: string;
    name: string;
    description: string;
    mount: PluginMount;
    /** Probed server-side; drives the sidebar health dot. */
    healthUrl?: string;
    defaultEnabled: boolean;
  }
  ```
- **`CatalogEntry`** (`src/lib/pantheon/catalog.ts`) — a richer layer with
  an actual (non-numbered) tier concept:
  ```ts
  export type PluginLevel = 'harness-direct' | 'ui' | 'core';
  export type CatalogStage = 'shipped' | 'stub' | 'planned';

  export interface CatalogEntry {
    id: string;
    frameworkId?: string;
    name: string;
    description: string;
    level: PluginLevel;
    stage: CatalogStage;
    standalone: boolean;
    port?: number;
    healthUrl?: string;
    pantheonTab?: string;
    repoPath?: string;
    installHint: string;
    requires?: string[];
    defaultEnabled: boolean;
  }
  ```
- **UI mounting** is one of three kinds: `route` (a first-party Next.js
  page in the Pantheon app itself), `iframe` (a standalone micro-UI on
  another port of the same host — the real working precedent is Delphi,
  `{ kind: 'iframe', port: 7806 }`, rendered via `PluginFrame`), or
  `placeholder` (a reserved slot with no UI yet — this is the Portunus/Vault
  entry's current state, and the precedent this stub follows).
- **No lifecycle events.** Health is a passive, server-side `healthUrl`
  probe (`probeHttp()`, 1.5s timeout, 10s cache) — nothing a plugin
  registers for or emits into. "Install"/"enable" just record an intent /
  flip a boolean in a local config file; no plugin code runs on either.
  Every literal "v2" mention in that repo is a roadmap marker meaning "the
  day someone builds real install/enable execution," not a shipped
  architecture version — worth knowing so this isn't confused with a
  genuine v1→v2 migration.

## The stub

`src/integrations/pantheon.ts` exports two objects, kept separate because
they're two separate layers in the real Pantheon architecture:
`ROLODEX_PANTHEON_PLUGIN` (the leaner `registry.ts` shape, with `mount`) and
`ROLODEX_PANTHEON_CATALOG_ENTRY` (the richer `catalog.ts` shape, cross-
referencing the plugin via `pantheonTab`). Both are modeled directly on the
real Portunus/Vault entries (the closest existing "documented, not-yet-built
plugin" precedent):

- `level: "ui"` — rolodex would be a display surface (contacts/follow-ups),
  not harness-direct or core infrastructure.
- `stage: "stub"` — matches this document's own status.
- `mount: { kind: "placeholder", ... }` — no real mount exists yet. If/when
  this is actually built, the natural real mount is `{ kind: "iframe", port:
  4173 }` (rolodex's shell already runs as a local browser-tab server on
  that port — see the main [`README.md`](../README.md) — so it's a
  same-shape fit for Pantheon's existing iframe mechanism, not a new one).
- `healthUrl` is deliberately left unset rather than pointed at a real
  rolodex endpoint that doesn't yet exist for this purpose — rolodex has no
  dedicated `/healthz` today. Adding one is real, small future work, not
  invented here.

## Aspirational: a deeper ("L2") integration tier + lifecycle events

**Everything in this section is a forward-looking design note, not a
description of anything that exists in Pantheon today.** The owner asked
specifically about "L2 integrations and lifecycle events" — the audit above
confirms neither currently exists in `mdostal/pantheon`, so this is proposed
vocabulary for a future discussion, clearly separated from the real contract
above so nobody mistakes it for current fact.

If Pantheon grows a genuine lifecycle-event system later, a numbered tier
scheme might look like:

- **L1** (today's whole plugin system) — passive display only. A plugin
  mounts (`route`/`iframe`/`placeholder`) and is health-probed from the
  outside; it has no way to push information into Pantheon or react to
  anything happening there.
- **L2** (proposed, not built) — a plugin additionally emits and/or
  subscribes to lifecycle events for tighter dashboard integration, while
  remaining fully optional — Pantheon degrades to L1-style passive display
  if the plugin doesn't implement L2, and rolodex itself never requires
  Pantheon to be present to function. Candidate rolodex hook points, if
  this is ever built:
  - `onFollowUpOverdue` — surface rolodex's `Store.needsFollowUp()` results
    as a Pantheon dashboard widget/notification, via Pantheon polling or
    subscribing rather than rolodex pushing into a Pantheon-owned store.
  - `onContactLogged` — an optional, informational activity-feed entry
    after an interaction is logged in rolodex.
  - `onGoogleSyncComplete` — a lightweight sync-summary surfaced after
    `GoogleSync.pull()` finishes.
- **L3** (proposed, not built) — deep harness-level embedding, closer to
  today's real `level: "harness-direct"` tier but with two-way event flow.
  Not an obvious fit for rolodex, which is intentionally a standalone,
  single-user app — noted here only for completeness of the proposed tier
  scheme, not as a rolodex plan.

None of this is scheduled work. It exists so that if/when Pantheon itself
grows a real lifecycle-event system, rolodex has a concrete, already-thought-
through starting point rather than a cold start.
