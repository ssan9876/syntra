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
The modules after Access are designed but not yet implemented.

| Module | Status | Contents |
|---|---|---|
| **Core** | built | Multi-tenancy, directory, persons and contracts, RBAC, audit log, secrets vault, scheduler, notifications, web console |
| **Directory Sync** | built | LDAP/OpenLDAP connector over LDAPS or StartTLS, attribute mapping and correlation, previewed diffs, a mass-deactivation guard, scheduled and on-demand runs, and console screens for the lot: a source editor with a connection test, a mapping editor, and a run review with per-change skip and partial apply |
| **Access** | built | Application catalog and assignments, authentication policy, TOTP and WebAuthn second factors, recovery codes, self-service password reset, step-up MFA for the console. **SAML 2.0 identity provider**: both bindings, SP-initiated and IdP-initiated, signed assertions, optional encryption, front-channel single logout, metadata by upload or URL. **OpenID Connect provider**: authorization code with PKCE, refresh-token rotation, discovery, JWKS with overlapping rotation, UserInfo, RP-initiated logout, and a bounded client-credentials grant. **Upstream federation**: Syntra as a SAML service provider and as an OIDC relying party, with just-in-time provisioning and policy-driven routing. Every path reaches the same `authorize()`. See [what it does not do](#what-the-federation-half-does-not-do) |
| **Provision** | planned | Source systems, business rules, evaluation and enforcement, target systems, entitlements |
| **Automate** | planned | Product catalog, self-service requests, approval workflows, delegated forms |
| **Govern** | planned | Reconciliation, segregation of duties, recertification campaigns |

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
will too.

## Running it

Requires Node 22+ and Docker. pnpm is pinned by `packageManager` in
`package.json`, so `corepack enable` selects the right version — a newer
pnpm silently skips the build scripts for Prisma and argon2, and the
install looks clean until nothing can reach the database.

```bash
pnpm install
pnpm db:up                                  # PostgreSQL 16, MailDev, OpenLDAP

# BEFORE db:migrate, both of them. Prisma's CLI reads `.env` from its own
# working directory, and pnpm runs `migrate` with the cwd set to packages/db,
# so the root file is not in scope for it: a checkout carrying only that one
# fails with "Environment variable not found: DATABASE_URL".
cp .env.example .env                        # then fill in the secrets
cp packages/db/.env.example packages/db/.env

pnpm db:migrate

SEED_ADMIN_PASSWORD='choose-a-long-one' \
SEED_USER_PASSWORD='choose-another-one' \
  pnpm seed

pnpm dev                                    # api on :3000, web on :5173
```

Then open **http://acme.localhost:5173** and sign in as `admin`.

The host matters: Syntra picks the tenant from the `Host` header, so
`localhost:5173` will report an unknown tenant while `acme.localhost:5173`
resolves to the seeded tenant.

### Continuous integration

`.github/workflows/ci.yml` runs two jobs on every push and pull request: the
unit and integration suite against a real PostgreSQL, OpenLDAP and Samba domain
controller, and the browser suite against a running, seeded stack.

Both bring the infrastructure up with `infra/docker-compose.yml` rather than
GitHub's `services:`. The OpenLDAP container needs its bootstrap LDIF and TLS
settings and the Samba container needs a domain provisioned; both are already
expressed in that file, and a second, drifting copy of it in YAML is how CI
starts testing something the developers do not run.

**One known flake, deliberately not retried.** Under load a handful of
`resetDatabase()` hooks time out at 30 seconds and take their files with them.
The failing set moves between runs and every one of them passes in isolation —
seen roughly one run in two on an 8-worker machine. A `Hook timed out in
30000ms` in the test job is that, not your change. It is written up, with the
arithmetic and three candidate fixes, in
`docs/superpowers/specs/2026-08-15-directory-sync-known-gaps.md`.

### Tests

```bash
pnpm test                       # domain, API and database integration tests
pnpm --filter @syntra/web test  # web component tests
pnpm e2e                        # browser tests against a running stack
```

The integration tests run against a real PostgreSQL in Docker. They are not
mocked, because the properties worth testing here — row-level security, a
partial unique index, an append-only rule — only exist in the database.

**`pnpm test` creates and migrates a database of its own**, named after the
absolute path of the checkout it is running in, and never touches the one
`.env` names. Two checkouts on one machine therefore do not share truncations
or row locks — which used to produce about twenty-eight simultaneous failures
that all read `expected 500 to be 200` and sat nowhere near the code being
changed. It needs `SUPERUSER_DATABASE_URL` (already in `.env.example`) to
create the database, once. Exporting `DATABASE_URL` in the environment
overrides all of this and skips provisioning, which is the shape CI wants.

Start the browser stack with `AUTH_RATE_LIMIT_MAX` raised, since the suite
signs in far more often in a minute than a person would and the default limit
is right to refuse it.

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

`pnpm test` no longer competes with a running stack for the development
database — it makes its own — but the browser suite still shares whatever
`DATABASE_URL` the stack was started with. Pointing a second stack at a
database of its own (`CREATE DATABASE syntra_e2e OWNER syntra_app`, then
`pnpm db:migrate` and `pnpm seed` against it) removes the rest of that class of
confusion.

The browser tests need the stack already running — Playwright starts nothing
itself. If they fail with `ERR_CONNECTION_REFUSED` while `curl` reaches the
same URL, Vite is listening on IPv6 only: `localhost` resolves to `::1` on
recent Node, while Chromium maps `*.localhost` to `127.0.0.1`. Start the web
server with `vite --host 127.0.0.1`.

### Provisioning integration tests need a privileged Docker host

The Active Directory target connector is tested against a real Samba domain
controller (`nowsci/samba-domain:20260801025201`, pinned). That container
**must** run with `--privileged`: Samba's provisioning sets NT ACLs on the
sysvol filesystem and exits 255 without it. This is true for a self-hosted
runner and for GitHub Actions' standard Linux runners; it is **not** guaranteed
on more locked-down or sandboxed CI.

```bash
pnpm samba:up && pnpm samba:wait   # 12-20s to first LDAPS bind
pnpm vitest run packages/connectors/src/ad packages/core/src/provision
```

Everything Provision does over LDAP is encrypted. This container refuses even
a plain simple bind (`StrongAuthRequiredError: BindSimple: Transport encryption
required`), which is stricter than the OpenLDAP container, so any fixture
shared between the two must default to LDAPS or StartTLS. The certificate is
self-signed, so tests set `rejectUnauthorized: false` deliberately.

The domain controller answers plain LDAP on **1390**, not 1389: the OpenLDAP
container in the same compose file already publishes 1389, and a fixture aimed
there gets its refusals from the wrong server.

**An OpenLDAP container started before the TLS tests existed has to be
recreated:** `docker compose -f infra/docker-compose.yml up -d openldap`. The
image's default `LDAP_TLS_VERIFY_CLIENT` is `demand`, which requires a client
certificate and drops the socket mid-handshake for a client that has none. The
failure reads `Client network socket disconnected before secure TLS connection
was established`, which looks like a network fault and is not one — the compose
file sets `try` instead, and also maps 636 so the LDAPS path is covered.

**A change to `infra/ldap/seed.ldif` needs the container REMOVED, not
restarted:** `docker compose -f infra/docker-compose.yml rm -sf openldap &&
docker compose -f infra/docker-compose.yml up -d openldap`. The image bootstraps
the custom LDIF only when it initialises an empty data directory, and the data
lives in the container's own filesystem — so `up -d` on an existing container
leaves the old tree in place and the sync tests fail against DNs that are not
there.

The fixture is split into two subtrees on purpose. `ou=Shared,dc=acme,dc=test`
is read by every test that only reads; `ou=Scenarios,dc=acme,dc=test` belongs to
`packages/core/src/sync/scenarios.test.ts`, the one file that writes to the
directory. One container serves up to eight parallel vitest workers, and before
the split a reader previewing twice around one of that file's mutations saw an
object appear or vanish and proposed a `create_user` or a `deactivate_user` for
it. A test that needs to mutate the directory gets a subtree of its own and
scopes its source to it.

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
session and refresh token — including the OpenID Connect refresh tokens and
grants relying parties hold, which is where the ones that actually exist live —
and an account whose password lives upstream is told by mail where to go
instead. Deactivating a user and a sync-driven leaver revoke the same set.

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

### Signing in to applications

Syntra is a SAML 2.0 identity provider and an OpenID Connect provider, and it
can delegate authentication upstream to a SAML identity provider or an OIDC
one. Every one of those paths — a service provider's `AuthnRequest`, a relying
party's authorization request, and a login that came back from an upstream
provider — reaches the same `authorize()` call in `packages/core` that a local
sign-in does, and none of them issues an assertion or a token without an
`allow` from it. Policy, second factors and the audit trail apply the same way
whichever door somebody came in by.

**An application in the catalog is a bookmark, a SAML service provider or an
OIDC relying party.** A bookmark carries a launch URL. A SAML application's
launch address is *derived* from the tenant's own protocol identity and never
stored — the portal sends the browser to `/saml/start/:id`, which re-enters
`authorize()` on its own rather than inheriting the launch's decision. An OIDC
application is launched by sending the browser to the relying party's own start
address, because OpenID Connect has no identity-provider-initiated flow: only
the relying party knows its own `state`, `nonce` and PKCE verifier.

**Nothing derives an issuer, an entity ID, an audience or a redirect target
from the `Host` header.** A tenant is resolved from that header, so
`acme.attacker.example` resolves the tenant `acme`; an identifier built from it
would let an attacker choose the value a relying party checks against, which is
the whole content of an identifier. They come from the tenant's own
`primaryDomain` and from `PUBLIC_URL`, and `assertProtocolHost` refuses a
protocol request that did not arrive on the host those identifiers name.

**Redirect URIs and assertion consumer service URLs are matched byte for
byte.** There is no wildcard, no prefix and no normalization anywhere in the
comparison, and the registration form refuses a URL that is not a plain http(s)
address — no fragment, no embedded credentials, and nothing in the host that is
not a host. A pattern like `https://*.example.test/cb` is refused at the form
rather than accepted and then silently never matched.

**Requiring signed `AuthnRequest`s is the default for a newly registered
service provider**, and the API will not leave it on with no certificate to
check against. An unsigned authentication request is something anyone can send:
hand a signed-in user a link carrying one and Syntra would mint an assertion
for them and post it to the service provider's real endpoint. Turning it off is
a posture an administrator may choose per application, and it has to be chosen
— importing metadata that publishes no signing certificate is refused rather
than quietly writing the weaker setting.

**An in-flight sign-in is bound to the browser that started it.** Both halves
of the protocol surface park a single-use row while somebody authenticates —
`SamlAuthnRequest` while a service provider's user signs in here,
`FederationRequest` while a user of ours signs in at an upstream — and both
hand the browser an opaque identifier to come back with. Bound to nothing, that
identifier is a bearer credential: whoever can make Syntra park a row can take
the identifier out of their own redirect and give it to somebody else. On the
identity-provider side that mints an assertion for the victim; on the consuming
side the *victim* is signed in **as the attacker**, and every check on the
upstream's answer passes, because it genuinely is the attacker's answer to the
attacker's own request. A nonce in a cookie of its own — `syntra_saml_bind` and
`syntra_federation_bind`, scoped to their own paths — is set when the row is
parked, and only its SHA-256 is stored, so a row is not a credential even to
something that can read the table. A callback that does not present the nonce
is refused exactly as an expired one is, and it does not spend the row.

**One grant is an exemption, deliberately.** The OAuth 2.0 *client credentials*
grant issues an access token with no `authorize()` decision behind it, because
there is no person for a decision to be about: it authenticates a client, and a
policy that matches on group membership, contract attributes and enrolled
factors has nothing to say about one. The alternative would be to invent a
service-account user — a user-shaped principal no policy meaningfully governs,
appearing in the directory, resolvable by assignment, and counted in other
subsystems' guard denominators — which is worse than naming the exemption and
bounding it. It is bounded by four things:

- It is **off unless an administrator turns it on for that client**
  (`OidcClient.clientCredentialsEnabled`, its own field, default false). The
  API refuses `client_credentials` as a grant type outright, so that flag is
  the only way it can be on.
- Every issuance is audited as **`oidc.client_credentials_authorized`**, so
  "what was issued without a policy decision" is one query. The event is
  written only after the client has authenticated, so it cannot be filled with
  issuances that never happened by a caller who cannot issue anything.
- The client **must authenticate with a secret**. RFC 6749 section 4.4 asks for
  a confidential client, this exemption's whole justification is that the
  client secret is the control standing in for a policy decision, and a client
  registered with `token_endpoint_auth_method: none` has neither. Refused at
  registration and again at the token endpoint.
- The token is **scope-separated**: it may not carry `openid`, `profile`,
  `email` or `offline_access`, and UserInfo refuses it. Registration refuses
  those scopes too, so the configuration cannot exist in the first place. It
  cannot be presented anywhere a user token is accepted.
- It carries **no subject**, so nothing downstream can mistake it for a person.

If you are auditing this deployment, `oidc.client_credentials_authorized` is
the event to read, and `clientCredentialsEnabled` is the column to list.

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
| `application.launch` | Somebody entered an application through the portal, carrying whether it was a bookmark, a SAML application or an OIDC one |
| `saml.assertion_issued` | An assertion was issued to a service provider, naming it, the ACS URL it went to and the factor behind the session |
| `saml.acs_refused` | A request named an assertion consumer service URL that is not on the application's allowlist. **Somebody is probing, or a service provider changed its address without telling anyone** |
| `saml.signature_refused` | An `AuthnRequest` or `LogoutRequest` failed signature verification, or arrived for an application that requires signatures and has no certificate registered. **A service provider whose signing has broken and somebody probing signatures look the same here; both are worth a look** |
| `saml.logout` | A service provider ended a session through single logout |
| `oidc.interaction_resolved` | `authorize()` allowed an OIDC authorization request |
| `oidc.decision_missing` | **A token was requested for an authorization code with no `authorize()` decision behind it.** The second chokepoint control fired. This should never happen in normal operation — alert on it |
| `oidc.client_credentials_authorized` | A machine token was authorized. The one path with no policy decision behind it — see above |
| `oidc.logout` | An application ended a Syntra session through RP-initiated logout |
| `federation.user_provisioned` | An upstream login created a local account, carrying the groups the upstream asserted (which grant nothing — see below) |
| `federation.user_linked` | An upstream login was matched to a local account that already existed, and refreshed it. **The first one for a given account is where a login was adopted by an upstream** |
| `federation.provision_refused` | An upstream authenticated somebody Syntra has no account for, or sent too little to identify them |
| `federation.assertion_refused` | An upstream assertion failed verification |
| `federation.exchange_refused` | An upstream token exchange failed, including an `id_token` whose signature could not be verified against the provider's published keys |
| `access.saml_configured` / `access.saml_metadata_imported` / `access.oidc_configured` | An application's protocol configuration changed, carrying the allowlist that changed with it |
| `access.claim_mapping_changed` | A claim or attribute released to an application was added or removed |
| `access.upstream_configured` | An upstream identity provider was registered or changed. **Never the client secret, and never its vault name** |
| `policy.rule_added` / `policy.rule_updated` / `policy.rule_deleted` / `policy.rules_reordered` / `policy.default_set` | The policy changed, and who changed it |
| `tenant.settings_updated` | Admin MFA, self-enrolment or the password floor changed |
| `auth.password_reset_requested` / `auth.password_reset_factor_failed` / `auth.password_reset_completed` | A self-service reset was asked for, refused at the factor, or applied |

### What the federation half does not do

Each of these is a deliberate absence rather than an oversight, and each is
worth reading before this is put in front of users.

**Single logout does not propagate to other service providers.** Ending a
session through `/saml/slo` ends it *at Syntra* and answers the service
provider that asked. Every other service provider the same person signed into
still holds its own session until that session expires. Front-channel
propagation needs the browser to visit each one in turn; back-channel needs an
outbound HTTP client per service provider and a retry queue. Neither is here,
so **single logout is a local logout with a protocol answer attached**, and an
offboarding procedure must not rely on it. Deactivating the account does work
immediately, because a user's status is re-read on every request.

**There is no single logout on the consuming side either.** Signing out of
Syntra does not sign the person out of the upstream identity provider that
authenticated them, so the next sign-in may complete without a prompt. That is
the upstream's session, not Syntra's, and Syntra never had a handle on it.

**A LogoutResponse is not signed on either binding.** It says only that a
session Syntra had already ended is ended, and the request that asked for it
was verified. A service provider that requires a signed LogoutResponse is not
served today; `logoutRedirectUrl` and `logoutPostForm` are where that would go.

**SAML signing keys are not rotated automatically.** OIDC signing keys are:
every tenant gets a monthly rotation on the job scheduler, with the outgoing
key published beside the incoming one for a week, so a relying party that
selects by `kid` from the JWKS never sees a break. SAML is deliberately left
out. A service provider typically has the identity provider's certificate
pasted into its own configuration rather than re-reading metadata — which is
why a Syntra SAML key is minted with a three-year lifetime — and rotating one
on a timer would silently break every integration that pinned it, one week
after each rotation. Rolling a SAML key is an operator's decision, and there is
no console button for it yet: `rotateKey(tenantId, provider, 'saml')` is the
call, and the tenant's metadata must be re-published to the service providers
afterwards.

**Token revocation and introspection are advertised and do not work.** The
discovery document lists `<issuer>/token/revocation` and
`<issuer>/token/introspection` because oidc-provider publishes them. Client
authentication for the token endpoint is Syntra's own — constant-time, against
the stored SHA-256 hash — and oidc-provider is handed a placeholder secret it
never learns the real value of, which is what makes `/token` safe. The
consequence is that every *other* client-authenticated endpoint answers
`invalid_client` to a client presenting its real secret. Neither endpoint is
required by spec section 7. `oidc-boundary.test.ts` states this in a test so it
is not rediscovered.

**An `id_token` signed with HS256 from an upstream is refused, and the reason
is only in the log.** `openid-client` does not verify an `id_token`'s signature
by default; Syntra turns that on, which means the signature must verify against
a key the provider publishes in its JWKS. A symmetric algorithm publishes no
key, so a provider configured for HS256 fails the exchange with
`federation.exchange_refused` and a message in the server log. The
administrator sees a failed sign-in and nothing pointing at the algorithm.

**Groups asserted by an upstream grant nothing.** `groupsAttribute` is read,
carried through provisioning and recorded on `federation.user_provisioned`, and
that is all it does: it does not create groups, does not add anybody to one,
and does not feed the policy engine's group conditions. It is there so the
mapping can be verified against real traffic before anything acts on it.
**Do not size a policy on it.**

**A refused request signature is not in the audit log.** A service provider
whose `AuthnRequest` fails signature verification gets a 400 or a 409 naming
the setting and the application, and the server logs it — but there is no
`recordEvent` for it, so it does not appear in the tamper-evident log or in the
console's audit screen. A service provider that has stopped signing correctly
is visible in the API logs and nowhere else.

**The console has screens for none of this.** Protocol configuration, metadata
import, OIDC client registration, claim mappings, upstream identity providers
and routing (`federate`) rules are all API-only —
`/api/admin/applications/:id/saml`, `/applications/:id/oidc`,
`/applications/:id/claims`, `/api/admin/upstreams` and
`/api/admin/policy/rules`. The policy screen writes tenant-wide rules and does
not offer the application scope, the upstream, or the login domains. Everything
is reachable and tested; none of it has a form yet.

**Signed metadata, back-channel logout, a consent screen and a scheduled sweep
of expired artifacts are all out.** The identity-provider metadata document is
unsigned — it is served over TLS from the tenant's own host, which
`assertProtocolHost` enforces. Assignment is the consent decision, so there is
no per-launch consent screen. `sweepExpiredArtifacts` exists and expiry is
enforced on read, but nothing runs it on a schedule; the table grows until
somebody does.

## License

Apache-2.0. See [LICENSE](LICENSE).
