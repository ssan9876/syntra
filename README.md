# Syntra

Open-source Identity and Access Management. Syntra gives an organization one
place to hold its people, decide what they may reach, and hand them a single
front door to every application they use.

It is modeled on the shape of a commercial cloud IAM suite, rebuilt as
self-hostable software under Apache-2.0.

## Status

Early development. The platform Core is being built first; see
`docs/superpowers/plans/2026-08-14-syntra-core.md` for the task-by-task plan and
`docs/superpowers/specs/2026-08-14-syntra-core-access-design.md` for the design.

## Modules

| Module | Status | Contents |
|---|---|---|
| **Core** | in progress | Multi-tenancy, directory, persons and contracts, RBAC, audit log, secrets vault, scheduler, notifications |
| **Access** | planned | SAML 2.0 IdP, OpenID Connect provider, upstream federation, application catalog, MFA, authentication policies |
| **Provision** | planned | Source systems, business rules, evaluation and enforcement, target systems, entitlements |
| **Automate** | planned | Product catalog, self-service requests, approval workflows, delegated forms |
| **Govern** | planned | Reconciliation, segregation of duties, recertification campaigns |

## Getting started

Requires Node 22 or later, pnpm 9, and Docker.

```bash
pnpm install
pnpm db:up          # PostgreSQL 16 and MailDev
pnpm db:migrate
pnpm test
```

## License

Apache-2.0. See [LICENSE](LICENSE).
