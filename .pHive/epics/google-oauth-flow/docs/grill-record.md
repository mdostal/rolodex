# Grill Record — google-oauth-flow

**Source draft:** .pHive/epics/google-oauth-flow/docs/design-discussion.md
**CONTEXT.md substrate:** present
**inconsistency_risk_signals:** present
**round_number:** 1
**unresolved_count:** 0 (all 11 resolved in the revision below)
**Generated:** 2026-08-12T21:00:00Z

## Summary

- Vocabulary mismatches: 1 finding (V1) — resolved
- Hidden assumptions: 2 findings (H1, H2) — resolved
- Unresolved tensions: 2 findings (T1, T2) — resolved
- Convention violations: 2 findings (C1, C2) — resolved
- Security-specific scrutiny: 3 findings (S1, S2, S3) — resolved

## Findings and resolutions

- **V1** — `GOOGLE_OAUTH_TOKEN_KEY` isn't exported from `google-sync.ts`; the
  design's "imports it, unchanged" claim was self-contradictory.
  **Resolved:** export the constant (one-line change, called out explicitly,
  no longer "unchanged"). Distinguished from `GOOGLE_OAUTH_CLIENT_KEY`'s
  deliberate duplication: that rule exists to keep `src/lib` independent of
  `src/shell`; the new module lives in `src/lib` alongside `google-sync.ts`,
  so this is a same-package import, not a cross-boundary one — the
  duplication rationale doesn't apply here.

- **H1 / C2** — the `/callback` path suffix on the loopback redirect_uri was
  never actually confirmed by the cited research; only the bare
  `http://127.0.0.1:<port>` form was. **Resolved:** dropped the path
  suffix — the listener now matches the bare root path only, the only form
  actually confirmed.

- **H2** — unclear how `clientId`/`clientSecret` reach `connectGoogleAccount`.
  **Resolved:** they're passed as plain arguments by the caller
  (`server.ts`'s new route reads and parses `GOOGLE_OAUTH_CLIENT_KEY`
  itself, same as the existing route already does); the new module never
  reads that key directly, keeping it decoupled from how credentials were
  obtained.

- **T1** — §2 flatly claimed "no logic changes" to `pull()`, contradicted by
  §3's later commitment to a small change. **Resolved:** qualified in §2
  with a forward-reference.

- **T2** — Scale Assessment's file list omitted `google-sync.ts` despite §3
  committing to edit it. **Resolved:** added to the file list.

- **C1** — importing `GOOGLE_OAUTH_TOKEN_KEY` runs against the codebase's
  established duplicate-the-literal convention without acknowledging it.
  **Resolved:** addressed together with V1 above — the convention's actual
  rationale (lib/shell independence) doesn't apply to a same-directory
  import, and the doc now says so explicitly instead of silently importing.

- **S1** — listener behavior for a non-matching request (wrong path, bad
  `state`) was unspecified, creating a local interference/DoS surface where
  any stray request could kill the real flow. **Resolved:** any request
  that doesn't match the expected path with a valid `state` gets a generic
  404/400 response and does **not** close the listener or settle the
  promise; only a legitimate matching callback (or the timeout) ends the
  flow.

- **S2** — the `state` CSRF nonce now travels through the spawned `open`
  process's argv (readable by other local accounts via `ps`), unlike the
  existing fixed-URL `open` usage. **Resolved:** documented as an accepted
  risk under this app's single-user-local-machine threat model (same class
  of exposure the OS keychain CLI calls already have), mitigated by the
  nonce being single-use and short-lived — not silently ignored.

- **S3** — the callback response page's content for error/mismatch paths
  was unspecified, leaving open whether it echoes raw query params.
  **Resolved:** the callback response is always one of a small set of fixed,
  static strings (success / denied / state-mismatch / generic-error) — it
  never interpolates any request-derived value, by design, closing the
  reflected-content risk entirely rather than relying on escaping.

## Out of scope (this pass)

Grill does NOT propose solutions, score quality, gate work, or prioritize
findings — resolutions above were authored by the planner (me) in response
to each grill question, not by the grill pass itself.
