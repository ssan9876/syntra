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
- **Two API replicas.** Every piece of state that has to agree between
  replicas lives in Postgres, including the OIDC provider cache's validity
  and the rate-limit counters, so a node drain or a crashed pod does not
  take sign-in down. See [Running more than one API replica](#running-more-than-one-api-replica)
  for what is shared and how.
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

Each release publishes this chart to `oci://ghcr.io/ssan9876/charts/syntra`,
with chart version and appVersion both set to the release. Empty image tags
mean appVersion, so chart `1.20.0` installs images `1.20.0`. Check the chart
first with `gh attestation verify oci://ghcr.io/ssan9876/charts/syntra:1.20.0
--repo ssan9876/syntra` (see
[Verifying a release](../../../docs/operate.md#verifying-a-release)).

```bash
kubectl create namespace syntra
kubectl -n syntra create secret generic syntra-runtime \
  --from-literal=DATABASE_URL='postgresql://syntra_app:...@db.example.internal:5432/syntra?connection_limit=10' \
  --from-literal=SESSION_SECRET="$(openssl rand -base64 32)" \
  --from-literal=MASTER_KEY="$(openssl rand -base64 32)" \
  --from-literal=SMTP_URL='smtp://mail.example.com:587' \
  --from-literal=METRICS_TOKEN="$(openssl rand -hex 24)"

cat > values.yaml <<'EOF'
existingSecret: syntra-runtime
publicUrl: https://idm.example.com
api:
  trustProxy: 10.244.0.0/16
ingress:
  enabled: true
  className: nginx
  hosts:
    - host: idm.example.com
      paths:
        - path: /
EOF

helm install syntra oci://ghcr.io/ssan9876/charts/syntra --version 1.20.0 \
  -n syntra -f values.yaml
```

To upgrade: `helm upgrade syntra oci://ghcr.io/ssan9876/charts/syntra
--version <new> -n syntra -f values.yaml`. Always pass `--version`. `helm show
values oci://ghcr.io/ssan9876/charts/syntra --version 1.20.0` prints every
value with its default.

**From this directory** the chart is version `0.3.0` with appVersion
`latest`. Use it only to test an unreleased change, and pin the images:
`helm upgrade --install syntra ./deploy/helm/syntra -n syntra -f values.yaml
--set api.image.tag=1.20.0 --set web.image.tag=1.20.0`.

**Back up `MASTER_KEY` outside the cluster.** It encrypts every stored
credential and signs SAML, and a database restore does not bring it back. A
Secret that exists only in etcd is not a backup.

Or keep the master key out of the cluster altogether: with
`MASTER_KEY_PROVIDER=vault-transit` or `aws-kms` (IRSA / Pod Identity for the
AWS credentials), put the provider variables in a Secret or ConfigMap named
in `api.envFrom`, and `MASTER_KEY` in `existingSecret` may be empty. See
[Key management](../../../docs/configure.md#key-management). The backup
CronJob reads the same `api.env` and `api.envFrom`, and fingerprints the
Vault or KMS key reference the way `syntra-backup` does.

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
| `existingSecret` | Required. Must hold `DATABASE_URL`, `SESSION_SECRET`, `MASTER_KEY` and `SMTP_URL` (or, with `mail.transport=graph`, `MAIL_GRAPH_CLIENT_SECRET` instead of `SMTP_URL`). Optional keys: `METRICS_TOKEN`, `GOVERN_CHECKPOINT_KEY`, a direct `MIGRATION_DATABASE_URL` (`secretKeys.migrationDatabaseUrl`) and `BACKUP_DATABASE_URL` for the backup CronJob. Rename keys with `secretKeys.*`. |
| `publicUrl` | Required. The origin users type. The session cookie and the WebAuthn relying party are derived from it. |
| `mail.*` | How mail leaves: `smtp` (default, `SMTP_URL` from the Secret) or `graph` (Microsoft 365). For `graph`, set `mail.graph.tenantId`, `.clientId` and `.sender` here and put the client secret in the Secret as `MAIL_GRAPH_CLIENT_SECRET` (`secretKeys.mailGraphClientSecret`). The chart never takes the secret from values. `mail.from` sets the From header. See [Sending through Microsoft 365](../../../docs/configure.md#sending-through-microsoft-365). |
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

`/health/ready` is rate-limited to 60 requests per minute per address. The
counter is shared by every API replica, and the kubelet probes from its
node's address, so all API pods on one node share one allowance. The
default readiness period of 10 s uses 6 per pod per minute, which leaves
room for 10 API pods on a node. Keep `periodSeconds` at least equal to the
number of API pods one node can hold. If the limiter's store (Postgres) is
unreachable, this route still answers, with 503 and the failing probe named,
rather than failing inside the limiter.

## Running more than one API replica

The chart runs two API replicas by default, and more are safe. This section
comes from reading the code, not from assumptions. It lists what is shared
and how, and the little that stays per process.

**Shared through Postgres:**

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
- **The OIDC provider cache's validity.** Each process still builds and
  caches one `oidc-provider` instance per tenant, because the library fixes
  clients, issuer and signing keys at construction. Each tenant row carries
  an `oidcConfigGeneration` counter. Database triggers bump it in the same
  transaction as any change a provider is built from: an OIDC client insert,
  update or delete (from the admin API, a catalog install or a cascade), an
  OIDC signing-key rotation or retirement, and a tenant hostname change.
  Every OIDC request already reads the tenant row, and the cache rebuilds
  when the row's generation is newer than the one it was built at. A change
  made through any replica, or by the key-rotation job wherever it runs, is
  therefore used by every replica **on its next request**, with no staleness
  window and no extra query. This does not use `LISTEN/NOTIFY`, so it works
  unchanged behind PgBouncer in transaction pooling mode.
  (`packages/protocols/src/oidc/provider-factory.ts`,
  migration `20261027173100_replica_safe_state`.)
- **Rate limits.** `@fastify/rate-limit` counts in the `RateLimitBucket`
  table (`RATE_LIMIT_STORE=postgres`, the default). Each count is one
  upsert per rate-limited request, using the database clock. The
  per-address limit (`AUTH_RATE_LIMIT_MAX`) and the per-tenant ceiling
  (`AUTH_RATE_LIMIT_TENANT_MAX`) therefore hold at their configured values
  for the deployment as a whole, whatever the replica count. Do **not**
  divide them by the replica count. Ended windows are swept every minute.
  `RATE_LIMIT_STORE=memory` (`api.rateLimitStore`) restores the old
  per-process counters. That is only correct with exactly one replica.

**Still per process, and harmless:**

1. **Outbound OAuth token caches.** The Microsoft Graph and HTTP connectors
   each cache their own access tokens per process. This costs one extra
   token request per replica.
2. **Metrics.** `/metrics` exposes each process's own readiness, scheduler
   state and request histograms. Aggregate across pods. Database-derived
   gauges report the same value from every pod.

**The scheduled API restart is optional.** `apiRolloutRestart.enabled` adds
a CronJob on the 2nd of each month and a Role limited to patching the API
Deployment. It was a workaround for replicas that did not hear about a
signing-key rotation. The generation counter covers that now, so the restart
is not needed for correctness. Turn it on only if you want a regular restart
for your own reasons.

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

With `backup.enabled=true` the chart runs the backup agent: a one-replica
Deployment from the api image, a ClusterIP Service on 3100 that only the API
pods may reach (with `networkPolicy.enabled`), and a PersistentVolumeClaim.
It provides **Administration → Backups**: restore points every
`backup.intervalHours` (default 1), kept 48 hourly, 14 daily and 8 weekly
(`backup.retention`), Back up now, download and upload as a
passphrase-encrypted file, and restore. See
[Backups from the console](../../../docs/operate.md#backups-from-the-console).

It writes the layout `ops/syntra-backup` writes
(`syntra-<UTC>/{database.dump,manifest.json}`), with the same checks: a
`.partial` directory renamed into place only once the archive starts with
`PGDMP` and contains TABLE DATA, `0600` files, and the salted fingerprint of
`MASTER_KEY` or of the Vault/KMS key reference in the manifest.

Put a role that bypasses RLS (a superuser, or a role with `BYPASSRLS`) in the
Secret under `BACKUP_DATABASE_URL`. Use a **direct** connection, not a
transaction pooler: a restore locks the application role out and ends its
connections. The PVC is annotated `helm.sh/resource-policy: keep`. Use an
encrypted StorageClass: every file is a full copy of every tenant's data. A
PVC is **not off-site**: set `backup.copyCommand` (with
`networkPolicy.extraBackupEgress` for its destination), or copy it out with
your own tooling.

A restore keeps the API running. Every API pod restarts twice and comes back
held until somebody selects **Resume**.

A restore test runs every `backup.verifyEveryDays` (default 7). For off-site
copies set `backup.offsite.bucket` (and `endpoint` for anything that is not
AWS), and put `BACKUP_S3_PASSPHRASE` in the Secret; the access keys too,
unless the pod has an IAM role. Allow the bucket in
`networkPolicy.extraBackupEgress`.

## Upgrading from 1.20 or earlier

- `backup.enabled` now runs the backup agent (a Deployment and a Service)
  instead of a CronJob. The PVC and its backups are kept and read as they are.
- Removed: `backup.schedule`, `backup.keep` and `backup.image`. Use
  `backup.intervalHours` and `backup.retention`; the agent runs from
  `api.image`.

## Upgrading from 0.2

- `api.replicas` now defaults to `2`. This is safe only with an API image
  that includes migration `20261027173100_replica_safe_state`. If you deploy
  an older image with this chart, set `api.replicas=1`.
- If you divided `api.authRateLimitMax` / `api.authRateLimitTenantMax` by
  your replica count, undo that. The counters are now shared, so the values
  apply to the whole deployment.
- `apiRolloutRestart` is no longer needed. You can turn it off.
- New value: `api.rateLimitStore` (empty means `postgres`).

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
