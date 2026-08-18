# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately, not in a public issue.

Use GitHub's private vulnerability reporting: **Security → Advisories → Report
a vulnerability** on this repository
(<https://github.com/orchestral-media/orchestral/security/advisories/new>). That
channel is preferred because it keeps the report, the fix and the eventual
advisory in one place, and it works without exposing anyone's email address.

A useful report includes the affected package and version, what an attacker can
do with the issue, and a reproduction — ideally a minimal host built on
`examples/atomic-hello-world`.

## What to expect

This is a single-maintainer project. Response is best-effort: expect an
acknowledgement within about a week, and a fix timeline that depends on
severity and on how much of the fix lives in this repository rather than in a
host application. You will be credited in the advisory unless you ask
otherwise.

Please give a reasonable window for a fix before disclosing publicly.

## Scope

In scope: `@orchestral/core`, `@orchestral/patterns`, `@orchestral/runtime` —
the code in `packages/`.

Out of scope, because the packages deliberately do not own them:

- **Credentials.** Orchestral never reads, stores or transmits API keys. The
  host supplies an already-authenticated model call.
- **Provider SDKs and model behaviour.** No provider SDK is a dependency;
  report those upstream.
- **Host storage and asset resolution.** Asset handles are opaque identifiers
  the host resolves — path traversal or access control on the host's asset
  store is the host's boundary.
- **Prompt injection through model output.** Patterns pass model text through;
  a host that grants a model authority over side effects owns that decision.

Reports about `examples/` are welcome but are treated as documentation bugs —
those hosts are illustrative and not published to npm.

## Supported versions

Only the latest published `0.x` release line receives fixes. There are no
backports to earlier versions.
