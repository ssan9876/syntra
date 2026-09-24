# Syntra Helm chart

Deploys the Syntra API and web console to Kubernetes, with the schema
migration as a pre-install/pre-upgrade hook. Ingress, autoscaling, network
policy, Prometheus Operator monitoring, scheduled backups and a scheduled
API restart are all available and all controlled from `values.yaml`.

The defaults favour safety over completeness:

- **No secrets in the chart.** Credentials come from a Secret you create
  (`existingSecret`). If neither that nor `secret.create` is set, the render
  fails with a message saying what to do. Credentials in a values file end up
  in Helm's release history.
- **One API replica.** More than one works, but some state lives in each
  process. Read [Running more than one API replica](#running-more-than-one-api-replica)
  before you raise `api.replicas` or turn on autoscaling.
- **Hardened pods.** Both workloads run as non-root with a read-only root
  filesystem, all capabilities dropped, `allowPrivilegeEscalation: false`,
  seccomp `RuntimeDefault` and no service-account token. Each has
  resource requests and limits.
- **NetworkPolicy is on.** Only the ingress controller can reach the web
  pods, and only the web pods can reach the API. Egress is limited by port:
  DNS, Postgres, SMTP and the connector ports. Cloud metadata addresses are
  excluded.

Install **one release per namespace**. The web image's nginx sends API
traffic to the in-namespace Service called `api` on port 3000. The chart
creates that Service under that exact name, so two releases in one namespace
would collide.

## Install

```bash
kubectl create namespace syntra
kubectl -n syntra create secret generic syntra-runtime \
  --from-literal=DATABASE_URL='postgresql://syntra_app:...@db.example.internal:5432/syntra?connection_limit=10' \
  --from-literal=SESSION_SECRET="$(openssl rand -base64 32)" \
  --from-literal=MASTER_KEY="$(openssl rand -base64 32)" \
  --from-literal=SMTP_URL='smtp://mail.example.com:587' \
  --from-literal=METRICS_TOKEN="$(openssl rand -hex 24)"

helm upgrade --install syntra ./deploy/helm/syntra -n syntra \
  --set existingSecret=syntra-runtime \
  --set publicUrl=https://idm.example.com \
  --set api.image.tag=1.4.0 --set web.image.tag=1.4.0 \
  --set api.trustProxy=10.244.0.0/16 \
  --set ingress.enabled=true --set ingress.className=nginx \
  --set 'ingress.hosts[0].host=idm.example.com' \
  --set 'ingress.hosts[0].paths[0].path=/'
```

**Back up `MASTER_KEY` outside the cluster.** It encrypts every stored
credential and signs SAML, and a database restore does not bring it back. A
Secret that exists only in etcd is not a backup.

Or keep the master key out of the cluster altogether: with
`MASTER_KEY_PROVIDER=vault-transit` or `aws-kms` (IRSA / Pod Identity for the
AWS credentials), put the provider variables in a Secret or ConfigMap named
in `api.envFrom`, and `MASTER_KEY` in `existingSecret` may be empty. See
[Key management](../../../docs/configure.md#key-management). The backup
CronJob still fingerprints `MASTER_KEY` only (`null` once it is empty),
unlike `syntra-backup`, which fingerprints the external key reference.

`ci/full-values.yaml` is a worked production example with every option
turned on. `ci/minimal-values.yaml` shows the least an install needs.

### The first tenant

Run the production bootstrap once. It is not the dev seed:

```bash
kubectl -n syntra exec deploy/syntra-api -- env \
  BOOTSTRAP_TENANT_NAME='Example Ltd' BOOTSTRAP_TENANT_SLUG=example \
  BOOTSTRAP_TENANT_DOMAIN=idm.example.com BOOTSTRAP_ADMIN_EMAIL=you@example.com \
  BOOTSTRAP_ADMIN_PASSWORD='...' \
  sh -c 'cd /app/packages/db && node --import tsx src/bootstrap.ts'
```

## Values that matter most

| Value | Why |
|---|---|
| `existingSecret` | Required. Must hold `DATABASE_URL`, `SESSION_SECRET`, `MASTER_KEY` and `SMTP_URL`. Optional keys: `METRICS_TOKEN`, `GOVERN_CHECKPOINT_KEY`, a direct `MIGRATION_DATABASE_URL` (`secretKeys.migrationDatabaseUrl`) and `BACKUP_DATABASE_URL` for the backup CronJob. Rename keys with `secretKeys.*`. |
| `publicUrl` | Required. The origin users type. The session cookie and the WebAuthn relying party are derived from it. |
| `api.trustProxy` | Traffic arrives as ingress controller → web → API, so set this to the pod CIDR. If it is empty, every per-address rate limit and IP policy condition sees the web pod's address and collapses into one bucket. `true` and hop counts are refused, by the chart and by the API. |
| `api.image.tag` / `web.image.tag` | Pin a release. Empty means `appVersion`. A `digest` overrides the tag. |
| `ingress.*` | Routes each host to the web Service, whose nginx forwards `/api`, `/saml`, `/oidc`, `/federation`, `/scim`, `/health` and `/metrics`. Every tenant hostname needs a host entry, because Syntra picks the tenant from `Host`. Most controllers default to 1 MB bodies and 60 s timeouts, but federation metadata can reach 2 MB and sync previews can take up to 120 s. `values.yaml` has the ingress-nginx annotations for both. |
| `networkPolicy.ingressFrom` | Who may reach the web pods. The default is namespace `ingress-nginx`. If your controller runs elsewhere, the console times out until this is set. |
| `networkPolicy.postgres` / `.smtp` / `.connectorEgress` | Egress allow-lists as `{cidrs, ports}`. See [Connector egress](#connector-egress). |

## What the chart renders

| Resource | When |
|---|---|
| Deployment + Service `<release>-web` | Always. nginx on 8080 runs as uid 101 on a read-only root. It gets `emptyDir` mounts for `/tmp` and `/var/cache/nginx`. |
| Deployment `<release>-api` + Service `api` | Always. Node runs as uid 1000 on a read-only root, with an `emptyDir` for `/tmp`, which holds tsx's compile cache. The chart **overrides the image's CMD** so the pod does not migrate on start; the hook Job below does that. |
| Job `<release>-migrate` | `migration.enabled` (default). Runs as a `pre-install,pre-upgrade` hook, weight -10, with `backoffLimit: 1`, a 15-minute deadline and a 24 h TTL. A failed migration fails the `helm upgrade` and leaves the running pods alone. It runs `prisma migrate deploy` directly, because pnpm/corepack need a writable home directory. |
| ServiceAccount | `serviceAccount.create` (default). Sets `automountServiceAccountToken: false`. |
| Ingress | `ingress.enabled` |
| HorizontalPodAutoscaler | `api.autoscaling.enabled` / `web.autoscaling.enabled`. Scales down slowly: one pod per 2 minutes after a 5-minute window. |
| PodDisruptionBudget | Only when a component can have more than one pod. A PDB over one replica would block every node drain. |
| topologySpreadConstraints | Always. Soft spreading across nodes and zones, unless you set your own. |
| NetworkPolicy ×3 (+1) | `networkPolicy.enabled` (default). Separate policies for web, API, and the migrate/backup Jobs, plus one for the restart Job when that is on. |
| ServiceMonitor | `metrics.serviceMonitor.enabled`. Scrapes each API pod's `/metrics` with `METRICS_TOKEN` as the bearer token, read from the runtime Secret. |
| PrometheusRule | `metrics.prometheusRule.enabled`. Uses `files/prometheus-alerts.yml`, which CI keeps byte-identical to `ops/prometheus-alerts.yml`. |
| CronJob `<release>-backup` + PVC | `backup.enabled`. See [Backups](#backups). |
| CronJob `<release>-rollout-restart` + Role | `apiRolloutRestart.enabled`. See below. |
| Secret `<release>-runtime` | Only when `secret.create=true` and no `existingSecret` is set. Use it for disposable environments only. It is a hook, so `helm uninstall` leaves it in place. |

### Probes

| Probe | API | Web |
|---|---|---|
| startup | `GET /health`, up to 3 minutes | none |
| liveness | `GET /health`. It returns a constant and never touches the database, so a Postgres blip does not restart the API. | `GET /` (served from disk) |
| readiness | `GET /health/ready`. Checks the database, migrations, the vault unseal and the console, and returns 503 when any fails. | `GET /` |

Web probes deliberately avoid `/health`. On that server, `/health` is a proxy
to the API, so the probe would restart healthy nginx pods whenever the API is
down.

`/health/ready` is rate-limited to 60 requests per minute per address, per
process. The default readiness period of 10 s uses 6 of those. Keep the
period at 2 s or more.

## Running more than one API replica

This section comes from reading the code at the time of writing, not from
assumptions. Here is what is safe and what is per-process:

**Safe across replicas (shared through Postgres):**

- **Background jobs.** pg-boss keeps queues and cron schedules in Postgres
  and claims jobs with `SKIP LOCKED`, so each job runs on exactly one
  replica. Every replica re-applies all schedules at boot
  (`scheduleBackgroundWork`). Schedules are keyed on `(queue, key)`, so this
  reconciles rather than duplicates.
- **Sessions, OIDC and login state.** Sessions, OIDC artefacts (codes,
  tokens, grants and interactions, through the tenant-bound adapter),
  WebAuthn challenges, email OTP codes, TOTP replay counters, login lockout
  (with `pg_advisory_xact_lock`), SAML/federation replay records and the
  audit hash chain (also with an advisory transaction lock).
- **Cookies.** Session and OIDC cookies are signed with `SESSION_SECRET`,
  which is the same for every replica.

**Per process: the consequences you accept with N > 1:**

1. **The OIDC provider cache.** Each process builds one `oidc-provider`
   instance per tenant and caches it (`packages/protocols/src/oidc/provider-factory.ts`).
   Clients, redirect URIs, token lifetimes, issuer hostnames and the signing
   JWKS are fixed when the instance is built. The cache is evicted by
   `invalidateProvider()`, which is **only called in the process that made
   the change**:
   - **OIDC application changes** (`routes/admin/protocol-apps.ts`). The
     other replicas keep the old client list until they restart. A new
     client can get `invalid_client` on some requests, a deleted client
     still works there, and a changed redirect URI is enforced
     inconsistently.
   - **Tenant hostname changes** (`routes/admin/tenant.ts`). The other
     replicas keep issuing tokens with the old issuer.
   - **Signing-key rotation** (`keys.rotate`, a pg-boss job at 03:00 UTC on
     the 1st of each month). The job runs on one replica, so only that one
     evicts its cache. The others keep signing with the now-outgoing key.
     That works for the 7-day overlap while the key is still published.
     **After that, their tokens fail validation at every relying party**
     until those replicas restart.

   Mitigations: after changing an OIDC application or a tenant hostname, run
   `kubectl rollout restart deployment/<release>-api`. For key rotation, set
   `apiRolloutRestart.enabled=true`. This adds a CronJob on the 2nd of each
   month and a Role limited to patching that one Deployment. The proper fix
   is a cross-process invalidation, for example Postgres `LISTEN/NOTIFY` or a
   version column checked per request. **It has not been built.**
2. **Rate limits.** `@fastify/rate-limit` is registered with no external
   store, so counters live in memory in each process. Behind a round-robin
   Service, the per-address limit (`AUTH_RATE_LIMIT_MAX`, default 10/min)
   and the per-tenant ceiling (`AUTH_RATE_LIMIT_TENANT_MAX`) are each
   effectively **up to N times** their configured value. To keep the same
   protection, divide both by the replica count (`api.authRateLimitMax`,
   `api.authRateLimitTenantMax`), or pin clients with session affinity at
   the ingress. Account lockout is stored in the database, so it is
   unaffected.
3. **Outbound OAuth token caches.** The Microsoft Graph and HTTP connectors
   each cache their own access tokens per process. This only costs one extra
   token request per replica.
4. **Metrics.** `/metrics` exposes each process's own readiness, scheduler
   state and request histograms. Aggregate across pods. Database-derived
   gauges report the same value from every pod.

Scaling the web tier is always safe, because it is stateless nginx.

## Connector egress

Syntra's outbound traffic includes:

- LDAP/LDAPS to Active Directory (389/636)
- SCIM and Microsoft Graph over HTTPS (443)
- SFTP HR feeds (22)
- Upstream OIDC/SAML discovery and metadata (443)
- Webhooks and back-channel logout (usually 443)
- SMTP

Kubernetes NetworkPolicy matches **IP ranges and ports, never hostnames**.
The default `networkPolicy.connectorEgress` therefore allows 443/636/389/22
to any address except the cloud metadata endpoints. That limits ports, not
destinations. To tighten it:

- List the real destinations as CIDRs, as in `ci/full-values.yaml`: domain
  controllers on 636, the SFTP host on 22, and 443 wherever SaaS endpoints
  must be reached.
- For hostname rules such as `graph.microsoft.com` or `*.okta.com`, use your
  CNI's own policy (Cilium `toFQDNs`, Calico `domains`) or an egress proxy,
  alongside this policy.
- Add anything else, such as an HTTP webhook on port 80, with
  `networkPolicy.extraApiEgress` (raw NetworkPolicyEgressRule objects).

## Backups

The container path has no backup mechanism of its own. `ops/syntra-backup`
works through `docker exec` on a host. With `backup.enabled=true`, the chart
adds a CronJob that uses the stock `postgres` image and **applies the same
checks as `syntra-backup create`**, writing the same layout
(`syntra-<UTC>/{database.dump,manifest.json}`) to a PersistentVolume:

- The dump is written to a `.partial` directory and only renamed into place
  once every check passes. A killed pod never leaves something that looks
  like a backup.
- Files are created `0600` under `umask 077`.
- The archive must start with `PGDMP` **and contain TABLE DATA**. Every tenant
  table is `FORCE ROW LEVEL SECURITY`, so a dump taken as `syntra_app` would
  be an empty archive. This was verified: `pg_dump` as `syntra_app` fails
  with *"query would be affected by row-level security policy"*, and the job
  exits non-zero.
- The manifest records the salted SHA-256 fingerprint of `MASTER_KEY`, using
  the same salt as `syntra-backup`, so a restore can tell whether the key
  still matches.
- The newest `backup.keep` backups are kept (default 7).

Put a role that bypasses RLS (a superuser, or a role with `BYPASSRLS`) in the
Secret under `BACKUP_DATABASE_URL`. Use a **direct** connection, not a
transaction pooler. The PVC is annotated `helm.sh/resource-policy: keep`.
Use an encrypted StorageClass: every file is a full copy of every tenant's
data. A PVC is **not off-site**. Copy it out with your own tooling (Velero,
a snapshot schedule, or object-storage sync), or skip this CronJob and use
your managed Postgres's PITR. docs/operate.md has the restore procedure and
the HA Postgres guidance.

## Upgrading from 0.1

- `api.image` / `web.image` are now `{repository, tag, digest, pullPolicy}`.
- `existingSecret` no longer defaults to `syntra-runtime`. Set it explicitly.
- `PUBLIC_URL` moved from the Secret to the `publicUrl` value. To keep reading
  it from the Secret, set `secretKeys.publicUrl=PUBLIC_URL`.
- `METRICS_TOKEN` is now optional in the Secret.
- The API pods no longer run migrations on start. The hook Job does.
- Deployment selectors are unchanged, so the upgrade happens in place.
- NetworkPolicy is now on by default. Check `networkPolicy.ingressFrom`
  before you upgrade.

## Validating the chart

CI runs `helm lint --strict` and `helm template` with both files under `ci/`.
It also checks that rendering without `existingSecret` fails, and that
`files/prometheus-alerts.yml` matches `ops/prometheus-alerts.yml`. To run the
same checks locally without installing Helm:

```bash
docker run --rm -v "$PWD/deploy/helm/syntra:/chart" alpine/helm:3.16.2 lint --strict /chart -f /chart/ci/full-values.yaml
docker run --rm -v "$PWD/deploy/helm/syntra:/chart" alpine/helm:3.16.2 template syntra /chart -f /chart/ci/full-values.yaml
```
