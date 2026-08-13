/**
 * Dormant, unwired stub for a future Pantheon plugin registration. Nothing
 * in rolodex imports this file — rolodex runs entirely standalone with zero
 * Pantheon dependency, and always will be usable that way. This exists so a
 * future integration pass has a concrete, accurate starting point instead of
 * a blank page. See ../../docs/PANTHEON.md for the full writeup, including
 * a note on an earlier version of this file that was researched against the
 * wrong repo.
 *
 * The types below mirror (not import — rolodex has no dependency on the
 * separate mdostal/pantheon-v2 repo, and that repo's contracts are Zod
 * schemas, not plain TypeScript types) `contracts/l2/*.ts` on that repo's
 * `main` branch, confirmed accurate as of 2026-08-12.
 */

/** Mirrors pantheon-v2's contracts/l2/service-descriptor.ts
 * ServiceDescriptorSchema. Describes a long-lived local service — the
 * closest fit for rolodex's shell server (src/shell/server.ts). */
export interface PantheonServiceDescriptor {
  id: string;
  type: "service";
  capabilities: string[];
  health_endpoint: string;
  api_version: string;
  port: number;
  transport: "http" | "ndjson-stdio" | "grpc";
}

/** Mirrors pantheon-v2's contracts/l2/dashboard-component-descriptor.ts.
 * NOT used by this stub — see docs/PANTHEON.md for why a `service` +
 * `proxy` web-plugin pairing fits rolodex better than a dashboard
 * component today (the React-component mount path this descriptor feeds
 * is real in manifest shape but still renders a generic placeholder for
 * every registered example in that repo, per its own janus-plugin/loader.tsx). */
export interface PantheonDashboardComponentDescriptor {
  id: string;
  type: "dashboard-component";
  capabilities: string[];
  mount_point: string;
  props_schema: Record<string, unknown>;
  event_subscriptions: string[];
}

/** Mirrors pantheon-v2's contracts/l2/plugin-descriptor.ts
 * PluginRegistryEntrySchema — the wrapper object that actually goes into
 * that repo's pantheon.plugins.yaml. Third-party plugins (not one of the
 * "gods") register here; gods use a separate pantheon.gods.yaml instead. */
export interface PantheonPluginRegistryEntry {
  id: string;
  type: "runner" | "service" | "dashboard-component" | "tool";
  repo: string | null;
  /** semver, matches pantheon-v2's own validation regex. */
  version: string;
  /** Required (non-nullable) by the real schema, even though nothing here
   * has ever actually been installed — see this field's value below. */
  installed_at: string;
  updated_at: string;
  enabled: boolean;
  dependencies: string[];
  descriptor?: PantheonServiceDescriptor | PantheonDashboardComponentDescriptor;
  /** Required by the real schema — see this field's value below. */
  local_path: string;
  port?: number;
  notes?: string;
}

/** Mirrors pantheon-v2's pantheon.web-plugins.json `proxy`-kind entries —
 * the real, working mount mechanism every actual god with a real UI uses
 * today (full reverse-proxy of a standalone running app under a basePath,
 * via that repo's lib/proxy-handler.ts). This is the fit for rolodex: it
 * already runs as its own standalone local server (see README.md), not a
 * React component to embed. */
export interface PantheonWebPluginProxyEntry {
  id: string;
  kind: "proxy";
  basePath: string;
  proxyTo: string;
  enabled: boolean;
  nav?: { label: string; icon?: string };
}

/**
 * What rolodex's three pantheon-v2 registration objects would look like
 * today — an L2 service descriptor, its registry wrapper, and its web-plugin
 * proxy mount — modeled on the real `cadex` reference plugin (the closest
 * existing service+proxy precedent in that repo). Not registered anywhere —
 * copying these into pantheon-v2's actual `pantheon.plugins.yaml` and
 * `pantheon.web-plugins.json` is the real future step, deliberately not
 * done here.
 */
export const ROLODEX_PANTHEON_SERVICE_DESCRIPTOR: PantheonServiceDescriptor = {
  id: "rolodex",
  type: "service",
  capabilities: ["contacts", "relationship-tracking", "follow-ups"],
  // Deliberately a placeholder path: rolodex has no dedicated /health
  // endpoint today. Adding one is real, small future work on rolodex's own
  // side — not invented here just to fill this field. pantheon-v2's
  // ServiceDescriptor requires a real URL, so this is left as an obviously
  // fake value rather than a plausible-looking one that could be mistaken
  // for real.
  health_endpoint: "http://127.0.0.1:4173/health-not-implemented-yet",
  api_version: "v1",
  port: 4173,
  transport: "http",
};

export const ROLODEX_PANTHEON_REGISTRY_ENTRY: PantheonPluginRegistryEntry = {
  id: "rolodex",
  type: "service",
  repo: "https://github.com/mdostal/rolodex",
  version: "0.4.0",
  // Placeholder timestamps — the schema requires a real ISO datetime, but
  // nothing here has ever actually been installed. Epoch is used rather
  // than "now" so it reads unambiguously as fictitious, not as a real
  // install record.
  installed_at: "1970-01-01T00:00:00.000Z",
  updated_at: "1970-01-01T00:00:00.000Z",
  enabled: false,
  dependencies: [],
  descriptor: ROLODEX_PANTHEON_SERVICE_DESCRIPTOR,
  // Placeholder path — the schema requires a real string, but this has
  // never actually been installed into a pantheon-v2 checkout.
  local_path: "(not installed)",
  port: 4173,
  notes: "Stub only — not registered in pantheon-v2. See docs/PANTHEON.md.",
};

export const ROLODEX_PANTHEON_WEB_PLUGIN: PantheonWebPluginProxyEntry = {
  id: "rolodex",
  kind: "proxy",
  basePath: "/rolodex",
  proxyTo: "http://127.0.0.1:4173",
  enabled: false,
  nav: { label: "Rolodex" },
};

/**
 * Mirrors pantheon-v2's contracts/l1's `L1Event` envelope
 * (core/events/bus.ts) — the real, working cross-process event mechanism
 * (fire-and-forget webhook POST to registered subscribers, proven by that
 * repo's real Consus -> Minerva `decision:created` flow). NOT the same as
 * that repo's plugin:install/enable/disable/remove events, which fire on
 * an in-process bus a separate plugin process cannot subscribe to directly.
 *
 * Candidate event types rolodex could emit if this is ever wired up —
 * real envelope shape, hypothetical payloads/types (rolodex does not emit
 * any of these today; this is a design note, not a claim of current
 * behavior). Emitting would mean rolodex POSTs one of these to a
 * pantheon-v2 Core webhook route; receiving-side subscription registration
 * happens on pantheon-v2's own side, per that repo's real architecture —
 * so full wiring is future work on both repos, not just this one.
 */
export interface PantheonL1EventEnvelope<TPayload = Record<string, unknown>> {
  type: string;
  payload: TPayload;
  timestamp: string;
  source: string;
  correlationId: string;
}

export type RolodexPantheonEventType =
  | "rolodex:follow-up-overdue"
  | "rolodex:contact-logged"
  | "rolodex:google-sync-completed";
