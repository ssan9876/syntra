# Syntra

Open-source Identity and Access Management. Syntra gives an organization one
place to hold its people, decide what they may reach, and hand them a single
front door to every application they use.

Self-hosted, multi-tenant, Apache-2.0.

## Status

The platform **Core** is built and tested: multi-tenancy, a directory, the
person and contract model, role-based access control, a tamper-evident audit
log, a secrets vault, a job scheduler, notifications, and an administration
console. **Directory Sync** is also built: an LDAP source can be read,
mapped, and correlated against the directory, with every run previewed as a
reviewable diff and guarded against mass deactivation before anything is
applied. **Access** is built: one authentication chokepoint, an ordered
authentication policy, TOTP and WebAuthn second factors with recovery codes,
self-service password reset, an application catalog the portal launches from,
and the federation protocols — Syntra is a SAML 2.0 identity provider and an
OpenID Connect provider, and can delegate authentication upstream to either.
**Provision**, **Automate** and **Govern** are built too: business rules
evaluated against target systems, a self-service catalog with approval
workflows and delegated management, and reconciliation, segregation of duties
and recertification campaigns over the lot. Provision's other half is built as
well — the **HR feed**, which reads a nightly export over SFTP and keeps the
person register in step with it, so the joiner–mover–leaver lifecycle starts
where the organization actually records it rather than at a CSV somebody
uploads.

| Module | Status | Contents |
|---|---|---|
| **Core** | built | Multi-tenancy, directory, persons and contracts, RBAC, audit log, secrets vault, scheduler, notifications with webhook endpoints for Automate, Govern and security events, an optional Prometheus endpoint, scheduled backups that verify themselves by restoring, web console. Users, groups, org units and people can be created, edited and deactivated from the console — never deleted |
| **Directory Sync** | built | **Inbound SCIM 2.0**: an identity provider pushes users and groups to `/scim/v2`, authenticating with a machine token, and what it pushes is owned by the source that pushed it — the push counterpart to the pull connectors, not a replacement for them. LDAP/OpenLDAP connector over LDAPS or StartTLS, attribute mapping and correlation, previewed diffs, a mass-deactivation guard, scheduled and on-demand runs, and console screens for the lot: a source editor with a connection test, a mapping editor, and a run review with per-change skip and partial apply |
| **Access** | built | Application catalog and assignments, authentication policy, TOTP and WebAuthn second factors, recovery codes, self-service password reset, step-up MFA for the console, a session inventory an administrator or the person themselves can revoke from, and API tokens for machines — issued against a service account, bounded by the intersection of its roles and the token's scopes, and refused by the same `authorize()` as everybody else. **SAML 2.0 identity provider**: both bindings, SP-initiated and IdP-initiated, signed assertions, optional encryption, front-channel single logout, metadata by upload or URL. **OpenID Connect provider**: authorization code with PKCE, refresh-token rotation, discovery, JWKS with overlapping rotation, UserInfo, RP-initiated logout, working token revocation and introspection, back-channel logout to relying parties that ask for it, and a bounded client-credentials grant. **Upstream federation**: Syntra as a SAML service provider and as an OIDC relying party, with just-in-time provisioning and policy-driven routing. Every path reaches the same `authorize()`. See [what it does not do](docs/configure.md#what-the-federation-half-does-not-do) |
| **Provision** | built | Source systems, business rules, evaluation and enforcement, target systems and entitlements, previewed runs in the same idiom as Directory Sync. Org units drive placement: materialise a unit against a target and the accounts of everyone in it are created in that container, which Provision creates where an administrator asked for it by name and never to satisfy a template |
| **Provision — Sources** | built | The HR feed. A delimited export read over SFTP on a schedule, with the server's host key pinned and no trust-on-first-use, mapped onto persons and contracts, and previewed as a reviewable diff with per-change skip and partial apply. Two guards stand between a bad export and the register: one measures what a run does against what its own source owns, the other whether the person register itself is collapsing. Absence means a leaver only for a source declared to carry a full snapshot — never for a delta, never for a row that was read but could not be mapped, and never at all on a run whose failures cannot be attributed to anybody, which is what a renamed column looks like |
| **Automate** | built | Product catalog, self-service requests, approval workflows, resource delegation so a team lead manages a group without an administrative session, and an expiry sweep with a proportional guard |
| **Govern** | built | Reconciliation, segregation of duties, recertification campaigns, a tamper-evident snapshot chain with optional signing and anchoring |

Design and plan documents live in [`docs/superpowers/`](docs/superpowers).

## How it is put together

```
apps/
  api/        Fastify: REST API, the SAML and OIDC endpoints, and federation
  web/        One React application - portal at /, console at /admin
packages/
  db/         Prisma schema, migrations, the withTenant helper
  core/       Domain services; knows nothing about HTTP
  contracts/  Zod schemas shared by the API and the web app
  ui/         Design system
```

Three decisions shape everything else:

**Tenant isolation is enforced by PostgreSQL, not by application code.** Every
tenant-scoped table has `FORCE ROW LEVEL SECURITY` and the application connects
as a non-superuser role without `BYPASSRLS`. A query written without a `where`
clause returns nothing rather than another tenant's rows, and there is a test
that proves it by asking for exactly that.

**A person is not an account.** `Person` is who someone is, `Contract` is what
they do, and `User` is how they sign in. A contractor with two simultaneous
engagements, an employee who moves department mid-year, and a service account
with nobody behind it are all representable.

**Every authentication goes through one function.** `authorize()` in
`packages/core/src/auth/authorize.ts` is the only path that establishes who a
caller is, so policy and auditing live in one place instead of being
reimplemented per protocol. Sign-in, elevation to the console and every
application launch all go through it, and in Access II every protocol adapter
does too.

## Quickstart (development)

Requires Node 22+ and Docker; `corepack enable` picks up the pinned pnpm.

```bash
pnpm install
pnpm db:up
cp .env.example .env && cp packages/db/.env.example packages/db/.env
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"  # run twice, for SESSION_SECRET and MASTER_KEY in .env
pnpm db:generate && pnpm db:migrate
SEED_ADMIN_PASSWORD='choose-a-long-one' SEED_USER_PASSWORD='choose-another-one' pnpm seed
pnpm dev                                    # api on :3000, web on :5173
```

Open **http://acme.localhost:5173** and sign in as `admin`. Full walkthrough,
including why the two `.env` copies and the generate-before-migrate ordering
matter, in [Install](docs/install.md).

## Running it for real

`pnpm dev` is a development server and does not belong in front of real
users. Either build the application and run it as one process
(`pnpm build && WEB_ROOT=apps/web/dist pnpm start`), or use the container
path: `docker-compose.yml` runs published images behind Postgres and nginx,
with a `docker-compose.tls.yml` overlay for automatic TLS. See
[Install](docs/install.md) for both, and [Configure](docs/configure.md) for
every environment variable involved.

## Documentation

- [docs/install.md](docs/install.md) — development install, the container
  path, TLS, the single-process alternative.
- [docs/configure.md](docs/configure.md) — every environment variable,
  tenants and hostnames, directory sources, signing in, second factors,
  policy, and SSO/federation configuration and its known limits.
- [docs/operate.md](docs/operate.md) — upgrades, backups,
  deactivate-never-delete, CI, tests, troubleshooting.
- [docs/lab/](docs/lab/) — a complete worked build: Syntra over HTTPS, an
  Active Directory domain behind it, sync in both directions, and SAML single
  sign-on to a third-party application.

## Deactivate, never delete

There is no Delete anywhere in the directory, and that is a design decision
rather than an omission: deactivating a user, group or org unit revokes real
access — **grants nothing** — while keeping the trail of who had what and why
it changed, so reactivating puts back exactly what was there. Full detail,
including the two deliberate exceptions, in
[Operate](docs/operate.md#deactivate-never-delete).

## Access, second factors and federation

Every sign-in, elevation and application launch goes through one
`authorize()` in `packages/core/src/auth/authorize.ts`, so policy and
auditing live in one place instead of being reimplemented per protocol.
Syntra is a SAML 2.0 identity provider and an OpenID Connect provider, with
TOTP and WebAuthn second factors, self-service password reset, and upstream
federation to another SAML or OIDC provider. Taking access away goes through
one function too: revoking a session — by an administrator, by the person, or
by a password reset, a deactivation or a sync-driven leaver — revokes the
refresh tokens with it and sends a signed logout token to every OIDC relying
party that asked to hear about it. What each of those does, what they
deliberately don't (SAML single logout propagation, SAML key rotation, a
consent screen), the audit events they emit, and the one exemption to
`authorize()` (the OAuth 2.0 client credentials grant) are all in
[Configure](docs/configure.md#access-signing-in-second-factors-and-policy).

## Tests

```bash
pnpm test                       # domain, API and database integration tests
pnpm test:watch                 # the same suite, watching
pnpm --filter @syntra/web test  # web component tests
pnpm e2e                        # browser tests against a running stack
pnpm typecheck                  # tsc -b, no emit
```

The integration tests run against a real PostgreSQL in Docker — not mocked,
because the properties worth testing here (row-level security, a partial
unique index, an append-only rule) only exist in the database. CI, the
privileged-Docker requirement for the Active Directory connector tests, the
SFTP integration test, and troubleshooting a suite run are all in
[Operate](docs/operate.md#tests).

## License

Apache-2.0. See [LICENSE](LICENSE).
