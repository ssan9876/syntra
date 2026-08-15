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
applied. Access Management and the modules after it are designed but not yet
implemented.

| Module | Status | Contents |
|---|---|---|
| **Core** | built | Multi-tenancy, directory, persons and contracts, RBAC, audit log, secrets vault, scheduler, notifications, web console |
| **Directory Sync** | built | LDAP/OpenLDAP connector over LDAPS or StartTLS, attribute mapping and correlation, previewed diffs, a mass-deactivation guard, scheduled and on-demand runs, source lifecycle over the API and a run review screen in the console |
| **Access** | planned | SAML 2.0 IdP, OpenID Connect provider, upstream federation, application catalog, MFA, authentication policies, self-service password reset |
| **Provision** | planned | Source systems, business rules, evaluation and enforcement, target systems, entitlements |
| **Automate** | planned | Product catalog, self-service requests, approval workflows, delegated forms |
| **Govern** | planned | Reconciliation, segregation of duties, recertification campaigns |

Design and plan documents live in [`docs/superpowers/`](docs/superpowers).

## How it is put together

```
apps/
  api/        Fastify: REST API and, later, the SAML and OIDC endpoints
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

**Every authentication goes through one function.** `authenticate()` in
`packages/core` is the only path that establishes who a caller is, so policy
and auditing live in one place instead of being reimplemented per protocol.

## Running it

Requires Node 22+, pnpm 9, and Docker.

```bash
pnpm install
pnpm db:up                                  # PostgreSQL 16, MailDev, OpenLDAP
pnpm db:migrate

cp .env.example .env                        # then fill in the secrets
SEED_ADMIN_PASSWORD='choose-a-long-one' \
SEED_USER_PASSWORD='choose-another-one' \
  pnpm seed

pnpm dev                                    # api on :3000, web on :5173
```

Then open **http://acme.localhost:5173** and sign in as `admin`.

The host matters: Syntra picks the tenant from the `Host` header, so
`localhost:5173` will report an unknown tenant while `acme.localhost:5173`
resolves to the seeded tenant.

### Tests

```bash
pnpm test                       # domain, API and database integration tests
pnpm --filter @syntra/web test  # web component tests
pnpm e2e                        # browser tests against a running stack
```

The integration tests run against a real PostgreSQL in Docker. They are not
mocked, because the properties worth testing here — row-level security, a
partial unique index, an append-only rule — only exist in the database.

Two ordering notes for the browser tests. Run `pnpm db:reset && pnpm seed`
*after* `pnpm test`: the integration tests truncate between cases and leave
fixtures behind that fool the seed into thinking the tenant is already
populated. And start the stack with `AUTH_RATE_LIMIT_MAX` raised, since the
suite signs in far more often in a minute than a person would and the default
limit is right to refuse it.

The browser tests need the stack already running — Playwright starts nothing
itself. If they fail with `ERR_CONNECTION_REFUSED` while `curl` reaches the
same URL, Vite is listening on IPv6 only: `localhost` resolves to `::1` on
recent Node, while Chromium maps `*.localhost` to `127.0.0.1`. Start the web
server with `vite --host 127.0.0.1`.

**An OpenLDAP container started before the TLS tests existed has to be
recreated:** `docker compose -f infra/docker-compose.yml up -d openldap`. The
image's default `LDAP_TLS_VERIFY_CLIENT` is `demand`, which requires a client
certificate and drops the socket mid-handshake for a client that has none. The
failure reads `Client network socket disconnected before secure TLS connection
was established`, which looks like a network fault and is not one — the compose
file sets `try` instead, and also maps 636 so the LDAPS path is covered.

### Connecting a directory source

`infra/docker-compose.yml` already runs an OpenLDAP container for
development (`ldap://localhost:1389`, seeded from `infra/ldap/seed.ldif`), so
there is a real directory to sync against without standing anything up
yourself. The same container serves StartTLS on that port and LDAPS on
`ldaps://localhost:1636`, with a self-signed certificate.

A source's `config` carries a `tlsMode` — `plain`, `starttls` or `ldaps`.
StartTLS completes before the bind, so the bind password never crosses the
wire in the clear; `plain` means it does, and the **Directory sources** page
says so in as many words. Left out, the mode is read from the URL scheme, so
a source saved before the field existed keeps the transport it had. Server
certificates are verified unless a source sets `rejectUnauthorized: false`,
which the same page flags. The mode and the scheme have to agree: an
`ldaps://` URL with any other mode is refused rather than quietly
reinterpreted.

A source is created with `POST /api/admin/sources`, edited with `PATCH
/api/admin/sources/:id`, and removed with `DELETE /api/admin/sources/:id`;
its attribute mappings are set through `PUT /api/admin/sources/:id/mappings`.
The console's **Directory sources** page lists sources and their last run
today, and editing one from the console is a later piece of work. Either way,
the bind password goes into the secrets vault, not into the source's stored
`config` — the API only ever accepts it, never returns it, and a `PATCH`
carrying a new one replaces the vault entry rather than adding beside it.

A `PATCH` mentioning a schedule takes effect immediately, not at the next
restart; so does a create, and so does a delete. Each source has a schedule of
its own on the shared job queue, so rescheduling one leaves the rest alone.

**Deleting a source deactivates every account and group it owned**, gives them
a status reason naming the source, and detaches them — it never deletes a
directory object, in keeping with the rest of this subsystem. Because that
revokes real access it is refused with a 409 and the counts unless the request
says `?confirm=true`, the same shape as the run guard. A foreign key from
`User`, `Group` and `OrgUnit` to the source makes that the only way a source
can go: the database refuses to leave a row pointing at a source that no
longer exists.

A run always previews before it applies. `POST /api/admin/sources/:id/run`
reads the directory, correlates it against what Syntra already holds, and
writes a reviewable diff — creates, updates, deactivations, and membership
changes, grouped by type on the **Sync runs** review screen — without
touching anything yet. Only an explicit `POST /api/admin/sync-runs/:id/apply`,
from that same review screen, writes the changes.

A guard stands between the two. A run that read **no records** is refused
outright: an empty directory and an unreachable one look the same from here,
and the safe reading is the second. A run that would deactivate an outsized
share of the users, groups or group memberships this source owns — each
measured against its own population, so a filter that returns no groups
cannot hide behind the user count — is refused *pending confirmation*: the
review screen states the numbers, and an administrator has to tick the box
before Apply does anything. `autoApply` never satisfies that, because an
unattended schedule is precisely when nobody is watching.

Records the source returned but that could not be mapped are counted and
named on the run, and are never treated as absent. A missing attribute is our
failure to understand a record, not evidence that the person has left.

## License

Apache-2.0. See [LICENSE](LICENSE).
