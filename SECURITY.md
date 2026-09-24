# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 2.x     | :white_check_mark: |
| < 2.0   | :x:                |

Only the latest `2.x` release line receives security updates.

## Reporting a Vulnerability

**Do not open a public GitHub issue for a suspected vulnerability.**

> Maintainer action required: configure the reporting channel before relying
> on this policy (for example, enable GitHub private vulnerability reporting
> under the repository's Security settings, or designate a private contact).
> Until then, reporters should contact a repository maintainer directly
> through an existing private channel.

A report should include:

- a description of the issue and the affected component or endpoint,
- steps to reproduce against a local build (never against production systems),
- any relevant logs or configuration, with secret values redacted.

Please allow reasonable time for triage before any public disclosure.
Reports that include actual credentials, tokens, or other secret material
cannot be accepted in public issues.

## Scope

In-scope for review: the Express/TypeScript backend (`backend/`), covering
authentication, authorization, inventory, borrowing/return flows, and audit
logging.

Out of scope: production infrastructure, third-party services (Supabase,
Neon, Redis, SMTP providers), and social-engineering or physical attacks.

## Security Process

- Dependencies are monitored via Dependabot and static analysis via CodeQL
  (see `.github/`).
- Security fixes are merged as version-controlled commits and shipped through
  releases; breaking changes are documented in release notes.
