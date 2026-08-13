/**
 * Dormant, unwired stub for a future Pantheon plugin registration. Nothing
 * in rolodex imports this file — rolodex runs entirely standalone with zero
 * Pantheon dependency, and always will be usable that way. This exists so a
 * future integration pass has a concrete, accurate starting point instead of
 * a blank page. See ../../docs/PANTHEON.md for the full writeup, including
 * what's real vs. aspirational in this file and why.
 *
 * The types below are copied (not imported — rolodex has no dependency on
 * the separate mdostal/pantheon repo) from `src/lib/pantheon/catalog.ts` on
 * that repo's `main` branch, confirmed accurate as of 2026-08-12.
 */

/** Copied from mdostal/pantheon's src/lib/pantheon/registry.ts. This is
 * the leaner "registry" layer — what actually drives the sidebar/mount
 * page. A CatalogEntry's `pantheonTab` (below) cross-references a
 * PantheonPlugin's `id` in that repo's real architecture; they're two
 * separate objects there, kept separate here too rather than merged into
 * one inaccurate shape. */
export type PantheonPluginMount =
  | { kind: "route"; href: string }
  | { kind: "iframe"; port: number; path?: string }
  | { kind: "placeholder"; note: string };

export interface PantheonPlugin {
  id: string;
  name: string;
  description: string;
  mount: PantheonPluginMount;
  /** Probed server-side; drives the sidebar health dot. */
  healthUrl?: string;
  defaultEnabled: boolean;
}

/** Copied from mdostal/pantheon's src/lib/pantheon/catalog.ts. The richer
 * "catalog" layer. Real, current vocabulary — NOT the "L1/L2/L3" tiering
 * discussed in docs/PANTHEON.md's aspirational section, which Pantheon does
 * not have. */
export type PantheonPluginLevel = "harness-direct" | "ui" | "core";
export type PantheonCatalogStage = "shipped" | "stub" | "planned";

export interface PantheonCatalogEntry {
  id: string;
  frameworkId?: string;
  name: string;
  description: string;
  level: PantheonPluginLevel;
  stage: PantheonCatalogStage;
  standalone: boolean;
  port?: number;
  healthUrl?: string;
  pantheonTab?: string;
  repoPath?: string;
  installHint: string;
  requires?: string[];
  defaultEnabled: boolean;
}

/**
 * What rolodex's two Pantheon entries would look like today, modeled
 * directly on that repo's real Portunus/Vault stub entries (the closest
 * existing "documented, not-yet-built plugin" precedent). Not registered
 * anywhere — copying these into mdostal/pantheon's actual registry/catalog
 * is the real future step, deliberately not done here.
 */
export const ROLODEX_PANTHEON_PLUGIN: PantheonPlugin = {
  id: "rolodex",
  name: "rolodex",
  description:
    "Local-first relationship rolodex — contacts, verdicts, next steps, and Google Contacts sync, all in one SQLite file the owner controls.",
  mount: {
    kind: "placeholder",
    note: "Reserved mount point for rolodex. No real Pantheon wiring exists yet — see docs/PANTHEON.md. If/when built, the natural real mount is { kind: \"iframe\", port: 4173 } — rolodex's shell already runs as a local browser-tab server on that port (see README.md).",
  },
  // Deliberately unset: rolodex has no dedicated /healthz endpoint today.
  // Adding one is real, small future work — not invented here just to
  // fill this field.
  healthUrl: undefined,
  defaultEnabled: false,
};

export const ROLODEX_PANTHEON_CATALOG_ENTRY: PantheonCatalogEntry = {
  id: "rolodex",
  name: "rolodex",
  description: ROLODEX_PANTHEON_PLUGIN.description,
  level: "ui",
  stage: "stub",
  standalone: true,
  port: 4173,
  healthUrl: undefined,
  pantheonTab: "rolodex",
  installHint: "clone rolodex · npm install · npm run shell",
  requires: [],
  defaultEnabled: false,
};
