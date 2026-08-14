# Research Brief: portunus-secrets-backend

## Summary

`SecretsAdapter` (`src/lib/secrets-adapter.ts`) was explicitly designed as a
pluggable interface with exactly one real backend today (macOS Keychain via
the `security` CLI). The owner has repeatedly named a second backend,
Portunus, as the intended second implementation. This epic adds it for
real, plus a real install-time choice between backends — not a stub.

**Portunus is confirmed real and dogfoodable** (full audit: cloned
`mdostal/portunus`, `pip install -e ".[test]"`, 357/357 tests passing, and
personally exercised `portunus drop` → `portunus state enabled` →
`portunus resolve` end to end against a real, isolated `PORTUNUS_HOME`).
141 commits, MIT-licensed, real CLI entry point, version 0.13.1 at clone
time (confirmed 0.14.0 now installed on this machine via `portunus
--version` during a later review pass — active project, expect continued
drift; pin exact behavior verification to whatever version is installed
at implementation time, not this document).

## The real Portunus contract (confirmed by running it, not reading docs)

Portunus has **no "get secret by key → plaintext string" API** — by
deliberate design, a resolved value is never returned up the call stack to
arbitrary caller code. Only these boundary patterns exist:

- **Tempfile mode**: `portunus resolve "{{secret:NAME}}"` → prints a
  `0600`-permission temp-file **path** to stdout (not the value). Caller
  reads the file, then must delete it.
- **Exec mode**: `portunus resolve --exec <argv...>` — substitutes
  `{{secret:NAME}}` into a child process's own argv and execs it directly;
  the value never returns to the caller at all. Not useful for rolodex,
  which needs the string in-process (e.g. to build a `google.auth.OAuth2`
  client), not to exec a new child process.
- **Python-library-only**: `Resolver.resolve_call(template, boundary=callable)`
  — not reachable from Node without an MCP client (see below).

**Writing** is CLI-only, deliberately no `--value` flag (value must come via
stdin, never argv, to avoid shell-history/`ps` leakage):
```
portunus drop <name> <sm_name> --stdin      # lands as state=dropped (fail-closed)
portunus state <name> enabled               # required before it's resolvable
portunus reg rm <name>                      # removal
```

There's also a `portunus mcp` stdio server, built for LLM/agent callers —
not the right fit here (a heavy dependency for what's otherwise a couple of
CLI calls, and rolodex's own MCP server is a separate concern).

**Implication for a rolodex adapter**: this is architecturally similar to
the existing Keychain adapter (`execFile`-based shell-out, no new npm
dependency) but a materially different shape — a `get()` needs to run
`resolve`, read the printed tempfile path, read that file's contents, then
delete it; a `set()` needs two sequential CLI calls (`drop` then
`state enabled`), not one.

## Real current code this touches

- **`src/lib/secrets-adapter.ts`** — `SecretsAdapter` interface
  (`get`/`set`/`delete`, each with `{signal?: AbortSignal}`),
  `createKeychainSecretsAdapter()` (the pattern to mirror: `execFile` with
  an argv array, never a shell string; `sanitizeSetError()` strips argv
  before any error can leak a secret to a log), `createInMemorySecretsAdapter()`,
  `withInMemoryFallback()` (wraps a real adapter so a first-call failure
  permanently swaps to in-memory for the rest of the process, with an
  `onFallback` hook), and the `createSecretsAdapter(opts)` factory —
  currently hardcoded to Keychain-or-in-memory-fallback, Darwin-only.
- **`src/lib/secrets-check.ts`** — `checkSecretsCapability(factory)`: a
  real (not simulated) round-trip probe (set → get → delete a throwaway
  key) used by the wizard's capability-check screen. Already
  factory-injectable and already mostly backend-agnostic in structure —
  the one thing that needs to change is that `SecretsCheckResult.backend`
  is currently a hardcoded `"macOS Keychain"` string in every branch, not
  derived from which backend was actually probed.
- **`src/shell/db-location.ts`** — the real precedent for a wizard-set,
  non-secret preference: `wizard-config.json` at
  `~/.local/share/rolodex/wizard-config.json` (plain JSON, gitignored
  `.local/` territory, not routed through `SecretsAdapter` since a path
  isn't sensitive). `getDbPathOverride`/`setDbPathOverride`/
  `clearDbPathOverride`, all `homeDir`-parameterized purely for test
  isolation. This module's own doc comment explicitly states the layering
  rule: "`Store` (the 'core' layer) must keep knowing nothing about a
  specific user's config... This module is the 'your layer' piece."
- **`src/shell/server.ts:135`** — `const secrets = opts.secrets ??
  createSecretsAdapter();` — called **synchronously**, at server-construction
  time, `createRolodexServer()` itself is a synchronous function (returns
  `Server`, not `Promise<Server>`). This is the real architectural
  constraint: there is no `await` available at this call site today, but
  resolving a persisted backend choice from `wizard-config.json` requires
  an async file read.
- **`src/shell/wizard.html`** — confirmed real screen order by reading the
  actual `navigate()` calls: **welcome → database → google → secrets →
  finish**. The "secrets" (capability-check) screen currently runs *after*
  "google" (which already calls `secrets.set()` to save the OAuth client
  id/secret) — meaning today's capability check is a post-hoc confirmation,
  not a pre-flight gate. Introducing a real backend *choice* requires that
  choice to be made and persisted *before* the "google" screen runs, since
  that screen's `secrets.set()` call needs to already be using the chosen
  backend.

## Constraints

- No new npm dependency — `execFile`-based shell-out, matching the existing
  Keychain adapter's own justification for avoiding a native module
  (per-platform prebuild risk) or an unmaintained one (`keytar`).
- Portunus itself is a separate, independently-installed program (Python
  CLI) — not bundled with rolodex. The wizard must detect whether it's
  actually present (`portunus` on `PATH`, runnable) before offering it as a
  choice; falling back silently to Keychain-only when it's absent, exactly
  like the existing platform-based fallback already does for non-Darwin.
- `createSecretsAdapter()`'s exported signature is used elsewhere
  synchronously (`src/shell/server.ts:135`, `src/lib/secrets-check.ts`'s
  default factory param) — changing it to return a `Promise<SecretsAdapter>`
  would ripple into every call site. Worth treating as an explicit design
  decision (keep it sync + lazily resolve the choice on first real call,
  vs. make it async and touch every caller) rather than deciding silently.
- Every rolodex secret write already goes through `sanitizeSetError()`-style
  argv-scrubbing before any error can reach a log sink — a Portunus adapter
  needs the equivalent discipline (its own CLI calls involve tempfile paths
  and stdin, a different leak surface than Keychain's argv-embedded `-w`
  value, but a real one: e.g. what happens if `delete()` on the tempfile
  fails partway).

## Open questions (for design-discussion to resolve, not silently decide)

1. **Sync vs. async `createSecretsAdapter()`.** Keep the exported factory
   synchronous and lazily resolve the persisted backend choice on first
   real `get`/`set`/`delete` call (mirrors the existing
   `withInMemoryFallback` wrapper's own "decide the real backend on first
   use" shape) — or make it genuinely async and update the (few) call
   sites?
2. **Where does backend-choice persistence live?** `wizard-config.json`
   (extending the existing file, `src/shell` layer) vs. a new file — and
   does `src/lib/secrets-adapter.ts` read that shell-layer file directly
   (crossing the explicit core/your-layer boundary `db-location.ts`'s own
   comment calls out), or does the shell layer resolve the choice and pass
   it into `createSecretsAdapter(opts)` as an explicit option?
3. **Wizard screen reorder.** Move the existing "secrets" (capability-check)
   screen earlier (before "google"), and fold the backend *choice* into it
   — vs. add a distinct new screen. Reordering touches real, already-tested
   wizard navigation; scope this precisely.
4. **Tempfile handling for `get()`.** Portunus's tempfile mode is a
   real, if narrow, leak surface: a value briefly exists as a `0600` file
   on disk. Read-then-delete must be robust (deletion must happen even if
   the read throws) and should probably use a dedicated temp directory /
   explicit cleanup-on-error path, not assume the happy path.

## Risks

- **Medium** — genuinely new shell-out surface with a materially different
  contract than the existing Keychain adapter (multi-step writes, tempfile
  reads). Real risk of a leaked secret via an incompletely-cleaned-up
  tempfile or an error path that echoes a stdin-supplied value.
- **Medium** — the wizard reorder touches already-tested, working
  navigation (`onConnect()`'s Google-connect flow, the existing
  capability-check screen) — needs care not to regress it.
- **Low** — detection-of-Portunus-availability failing open (offering the
  choice when it's not actually usable) vs. failing closed (silently never
  offering it even when it would work) — needs an explicit, tested answer,
  not an assumption.

## Inconsistency risk signals

**present** — for the grill pass to focus on:

- The sync/async factory-signature question (open question 1) has two
  real, defensible answers with different blast radii — the design must
  pick one explicitly and justify it, not hand-wave past it.
- The tempfile read/delete path (open question 4) is exactly the kind of
  "looks fine on the happy path" surface that has produced real, found-by-
  review bugs elsewhere in this project (the OAuth epic's race condition,
  the wizard's disabled-fields bug) — deserves the same scrutiny.
