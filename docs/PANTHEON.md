# Pantheon integration (future, stub only)

This document — and the dormant, unwired stub at
[`src/integrations/pantheon.ts`](../src/integrations/pantheon.ts) — is
deliberately **not a real integration**. Nothing in rolodex imports or
registers this file today; rolodex runs entirely standalone with zero
Pantheon dependency, and always will be usable that way.

## Correction

An earlier version of this document was researched against
`mdostal/pantheon` — an older, private dashboard repo (forked from
Claud-ometer). That repo has no "v2," no numbered integration tiers, and no
lifecycle-event system, and its content was written up here as the real
contract, with an explicitly-aspirational section proposing what "L2" +
lifecycle events might look like someday.

That was the wrong repo. The owner's actual "Pantheon v2" is a **separate**
private repo, `mdostal/pantheon-v2` — *"the contract/wrapper/interface host
that binds the standalone gods (Consus, Heimdall, Auriga, Minerva, Argus,
Portunus) into one system."* It supersedes the older repo entirely (that
repo's own content has since been vendored into pantheon-v2 as a plugin,
`plugins/claud-ometer-upstream`, per pantheon-v2's own
`docs/intro/prior-attempts.md`). This document now reflects **that** repo,
confirmed by cloning it and reading real code — not the older one.

## What's actually real in `pantheon-v2` (confirmed 2026-08-12, `main`)

**"L2" is not a trust/access tier — it's a capability-descriptor layer.**
`contracts/l2/plugin-descriptor.ts` defines a discriminated union describing
*what kind of thing* a plugin is:

```ts
// Zod schemas in the real repo; shown here as their inferred shape.
type ServiceDescriptor = {
  id: string;
  type: "service";
  capabilities: string[];
  health_endpoint: string; // real URL
  api_version: string;
  port: number;
  transport: "http" | "ndjson-stdio" | "grpc";
};

type DashboardComponentDescriptor = {
  id: string;
  type: "dashboard-component";
  capabilities: string[];
  mount_point: string;
  props_schema: Record<string, unknown>;
  event_subscriptions: string[];
};

// A third variant, RunnerDescriptor (invoke-and-return, call.{start,poll,
// status,output}), is explicitly flagged in that repo's own docs as
// unproven — no real committed example exists. Not used by this stub.
```

The wrapper that actually goes into `pantheon.plugins.yaml` (third-party
plugins register here; the "gods" themselves use a separate
`pantheon.gods.yaml` instead):

```ts
type PluginRegistryEntry = {
  id: string;
  type: "runner" | "service" | "dashboard-component" | "tool";
  repo: string | null;
  version: string; // semver
  installed_at: string; // ISO datetime
  updated_at: string;
  enabled: boolean;
  dependencies: string[];
  descriptor?: ServiceDescriptor | DashboardComponentDescriptor; // (or RunnerDescriptor)
  local_path: string;
  port?: number;
  notes?: string;
};
```

Real precedent, closest analog to rolodex: `plugins/cadex` — a standalone
reference plugin proving the `service` + separate `dashboard-component`
descriptor pattern (one plugin, two descriptors, one per concern).

**Lifecycle events are real, but not the mechanism the "L2" naming might
suggest.** Two separate things exist under a shared "L1" name — worth not
conflating, per that repo's own docs flagging this exact confusion:

1. **In-process only.** Pantheon Core emits `plugin:install` / `plugin:enable`
   / `plugin:disable` / `plugin:remove` on an in-process `EventEmitter`
   when an operator installs/enables/disables/removes a plugin. A separate
   plugin process (like rolodex would be) **cannot subscribe to this
   directly** — it only exists inside Core's own Node process.
2. **Real, working, cross-process.** An `L1Event` envelope
   (`{type, payload, timestamp, source, correlationId}`) delivered by a
   plugin `POST`ing its own payload to a Core webhook route; Core wraps it,
   looks up subscribers, and does a fire-and-forget `POST` to each
   subscriber's registered `callbackUrl` — **no delivery guarantee**,
   failures are logged, never raised back to the sender. Proven working via
   a real Consus → Minerva `decision:created` example
   (`docs/cross-god-event-flow.md`). **Receiving-side subscription
   registration happens on Core's own side**, not inside the emitting
   plugin's repo — so a receiver isn't something rolodex could set up
   unilaterally even if it wanted to.

**UI mounting — two mechanisms, only one proven with real content.**
- `kind: "proxy"` — full reverse-proxy of an entire standalone running app
  under a basePath (`{id, kind:"proxy", basePath, proxyTo, enabled, nav}`,
  via that repo's `lib/proxy-handler.ts`). **Real and working** — every
  actual god with a real UI (Heimdall, Consus, Auriga, Minerva, Argus,
  Mnemosyne, Janus) is mounted exactly this way today.
- `kind: "plugin"` — a mountable React-component manifest, validated
  against a JSON Schema, with real registered examples for several gods.
  **Manifest-shape real, content not real yet** — that repo's own
  `janus-plugin/loader.tsx` maps every single registered plugin ID
  (including the "god" ones) to the same generic placeholder component;
  nothing renders real content through this path yet.

Since rolodex is a standalone local server with its own UI (not a React
component to embed), `proxy` is both the closer conceptual fit **and** the
one with a real, working precedent — unlike the `plugin`/React path, which
is scaffold today. This stub uses `proxy`.

## The stub

`src/integrations/pantheon.ts` exports:
- `ROLODEX_PANTHEON_SERVICE_DESCRIPTOR` — a `service`-type L2 descriptor,
  modeled on `cadex`'s.
- `ROLODEX_PANTHEON_REGISTRY_ENTRY` — the `pantheon.plugins.yaml`-shaped
  wrapper around it.
- `ROLODEX_PANTHEON_WEB_PLUGIN` — a `proxy`-kind `pantheon.web-plugins.json`
  entry, pointed at rolodex's existing shell server (port `4173`, see
  [`README.md`](../README.md)).
- `PantheonL1EventEnvelope` + `RolodexPantheonEventType` — the real event
  envelope shape, plus **candidate** event names rolodex could emit if this
  is ever wired up (`rolodex:follow-up-overdue`, `rolodex:contact-logged`,
  `rolodex:google-sync-completed`). Rolodex does not emit any of these
  today — this is a design note, not a claim of current behavior. Emitting
  for real means rolodex `POST`s to a pantheon-v2 Core webhook route;
  actually *receiving* them requires a subscription registered on
  pantheon-v2's own side, which is future work on both repos, not just
  this one.

`health_endpoint` is deliberately left as an obviously-fake placeholder URL
rather than a plausible-looking one — rolodex has no dedicated `/health`
endpoint today, and pantheon-v2's schema requires a real URL string. Adding
a real health endpoint is small, genuine future work on rolodex's own side,
not invented here.

None of this is scheduled work, and nothing here is registered in either
repo. It exists so a future integration pass — on either side — has an
accurate, code-verified starting point instead of a cold start.
