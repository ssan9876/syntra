# Configuring Syntra

Every variable Syntra reads, what it does, and what it defaults to; then the
directories it reads from, the systems it provisions into, the applications
it signs people in to, and the API an integration calls. Comments in
`.env.example` and `packages/core/src/config.ts` are the source of truth for
the variables; this page collects them in one place.

- [Required](#required) and [Optional](#optional) environment variables,
  including [outgoing mail](#outgoing-mail), [`TRUST_PROXY`](#trust_proxy-and-proxy-notes),
  [bootstrap](#bootstrap-variables) and [seed](#seed-variables)
- [Where the variables go](#where-the-variables-go) — `.env`, Compose, Helm,
  the release layout
- [Key management](#key-management) — `MASTER_KEY`, Vault Transit, AWS KMS
- [Tenants and hostnames](#tenants-and-hostnames)
- [Connecting a directory source](#connecting-a-directory-source), and
  [Active Directory as a source](#active-directory-as-a-source)
- [Connectors: provisioning into target systems](#connectors-provisioning-into-target-systems)
  — [Active Directory](#active-directory), [Microsoft Entra ID](#microsoft-entra-id),
  [SCIM 2.0](#scim-20-targets), [REST API documents](#rest-api-connector-documents)
  including [Snipe-IT](#snipe-it), and
  [certification and rollout](#connector-certification-capabilities-and-rollout)
- [Access: signing in, second factors and policy](#access-signing-in-second-factors-and-policy),
  including [signing in to applications](#signing-in-to-applications) and
  [setting up a SAML application](#setting-up-a-saml-application)
- [New accounts' sign-in details](#new-accounts-sign-in-details)
- [Credentials and security notifications](#credentials-and-security-notifications)
- [Machine access](#machine-access) — service accounts and API tokens
- [Provisioning into Syntra with SCIM](#provisioning-into-syntra-with-scim)
- [The administration API](#the-administration-api)
- [Personal data](#personal-data)

## Required

These have no default. The API refuses to start without them.

| Variable | Meaning |
|---|---|
| `DATABASE_URL` | The Postgres connection string, as the `syntra_app` role. |
| `PUBLIC_URL` | The origin users type. The session cookie and the WebAuthn relying party are derived from it, so it has to be the address the browser actually sees, not an internal one. |
| `SESSION_SECRET` | At least 32 characters, and not the `.env.example` placeholder — the API refuses to start on the literal placeholder value so a copied `.env` nobody edited can't run with a secret that's in the repository. |
| `MASTER_KEY` | 32 random bytes, base64-encoded. Encrypts every stored credential and signs SAML. Losing it means re-entering every secret; back it up. Generate both this and `SESSION_SECRET` with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`, run twice. Required with the default `MASTER_KEY_PROVIDER=local`; optional when Vault Transit or AWS KMS holds the master key -- see [Key management](#key-management). |
| `SMTP_URL` | Where outgoing mail (password resets, MFA-added notifications, new accounts' sign-in links) is sent. Required with the default `MAIL_TRANSPORT=smtp`; not needed when mail goes through Microsoft 365 -- see [Outgoing mail](#outgoing-mail). |

The container path (`docker-compose.yml`) additionally requires:

| Variable | Meaning |
|---|---|
| `POSTGRES_PASSWORD` | The Postgres superuser password for the `postgres` container. |
| `SYNTRA_APP_PASSWORD` | The password for the `syntra_app` role that `DATABASE_URL` connects as inside the container. Read by `infra/initdb/01-app-role.sh`; not read anywhere outside `docker-compose.yml`. |

And reads two optional ones of its own:

| Variable | Default | Meaning |
|---|---|---|
| `SYNTRA_VERSION` | `latest` | Which published release to pull: the version part of a release tag (`1.4.0` for `v1.4.0`), not the tag itself. |
| `SYNTRA_DOMAIN` | — | Required by the `docker-compose.tls.yml` overlay only: the hostname Caddy obtains a certificate for. It must resolve to this host on ports 80 and 443. Set `PUBLIC_URL=https://$SYNTRA_DOMAIN` with it, or every absolute link Syntra builds still says `http`. |

## Optional

Everything below has a default, and an install that sets none of them is a
supported, working configuration.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | The port the API listens on. |
| `SHADOW_DATABASE_URL` | — | The database `prisma migrate dev` builds and tears down to diff against. Needed only for `pnpm --filter @syntra/db migrate:dev`, not for `pnpm db:migrate`. `syntra-update` passes it to the migration step when `shared/.env` sets it, and falls back to `DATABASE_URL`. |
| `SUPERUSER_DATABASE_URL` | — | Owns the `CREATE DATABASE` the test harness performs for each worker's shard — simulates an attacker with direct database access, the threat the audit hash chain exists to detect. Never used by the API itself. On the release layout, `syntra-update` and `syntra-backup` take the **role** from it to run `pg_dump`, because a dump taken as `syntra_app` sees no rows under row-level security; without it they fall back to a role named after the database. |
| `AUTH_RATE_LIMIT_MAX` | `10` | Authentication attempts per minute, per tenant per address. |
| `AUTH_RATE_LIMIT_TENANT_MAX` | 10× `AUTH_RATE_LIMIT_MAX` | Attempts per minute, per tenant, across every address at once — the ceiling that does not move when an attacker rents more addresses. |
| `RATE_LIMIT_STORE` | `postgres` | Where rate-limit counters live. `postgres` shares one counter per key across every API process, so the limits above apply to the deployment as a whole. `memory` keeps per-process counters, which is correct only with a single process; with N processes each limit is effectively N times larger. |
| `SYNTRA_ALLOW_RESET` | unset | Tests only. The exact name of the database `pnpm db:reset` may empty. Refuses anything that is not a scratch `syntra_test_*` database unless this names the database in `DATABASE_URL` exactly — typing the name out is the point, so nobody pastes a truthy flag into the wrong shell. |
| `SYNTRA_TEST_WORKERS` | cores − 1, capped at 8 | Tests only. How many vitest workers/scratch databases the suite provisions. Force it to 1 to bisect a suspected ordering dependency, or match whatever CI pins it to. |
| `GOVERN_BUDGET_MS` | `2500` (CI: `4500`) | Tests only. The transaction-budget check's ceiling in milliseconds, for a runner slower than the machine it was calibrated on. Anything under Prisma's 5000ms interactive-transaction ceiling keeps the check meaningful. |
| `OUTBOUND_ALLOW_PRIVATE` | `false` | Whether outbound fetches to an administrator-supplied address (SAML metadata import, upstream OIDC discovery, the HR feed's SFTP connector) may resolve to loopback, link-local, a private range or a unique-local range. Only the exact value `true` opens it. Off by default as an SSRF guard; the SFTP integration test opens it on purpose because it connects to a container on a private address. Never set outside tests unless self-hosting an on-premises upstream identity provider genuinely needs it. Provisioning targets have their own per-target switch instead (`allowPrivateAddresses`, below). |
| `NODE_EXTRA_CA_CERTS` | unset | Node's own variable, not Syntra's, and the only way to make Syntra trust a private certificate authority — an Active Directory enterprise CA for LDAPS, or the CA in front of Vault. **Node ignores the system CA store**: `update-ca-certificates` satisfies `openssl` and `curl` and does nothing for Node, so LDAPS fails with *unable to verify the first certificate* while `openssl s_client` against the same host verifies cleanly. Point it at the CA's PEM file. |
| `SFTP_INTEGRATION` | unset | Tests only. The HR feed's SFTP integration test is skipped unless this is exactly `1`, so `pnpm test` stays hermetic. Bring the fixture up first with `pnpm sftp:up && pnpm sftp:wait`. |
| `SFTP_PORT` | `2222` | Which port the SFTP integration test connects to, if 2222 is taken. |
| `SAMBA_LDAPS_URL` | `ldaps://localhost:1637` | Tests only, for the Samba/Active Directory provisioning integration tests and the browser suite's provisioning spec. Matches `infra/docker-compose.yml`'s samba service; override only to point at a domain controller of your own. |
| `SAMBA_BASE_DN` | `DC=syntra,DC=test` | See above. |
| `SAMBA_BIND_DN` | `CN=Administrator,CN=Users,DC=syntra,DC=test` | See above. |
| `SAMBA_BIND_PASSWORD` | `Syntra!Passw0rd` | See above, matches the samba service's `DOMAINPASS`. |
| `LOG_LEVEL` | `info` | Fastify's own logger level: `error`, `warn`, `info`, `debug`, `trace`, `silent`. Every level goes through the same redaction; `debug` does not relax it. See [Observability](operate.md#observability). |
| `POLICY_COUNTRY_HEADER` | unset | The header naming the caller's country, for the policy engine's country conditions — Cloudflare sends `cf-ipcountry`; most other proxies need configuring by hand. Unset leaves every country condition unevaluable, which is right for a deployment with no proxy that sets one: guessing a header name would let an untrusted client claim its own country. |
| `WEB_PORT` | `5173` | Development server only (`apps/web/vite.config.ts`). The port Vite listens on; it fails rather than moving to the next free port when this one is taken. |
| `WEB_HOST` | `127.0.0.1` | Development server only. The address Vite binds — IPv4 loopback on purpose, so the browser suite's `*.localhost` mapping reaches it. |
| `API_TARGET` | `http://127.0.0.1:3000` | Development server only. Where Vite proxies the API's paths; change it with `PORT` to run a second stack beside the first. |
| `WEB_ALLOWED_HOSTS` | unset | Development server only. Extra hostnames Vite will answer for, comma-separated, or `true` for any. Unset allows `localhost` and IP addresses only; see [Install](install.md#reaching-an-instance-by-more-than-one-name). |
| `WEB_ROOT` | unset | Where the built single-page application lives. Unset, the API serves itself alone — right for the test suite and `pnpm dev`, where Vite is the origin. Set it after `pnpm build` to serve the whole deployment from one process, one origin, one port; see [Install](install.md#running-the-built-application-as-one-process). |
| `GOVERN_CHECKPOINT_KEY` | unset | 32 bytes, base64-encoded. Signs Govern's audit checkpoints. A deployment with none configured is honest about it: `checkpointTrust` returns `unsigned_no_signer_configured` and the console says so, rather than claiming protection that isn't there. |
| `GOVERN_CHECKPOINT_KEY_ID` | `govern-checkpoint-1` | The id the checkpoint key above is known by. |
| `GOVERN_ANCHOR_DIR` | unset | A directory on a write-once volume where the weekly Govern anchor receipt is written. Neither this nor `GOVERN_ANCHOR_EMAIL` configured means the anchor job reports `not_configured` and the integrity screen states, in words, that nothing protects against the operator. |
| `GOVERN_ANCHOR_EMAIL` | unset | An address the weekly anchor receipt is mailed to, instead of or alongside `GOVERN_ANCHOR_DIR`. |

### Outgoing mail

| Variable | Default | Meaning |
|---|---|---|
| `MAIL_TRANSPORT` | `smtp` | `smtp` sends through `SMTP_URL`. `graph` sends through Microsoft 365 with Microsoft Graph's `sendMail`, and then `SMTP_URL` is not needed. |
| `MAIL_FROM` | `Syntra <no-reply@syntra.local>` (SMTP); the sender mailbox (Graph) | The From header, as `Name <address>` or a bare address. With Graph, an address other than `MAIL_GRAPH_SENDER` needs Send As rights on it, or Graph refuses the message. |
| `MAIL_GRAPH_TENANT_ID` | — | Graph only, required. The directory (tenant) id, or a verified domain such as `contoso.onmicrosoft.com`. |
| `MAIL_GRAPH_CLIENT_ID` | — | Graph only, required. The application (client) id of the app registration. |
| `MAIL_GRAPH_CLIENT_SECRET` | — | Graph only, required. The app registration's client secret. Keep it with the other secrets, not in a values file or a ConfigMap; it is never logged or audited. |
| `MAIL_GRAPH_SENDER` | — | Graph only, required. The mailbox mail is sent as: its UPN or primary SMTP address. |

`SMTP_URL` takes credentials and TLS in the URL:
`smtps://user:password@mail.example.com:465`. The development default,
`smtp://localhost:1025`, is MailDev, which accepts everything and delivers
nothing. Two separate things decide whether a message is useful: **the address
it goes to** comes from the account, which for a directory-managed account is
the directory's `mail` attribute — `user@example.local` is an address no real
mail server accepts, and has to be fixed in the directory, because the next
sync rewrites it — and **the links inside it** come from `PUBLIC_URL`, which
must be the externally reachable name.

With `MAIL_TRANSPORT=graph` the API refuses to start unless all four `MAIL_GRAPH_*`
variables are set, and names every missing one. The status page's mail check
fetches a token and sends nothing. The container path passes all of them
through from the environment; under Helm they are `mail.transport`,
`mail.from` and `mail.graph.{tenantId,clientId,sender}` in values, with the
client secret read from the Secret key named by
`secretKeys.mailGraphClientSecret`.

#### Sending through Microsoft 365

Syntra sends as **one mailbox** and nothing else. Do not add the Graph
`Mail.Send` application permission to the app registration, and do not grant
admin consent for it: that grant lets the application send as *every* mailbox
in the tenant, and Exchange Online's RBAC for Applications only adds to a
tenant-wide grant, it cannot narrow one. The access comes from Exchange
instead:

1. **Register an application** in Microsoft Entra ID with a client secret and
   **no Graph API permissions**. Note its application (client) id, and the
   **object id of its Enterprise application** (the service principal: Entra
   ID → Enterprise applications → the app → Object ID). That is not the object
   id shown on the app registration.
2. **Create a shared mailbox** for the sender, for example
   `syntra@contoso.com`. It needs no licence.
3. **Let the application send as that mailbox only**, in Exchange Online
   PowerShell (`Connect-ExchangeOnline`):

   ```powershell
   New-ServicePrincipal -AppId <clientId> -ObjectId <enterprise app object id> -DisplayName "Syntra Mail"
   New-ManagementScope -Name "Syntra sender" -RecipientRestrictionFilter "PrimarySmtpAddress -eq 'syntra@contoso.com'"
   New-ManagementRoleAssignment -App <clientId> -Role "Application Mail.Send" -CustomResourceScope "Syntra sender"
   ```

4. **Check it**:

   ```powershell
   Test-ServicePrincipalAuthorization -Identity <clientId> -Resource syntra@contoso.com
   ```

   `InScope` should be `True` for `Application Mail.Send`. Test another mailbox
   too; it should be `False`.

Then set `MAIL_TRANSPORT=graph`, `MAIL_GRAPH_TENANT_ID`, `MAIL_GRAPH_CLIENT_ID`,
`MAIL_GRAPH_CLIENT_SECRET` and `MAIL_GRAPH_SENDER=syntra@contoso.com`, and allow
outbound HTTPS to `login.microsoftonline.com` and `graph.microsoft.com`.

**A 403 from `sendMail`** (`ErrorAccessDenied`) almost always means the
management scope does not cover `MAIL_GRAPH_SENDER`: a typo in the filter, a
different primary SMTP address, or a scope created for a different mailbox.
RBAC for Applications changes **can take up to about two hours** to take
effect, so a correct setup can still answer 403 for a while after step 3.
A token error (`invalid_client`, `AADSTS7000215`) is the client secret: wrong,
expired, or copied as its id rather than its value.

Messages are sent with `saveToSentItems: false`. Some of them carry a one-time
link, and a Sent Items folder is one more place that would keep it.

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

**Name the address the proxy connects from, which is not always the proxy's
public one.** Behind a Cloudflare tunnel it is the host running the tunnel
connector (`TRUST_PROXY=192.0.2.200`); behind an ingress controller it is the
pod network's range (`api.trustProxy: 10.244.0.0/16` under Helm, which refuses
to render `true` or a hop count for the same reason the API refuses to start
on them). Get it wrong and nothing fails loudly: every request simply carries
the proxy's address, and source-address policy conditions and per-address rate
limits quietly stop meaning anything. A proxy that sets a country header can
feed the policy engine's country conditions through `POLICY_COUNTRY_HEADER`;
Cloudflare's is `cf-ipcountry`.

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

Bootstrap refuses to run without a master key -- `MASTER_KEY`, or an external
provider configured as in [Key management](#key-management), which then seals
the first signing key -- unlike the dev seed which
merely warns — a production tenant with a SAML tile and no signing key is a
deployment an operator has to come back and fix by hand, and refusing up
front is cheaper than discovering it later as a `409 saml-no-key`.

`pnpm bootstrap` at the repository root runs the same script. It is safe to
run twice: a tenant whose slug already has an administrator is left alone and
the script says *Nothing to do*.

### SEED variables

Read once, by `pnpm seed` (`packages/db/src/seed.ts`), which creates **demo
data** — the `acme` tenant on `acme.localhost`, an administrator (`admin`), an
ordinary portal user (`jdoe`), a deactivated leaver (`sroe`) and an account
with no person behind it (`svc-backup`), for development and for the browser
suite. It is not the production bootstrap above and must not be used as one.

| Variable | Meaning |
|---|---|
| `SEED_ADMIN_PASSWORD` | The demo `admin` account's password. Required — the seed refuses to run without it, and refuses anything under 12 characters. |
| `SEED_USER_PASSWORD` | The demo `jdoe` account's password. Falls back to `SEED_ADMIN_PASSWORD` when unset. |
| `SEED_DEMO` | Exactly `1` adds lifecycle scenarios (a hire half-provisioned, a failed target, a write waiting for read-back, an overdue departure) and portal categories, against two **disabled** demo targets. Off by default because the browser suite counts rows on a plain seed. |

`SEED_ADMIN_PASSWORD` is required rather than defaulted for one reason: a seed
with a built-in password creates a well-known administrator on every machine it
ever runs on, including the one somebody puts on a network "just to have a look".

### Updating from the console

`RELEASE_REPO`, `RELEASE_TOKEN`, `RELEASE_ROOT` (default `/opt/syntra`) and
`PG_CONTAINER` configure the in-console updater. `PG_CONTAINER` names the
PostgreSQL container the pre-migration dump is taken through; `syntra-update`
falls back to `infra-postgres-1`, and `syntra-backup` refuses to run without
it. See [Operating Syntra](operate.md#upgrades) for what they do and how
upgrades work.

### Metrics

`METRICS_TOKEN` is the bearer token a Prometheus scraper presents at
`/metrics`. Sixteen characters minimum, and it should be random.

**Unset is the off switch, not a default.** With no token the route is never
registered and the path answers 404 rather than 403 — a route that answered 403
would confirm its own existence. See
[Operating Syntra](operate.md#metrics) for what is exposed, and why there are
no per-tenant labels.

### Tracing (OpenTelemetry)

Optional, and **off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set**. Off means
the SDK is never loaded and every instrumented call site checks one flag and
calls straight through. Correlation ids (below) work either way.

| Variable | Default | Meaning |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | The OTLP/HTTP collector base URL, for example `http://otel-collector:4318`. Setting it turns tracing on; traces are sent to `<endpoint>/v1/traces`. Only the host is ever logged. |
| `OTEL_SDK_DISABLED` | unset | `true` keeps tracing off even with an endpoint set — the switch for turning it off without editing the endpoint out. |
| `OTEL_SERVICE_NAME` | `syntra-api` | The `service.name` resource attribute. |
| `OTEL_RESOURCE_ATTRIBUTES` | unset | Extra resource attributes, `key=value,key=value` — `deployment.environment=production`, say. |
| `OTEL_EXPORTER_OTLP_HEADERS` | unset | Headers sent with every export, typically a vendor's API key: `x-honeycomb-team=…`. Treated as a secret; never logged. |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | derived | Overrides the full traces URL when a collector does not use the standard `/v1/traces` path. |
| `OTEL_TRACES_SAMPLER` / `OTEL_TRACES_SAMPLER_ARG` | `parentbased_always_on` | Standard sampling. `parentbased_traceidratio` with `0.1` keeps a tenth of traces, and follows the caller's decision when a request arrives with `traceparent`. |
| `SYNTRA_OTEL_DATABASE` | unset | `true` also records a span for every Prisma operation. Off by default because it multiplies span volume many times over. The spans carry parameterised SQL, never parameter values. pg-boss's own polling queries are not traced. |

What is instrumented, what a span may carry, and how to follow one import
through to a connector call is in
[Operating Syntra](operate.md#observability).

## Where the variables go

The API reads its environment once, at start, through `loadConfig`; a change
takes effect at the next restart and not before. Where the environment comes
from depends on how Syntra runs:

- **A checkout** (`pnpm dev`, `pnpm start`): the root `.env`, and
  `packages/db/.env` beside it. Prisma's CLI reads `.env` from its own working
  directory, which is `packages/db` when pnpm runs a migration, so
  `DATABASE_URL`, `SHADOW_DATABASE_URL` and `SUPERUSER_DATABASE_URL` have to be
  in both files and name the same database. `pnpm seed`, `pnpm bootstrap`,
  `pnpm rekey` and `pnpm db:reset` read both files, the package's own winning.
- **The release layout** (`ops/syntra-install`): `/opt/syntra/shared/.env`,
  which the systemd unit passes with `--env-file-if-exists` and every release
  shares. `RELEASE_*` and `PG_CONTAINER` live there too. See
  [Operating Syntra](operate.md#upgrades).
- **`docker-compose.yml`**: the shell environment, or a `.env` file beside the
  compose file. The compose file passes through only the variables it names —
  the required ones, `MASTER_KEY_PREVIOUS`, `MASTER_KEY_PROVIDER` with
  `VAULT_ADDR`, `VAULT_TRANSIT_KEY`, `VAULT_TRANSIT_PREVIOUS_KEY`,
  `VAULT_TRANSIT_MOUNT`, `VAULT_NAMESPACE`, `VAULT_TOKEN`, `VAULT_ROLE_ID`,
  `VAULT_SECRET_ID`, `AWS_KMS_KEY_ID`, `AWS_KMS_PREVIOUS_KEY_ID` and
  `AWS_REGION`, and every `MAIL_*` variable — and sets `TRUST_PROXY` itself.
  Anything else (`METRICS_TOKEN`, `LOG_LEVEL`, `POLICY_COUNTRY_HEADER`, the
  `GOVERN_*` keys, the `OTEL_*` variables, the remaining key-management
  settings) goes in a `docker-compose.override.yml` under `api.environment`.
- **Helm**: secrets from the Secret named by `existingSecret`, under the key
  names in `secretKeys` (`DATABASE_URL`, `SESSION_SECRET`, `MASTER_KEY`,
  `SMTP_URL`, `MAIL_GRAPH_CLIENT_SECRET`, `METRICS_TOKEN`,
  `GOVERN_CHECKPOINT_KEY`); `publicUrl`, `mail.*`, `api.trustProxy`,
  `api.authRateLimitMax`, `api.authRateLimitTenantMax`, `api.rateLimitStore`
  and `api.logLevel` from values; anything else through `api.env` or a Secret
  or ConfigMap named in `api.envFrom`. The chart refuses to render without
  `existingSecret` (or `secret.create=true`, for a disposable environment) and
  an absolute `publicUrl`. The chart's own
  [README](../deploy/helm/syntra/README.md) has every value.

## Key management

Every stored credential (the `Secret` table) is sealed with its own random
data key, and that data key is sealed -- "wrapped" -- by the **master key**.
`MASTER_KEY_PROVIDER` chooses what holds the master key. The data keys and the
secret values never leave the process whichever you choose; only the wrapping
moves (`packages/core/src/vault/`).

| `MASTER_KEY_PROVIDER` | The master key lives in | Use it for |
|---|---|---|
| `local` (default) | `MASTER_KEY`, in the environment | Development, single-node installs, and every install until it moves to a KMS. |
| `vault-transit` | A HashiCorp Vault or OpenBao Transit key | Self-hosted and hybrid deployments that already run Vault. |
| `aws-kms` | An AWS KMS symmetric key | Deployments on AWS. |

The configuration is checked at startup: an unknown provider or a missing
variable stops the API with `Invalid configuration — <VARIABLE>: …`, naming
every missing variable at once. Whether the provider is *reachable* is a
different question, answered by the readiness probe (below), because a KMS
that is briefly down at boot should not stop password sign-in from starting;
the API logs whether the provider answered, once, at startup.

### Variables

| Variable | Default | Meaning |
|---|---|---|
| `MASTER_KEY_PROVIDER` | `local` | `local`, `vault-transit` or `aws-kms`. |
| `MASTER_KEY` | — | 32 random bytes, base64. **Required** with `local`. With an external provider it is optional and **decrypt-only**: it reads data keys not yet moved by `rekey`, and nothing new is ever wrapped with it. Remove it when `pnpm rekey --status` shows no `local` rows; the API logs a warning at every start until you do. |
| `MASTER_KEY_PREVIOUS` | — | The local key being rotated away from, decrypt-only. See [Changing the master key](#changing-the-master-key). |
| `MASTER_KEY_CACHE_TTL_SECONDS` | `300` | How long an unwrapped data key is kept in memory (0–3600; `0` turns the cache off). External providers only; see [Outages and revocation](#outages-and-revocation). |
| `MASTER_KEY_CACHE_MAX_ENTRIES` | `1000` | How many unwrapped data keys are kept, least recently used evicted first (0–100000). |
| `MASTER_KEY_PROVIDER_TIMEOUT_MS` | `5000` | Per-request deadline for the external provider (100–60000). |
| `VAULT_ADDR` | — | `vault-transit`: the server, e.g. `https://vault.internal:8200`. Trust a private CA with Node's own `NODE_EXTRA_CA_CERTS`. |
| `VAULT_TRANSIT_KEY` | — | `vault-transit`: the Transit key's name. |
| `VAULT_TRANSIT_PREVIOUS_KEY` | — | `vault-transit`: a *different* Transit key being moved away from, decrypt-only. Not needed for Transit's own key versions. |
| `VAULT_TRANSIT_MOUNT` | `transit` | `vault-transit`: where the Transit engine is mounted. |
| `VAULT_NAMESPACE` | — | `vault-transit`: Vault Enterprise / HCP namespace. |
| `VAULT_TOKEN` | — | `vault-transit`: a token. Exactly one of this or AppRole. |
| `VAULT_ROLE_ID`, `VAULT_SECRET_ID` | — | `vault-transit`: AppRole credentials, exchanged for a short-lived token that is renewed by logging in again. The recommended method. |
| `VAULT_APPROLE_MOUNT` | `approle` | `vault-transit`: where the AppRole auth method is mounted. |
| `AWS_KMS_KEY_ID` | — | `aws-kms`: key ARN (recommended), key id, alias name or alias ARN. |
| `AWS_KMS_PREVIOUS_KEY_ID` | — | `aws-kms`: a *different* KMS key being moved away from, decrypt-only. Not needed for KMS automatic rotation. |
| `AWS_KMS_ENCRYPTION_CONTEXT` | `tenant` | `aws-kms`: `tenant` binds each data key to its tenant id through the KMS encryption context; `none` binds nothing. Each row records which, so changing it never strands existing rows. |
| `AWS_KMS_ENDPOINT` | — | `aws-kms`: a VPC endpoint, or LocalStack for testing. |
| `AWS_REGION` and the AWS credential chain | SDK default | `aws-kms`: region and credentials come from the AWS SDK's own chain -- an instance or task role, IRSA / Pod Identity on EKS, or `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`. Prefer a role; a long-lived access key in `.env` is a second master key. |

The container path (`docker-compose.yml`) passes the provider variables
through (AWS credentials beyond `AWS_REGION` belong in a compose override or,
better, a role). Under Helm, put them in a Secret or ConfigMap named in
`api.envFrom`; the `MASTER_KEY` key in `existingSecret` may then be empty.

### What each provider needs

**Vault / OpenBao Transit.** A Transit key of the default type
(`aes256-gcm96`) and a policy that allows exactly encrypt and decrypt on it --
not `read`, not `rotate`, not any other key. That least-privilege policy is
what the integration test runs with:

```hcl
path "transit/encrypt/syntra" { capabilities = ["update"] }
path "transit/decrypt/syntra" { capabilities = ["update"] }
```

```bash
vault secrets enable transit
vault write -f transit/keys/syntra
vault policy write syntra syntra.hcl
vault auth enable approle
vault write auth/approle/role/syntra token_policies=syntra token_ttl=1h
vault read auth/approle/role/syntra/role-id            # VAULT_ROLE_ID
vault write -f auth/approle/role/syntra/secret-id      # VAULT_SECRET_ID
```

Each data key is sent with `associated_data` = `syntra-tenant:<tenant id>`,
so a wrapped key copied into another tenant's row does not decrypt; the
integration test proves Transit enforces that against a real server. Each
stored ciphertext carries the key version that sealed it (`vault:v3:…`).

**AWS KMS.** A symmetric encryption key (`SYMMETRIC_DEFAULT`) with automatic
rotation on, and a key policy or IAM policy granting the API's role exactly
`kms:Encrypt`, `kms:Decrypt` and `kms:GenerateDataKey` on that key ARN, and
nothing on `*`. New data keys come from `GenerateDataKey` (one round trip per
write); reads are `Decrypt`, always naming the configured key so a ciphertext
sealed under any other key is refused. The encryption context is
`{"syntra:tenant": "<tenant id>"}`. (The readiness canary is wrapped without
one, so a policy condition requiring the context must use an `IfExists`
operator.)

**Azure Key Vault and GCP KMS** are not implemented. `MasterKeyProvider`
(`packages/core/src/vault/master-key.ts`) is the interface one would
implement; the rest -- cache, fallback, readiness, rekey -- is shared.

### Readiness

`/health/ready` has a `key-management` probe. It wraps a random canary under
the provider new keys are written with, unwraps it, compares it and zeroes it
-- bypassing the cache -- and fails when the provider is unreachable, the
credential is revoked, or the key is disabled. The detail names only the
provider and its error, and the unauthenticated wire answer is redacted to
"this check did not pass" like every other probe. A pass is remembered for 30
seconds, so an orchestrator polling every few seconds is not a KMS bill; a
failure is never remembered.

The `vault` probe still unseals a stored signing key, through the cache. The
two can disagree during an outage, and that is informative: `vault` passing
with `key-management` failing means cached keys are carrying the deployment
and the clock is running.

### Outages and revocation

With an external provider the process keeps unwrapped data keys in a bounded
cache (`MASTER_KEY_CACHE_TTL_SECONDS`, `MASTER_KEY_CACHE_MAX_ENTRIES`), keyed
by the wrapped bytes *and* the tenant, zeroed on eviction. That defines what a
KMS outage does:

| During an outage | What happens |
|---|---|
| Reading a secret whose data key was unwrapped within the TTL | Works, until that entry expires. |
| Reading any other secret | Fails at once with the provider's error. SSO signing, connector runs and webhook signing that need it fail, and scheduled work retries on its normal schedule. |
| Writing any secret (a target credential, a rotated webhook secret, a new signing key, a TOTP enrolment) | Fails at once. Nothing is written half-sealed. |
| `/health/ready` | `key-management` fails; the deployment reports not-ready and `SyntraNotReady` fires after five minutes. |
| Password sign-in, sessions, the console, the audit log | Unaffected: none of them needs the master key. |

When the provider answers again everything resumes without a restart.

**Revocation** is the KMS's: disable the key, schedule its deletion, remove
the role's grant, revoke the Vault token, or raise Transit's
`min_decryption_version`. It takes effect on the next call to the provider --
immediately for writes and uncached reads, within one TTL for cached data
keys. Restart every API replica when that is too long; a restart empties the
cache. `0` turns the cache off entirely, at the cost of a KMS round trip on
every secret read.

### Who logs what

**Key access is logged by the KMS, not by Syntra.** Every wrap, unwrap and
canary is an authenticated call the provider records: CloudTrail logs each
`Encrypt`, `Decrypt` and `GenerateDataKey` with the calling role and the
encryption context -- which names the tenant in clear -- and a Vault audit
device logs each Transit request with the token's accessor (Vault HMACs
request fields, the tenant AAD included, by default). That is the record for
"which process used the key, when, and for which tenant". CloudTrail records
these KMS calls as management events, kept in Event history for 90 days
without configuration (a trail keeps them longer); a Vault audit device has to
be enabled, and enabling one is part of adopting Transit.

**Syntra audits the administrative events around the keys**, in its
hash-chained audit log: `rekey` records one `vault.data_keys_rewrapped` event
per tenant with the provider it moved to and the before-and-after counts per
provider and key version, and every credential write already records its own
event (`notify.webhook_secret_rotated`, target and source updates,
`mfa.enrolled`, signing-key rotation). Syntra never logs a master key, a data
key or a canary, and does not duplicate the KMS's per-call log.

### Changing the master key

Changing the master key is a **rewrap**, not a re-entry: `pnpm rekey --yes`
(`packages/db/src/rekey.ts`) unwraps each data key with whichever configured
key recognises it and wraps it again under the provider `MASTER_KEY_PROVIDER`
names. Secret values are never decrypted. Every change has the same three
steps, and between them the deployment reads both old and new rows, because
the old key is configured *decrypt-only*:

| Changing | Step 1: configure, restart | Step 3: remove, restart |
|---|---|---|
| Local key to a new local key | `MASTER_KEY=<new>`, `MASTER_KEY_PREVIOUS=<old>` | `MASTER_KEY_PREVIOUS` |
| Local key to Vault Transit | `MASTER_KEY_PROVIDER=vault-transit` and its variables; keep `MASTER_KEY` | `MASTER_KEY` |
| Local key to AWS KMS | `MASTER_KEY_PROVIDER=aws-kms` and its variables; keep `MASTER_KEY` | `MASTER_KEY` |
| One Transit key to another | `VAULT_TRANSIT_KEY=<new>`, `VAULT_TRANSIT_PREVIOUS_KEY=<old>` | `VAULT_TRANSIT_PREVIOUS_KEY` |
| One KMS key to another | `AWS_KMS_KEY_ID=<new>`, `AWS_KMS_PREVIOUS_KEY_ID=<old>` | `AWS_KMS_PREVIOUS_KEY_ID` |

Moving directly between Vault and AWS is not supported: go through a local
key. A Transit key's own versions and KMS automatic rotation need no Syntra
change at all.

1. **Back up first**, and put a new local key in your secret store before it
   seals anything. Configure and restart as in step 1 of the table;
   `/health/ready` should show `key-management` passing.
2. `pnpm rekey --status` (it calls no KMS) shows what there is to move, per
   tenant and provider. `pnpm rekey --yes` checks the new provider with a
   canary, then moves every tenant's data keys, one transaction per tenant;
   a failure rolls back that tenant only. It is safe to run again. Under
   Compose: `docker compose exec api pnpm rekey --status`.
3. When `--status` shows only the new provider for every tenant, remove the
   old key (step 3 of the table) and restart every replica. Take a fresh
   backup: backups taken before the move still need the old key to restore,
   so keep it until they expire. See [Operating Syntra](operate.md#backups).

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
did not arrive on the host those identifiers name: SAML and OIDC reached by an
IP address or an additional name answer `421`, naming the host to use.

**Make the name people type the primary domain.** A tenant bootstrapped with
`example.com` and published as `idm.example.com` matches neither the primary
domain (compared exactly) nor, through the slug rule, a tenant called `idm`, so
it answers as an unknown tenant — which looks like a proxy or tunnel fault and
is not one. Adding the name under *Also answers on* makes the console reachable,
but the SAML entity ID, the SSO endpoints and the WebAuthn relying party are
built from the primary domain, so single sign-on and security keys want the
public name there.

## Connecting a directory source

`infra/docker-compose.yml` already runs an OpenLDAP container for
development (`ldap://localhost:1389`, seeded from `infra/ldap/seed.ldif`), so
there is a real directory to sync against without standing anything up
yourself. The same container serves StartTLS on that port and LDAPS on
`ldaps://localhost:1636`, with a self-signed certificate.

A source's `config` carries a `tlsMode` — `plain`, `starttls` or `ldaps`.
StartTLS completes before the bind, so the bind password never crosses the
wire in the clear; `plain` means it does, and the source's page (under
**Sources** in the console) says so in as many words. Left out, the mode is read from the URL scheme, so
a source saved before the field existed keeps the transport it had. Server
certificates are verified unless a source sets `rejectUnauthorized: false`,
which the same page flags. The mode and the scheme have to agree: an
`ldaps://` URL with any other mode is refused rather than quietly
reinterpreted.

Sources are created and edited from **Sources** in the console (directory
sources and HR feeds share that page).
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

**Write-back** is the exception, and it is off for every source until turned
on: a master switch (*Allow Syntra to write to this directory*) and three
writes under it — deactivating a user disables the account in the directory,
self-service password changes write through, and *Deleting a user or org unit
removes it from this directory*. The directory is written first and Syntra's
row changes only if that succeeded. Deleting an account or an (empty) org unit
also needs the `directory.delete` permission and the name typed back; for a
directory-managed object it is refused (`409 delete-not-enabled`) unless the
delete switch is on, because removing only Syntra's row would let the next run
create it again. What each switch needs from the bind account is in
[Write-back to Active Directory](#write-back-to-active-directory).

A run always previews before it applies. `POST /api/admin/sources/:id/run`
reads the directory, correlates it against what Syntra already holds, and
writes a reviewable diff — creates, updates, deactivations, and membership
changes, grouped by type on the run's review screen (**Sources → Runs**) — without
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

### Active Directory as a source

**Sources → New source → Start from Active Directory** fills in the mappings
(`sAMAccountName`, `mail`, `displayName`), the `objectGUID` anchor and an
AD-shaped user filter. What is left is the connection:

| Field | Example |
|---|---|
| Server URL | `ldaps://ad-dc.example.local:636` — the domain controller's **hostname**, not its address: the certificate is issued to the name, and verification fails against an IP |
| Transport | LDAPS, certificate verification **on** |
| Bind DN | `CN=svc-syntra,OU=Syntra,DC=example,DC=local` |
| User, group and OU search bases | `OU=Company,DC=example,DC=local` |

Reading needs nothing beyond what any authenticated account already has. The
bind account should **not** be a Domain Admin. Keep what Syntra reads and what
it writes in separate subtrees (`OU=Company` read by the source,
`OU=Syntra` written by a [provisioning target](#active-directory)), so a
provisioning mistake cannot overwrite the directory being synced from.

Three things break LDAPS from a Linux host with nothing wrong at either end:

- **Node does not trust the domain's CA** until `NODE_EXTRA_CA_CERTS` names it
  (see [Optional](#optional)). A domain controller serves LDAPS only once it
  holds a certificate — from an enterprise CA, which a real AD estate already
  has; `Restart-Service NTDS` after enrolment makes it bind.
- **`.local` does not resolve.** `systemd-resolved` treats `*.local` as
  multicast DNS and will not forward it to a unicast server, so `dig @dc`
  answers and `getent hosts` does not. Turn it off for the host
  (`MulticastDNS=no` and `LLMNR=no` in a `resolved.conf.d` drop-in).
- **A public resolver listed beside the DC breaks internal names at random.**
  `systemd-resolved` treats every server on a link as equivalent for every
  name and switches between them, so whenever it settles on the public one,
  every `example.local` lookup is NXDOMAIN. Name the domain controller alone;
  it forwards what it cannot answer.

**An account disabled in Active Directory is deactivated in Syntra.** Sync
reads `userAccountControl`; the next run deactivates the user with the reason
*Disabled in directory source, run &lt;id&gt;*, which ends their portal sign-in
and their single sign-on into everything Syntra fronts. A later run does not
reactivate an account the source still reports disabled.

**Moving an account out of the search base is how a leaver reaches Syntra
without write-back.** A record the source stops returning is proposed for
deactivation on the next run. That is why a provisioning target's archive
container must sit **outside** the source's search base, as a sibling:
nested inside it, archived accounts keep being read as present and active,
and nothing errors.

### Write-back to Active Directory

With write-back off, a directory-managed account has no Deactivate button: the
next run would read it back as active and undo the change. **Sources → the
source → Write-back** has four switches, all off until somebody turns them on:

| Switch | What it allows | What the bind account needs |
|---|---|---|
| Allow Syntra to write to this directory | the master switch; nothing below works without it | — |
| Deactivating a user disables their account here | the Deactivate button on a directory-managed user | write `userAccountControl` on the user objects in scope |
| Self-service password change writes through | a portal password change sets the domain password | **nothing extra** |
| Deleting a user or org unit removes it from this directory | Delete on a directory-managed account or empty org unit, with `directory.delete` and the name typed back; the one switch whose effect Syntra cannot undo | delete rights on the objects in scope |

**A password change binds as the user**, with the password they just typed,
and performs the standard LDAP change on their own object. The bind account is
not involved, so do not grant it *Reset Password* across the user OU: a
credential that can reset any password is an account-takeover primitive in a
vault, and nothing here needs it. The domain's policy applies on top of the
tenant's — minimum password age (one day by default), history and complexity
— and a refusal says the directory refused it. A domain controller that cannot
be reached refuses the change; it is never applied locally alone.

**Delegate the disable right on the OU the source reads**, which is not
necessarily the one a target writes to. The mistake is silent until the first
leaver. Scoped to one attribute on one object class:

```powershell
Import-Module ActiveDirectory
$sid      = (Get-ADUser -Identity "svc-syntra").SID
$uacGuid  = [Guid]"bf967a68-0de6-11d0-a285-00aa003049e2"   # userAccountControl
$userGuid = [Guid]"bf967aba-0de6-11d0-a285-00aa003049e2"   # the user class
foreach ($ouDn in @("OU=Company,DC=example,DC=local", "OU=Syntra,DC=example,DC=local")) {
  $ou  = [ADSI]"LDAP://$ouDn"
  $ace = New-Object System.DirectoryServices.ActiveDirectoryAccessRule(
    $sid, "WriteProperty", "Allow", $uacGuid, "Descendents", $userGuid)
  $ou.ObjectSecurity.AddAccessRule($ace)
  $ou.CommitChanges()
}
```

`GenericWrite` on the OU also works, and also lets the same credential rewrite
everybody's group memberships.

**Deactivate** on a directory-managed user sets the disable bit in AD first,
immediately (the target's `disableGraceDays` is for scheduled departures, not
for a person pressing a button); then marks the user inactive and revokes every
session and refresh token; then puts the linked person on the ordinary leaver
ladder. If AD refuses, nothing changes anywhere. **Reactivate** reverses it.

## Connectors: provisioning into target systems

A **target system** is somewhere Provision creates, updates, disables and
archives accounts and grants entitlements, for **people with contracts** —
not for synced logins. Business rules say who gets an account; the account
profile says what it looks like; every run previews a plan before it applies.
Targets are created under **Target systems → New target**, and each has four
connector types to choose from:

| Type | Console label | Talks to | Places accounts in containers | Support |
|---|---|---|---|---|
| `activeDirectory` | Active Directory | LDAP over LDAPS or StartTLS | yes (OUs) | supported |
| `entraId` | Microsoft Entra ID | Microsoft Graph v1.0 | no | preview, controlled rollout |
| `scim2` | SCIM 2.0 | any SCIM 2.0 service provider | no | supported |
| `httpJson` | REST API | whatever a connector document describes: shipped for Snipe-IT, Google Workspace and Entra ID | only if the document describes `container` | preview, controlled rollout |

What every target has in common:

- **One credential**, typed once and sealed into the vault — the bind
  password, SCIM bearer token, API key or client secret. It is never returned
  to the browser; an edit that leaves it blank keeps it. A connection test
  after changing the address, transport or certificate setting needs it typed
  again, for the same reason as a source's. Rotating it without an outage is
  [Rotating a connector credential](#rotating-a-connector-credential).
- **Encrypted transport, always.** There is no plaintext option: the database
  itself refuses an Active Directory target that is not LDAPS or StartTLS, and
  any other target whose endpoints are not `https://`. SCIM, REST and Entra
  targets refuse to reach a private address unless their configuration sets
  `allowPrivateAddresses: true`, which is for an on-premises system you mean
  to reach.
- **Test connection** before saving, which reports what the target let it see
  and, where the target publishes it, which rights the credential holds.
- **A first run confirmed by a person**, whatever the thresholds say, and a
  guard on every later run: see
  [Safety thresholds](operate.md#safety-thresholds).
- **A schedule and, optionally, automatic apply** (`schedule`, a UTC cron
  expression; `autoApply`), with renames, late re-enables and re-creates held
  for a person unless *Apply renames automatically* (`autoConfirmRenames`)
  covers the rename: see
  [Schedules and automatic apply](operate.md#schedules-and-automatic-apply) and
  [Held actions and renames](operate.md#held-actions-and-renames).
- **A leaver ladder** — revoke entitlements, disable, archive — timed by
  `entitlementRevocationDelayDays`, `disableGraceDays` and `archiveAfterDays`.
  No connector deletes an account.
- **Failures surface as incidents** under **Activity → Attention** and on the
  Overview's *Needs you*, where they can be acknowledged or resolved: see
  [What is broken: incidents](operate.md#what-is-broken-incidents).

Before the first run, the **Provisioning setup** checklist and the account
profile's **Preview** (`POST /api/admin/targets/:id/profile/preview`) show the
name and container each person would get, and **Preview impact** on a
business rule shows exactly who it matches.

### Active Directory

| Key | Default | Meaning |
|---|---|---|
| `url` | required | `ldaps://dc.example.local:636`, or `ldap://…` with StartTLS. The hostname the certificate names. |
| `tlsMode` | required | `ldaps` or `starttls`; it has to agree with the URL's scheme. `plain` does not exist here: Active Directory refuses a password write over an unencrypted connection. |
| `rejectUnauthorized` | `true` | Verify the server certificate. Trust a private CA with `NODE_EXTRA_CA_CERTS` rather than turning this off. |
| `bindDn` | required | The service account. |
| `baseDn` | required | Where accounts are created, e.g. `OU=Users,OU=Syntra,DC=example,DC=local`. |
| `entitlementSearchBase` | required | Where groups are enumerated as entitlements. |
| `archiveContainer` | required | Where `archive_account` moves a leaver. Outside every directory source's search base — see [above](#active-directory-as-a-source). |
| `provenanceAttribute` | `info` | Where a create records the tenant and the action that created the account; or a nominated `extensionAttribute`. |
| `accountFilter` / `groupFilter` | `(&(objectCategory=person)(objectClass=user))` / `(objectClass=group)` | |
| `primaryGroupExternalIds` | `[]` | Groups left out of the catalog entirely: a primary group is not in `member`, and a revoke of it would fail forever. |
| `pageSize`, `connectTimeoutMs`, `timeoutMs` | `1000`, `10000`, `60000` | |

**Rights.** Delegate **full control over the subtree Syntra writes to** — the
base DN, the archive container and, with mirroring on, the org-unit root —
and nothing else; the account is not a Domain Admin:

```powershell
dsacls "OU=Syntra,DC=example,DC=local" /I:T /G "EXAMPLE\svc-syntra:GA"
```

The connection test reads, without exercising, the four write rights the
connector needs: create a user under the base DN, move a user into the archive
container, modify `userAccountControl` on an existing account, and modify
`member` on an existing group. It reads Active Directory's constructed
`allowedChildClassesEffective` and `allowedAttributesEffective` rather than
creating a probe object, because there is no delete to remove one with. A right
it could not confirm (an empty target has no account to read rights from) is
reported as unverified, not assumed. An archive container outside the
delegated subtree is refused at the first archive with
`INSUFF_ACCESS_RIGHTS`: delegate it too, or put it inside the subtree — it only
has to sit outside the *sync* search base.

**Account profile.** Use `%baseDn%` as the container template when the base
DN already ends in the users OU; the default template would give
`OU=Users,OU=Users,…`. The fallback container is required. Provision creates
an OU only for an org unit given a container on the target — by hand, or by
**Mirror org units as OUs**, which places every active org unit at a DN
derived from Syntra's tree under an *Org-unit root*, creates missing OUs
(at most `maxContainerCreatesPerRun`, default 5, per run) and moves a renamed
unit's OU with everything in it. A run that moves an OU is always held for a
person. The whole mechanism is in [Org units as OUs](operate.md#org-units-as-ous);
it is refused (`422 mirror-unsupported`) on a target that places accounts in no
container.

**New accounts' passwords.** A create sets a generated initial password (so
the connection must be encrypted) and, when the profile's *Require a new
password at first sign-in* is on, `pwdLastSet = 0`. How the person receives it
is [New accounts' sign-in details](#new-accounts-sign-in-details).

**Deletion is the domain's job, not Syntra's.** The connector has no delete of
any kind; it refuses one before it binds. Archive moves a leaver into the
archive container. Deleting what has sat there long enough is a scheduled task
on the domain controller, with the AD Recycle Bin on so a mistake can be
restored for the deleted-object lifetime. `archiveAfterDays: 0` archives on the
departure date, so the whole retention period is served in the archive OU.
Deleting a single account from the console is a directory source's write-back
switch, above, not a provisioning target's.

### Microsoft Entra ID

The native connector, type `entraId`, calls Microsoft Graph v1.0 directly,
through the same outbound guard as every administrator-supplied URL. It does
what the shipped `entra-id` REST document cannot: an idempotent create, a
per-user membership read that is complete or says it is not, a refusal to
touch dynamic groups, and a read-back after every write. Code:
`packages/connectors/src/entra/`.

**Permissions.** Register an application with a client secret, and grant these
**application** permissions with admin consent, and no more:

- `User.ReadWrite.All`
- `GroupMember.ReadWrite.All`
- `Group.Read.All`

Optionally `Application.Read.All`, only so the
[credential inventory](#the-credential-inventory) can discover the client
secret's expiry; provisioning never needs it. Graph does not publish an
application's effective permissions, so the connection test reports each right
as unverified. It does tell a refused credential (401) from missing consent
(403). Record consent in the readiness check rather than assuming it.

| Key | Default | Meaning |
|---|---|---|
| `tenantId` | required | The directory id (a GUID, which Microsoft recommends) or a verified domain. |
| `clientId` | required | The application (client) id. |
| `userPrincipalDomain` | — | The domain new users sign in with, e.g. `contoso.com`: lowercase, no `@`, scheme or path. **Required when `tenantId` is the GUID** — see below. Console: *User principal name domain*. |
| client secret | vault | The target's one credential. |
| `graphBaseUrl` | `https://graph.microsoft.com/v1.0` | Page links are pinned to this origin. |
| `tokenUrl` | `https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token` | |
| `correlationField` | `employeeId` | Where the create marker is written; or `extensionAttribute1`–`15`. |
| `managedAttributes` | all ten | A subset of `displayName`, `givenName`, `familyName` (`surname`), `mail`, `title` (`jobTitle`), `department`, `officeLocation`, `companyName`, `employeeType`, `usageLocation`. |
| `groupScope.securityEnabledOnly` | `true` | Microsoft 365 groups are not entitlements. |
| `groupScope.includeMailEnabled` | `false` | Mail-enabled security groups are left out unless set. |
| `timeoutMs` | `30000` | |

**Capabilities.** `GET /api/admin/targets/:id/capabilities` serves the matrix
and the target page renders it:

| Capability | Status | Graph permission | What it does |
| --- | --- | --- | --- |
| readAccounts | available | `User.Read.All`, `GroupMember.Read.All` | Pages `/users`; reads direct memberships in `$batch`es of 20. A user whose membership read fails is returned marked as such, never dropped. |
| createAccount | available | `User.ReadWrite.All` | `POST /users` carrying the correlation marker; a retry finds the user by it instead of creating a second. |
| updateAccount | available | `User.ReadWrite.All` | `PATCH` of the requested attributes that are in `managedAttributes`. Never the UPN, `accountEnabled` or the marker. |
| enable / disable | available | `User.ReadWrite.All` | `PATCH accountEnabled`. |
| renameAccount | available | `User.ReadWrite.All` | `userPrincipalName` and `mailNickname`. |
| archiveAccount | available | `User.ReadWrite.All`, `GroupMember.ReadWrite.All` | Revokes each managed membership, then disables. No container, no delete. |
| grant / revoke entitlement | available | `GroupMember.ReadWrite.All` | Adds or removes a direct member. "Already a member" and "not a member" are success. Refused before any request for a dynamic group. |
| readBack | available | `User.Read.All`, `GroupMember.Read.All` | The user and its direct `memberOf`; incomplete when the membership read fails. |
| searchEntitlements | available | `Group.Read.All` | `$search` on `displayName`, falling back to `startswith`. |
| readCredentialExpiry | optional | `Application.Read.All` | The app registration's own `passwordCredentials`, for the credential inventory. |
| nestedGroups, dynamicGroups | unsupported | — | Direct memberships only; dynamic groups are listed as not manageable. |
| deleteAccount | never | — | No code path issues `DELETE /users`. |

**The correlation marker.** Every create writes a marker derived from the id
of the action that proposed it into `correlationField`, and nothing ever
changes it afterwards. Before any `POST /users`, the connector searches for
that marker; a hit is the anchor and nothing is created. A search that fails
is a failure, not "not found", because "not found" is what leads to a second
account. (`employeeId` holds 16 characters, so a long action id is
represented by a 16-character digest of it; retries derive the same one.)

**User principal names.** A generated correlation key never contains `@`, so
the connector completes it: a key that already has one is used as it is;
otherwise `<key>@<userPrincipalDomain>`; otherwise `<key>@<tenantId>` when the
tenant id is a domain; otherwise the create is refused, naming
`userPrincipalDomain`. The account profile's Preview shows the full UPN each
person would get and reports when none can be formed. Changing
`userPrincipalDomain` never requires re-entering the secret.

**Existing users.** A user read from Graph holds a correlation key only when
its UPN is in the domain Syntra would create it in; the key is the local part
(`anna.novak@contoso.com` holds `anna.novak`). A run never takes an existing
user over: it binds a person only by object id, and an existing in-domain user
reserves its name, so the person is proposed the next free one
(`anna.novak2`). A create Graph refuses because the UPN is taken marks the
account `conflict`, and later runs leave that person alone. **Adopt** on the
person's account is the way out, and is a person's decision: it shows the
specific user it would bind
(`GET /api/admin/targets/:id/accounts/:personId/adoption-candidate`), then binds
it on a written reason (`POST …/adopt`) with one read and no write in Entra.
A user in another domain is not offered (`404 candidate-not-visible`).

**No containers.** Entra ID has no OUs. Runs skip the container check for this
target; the profile's container template and fallback are ignored (`/` is the
conventional value); moving an account or mapping an org unit to a container
is refused with `409 no-containers`; mirroring is refused with
`422 mirror-unsupported`.

**Nested and dynamic groups are not managed**, and no setting makes them so.
A membership held through another group is not one Provision can revoke, so it
is not reported as held; a rule naming such a group proposes a direct grant. A
dynamic group's membership is computed by Entra, so a grant would be refused
and a revoke undone: the catalog lists it as not manageable and a grant is
refused before any request.

**Errors.** Messages carry the HTTP status and Graph's `error.code`, never
Graph's message or a request body. 401 and 403 are `unauthorized` (credential
or consent), 404 `not_found`, 409 `conflict` — none retried. 429 is
`throttled` and retried after `Retry-After`, within the run's budget; 5xx and
connection failures are `transient` and retried up to `maxAttempts`. A token
endpoint failure reads *the token endpoint answered HTTP &lt;n&gt;
(AADSTS&lt;code&gt;)*.

**Rotating the client secret.** Add the new secret to the app registration;
type it into the target (or use the dual-secret
[rotation](#rotating-a-connector-credential)); saving clears the cached tokens
and tests the new secret, recording a readiness check that starts
*credential rotated:*. Check that check passed, then remove the old secret
from the app registration. The token cache is keyed on a digest of the secret,
so a rotated secret is never served a token the old one obtained.

**Moving a REST-document Entra target to the native connector.** The target
page converts an `httpJson` target pointed at Graph in place. It first shows a
revision-bound preview of the derived configuration and of what is kept —
accounts, entitlements, rules, run history, schedule, profile and the saved
credential — and applying it changes only the adapter type and configuration
(`provision.target.connector-migrate` in the audit log). Only the standard
Graph and Microsoft identity v2 endpoints are accepted. Test the connection and
run a lifecycle simulation before enabling writes again: earlier readiness
evidence is stale by design, because the configuration changed.

**Validating against a disposable tenant.** The automated tests prove protocol
handling against a fake Graph, not Graph itself. `pnpm entra:validate` checks a
real tenant read-only (token, paged users, groups, search, a read-back), with
`ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID` and `ENTRA_CLIENT_SECRET` set. `--write`,
refused unless `ENTRA_DISPOSABLE_TENANT=yes`, also creates a user
`${ENTRA_TEST_USER_PREFIX}<runid>@${ENTRA_TEST_DOMAIN}`, re-creates it under
the same action id (expecting the same anchor), updates it, grants and revokes
each group in `ENTRA_TEST_GROUP_IDS`, and disables it — never deleting it. The
evidence is written to `test-results/entra-evidence-<timestamp>.json`.

### SCIM 2.0 targets

Type `scim2`, for any service provider that implements SCIM 2.0: users by
`/Users`, entitlements as group membership by `PATCH` on `/Groups`, read back
from the group. The credential is the bearer token the service provider issued.

| Key | Default | Meaning |
|---|---|---|
| `baseUrl` | required | The SCIM base, `https://…`. |
| `userResourcePath` / `groupResourcePath` | `/Users` / `/Groups` | |
| `pageSize` | `200` | |
| `connectTimeoutMs`, `timeoutMs` | `10000`, `60000` | |
| `allowPrivateAddresses` | `false` | |

A SCIM target places accounts in no container, so container settings are
ignored and mirroring is refused. This is Syntra pushing *out*; a system
pushing users *into* Syntra is [Provisioning into Syntra with SCIM](#provisioning-into-syntra-with-scim).

### REST API connector documents

Type `httpJson` runs a **connector document**: JSON describing a system's REST
API — its base URL, authentication, how to list, create, update, enable,
disable and read back an account, optionally entitlements and containers, and
how its refusals look. **Target systems → New target → REST API** offers the
shipped documents as starting points (`GET /api/admin/targets/connector-documents`):
Snipe-IT, Google Workspace and Microsoft Entra ID. The one you pick is
**copied into the target's own configuration** and edited there under *Edit
the connector document*, so editing one target's never changes another's —
or changes a plan between its preview and its apply.

- **Authentication** is one of `bearer` (the credential sent as a bearer
  token), `basic` (a username in the document, the password in the vault),
  `header` (a named header and optional prefix, e.g. `X-Api-Key`), or `oauth2`
  client credentials (an `https://` token URL, client id and scope in the
  document, the client secret in the vault). The credential never appears in
  the document.
- **Only what the document declares is possible.** A document with no create
  cannot create, and no document can express `DELETE` on an account.
- **Refusals**: HTTP status lists for unauthorized, not-found, conflict and
  throttled, and optionally `failures.body` for an API that answers `200` and
  puts the refusal in the body (Snipe-IT does).
- **Naming**: without a `naming` block a correlation key follows Active
  Directory's rule — letters, digits, `.` and `-`, 20 characters. A document
  may allow an email-shaped key instead (Snipe-IT's does).
- **A provenance field** records which action created an account, so a retried
  create adopts only its own account; without one the connector refuses to
  create.

**Google Workspace** (Admin SDK Directory API; scopes
`admin.directory.user` and `admin.directory.group.member`) comes with a caveat
worth reading first: Google's service accounts authenticate with a signed JWT
and domain-wide delegation, not the `client_id`/`client_secret` post the
`oauth2` type performs, so its token URL works only where an OAuth client with
a secret has been set up for the domain. Otherwise use `bearer` with a token
refreshed outside Syntra. There is no archive: suspension is what archiving
means there.

**Microsoft Entra ID** as a document still works; the
[native connector](#microsoft-entra-id) is the better choice, and an existing
document target can be converted in place.

### Snipe-IT

The shipped Snipe-IT document provisions Snipe-IT **user accounts** through
REST API v1:

| Operation | Request | Notes |
| --- | --- | --- |
| Read accounts | `GET /api/v1/users?sort=id&order=asc&limit=500&offset=N` | Offset paging, held to the response's `total`. |
| Create | `POST /api/v1/users` | `first_name`, `last_name`, `username`, `email`, `jobtitle`, `password` and `password_confirmation` (the run's initial password), `activated`, and Syntra's marker in `employee_num`. |
| Update | `PATCH /api/v1/users/{id}` | `first_name`, `last_name`, `email`, `jobtitle`. |
| Rename | `PATCH /api/v1/users/{id}` | `username`. |
| Disable / enable | `PATCH /api/v1/users/{id}` | `activated: false` / `true` — Snipe-IT's *This user can login*. |
| Read-back | `GET /api/v1/users/{id}` | |

No groups, permissions or entitlements; no delete and no archive (Snipe-IT
keeps a user's checkout history, so a leaver is deactivated); no departments,
locations, companies or managers, which Snipe-IT takes by numeric id and a
profile template cannot know.

**Setting it up.**

1. Sign in to Snipe-IT as the account Syntra should act as. It needs to view,
   create and edit users; a permission group with the Users permissions is
   better than a superuser.
2. User menu → **Manage API Keys** → **Create New Token**, and copy it (it is
   shown once).
3. **Target systems → New target → REST API → Snipe-IT**, and paste the token
   as **Personal API key**. It is sent as `Authorization: Bearer <key>`.
4. **Edit the connector document** and replace `{instance}` in `baseUrl`:
   `https://assets.example.com/api/v1`.
5. If your Snipe-IT already uses employee numbers, point the provenance path
   and the create body's `employee_num` at a field you do not use, before the
   first create.

**Account profile.** Correlation key `%person.businessEmail%`; attributes
`givenName` = `%person.givenName%` (Snipe-IT refuses a user with no first
name), `familyName` = `%person.familyName%`, `mail` = `%person.businessEmail%`,
`title` = `%contract.jobTitle%`; no `displayName`. The generated initial
password is sent as both password fields, so it must satisfy the instance's
password policy (eight characters by default). **Use the email address as the
username when people sign in to Snipe-IT through SAML**: Snipe-IT matches the
assertion's NameID, which is the person's email address, against `username`,
and any other template gives accounts nobody can sign in to by SSO. Without
SSO, `%person.givenName.initial%%person.familyName%` works too.

The document's `naming` block (`"allow": "email"`, `"maxLength": 191`) is what
permits that: the key is lowercased, accents folded, and letters, digits,
`.`, `-`, `_`, `+` and one `@` kept; a collision is suffixed before the `@`
(`jane.doe2@example.com`), and truncation never cuts the domain. **A Snipe-IT
target created before the block shipped has the old document embedded**, which
folds the `@` away (`jane.doeexample.com`): add the block under *Edit the
connector document* before switching to `%person.businessEmail%`. With renaming
on, that can propose renames, each waiting for confirmation.

**Refusals answered with 200.** Snipe-IT answers `200 OK` with
`"status":"error"` in the body when it refuses. The document declares that, so
such an answer is a `conflict` when a value is already taken, `not_found` when
the user is gone, otherwise `rejected`, and the run shows Snipe-IT's own
message with the API key, the initial password, addresses and token-shaped
strings removed. Snipe-IT throttles its API at 120 requests a minute by
default; a 429 is retried.

**Cloudflare in front.** Cloudflare refuses a request with no user agent with
*error 1010*, which looks like an authentication failure. The document sends
`User-Agent: Syntra-Provisioning/1`; keep it, or another explicit value your
rules allow.

**Single sign-on to Snipe-IT** is a separate registration: **Applications →
Add from the catalog → Snipe-IT**, with its hostname. It registers the entity
ID `https://<host>`, the ACS `https://<host>/saml/acs`, an email NameID, the
`username`, `email`, `firstname` and `lastname` attributes, single logout at
`https://<host>/saml/sls` in the HTTP-Redirect binding (the only one Snipe-IT's
SLS answers), and the launch address `https://<host>/login/saml`. Importing
Snipe-IT's own SP metadata instead picks up the binding as well.

The document's shapes follow Snipe-IT's API reference and are tested against an
in-memory Snipe-IT; run a lifecycle simulation and one real create and
deactivate against a test instance before enabling writes.

### Connector certification, capabilities and rollout

Syntra writes to a target only what the exact adapter release running it was
certified to write, only what the target's configuration advertises, and only
while that release is not past its deprecation date. Code:
`packages/connectors/src/metadata.ts` (the catalog) and
`packages/core/src/provision/adapter-rollout.ts` (enforcement).

**The catalog.** Every connector type has one or more adapter releases, each
with a version, a channel (`stable` or `canary`), a support state, a
deprecation date, and a certification — `passed`, `partial`, `failed` or
`not-run` — naming the writes it covers: `create_container`,
`move_container`, `create_account`, `update_account`, `rename_account`,
`enable_account`, `disable_account`, `archive_account`, `grant_entitlement`,
`revoke_entitlement`. A certification speaks only for its own version; a
`failed` or `not-run` one certifies nothing. Shipped releases, all 1.0.0 on
the stable channel:

| Type | Certification | Certified writes |
| --- | --- | --- |
| `activeDirectory` | passed | everything, including creating and moving OUs |
| `scim2` | passed | every account and entitlement write; no containers |
| `httpJson` | passed | every account and entitlement write; no containers |
| `entraId` | partial | every account and entitlement write; no containers |

**Enforcement.** Every action a run plans is checked twice — is the target's
release certified for this write, and does its configuration advertise it (for
`httpJson`, does the document describe it)? An action that fails either is
**refused**, not dropped: it stays in the plan with status `refused` and a
reason (*this target's configuration does not advertise the ability to grant
entitlements*), is never attempted, does not count towards the guard, and
leaves the run `partially_applied`. The run page shows a banner with the
reasons. The check is repeated at apply time. Refusal is per action, so one
uncertified capability never holds up a leaver's disable on the same target.

**Canary, pin and rollback.** Each target has a channel (`stable`, the default,
runs the newest stable release; `canary` the newest canary, falling back to
stable) and an optional exact pin. When a change moves the target to a
different release, the one it left becomes the **rollback point**, and a
rollback pins the target back to it on the stable channel at once, so the next
canary cannot undo it. Neither changes configuration, profile, rules or
accounts — only which certified code runs them. A run previewed under one
release refuses to apply under another (`409 adapter-version-changed`): preview
again.

**Deprecation.** A deprecated or not fully certified release raises a readiness
warning on the target's **Adapter release** panel, the setup checklist and
`GET /api/admin/targets/:id/readiness`. From its deprecation date (a UTC day)
it **writes nothing**: previews are blocked and applies refused with
`409 adapter-writes-blocked`, until the target moves to a supported release or
an administrator records a **deprecation override** — a reason and an expiry at
most 30 days away, bound to that exact release.

| Method and path (under `/api/admin`) | Purpose |
| --- | --- |
| `GET /targets/:id/adapter` | Selection, effective release and why, every release, per-capability certification and refusal, warnings, the override |
| `PUT /targets/:id/adapter` | `{ channel, version \| null, reason }` |
| `POST /targets/:id/adapter/rollback` | `{ reason }` |
| `POST /targets/:id/adapter/deprecation-override` | `{ reason, expiresAt }` |
| `POST /targets/:id/adapter/deprecation-override/clear` | `{ reason }` |

Reads need `provision.read`; changes need `provision.manage` and a reason of
at least ten characters, and are audited in the **Configuration changes**
webhook group (`provision.target.adapter.select`, `.rollback`,
`.deprecation_override.grant`, `.deprecation_override.clear`).

**Rolling out a new adapter release**: implement it beside the current one and
register it in `IMPLEMENTATIONS` (`packages/connectors/src/registry.ts`); run
the certification runner
(`packages/connectors/src/testing/target-connector-certification.ts`) and the
adapter's fixtures, and publish it on the `canary` channel naming only what
passed; move a few targets to canary, preview, and watch their runs; promote it
to `stable`, rolling back any target that misbehaves; then give the old release
a deprecation date.

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

### Session lifetimes

**Each tenant sets its own idle and absolute session lifetimes**, per scope,
under **Settings → Sign-in → Sessions** (`PUT /api/admin/tenant`,
`tenant.manage`, audited as `tenant.settings_updated` with the resulting
values). The defaults are the values that used to be hardcoded, so a tenant
that never opens the form behaves exactly as before.

| Setting | Default | Allowed |
| --- | --- | --- |
| `portalSessionIdleMinutes` | 60 | 5 – 1,440 (24 hours) |
| `portalSessionAbsoluteMinutes` | 720 (12 hours) | 60 – 43,200 (30 days) |
| `adminSessionIdleMinutes` | 15 | 5 – 60 |
| `adminSessionAbsoluteMinutes` | 120 (2 hours) | 15 – 720 (12 hours) |

Two relations hold as well: an idle timeout may not exceed the absolute
lifetime of its scope, and a console session may not outlive a portal one. The
bounds are the platform's, not the tenant's — an elevation is meant to be a
fresh authentication, so it cannot be made to survive overnight, and a portal
credential older than a month is one nobody remembers issuing. They are
enforced by the request schema (`SESSION_POLICY_BOUNDS` in
`packages/contracts/src/tenant.ts`) and again by database CHECK constraints.

**Lifetimes are evaluated against the current policy on every request, not
only at sign-in.** Shortening one ends every session already past the new
limit at its next request, which is what an administrator tightening the
policy after an incident needs. Lengthening one does not extend a session
already issued — its cookie was written with the old expiry — so the new
value applies to sessions established afterwards. The session inventory on an
account shows the expiry that will actually apply.

### Revoking every session

**Settings → Sessions ends sessions across the whole tenant at once**
(`POST /api/admin/sessions/revoke`): every session, or only console sessions,
optionally sparing the session making the request. It needs `tenant.manage`, a
reason of at least ten characters, and **step-up**: the caller's console
session must have been established in the last ten minutes. Elevation re-runs
the password and every factor the tenant demands, so a fresh elevation is a
fresh strong authentication; a console left open after lunch cannot sign the
organization out. A refusal answers `step-up-required` and the screen offers to
elevate again. Bearer tokens are refused outright.

Every affected person goes through the same revocation as a single-user
revoke: their sessions, refresh tokens and OIDC grants end together and every
relying party with a back-channel logout URI is told. For "every session", that
includes people who hold only a refresh token or grant, since those outlive the
session that minted them. Each person gets a `session.revoked` event with
trigger `mass_revoke`; the run gets one `session.mass_revoked` event carrying
the scope, reason and counts. The work is done in batches, one transaction per
batch — a partial failure is recorded as `session.mass_revoked` with outcome
`failure` and the counts that committed, and pressing the button again
finishes the job.

### Phishing-resistant console access

**`Tenant.adminWebauthnRequired` requires a security key (WebAuthn) for the
console.** An authenticator-app code, an emailed code or a recovery code can be
relayed through a convincing fake sign-in page; a WebAuthn assertion is bound to
the origin the browser is really on, so a relayed one fails. With the setting
on:

- `authorize()` demands WebAuthn for every administrative-scope decision,
  whatever the policy rules or the admin-MFA floor say. It only strengthens: a
  rule that denies still denies. It is enforced inside the chokepoint, so no
  caller can forget to ask for it.
- **No enrolment is offered during elevation.** Forced enrolment would let
  whoever relayed the password register their own key. An administrator
  without a key is refused (`security-key-required`) and registers one from the
  Security page of their portal session, which is its own audited, mailed act.
- **Existing console sessions a key did not establish stop working** at their
  next request.
- The portal is unaffected, and so are API tokens — a machine presents no
  factor at all, and tokens are issued from a console session, which under this
  setting a key established.

**Lockout prevention.** Turning it on is refused unless the administrator doing
it holds a registered security key *and* is using a console session that key
established — proving, in the same request, that the rule can be satisfied on
this domain. It is also refused with no primary domain, and while it is on the
primary domain cannot be cleared or moved (moving it invalidates every key,
including every administrator's). It can always be turned off. Both changes are
audited as `tenant.admin_webauthn_required` / `tenant.admin_webauthn_relaxed`,
alongside `tenant.settings_updated`.

**Break-glass.** If every administrator loses their key, the sanctioned way
back in is a designated emergency account and its sealed recovery credential —
see [Break-glass (emergency access)](#break-glass-emergency-access) below. It is
the one path past this requirement, and it is announced, delayed, time-bound and
reviewed. Keep at least two administrators with registered keys *and* one
designated emergency account, so that neither the break-glass path nor the
operator fallback below is routinely needed.

If no emergency account was designated beforehand, recovery is an operator
action against the database, done under change control and followed by a
review of the audit log:

```sql
-- Turn the requirement off for one tenant. The next elevation falls back to the
-- tenant's ordinary policy and admin-MFA floor.
UPDATE "Tenant" SET "adminWebauthnRequired" = false WHERE slug = '<tenant-slug>';
```

### Separation of duties for privileged changes

**A tenant can hold classes of privileged administrative change for a second
administrator** (Settings → Change control, `PUT /api/admin/change-control/policy`,
`tenant.manage`). A held change is not applied: it is stored as a *change
request*, and a different administrator applies it. This is about
*administration* — one administrator should not be able to request, approve,
execute and close the same privileged change. Govern's SoD rules are a
different control, about *business access* two entitlements one person should
not hold together.

Classes implemented end to end:

| Class | What is held | Approver needs |
| --- | --- | --- |
| **Privileged role grants** (`role_grant`) | Assigning a role that carries a privileged permission (`rbac.manage`, `tenant.manage`, `token.manage`, `policy.manage`, `secrets.write`, `deployment.manage`, `access.manage`), and adding a privileged permission to an existing role — otherwise assigning a harmless role and then widening it would walk round the hold | `rbac.manage` |
| **Admin-scoped API tokens** (`admin_token`) | Minting a token whose scopes include a privileged permission, or whose empty scope list means "the account's full authority" on an account that holds one | `token.manage` |
| **Authentication policy relaxation** (`auth_policy`) | A `PUT /api/admin/tenant` that *weakens* any sign-in setting: admin MFA or the console security key switched off, emailed codes switched on, a shorter minimum password or shallower history, lockout switched off / a higher threshold / a shorter window or lock, password expiry off or longer, any session lifetime longer. Tightening is never held | `tenant.manage` |
| **Webhook endpoints** (`webhook_endpoint`) | Creating an endpoint, or changing where one sends, what it receives, or whether it is enabled | `tenant.manage` |

Not yet covered, and able to adopt the same mechanism by adding a class and a
handler (`packages/core/src/privileged/change-control.ts`): SSO and federation
configuration (SAML/OIDC applications, upstream identity providers) and target
credential changes.

**The rules**, the same idioms as tenant deletion and the tenant write stop:

- **The requester never decides.** They may *withdraw* a pending request,
  which applies nothing; they cannot approve, reject or apply it. The database
  refuses a decider who is the requester (`PrivilegedChangeRequest_four_eyes`).
- **Approval needs step-up**: a console session elevated in the last ten
  minutes (`STEP_UP_MAX_AGE_MS`), recorded as evidence and checked again by a
  database constraint.
- **Approval is execution.** The stored change is applied in the approver's
  transaction, by the same code the direct route runs, under the approver's
  authority (the tenant-settings lockout guards are judged against the
  approver). There is no approved-but-unapplied state for a third party to run
  later. For a token or a new webhook endpoint the secret is returned to the
  **approver**, once, and stored nowhere — hand it over through your usual
  secure channel.
- **Revision-bound.** The request stores a SHA-256 over the current state of
  what it changes (the role and the grantee's holdings; the token's account and
  its roles; the endpoint; the tenant settings; the policy itself). If that has
  moved since, approval is refused as `stale` and the request is invalidated.
- **Expiry.** A request not decided within 72 hours expires; a minute sweep
  closes it with an audit event.
- **Switching a class off is itself held**, so the first move of a lone
  administrator cannot be to turn the control off. Switching one on applies at
  once.
- **Machine tokens** cannot reach the change-control routes at all; a token
  whose own call is held creates a request like anyone else.

**How a requester supplies the reason.** A held route answers the first
attempt `409 change-approval-required` (carrying `changeClass` and `summary`)
and writes nothing. The same request sent again with a reason of at least ten
characters in the `X-Syntra-Change-Reason` header (URI-encoded) answers `202`
with `{ status: "pending_approval", changeRequest }`. The console does this for
every form: it asks for the reason in a dialog and resends.

Every step is audited and is a security event in the **Privileged access**
webhook group: `change_request.created`, `.approved`, `.rejected`,
`.withdrawn`, `.expired`, `.approve_refused`, and
`change_control.policy_updated`. The applied change also writes its own usual
event (`rbac.role_assigned`, `api_token.issued`, …) carrying the
`changeRequestId` that authorised it.

### Break-glass (emergency access)

With the console security-key requirement on, losing every administrator's
key means nobody can reach the console — by design, because any path that
skips the key is the path an attacker uses. Break-glass is that path made
deliberate: narrow, slow, loud, time-bound and reviewed (Settings → Break-glass;
`packages/core/src/privileged/break-glass.ts`).

**Designation.** A `tenant.manage` administrator designates an emergency
account (never their own; only an account with a password Syntra holds, since
an upstream provider may be what is down), from a session stepped up in the
last ten minutes. Designation returns a **sealed recovery credential** once —
256 random bits, stored only as a SHA-256 digest. Print it, seal it and keep it
offline, ideally split between two custodians; it can be rotated (the old one
stops at once) and the designation removed, both refused while an activation
is open. Give the account whatever role it will need in an emergency
(normally an owner role) in advance.

**Outside an activation the account is inert.** `authorize()` refuses it an
administrative session outright (`auth.break_glass_refused`), whatever roles
it holds, and refuses any machine token acting as it at all times.

**Activation.**

1. Somebody holding the credential requests activation without a session at
   `/break-glass` in the web app (`POST /api/auth/break-glass/activate`: login,
   credential, a reason of at least 20 characters, 15–240 minutes). Every way
   of not being an emergency account — unknown login, undesignated account,
   wrong credential — is one `invalid-credentials` answer, rate limited like the
   password endpoints; the audit log records which.
2. **Immediately**, every active `tenant.manage` holder is emailed
   (`break-glass-requested`: account, reason, source address, when it takes
   effect) and `break_glass.activation_requested` goes to every endpoint
   subscribed to the Privileged access group.
3. It takes effect after the tenant's **activation delay** (15 minutes to
   24 hours, default 60; `PUT /api/admin/break-glass/settings`, stepped up).
   During the delay **any administrator can cancel it**. A *different*
   administrator with a working console may instead **approve it early**
   (four-eyes, stepped up) — the fast path when only some keys are lost.
   Either way `break_glass.activated` is recorded and holders are emailed
   (`break-glass-activated`).
4. The account then signs in and elevates **through `authorize()` as usual** —
   password, policy rules and the admin-MFA floor all still apply. The only
   thing lifted is the security-key requirement, for that account alone. The
   session records the activation and is live only while it is.
5. It **ends automatically** at its expiry (`break_glass.expired`), or earlier
   when any administrator — or the account itself — ends it
   (`break_glass.ended`). Its sessions stop at their next request.
6. A **post-event review** is then owed. Only a different administrator can
   complete it, stepped up, with written findings of at least 20 characters;
   the event records how many audited actions the account took in the window
   (`break_glass.reviewed`). The database refuses the emergency account as its
   own approver or reviewer.

Every console page shows a **banner** to every administrator while an
activation is pending or active and while a review is outstanding.

**Threat model.**

| Attacker holds | What they get |
| --- | --- |
| The account's password only | Nothing: no activation, no console |
| The sealed credential only | An activation request that every `tenant.manage` holder and every Privileged access webhook hears about at once, that waits out the delay and can be cancelled by anyone, and that still needs the password (and whatever the policy demands) to use |
| Both | At worst a console session everybody was told about when it was asked for, that could have been cancelled for the whole delay, that ends on its own within four hours, and that somebody else must review |
| An insider administrator | Cannot designate themselves, approve their own activation or review their own use (database constraints); every designation, rotation and delay change is a security event |

What it does *not* defend against: an attacker who holds the credential and
password **and** suppresses every notification channel (mail and webhook
receivers) for the whole delay. Choose the delay against how quickly your
administrators and on-call receivers would notice, and keep the credential
where stealing it is itself noticed. If *no* administrator can reach the
console and nobody objects, the delay path is designed to succeed — that is
the recovery it exists for.

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
OIDC relying party.** A bookmark carries a launch URL. How a SAML application
is launched depends on its **Allow sign-in started from Syntra** setting
(`allowIdpInitiated`):

- **On:** the launch address is *derived* from the tenant's own protocol
  identity and never stored — the portal sends the browser to
  `/saml/start/:id`, which re-enters `authorize()` on its own rather than
  inheriting the launch's decision.
- **Off (the default, and what the catalog creates):** `/saml/start` would
  refuse the unsolicited sign-in with `409 saml-idp-initiated-disabled`, so
  the tile instead opens the application's own **launch address** and the
  application starts *SP-initiated* sign-in, sending an `AuthnRequest` back to
  `/saml/sso`. The launch address must therefore be the application's **SSO
  start page** — Snipe-IT's is `https://<host>/login/saml` — not a home page
  with a password form. With none recorded the launch answers
  `409 not-launchable`, telling the administrator to set the launch address or
  allow sign-in started from Syntra, and the refusal is audited as a failed
  `application.launch` with `reason: no-launch-address`. The SAML panel on the application's page
  shows and edits the launch address beside that switch and warns when it is
  empty. The `application.launch` audit event records which way it went
  (`samlFlow: sp-initiated | idp-initiated`).

An OIDC application is launched by sending the browser to the relying party's
own start address, because OpenID Connect has no identity-provider-initiated
flow: only the relying party knows its own `state`, `nonce` and PKCE verifier.

**Assigning an application to an org unit reaches the people in it, and
everybody in the units below.** A login's unit for access is its own
`User.orgUnitId` when that is set, and otherwise the unit of the **person it
is linked to** — the same `Person.orgUnitId` that decides where Provision
places their account. Most installs place people and never set a unit on the
login, and before this fallback an application assigned to a unit reached
nobody. A login's own unit still wins, so a contractor's login can be kept in
*Contractors* while their person sits in the team they work for. A login with
no person (a service account) inherits nothing, and neither does one whose
person is deactivated. The account list and the account page show the unit
access resolves through, as *IT (from the linked person)* when it is
inherited. The same rule feeds the Govern access paths, Automate's
`user.orgUnit` audience field and org-unit-scoped review campaigns (which,
unlike access, keep an inactive person's unit so a leaver's holdings are
still reviewed).

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

**Metadata import takes the single logout endpoint in the binding the service
provider publishes.** The first `SingleLogoutService` in a binding Syntra can
answer in (HTTP-Redirect or HTTP-POST) is stored with its binding, and the
LogoutResponse goes back in that binding — Snipe-IT, for one, serves
`/saml/sls` as HTTP-Redirect only and ignores a POST. A service provider that
publishes only SOAP gets no SLO URL. Catalog entries carry the binding too.

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

### Setting up a SAML application

**Applications → Add from the catalog** registers a known application with
its endpoints, claims and launch address filled in from a hostname or tenant
name you supply (`GET /api/admin/catalog`,
`POST /api/admin/applications/from-catalog`). The catalog is deliberately
short — SAML for Slack, Zoom, Google Workspace, Salesforce, Nextcloud,
Snipe-IT and AWS IAM Identity Center, OpenID Connect for Grafana and GitLab —
and each entry links to the vendor's own page, which stays authoritative.
Where a service provider publishes SP metadata, importing it is better than an
entry, and the console offers that first. An application made from the catalog
has sign-in started from Syntra off.

For anything else, create the application with type `saml` (a bookmark is
refused) and use the **SAML** panel on its page, or the same settings over
`PUT /api/admin/applications/:id/saml`:

```json
{
  "spEntityId": "https://app.example.com",
  "acsUrls": ["https://app.example.com/saml/acs"],
  "defaultAcsUrl": "https://app.example.com/saml/acs",
  "nameIdFormat": "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
  "wantAuthnRequestsSigned": true,
  "spCertificates": ["-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----"],
  "sloUrl": "https://app.example.com/saml/sls",
  "sloBinding": "HTTP-Redirect",
  "allowIdpInitiated": false
}
```

or import the provider's metadata (`POST /api/admin/applications/:id/saml/import`),
which also takes the single logout binding, as above. `wantAuthnRequestsSigned`
needs the service provider's signing certificate registered; set it `false`
only for a provider that does not sign. The portal tile's **launch address** is
the application's `launchUrl` (`PUT /api/admin/applications/:id`): the
provider's SSO start page, used whenever `allowIdpInitiated` is off.

Give the service provider Syntra's side, all on the tenant's primary domain:

| Field | Value |
|---|---|
| IdP metadata | `https://<primary domain>/saml/metadata/<application id>` |
| IdP entity ID | `https://<primary domain>/saml/idp` |
| SSO URL | `https://<primary domain>/saml/sso` |
| SLO URL | `https://<primary domain>/saml/slo` |

**An assertion carries no attributes until you map them.** Registering the
provider is not enough: with no claim mappings the `AttributeStatement` is
empty, the provider finds nothing to match on, and the sign-in fails with
nothing in either side's log. Map them on the application's **Claims** panel
(`POST /api/admin/applications/:id/claims`), and take the names from the
provider's documentation, not from Syntra: Snipe-IT reads an attribute called
`username`, another application wants `uid` or a full
`http://schemas.xmlsoap.org/…` URI. `username` from `login`, `email` from
`email` and `displayname` from `displayName` covers most.

**The account has to exist on both sides under the same name.** Most providers
match the assertion against a user they already hold, often by username rather
than the NameID. When Syntra knows somebody as `a.brennan` and the application
as `abrennan`, the assertion validates, no user matches, and the browser lands
back on the application's login page. Fix it at the source of the name — the
directory, or the provisioning target's correlation key template.

**Testing it.** Some providers, Snipe-IT among them, do not sign anybody in at
the ACS: they validate the assertion, keep it in their session and redirect to
their own login route, which is what establishes the session. A test that
stops at the ACS sees a redirect to `/login` and reads it as a rejection when
the handshake worked. Assertions are single-use, so each attempt needs a fresh
one.

### Retiring and deleting an application

The application page ends with a **Danger zone** (shown to holders of
`access.manage`) holding the two ways to take an application away, in the
order to reach for them.

**Retire** sets `status: inactive` (`PUT /api/admin/applications/:id`). The
tile leaves the portal and sign-in stops, because resolution only considers
active applications; the SAML/OIDC configuration, claim mappings and
assignments are all kept, and **Reactivate** brings it back as it was. The
list labels it *Retired*.

**Delete application** is permanent, and exists for what retiring cannot do:
free the application's SAML entity ID, OIDC `client_id` and slug so the same
application can be registered again. (An entity ID is unique per tenant, so
re-registering a retired one is refused with `409 entity-id-taken`.) A dialog
says what will happen and asks for the application's name typed back, exactly
and case-sensitively; the server compares it too.

`DELETE /api/admin/applications/:id` with `{ "confirm": "<name>" }`:

- needs `access.manage` **and** a console session elevated within the step-up
  window (`403 step-up-required`; the console offers to elevate). API tokens
  are refused (`403 token-not-accepted`) — only this operation; reading and
  editing applications stay open to tokens;
- `400 confirm-mismatch` when the name does not match; `404` for an
  application that is not there, including a second delete;
- `409 application-in-use` while a catalog **product grants** the application
  or a **live access grant** (scheduled, pending or active) holds it. Take it
  out of the product and end those grants first: a product granting a missing
  application would fail at fulfilment, after somebody approved it.

In one transaction it removes the application with its SAML configuration, its
OIDC client (the client secret is only ever stored as a hash on that row, so
it goes with it; queued back-channel logout deliveries for the client go too),
claim mappings, assignments and logo. It **revokes what was issued to it**:
OIDC access and refresh tokens, codes and grants (deleted, so the provider
no longer finds them), Syntra refresh tokens for the client (kept, revoked),
unspent authorization decisions, SAML single-logout sessions, parked SAML
requests, and sign-ins still in flight towards it (second factor or upstream).
Resource owners, delegations, privileged-resource classifications and
business-function (separation of duties) entries naming the application are
removed. **Users lose single sign-on to it immediately.** A service provider's
own session, established before the delete, lasts until that provider ends it;
Syntra sends no logout to a provider it no longer knows.

It does **not** touch the tenant's signing keys, users, groups or org units,
Govern snapshots, reviews and decisions (they record that people held the
application), or authentication policy rules. A rule's `applicationIds`
keeps the deleted id on purpose: an empty list means *every* application, so
removing the only id would widen a "deny for this app" rule to all of them;
a dangling id matches nothing. The audit event counts such rules.

Audited as `application.deleted` with the name, slug, protocol, entity ID and
client ID, catalog entry, assignment and claim-mapping counts, and what was
revoked — never a secret. Refusals for a real application (step-up, name
mismatch, in use) are audited as `application.deleted` with `outcome: failure`
and the reason; the typed text is not recorded.

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
| `application.launch` | Somebody entered an application through the portal, carrying whether it was a bookmark, a SAML application or an OIDC one, and for SAML whether the launch was SP- or IdP-initiated (`samlFlow`) |
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
| `application.deleted` | An application was deleted, or a delete was refused (`outcome: failure`, with the reason). Carries its name, protocol, entity ID / client ID, assignment count and what was revoked — never a secret. See [Retiring and deleting an application](#retiring-and-deleting-an-application) |
| `access.claim_mapping_changed` | A claim or attribute released to an application was added or removed |
| `access.upstream_configured` | An upstream identity provider was registered or changed. **Never the client secret, and never its vault name** |
| `policy.rule_added` / `policy.rule_updated` / `policy.rule_deleted` / `policy.rules_reordered` / `policy.default_set` | The policy changed, and who changed it |
| `tenant.settings_updated` | Admin MFA, self-enrolment, the password floor or the session lifetimes changed |
| `tenant.admin_webauthn_required` / `tenant.admin_webauthn_relaxed` | The security-key requirement for the console was switched on or off. **Alert on the second** |
| `change_request.created` / `.approved` / `.rejected` / `.withdrawn` / `.expired` / `.approve_refused` | A privileged change was held for a second administrator, and what became of it |
| `change_control.policy_updated` | The classes of change held for a second administrator changed |
| `break_glass.activation_requested` / `.activated` / `.ended` / `.expired` / `.reviewed` | Emergency console access was asked for, took effect, ended and was reviewed. **Alert on the first** |
| `break_glass.account_designated` / `.account_revoked` / `.credential_rotated` / `.delay_updated` / `.activation_refused` / `.activation_cancelled` | Emergency accounts and their credentials changed, or an activation was refused or cancelled |
| `auth.break_glass_refused` | An emergency account tried to reach the console outside an activation, or a token acting as one was presented |
| `session.revoked` | One person's sessions ended, with the trigger (`admin`, `self`, `logout`, `password_reset`, `password_change`, `deactivation`, `mass_revoke`) |
| `session.mass_revoked` | Sessions ended across the tenant, with scope, reason and counts; outcome `failure` means a partial run |
| `auth.password_reset_requested` / `auth.password_reset_factor_failed` / `auth.password_reset_completed` | A self-service reset was asked for, refused at the factor, or applied |

The forced-enrolment trade above is defensible *because* the enrolment is
visible after the fact, so **wire these into your alerting.** An audit row
nobody reads does not discharge the obligation.

### Getting them out

A webhook endpoint can subscribe to five security groups, alongside the six
Automate and Govern ones:

| Group | What arrives |
|---|---|
| **Sign-in security** | Lockouts, failed second factors, policy denials, refused protocol signatures, and administrative elevation |
| **Credentials** | Second factors enrolled or removed, recovery codes issued, passwords changed or renewed, sessions and tokens revoked; connector and upstream credentials replaced (`credential.changed`), each step of a credential rotation, credential expiry warnings and expiries, an SFTP host key pinned, a signing key rolled over |
| **Data exports** | A bulk export of tenant data requested, downloaded or revoked (`export.request`, `export.download`, `export.revoke`) |
| **Configuration changes** | Policy rules, roles, tenant settings, protocol and upstream configuration, webhook endpoints, and deployment updates |
| **Emergency write stops** | A tenant-wide or per-target external-write stop placed, resumed by a second administrator, or expired on its own (`provision.{tenant,target}.external_writes.{pause,resume,expire}`) |
| **Privileged access** | A privileged change held for, approved, rejected, withdrawn or expired before a second administrator, the change-control policy changed, and every break-glass step — designation, credential rotation, delay change, activation requested / refused / cancelled / active / ended / expired, review completed, and a refused elevation by an inactive emergency account (`change_request.*`, `change_control.policy_updated`, `break_glass.*`, `auth.break_glass_refused`) |

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
launch; every session issued before it stays usable until it expires — by
default twelve hours, or one idle hour, for a portal session and two hours, or
fifteen idle minutes, for an administrative one (see
[Session lifetimes](#session-lifetimes)). That is a deliberate trade against re-evaluating
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

**A refused request signature is audited.** A service provider whose
`AuthnRequest` or `LogoutRequest` fails signature verification, or arrives
unsigned for an application that requires signatures and has no certificate,
gets a 400 or a 409 naming the setting and the application, and the refusal is
recorded as `saml.signature_refused` (in the **Sign-in security** webhook
group), so a service provider that has stopped signing correctly shows up in
the audit log as well as the API logs.

**Signed metadata, SAML back-channel (SOAP) logout, a consent screen and a
scheduled sweep of expired artifacts are all out.** The identity-provider metadata document is
unsigned — it is served over TLS from the tenant's own host, which
`assertProtocolHost` enforces. Assignment is the consent decision, so there is
no per-launch consent screen. `sweepExpiredArtifacts` exists and expiry is
enforced on read, but nothing runs it on a schedule; the table grows until
somebody does.

## New accounts' sign-in details

When Provision creates an account, its initial password is sealed into the
vault. If the account profile's **Delivery** is the person's personal email or
their manager, that address is sent a **one-time link**, never the password:

- The link (`<PUBLIC_URL>/credential/<token>`) works for 72 hours. Opening it
  shows the system and the username and nothing else, so a mail scanner such
  as Safe Links that opens every link cannot spend it. The password appears
  only when somebody presses **Show password**, and only once.
- Only a hash of the link is stored, and not the address it was sent to.
- **Vault only** sends nothing, as before.
- The message says the person will be asked to choose a new password at first
  sign-in only when that is true: Entra ID always asks, Active Directory asks
  when the profile's **Require a new password at first sign-in** is on (the
  default; it sets `pwdLastSet = 0`), and other targets are told nothing.

**Send login info**, on a person's access page beside each account, sends a
new link to the profile's recipient, the personal email, the manager or you,
and withdraws every link nobody has opened
(`POST /api/admin/targets/:id/accounts/:personId/send-login-info`; the links
already sent are listed by `GET …/credential-pickups`). It needs
`provision.manage` and a console session elevated in the last ten minutes, is
refused to API tokens, and answers 409 when Syntra holds no initial password
for the account. Every
link sent, opened or refused is in the audit log
(`provision.credential.sealed` on create, `provision.credential.link_sent` on
a resend, `provision.credential.picked_up` for each reveal), never with the
password, the link or the address.

## Credentials and security notifications

**Settings → Credentials** is one inventory of every credential this tenant's
Syntra holds, issues or depends on, soonest to expire first. **Settings →
Security alerts** is the security notification policy. Both are also API
routes: `GET /api/admin/credentials` and `/api/admin/security-notifications`.

### The credential inventory

| Credential | Expiry comes from | Last rotated | Rotation |
|---|---|---|---|
| Provisioning target credential (AD bind password, SCIM token, HTTP credential, Entra client secret) | Entra: **discovered** from Microsoft Graph when the app registration may read itself (below); otherwise **declared** by an administrator, or unknown | when the vault entry was last written | dual-secret workflow |
| Directory source bind password | declared, or unknown | vault entry written | dual-secret workflow |
| HR feed (SFTP) password or private key | declared, or unknown | vault entry written | dual-secret workflow |
| Pinned SFTP host key | never expires | last `person_source.host_key_accepted` | re-pin on the source |
| Upstream identity provider client secret | declared, or unknown | vault entry written | `POST /api/admin/upstreams` |
| Upstream identity provider signing certificates | the certificate | the certificate's `notBefore` | re-import metadata |
| Service-provider signing and encryption certificates Syntra trusts | the certificate | the certificate's `notBefore` | the application's SAML settings |
| Syntra's SAML and OIDC signing keys | the key's `notAfter` (an outgoing key's overlap end is shown, never alerted) | the key's creation | OIDC monthly and automatic; SAML by an operator |
| API tokens (revoked ones, and ones expired over 30 days ago, are left out) | the token's `expiresAt`, or never | issue time | issue, install, revoke |
| Webhook signing secrets | never expires | vault entry written | `POST /api/admin/webhooks/:id/secret` |
| OIDC client secrets Syntra issued | never expires | not recorded | the application's OIDC settings |

No entry carries a secret, a vault name, or a digest of either; certificates
are identified by their public SHA-256 fingerprint. Each entry can be given an
**owner** (who is mailed about it), a **note**, and — for the four credentials
whose issuer does not tell Syntra — a **declared expiry**. A declared expiry is
refused for anything that carries its own. Deployment secrets
(`SESSION_SECRET`, the master key, `METRICS_TOKEN`, SMTP) are not tenant data
and are not listed; they are replaced in the environment and take effect at a
restart (the master key through [a rewrap](#changing-the-master-key)).

**Entra expiry discovery is optional and never required.** Granting the app
registration `Application.Read.All` (the `readCredentialExpiry` entry in the
capability matrix) lets the daily scan read the registration's own
`passwordCredentials` and match the secret Syntra holds by its three-character
hint. Without it Graph answers 403, the entry says so, the expiry stays
declared or unknown, and the scan does not ask again for a week (**Scan now**
asks immediately). Nothing about provisioning changes either way.

### Expiry alerts

A scan runs daily at 06:20 UTC for each tenant, and on **Scan now**
(`POST /api/admin/credentials/scan`). For each credential with an expiry it
raises the most urgent threshold crossed — the defaults are 30, 14, 7 and 1
days, and **Security alerts** changes them — and then the expiry itself. Each
is raised **once per expiry date**: the record keeps the expiry and the
threshold last alerted, a second replica's concurrent scan cannot raise it
again, and a new expiry (a rotation, a new declaration) starts the ladder over.

Each alert is an audit event (`credential.expiring` or `credential.expired`,
in the **Credentials** webhook group) and a mail to the credential's owner. The
`tenant.manage` holders are mailed too when **Credential expiry** is switched on
under Security alerts, or when the credential has no active owner — somebody is
always told. An expired credential is also a critical entry on **Activity →
Needs attention** until it is rotated or removed.

### Rotating a connector credential

Targets, directory sources and HR feeds have a dual-secret rotation, from the
**Rotate** action on the inventory or `POST /api/admin/credentials/rotations`.
It needs `provision.manage` for a target and `sync.manage` for a source.

1. **Create the new secret at the issuer without deleting the old one.**
2. **Stage** it. It is sealed beside the live one and nothing uses it.
3. **Test** it. The connector's own connection test runs with the staged
   secret against the saved configuration; pass or fail is recorded.
4. **Cut over**, only after a passed test under a day old, and only if the
   connection settings have not changed since. The staged secret becomes live,
   the old one is kept sealed, and cached access tokens are dropped.
5. **Complete**: the live secret is tested again and, only if it passes, the
   old one is erased and a readiness check is recorded. Then revoke the old
   secret at the issuer. Or **roll back**, which puts the old secret back.

Every step is a `credential.rotation_*` audit event and an entry in the
rotation's evidence (who, when, the test result and the configuration
fingerprint it ran against). One rotation per system may be open at a time.
Replacing a credential in place from the connector screen still works and is
now announced as `credential.changed`.

### The security notification policy

These are the customer-visible security events. Every one of them is audited
and delivered to any webhook endpoint subscribed to its group; the **Email**
column is what **Security alerts** can additionally send, by mail, to every
active holder of `tenant.manage`. All categories are off by default. A mail
carries the event's name, outcome, time and audit sequence — never the audit
payload — and is never held for a daily digest.

| Category | Events | Webhook group | Email |
|---|---|---|---|
| Credential changes | `credential.changed`, `credential.rotation_cut_over`, `credential.rotation_completed`, `credential.rotation_rolled_back`, `api_token.issued`, `api_token.revoked`, `notify.webhook_secret_rotated`, `person_source.host_key_accepted`, `signing_key.rotated` (mailed for SAML only; the OIDC key rolls monthly) | Credentials | opt-in |
| Privileged role grants | `rbac.role_assigned`, mailed only when the role carries `tenant.manage`, `rbac.manage`, `secrets.write`, `token.manage`, `deployment.manage`, `policy.manage`, `access.manage`, `provision.manage`, `sync.manage`, `directory.delete` or `govern.accept_risk` | Configuration changes | opt-in |
| Data exports | `export.request` (download and revocation reach webhooks only) | Data exports | opt-in |
| Emergency write stops | `provision.{tenant,target}.external_writes.{pause,resume,expire}` | Emergency write stops | opt-in |
| Suspicious authentication | `auth.lockout`, `auth.lockout_cleared`, `mfa.removed` (mailed only when an administrator removed it), `oidc.decision_missing` | Sign-in security, Credentials | opt-in |
| Credential expiry | `credential.expiring`, `credential.expired` | Credentials | owner always; administrators opt-in, or when there is no owner |

**Break-glass use.** Designated emergency accounts are described under
[Break-glass (emergency access)](#break-glass-emergency-access). Every step —
designation, activation requested, activated, ended, reviewed — is a
`break_glass.*` event in the **Privileged access** webhook group, and every
`tenant.manage` holder is mailed when an activation is requested and when it
takes effect, whatever this policy says. Subscribe an endpoint to Privileged
access and alert on `break_glass.activation_requested`.

Changing the policy is audited as `tenant.security_notifications_updated` in
the Configuration changes group.

## Machine access

A program that needs to call Syntra's API holds an **API token**, issued
against a service account.

A service account is an ordinary user with nobody behind it — no linked person.
Everything that applies to an account applies to it: roles, the audit log,
deactivation, and Govern's recertification campaigns. That is deliberate.
Machine access is the access most worth reviewing and least often reviewed, and
giving it its own concept would have put it outside every control that already
exists.

### Marking an account as a service account

An account is marked **Service account** on its own page (**Account type →
Mark as service account**), by `PATCH /api/admin/users/:id` with
`{"kind": "service"}`, or at creation (**Person → No person — service
account**, or `"kind": "service"` on `POST /api/admin/users`). It needs
`directory.write`, and the change is audited as `user.kindChanged` with the
before and after. An account linked to a person cannot be one, and a service
account cannot be linked to a person: both are refused with `409`. Service
accounts are also left out of the list of accounts with no person behind them
(*Accounts with no person*, reached from **Users**;
`GET /api/admin/users/unlinked`), which is a backlog of
logins waiting to be matched to people; an integration's login is not one.

**An integration's login that was given a person by mistake** is unlinked
first: **Unlink** beside the person on the account's page, or
`POST /api/admin/persons/:id/unlink-user` with `{"userId": "…"}`. It needs
`identity.write`, is audited as `person.unlinkUser`, and answers
`409 not-linked` when the account is not linked to that person (a stale page).
The account keeps its password, tokens and status; what changes is that the
person's leaver no longer disables it and it no longer reaches applications
through the person's org unit. Then mark it as a service account.

Exactly two things differ, both about the password, because nobody signs in as
an integration to change one:

- **An administrator setting its password does not flag it must-change.** For a
  person's account the set password is a handover credential two people know,
  so they must choose their own at next sign-in; for a service account the
  administrator setting it is the one meant to know it. The audit event
  `user.setPassword` records `mustChange: false` and `accountKind: service`.
- **A pending password renewal does not refuse its API tokens.** A person's
  tokens are refused (`401`) while their password must change or has expired,
  exactly as before. A service account's are not — which is what used to stop an
  integration dead the moment somebody set its password.

Everything else applies unchanged: deactivation, lockout, policy (including
IP rules and the second-factor refusal below), break-glass, and interactive
sign-in, which still meets scheduled password expiry if the tenant has it on.

### Issuing one

**Users → the account → API tokens**, in the console, or
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

## The administration API

The console is a client of Syntra's own HTTP API, and that API is published so
integrations can call it too. Its contract is an OpenAPI 3.1 description of
every `/api/admin/…` operation, [`apps/api/openapi.json`](../apps/api/openapi.json)
— generated, committed and checked in CI — and a running deployment serves the
same document at **`GET /api/openapi.json`**, with no session, on any hostname,
and with nothing from any tenant in it.

**Covered:** everything under `/api/admin` — directory, people, lifecycle,
provisioning, governance, access, tenant settings and the rest — including the
routes a token is refused at, published with session-only security so an
integrator can see that they exist. **Not covered, deliberately:** SCIM
(`/scim/v2`, which follows RFC 7643 and 7644), the protocols (`/oidc`, `/saml`,
`/federation`, each described by its own discovery or metadata document), and
sign-in and the portal (`/api/auth`, `/api/portal`), which are for people.

### Authenticating

An integration presents an [API token](#machine-access) issued to a service
account, as `Authorization: Bearer syntra_pat_…`. It can do what the account's
roles allow, narrowed to the token's scopes. The description names two schemes,
`bearerToken` and `sessionCookie` (the console's own), and each operation
carries extensions that answer "can my token call this?" without trial and
error:

| Extension | Meaning |
| --- | --- |
| `x-syntra-permission` | The permissions the operation checks. **All** of them are required. Read from the route's own guards when the document is generated, so it cannot disagree with the server. |
| `x-syntra-token-allowed` | `false` where a bearer token is refused whatever it holds — setting a password or minting a password link, issuing tokens, the tenant-wide session revoke, tenant deletion, change control, break-glass, a privacy case's erasure, *Send login info*, and deleting an application — with `403 token-not-accepted`. |
| `x-syntra-paginated` | The operation takes `page` and `pageSize` and returns the paging envelope below. |
| `x-syntra-rate-limit` | A per-route limit, where the route has one. |
| `x-syntra-deprecation` | `since`, `sunset` and, when there is one, `replacement`. |

### Versioning and deprecation

The contract's version is `info.version` (1.0.0 today), semantically versioned,
and it is the version of the **API**, not of the product. **Within major version
1 only additive changes ship**: a new operation, a new optional request field or
query parameter, a new response field, a new enum value in a response, a new
problem `type`, a looser input limit. Removing or renaming an operation, a path,
a field or an `operationId` (generated clients name methods after it), making an
optional input required, narrowing an input, changing a success status or the
meaning of a field — those wait for a new major version, served beside version
1 under a new prefix. The prefix carries no version today (`/api/admin`), and
existing paths are never repurposed. **A client should ignore response fields
and tolerate enum values it does not know.**

Anything removed or changed incompatibly is deprecated first, with **at least
six months' notice** — a sunset closer than that fails the test suite. The
operation is marked `deprecated: true` with `x-syntra-deprecation`, and every
response from it carries `Deprecation` (RFC 9745), `Sunset` (RFC 8594) and, with
a replacement, `Link: <…>; rel="successor-version"`, so a client that never
rereads the document still hears. Log or alert on any response carrying
`Deprecation`. Nothing is deprecated today.

### Errors

Every error is an RFC 9457 problem, `application/problem+json`:

```json
{
  "type": "https://syntra.dev/problems/forbidden",
  "title": "Forbidden",
  "status": 403,
  "detail": "Requires directory.write"
}
```

**Branch on `type`**, which is stable; `title` and `detail` are prose and may
be reworded. Some problems carry extension members a client can act on: a
schema failure is always `validation-failed` with an `errors` array of
`{ path, message }`. Request bodies and query strings are **strict** — an
unknown field is a `400`, not something silently ignored — and where a route
asks for `confirm`, only the exact value `true` counts.

| Status | `type` | When |
| --- | --- | --- |
| 400 | `validation-failed` | The body, query or path failed its schema. |
| 400 | `bad-request` | Malformed before validation, such as invalid JSON. |
| 401 | `unauthenticated` | No valid session or token. |
| 403 | `forbidden` | The account lacks the permission, or the token's scopes do not include it. |
| 403 | `token-not-accepted` | The route refuses tokens whatever they hold. |
| 404 | `not-found` | No such resource **in this tenant**; another tenant's id looks exactly like one that never existed. |
| 503 | `unavailable` | The database did not answer within the transaction budget. The transaction was rolled back, so retry after a short delay. |
| 500 | `internal-error` | A bug. The response carries no detail; the server log has it. |

Operations add their own types, mostly `409`s — a stale preview,
`approval-required`, `four-eyes-required`, `change-approval-required`,
`step-up-required`, `run-not-appliable`, `adapter-version-changed` — and their
descriptions name the ones a client is likely to meet.

### Idempotency, rate limits and paging

There is **no general `Idempotency-Key` header.** `GET` changes nothing; `PUT`
replaces and can be repeated; a `DELETE` repeated answers `404`, which a retry
should treat as success. `POST` is not idempotent in general, and where a
duplicate would do harm the operation takes a key of its own:
`POST /api/admin/lifecycle-operations/onboard` takes `idempotencyKey` (a repeat
with the same input answers `200` with what the first created; the same key
with different input is `409 idempotency-key-reused`), and
`POST /api/admin/persons/:id/provision-receipts` takes a `requestKey` UUID.
Preview-then-apply operations — sync and provisioning runs, movers,
offboarding — are guarded by a **revision** instead: applying a preview whose
data has moved is refused with a `409`; preview again.

Two operations have per-route limits: `POST /api/admin/policy/rules/impact`
and `POST /api/admin/targets/test`, each `AUTH_RATE_LIMIT_MAX` a minute (10 by
default) per tenant and client address. `GET /api/openapi.json` allows 60 a
minute per address. Other administration operations have no per-route limit;
the database's transaction budget is the real ceiling, and exceeding it is a
`503`. An exceeded limit answers `429` with `Retry-After` and
`x-ratelimit-*` headers, and a problem `type` of the generic `bad-request`, so
**branch on the status**. With `RATE_LIMIT_STORE=postgres`, the default, the
counters are shared by every API replica; with `memory` each replica counts
its own.

A list that can grow without bound is paged: `page` (1-based, default 1) and
`pageSize` (default 50, at most 200 — more is refused, not clamped), often `q`
for a search, and the answer `{ "rows": [...], "total": 1234, "page": 2,
"pageSize": 50 }`, where `total` counts what matches. Stop when
`page * pageSize >= total`.

### Generating a client

Point any OpenAPI 3.1 generator at the committed file or at a deployment's
`/api/openapi.json`, and pin the file you generated from:

```sh
npx openapi-typescript https://syntra.example.com/api/openapi.json -o syntra-api.d.ts
npx @openapitools/openapi-generator-cli generate -i apps/api/openapi.json -g python -o ./syntra-client
curl -fsS "https://syntra.example.com/api/admin/users?pageSize=100" -H "Authorization: Bearer $SYNTRA_TOKEN"
```

Request bodies, query strings and path parameters are fully described; most
response bodies are not yet, and are published as "a JSON object" apart from the
paging envelope and the operations with a contracts schema. Adding one is a
minor-version change.

**Changing a route** means describing it in the module's
`apps/api/src/routes/admin/<module>.openapi.ts` (a summary, the Zod schemas the
handler already parses, the success status when it is not 200), then running
`pnpm openapi:generate` and committing `apps/api/openapi.json` with the change —
the diff is the contract change a reviewer reads. The method, path,
permissions, token refusal and rate limit come from the registered route table
and are never written by hand. `apps/api/src/openapi/openapi.test.ts` fails on
an undescribed `/api/admin` route or a description of one that no longer
exists, and CI (and `pnpm openapi:check` locally) fails when the committed file
is stale.

## Personal data

What Syntra stores about a person, and where, is listed field by field in the
data inventory, [`packages/core/data-inventory.md`](../packages/core/data-inventory.md),
generated from the code by `pnpm privacy:inventory` and checked in CI by
`pnpm privacy:inventory:check`. Access, rectification, restriction and erasure
requests are handled as cases under **Privacy requests** in the console
(`privacy.manage`); erasure is
decided by two administrators, each signed in, and is refused to API tokens.
How a case runs, and what erasure does and keeps, is in
[Data-subject requests](operate.md#data-subject-requests). Deactivating an
account, deleting a SCIM user and retiring an application are not erasure:
each keeps the record on purpose.

## Further reading

- [Install](install.md) — development, single-process, container and
  Kubernetes installs, TLS.
- [Operating Syntra](operate.md) — upgrades, backups, incidents, data-subject
  requests, CI, tests, troubleshooting.
- [The console, screen by screen](console-guide.md).
- [The Helm chart's values](../deploy/helm/syntra/README.md).
