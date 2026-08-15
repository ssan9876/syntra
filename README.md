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
applied. The first slice of **Access** is built too: one authentication
chokepoint, an ordered authentication policy, TOTP and WebAuthn second factors
with recovery codes, self-service password reset, and an application catalog
the portal launches from. The federation protocols — SAML, OIDC, upstream
identity providers — are designed but not yet implemented, as are the modules
after Access.

| Module | Status | Contents |
|---|---|---|
| **Core** | built | Multi-tenancy, directory, persons and contracts, RBAC, audit log, secrets vault, scheduler, notifications, web console |
| **Directory Sync** | built | LDAP/OpenLDAP connector over LDAPS or StartTLS, attribute mapping and correlation, previewed diffs, a mass-deactivation guard, scheduled and on-demand runs, and console screens for the lot: a source editor with a connection test, a mapping editor, and a run review with per-change skip and partial apply |
| **Access** | partly built | **Built:** application catalog and assignments, authentication policy, TOTP and WebAuthn second factors, recovery codes, self-service password reset, step-up MFA for the console. **Planned:** SAML 2.0 IdP, OpenID Connect provider, upstream federation |
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

**Every authentication goes through one function.** `authorize()` in
`packages/core/src/auth/authorize.ts` is the only path that establishes who a
caller is, so policy and auditing live in one place instead of being
reimplemented per protocol. Sign-in, elevation to the console and every
application launch all go through it, and in Access II every protocol adapter
will too.

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

**If another Syntra is already running, do not test through it.** A second
checkout — a worktree, a colleague's branch — answers `/health` and every
familiar route exactly as yours does, so a suite pointed at the wrong port
passes while testing code you did not write. Give the second stack ports and
a database of its own:

```bash
PORT=3100 pnpm --filter @syntra/api dev
WEB_PORT=5174 API_TARGET=http://127.0.0.1:3100 \
  pnpm --filter @syntra/web exec vite --host 127.0.0.1
E2E_BASE_URL=http://acme.localhost:5174 pnpm e2e
```

Then prove it is yours before believing a result: request a route that exists
only on your branch and check it is not a 404. `/health` proves nothing.
Vite's dev server uses `strictPort`, so it fails rather than quietly moving to
the next free port when 5173 is taken.

The integration tests truncate the shared database between cases, so a
browser suite running while someone else runs `pnpm test` will lose its seeded
tenant mid-flight. `DATABASE_URL` pointed at a database of its own
(`CREATE DATABASE syntra_e2e OWNER syntra_app`, then `pnpm db:migrate` and
`pnpm seed` against it) removes that whole class of confusion.

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

Sources are created and edited from **Directory sources** in the console.
**New source** opens an editor for the connection, the search bases and
filters, the anchor attribute, the schedule and the deactivation threshold;
**Start from Active Directory / OpenLDAP** seeds the attribute mappings, the
anchor and the per-flavour filters, so the common case needs no typing.

**Test connection** works before anything is saved, and reports what it
found: the number of users, groups and organizational units in the configured
search bases, and the object classes and attributes the directory returned —
including the operational ones, since the anchor lives among those. The
editor also carries **Run now**, and a delete that states in words how many
users and groups it would deactivate before the button will do anything.

Editing a source and re-testing it reuses the stored bind password, but only
against the address the source is saved with: changing the URL, the transport
or the certificate setting means typing the password again. Otherwise anyone
who can configure a source could ask Syntra to send a stored credential to a
host of their choosing, which is a way of reading the vault rather than a way
of testing a connection. Every test is recorded in the audit log with where it
connected, refusals included.

The same operations are available over HTTP — `POST /api/admin/sources`,
`PATCH /api/admin/sources/:id`, `DELETE /api/admin/sources/:id`, `PUT
/api/admin/sources/:id/mappings`, and `POST /api/admin/sources/test` for a
configuration that has not been saved. Either way, the bind password goes into
the secrets vault, not into the source's stored `config` — the API only ever
accepts it, never returns it, and a `PATCH` carrying a new one replaces the
vault entry rather than adding beside it. The editor leaves the field blank on
an edit, and blank means unchanged; re-testing a connection after changing a
search base borrows the stored credential server-side rather than round-
tripping it to the browser.

A source can be saved **disabled**, which is worth knowing: a create with a
cron expression is scheduled the moment it commits, so saving disabled is how
you get the mappings in place before the first run fires.

A `PATCH` mentioning a schedule takes effect immediately, not at the next
restart; so does a create, and so does a delete. Each source has a schedule of
its own on the shared job queue, so rescheduling one leaves the rest alone.

The console sends the counts it displayed along with the confirmation, and the
server checks them inside the deleting transaction. A run that landed between
the page being read and the box being ticked therefore stops the delete rather
than quietly enlarging it, and the question is put again with the real
numbers.

**Deleting a source deactivates every account and group it owned**, gives them
a status reason naming the source, and detaches them — it never deletes a
directory object, in keeping with the rest of this subsystem. Because that
revokes real access it is refused with a 409 and the counts unless the request
says `?confirm=true`, the same shape as the run guard. A foreign key from
`User`, `Group` and `OrgUnit` to the source makes that the only way a source
can go: the database refuses to leave a row pointing at a source that no
longer exists.

A directory-managed account is labelled as such wherever it appears: **Users**
names the source that owns it and says the fields are read-only, because a
change made here is overwritten by the next run.

A run always previews before it applies. `POST /api/admin/sources/:id/run`
reads the directory, correlates it against what Syntra already holds, and
writes a reviewable diff — creates, updates, deactivations, and membership
changes, grouped by type on the **Sync runs** review screen — without
touching anything yet. Only an explicit `POST /api/admin/sync-runs/:id/apply`,
from that same review screen, writes the changes.

The review screen applies all of it, part of it, or none of it. Unticking a
change leaves it out of this apply and still proposed, so the run comes back
partially applied and the rest can be applied afterwards; **Skip** records
that a change will not be applied at all, and is refused once the change has
stopped being proposed, so a run's account of what it did stays true.

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

## Access: signing in, second factors and policy

**Every sign-in, every elevation and every application launch goes through one
`authorize()`** in `packages/core/src/auth/authorize.ts`. Nothing issues a
session without a decision from it, which is what stops a policy bypass hiding
inside one code path.

**The authentication policy is an ordered list of rules; the first that matches
decides**, and when none does the tenant default applies. Rules match on target
application, group, contract attribute, source address and time window, and a
contract condition matches if any of the person's currently active contracts
satisfies it — a nurse who also trains one day a week is matched by a rule
about either job.

**Second factors are TOTP and WebAuthn, with single-use recovery codes as the
fallback.** A user enrols their own at `/security`. An administrator can clear
somebody's factor when they lose a phone, over
`DELETE /api/admin/users/:id/factors/:type` — this slice ships the endpoint and
its tests, but no console screen for it yet.

**A policy that requires a factor the user does not hold offers enrolment
rather than refusing.** The password has already been accepted at that point;
the token they receive buys exactly one thing — enrolling a factor of the
required kind — and no session is issued until it succeeds. Without this, the
first tenant-wide `require_mfa` rule would lock out everyone who had not
already enrolled, and MFA would be a feature nobody could switch on. The trade
is that whoever holds a password can enrol their own factor, so every such
enrolment is audited with `underForcedEnrolment: true`. A tenant that issues
factors by hand sets `Tenant.selfEnrolmentEnabled` to false, and then a missing
factor really is a refusal.

**Before a policy rule is saved, the console reports how many users it matches**
and how many of them would be asked to enrol — the same courtesy Directory
Sync's deactivation threshold provides, for the same shape of mistake. Above
25,000 active users it answers from counts instead of walking the directory,
and names the conditions it could not apply.

**Whenever a second factor is added to an account, its owner is mailed.** Not
only under forced enrolment: a factor added with a stolen password is the worse
case precisely because it survives the password reset that would otherwise fix
things, and the owner is the only person who can tell a legitimate enrolment
from an attacker's.

**Security keys need `Tenant.primaryDomain` set.** WebAuthn pins the relying
party server-side; Syntra derives it from the tenant's own domain and refuses a
request that arrives on any other host. Taking it from the `Host` header
instead would let anyone who proxies Syntra under their own name choose what
their assertion is checked against, which is the entire property a security key
exists to provide. A tenant with no primary domain gets a message saying so,
and authenticator apps still work.

**Self-service password reset answers identically whether or not the account
exists.** A user with a second factor must present it, completion revokes every
session and refresh token, and an account whose password lives upstream is told
by mail where to go instead.

**`Tenant.adminMfaRequired` makes a second factor mandatory for reaching the
administration console.** It is off by default so an existing tenant's owner is
not locked out by the migration; turn it on from **Administration → Tenant
settings**, which is also where self-enrolment is switched off for an
organization that issues factors by hand. It is a floor the elevation endpoint
imposes on top of the policy, so it can only strengthen the outcome — a rule
that denies is still a denial. Requiring a factor *and* turning self-enrolment
off refuses every administrator who does not already hold one, so the screen
refuses to save that pair until the administrator making the change holds a
factor themselves.

### What this slice does not do

**A policy change does not reach sessions that are already live.** Turning on a
`require_mfa` rule takes effect at the next sign-in, elevation or application
launch; every session issued before it stays usable until it expires. A portal
session lasts twelve hours, or one idle hour; an administrative one lasts two
hours, or fifteen idle minutes. That is a deliberate trade against re-evaluating
policy on every request, and it is why an administrator who turns a rule on can
still take it away again from the same session. If you need a rule to bite
immediately, revoke the sessions as well.

**Deactivation is the exception, and it is immediate.** A user's status *is*
re-read on every request, so deactivating an account — from the console or from
a directory sync — ends every session it holds at once rather than at the next
expiry. Offboarding is the one thing a policy delay is not acceptable for.

**Nothing watches the audit events this slice emits.** They are written to the
tamper-evident log and nothing reads them. The forced-enrolment trade above is
defensible *because* the enrolment is visible after the fact — so **wire these
into your alerting.** An audit row nobody reads does not discharge the
obligation.

The names are `<area>.<past-tense event>`; the source of truth is every
`recordEvent` call under `apps/api/src/routes` and `packages/core/src`, and
`grep -rn "action: '"` over those two trees will always be more current than a
list. What this slice adds:

| Event | What it means |
| --- | --- |
| `auth.login` | Primary authentication, success or failure, with the reason on a failure |
| `auth.policy_denied` | A rule refused the sign-in, naming the rule |
| `auth.mfa_challenged` | A factor was demanded, naming what and why |
| `auth.mfa_verified` / `auth.mfa_failed` | The factor was presented, and taken or not |
| `auth.enrolment_required` | No acceptable factor held; enrolment was offered instead |
| `auth.forced_enrolment_completed` | A factor was enrolled *during* a sign-in — see the trade above |
| `auth.mfa_unavailable` | A factor was required and there was no way to obtain one. A dead end somebody has to fix |
| `auth.elevate` | An administrative session was issued |
| `mfa.enrolled` | A factor was added, carrying `underForcedEnrolment` |
| `mfa.enrol_failed` | An authenticator or key was rejected during enrolment |
| `mfa.removed` | A factor was removed, carrying how many recovery codes went with it |
| `mfa.recovery_codes_issued` | A fresh set was minted; the old set stopped working |
| `notify.delivery_failed` | **A notification could not be sent.** The factor-added mail is one of only two things making "a stolen password can enrol a factor" an acceptable trade, so this is the event that says a control has stopped working. Alert on it |
| `application.launch` | Somebody entered an application through the portal |
| `policy.rule_added` / `policy.rule_updated` / `policy.rule_deleted` / `policy.rules_reordered` / `policy.default_set` | The policy changed, and who changed it |
| `tenant.settings_updated` | Admin MFA, self-enrolment or the password floor changed |
| `auth.password_reset_requested` / `auth.password_reset_factor_failed` / `auth.password_reset_completed` | A self-service reset was asked for, refused at the factor, or applied |

**The federation half of Access is not built.** There is no SAML IdP, no OIDC
provider and no upstream identity provider yet. `Principal.external` and
`AuthorizeRequest.applicationId` in `authorize()` are the mount points they
will attach to; an application in the catalog is a bookmark with a launch URL,
not yet a service provider Syntra asserts an identity to.

## License

Apache-2.0. See [LICENSE](LICENSE).
