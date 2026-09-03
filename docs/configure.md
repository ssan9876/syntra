# Configuring Syntra

Every variable Syntra reads, what it does, and what it defaults to. Comments
in `.env.example` and `packages/core/src/config.ts` are the source of truth;
this page collects them in one place.

## Required

These have no default. The API refuses to start without them.

| Variable | Meaning |
|---|---|
| `DATABASE_URL` | The Postgres connection string, as the `syntra_app` role. |
| `PUBLIC_URL` | The origin users type. The session cookie and the WebAuthn relying party are derived from it, so it has to be the address the browser actually sees, not an internal one. |
| `SESSION_SECRET` | At least 32 characters, and not the `.env.example` placeholder — the API refuses to start on the literal placeholder value so a copied `.env` nobody edited can't run with a secret that's in the repository. |
| `MASTER_KEY` | 32 random bytes, base64-encoded. Encrypts every stored credential and signs SAML. Losing it means re-entering every secret; back it up. Generate both this and `SESSION_SECRET` with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`, run twice. |
| `SMTP_URL` | Where outgoing mail (password resets, MFA-added notifications) is sent. |

The container path (`docker-compose.yml`) additionally requires:

| Variable | Meaning |
|---|---|
| `POSTGRES_PASSWORD` | The Postgres superuser password for the `postgres` container. |
| `SYNTRA_APP_PASSWORD` | The password for the `syntra_app` role that `DATABASE_URL` connects as inside the container. Read by `infra/initdb/01-app-role.sh`; not read anywhere outside `docker-compose.yml`. |

## Optional

Everything below has a default, and an install that sets none of them is a
supported, working configuration.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | The port the API listens on. |
| `SHADOW_DATABASE_URL` | — | The database `prisma migrate dev` builds and tears down to diff against. Needed only for `db:migrate:dev`, not for `db:migrate`. |
| `SUPERUSER_DATABASE_URL` | — | Tests only. Owns the `CREATE DATABASE` the test harness performs for each worker's shard — simulates an attacker with direct database access, the threat the audit hash chain exists to detect. Never used by the application itself. |
| `AUTH_RATE_LIMIT_MAX` | `10` | Authentication attempts per minute, per tenant per address. |
| `AUTH_RATE_LIMIT_TENANT_MAX` | 10× `AUTH_RATE_LIMIT_MAX` | Attempts per minute, per tenant, across every address at once — the ceiling that does not move when an attacker rents more addresses. |
| `SYNTRA_ALLOW_RESET` | unset | Tests only. The exact name of the database `pnpm db:reset` may empty. Refuses anything that is not a scratch `syntra_test_*` database unless this names the database in `DATABASE_URL` exactly — typing the name out is the point, so nobody pastes a truthy flag into the wrong shell. |
| `SYNTRA_TEST_WORKERS` | cores − 1, capped at 8 | Tests only. How many vitest workers/scratch databases the suite provisions. Force it to 1 to bisect a suspected ordering dependency, or match whatever CI pins it to. |
| `GOVERN_BUDGET_MS` | `2500` (CI: `4500`) | Tests only. The transaction-budget check's ceiling in milliseconds, for a runner slower than the machine it was calibrated on. Anything under Prisma's 5000ms interactive-transaction ceiling keeps the check meaningful. |
| `OUTBOUND_ALLOW_PRIVATE` | `false` | Whether outbound fetches to an administrator-supplied address (SAML metadata import, upstream OIDC discovery) may resolve to loopback, link-local, a private range or a unique-local range. Off by default as an SSRF guard; the SFTP integration test opens it on purpose because it connects to a container on a private address. Never set outside tests unless self-hosting an on-premises upstream identity provider genuinely needs it. |
| `SFTP_INTEGRATION` | unset | Tests only. The HR feed's SFTP integration test is skipped unless this is exactly `1`, so `pnpm test` stays hermetic. Bring the fixture up first with `pnpm sftp:up && pnpm sftp:wait`. |
| `SFTP_PORT` | `2222` | Which port the SFTP integration test connects to, if 2222 is taken. |
| `SAMBA_LDAPS_URL` | `ldaps://localhost:1637` | Tests only, for the Samba/Active Directory provisioning integration tests and the browser suite's provisioning spec. Matches `infra/docker-compose.yml`'s samba service; override only to point at a domain controller of your own. |
| `SAMBA_BASE_DN` | `DC=syntra,DC=test` | See above. |
| `SAMBA_BIND_DN` | `CN=Administrator,CN=Users,DC=syntra,DC=test` | See above. |
| `SAMBA_BIND_PASSWORD` | `Syntra!Passw0rd` | See above, matches the samba service's `DOMAINPASS`. |
| `LOG_LEVEL` | `info` | Fastify's own logger level: `error`, `warn`, `info`, `debug`, `trace`, `silent`. |
| `POLICY_COUNTRY_HEADER` | unset | The header naming the caller's country, for the policy engine's country conditions — Cloudflare sends `cf-ipcountry`; most other proxies need configuring by hand. Unset leaves every country condition unevaluable, which is right for a deployment with no proxy that sets one: guessing a header name would let an untrusted client claim its own country. |
| `WEB_ROOT` | unset | Where the built single-page application lives. Unset, the API serves itself alone — right for the test suite and `pnpm dev`, where Vite is the origin. Set it after `pnpm build` to serve the whole deployment from one process, one origin, one port; see [Install](install.md#running-the-built-application-as-one-process). |
| `GOVERN_CHECKPOINT_KEY` | unset | 32 bytes, base64-encoded. Signs Govern's audit checkpoints. A deployment with none configured is honest about it: `checkpointTrust` returns `unsigned_no_signer_configured` and the console says so, rather than claiming protection that isn't there. |
| `GOVERN_CHECKPOINT_KEY_ID` | `govern-checkpoint-1` | The id the checkpoint key above is known by. |
| `GOVERN_ANCHOR_DIR` | unset | A directory on a write-once volume where the weekly Govern anchor receipt is written. Neither this nor `GOVERN_ANCHOR_EMAIL` configured means the anchor job reports `not_configured` and the integrity screen states, in words, that nothing protects against the operator. |
| `GOVERN_ANCHOR_EMAIL` | unset | An address the weekly anchor receipt is mailed to, instead of or alongside `GOVERN_ANCHOR_DIR`. |

### TRUST_PROXY and proxy notes

`TRUST_PROXY` names which proxies may be believed about a request's source
address, which feeds both the policy engine's IP conditions and every
rate-limit key. Unset trusts no proxy, which is correct for a deployment
with none in front of it — behind any reverse proxy, every request otherwise
carries the proxy's own address, so the policy engine's source-IP condition
matches everyone or nobody and every per-IP rate limit collapses into one
global bucket.

Name the proxies to trust as addresses and CIDRs
(`10.0.0.0/8, 192.168.1.7`). **Never `true`** — that believes
`X-Forwarded-For` from any client, letting anyone choose their own source
address; the config loader refuses the literal value `true` by name rather
than accepting it.

**A hop count is refused too, and used to be accepted.** Fastify took a
number until 5.12.1, which fixed GHSA-3m5p-2c4r-xxw2 by making hop-count
trust fail closed — a count cannot check which proxy actually connected, so a
direct client could send enough hops to choose its own address. Upstream now
trusts *nothing* when given a number, so `TRUST_PROXY=1` would mean the same
as leaving it unset while reading as though a proxy were configured. The
config loader refuses it by name and names the address form to use instead.
If you are upgrading and had a hop count set, replace it with the addresses
your proxy connects from; the API will not start until you do, which is
deliberate — the alternative is a deployment that looks configured and is
not. The container path's own `docker-compose.yml` now trusts the private
ranges Docker allocates its bridge networks from, because nginx is the only
thing a client reaches, it connects from inside that network, and its address
there is assigned at run time rather than fixed.

### BOOTSTRAP variables

Read once, by `pnpm --filter @syntra/db bootstrap` (`packages/db/src/bootstrap.ts`),
to create the first tenant and its first administrator in a production
deployment — the dev `pnpm seed` is demo data and is not this. All required
when bootstrapping; there is no default tenant.

| Variable | Meaning |
|---|---|
| `BOOTSTRAP_TENANT_NAME` | The tenant's display name. |
| `BOOTSTRAP_TENANT_SLUG` | The tenant's slug — matches on any hostname whose leftmost label is this. |
| `BOOTSTRAP_TENANT_DOMAIN` | The tenant's primary domain. |
| `BOOTSTRAP_ADMIN_LOGIN` | The first administrator's login. Defaults to `admin`. |
| `BOOTSTRAP_ADMIN_EMAIL` | The first administrator's email address. |
| `BOOTSTRAP_ADMIN_PASSWORD` | The first administrator's password. At least 12 characters; bootstrap refuses a shorter one. |

Bootstrap refuses to run without `MASTER_KEY` set, unlike the dev seed which
merely warns — a production tenant with a SAML tile and no signing key is a
deployment an operator has to come back and fix by hand, and refusing up
front is cheaper than discovering it later as a `409 saml-no-key`.

### Updating from the console

`RELEASE_REPO`, `RELEASE_TOKEN`, `RELEASE_ROOT` and `PG_CONTAINER` configure
the in-console updater. See [Operating Syntra](operate.md#upgrades) for what
they do and how upgrades work.

### Metrics

`METRICS_TOKEN` is the bearer token a Prometheus scraper presents at
`/metrics`. Sixteen characters minimum, and it should be random.

**Unset is the off switch, not a default.** With no token the route is never
registered and the path answers 404 rather than 403 — a route that answered 403
would confirm its own existence. See
[Operating Syntra](operate.md#metrics) for what is exposed, and why there are
no per-tenant labels.

## Tenants and hostnames

Syntra picks the tenant from the `Host` header, and a tenant answers on three
things: its **primary domain**, any of its **additional domains**, and any
hostname whose leftmost label is its **slug** (so `acme.anything.example.com`
finds the tenant with slug `acme`). An unrecognised host is a 404 — there is
no default tenant.

Add a new name to **Also answers on** in tenant settings *before* the DNS
record propagates, so the cutover has no window where the old name has
stopped working and the new one has not started. An IP address is a valid
entry too.

Additional names are **not** the WebAuthn relying party — security keys are
bound to the primary domain — and they do not bypass the **development
server's** host check (`WEB_ALLOWED_HOSTS`, covered in
[Install](install.md#reaching-an-instance-by-more-than-one-name)). Neither
limit applies to the served build, which has no host check of its own: the
tenant lookup is the check.

Nothing derives an issuer, an entity ID, an audience or a redirect target
from the `Host` header — those come from the tenant's own `primaryDomain`
and from `PUBLIC_URL`. `assertProtocolHost` refuses a protocol request that
did not arrive on the host those identifiers name.

## Connecting a directory source

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
`DELETE /api/admin/users/:id/factors/:type`, and the account detail page has a
button for each enrolled factor that calls it
(`apps/web/src/pages/admin/AccountDetailPage.tsx`).

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

**Requiring signed `AuthnRequest`s is the default for a newly registered
service provider**, and the API will not leave it on with no certificate to
check against. An unsigned authentication request is something anyone can
send: hand a signed-in user a link carrying one and Syntra would mint an
assertion for them and post it to the service provider's real endpoint.
Turning it off is a posture an administrator may choose per application, and
it has to be chosen — importing metadata that publishes no signing
certificate is refused rather than quietly writing the weaker setting.

**Redirect URIs and assertion consumer service URLs are matched byte for
byte.** There is no wildcard, no prefix and no normalization anywhere in the
comparison, and the registration form refuses a URL that is not a plain
http(s) address — no fragment, no embedded credentials, and nothing in the
host that is not a host. A pattern like `https://*.example.test/cb` is
refused at the form rather than accepted and then silently never matched.

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

**Rolling a SAML signing key is an operator's decision**, and there is no
console button for it: `rotateKey(tenantId, provider, 'saml')` is the call,
and the tenant's metadata must be re-published to the service providers
afterwards. SAML keys are minted with a three-year lifetime and are not
rotated automatically, unlike OIDC signing keys, which rotate monthly on the
job scheduler with the outgoing key published beside the incoming one for a
week. A service provider typically has the identity provider's certificate
pasted into its own configuration rather than re-reading metadata, so an
automatic SAML rotation would silently break every integration that pinned
it, one week later.

**The console has screens for protocol configuration and claims, not for
upstreams or routing.** `ApplicationSso.tsx` covers SAML and OIDC
configuration and metadata import, against `/api/admin/applications/:id/saml`
and `/applications/:id/oidc`; `ApplicationClaims.tsx` covers claim mappings,
against `/applications/:id/claims`. Upstream identity providers and routing
(`federate`) rules are still API-only, at `/api/admin/upstreams` and
`/api/admin/policy/rules`. The policy screen writes tenant-wide rules and
does not offer the application scope, the upstream, or the login domains.
Both are reachable and tested; neither has a form yet.

**Groups asserted by an upstream grant nothing.** `groupsAttribute` is read,
carried through provisioning and recorded on `federation.user_provisioned`,
and that is all it does: it does not create groups, does not add anybody to
one, and does not feed the policy engine's group conditions. It is there so
the mapping can be verified against real traffic before anything acts on it.
**Do not size a policy on it.**

**An `id_token` signed with HS256 from an upstream is refused, and the reason
is only in the log.** `openid-client` does not verify an `id_token`'s
signature by default; Syntra turns that on, which means the signature must
verify against a key the provider publishes in its JWKS. A symmetric
algorithm publishes no key, so a provider configured for HS256 fails the
exchange with `federation.exchange_refused` and a message in the server log
— the administrator sees a failed sign-in and nothing pointing at the
algorithm.

**One grant is an exemption, deliberately.** The OAuth 2.0 *client
credentials* grant issues an access token with no `authorize()` decision
behind it, because there is no person for a decision to be about: it
authenticates a client, and a policy that matches on group membership,
contract attributes and enrolled factors has nothing to say about one. The
alternative would be to invent a service-account user — a user-shaped
principal no policy meaningfully governs, appearing in the directory,
resolvable by assignment, and counted in other subsystems' guard
denominators — which is worse than naming the exemption and bounding it. It
is bounded by four things:

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

### Audit events

The names are `<area>.<past-tense event>`; the source of truth is every
`recordEvent` call under `apps/api/src/routes` and `packages/core/src`, and
`grep -rn "action: '"` over those two trees will always be more current than a
list. This slice adds:

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
| `federation.user_provisioned` | An upstream login created a local account, carrying the groups the upstream asserted (which grant nothing — see above) |
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

The forced-enrolment trade above is defensible *because* the enrolment is
visible after the fact, so **wire these into your alerting.** An audit row
nobody reads does not discharge the obligation.

### Getting them out

A webhook endpoint can subscribe to three security groups, alongside the six
Automate and Govern ones:

| Group | What arrives |
|---|---|
| **Sign-in security** | Lockouts, failed second factors, policy denials, refused protocol signatures, and administrative elevation |
| **Credentials** | Second factors enrolled or removed, recovery codes issued, passwords changed or renewed, sessions and tokens revoked |
| **Configuration changes** | Policy rules, roles, tenant settings, protocol and upstream configuration, webhook endpoints, and deployment updates |

An endpoint subscribed to **Configuration changes** is told when webhook
endpoints change, **including its own** — somebody quietly repointing an
integration is exactly the change an integration should announce.

For finer control, an endpoint may name a single action (`auth.lockout`) or a
prefix (`policy.*`) instead of a group.

**The body is a projection, not the audit row.** It carries seven fields and
no others:

```json
{
  "action": "auth.lockout",
  "outcome": "failure",
  "occurredAt": "2026-08-29T02:11:04.512Z",
  "sequence": 4412,
  "actorUserId": null,
  "targetType": "User",
  "targetId": "…"
}
```

There is **no `payload` and no `sourceIp`**. An audit payload is written for an
authenticated reader inside the console — before-and-after values, statuses,
reasons — and a webhook goes to a URL an administrator typed, over the
internet, to a receiver Syntra cannot vouch for. Forwarding it would make every
future audit call a disclosure decision taken months earlier by somebody with
no idea their field would leave the building.

A receiver that needs the detail has `sequence` and can read the audit log
through the API, authenticated, which is where that decision belongs.

**`auth.login` is in no group, deliberately.** It fires on every successful
sign-in as well as every failed one, so a subscription containing it would
deliver a webhook per sign-in — a thousand on a Monday morning for a
thousand-user tenant, each with its own retry ladder. `auth.lockout` is the
aggregated signal, and it is the one worth waking somebody for. A receiver
that genuinely wants every attempt should poll the audit log, which is indexed
for it.

### What this slice does not do

**A policy change does not reach sessions that are already live.** Turning on a
`require_mfa` rule takes effect at the next sign-in, elevation or application
launch; every session issued before it stays usable until it expires. A portal
session lasts twelve hours, or one idle hour; an administrative one lasts two
hours, or fifteen idle minutes. That is a deliberate trade against re-evaluating
policy on every request, and it is why an administrator who turns a rule on can
still take it away again from the same session. If you need a rule to bite
immediately, revoke the sessions as well: **Sessions** on the account in the
console lists everything that account currently holds — where from, which
browser, when it was established and when it was last used — with a revoke on
each row and a **Sign out everywhere** above them. Over the API that is
`GET`, `DELETE` and `POST /api/admin/users/:id/sessions[/revoke]`, and a person
can end their own from **Where you are signed in** on their security page.

**Deactivation is the exception, and it is immediate** — see
[Operate](operate.md#deactivate-never-delete).

### What the federation half does not do

Each of these is a deliberate absence rather than an oversight, and each is
worth reading before this is put in front of users.

**SAML single logout does not propagate to other service providers.** Ending a
session through `/saml/slo` ends it *at Syntra* and answers the service
provider that asked. Every other SAML service provider the same person signed
into still holds its own session until that session expires. Front-channel
propagation needs the browser to visit each one in turn, and one dead service
provider stalls the rest; back-channel needs the SOAP binding, whose support
across service providers is patchy. Neither is here, so **SAML single logout is
a local logout with a protocol answer attached, and an offboarding procedure
must not rely on it.** Deactivating the account does work immediately, because
a user's status is re-read on every request.

**OIDC relying parties are told, if they asked to be.** Set a **Back-channel
logout endpoint** on the application's SSO settings and Syntra POSTs a signed
logout token there whenever that person's session ends — an administrator
revoking it, the person signing out, a password reset or change, a
deactivation, or a sync-driven leaver. The token is signed with the same key
the id tokens are, so it verifies against the JWKS the relying party already
fetches, and `backchannel_logout_supported` is advertised in discovery.

A client with no endpoint configured is not told, which is the default. A
delivery that fails is retried on the same ladder webhooks use — 30 seconds, 2
minutes, 10 minutes, 1 hour, 6 hours — and a delivery that runs out of attempts
stays in the table with the status and error it stopped on. **A failed logout
is a row somebody can look at, not a silent gap**, which is the reason this is
back-channel rather than a chain of browser redirects.

**There is no single logout on the consuming side either.** Signing out of
Syntra does not sign the person out of the upstream identity provider that
authenticated them, so the next sign-in may complete without a prompt. That is
the upstream's session, not Syntra's, and Syntra never had a handle on it.

**A LogoutResponse is not signed on either binding.** It says only that a
session Syntra had already ended is ended, and the request that asked for it
was verified. A service provider that requires a signed LogoutResponse is not
served today; `logoutRedirectUrl` and `logoutPostForm` are where that would go.

**Token revocation and introspection are Syntra's own routes.** Both are
registered in the plugin that owns client authentication rather than falling
through to `oidc-provider`, because `oidc-provider` is handed a *placeholder*
client secret it never learns the real value of — that is what makes `/token`
safe, and it is why every endpoint the library authenticates for itself would
refuse a client presenting its correct one. Client authentication on these two
is constant-time against the stored SHA-256 hash, exactly as `/token` does it.

Two behaviours are worth knowing before you integrate:

- **Revocation always answers `200`** — whether the token existed, had already
  been revoked, or belongs to another client. RFC 7009 requires it, and it is
  also the only answer that does not turn the endpoint into an oracle for
  guessing other clients' tokens. Revoking a refresh token takes its whole
  grant, so the access tokens issued under it die with it.
- **A client may introspect only its own tokens.** Anything else — unknown,
  expired, revoked, or issued to a different client — is `{"active": false}`,
  with no way to tell those cases apart. A client holding one token must not be
  able to learn the subject and scope of another.

Everything else `oidc-provider` owns still cannot see a real client secret, and
that is still correct.

**A refused request signature is not in the audit log.** A service provider
whose `AuthnRequest` fails signature verification gets a 400 or a 409 naming
the setting and the application, and the server logs it — but there is no
`recordEvent` for it, so it does not appear in the tamper-evident log or in the
console's audit screen. A service provider that has stopped signing correctly
is visible in the API logs and nowhere else.

**Signed metadata, back-channel logout, a consent screen and a scheduled sweep
of expired artifacts are all out.** The identity-provider metadata document is
unsigned — it is served over TLS from the tenant's own host, which
`assertProtocolHost` enforces. Assignment is the consent decision, so there is
no per-launch consent screen. `sweepExpiredArtifacts` exists and expiry is
enforced on read, but nothing runs it on a schedule; the table grows until
somebody does.

## Machine access

A program that needs to call Syntra's API holds an **API token**, issued
against a service account.

A service account is an ordinary user with nobody behind it — no linked person.
Everything that applies to an account applies to it: roles, the audit log,
deactivation, and Govern's recertification campaigns. That is deliberate.
Machine access is the access most worth reviewing and least often reviewed, and
giving it its own concept would have put it outside every control that already
exists.

### Issuing one

**Sessions → the account → API tokens**, in the console, or
`POST /api/admin/users/:id/tokens`. It needs `token.manage`, which is separate
from `directory.write` on purpose: issuing a credential that *acts as* an
account is a different authority from editing that account's display name.

The token is shown **once**. There is no route that reads it back and no column
it could be read back from — a lost token is replaced, not recovered.

It looks like this:

```
syntra_pat_4f3c9a1e…
```

and is presented as `Authorization: Bearer syntra_pat_…`. The prefix is there
so a leaked token is recognisable — in a log, in a paste, to a secret scanner
watching a repository — as a Syntra credential rather than an opaque blob
nobody investigates.

### What it can do

**The intersection of the account's roles and the token's own scopes, and
never the union.**

- Scopes narrow. A token scoped `directory.read` on an account that also holds
  `directory.write` cannot write.
- Scopes cannot widen. A token scoped `directory.write` on an account that
  holds only `directory.read` cannot write either.
- An empty scope list means the account's own authority. The console always
  writes an explicit list.

Two consequences worth planning around. **Revoking the service account's role
revokes every token it ever issued**, at once — which is what makes offboarding
an integration a single act. And a token minted for one job cannot quietly do
everything the account can, so one over-broad account does not become many
over-broad credentials.

### What it cannot do, whatever it holds

- **Authenticate or elevate** (`/api/auth/…`). A token is already
  authenticated, and one that could elevate would be one that could mint a
  session.
- **Set a person's password.** Handing a program the ability to set a human's
  credential is a different authority from managing the directory.
- **Reach the portal.** A machine has no applications to launch.
- **Issue or revoke tokens.** A credential that can mint credentials is a
  credential whose revocation does not end its authority: revoke the first, the
  second keeps working, and nobody has a reason to look for it.

All four answer `403`, never `401`. The credential was fine; the route is not
one a machine may use, and a `401` would send an integrator to check a token
that is perfectly good.

### Policy applies to machines

A token goes through the same `authorize()` as everybody else, so an IP rule
confines it to the host that should be presenting it — which is the one control
that limits the damage of a stolen token.

**A rule that requires a second factor REFUSES a token.** This is the surprise
worth knowing before you meet it. A bearer token cannot answer a challenge, so
the rule is honoured the only way it can be: the request is denied, the audit
log records `auth.token_denied` with the rule's name, and the integration will
keep failing for as long as that rule matches it. Allowing it instead would
mean an operator believing a second factor was enforced on a caller that never
presented one.

A deactivated service account's tokens stop at the next request, not at their
expiry.

### Expiry, and finding the ones nobody uses

The console suggests ninety days. A token that never expires is allowed —
an integration nobody is staffed to rotate is worse broken than long-lived —
but it is a choice somebody makes, and the list marks it.

Every token records when it was **last used**, written at most once a minute.
That column is what makes a dormant integration findable, and a credential
nobody can tell is unused is a credential nobody ever revokes.

## Provisioning into Syntra with SCIM

Syntra is a SCIM 2.0 target at `/scim/v2`. An identity provider — Entra, Okta,
Workday — pushes users and groups into it, rather than Syntra polling them.

This is the **push** counterpart to the pull connectors above, not a
replacement for them. LDAP sync and the HR feed still read on a schedule; SCIM
lets a system that already knows the moment something changed tell you.

### Setting it up

1. **Create a SCIM source.** It is a directory source like any other, and it is
   what will own everything the IdP pushes.
2. **Create a service account** — a user with nobody behind it — and give it a
   role holding `directory.write`.
3. **Issue an API token** for it (see [Machine access](#machine-access)).
4. In the IdP, set the base URL to `https://<your-host>/scim/v2` and the secret
   token to the value from step 3.

**Test with a read-only token first.** A token scoped to `directory.read` can
list and read and nothing else, which proves the connection, the URL and the
credential before anything can be changed by a rule you have not finished
writing.

### What to expect

**`DELETE` deactivates.** SCIM says remove; this directory has no Delete
anywhere, because deactivation revokes real access, grants nothing, and keeps
the trail of who had what and why it changed. The client gets its `204`, the
account stops working immediately, and the record survives. `active: false` on
a `PUT` or `PATCH` does the same thing, and is what Entra and Okta actually
send when they deprovision.

`ServiceProviderConfig` says this, so a client's administrator can read it
before an audit rather than during one.

**Passwords are ignored.** SCIM allows a `password` attribute; Syntra accepts
it and drops it. Password rules — the tenant floor, ageing, renewal, upstream
write-back — live in one place, and a provisioning protocol is not the place to
route around them. `changePassword` is advertised as unsupported.

**What SCIM creates, SCIM owns.** A pushed account carries the SCIM source's
id, so editing it by hand in the console is refused with the same message any
source-owned account gives. It also cuts the other way: a `POST` whose
`userName` already belongs to an LDAP-anchored account is a `409 uniqueness`,
not a takeover. The account belongs to the system that anchored it.

**A Person is created only when the payload has both names.** An IdP that knows
a login and an address makes an account and nothing else — filling the person
register with half-records that no HR feed will ever reconcile against would be
worse than leaving the account standing alone, which is what a service account
does anyway.

### Filters and paging

`userName eq "…"` and `externalId eq "…"` on `/Users`; `displayName eq "…"` and
`externalId eq "…"` on `/Groups`. Anything else is a `400 invalidFilter`
naming what is supported.

That is what Entra and Okta send to correlate before deciding whether to POST
or PATCH. The rest of the filter grammar is a parser with its own surface, and
a filter half-understood and applied wrongly returns the wrong users while the
client believes the answer.

`startIndex` is **1-based**, as the RFC specifies. `startIndex=0` is refused
rather than read as 1, because a client that is off by one is a client whose
next page skips somebody.

### What is deliberately absent

`/Me`, bulk operations, and ETags. `ServiceProviderConfig` reports each as
unsupported so a client learns it by reading rather than by failing.

## Further reading

- [Install](install.md) — development and container installs, TLS.
- [Operating Syntra](operate.md) — upgrades, backups, CI, tests,
  troubleshooting.
