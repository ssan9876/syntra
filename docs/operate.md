# Operating Syntra

Upgrades, backups, what "delete" actually means in this product, and how the
test suite and CI are put together — including the troubleshooting notes that
save the most time.

## Upgrades

Syntra's own in-console updater and the `syntra-update` / `syntra-install`
scripts under `ops/` are covered end to end, including the systemd units and
a full worked run, in [`docs/lab/README.md`](lab/README.md#why-this-is-not-an-ordinary-update-button)
— that document is written from an actual lab deployment and is the source
of truth for the update workflow. In short: the updater is not part of
Syntra, runs as its own transient systemd unit outside the API process, takes
a pre-migration database dump through the Postgres container before it acts,
and can roll back. The environment variables that configure it —
`RELEASE_REPO`, `RELEASE_TOKEN`, `RELEASE_ROOT`, `PG_CONTAINER` — are listed
in [Configuration](configure.md#updating-from-the-console); all are optional,
and an install that sets none of them simply has no update button.

The scripts themselves are not tied to the lab: `SYNTRA_ROOT` moves the
release layout away from `/opt/syntra`, and `SYNTRA_RELEASE_REPO` names the
GitHub repository whose releases they download, for a fork that cuts its own.

For the container path (`docker-compose.yml`), an upgrade is pulling a newer
image: set `SYNTRA_VERSION` to the release you want and re-run
`docker compose up -d` (see [Install](install.md#running-it-for-real-the-container-path)).

## Backups

Two things to keep, and either one alone is not enough:

- **The database.** It is the whole state of the deployment — tenants,
  persons, contracts, policy, the audit log, every application's
  configuration.
- **`MASTER_KEY`.** It encrypts every stored credential and signs SAML. A
  restored database with a lost `MASTER_KEY` means every stored secret is
  unreadable and every SAML integration has to be reconfigured. It is not
  stored in the database, so it does not come back with a database restore —
  back it up separately, and never rotate it by hand.

`syntra-backup` takes care of the first and **detects** a mismatch in the
second. It does not fix one: keeping the key is still yours.

```
syntra-backup create               take one
syntra-backup verify [name]        prove one restores, then throw the copy away
syntra-backup restore <name> --yes replace the live database with one
syntra-backup list                 what is here, and whether it can be restored
```

Backups land in `/opt/syntra/backups`, one directory each, holding a
`pg_dump` archive and a manifest. `SYNTRA_BACKUP_DIR` moves them and
`SYNTRA_BACKUP_KEEP` changes how many are kept (seven by default; the oldest
beyond that are pruned after each successful run).

**They are deliberately not in `shared/backups`.** That is where the updater
puts its pre-migration dumps, and it prunes that directory to the last three on
every upgrade — a backup history kept beside them would be silently truncated
by an unrelated update, and you would find out during a recovery.

### Turning it on

The timers are installed by `syntra-install` and **left disabled**, because a
tool that starts writing gigabytes to a disk nobody sized for it is a tool that
gets uninstalled. Turn them on deliberately:

```bash
systemctl enable --now syntra-backup.timer          # daily
systemctl enable --now syntra-backup-verify.timer   # weekly
```

**Enable the second one.** It is the point of the arrangement, not a fourth
command you might get to later. A backup schedule nobody checks produces a
directory full of files with the shape of backups, and the first time anybody
learns otherwise is the worst possible time. `verify` restores the newest
backup into a scratch database, counts what arrived, and drops it — it never
touches the live database, which is what makes it safe to run unattended.

A truncated or corrupt archive still starts with the right magic bytes and is
still non-empty. `verify` is what tells the difference between an archive that
is well-formed and one that is restorable.

The verify unit is ordered `After=syntra-backup.service`, so on the night both
timers elapse it cannot start while the dump is still being written — a verify
that read a half-written `latest` would report the backup unrestorable, and the
alarm would be real-looking and wrong.

### Seeing that a run failed

A `Type=oneshot` timer job that fails leaves the timer itself perfectly
healthy: `active (waiting)`, with a plausible next elapse. **The timer's state
is not the backup's state.** Ask about the service:

```bash
systemctl list-timers syntra-backup\*        # when each last ran and next will
systemctl is-failed syntra-backup.service    # "failed" or "active"; exit 0 means failed
systemctl status syntra-backup.service       # and why
journalctl -u syntra-backup.service -n 50 --no-pager
```

You should not have to remember to ask. Both units carry
`OnFailure=syntra-backup-failed@%n.service`, a handler installed alongside them
by `syntra-install`, which writes to the journal at **error** priority naming
the unit that failed, the command to read its log, and the fact that there is
now no recovery point newer than the last successful run:

```bash
journalctl -p err -t syntra-backup --since -7d --no-pager
```

That is the line to put in whatever already watches this host's journal for
errors. It is journal-only on purpose: mail would need an MTA this host may not
have and an address the unit cannot know, and a notification that silently
fails to send is worse than one that was never promised.

### When a restore refuses

`restore` refuses an interrupted backup, a backup whose archive no longer
passes the checks it passed when taken — archives rot on disk — and this:

```
syntra-backup: this backup was taken under a different MASTER_KEY
  backup:  sha256:9f2b…
  running: sha256:41c7…
```

The manifest records a salted fingerprint of `MASTER_KEY`, never the key
itself, so a stolen backup is not a stolen key. What the fingerprint buys is
this refusal: restoring a database whose secrets were sealed under a key you no
longer have is a restore that appears to succeed and has quietly destroyed
every stored credential's usability.

The right response is almost always to go and find the original key.
`--accept-secret-loss` overrides it for the cases where the answer is genuinely
yes — a development host, or a deployment whose secrets are all being rotated
anyway. It does not imply `--yes`; you still have to say both.

A backup taken where `MASTER_KEY` could not be read records `null` and `list`
shows its key column as `unknown`. Unknown never counts as a match.

### Getting them off the host

Not this tool's job, deliberately. `rsync`, `restic` and every object-store
client already do it better than a shell script bolted onto this one would.
Each backup is a self-contained directory with a stable, sortable name; point
something at `/opt/syntra/backups` and it will do the right thing.

There is no point-in-time recovery here. That needs WAL archiving, which is
a different feature with different operational requirements, and `pg_dump`
is not a step toward it.

## Kubernetes and high availability

The Helm chart in [`deploy/helm/syntra`](../deploy/helm/syntra/README.md)
is the Kubernetes path. It runs the migration as a pre-upgrade hook and the
pods on read-only root filesystems. Ingress, NetworkPolicy, PodDisruptionBudget,
autoscaling, a ServiceMonitor and a PrometheusRule are optional. The chart
runs two API replicas by default, and any number is correct. The chart
README's section
[Running more than one API replica](../deploy/helm/syntra/README.md#running-more-than-one-api-replica)
has the details. In short:

- pg-boss, sessions, OIDC artefacts, challenges and lockout are shared
  through Postgres.
- Each process caches its OIDC providers, but checks each one against the
  tenant's `oidcConfigGeneration` on every request. Database triggers bump
  that counter in the same transaction as any OIDC client, OIDC signing-key
  or tenant-hostname change. A change made on one replica, or by the
  key-rotation job, therefore reaches every replica on its next request. No
  restart is needed, and it works behind PgBouncer transaction pooling
  because it does not use `LISTEN/NOTIFY`.
- Rate-limit counters are shared in Postgres (`RATE_LIMIT_STORE=postgres`,
  the default). `AUTH_RATE_LIMIT_MAX` and `AUTH_RATE_LIMIT_TENANT_MAX` are
  deployment-wide limits whatever the replica count.
  `RATE_LIMIT_STORE=memory` keeps per-process counters and is only correct
  for a single process.

Syntra has no state of its own outside Postgres, `MASTER_KEY` and
`SESSION_SECRET`. Availability therefore depends almost entirely on the
database.

### Postgres for production

- **Use managed or replicated Postgres** with automatic failover: RDS/Aurora,
  Cloud SQL, Azure Flexible Server, or an operator such as CloudNativePG,
  Crunchy PGO or Zalando with synchronous or quorum replication. Syntra
  needs no extensions and nothing beyond PostgreSQL 16 semantics.
- **Connect to the primary through its failover endpoint** (the cloud
  writer endpoint, or the operator's `-rw` Service). **Never point Syntra at
  a read replica.** Every request writes: sessions, audit and lockout.
- **Keep the role model.** Syntra connects as a `NOSUPERUSER NOBYPASSRLS`
  role that owns the tables. That is what makes `FORCE ROW LEVEL SECURITY`
  bind it. Recreate `infra/initdb/01-app-role.sh`'s grants on the managed
  instance, including `CREATE` on the database, which pg-boss needs for its
  own schema. On services that grant new roles extra privileges by default,
  check the role with `\du`. Many managed "admin" roles carry `BYPASSRLS`,
  and a connection as one of them silently disables tenant isolation.
- **Failover behaviour.** During a failover, `/health/ready` returns 503 and
  Kubernetes stops sending traffic, but liveness (`/health`) keeps passing,
  so pods are not restarted into a crash loop. Prisma and pg-boss reconnect
  on their own. An interactive transaction in flight at that moment fails
  and the client sees a 5xx. A pg-boss job in flight is retried: queues are
  created with `retryLimit: 3` and backoff.

### PgBouncer and transaction pooling

Transaction pooling works with how Syntra sets tenant context. This was
checked in the code and against a real PgBouncer:

- `withTenant` (`packages/db/src/with-tenant.ts`) opens a transaction and
  runs `SELECT set_config('app.current_tenant', $1, true)`. The `true` means
  *is_local*: the setting lasts only for that transaction, the same as
  `SET LOCAL`, and never leaks to the next client of a pooled server
  connection. A session-level `SET` or `set_config(..., false)` would be
  unsafe under transaction pooling. **Nothing in the codebase does that.**
  Keep it that way.
- The lockout and audit-chain locks are `pg_advisory_xact_lock`, which are
  also transaction-scoped.
- **Prepared statements are the one real requirement.** Prisma uses named
  prepared statements. Tested against PgBouncer 1.25.2 in `pool_mode =
  transaction`:
  - With `max_prepared_statements = 200` (the protocol-level prepared
    statement support added in PgBouncer 1.21), sign-in, the RLS-scoped
    reads, `/health/ready` and the pg-boss scheduler all worked unchanged.
  - With `max_prepared_statements = 0`, every tenant-scoped query failed
    with `prepared statement "s1" does not exist`, and `/health/ready`
    correctly returned 503.
  - With `max_prepared_statements = 0` and `?pgbouncer=true` added to
    `DATABASE_URL`, everything worked again. That flag makes Prisma stop
    using named statements. pg-boss (node-postgres) ignores the parameter
    and ran normally.

  So: on PgBouncer 1.21 or later, set `max_prepared_statements` above zero.
  On anything older, or on a pooler you cannot configure, append
  `pgbouncer=true`.
- **Migrations and backups must bypass the pooler.** `prisma migrate
  deploy` holds a session-level advisory lock, and `pg_dump` needs a
  consistent session snapshot. Put a direct connection URL in the Secret and
  name it with `secretKeys.migrationDatabaseUrl` (and `BACKUP_DATABASE_URL`
  for backups).
- pg-boss polls and claims jobs with `SELECT … FOR UPDATE SKIP LOCKED` inside
  transactions, so it pools like the application does. pg-boss 12 can also
  use `LISTEN/NOTIFY`, which would break behind a transaction pooler, but
  only when `useListenNotify` is set. It defaults to off, and
  `packages/core/src/jobs/scheduler.ts` does not turn it on. If it is ever
  enabled, give pg-boss a direct connection.

### Connection-pool sizing

Each API process opens two pools against `DATABASE_URL`:

| Pool | Default size | Set with |
|---|---|---|
| Prisma | `physical CPUs × 2 + 1`. The CPUs are the ones the query engine detects, which is usually the **node's** count, not the pod's CPU limit. A pod on a 32-core node can open up to 65 connections. | `?connection_limit=N` in `DATABASE_URL` (and `pool_timeout=S`) |
| pg-boss | 10 (node-postgres `Pool` default; connections show `application_name = pgboss`) | not configurable today |

Set `connection_limit` explicitly. 10 is a sensible start for a 2-CPU pod.
Then size the server's `max_connections` (or PgBouncer's
`default_pool_size`) for the worst case:

```
(maxReplicas + 1 surge pod) × (connection_limit + 10)
  + 2 (migration Job) + 1 (backup Job) + monitoring/admin headroom
```

With 3 replicas and `connection_limit=10`, that is 4 × 20 + 3 = 83, plus
headroom. Behind PgBouncer those are client connections. The server-side
count is the pool size you give PgBouncer, and interactive transactions are
short. Syntra's own budget is under Prisma's 5 s transaction ceiling. More
than 100 server connections is rarely needed.

### Backups in Kubernetes

`syntra-backup` drives `docker exec` on a host, so it does not run in a
cluster. Choose one of these:

1. **Managed Postgres PITR** (preferred). Point-in-time recovery with
   cross-region snapshot copies covers what `pg_dump` cannot. It still does
   not cover `MASTER_KEY`, so keep that in your secret manager, backed up
   separately.
2. **The chart's backup CronJob** (`backup.enabled=true`). It applies the
   same checks as `syntra-backup create`: `.partial` then atomic rename,
   `0600`, `PGDMP` plus a non-empty TABLE DATA check, the salted master-key
   fingerprint, and retention. It writes the same layout to a
   PersistentVolume. See the chart README. It needs a role that bypasses RLS,
   supplied as `BACKUP_DATABASE_URL`. As `syntra_app`, `pg_dump` fails with
   "query would be affected by row-level security policy" and the job fails.
   Copy the PVC off-cluster yourself.

To restore from a CronJob backup:

1. Scale the API to zero: `kubectl scale deploy/<release>-api --replicas=0`.
2. Start a pod with the `postgres` image, mounting the backup PVC and the
   Secret.
3. Compare the manifest's `masterKeyFingerprint` with the running key, as
   `syntra-backup restore` does, and stop if they differ.
4. Drop and recreate `public`. A `pg_restore --clean` alone leaves tables
   created by newer migrations in place.
5. Run `pg_restore --no-owner -d "$BACKUP_DATABASE_URL" database.dump`.
6. Check that rows arrived (`SELECT sum(n_live_tup) FROM pg_stat_user_tables`
   after `ANALYZE`).
7. Run `helm upgrade` so the migration hook brings the schema forward, then
   scale the API back up.

Rehearse this before you need it. `syntra-backup verify` shows the shape of
a restore into a scratch database.

A backup is also the one place an erased tenant survives. How long, and what
to do before restoring one older than a deletion, is in
[Deleted tenants and backups](#deleted-tenants-and-backups).

## Metrics

`GET /metrics`, in Prometheus text exposition, authenticated by a bearer token.

**Set `METRICS_TOKEN` to turn it on.** With no token the route is not
registered at all and the path answers 404 — not 403. That is deliberate: a
route answering 403 confirms its own existence, and the existence of a metrics
endpoint tells somebody probing what this deployment is and how it is operated.
Sixteen characters minimum, and it should be random.

```yaml
scrape_configs:
  - job_name: syntra
    bearer_token: <METRICS_TOKEN>
    static_configs:
      - targets: ['syntra.example:3000']
```

### What it reports

Process and runtime metrics — heap, CPU, event-loop lag — plus:

| Metric | Answers |
|---|---|
| `syntra_http_request_duration_seconds` | Request latency, by route pattern and status |
| `syntra_build_info` | Which release is running |
| `syntra_webhook_deliveries_pending` | Is the webhook sender keeping up? |
| `syntra_webhook_deliveries_abandoned` | Has any integration stopped being fed? |
| `syntra_logout_deliveries_pending` | Back-channel logouts still in flight |
| `syntra_logout_deliveries_abandoned` | **Offboardings a relying party was never told about** |
| `syntra_jobs_pending` | Is the scheduler running at all? |
| `syntra_sessions_active` | |
| `syntra_users_total{status}` | Accounts, active and inactive |
| `syntra_accounts_locked` | A lockout spike, before the tickets arrive |
| `syntra_lifecycle_operations_unresolved` | Lifecycle work still in progress or awaiting verification |
| `syntra_lifecycle_operations_failed` | Lifecycle work requiring recovery |
| `syntra_lifecycle_operations_overdue` | Unacknowledged lifecycle work past its due date |
| `syntra_signing_key_expires_in_seconds` | The nearest signing key's expiry |
| `syntra_audit_events_total{action,outcome}` | Security events, by kind |
| `syntra_readiness` | The same probe `/health/ready` runs |

**Four are worth alerting on before the rest.**
`syntra_logout_deliveries_abandoned` and `syntra_webhook_deliveries_abandoned`
above zero each mean something that was supposed to leave the building did not.
`syntra_signing_key_expires_in_seconds` earns its place because key rotation is
scheduled monthly and its failure is completely silent until every token stops
verifying at once. `syntra_readiness` at 0 is the process telling you it cannot
do its job.

`ops/prometheus-alerts.yml` is an installation-wide starter rule group. Load it
into Alertmanager/Prometheus and route its alerts to the operations channel;
the lifecycle rules intentionally name no tenant because metrics expose no
tenant labels. Use the authenticated employee-work queue to identify the owner
and record.

Two metrics are **absent rather than zero** when the answer is unknown:
`syntra_jobs_pending` where the scheduler has never run, and
`syntra_signing_key_expires_in_seconds` where no key exists. Zero would read as
"the queue is empty" and "expires now" respectively, and both would be wrong in
the direction that wakes somebody up.

### There are no per-tenant labels

Every series is installation-wide, and that is a decision rather than a gap. A
per-tenant label would let anybody who can scrape enumerate your customers,
count them and read their slugs, and the series count would grow with the
customer list — which is the ordinary way a Prometheus instance is brought down
by its own success.

An operator debugging one tenant has the audit log and the console. Both are
authenticated, and both are better at it than a time series.

The counts are assembled with one short transaction per tenant, because every
table involved is under row-level security and the application role has no
`BYPASSRLS` — see [the isolation note](../README.md#how-it-is-put-together).
They are cached for ten seconds, so a scrape every fifteen seconds pays for
them once and a misconfigured scraper cannot multiply the load on the database
it is trying to observe.

## Observability

Three channels leave the process: **logs** (JSON on stdout), **traces**
(optional OpenTelemetry, see [configuration](configure.md#tracing-opentelemetry))
and **metrics** (above). One **correlation id** ties them to the audit log.

### Correlation ids

Every HTTP request and every background job runs under a 32-character hex
correlation id. It is:

- returned on every response as `x-correlation-id` — the thing to ask a user
  for when they report an error;
- on every log line written during that request or job, as `correlationId`;
- on every audit event recorded during it, in the `correlationId` column, and
  searchable with `GET /api/admin/audit?correlation=<id>`;
- carried through pg-boss job payloads (under `_syntraTrace`, stripped before
  a handler sees the payload), so work a request queues — and work *that*
  job queues — shares the id. An HR import, the provisioning run it causes
  and the connector calls that run makes are one id end to end.

A job with no originating request (a cron-scheduled sync or import) starts a
fresh id. With tracing on, the correlation id **is** the trace id, so an id
from an audit event or a log line pastes straight into the tracing backend.

The audit column is a join key, not evidence: it is outside the hash chain
(so every chain written before it existed still verifies), immutable after
insert like the rest of the row, and held to the 32-hex format by a database
constraint. With tracing on, a caller may choose its own trace id by sending
`traceparent` — standard behaviour, and harmless for a join key; with tracing
off the id is always minted by the server.

### Following one import through

1. Take the `x-correlation-id` from the response that started it, or the
   `correlationId` of its `person_import.*` audit event.
2. `GET /api/admin/audit?correlation=<id>` lists every audit event of the
   import, the provisioning run it enqueued and that run's actions.
3. `grep '"correlationId":"<id>"'` over the logs shows the same work,
   including errors that were logged but not audited.
4. With tracing on, search the trace id in the backend: the request span,
   `job personSource.run`, `job provision.person` or `job provision.run`,
   `connector.<type>.<method>`
   and `HTTP POST` spans form one tree.

### What is traced (when enabled)

| Span | Carries |
|---|---|
| `METHOD /route/:pattern` (server) | method, route **pattern**, status, tenant id |
| `job <queue>` (consumer) | queue, job id, retry count, tenant id; parent is whatever enqueued it |
| `connector.<type>.<method>` (client) | connector family and operation, records read for a streaming read |
| `HTTP <METHOD>` (client, every `guardedFetch` call) | method, scheme, host, port, status |
| `prisma:*` (only with `SYNTRA_OTEL_DATABASE=true`) | model, operation, parameterised SQL |

Never on a span: URLs' paths or queries (a SCIM filter or a Graph path names
the person), headers, bodies, client addresses, user agents, connector
arguments (configs carry credentials, records carry people), or raw exception
messages and stacks. A failure is recorded as its type, its code and a
scrubbed message; `recordException` is not used. `traceparent` is **not**
forwarded to connector targets — they are third parties, and the span tree
already provides the correlation. pg-boss's own polling queries and raw `pg`
calls are not traced.

### What logs never contain

One logger configuration serves the API and every background job
(`apps/api/src/logging.ts`), and one rule set
(`packages/connectors/src/observability/redact.ts`) decides what is a secret
and what is personal, for logs and span attributes alike:

- **Errors** keep type, code, status, a scrubbed message and stack, and the
  cause chain. The request an HTTP client error carries (`config`,
  `request`, `response`) is reduced to method, URL without query, and status
  — so `Authorization`, cookies and request bodies never reach the output.
- **Secret keys** — passwords, tokens, cookies, authorization headers, client
  secrets, private keys, SAML assertions, vault plaintext, TOTP secrets,
  recovery codes — are replaced wherever they appear, whatever the casing.
- **Personal keys** — email, names, UPN, phone, DN, employee id, account
  names, whole person records and attribute bags — are replaced too.
- **Free text** is scrubbed of bearer tokens, JWTs, PEM blocks, SAML XML, URL
  credentials, query strings, `password=`-style pairs, DN values and email
  addresses.
- **Size** is bounded: depth 6, 50 entries per object or array, 1,000
  characters per string (4,000 for a stack).

Kept deliberately: tenant ids and other UUIDs (an incident cannot be scoped
without them), hosts and ports, error codes, and the client address on
request log lines — it is the evidence a credential-stuffing investigation
starts from, and the audit log records it for the same reason. Log retention
is therefore the deployment's personal-data retention for client addresses;
set it accordingly.

Metrics labels carry no redaction pass at all, so their safety is
structural: a closed set of label names (`method`, `route`, `status`,
`kind`, `quantile`, `target_type`, `action`, `outcome`, `version`), each
holding a bounded vocabulary, enforced by a test that fails when a new label
appears.

## What a session records about a person

A session row carries the address it was established from and the browser's
`User-Agent`, so a person reading **Where you are signed in** on their security
page — or an administrator reading **Sessions** on an account — can tell one
session from another. A list nobody can read is a list that gets revoked
wholesale instead of precisely, which is the outcome the columns exist to
avoid.

Three things are worth knowing about that data:

- **Nothing reads it to make a decision.** A session is never refused for
  having moved address or changed browser. Both fields are descriptive, which
  is also why it is safe that both are attacker-influenced.
- **It ages out with the session.** There is no separate retention schedule:
  the columns live and die with the row they are on, and a session's row is
  what expiry and revocation act on.
- **Revoking marks the row revoked; it does not delete it.** That is the same
  rule as everything below, applied to sessions — the record of a session
  having existed and having been ended is the evidence an offboarding actually
  happened.

Sessions predating the upgrade that added these columns have neither, and show
as unknown. They were not backfilled, because a backfill would have had to
invent the values.

## Finding machine credentials nobody uses

Every API token records when it was last used. `Sessions → the account → API
tokens` shows it, and a token that has never been used says so.

That column exists because a credential nobody can tell is unused is a
credential nobody ever revokes. The integration that was decommissioned two
years ago still has a working token, and the only way anybody finds it is by
being able to see that nothing has presented it since.

Two things to know when clearing them out:

- **Revoking the service account's role revokes every token it issued**, at
  once. Offboarding an integration is one act, not a hunt through its
  credentials.
- **A token that never expires is a choice somebody made**, not a default. The
  console suggests ninety days. Long-lived tokens are legitimate — an
  integration nobody is staffed to rotate is worse broken than long-lived — but
  they should be deliberate, and the list marks them so they can be reviewed as
  a set.

`api_token.issued`, `api_token.revoked` and `auth.token_denied` are in the
**Credentials** webhook group, so an endpoint subscribed to it learns when a
machine credential is minted without anybody wiring that up separately.

## Deactivate, never delete

There is no Delete anywhere in the directory, and that is a design decision
rather than an omission. Deleting a group revokes access from everybody in it
and takes the record of who had what with it; deleting a user destroys the
trail of what they held; deleting an org unit does both and orphans any
administrative role scoped to it. A deactivated row is still listed, still
shows its members, still says why it was deactivated and who did it — and
grants nothing. Reactivating puts back exactly what was there, because nothing
was thrown away.

**Grants nothing** is the part that has to be true in the code, not only in
the copy. A deactivated group is left out of the applications a user resolves
to and out of the group names asserted into SAML assertions and OIDC tokens;
a deactivated org unit stops granting the applications assigned to it and
stops any administrative role scoped to it from carrying authority.
Deactivation without that is a control that reports success and revokes
nothing.

Two deliberate exceptions:

- **The policy engine still sees every group, deactivated or not.** A rule
  can deny or demand a second factor, not only allow. Dropping a deactivated
  group there would stop those rules matching, so deactivating a group would
  quietly *remove* a restriction — the opposite of what the word means.
- **A deactivated unit does not cut off the units above it.** Somebody in a
  closed department is still under the division that contains it, and an
  assignment made there was never deactivated. Its children are untouched for
  the same reason, and because a cascade could not be undone by reactivating
  the parent.

And one deliberate exception to the rule itself:

- **A whole tenant can be erased.** A customer who leaves is owed the
  opposite of a deactivation: their data gone, and proof that it went. That
  is the one path in the product that deletes directory objects wholesale,
  and it is built to be hard to reach — see [Tenant deletion](#tenant-deletion).
  Nothing inside a tenant that is staying gains a Delete from it.

Rows owned by a directory source cannot be deactivated or edited here at all.
The next sync run reads them as present and puts them back, so the console
says who owns them rather than offering a control that silently reverts.

Deactivation is also the one place policy changes are immediate rather than
waiting for a session to expire — a user's status is re-read on every
request, so deactivating an account, from the console or from a directory
sync, ends every session it holds at once. Everything else about policy
timing is in [Configure, "What this slice does not do"](configure.md#what-this-slice-does-not-do).

## Tenant deletion

**Settings → Offboarding**, `tenant.manage` only, in this order — the server
refuses any step taken out of it:

1. **Assess.** A read-only preflight: record counts, active legal holds,
   unresolved lifecycle operations, and the tenant's *data revision* — a
   SHA-256 over exactly what an export contains. The result is digest-bound
   and stored as a permanent audit receipt.
2. **Export.** The portable JSON artifact (no credential material). Its
   digest covers the file as downloaded, timestamps included, so it can be
   recomputed from the file; its receipt records the same data revision.
3. **Request.** Names the assessment and the export by digest, with a reason
   of at least 20 characters. Refused if the assessment reported blockers, if
   a legal hold is active or lifecycle work unresolved *now*, if the export was
   not taken after the assessment, or if the tenant's data no longer hashes to
   the revision both recorded — somebody edited a person, a group, a mapping,
   so the export is no longer a complete copy. Reassess and export again. One
   open request per tenant.
4. **Approve.** A *different* administrator — the database rejects an
   approval by the requester, whatever the code above it does — from an
   administrative session minted in the last 10 minutes (sign in again to
   step up; the tenant's MFA-for-administration rule applies to that sign-in).
   Within 72 hours of the request, or the request expires. The checks in
   step 3 run again.
5. **Cooling off, 24 hours.** Long enough for somebody who did not know — the
   customer's contact, a colleague watching the audit feed — to see the
   approval and cancel it. Anyone with `tenant.manage` can cancel an open
   request, the requester included; stopping needs no second pair of eyes.
6. **Execute.** Within seven days after cooling off, from a fresh session,
   typing `DELETE`. Every check runs a third time inside the same transaction
   that erases, so nothing can change between the last check and the first
   DELETE. A request whose data went stale is *invalidated* and one past its
   window *expired*; neither can be revived.

Machine tokens are refused on every route of this flow. Every refusal is
itself an audit event.

### What execution does

In one transaction, holding the tenant's binding lock **exclusively** — it
waits for every transaction already working in the tenant and holds off every
new one; afterwards they find the tombstone and are refused
(`TenantRetiredError`):

- **Crypto-erases the vault.** Each secret's wrapped data key, nonce, tag and
  ciphertext are overwritten with random bytes, then the row is deleted.
- **Removes the tenant's pg-boss schedules and queued jobs**, whose payloads
  name the tenant. A job already running is refused at binding and finishes
  quietly rather than retrying.
- **Deletes every row in every table with a `tenantId`**, children before
  parents. The table list and order are read from the database catalog at
  execution time, so a table added later is erased without anybody updating a
  list. The two append-only decision tables (`ApprovalDecision`,
  `CampaignDecision`) have their no-delete rules disabled inside the
  transaction and re-enabled before it commits; while it runs, every tenant's
  approval and review decisions wait on that lock.
- **Leaves a tombstone.** The `Tenant` row keeps its id (so it is never
  reused), becomes `Deleted tenant` / `deleted-<id>`, status `deleted`, with
  its hostnames released and branding removed. It no longer resolves.
- **Returns the receipt**: tenant id, request id, assessment and export
  digests, data revision, requester, approver and executor ids, timestamps,
  per-table row counts, secrets erased, schedules and jobs removed. No names,
  no addresses, no reason text. Download it from the console at once: the
  tenant no longer serves the page that showed it.

### What is retained, and why

| Kept | Why |
| --- | --- |
| `Tenant` tombstone | Holds the id against reuse; the rows below reference it. |
| The completed `TenantDeletionRequest` | It *is* the receipt. Its `reason` is cleared on completion; earlier cancelled or expired requests are erased. |
| `AuditEvent`, `AuditCheckpoint`, `AuditChainCheck`, `AuditAnchor` | The audit record. |

The audit record is kept on purpose, and consistently with retention.
`audit_no_delete` makes audit events immutable to the application, and the
retention job only ever *counts* eligible events: they leave through the
database-owner archive-and-prune procedure, at or before a verified
checkpoint, once the tenant's audit retention period ends. Tenant deletion
follows that rule instead of inventing a second way to delete audit history —
an application path that could erase a tenant's audit log is the first thing
an intruder holding the application's credentials would use. The completion
event is the last link in the tenant's chain, which still verifies. Audit
payloads can name people (a login in an event, the request's reason), so the
retained record is personal data until that archive-and-prune runs: set the
audit retention period to what your obligations require and run the procedure
for deleted tenants when it elapses. An operator can read the stored receipt
with `readTenantDeletionReceipt(tenantId)`.

### Deleted tenants and backups

Erasure reaches the live database only. Every backup taken before it still
holds the tenant in full, including wrapped data keys that `MASTER_KEY` can
still open. The residual exposure therefore ends when the **last backup taken
before the deletion expires**: with the default `SYNTRA_BACKUP_KEEP=7` daily
backups that is seven days, plus however long your off-host copies are kept —
that retention, not this tool's, is usually the binding one. Record the
completion date against your backup register and confirm the off-host copies
age out.

**Restoring a backup older than a deletion brings the tenant back**, active,
with its data. Before putting such a restore into service, check the receipts
of deletions completed after the backup was taken and run the deletion again
for each tenant (the full assess → export → request → approve → execute path;
the restored tenant has no record of the earlier one). Keep the downloaded
receipts outside the backup set so they survive the restore that needs them.

## Cancelling a long-running run

Directory sync runs, HR person imports and provisioning runs can be stopped
from their run pages with **Cancel run**, which asks for confirmation first.
The API is `POST /api/admin/sync-runs/:id/cancel`,
`POST /api/admin/person-import-runs/:id/cancel` and
`POST /api/admin/targets/:id/runs/:runId/cancel`, each with an empty JSON
body. They need the same permission that applies the run —
`sync.manage` for the first two, `provision.manage` for provisioning — and
every request writes an audit event (`sync.run.cancel`,
`person_import.run.cancel`, `provision.run.cancel`) naming who asked, from
where, and what the run was doing at the time.

Cancellation is **cooperative**. Nothing kills a worker. The request is
recorded on the run (`cancelState: requested`) and the worker reads it at
checkpoints of its own: every 500 records of a directory or file read, after
each read of a target, immediately before a plan is written, and before each
item of an apply. An apply therefore stops *between* two items — for
provisioning, never between an action's `in_flight` marker and the target's
answer — so the run it leaves is an honest partial state:

- items already applied stay applied, with their audit events;
- items it did not reach are marked with the reason (`skipped` for sync and HR
  changes, `superseded` for provisioning actions, message *not applied: the
  run was cancelled*), and a revocation order a provisioning action was
  carrying is re-opened so the next run proposes it again;
- the run's status is `cancelled` and `cancelState` is `cancelled`; an
  `*.run.cancelled` audit event records the phase and the counts, with the
  requester as actor.

What happens depends on what the run was doing:

| Run was | Result |
| --- | --- |
| `queued`, or `previewed` / `blocked` / `partially_applied` (waiting for a person) | Cancelled at once. Nothing was working on it. A queued job that is later picked up does nothing. An HR run waiting on duplicate review has those reviews closed as `run_cancelled`. |
| `running` (reading or planning) | Request recorded; the next checkpoint stops it with **no plan written**, exactly as a failed preview writes none. |
| `applying` | Request recorded; the next checkpoint stops it between items. |
| finished (`applied`, `failed`, `cancelled`...) | Refused with `409 run-not-cancellable`. |

A run that finishes before any checkpoint sees the request ends normally and
records the request as `moot`, so "I pressed cancel and it applied anyway" has
an answer on the run itself. A cancelled run cannot be applied
(`409 run-not-appliable`); start a new run, which re-proposes whatever is still
needed.

Two operational notes:

- **Directory sync and HR imports now show `applying`** while an apply is in
  progress. It is a progress marker, not a lock: these two subsystems have no
  heartbeat, so if the API process dies mid-apply the run stays `applying`.
  Pressing **Apply** again resumes it (as it resumed a `previewed` run
  before), and if a cancellation was waiting, that apply honours it before
  touching anything.
- **Provisioning runs abandoned by a dead process** are adopted by the next run
  as before; if a cancellation was waiting on one, adoption records it as
  `cancelled` rather than `failed` or `partially_applied`, after resolving any
  `in_flight` actions against the target.

## Exports

Bulk copies of tenant data leave through one service. An export is requested,
generated by a background job, sealed at rest, watermarked, downloaded by the
person who asked for it, and then erased. The console shows every export under
**Activity → Exports** (`/admin/exports` redirects there), and the requests are
made from the screens that hold the data: **Export these results** on the
audit search, **Export as CSV** on a Governance access report.

| Kind | What it is | Needs | Format |
| --- | --- | --- | --- |
| `audit_log` | The audit log, filtered exactly as the search is. | `audit.read` | JSON Lines |
| `govern_access` | "Who has access to this system", limited to the requester's Govern org-unit scope. | `govern.read` (any scope) and `govern.export` | CSV |

The API is `POST /api/admin/exports` (`{ kind, params, ttlHours }`, answering
`202` with the export row), `GET /api/admin/exports` (your own;
`?scope=all` for `tenant.manage`), `GET /api/admin/exports/:id`,
`GET /api/admin/exports/:id/download` and `POST /api/admin/exports/:id/revoke`.
`POST /api/admin/govern/exports/csv` still exists with the same body and
guard; it now queues a `govern_access` export and answers `202` instead of
returning the CSV inline. A machine token needs every permission of the kind
among its own scopes, as on every other route.

What each step checks:

- **Request.** The requester's authority for the kind. A refusal is audited
  (`export.request`, outcome `failure`); an accepted request is audited with
  its filters and lifetime.
- **Generation** (`exports.generate` job). The authority is checked again, as
  it stands when the job runs, so a role removed while the job waited stops the
  export (`export.fail`, reason `forbidden`). A `govern_access` export is
  filtered to the requester's scope at this moment. The audit log is read in
  keyset batches of 1,000 and stops at the log's head as it stood when
  generation began. Every file carries a watermark — export id, tenant, the
  requesting user and the generation time — as the first JSON Lines record, or
  as the leading columns of every CSV row so it survives sorting and pasting.
  An audit export ends with a record carrying the event count, so a truncated
  file is recognisable. The SHA-256 of the plaintext is recorded; the file is
  sealed with the vault's envelope scheme (a fresh AES-256-GCM data key wrapped
  by `MASTER_KEY`) and stored in the `DataExport` row. Nothing is written to
  disk. A file over **64 MiB** fails with a message asking for narrower filters
  rather than being truncated.
- **Download.** Only the requester, only while `ready` and unexpired, only if
  they still hold the permission, and only if their authority is the one the
  file was generated under — a Govern export made for one department is refused
  (`403 export-authority-changed`) to somebody whose scope has since changed,
  either way. The digest is verified after decryption and sent as
  `x-syntra-export-sha256`, with `cache-control: no-store`. Every download and
  every refusal is audited (`export.download`).
- **Expiry.** 24 hours after the file is ready by default; a request may ask
  for 1–72 hours, and the database refuses anything else. A download past the
  expiry is refused at once (`410`); the `exports.sweep` job, every 15 minutes
  per tenant, erases the ciphertext and records `export.expire`. It also fails
  an export no worker finished within two hours.
- **Revocation.** The requester, or anybody holding `tenant.manage`, can revoke
  a queued, running or ready export. The ciphertext is erased in the same
  transaction and a revoked job never stores what it built (`export.revoke`).

The `DataExport` row outlives its file — with the digest, row count, size,
download count and who revoked it — as the record of who took what. A database
constraint refuses a failed, revoked or expired row that still holds
ciphertext, and a ready row without every part a download needs.

Two operational notes:

- **Master-key rotation** re-wraps the vault's `Secret` rows only. An export
  sealed before a rotation cannot be opened afterwards; it expires within its
  72-hour bound. Request it again after rotating.
- **Kept synchronous, and why.** The tenant offboarding export
  (`POST /tenant/offboarding/export`) stays inline: it is bound to the
  deletion flow's data-revision digest and returned once to a `tenant.manage`
  holder who must keep it outside the system. Evidence bundles
  (`GET /govern/evidence/:id`) are rebuilt from their recorded range and are
  the signed artifact itself. `GET /audit` is bounded at 200 events a page.

## Audit search

`GET /api/admin/audit` filters on the server: `actor` (user id), `action`
(a prefix — `auth.` is every authentication event), `target` (target id),
`targetType`, `outcome`, `from` (inclusive) and `to` (exclusive), and
`subject` (repeatable; done by or to any of the ids). Pages are at most 200
events, newest first, and are keyset-paged on the chain's own `sequence`:
the response's `nextBefore` is the `before` of the next page, or `null` when
there is none. There is no total, deliberately — counting a log that grows for
ever is the cost this avoids. The audit log records no correlation or request
id, so there is no filter for one; the subject filter follows a person or an
object through everything done by it and to it.

Saved searches (`GET`/`PUT /api/admin/audit/views`,
`DELETE /api/admin/audit/views/:id`) are filters only, private to the
administrator who saved them, at most 50 each; opening one re-runs the search
under the reader's current authority. **Export these results** hands the same
filters to an `audit_log` export.

Every filter has an index that leads with the tenant and ends with `sequence`
(migration `20261030120000_data_exports_audit_search`), and a time window is
resolved to the sequence range it covers. `recordEvent` now never records an
event earlier than the one before it, so time and sequence move together even
across API replicas whose clocks disagree; events recorded before this release
by such a deployment may sit a few milliseconds out of order at a window's
edge. The migration builds its four `AuditEvent` indexes with plain
`CREATE INDEX`, which blocks audited writes while each builds. On a very large
log, create them first with `CREATE INDEX CONCURRENTLY IF NOT EXISTS` under the
same names (see the migration file); the migration then skips them.

The query plans at 100,000 events are asserted by
`packages/core/src/audit/audit-search.test.ts` on every run; see
[Scale validation](runbooks/scale-validation.md) for the recorded figures.

A known limit: every page still carries a full chain verification
(`verifyChain`), which reads the tenant's whole log. The search itself is
bounded; that check is not, and on a log of millions of events it is what a
page's latency is made of. Moving the page onto the checkpointed, incremental
verification Govern already runs nightly is the follow-up.

## Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request. Its two main
jobs are the unit and integration suite, against a real PostgreSQL, OpenLDAP
and Samba domain controller, and the browser suite, against a running, seeded
stack. Two smaller jobs also run:

- `docker build` builds both images.
- `helm chart` runs `helm lint --strict` and `helm template` over
  `deploy/helm/syntra/ci/*.yaml` and validates the output with kubeconform.
  It also checks that the chart refuses to render without a Secret, that the
  backup script parses, and that the chart's copy of the alert rules matches
  `ops/prometheus-alerts.yml`.

Both bring the infrastructure up with `infra/docker-compose.yml` rather than
GitHub's `services:`. The OpenLDAP container needs its bootstrap LDIF and TLS
settings and the Samba container needs a domain provisioned; both are already
expressed in that file, and a second, drifting copy of it in YAML is how CI
starts testing something the developers do not run.

**A known flake, fixed by capping the worker count.** Too many vitest workers
against one PostgreSQL server made a handful of `resetDatabase()` hooks time
out at 30 seconds and take their files with them — `testWorkerCount()`'s old
`cores - 1` default put seven workers on an eight-core box, and that
oversubscribed the server badly enough to crash a backend roughly one run in
two. The fix is fewer workers, forced through `SYNTRA_TEST_WORKERS`: four on
an eight-core machine (0 crashes, 0 hook timeouts across three measured runs),
two in this job specifically, because GitHub's standard runner is two vCPUs
and four workers there trips a separate, hardcoded 60-second vitest RPC
heartbeat timeout, unrelated to `hookTimeout`. The arithmetic, the RPC timeout,
and why the number differs between a workstation and this runner are written
up in `docs/superpowers/specs/2026-08-15-directory-sync-known-gaps.md`.

## Tests

```bash
pnpm test                       # domain, API and database integration tests
pnpm test:watch                 # the same suite, watching
pnpm --filter @syntra/web test  # web component tests
pnpm e2e                        # browser tests against a running stack
pnpm typecheck                  # tsc -b, no emit
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

### The tenant-isolation probe

`apps/api/src/tenant-isolation/` is a generated, exhaustive cross-tenant test.
Run it on its own with:

```bash
SYNTRA_TEST_WORKERS=2 pnpm exec vitest run apps/api/src/tenant-isolation
```

It seeds two tenants with one real row of every major kind of object
(`world.ts`: users, groups, org units, people, contracts, applications,
sources, runs, targets, roles, tokens, webhooks, exports, campaigns, SoD
rules, Automate requests and more, 55 kinds in all). It then acts as tenant
A's administrator, with every permission, an elevated session and a machine
token for SCIM, and walks the running route table (`app.routeCatalog`):

- **Every route that takes an object id** is called with tenant B's ids. The
  route's parameters are resolved to kinds of object by `PARAM_KINDS` in
  `probe.ts`. Routes with several parameters are also called with one foreign
  parameter at a time and A's own ids for the rest. The answer must be a
  refusal (403 or 404, or a 400/409/422 that the route reached after looking).
  It must also be the same status as a "ghost" call with ids that never
  existed, so that the answer cannot tell anyone whether an id exists in
  another tenant. The routes allowed to answer an absent parent with an empty
  success are listed in `ABSENT_IS_EMPTY`. Each still has to give exactly the
  ghost's answer.
- **Every id-shaped body and query field** is pointed at B. Request bodies
  are generated from the published OpenAPI schemas, sent with the optional id
  fields and again without them. The portal and SCIM routes have no published
  schema, so `BODY_OVERRIDES` provides theirs.
- **Every list route** is called bare and with its id filters set to B's ids.
- **Every background job** the production scheduler registers is run with A's
  tenant and B's ids in its payload.

After every call, the response must not contain B's tag or any B id that the
request did not itself carry. After every write, B's rows must be
byte-for-byte what they were (a per-table digest taken as B). A refused write
must not have changed A's rows either (audit, session and token timestamps
excepted). No row of A may hold one of B's ids in any id, text or array
column. That last check is the one row-level security cannot give on its own:
PostgreSQL checks a foreign key without applying RLS to the referenced table,
so A's row can point at B's unless the code looked the id up first.

Structural tests fail when a route is added that the probe cannot classify:
a path parameter with no `PARAM_KINDS` entry, or a parameterless write whose
body has no id field and that is not listed in `NO_ID_INPUT` with a reason.
They also fail for a job queue without a tenant-B payload, and for any
allow-list entry that no longer names a registered route. Set
`PROBE_LOG=<file>` to get every call and its status, for example to see which
body probes validation stopped before the lookup. A run takes about 40
seconds.

### Provisioning integration tests need a privileged Docker host

The Active Directory target connector is tested against a real Samba domain
controller (`nowsci/samba-domain:20260801025201`, pinned). That container
**must** run with `--privileged`: Samba's provisioning sets NT ACLs on the
sysvol filesystem and exits 255 without it. This is true for a self-hosted
runner and for GitHub Actions' standard Linux runners; it is **not**
guaranteed on more locked-down or sandboxed CI.

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

### SFTP source integration test

The HR feed connector is unit-tested against a string for everything except
one property a fake cannot demonstrate: that a pinned host key which does not
match refuses the connection. That one property is checked against a real
server, skipped unless asked for:

```bash
pnpm sftp:up && pnpm sftp:wait
SFTP_INTEGRATION=1 pnpm vitest run packages/connectors/src/person/sftp
```

`pnpm db:up` already starts this container along with everything else in
`infra/docker-compose.yml`; `sftp:up` exists to bring up only this one, and
`sftp:wait` polls the port so the test does not race the container's start.
`SFTP_PORT` overrides the port the test connects to if 2222 is taken.

## Troubleshooting

**"Environment variable not found: DATABASE_URL" during `db:migrate`.**
Prisma's CLI reads `.env` from its own working directory, and pnpm runs
`migrate` with the cwd set to `packages/db`, so the root `.env` is not in
scope for it. Copy both env files: `cp .env.example .env` and
`cp packages/db/.env.example packages/db/.env`.

**"@prisma/client did not initialize yet".** Run `pnpm db:generate` before
`pnpm db:migrate`. `db:migrate` runs Prisma's CLI, which needs no generated
client, so it succeeds and the failure only shows up at the next step. The
client is not generated by `pnpm install` either — the postinstall cannot
find this workspace's schema from the root.

**A newer pnpm than the pinned version silently skips build scripts.**
pnpm is pinned by `packageManager` in `package.json`; `corepack enable`
selects it. A newer pnpm silently skips the build scripts for Prisma and
argon2, and the install looks clean until nothing can reach the database.

**`pnpm db:reset` refuses to run.** It empties whichever database
`DATABASE_URL` names, and refuses anything that is not a scratch
`syntra_test_*` database unless you name the one you mean with
`SYNTRA_ALLOW_RESET` — the development database and the lab's are both called
`syntra`, and nothing about the connection string tells them apart:
`SYNTRA_ALLOW_RESET=syntra pnpm db:reset && pnpm seed`.

**Suite hook timeouts / fsync-bound test runs.** See
[Continuous integration](#continuous-integration) above for the vitest worker
count issue (`SYNTRA_TEST_WORKERS`) and its two different correct values on a
workstation versus a two-vCPU CI runner.

## Runbooks

Step-by-step procedures for the situations this page describes, written
against the scripts and routes in this repository, live under
[`docs/runbooks/`](runbooks/README.md):

- [Backup and restore](runbooks/backup-and-restore.md) — the `syntra-backup`
  procedures, a restore rehearsal in isolation, and a before/after
  reconciliation checklist.
- [Master-key recovery](runbooks/master-key-recovery.md) — a wrong or lost
  `MASTER_KEY`, the fingerprint refusal, and the full list of secrets that
  would have to be re-entered.
- [Database migration](runbooks/database-migration.md) — the release layout,
  compose and Helm paths, the migration-name floor, and rollback by restore.
- [Secret rotation](runbooks/secret-rotation.md) — every rotatable secret and
  what rotating it does to sessions and integrations.
- [Incident response](runbooks/incident-response.md) — severity, the first
  fifteen minutes, evidence capture, and which alert leads where.
- [Target rollback](runbooks/target-rollback.md) — stopping a target, blocked
  and partial runs, reverting a mover, and what cannot be undone.
- [Tabletop exercises](runbooks/tabletop-exercises.md) — four rehearsed
  incidents with scorecards.

## Further reading

- [Install](install.md) — development and container installs, TLS.
- [Configuration](configure.md) — every environment variable, directory
  sources, SSO and federation configuration.
- [docs/lab/README.md](lab/README.md) — the update workflow in full, and a
  complete worked lab build.
