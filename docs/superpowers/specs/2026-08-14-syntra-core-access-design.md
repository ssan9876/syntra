# Syntra — Core + Access Management MVP

**Date:** 2026-08-14
**Status:** Approved design
**Scope:** Sub-projects 0 (Core) and 1 (Access Management) of the Syntra program

---

## 1. Purpose

Syntra is an open-source Identity and Access Management platform, modeled on
Tools4ever's HelloID. It gives an organization one place to hold its people,
decide what they may reach, and hand them a single front door to every
application they use.

HelloID is a commercial cloud product covering four modules. Syntra reproduces
that shape as self-hostable software under Apache-2.0. This document specifies
only the first slice: the platform foundation and Access Management. The
remaining modules get their own design documents.

### Success criteria

This slice is done when a self-hosted Syntra instance can:

1. Serve more than one tenant from a single deployment, with no tenant able to
   read another's data.
2. Hold users, groups, and organizational units, populated by hand and by
   synchronizing from Active Directory or another LDAP server.
3. Authenticate a user with a password plus a second factor (TOTP or WebAuthn).
4. Act as a SAML 2.0 identity provider and an OpenID Connect provider for
   downstream applications.
5. Delegate authentication upstream to Entra ID, Google, or a generic OpenID
   Connect provider, creating the local user on first login.
6. Show each user a portal of the applications assigned to them, and sign them
   in to any of those applications with one click.
7. Let a user reset a forgotten password by email, without a helpdesk call.
8. Record every privileged action in a tamper-evident audit log.

---

## 2. Program context

Syntra as a whole decomposes into six sub-projects. Each gets its own design
document, implementation plan, and build cycle.

| # | Sub-project | HelloID counterpart | Contents |
|---|---|---|---|
| 0 | **Core** | Platform, admin and user dashboards | Multi-tenancy, directory, admin RBAC, audit log, secrets vault, job scheduler, notifications, web shell |
| 1 | **Access** | Access Management | SAML 2.0 IdP, OIDC OP, upstream federation, application catalog, MFA, authentication policies, self-service password reset |
| 2 | **Provision** | Provisioning | Source systems, persons and contracts, snapshots, business rules, evaluation and enforcement, target systems, entitlements |
| 3 | **Automate** | Service Automation | Product catalog, self-service requests, approval workflows, delegated dynamic forms, scripted task engine |
| 4 | **Govern** | Governance | Reconciliation, orphan account detection, segregation of duties, recertification campaigns |
| 5 | **Agent** | HelloID Agent | Outbound-connecting on-premises worker for Active Directory, LDAP, SQL, and PowerShell |

Build order is 0 to 1 to 2 to 3 to 4, with 5 pulled forward when Provision first
needs to write to a real on-premises directory.

**This document covers 0 and 1 only.**

---

## 3. Decisions

These were settled during brainstorming and are not reopened by the
implementation plan.

| Decision | Choice | Reasoning |
|---|---|---|
| First slice | Core + Access | Produces a product a user can log into and demonstrate. Everything else depends on Core's tenancy, directory, and audit. |
| Language and stack | TypeScript monorepo — Fastify, Prisma, PostgreSQL, React, Vite, Tailwind | Mature SAML and OIDC libraries, one language across API and UI, fastest path to testable vertical slices. |
| Deployment | Self-hosted, multi-tenant from day one | Tenancy retrofitted later is a large and risky migration. Docker Compose for development, container images for production. |
| SSO role | Identity provider **and** upstream broker; SAML and OIDC both | This is what HelloID does. An IdP-only product cannot serve organizations that already federate to Entra ID. |
| Directory | Built-in directory plus LDAP/Active Directory synchronization | Proves the connector abstraction early, and matches the on-premises reality of the target market. |
| MFA | TOTP and WebAuthn/passkeys | Two real implementations behind one authenticator interface, so a third is a small addition rather than a redesign. |
| License | Apache-2.0 | Permissive, with the explicit patent grant that matters in the identity space. |
| Protocol engine | Protocol libraries embedded in the Syntra API | See section 4. |
| Web application | One React application with role-gated routes | See section 5. |

---

## 4. Identity engine: embedded libraries

Three options were considered for how Syntra speaks SAML and OIDC.

**Chosen — protocol libraries inside the Syntra API.** `oidc-provider` supplies
the OpenID Connect provider; `@node-saml/node-saml` and equivalent assertion
signing supply the SAML identity provider. Both are mounted as adapters behind a
Syntra-owned session, policy, and consent layer.

This buys protocol correctness from audited libraries while Syntra retains
ownership of the user model, login experience, application catalog, and policy
engine. That ownership is a hard requirement: Provision and Govern later need
direct access to the same user and entitlement tables, and a foreign user store
would force every write through a remote administrative API.

**Rejected — wrapping Keycloak or Ory Hydra.** Fastest route to certified
protocol behavior, but Syntra would become a skin and a synchronization layer
over another product's user store. Operationally it means running two servers,
and architecturally it constrains every later module.

**Rejected — implementing the protocols from scratch.** Hand-written XML
signature verification is where identity products acquire vulnerabilities.

---

## 5. Repository architecture

A pnpm workspace at the repository root.

```
syntra/
  apps/
    api/            Fastify server: REST API and SAML/OIDC protocol endpoints
    web/            Single React application
                      /            end-user portal
                      /admin/*     administration console
  packages/
    db/             Prisma schema, migrations, seed data
    core/           Domain services: tenancy, RBAC, audit, vault, scheduler
    protocols/      SAML IdP, OIDC OP, upstream federation clients
    connectors/     Connector SDK and the LDAP/Active Directory implementation
    ui/             Shared design system: Tailwind plus headless primitives
    contracts/      Zod schemas and generated OpenAPI, shared by api and web
  infra/
    docker-compose.yml   PostgreSQL 16, MailDev, OpenLDAP for tests
  docs/
```

### One web application

Administration and the end-user portal ship as one React application, with
administration under `/admin/*`. This gives one build, one development server,
one design-system consumer, and one session implementation.

The obvious risk is that a portal user reaches an administrative capability.
Three mitigations address it, none of which relies on the browser behaving:

- **Authorization is enforced server-side only.** Administrative endpoints live
  under an `/api/admin/*` prefix guarded by RBAC middleware. Router-level gating
  in React is cosmetic. Hiding a navigation item is never the control.
- **Administrative code is a lazy-loaded chunk** behind a route guard, so a
  portal-only session never downloads the administration console.
- **Administrative sessions require step-up MFA** and carry a distinct scope
  with a shorter idle timeout. A portal session token alone is rejected by
  `/api/admin/*`.

### Package boundaries

Each package has one purpose, a declared interface, and declared dependencies.

- `db` depends on nothing. It owns the schema and exports a typed client.
- `core` depends on `db`. It owns domain services and knows nothing about HTTP.
- `protocols` depends on `core`. It translates protocol messages to and from
  domain calls and knows nothing about the database.
- `connectors` depends on `core` types only. Each connector is independently
  testable against a container.
- `contracts` depends on nothing. Both `api` and `web` depend on it, which is
  what keeps request and response shapes from drifting.
- `api` composes `core`, `protocols`, `connectors`, and `contracts`.
- `web` depends on `contracts` and `ui` only.

A package that starts importing across these lines is a signal that a boundary
is wrong, and should be raised rather than worked around.

---

## 6. Data model

PostgreSQL 16, schema managed by Prisma migrations.

### Tenant isolation

Every tenant-scoped table carries a `tenantId` column, and isolation is enforced
by **PostgreSQL row-level security**. Each request opens its transaction with
the session's tenant set as a runtime parameter; RLS policies compare `tenantId`
against it.

This is deliberately not left to `where` clauses in application code. A missing
clause in one query handler is a cross-tenant data leak; an RLS policy holds
even when the application layer is wrong.

### Tenancy and administration

- `Tenant` — name, slug, primary domain, settings, branding, lifecycle status.
- `Role`, `Permission`, `RoleAssignment` — role-based access control, with
  assignments scoped to a tenant or to an organizational unit within it.

There is no separate administrator table. An administrator is a directory `User`
holding a `RoleAssignment` that carries administrative permissions. This keeps
one identity per person and one credential set per identity; the separation
between portal and console is a property of the *session*, not of the account.
A single bootstrap owner account is created when a tenant is provisioned.

- `AuditEvent` — append-only. Each row records actor, action, target, outcome,
  source address, and payload, and carries a hash of the previous row so that
  deletion or alteration is detectable.
- `Secret` — envelope encryption. Data is sealed with AES-256-GCM under a data
  key, which is itself sealed under a master key. The master key provider is an
  interface with a local-file implementation for development and room for a
  KMS-backed implementation later.

### Directory

- `User` — the identity of a person who signs in. Login name, email, display
  name, status, organizational unit, credentials.
- `Group`, `GroupMembership`, `OrgUnit` — grouping and hierarchy.
- `UserAttribute` — typed key/value storage for tenant-defined attributes, so a
  tenant can carry attributes Syntra does not model natively.
- `DirectorySource`, `SyncRun`, `SyncRecord` — synchronization configuration and
  per-run results.

`User` deliberately contains no employment or human-resources concepts: no job
title, no manager, no contract, no start and end date. Provision introduces
`Person` and `Contract` in its own design and links them to `User`. Merging the
two now would produce a `User` table that both modules fight over, and is the
single modeling mistake most likely to poison the later work.

### Credentials

- `PasswordCredential` — Argon2id hash, algorithm parameters stored alongside so
  they can be raised without invalidating existing hashes.
- `TotpCredential` — encrypted shared secret, with replay protection recording
  the last accepted counter window.
- `WebAuthnCredential` — credential ID, public key, signature counter,
  transports, attestation type.
- `RecoveryCode` — single-use, stored hashed.
- `PasswordResetToken` — single-use, stored hashed, time-limited.
- `Session`, `RefreshToken` — with scope, idle timeout, absolute expiry, and
  revocation.

### Access

- `Application` — a SAML service provider, an OIDC relying party, or a plain
  bookmark tile. Name, icon, description, visibility.
- `AppAssignment` — grants an application to a user, a group, or an
  organizational unit. Resolution is a union of all matching assignments.
- `SamlConfig` — entity ID, ACS URLs, name-ID format, signing and encryption
  certificates, binding preferences.
- `OidcClient` — client ID, hashed secret, redirect URIs, grant types, scopes,
  PKCE requirement.
- `ClaimMapping` — maps directory attributes to SAML attributes and OIDC claims,
  per application.
- `UpstreamIdp` — an external identity provider Syntra federates to, with its
  protocol configuration, attribute mapping, and just-in-time provisioning
  rules.
- `AuthPolicy`, `AuthPolicyRule` — see section 8.

---

## 7. Protocol surface

### SAML 2.0 identity provider

- HTTP-POST and HTTP-Redirect bindings for authentication requests.
- Service-provider-initiated and identity-provider-initiated flows.
- Signed assertions, with optional assertion encryption.
- Single logout.
- Per-application identity provider metadata endpoint, and import of service
  provider metadata by upload or URL.

Assertion consumer service URLs are validated against a per-application
allowlist. Incoming XML is parsed with entity expansion disabled, and signatures
are verified before any part of the document is trusted.

### OpenID Connect provider

- Authorization code flow with PKCE, refresh tokens, and client credentials.
- Discovery document and JWKS endpoint with key rotation, publishing the
  outgoing key alongside the incoming one for the duration of a rollover.
- UserInfo endpoint.
- RP-initiated logout.

Redirect URIs are matched exactly against the registered allowlist. No wildcard
or prefix matching.

### Upstream federation

Syntra can act as a SAML service provider and an OIDC relying party against an
external identity provider. On first successful upstream login, a local `User`
is created from the mapped attributes; on subsequent logins the mapped
attributes are refreshed. Which upstream a login uses is chosen by the
authentication policy, so a tenant can federate some users and locally
authenticate others.

### Single chokepoint

All three paths — local login, protocol-initiated login, and upstream
federation — funnel through one `authorize()` call in `core`. Policy evaluation,
MFA requirements, and audit logging live there and nowhere else. No protocol
adapter may issue a token or assertion without a decision from it. This is what
prevents a policy bypass from hiding in one protocol's code path.

---

## 8. Authentication policy engine

A policy is an ordered list of rules. Each rule matches on any combination of:
target application, group membership, source IP or CIDR range, and time window.
The first matching rule decides the outcome:

- `allow` — proceed with primary authentication only.
- `require_mfa` — require any registered second factor.
- `require_factor` — require a specific factor type, for example WebAuthn only.
- `deny` — refuse, with a reason recorded in the audit log.

If no rule matches, the tenant's default outcome applies. Evaluation is a pure
function of rule set and request context, which makes it exhaustively testable
without a server.

---

## 9. Notifications and self-service password reset

Core owns a single notification service: a template per message type, rendered
per tenant with that tenant's branding, delivered through a pluggable transport.
SMTP is the only transport in this slice, with MailDev standing in during
development so no test run can send real mail.

Access uses it for one user-facing feature, self-service password reset:

1. The user submits a login name or email address. The response is identical
   whether or not the account exists.
2. If it exists and the tenant permits reset for that user, a single-use,
   time-limited token is mailed. The token is stored hashed.
3. Presenting a valid token allows setting a new password, subject to the
   tenant's password policy. If the user has a second factor registered, the
   reset requires that factor as well — otherwise password reset becomes a way
   around MFA.
4. Completing a reset revokes every existing session and refresh token for that
   user, and writes an audit event.

Users whose password lives in an upstream identity provider cannot reset it
here; the flow tells them where to go instead.

---

## 10. Directory synchronization

One interface, implemented first by LDAP and Active Directory:

```ts
interface Connector {
  test(config): Promise<ConnectionResult>
  discoverSchema(config): Promise<SchemaDescriptor>
  read(config, cursor): AsyncIterable<SourceRecord>
  write(config, op): Promise<WriteResult>   // declared now, unused in this slice
}
```

`write` is declared now and left unimplemented for LDAP in this slice. It exists
so that Provision does not have to change an interface every connector already
implements.

A synchronization run is a pg-boss job that reads source records, maps them to
directory objects through configured attribute mappings, correlates them to
existing users by a configured matching attribute, and produces a `SyncRun`
holding the full set of proposed creates, updates, and deactivations.

**The run computes a diff and stops.** Applying it is a separate, explicit step,
either manual or scheduled. This mirrors HelloID's separation of evaluation from
enforcement, and putting it in Core means Provision inherits the pattern rather
than reinventing it.

Deletion from the source never deletes a user. It marks the user inactive and
records the reason, because an accidental source outage that empties a directory
must not be irreversible.

---

## 11. Error handling

Domain services return typed results rather than throwing for expected failures:
a wrong password, a policy denial, a connector timeout, and a duplicate login
name are all outcomes, not exceptions. Unexpected failures throw and are caught
at the HTTP edge.

The API translates both into RFC 9457 `application/problem+json`, with a stable
machine-readable `type` per error class. Authentication failures return a
deliberately uniform response and timing regardless of whether the user exists.

Connector and protocol failures are recorded on the owning `SyncRun` or
`AuditEvent` with enough context to diagnose them from the administration
console, rather than only in server logs.

---

## 12. Security posture

- Argon2id for passwords, with parameters stored per credential.
- Signing keys rotated on a schedule, with overlap so existing tokens verify.
- Strict allowlisting of redirect URIs and assertion consumer service URLs.
- XML signature verification with entity expansion disabled.
- Per-tenant and per-IP rate limiting on all authentication endpoints.
- Every privileged action written to the hash-chained audit log.
- Row-level security as the primary tenant isolation control.
- Secrets never returned by any API once written, only replaced.
- Administrative sessions separated by scope, with step-up MFA and a shorter
  idle timeout.

---

## 13. Testing strategy

Test-driven throughout: a failing test precedes the code that satisfies it.

- **Unit** — Vitest against domain services in `core`, with the policy engine
  and attribute mapping covered exhaustively since both are pure functions.
- **Integration** — the API against a real PostgreSQL in Docker, including
  explicit tests that a request scoped to one tenant cannot read another's rows
  even when the query is written wrongly.
- **Protocol conformance** — a real SAML service provider and a real OIDC
  relying party driven against the Syntra endpoints, asserting on signatures,
  claim contents, and rejection of malformed or replayed messages.
- **Connector** — the LDAP connector against a containerized OpenLDAP with
  seeded fixtures, covering paging, deletion detection, and reconnection.
- **End-to-end** — Playwright over login, MFA enrollment, MFA challenge,
  application launch, and the administration console's critical paths.

---

## 14. Out of scope for this slice

Deferred to their own design documents: Provisioning, Service Automation,
Governance, the on-premises Agent, SCIM, SMS-based factors, and the broad
connector library. The interfaces above are shaped to receive them without
restructuring.
