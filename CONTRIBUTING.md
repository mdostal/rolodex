# Contributing to rolodex

Thanks for considering a contribution. rolodex is young and still moving
fast, so it's worth opening an issue to discuss anything non-trivial
before sending a PR — it saves both of us rework.

## Getting set up

Requires Node >= 22 (this project uses `node:sqlite`, which needs the
`--experimental-sqlite` flag — already wired into the npm scripts below).

```sh
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run shell        # run the standalone app locally
npm run dev          # run the MCP server locally (stdio)
```

## Making a change

1. Fork/branch from `main`.
2. Make your change. Match the codebase's existing conventions:
   - `Store` is the only thing that talks to SQLite — don't reach around it.
   - No silent guesses: don't invent field values a caller didn't provide.
   - Local-only fields (`verdict`, `angle`, `nextStep`) must never be
     overwritten by a Google Contacts sync — see
     `mergeLocalOnlyFields`/`findExistingMatch` in `src/lib/google-sync.ts`
     if you're touching sync logic.
   - Secrets (OAuth tokens, etc.) go through `SecretsAdapter` — never a
     plain file, env var, or log line. If your change could touch an
     error path near a secret, double-check nothing leaks into a thrown
     error's `.message` (see `sanitizeSetError` in
     `src/lib/secrets-adapter.ts` for the pattern).
3. Add or update tests. Prefer real behavior over mocks — most of this
   codebase tests against a real `Store` backed by a temp SQLite file
   rather than mocking the database; `GoogleSync` tests inject a fake
   People API client via dependency injection rather than mocking `fetch`.
4. Run `npm run typecheck && npm test` and make sure both are clean.
5. Open a PR against `main` with a clear description of what changed and
   why. CI (typecheck + test) runs automatically on every PR.

## Reporting bugs / requesting features

Open a GitHub issue. For security issues, see [SECURITY.md](./SECURITY.md)
instead — please don't file those as public issues.

## Code of Conduct

This project follows the [Code of Conduct](./CODE_OF_CONDUCT.md).
