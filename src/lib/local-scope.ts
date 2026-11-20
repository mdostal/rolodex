// Standalone adapter (contacts-memory cm-02).
//
// The standalone app (shell server, MCP server, CLI, Electron) is one
// person's book: it reads and writes exactly `user:local`, the scope every
// pre-scopes (v0.5) row is migrated into. This module is the ONE place that
// ScopeSet is defined; every standalone entry point gets its Store binding
// from `localStore()`.

import type { Scope, ScopeSet } from "./scope.js";
import type { ScopedStore, Store } from "./store.js";

export const LOCAL_SCOPE: Scope = "user:local";

export const LOCAL_SCOPE_SET: ScopeSet = Object.freeze({
  read: Object.freeze([LOCAL_SCOPE]) as readonly Scope[],
  write: LOCAL_SCOPE,
});

/** `store` bound to the standalone ScopeSet. */
export function localStore(store: Store): ScopedStore {
  return store.scoped(LOCAL_SCOPE_SET);
}
