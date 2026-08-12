# Security Policy

## Scope

rolodex is a local-first, single-user application. There is no hosted
service, no multi-tenant backend, and no server-side secret store — your
contact data lives in a SQLite file on your own machine, and OAuth
credentials (if you connect Google Contacts) are stored in your OS
keychain via a pluggable `SecretsAdapter`, never in a file, environment
variable, or log.

That said, real security issues still apply here, including but not
limited to:

- The local HTTP server (`src/shell/server.ts`) binding to more than
  `127.0.0.1`, or otherwise becoming reachable off-machine
- Path traversal or injection in any local server route
- Credentials (OAuth tokens, keychain values) leaking into logs, error
  messages, or files
- A dependency with a known exploitable vulnerability
- Any way local data could be exfiltrated without the user's action

## Supported Versions

This project is pre-1.0 and moves quickly. Only the latest published
release on `main` / npm is supported — please upgrade before reporting.

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security reports.

Instead, use GitHub's private vulnerability reporting: go to the
[Security tab](https://github.com/mdostal/rolodex/security) of this
repository and select **"Report a vulnerability."** This opens a private
advisory visible only to the maintainer until a fix is ready.

Include, where possible:

- A description of the issue and its potential impact
- Steps to reproduce (or a proof-of-concept)
- The version/commit you tested against

You should expect an initial response within a few days. Once a fix is
available, a new release will ship along with a public advisory crediting
the reporter (unless you'd prefer to stay anonymous).
