# Operating Syntra

Upgrades, backups, monitoring, what "delete" actually means in this product,
the day-to-day work that waits for a person, and the runbooks for when
something goes wrong — plus how the test suite and CI are put together.

**Contents**

1. **Running it** — [Upgrades](#upgrades), [Backups](#backups),
   [Kubernetes and high availability](#kubernetes-and-high-availability)
2. **Watching it** — [Metrics](#metrics), [Observability](#observability),
   [Status reporting](#status-reporting)
3. **What it keeps and what it deletes** —
   [What a session records](#what-a-session-records-about-a-person),
   [Machine credentials](#finding-machine-credentials-nobody-uses),
   [Deactivate, never delete](#deactivate-never-delete),
   [Tenant deletion](#tenant-deletion),
   [Data-subject requests](#data-subject-requests)
4. **Day-to-day work** — [Cancelling a run](#cancelling-a-long-running-run),
   [Work held for review](#work-held-for-review),
   [Incidents](#what-is-broken-incidents),
   [Background work](#background-work-and-job-health),
   [Exports](#exports), [Audit search](#audit-search)
5. **Building and testing** — [Continuous integration](#continuous-integration),
   [Tests](#tests), [Troubleshooting](#troubleshooting)
6. **[Active Directory in practice](#active-directory-in-practice)** — the
   host, the domain and the traps met when running against a real domain
7. **[Runbooks](#runbooks)** — the on-call quick reference, then one
   procedure per situation: [incident response](#runbook-incident-response),
   [backup and restore](#runbook-backup-and-restore),
   [master-key recovery](#runbook-master-key-recovery),
   [database migration](#runbook-database-migration),
   [secret rotation](#runbook-secret-rotation),
   [target rollback](#runbook-target-rollback),
   [queue recovery](#runbook-queue-recovery),
   [scale validation](#runbook-scale-validation),
   [tabletop exercises](#runbook-tabletop-exercises)

## Upgrades

Three deployment shapes exist, and each upgrades differently:

- **Release layout** — `/opt/syntra/current` (a symlink into
  `/opt/syntra/releases/<version>`), `/opt/syntra/shared/.env`, a `syntra`
  systemd unit, Postgres in a Docker container named by `PG_CONTAINER`.
  `syntra-update` and `syntra-backup` are written for this layout and only
  this layout.
- **Compose path** (`docker-compose.yml`, optionally `docker-compose.tls.yml`)
  — `postgres`, `api` and `web` services; the `api` image migrates before it
  starts; data in the `syntra-data` volume.
- **Helm** (`deploy/helm/syntra`) — `<release>-api` and `<release>-web`
  Deployments, a `<release>-migrate` pre-install/pre-upgrade Job, secrets in
  the Secret the values name.

For the container path, an upgrade is pulling a newer image: set
`SYNTRA_VERSION` to the release you want and re-run `docker compose up -d`
(see [Install](install.md#running-it-for-real-the-container-path)). For Helm,
set the new image tags and `helm upgrade`. Both are walked through, with their
rollbacks, in the [database migration runbook](#runbook-database-migration).
The rest of this section is the release layout.

### Why the updater is not an ordinary update button

Syntra is what you sign in with. An update that breaks authentication takes
away the console you would use to undo it, and the SSO it fronts goes with it.
Three things follow, and they are the whole design:

- **The updater is not part of Syntra.** `ops/syntra-update` runs as its own
  transient systemd unit (`systemd-run --unit=syntra-update`), from
  `/opt/syntra/bin`, not from a release. A child process of the API would be
  killed by the restart the update itself causes, between the migration and
  the symlink swap — the least recoverable state this system has.
- **The rollback needs nobody.** If the new version does not come up, the
  updater puts the old one back — code *and* database — on its own. "Sign in
  and click rollback" is exactly what a broken sign-in prevents.
- **What it checks can fail.** `/health` is a constant: it returns 200 with the
  database unreachable and the migration half-applied. `/health/ready` is the
  gate. Keep the reverse proxy and external liveness monitoring pointed at
  `/health` all the same: a liveness probe that fails when Postgres blips
  restarts a healthy API.

### One-time setup

1. **Convert to the release layout.** An install that runs from one directory
   has nothing to roll back *to* — the old files are the ones an update
   overwrites.

   ```bash
   ./ops/syntra-install --dry-run     # read what it will do
   ./ops/syntra-install
   ```

   It copies the checkout to `/opt/syntra/releases/dev`, moves `.env` into
   `/opt/syntra/shared/`, points `current` at the release, rewrites `WEB_ROOT`
   and the systemd unit's working directory to follow it, installs
   `syntra-update` and `syntra-backup` into `/opt/syntra/bin`, and installs
   the backup units (left disabled; see [Backups](#backups)). It expects an
   existing configured systemd install and refuses to run twice. **The old
   tree is left exactly where it is**, so recovery is restoring
   `syntra.service.pre-release-layout` and restarting.
2. **A release token.** A fine-grained GitHub token, **read-only**, scoped to
   the one repository, with `Contents: Read` and nothing else, in
   `/opt/syntra/shared/.env`:

   ```
   RELEASE_REPO=ssan9876/syntra
   RELEASE_TOKEN=github_pat_…
   RELEASE_ROOT=/opt/syntra
   ```

   Not a git credential: the host never gains the ability to read source
   history, only to download release assets. Revoke it from GitHub without
   touching the box. The variables (and `PG_CONTAINER`) are listed in
   [Configuration](configure.md#updating-from-the-console); all are optional,
   and an install that sets none of them simply has no update button.
3. **Take the converted tree to its first release**, once, by hand:
   `SYNTRA_RELEASE_TOKEN=… /opt/syntra/bin/syntra-update --adopt <version>`.
   A working tree reports itself as `dev` and the console will not update it.

**Cutting a release.** Nothing is updatable until something has been released:

```bash
git tag -a v1.5.0 -m "What changed, for the operator deciding whether to take it."
git push origin v1.5.0
```

The tag message becomes the notes an operator reads before deciding. **Tag a
commit that is on `main`:** the release workflow refuses any other. It reuses
`main`'s own green CI run for that exact commit when there is one, and runs
the whole suite when there is not (see
[Continuous integration](#continuous-integration)) — either way, a tag whose
tests fail produces no release.

### Updating

From the console, **Updates** (`/admin/updates`, `deployment.manage`; the API
is `POST /api/admin/update` and `POST /api/admin/update/rollback`) shows the
running version, what is available, and a button. The console cannot
downgrade. By hand:

```bash
/opt/syntra/bin/syntra-update --check        # what is running, what is available; changes nothing
/opt/syntra/bin/syntra-update 1.5.0          # update
/opt/syntra/bin/syntra-update --rollback     # go back deliberately
cat /opt/syntra/var/update.status            # what it is doing right now
```

What an update does, in order:

1. Downloads the release and checks its SHA-256.
2. Unpacks it beside the running one, installs its dependencies, generates the
   client.
3. **Dumps the database into `/opt/syntra/shared/backups/` — and stops if that
   fails.** Migrating without a backup is the one step that cannot be undone.
4. Applies migrations, swaps the `current` symlink, restarts.
5. Polls `/health/ready` for 90 seconds.
6. If it does not go green: stops the service, drops every non-system schema
   and restores the dump (so tables the new migration created do not
   survive), relinks the previous release, restarts, and writes `rolled_back`.
   If the restore itself leaves an empty database it writes `failed` and
   leaves the service **stopped**, with the dump's path in the message.

Signing in stops working for about a minute. Sessions already open survive.

Things worth knowing before you need them:

- **Anything written into `current` by hand is invisible to the updater**, and
  the next update overwrites it silently. Cut a release instead.
- **A rollback does not undo what happened during the update.** The dump is
  from just before the migration; a login or a sync run in the minute since is
  not in it.
- **Three releases and three dumps are kept.** The one you are running is
  never pruned. These dumps are the updater's, not your backup schedule.

**A refused update leaves the status alone.** `syntra-update` writes
`var/update.status`, which is what the console shows. Anything it refuses
before an update or rollback has started — a malformed version, a version not
newer than the running one, `--adopt` on a release (or a working tree without
it), a missing release token, no `DATABASE_URL`, another update already
running, a rollback with no previous release or no pre-migration dump — exits
non-zero with `REFUSED: …` on stderr and does **not** touch that file, so the
record of the last successful update survives a typo or a double click. Only a
failure after work has begun (download, checksum, install, dump, migration,
restart) writes `failed`.

The scripts are not tied to one host: `SYNTRA_ROOT` moves the release layout
away from `/opt/syntra`, `SYNTRA_SERVICE` names a unit other than `syntra`,
and `SYNTRA_RELEASE_REPO` names the GitHub repository whose releases they
download, for a fork that cuts its own. `ops/rehearsal/README.md` describes a
full rehearsal of the updater against a local release server, in its own root,
unit, port and database.

### Running under systemd

The single-process install (see
[Install](install.md#the-single-process-alternative-to-the-container-path))
runs as one systemd unit, and `ops/syntra-install` converts that unit rather
than writing one. It needs a `WorkingDirectory=` line and an
`--env-file-if-exists=` argument to repoint. A unit of the shape it expects:

```ini
# /etc/systemd/system/syntra.service
[Unit]
Description=Syntra
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service

[Service]
Type=exec
WorkingDirectory=/opt/syntra/current/apps/api
ExecStart=/usr/bin/env node --env-file-if-exists=/opt/syntra/shared/.env --import tsx src/server.ts
Restart=always
RestartSec=5
# The API drains HTTP, stops the scheduler and disconnects on SIGTERM.
KillSignal=SIGTERM
TimeoutStopSec=45
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
# The one place the API process writes: var/update.status, when the
# updater could not even be started.
ReadWritePaths=/opt/syntra/var

[Install]
WantedBy=multi-user.target
```

systemd follows the `current` symlink at every start, so a swap under it
needs no unit change.

**If Postgres runs in Docker on the same host, make the API wait for it.**
`infra/docker-compose.yml` is a development file with no restart policies, so
after a reboot nothing comes back unless a unit brings it up; and "the
container has started" is not "PostgreSQL is accepting connections". The API
tolerates a missing database by starting anyway with no jobs scheduled — a
quiet failure — so catch it in the unit. A oneshot `syntra-infra.service`
(`Type=oneshot`, `RemainAfterExit=yes`, `ExecStart=/usr/bin/docker compose -f
infra/docker-compose.yml up -d`) owns the containers, and a drop-in on the
API waits for the database:

```ini
# /etc/systemd/system/syntra.service.d/10-wait-for-postgres.conf
[Unit]
After=syntra-infra.service
Requires=syntra-infra.service

[Service]
ExecStartPre=/bin/sh -c 'for i in $(seq 1 60); do docker exec <PG_CONTAINER> pg_isready -U syntra -d syntra >/dev/null 2>&1 && exit 0; sleep 2; done; echo "postgres never became ready" >&2; exit 1'
```

A private CA for LDAPS goes in a second drop-in as
`Environment=NODE_EXTRA_CA_CERTS=…` — see
[Active Directory in practice](#the-host). Prove the arrangement with a reboot
rather than assuming it, and check the boot was clean:

```bash
systemctl reboot
journalctl -u syntra -b | grep -ciE "scheduler failed|ECONNREFUSED"   # expect 0
```

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
beyond that are pruned after each successful run). The step-by-step
procedures — taking one before a risky change, restoring, rehearsing a restore
in isolation, reconciling before and after, and the compose and Helm
equivalents — are the [backup and restore runbook](#runbook-backup-and-restore).

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
- **Prepared statements.** Syntra now runs Prisma 7 through its
  node-postgres driver adapter (`@prisma/adapter-pg`, wired in
  `packages/db/src/client.ts`). The adapter names a statement only when given
  a `statementNameGenerator`, and Syntra does not give it one, so queries go
  out as unnamed statements — the kind transaction pooling has always handled.
  The measurements below were taken against PgBouncer 1.25.2 in
  `pool_mode = transaction` under Prisma 6, whose query engine **did** name
  its statements, and have not been repeated under Prisma 7:
  - With `max_prepared_statements = 200` (the protocol-level prepared
    statement support added in PgBouncer 1.21), sign-in, the RLS-scoped
    reads, `/health/ready` and the pg-boss scheduler all worked unchanged.
  - With `max_prepared_statements = 0`, every tenant-scoped query failed
    with `prepared statement "s1" does not exist`, and `/health/ready`
    correctly returned 503.
  - With `max_prepared_statements = 0` and `?pgbouncer=true` added to
    `DATABASE_URL`, everything worked again.

  `pgbouncer=true` was a flag for Prisma 6's query engine; the driver adapter
  does not read it. The conservative setting is unchanged and costs nothing:
  on PgBouncer 1.21 or later, set `max_prepared_statements` above zero. If you
  run an older pooler, test sign-in and `/health/ready` through it before
  relying on it.
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
| Prisma | 10 — Prisma 7 pools through node-postgres, and that is its `Pool` default | `?connection_limit=N` in `DATABASE_URL`. Prisma 6 read this itself; `packages/db/src/client.ts` now strips it from the URL and hands it to node-postgres as `max`, so existing URLs keep working. Prisma 6's other pool parameters (`pool_timeout`) are not translated. |
| pg-boss | 10 (node-postgres `Pool` default; connections show `application_name = pgboss`) | not configurable today |

Set `connection_limit` explicitly all the same, so the number in your sizing
is the number in the URL. 10 is a sensible start for a 2-CPU pod.
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
| `syntra_http_request_duration_seconds` | Request latency, by method, route pattern and status |
| `syntra_build_info` | Which release is running |
| `syntra_readiness` | The same probe `/health/ready` runs, 1 or 0 |
| `syntra_scheduler_running` | 1 when the job scheduler is up (published only when the process wires one) |
| `syntra_jobs_pending` | pg-boss jobs in `created` or `retry`; absent if the scheduler has never run |
| `syntra_webhook_deliveries_pending` | Is the webhook sender keeping up? |
| `syntra_webhook_deliveries_abandoned` | Has any integration stopped being fed? |
| `syntra_logout_deliveries_pending` | Back-channel logouts still in flight |
| `syntra_logout_deliveries_abandoned` | **Offboardings a relying party was never told about** |
| `syntra_sessions_active` | Live sessions |
| `syntra_users_total{status}` | Accounts, active and inactive |
| `syntra_accounts_locked` | A lockout spike, before the tickets arrive |
| `syntra_lifecycle_operations_unresolved` | Lifecycle work still in progress or awaiting verification |
| `syntra_lifecycle_operations_failed` | Lifecycle work requiring recovery |
| `syntra_lifecycle_operations_overdue` | Unacknowledged lifecycle work past its due date |
| `syntra_lifecycle_operations_awaiting_approval` | Lifecycle work waiting for a second person |
| `syntra_lifecycle_operations_slo_breached` | Unresolved work past its service-level deadline |
| `syntra_lifecycle_oldest_unresolved_age_seconds` | Age of the oldest open operation; absent when none |
| `syntra_lifecycle_retry_rate` | Share of operations resolved in the last day that needed more than one attempt; absent when none resolved |
| `syntra_lifecycle_receipts_deferred` | Target operations stepping back from a saturated tenant (the concurrency cap) |
| `syntra_lifecycle_operation_duration_seconds{kind,quantile}` | p50 / p95 of operations resolved in the last day |
| `syntra_provision_actions_pending_retry` | Actions that exhausted their retries and wait for the next run (the dead-letter equivalent) |
| `syntra_provision_actions_failed_24h` | Actions failed permanently in the last day |
| `syntra_provision_runs_failed_24h` | Provisioning runs that failed in the last day |
| `syntra_targets_stale` | Enabled, scheduled targets that have not run in a day |
| `syntra_target_readiness_age_seconds` | Age of the oldest current connection test across targets; absent when none |
| `syntra_target_operation_duration_seconds{target_type,quantile}` | p50 / p95 of applied target operations, by connector type, never by target |
| `syntra_signing_key_expires_in_seconds` | The nearest signing key's expiry |
| `syntra_audit_events_total{action,outcome}` | Security events, by kind |
| `syntra_job_health_findings{kind,finding}` | Background work that is orphaned, stuck, duplicated, delayed, poisoned or deferred by saturation — see [Background work](#background-work-and-job-health) |
| `syntra_job_queue_readable` | 0 when the job queue cannot be read, so orphaned work cannot be detected |

**Four are worth alerting on before the rest.**
`syntra_logout_deliveries_abandoned` and `syntra_webhook_deliveries_abandoned`
above zero each mean something that was supposed to leave the building did not.
`syntra_signing_key_expires_in_seconds` earns its place because key rotation is
scheduled monthly and its failure is completely silent until every token stops
verifying at once. `syntra_readiness` at 0 is the process telling you it cannot
do its job.

`ops/prometheus-alerts.yml` is an installation-wide starter rule group (the
Helm chart carries a copy as its PrometheusRule, and CI fails if the two
differ). Load it into Prometheus and route its alerts to the operations
channel; every rule carries a `runbook` annotation, and the
[on-call quick reference](#on-call-quick-reference) says where each one leads.
The lifecycle rules intentionally name no tenant because metrics expose no
tenant labels. Use the authenticated **Employee work** queue to identify the
owner and record.

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
`kind`, `quantile`, `target_type`, `action`, `outcome`, `version`,
`finding`, and Prometheus's own `le`), each
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

Every API token records when it was last used. `Users → the account → API
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

Deactivation, not deletion, is how the directory takes access away, and that
is a design decision rather than an omission. Deleting a group revokes access from everybody in it
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
stops any administrative role scoped to it from carrying authority. A
deactivated person stops passing their org unit down to a linked login that
has none of its own, so an assignment on that unit no longer reaches the login
through them.
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

Deleting a single **account** or an **empty org unit** does exist, for a
directory that genuinely has to forget something, and it is gated three ways:
the `directory.delete` permission (separate from `directory.write`), the name
typed back in the console, and — for an object a directory source owns — the
source's *Deleting a user or org unit removes it from this directory*
write-back switch, without which it is refused (`409 delete-not-enabled`)
because the next sync would only create it again. The directory is written
first; Syntra's row goes only if that succeeded. An org unit is refused while
any account (active or not), child unit or assigned person is still in it.
**The person and the audit trail survive an account's deletion.** Groups and
people have no delete.

An **application** is not a directory object, and can be deleted: it is
configuration an administrator registered, and deleting it is the only way to
free a SAML entity ID or OIDC client ID for re-registration. Retire it first
(reversible, keeps everything); delete only to register it again or to remove
a mistake. Deletion needs a fresh step-up and the name typed back, is refused
while Automate still grants the application, revokes what was issued to it,
and never touches users, groups or the signing keys — see
[Configure, "Retiring and deleting an application"](configure.md#retiring-and-deleting-an-application).

A data-subject erasure is *not* a second exception. It rewrites one person's
identifying fields in place and leaves every directory row standing — see
[Data-subject requests](#data-subject-requests). The only rows it deletes
are credential material and transient protocol state.

Rows owned by a directory source cannot be edited here at all, and cannot be
deactivated here unless the source has write-back on with *Deactivating a user
disables their account here*. Otherwise the next sync run reads them as
present and puts them back, so the console says who owns them rather than
offering a control that silently reverts. With that switch on, Deactivate
disables the account in the directory first, then in Syntra (see
[What deactivating a directory-managed user does](#what-deactivating-a-directory-managed-user-does)).

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

## Data-subject requests

**Directory → Privacy requests** (`/admin/privacy`), `privacy.manage` on every
route. The permission is granted to built-in roles that already hold
`tenant.manage` when the migration runs; grant it to a privacy officer's role
from **Roles**. A person's page links to it (**Privacy request**) for anyone
holding it.

### The data inventory

[`packages/core/data-inventory.md`](../packages/core/data-inventory.md) lists every
column of every table, classified as `identity`, `contact`, `hr`,
`authentication`, `audit`, `operational` or not personal, with each area's
purpose, source, retention, access and a legal-basis **placeholder** for the
controller to confirm. It is generated from
`packages/core/src/privacy/inventory.ts` (`pnpm privacy:inventory`), and the
build fails when a Prisma model gains a column the inventory does not
classify, or when the document is stale. The search, the access bundle and the
erasure below all read that same inventory, so the document describes what
they actually do.

### A case

Open one per request: the person, what they asked for (access,
rectification, restriction, erasure — any combination), the request and how it
arrived, how the requester's identity was verified (method and a written
attestation: what was checked, by whom), when it was received, and a due date
— 30 days after receipt by default, at most 90 (the GDPR art. 12(3)
extension). The list shows open cases soonest due first and marks overdue
ones. Do not type the subject's personal data into the reason, attestation or
closure note: those are kept after an erasure as the evidence the request was
handled.

The case's **timeline is the audit log**: every act under it is an audit event
whose target is the case (`privacy.case.open`, `.search`, `.access_export`,
`.rectify`, `.restrict`, `.lift_restriction`, `privacy.erasure.request`,
`.cancel`, `.completed`, `privacy.case.close`), plus the export service's own
events for the bundles it queued. Refusals are recorded too, with the reason.

### Search and access

**Search** reads every table the inventory links to people — the person,
contracts, accounts, attributes, group and role memberships, sessions,
credentials (metadata only), target accounts and entitlements, placements,
lifecycle work, provisioning, sync and import history, access requests,
approvals and grants, Govern holdings and reviews, notifications, and the audit
events they performed or that are about them — and shows a page of rows per
table with the full count. The search itself is audited with the counts.

**Queue access bundle** asks the [export service](#exports) for a
`dsar_bundle`: one JSON document with a section per table, each carrying the
inventory's purpose, source, retention, legal basis and column categories
beside the rows. It is generated by the background job, watermarked with the
export, the case reference, the requester and the time, sealed at rest,
downloadable only by the requester from **Activity → Exports**, and erased on
expiry like every export. Columns the inventory marks secret — password,
token and recovery-code hashes, key material, sealed bytes — are never
included, and the bundle lists them as excluded.

### Rectification

There is no separate write path. **Rectify** on the case (or any client)
calls the ordinary `PATCH /api/admin/persons/:id` or
`PATCH /api/admin/persons/:id/contracts/:sequence` with `privacyCaseId`. The
edit needs its usual permission, and citing a case also needs
`privacy.manage`; the case must be open and about this person. The edit's own
audit event carries the case id, and the case records which fields changed
(never the values). A source-owned field is still refused: correct it at the
source.

### Restriction

**Restrict processing** sets `Person.processingRestrictedAt` (and the case
that placed it). While it is set:

| Writer | Withheld | Still applied |
| --- | --- | --- |
| Provisioning | `create_account`, `update_account`, `enable_account`, `rename_account`, `grant_entitlement`, `reactivate_syntra_user` — kept on the plan as `refused`, message naming the case | `disable_account`, `archive_account`, `revoke_entitlement`, `deactivate_syntra_user` |
| HR import | `update_person`, `reactivate_person`, `create_contract`, `update_contract` — marked `skipped`, message naming the case, audited `person_import.change_withheld` | `depart_person`, `end_contract` |
| Directory sync | `update_user`, `reactivate_user`, `add_member` — `skipped`, audited `sync.change_withheld` | `deactivate_user`, `remove_member` |

**A restriction never keeps access alive**: everything that narrows access
still runs. A skipped change is "not now" — the next run proposes it again,
and applies it once the restriction is lifted. Administrators can still edit
the person by hand (that is how rectification works). **Lift restriction**
clears it; an erased person cannot be lifted.

### Erasure

Refused, with every blocker named, while any of these holds:

- a **legal hold** is active on the person (`subjectType: person` —
  `POST /api/admin/lifecycle-legal-holds` now accepts it), on one of their
  lifecycle operations, or on one of their simulations;
- a lifecycle operation for them is **unresolved** (not completed, cancelled
  or rejected), or a provisioning action for them is **in flight** or waiting
  to retry;
- the person is **active** — deactivate them first: an erasure never
  replaces an offboarding;
- one of their Syntra accounts is active, or a target account is `pending`,
  `active` or `conflict`;
- an access grant for them is `pending`, `active` or `scheduled`;
- they have already been erased.

Then, **four eyes**: one administrator requests it (the case must record that
erasure was asked for; one pending erasure per person), and a *different*
administrator approves it from a session minted within the step-up window —
the database rejects an approver who is the requester, whatever the code
does. Approval re-checks every blocker **in the transaction that erases**.
Anyone with `privacy.manage` can cancel a pending erasure. Machine tokens are
refused on every erasure route.

What the erasure does, per the inventory (the per-column detail is in
[the data inventory](../packages/core/data-inventory.md#data-subject-erasure-at-a-glance)):

| Treatment | Tables | Why |
| --- | --- | --- |
| **Pseudonymised in place** — the row stays; identifying fields become `erased-<row id>`, `erased-<row id>@erased.invalid`, a fixed literal (`Erased` / `Person`, `Erased user`, `[erased]`), or are cleared | `Person`, `Contract` (job title, department, cost centre, employer, location, manager, FTE), `User` (login, email, display name), `UserAttribute` values, `Session` and `AuthAttempt` addresses and browsers, `UpstreamLink` subject, `SamlSsoSession` NameID, `TargetAccount` (generated login, last-written attributes), run history before/after values (`ProvisionAction`, `SyncChange`, `PersonImportChange`, `DriftFinding`), lifecycle inputs and evidence, receipts, duplicate-review matches, access-request justifications and form values, delegated-task values, exception messages, notifications (recipient and variables; unsent ones stopped), the decider's name on revocation orders | Deactivate, never delete: every reference to the person or their accounts still resolves, the history of what was done is intact, and none of it says who anybody was. Unique indexes (logins, correlation keys) still hold because each pseudonym contains its row id. |
| **Deleted** | Password credentials and history, TOTP (and its vault secret), WebAuthn credentials and challenges, email OTP, recovery codes, reset tokens, lockout state, OIDC protocol artifacts, authorization decisions, lifecycle observations and simulations, the person's saved audit searches | Credential material and transient state. A deactivated, erased account has no use for it, and none of it is a record of anything. |
| **Retained unchanged** | `AuditEvent` (and checkpoints), `ApprovalDecision`, `CampaignDecision`, group and role memberships, entitlements held, access grants, Govern snapshots and reviews, legal holds, API tokens, refresh tokens, the case itself | The audit log is immutable to the application and hash-chained; decisions are append-only at the database; the rest are identifiers that point at rows now pseudonymised. **Audit payloads can still name the person** — they leave through the database-owner archive-and-prune procedure when the tenant's `auditRetentionDays` elapse, exactly as for [a deleted tenant](#what-is-retained-and-why). |
| **Kept as a key, on purpose** | `Person.externalId`, `Contract.externalId`, `PersonSourceLink`, `User.sourceAnchor`, `TargetAccount.anchor` | An HR feed or directory that still holds the person recognises the row, and the permanent restriction refuses its changes, instead of re-creating them from scratch. Erase them in the source; the keys identify nobody without it. |

Also: any access bundle about the person that still holds a file has the file
erased and is marked revoked; the person keeps `erasedAt` and is restricted
permanently. The **receipt** — case, person id, requester, approver and
step-up time, per-table counts of rows pseudonymised, deleted and retained,
secrets deleted, bundles erased, and its own SHA-256 — is returned by the
approval, kept on the case (**Download receipt**), and recorded as
`privacy.erasure.completed`, with `person.erased` on the person.

**Outside Syntra.** Target systems keep their own copy of the account (Syntra
has no delete path to a target, by design): erase it there. Backups taken
before the erasure still hold the person until they expire, as for
[deleted tenants](#deleted-tenants-and-backups); restoring one brings the
person back, so re-run the erasure (the receipt lists what to expect).

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

## Work held for review

Some work stops on purpose and waits for a person. A banner at the top of
every console page names it, and **Activity → Attention** lists it under
*Waiting for a decision*, above what is broken:

- **Provisioning runs awaiting review** (`previewed` or `blocked`): the target,
  what the run would do and the guard's reason, with a link to the run
  (`/admin/targets/:id/runs/:runId`). What one holds up is described in
  [Runs that replace a waiting run](#runs-that-replace-a-waiting-run) below; a
  run **held for confirmation** stops everything on its target, so those are
  worth clearing promptly.
- **Held actions** in each target's latest finished run: a rename, a re-enable
  outside the window or the re-create of a vanished account that the run left
  unapplied because it needs a person's confirmation and nobody has approved
  it yet. They block nothing, which is why they are listed. See
  [Held actions and renames](#held-actions-and-renames).
- **Lifecycle operations** that failed, or whose target step waits on
  read-back verification (Employee work).
- **Privileged change requests** waiting for a second administrator, for
  administrators who could decide one.

The banner can be dismissed for the browser session; it comes back when
something new arrives. It polls every minute. The same data is
`GET /api/admin/attention/summary`: any signed-in administrator may call it,
and each section is present only when the caller holds the permission for what
it lists (`provision.read` for runs, held actions and lifecycle work; `tenant.manage`,
`rbac.manage` or `token.manage` for change requests).

## What is broken: incidents

Below the work held for review, **Activity → Attention** lists what has
stopped working: webhooks and mail that gave up, targets skipping or never
finishing their runs, provisioning and sync runs that failed this week,
failing delegated tasks and expired credentials. The same list feeds
**Needs you** on the Overview.

Each incident lists the failures behind it, newest first, up to ten: the
target, source, endpoint or credential by name, when, and the error it
recorded. Errors are put through the same scrubbing as the logs, so a stored
message never shows a credential, an email address, a DN or a long opaque
token. Each item links to the run or record it came from.

Two answers can be given to an incident, and both are in the audit log
(`incident.acknowledged`, `incident.resolved`):

- **Acknowledge** (`audit.read`) marks it as being handled, with an optional
  note. It hides nothing: the incident stays listed with who has it, and the
  acknowledgement lapses as soon as something newer fails.
- **Resolve** is offered only for *events* -- failed runs, undelivered
  webhooks or mail, failed delegated tasks -- and needs the management
  permission of the area (`provision.manage`, `sync.manage`, `tenant.manage`
  or `automate.manage`). It is a watermark: what happened up to now is dealt
  with, and the next failure brings the incident straight back. A *condition*
  (a target skipping its runs, an expired credential) cannot be resolved; it
  disappears when the cause is fixed.

The API is `GET /api/admin/incidents`, `POST /api/admin/incidents/:kind/acknowledge`
and `POST /api/admin/incidents/:kind/resolve`, each taking an optional
`{ "note": "…" }`.

**Operations → Background work** names the job behind each finding (for
example *Provisioning run · Local AD*) and shows its last error, scrubbed the
same way, instead of only its class.

### Safety thresholds

A run is held for confirmation when it would change more than a set share of
the target in one go: *would create 1 of 2 accounts (50.0%), above the 20%
threshold*. The run's page names the setting that held it and links to
**Safety thresholds** on the target's edit form: Accounts created, Accounts
disabled, Accounts archived (container moves use this one too), Entitlements
revoked, Syntra logins deactivated, Holders of any one entitlement, and Drop in
the person population. Either confirm the run, if the change is expected, or raise
the percentage when it is simply too low for a target that size: on a small
directory one new starter is a large share. Later runs are measured against
the new value; the held run keeps its verdict and still needs confirming or
superseding.

A run that **moves an OU** (see [Org units as OUs](#org-units-as-ous)) is
always held for a person, however small: *would move 1 container and every
account inside it*. OU creates count against the absolute cap
`maxContainerCreatesPerRun` (default 5), missing parents included.

A target's **first** run is always confirmed by a person, whatever the
thresholds say, and no setting changes that. A run the guard **refused**
outright (no accounts read from the target, a collapsed person population, an
axis with no denominator) cannot be confirmed: fix the cause and run again.

### Runs that replace a waiting run

A target has at most one unfinished run. What a new run does about one that is
already there depends on what that run is, and on who asked for the new one:

| The run already there | Scheduled run | Run started by hand (`POST /targets/:id/runs`) | Onboarding / offboarding (a person's receipt) |
| --- | --- | --- | --- |
| `previewed` — a plan nobody applied | skipped, and the skip is recorded on the target | **supersedes it** | **supersedes it** |
| `blocked`, **held for confirmation** (a threshold tripped, or the first run) | skipped | skipped | **held** — the receipt is `blocked` naming the held run |
| `blocked`, refused outright (nothing to confirm) | supersedes it | supersedes it | supersedes it |
| `running` / `applying`, alive | skipped | skipped | **waits** — deferred and retried every 30 seconds |
| `running` / `applying`, silent for six hours | adopted | adopted | adopted |

**Superseding** a run marks it `failed` with *superseded by a later run* (the
runs list and the run page show it as *Superseded*), marks its unapplied actions
`superseded`, re-opens any revocation order they carried, and writes a
`provision.run.superseded` audit event naming the run, its previous status and,
for a receipt, the receipt. Nothing is written to the target on its behalf:
the new run's plan is computed afresh for the whole target, and still carries
whatever of the old plan is still wanted — including other people's work, which
stays in the new plan for somebody to apply.

The schedule deliberately does not supersede a `previewed` plan, so the review
screen is not replaced every night. A person asking — by hand, or through an
onboarding or offboarding — is asking for current work to happen, and a stale
preview holding other people's changes used to refuse every such retry on the
target with "Another run is in progress or awaiting review".

**A hold for confirmation is never stepped over by a retry.** It is a question
put to a person, and it is resolved only by confirming the run or cancelling it
(**Cancel** on the run, or `POST /targets/:id/runs/:runId/cancel`). Nor could a
retry get round the guard even if it did replace the run: every preview
evaluates the guard afresh against baselines that only an **applied** run moves
(whether the target has ever been applied, and the last applied population), so
a change still over a threshold is held again. A receipt only ever applies its
own person's actions, from a plan the guard let through.

### Schedules and automatic apply

A target's **Schedule** (under *Schedule and enforcement* on the target page)
is a cron expression evaluated in **UTC** — `0 * * * *` hourly,
`*/15 * * * *` every fifteen minutes, `0 3 * * *` daily at 03:00 UTC. Blank
means the target runs only when somebody starts a run, and the targets
overview says *By hand only*. **Apply scheduled runs automatically**
(`autoApply`) applies what a run plans without a person, except what the
guard holds and the single actions described next; with no schedule it does
nothing, and the form warns about that. **Run now** on the target page (it
needs `provision.manage`, like `POST /api/admin/targets/:id/runs`) starts a
run at once; it is held while the saved target is disabled, because the
worker drops a disabled target's job without recording a run.

### Held actions and renames

Some single actions need a person's confirmation even in a run nobody held: a
**rename** (the sign-in name changes), a **re-enable** of an account disabled
for longer than *Re-enable without confirmation (days)*, and the **re-create**
of an account that vanished from the target. A run someone applies from its
page confirms them with the box beside Apply. A run that applies itself (a
target with *Apply scheduled runs automatically*, whether the run was
scheduled or started with Run now) confirms nothing: it applies everything
else, leaves these `proposed` with "requires an explicit confirmation", and
ends `partially_applied`. The runs list marks such a run **N held**.

**Approving after the fact.** On a finished run, *Waiting for your approval*
lists each held action with its before and after. **Approve** asks first, then
records a standing approval of exactly that change and queues a run. It does
not replay the old plan: the new run reads the target again, and applies the
change only if it plans the very same one (same account, same type, same
before and after). A change that has moved on since, such as a second name
change, is not covered and the approval lapses. Approvals are used once,
expire after 24 hours, can be revoked until a run uses them, and never
confirm a run the safety guard held. Each is audited
(`provision.action.approved`, `provision.action.approval_revoked`, and
`provision.action.confirmed_by_approval` on the action it confirmed). API:
`POST` / `DELETE /api/admin/targets/:id/runs/:runId/actions/:actionId/approve`
(`provision.manage`, body `{ "confirm": true }`).

**Apply renames automatically.** A per-target setting under *Schedule and
enforcement*, off by default. When on, every run on that target (scheduled or
requested) applies `rename_account` actions without asking, and audits each
as `provision.action.auto_confirmed` by the setting. It covers renames only:
re-enables, re-creates and threshold holds still wait for a person. A rename
changes the name the person signs in with. On Active Directory that is the
`sAMAccountName`, and changing it breaks cached logons, profile paths and
anything else that stored the old name. Turn it on only where names follow a
source of truth people expect to change, such as an Entra UPN that follows
the business email. Renames are planned only when *Rename an account when
the person's name changes* is on. The checkbox is disabled on a target whose
adapter cannot rename. Changing the setting is audited on
`provision.target.update` as `autoConfirmRenames: { from, to }`.

### Onboarding against an account that already exists

When a person's account was created or adopted by a different run, their
onboarding's own preview plans nothing for them. Syntra then reads the account
back from the target and completes the target step when it matches what
Syntra records; only a mismatch or an incomplete read-back leaves it waiting
for manual verification. A preview started for one person that found nothing
to change anywhere is closed as an empty applied run rather than left
awaiting review; one that found work for other people is left for a person to
apply and shows in the banner. It does not hold up the next onboarding or
offboarding on the target, which supersedes it (see above).

### Org units as OUs

A person's account is placed, on a target that has containers (Active
Directory), by the first of: a manual **Move** of that account, the
**container of their org unit** on that target, the account profile's
container template, and its fallback container. An org unit gets a container
on a target in one of two ways, shown on the unit's page under **Containers**
— the automatic one first, because it is the recommended one:

- **Mirrored automatically** — the target has **Mirror org units as OUs** on
  (target page, *Org units*). Every **active** unit is then placed at a DN
  derived from its place in Syntra's tree, `OU=<unit>,OU=<parent>,…,<root>`,
  the top-level unit nearest the root. The root is the *Org-unit root* (blank:
  the target's base DN); it must sit below the base DN. The section previews,
  from the real org units and before anything is saved, which DN every unit
  would get and why a unit cannot be mirrored. A unit with no row yet shows
  *Mirrored automatically* with its derived DN: nothing to do — the next run
  writes the row and creates the OU if it is missing.
- **Typed by hand** — an override. *Set a DN by hand* on the unit's
  Containers panel types a DN for that unit on that target, pre-filled
  `OU=<unit>,<parent's container>` when the parent already has a container
  there, and `OU=<unit>,<base DN>` otherwise. **A typed DN always takes
  precedence over the mirror**, so on a mirroring target the unit stops
  following the tree until it is switched back. On a target that places
  accounts in OUs but does not mirror, the panel first recommends turning
  mirroring on (a link to the target's *Org units* section, where the switch
  and its preview are); typing a DN stays available below it. Targets with no
  OUs (Entra ID, SCIM) are not offered.

Names are escaped per RFC 4514 (`Sales, West` becomes `OU=Sales\, West`).
A name over Active Directory's 64-character OU limit is never truncated: that
unit — and every unit below it — is reported as not mirrored until it is
renamed. So are two active units that would derive the same DN (two `IT`s
under one parent), and a unit whose derived DN is another unit's typed DN.

**Nothing is written by the setting.** Turning mirroring on, changing the
root, renaming or moving a unit only change what the *next run* proposes.
Each run of a mirroring target first brings the units' container rows into
step with the tree (audited as `provision.target.org_units_mirrored`), then
plans against them, under the guard:

- **Missing OUs are created parent first**, including missing parents that
  are not units of their own — the root, say — so
  `OU=IT,OU=contoso.local,OU=Syntra,DC=…` works when none of the three exist.
  Missing parents are created only for mirrored containers, only as `OU=`
  containers, and never at or above the base DN. A typed DN gets no
  invented parents: a typo in one still fails `not_found`.
- **A renamed or re-parented unit's OU is moved**, with an LDAP modifyDN, so
  every account, child OU and GPO link in it moves too. Only the topmost OU
  that changed moves; its children ride along. Accounts inside it get no
  per-account move. A run that moves an OU is always held for a person; the
  run page's **Directory structure** panel lists the OUs to create, the OUs
  to move with every account that rides along, and the accounts that move to
  a different OU on their own.
- **Nothing is deleted.** A deactivated unit keeps its row and its OU, and
  its accounts stay where they are; it is shown as *No longer mirrored*. A
  deleted unit's OU stays in the directory. If the new OU already exists when
  a move is due (somebody made it by hand), the old OU is left behind, named
  in the audit event, and the accounts move one by one.

**Switch to mirrored** on a unit's typed container hands it to the mirror:
the row takes the derived DN, and when the target had confirmed the typed DN
the next run proposes moving that OU — the flat `OU=IT,OU=Syntra,…` becoming
`OU=IT,OU=contoso.local,OU=Syntra,…` — and a person confirms it. Audited as
`orgUnit.container.switch_to_mirrored`.

**Turned mirroring on and nothing moved?** Units materialised by hand before
mirroring was on keep their typed DNs, because a typed DN always wins. The
target's *Org units* section then warns *Mirroring is on, but N org units use
a DN typed by hand*, listing each unit with its typed DN and the DN mirroring
would give it. **Switch all to mirrored**
(`POST /api/admin/targets/:id/org-units/switch-to-mirrored`,
`provision.manage`, administrative session) converts every active unit's
typed row on that target, parents first, in one transaction, through the same
code and with the same `orgUnit.container.switch_to_mirrored` event per unit
as the single switch; a unit that cannot be converted (its name cannot be
mirrored, or another unit holds its DN) keeps its typed DN and is named in the
answer. Pressing it again converts nothing. Per-unit *Switch* buttons sit
beside each listed unit for keeping some typed DNs on purpose. Nothing moves
in the directory until a run is confirmed: the next run proposes the OU moves,
and a container move always holds the run. Save the *Org units* settings
before switching — the switch uses the saved root.

The setting itself is audited on
`provision.target.update` as `mirrorOrgUnits` and `orgUnitRootDn`
`{ from, to }`. Mirroring is refused on a target that does not place accounts
in containers (Entra ID, SCIM, HTTP), and the target page says why.

## Background work and job health

Background work has a row (a sync run, an HR import run, a provisioning run, a
person's target operation, an export, a lifecycle operation) and a pg-boss job
that moves it. **Operations → Background work** in the console, and
`GET /api/admin/job-health` (`audit.read`), compare the two, and the clock,
for the tenant signed in:

| Finding | When |
| --- | --- |
| `orphaned` | A queued or running row with no live job for 10 minutes; a provisioning apply whose heartbeat (restamped every minute) is 15 minutes old |
| `stuck` | No progress for 6 hours (the provisioning adoption threshold) |
| `delayed` | A live job waiting more than 15 minutes for a worker |
| `duplicated` | Two or more live jobs for the same work |
| `poisoned` | The same payload failed 3 or more times in 24 hours; the finding carries the failure's class, never its message |
| `saturation_deferred` | A target operation waiting under the tenant's concurrency cap |

Each finding lists the repairs that are safe for it, and
`POST /api/admin/job-health/repair` (`tenant.manage`,
`{ kind, subjectId, action, reason }`) applies one:

- **`requeue`** — enqueue the job a queued run, export or target operation is
  missing. Workers claim rows conditionally, so a requeue racing a late job
  does nothing twice.
- **`mark_failed`** — end a row no worker is running, with the reason; a
  waiting cancellation is honoured instead. The same semantics as the
  subsystem's own abandoned-run path.
- **`release_lease`** — close a provisioning apply whose heartbeat stopped as
  `partially_applied`. Its `in_flight` actions are left for
  `resolveInFlightActions`, which the next preview runs against the target
  before planning. **No repair re-runs a connector write.**

Every repair re-derives the finding when it runs and writes through a
conditional update keyed on what it saw (for a release, on the heartbeat
value), so a second press answers `outcome: "noop"`. Every attempt is an audit
event (`job_health.requeue`, `job_health.mark_failed`,
`job_health.release_lease`) with the reason and the before and after status.
Lifecycle operations are reported but never repaired here: their retry is
verification-gated on the operation's own page. Directory sync and HR applies
carry no heartbeat and are resumed by applying again or cancelled.

pg-boss's table is not under row-level security, so every read of it is
filtered on the job payload's `tenantId`; a tenant never sees another tenant's
jobs. When the table cannot be read, nothing is reported orphaned. The alert
rules are `SyntraJobsOrphaned`, `SyntraJobsStuck`, `SyntraJobsPoisoned`,
`SyntraJobsDelayed`, `SyntraJobsDuplicated` and `SyntraJobHealthBlind`; the
procedure is the [queue recovery runbook](#runbook-queue-recovery).

## Status reporting

Two status views, split by audience:

- **Tenant status** — `GET /api/admin/status` (`audit.read`) and
  **Operations → Service status** in the console. The shared components (API,
  database, background work, key provider, outbound mail) as `operational`,
  `degraded`, `unavailable` or `unknown`, each with one sentence and never a
  cause, host or count; then the tenant's own degradation: its tenant-wide and
  per-target write stops, targets whose readiness evidence is missing,
  failing, older than a week or taken under a different configuration,
  connectors whose last readiness check or last run failed in the last day
  (with the error class), and its background-work finding counts. Nothing in
  it can move with another tenant's activity — the queue is reported as
  working or not, never its depth.
- **Deployment status** — `GET /api/admin/deployment/status`
  (`deployment.manage`). The release, the readiness probes (causes redacted,
  as on `/health/ready`), migration state, queue depth, schedules the
  scheduler asked for that pg-boss does not hold, installation-wide finding
  counts, and how many tenants have an active write stop or stuck work.
  Counts only: no tenant is named, because in a shared deployment the holder
  of `deployment.manage` may be one customer's administrator.

Component checks are cached for 15 seconds per process, so an open status page
cannot load the KMS or the mail server. Mail is checked with an SMTP `verify`
(connect and authenticate; nothing is sent); a transport that cannot be
checked reports `unknown`.

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
| `support_bundle` | A redacted operational support bundle for one tenant, covering at most seven days. See below. | `tenant.manage` | JSON Lines |
| `dsar_bundle` | One person's data, for a data-subject access request. Requested only from a privacy case (`POST /api/admin/privacy/cases/:id/access-bundle`); see [Data-subject requests](#data-subject-requests). | `privacy.manage` | JSON |

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

### Support bundles

A support bundle is what a support engineer needs to diagnose a tenant, and
nothing they should not hold. Request it from **Operations → Support bundle**
or `POST /api/admin/exports` with
`{ "kind": "support_bundle", "params": { "from": "…", "to": "…" } }`; both
bounds are optional (`to` defaults to now, `from` to a day earlier) and the
window may not exceed **seven days** — the contract refuses a longer one with
`400`, the service refuses it again, and the window is fixed as explicit
instants when the request is recorded. It is generated, sealed, watermarked,
downloaded, expired and audited exactly like any other export.

The file is a watermark record, one record per section, and an end record:
`software` (version, commit, Node, migration state), `tenant` (status, a
settings fingerprint, four sign-in policy numbers, record counts),
`configuration` (per target and source: type, enabled, schedule present,
adapter channel and a SHA-256 **fingerprint** of the configuration),
`write_stops` (active, when, and whether a reason was given — not the reason),
`connector_readiness` (latest check per system: status, time, latency,
capabilities, whether it matches the current configuration, and an error
class), `job_health`, `recent_failures` (failed, partial and cancelled runs,
receipts, exports and lifecycle operations in the window, by id, status, time
and **error class**), and `audit_counts` (events by action and outcome in the
window).

It is built by allow-list: identifiers, fingerprints, versions, statuses,
timestamps, counts and error classes. It never contains credentials, vault
material, configuration values, target, source, application or person names,
personal data, audit payloads or error messages — an error message can carry a
DN, an email address or a credential in a URL, so it is reduced to a class
from a closed vocabulary (`timeout`, `unauthorized`, `network`, …). Every
section then passes through the shared log redaction rules as a second layer.
A test seeds secrets and personal data into every table the bundle reads and
asserts none survive.

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
`targetType`, `outcome`, `from` (inclusive) and `to` (exclusive), `subject`
(repeatable; done by or to any of the ids) and `correlation` (the 32-hex
correlation id — see [Correlation ids](#correlation-ids)). Pages are at most
200 events, newest first, and are keyset-paged on the chain's own `sequence`:
the response's `nextBefore` is the `before` of the next page, or `null` when
there is none. There is no total, deliberately — counting a log that grows for
ever is the cost this avoids. The subject filter follows a person or an object
through everything done by it and to it; the correlation filter follows one
request or job through everything it caused.

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
[the scale validation runbook](#runbook-scale-validation) for the recorded figures.

A known limit: every page still carries a full chain verification
(`verifyChain`), which reads the tenant's whole log. The search itself is
bounded; that check is not, and on a log of millions of events it is what a
page's latency is made of. Moving the page onto the checkpointed, incremental
verification Govern already runs nightly is the follow-up.

## Continuous integration

`.github/workflows/ci.yml` runs on every pull request, every push to `main`,
on demand (`workflow_dispatch`), and as a reusable workflow that the release
workflow calls. Its jobs:

- **`tests (shard N/4)`** — the unit and integration suite, against a real
  PostgreSQL, OpenLDAP, Samba domain controller, MailDev and Vault dev server,
  split by file into four shards, each on its own runner with its own
  containers and scratch databases, running `pnpm test -- --shard=N/4`. One
  red shard does not cancel the other three. Locally, `pnpm test` with no
  argument is still the whole suite, unsharded.
- **`typecheck, lint and console`** — the operational shell tools' own tests
  (`bash -n` over `ops/syntra-update`, `ops/syntra-install` and
  `ops/syntra-backup`, then `ops/syntra-update.test.sh` and
  `ops/syntra-backup.test.sh`), `tsc -b`, `pnpm lint`, the console's
  component tests and its production build. Run once, beside the shards,
  since none of it needs a database.
- **`tests`** — needs the shards and the checks job and is green only when
  every one of them is, so there is still one `tests` status to require.
- **`browser`** — the Playwright suite (`pnpm e2e`) against a running, seeded
  stack; the report is uploaded as an artifact.
- **`docker build`** builds both images (`apps/api/Dockerfile`,
  `apps/web/Dockerfile`).
- **`helm chart`** runs `helm lint --strict` and `helm template` over
  `deploy/helm/syntra/ci/*.yaml` and validates the output with kubeconform.
  It also checks that the chart refuses to render without a Secret, that the
  backup CronJob's script parses, and that the chart's copy of the alert
  rules matches `ops/prometheus-alerts.yml`.
- **`openapi document`** regenerates `apps/api/openapi.json` with
  `pnpm openapi:generate` and fails when the committed copy differs; the fix
  it prints is to run the generator and commit the result
  (`pnpm openapi:check` asks the same question locally).

The suite shards and the browser job bring the infrastructure up with
`infra/docker-compose.yml` rather than GitHub's `services:` (the shards also
start Vault from its `kms` profile). The OpenLDAP container needs its bootstrap LDIF and TLS
settings and the Samba container needs a domain provisioned; both are already
expressed in that file, and a second, drifting copy of it in YAML is how CI
starts testing something the developers do not run. The browser job waits for
a seeded OpenLDAP entry to answer over TCP before it starts the stack: the
image restarts `slapd` after seeding, and a sync test that ran into the
restart failed with `ECONNREFUSED` on 1389.

**A known flake, fixed by capping the worker count.** Too many vitest workers
against one PostgreSQL server made a handful of `resetDatabase()` hooks time
out at 30 seconds and take their files with them — `testWorkerCount()`'s old
`cores - 1` default put seven workers on an eight-core box, and that
oversubscribed the server badly enough to crash a backend roughly one run in
two. The fix is fewer workers, forced through `SYNTRA_TEST_WORKERS`: four on
an eight-core machine (0 crashes, 0 hook timeouts across three measured runs),
two in this job specifically, because GitHub's standard runner is two vCPUs
and four workers there trips a separate, hardcoded 60-second vitest RPC
heartbeat timeout, unrelated to `hookTimeout`. Two workers is per runner, so
it holds unchanged in each shard.

**Releases reuse a green run.** `.github/workflows/release.yml` refuses a tag
whose commit is not reachable from `main`, then looks for a `ci.yml` run in
this repository for exactly that commit, on `main`, from a `push` or
`workflow_dispatch`, that completed with `success`. If it finds one it skips
the suite and names that run in the log and the job summary; otherwise, or if
the API call fails, it runs `ci.yml` in full. The release jobs run only when
one of the two is green. A tag pushed while `main`'s own run is still going
finds nothing and runs the suite. `security.yml` is not part of the release
gate.

## Tests

```bash
pnpm test                       # domain, API and database integration tests
pnpm test:watch                 # the same suite, watching
pnpm --filter @syntra/web test  # web component tests
pnpm e2e                        # browser tests against a running stack
pnpm typecheck                  # tsc -b, no emit
pnpm lint                       # eslint
pnpm openapi:check              # the committed OpenAPI document matches the code
pnpm privacy:inventory:check    # the committed data inventory matches the code
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
rules, Automate requests, held privileged changes, break-glass accounts and
activations, credential rotations, privacy cases, support and DSAR bundles
and more, 62 kinds in all). It then acts as tenant
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
- **Credentials and downloads.** A's session and token are refused at B's
  host; B's user cannot sign in, and B's emergency (break-glass) account
  cannot be activated, at A's host with B's correct secrets. A support bundle
  and a DSAR access bundle are generated for A by the production export job,
  downloaded, and searched for B.
- **SCIM** requests are sent as `application/scim+json`, as a conforming IdP
  sends them.

After every call, the response must not contain B's tag or any B id that the
request did not itself carry. After every write, B's rows must be
byte-for-byte what they were (a per-table digest taken as B). A refused write
must not have changed A's rows either (audit, session and token timestamps
excepted), and must not have recorded a *success* audit event naming one of
B's ids: a no-op that audits "removed" puts a false record in A's trail and,
through it, B's ids into A's DSAR bundles. No row of A may hold one of B's ids
in any id, text, array or JSON column. That last check is the one row-level security cannot give on its own:
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
`SYNTRA_ALLOW_RESET` — the development database and a real deployment's are both
called `syntra`, and nothing about the connection string tells them apart:
`SYNTRA_ALLOW_RESET=syntra pnpm db:reset && pnpm seed`.

**Suite hook timeouts / fsync-bound test runs.** See
[Continuous integration](#continuous-integration) above for the vitest worker
count issue (`SYNTRA_TEST_WORKERS`) and its two different correct values on a
workstation versus a two-vCPU CI runner.

## Active Directory in practice

What running against a real Windows domain teaches, written from a build that
put Syntra behind HTTPS with an AD domain behind it, sync in both directions
and SAML to a third-party application. None of these failures is obvious from
its error message. Directory and target configuration itself is in
[Configuration](configure.md#connecting-a-directory-source).

### The host

- **Writes to AD need LDAPS, so the domain controller needs a certificate.** A
  target has no plaintext transport option at all. An enterprise CA is the
  ordinary way to get one (`Install-AdcsCertificationAuthority -CAType
  EnterpriseRootCA`, then `certutil -pulse` and a restart of `NTDS` rather
  than waiting for auto-enrolment). Installing a CA changes the forest and is
  not casually reversible; decide deliberately. Connect by the DC's
  **hostname**, not its address: the certificate is issued to the name, and
  verification fails against an IP.
- **Node ignores the system CA store.** `update-ca-certificates` satisfies
  `openssl` and `curl` and does nothing for Node, which carries its own
  bundled list. LDAPS fails with *unable to verify the first certificate*
  while `openssl s_client` against the same host verifies cleanly. Set
  `NODE_EXTRA_CA_CERTS` to the CA's PEM (a unit drop-in with
  `Environment=NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/<ca>.crt`
  is the tidy way) — it is the only fix short of disabling verification.
- **`.local` does not resolve on Linux by default.** `systemd-resolved` treats
  `*.local` as multicast DNS and will not forward it to a unicast server, so
  `dig @dc` answers and `getent hosts` does not. Turn it off:

  ```ini
  # /etc/systemd/resolved.conf.d/10-ad-local.conf
  [Resolve]
  MulticastDNS=no
  LLMNR=no
  ```

- **Name the DC as the only resolver.** A public resolver listed beside it is
  not a fallback: `systemd-resolved` treats every server on a link as
  equivalent, switches between them freely, and whenever it settles on the
  public one every internal lookup answers NXDOMAIN — LDAP and Kerberos fail
  at random with nothing in any log. The DC forwards what it cannot answer.
- **Publishing it.** Point the reverse proxy or tunnel at the API's port over
  plain HTTP, with the `Host` header left untouched. An `https://` origin URL
  in front of an HTTP origin, and a stale origin address, both show up as the
  same `Request failed` at a tunnel connector.
- **`TRUST_PROXY` must name the proxy or connector** (see
  [Configuration](configure.md#trust_proxy-and-proxy-notes)). Without it every
  request carries the proxy's address: source-address policy conditions match
  everyone or nobody, and every per-IP rate limit is one bucket shared with
  the internet.
- **The tenant must claim the hostname it is reached on.** `syntra.example.com`
  matches neither a `primaryDomain` of `example.com` nor the slug fallback
  (which takes the leftmost label, `syntra`), and 404s as an unknown tenant —
  which looks like a proxy fault. Make the public name the **primary** domain:
  the SAML entity ID, the SSO endpoints and the WebAuthn relying party are
  built from it, and SSO is served only there. Reaching Syntra by any other
  name answers SAML with `421 wrong-protocol-host`, naming the right host.

### The domain: subtrees and the service account

Keep what Syntra reads and what it writes in **separate subtrees**, so a
provisioning mistake cannot overwrite the directory being synced from:

```
DC=example,DC=local
├── OU=Company            ← the directory source reads
└── OU=Syntra             ← the provisioning target writes
    ├── OU=Users
    └── OU=Archive
```

The service account is **not** a Domain Admin. Full control over the write
subtree only; reading the rest is what any authenticated account can already
do, which is all the sync needs:

```powershell
dsacls "OU=Syntra,DC=example,DC=local" /I:T /G "EXAMPLE\svc-syntra:GA"
(Get-ADUser svc-syntra -Properties MemberOf).MemberOf   # expect nothing
```

**Write-back** (a directory source's switches, described in
[Configuration](configure.md#connecting-a-directory-source)) needs one more
right for one switch. *Deactivating a user disables their account here* needs
write access to `userAccountControl` — **on the OU the directory source reads,
not only the one the target writes to.** Delegating it on the wrong one is
silent: everything saves, and the first refusal arrives on the day somebody
leaves. Scope it to the one attribute on the user class:

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
(Get-Acl "AD:OU=Company,DC=example,DC=local").Access |
  Where-Object { $_.IdentityReference -like "*svc-syntra*" }      # check it took
```

`GenericWrite` on the OU also works, and also lets the same credential rewrite
everybody's group memberships. *Self-service password change writes through*
needs **nothing extra**: Syntra changes a password by binding as the user,
with the password they just typed. Do not grant the service account **Reset
Password** to make that work — a bind credential that can reset any password
in the OU is an account-takeover primitive sitting in a vault. The delete
switch needs delete rights on the objects in scope, and is the one switch
whose effect Syntra cannot undo.

### What deactivating a directory-managed user does

With the disable switch on, **Deactivate** on a directory-managed user:

1. sets the disable bit in AD — immediately;
2. marks the user inactive in Syntra and revokes every session and refresh
   token;
3. stamps an administrative departure on the linked person, which puts them
   on the ordinary leaver ladder (entitlements revoked, archived, and deleted
   by the domain's own sweep if you run one — below).

The directory is written **first**. If AD refuses, nothing changes anywhere
and the console says why. `disableGraceDays` is bypassed: it delays the
disable after a *scheduled* departure, and a person pressing Deactivate means
now. **Reactivate** reverses all three.

Sync reads the bit too: an account disabled in AD is deactivated in Syntra on
the next sync run, with the reason *Disabled in directory source, run <id>*,
and the reactivate branch will not resurrect an account the source still
reports disabled.

### Passwords

**A joiner's first password.** A person who arrives through directory sync or
provisioning has a login and no Syntra password; Syntra verifies against its
own hash and never binds to the directory to do it, so the domain password
provisioning generated does nothing here. **Users → Accounts → the account →
Password link** mints a link to copy: it lasts 24 hours, works once, and
minting another (or the person requesting a self-service reset) kills the
first. Every issuance is audited as `auth.password_setup_issued` with the
administrator who minted it — the link is a bearer credential. It is refused
for an account whose password lives at an upstream identity provider.

**With password write-back on, the domain's policy applies, not only
Syntra's.** A change the domain refuses is reported as refused by the
directory, and the usual causes are:

- **Minimum password age** — one day by default; a password set yesterday
  cannot be changed today. That is the evidence the change is done as the
  user rather than as an administrative reset, which would bypass it.
- **Password history** — 24 by default.
- **Complexity and length** — the domain's, checked after the tenant's own,
  so an obviously weak password is refused before it costs a lockout attempt.
  A wrong *current* password does count against the domain's lockout.

If the DC is unreachable the change is refused with nothing changed — never
applied locally, which would leave the person with two passwords.

### Leavers: archive in Syntra, delete in the domain

Provisioning never deletes anything at a target (see the
[target rollback runbook](#what-cannot-be-undone)). On AD a leaver's account
is disabled and then **archived** — moved into the target's archive container.
What happens afterwards is the domain's decision, and running the deletion on
the domain controller keeps the blast radius to one domain with the AD Recycle
Bin as the safety net.

**The archive OU must sit outside the directory source's search base**, as a
sibling, not inside it:

| | |
|---|---|
| Sync search base | `OU=Company,DC=example,DC=local` |
| Archive container | `OU=Deactivated,DC=example,DC=local` |

Provisioning moves the object to the archive; the object thereby leaves the
sync's search base; the next sync run reads it as absent and proposes
`deactivate_user`, reviewed and applied like any other change. Nest the
archive inside the search base and none of this happens, and nothing errors.
The archive must also be somewhere the service account can write — at the
domain root it needs the OU delegated to it, or put the archive inside the
subtree it already holds (`OU=Deactivated,OU=Syntra,…`), which is outside the
sync base all the same. The refusal otherwise is `INSUFF_ACCESS_RIGHTS` on the
move, and is correct.

The repository ships a retention sweep for the domain controller:
`install-reap.ps1` (run once as a domain administrator: `-Domain`,
`-ArchiveOu`, `-RetentionDays` default 30, `-MaxDeletesPerRun` default 25,
`-Apply`) creates and protects the archive OU, **enables the AD Recycle Bin —
which cannot be undone, and needs a 2008 R2 forest functional level** —
installs `syntra-reap.ps1` into `C:\ProgramData\Syntra` and registers a daily
task as SYSTEM. It installs in **dry run**: read
`C:\ProgramData\Syntra\reap.log` for a few days, then re-run the installer
with `-Apply`. Its rules:

- The clock is a `syntra-reap-after=<date>` line the sweep writes into
  `adminDescription` (not `info`, which holds Syntra's provenance note). On
  first sight of an unstamped account the due date is `whenChanged` plus the
  retention — **and never earlier than tomorrow**, so no account is deleted on
  the run that first stamps it. A stamp that does not parse holds the account
  forever rather than restarting its clock.
- An **enabled** account in the archive is held (somebody put it back), as is
  one **protected from accidental deletion**. More than `-MaxDeletesPerRun`
  due at once deletes up to the cap and logs the rest.
- A deletion is undone within the deleted-object lifetime with
  `Get-ADObject -Filter 'SamAccountName -eq "<name>"' -IncludeDeletedObjects |
  Restore-ADObject`; it comes back in its original OU.

Point the target's archive container at the same OU and set the ladder's
archive rung: `archiveAfterDays: 0` archives on the departure date so the
whole retention runs in the OU; `archiveAfterDays: 7` with `-RetentionDays 23`
gives the same total.

### First runs against a small directory

Two guard refusals meet everybody on a small or rebuilt directory. Both are
the guard working.

- *"the target returned no accounts at all, and a run has been applied against
  it before"* is **not confirmable**: an empty target and an unreachable one
  look identical. On a target whose accounts were deliberately removed by hand
  after a successful run, the input is `TargetSystem.lastAppliedRunAt`, and
  clearing that column (and only that — the runs and their audit events are
  the record) states what is actually true: the target has no surviving
  applied run.
- *"would disable 1 of 4 active accounts (25.0%), above the 10% threshold"* is
  confirmable, and on four people every leaver will trip it. Confirm it, or
  raise the threshold deliberately (see [Safety thresholds](#safety-thresholds)).
  Container moves share the archive axis, so the first run that places people
  by org unit on a small tenant is held for the same reason. Raise thresholds
  in advance, knowing which axis and why — not mid-incident because a run
  skipped.

### SAML to a third-party application: what goes wrong

The service provider needs the IdP metadata URL
`https://<primary domain>/saml/metadata/<application-id>` (or the entity ID
`https://<primary domain>/saml/idp`, SSO `…/saml/sso`, SLO `…/saml/slo`).
Application setup is in
[Configuration](configure.md#signing-in-to-applications). Then:

- **An assertion carries no attributes until claims are mapped.** Registering
  the service provider is not enough: the `AttributeStatement` is empty, the
  SP finds nothing to match on, and the sign-in fails with nothing in either
  side's log. Map claims under the names **the service provider** documents
  (`username`, `uid`, a full schema URI…), commonly `login`, `email` and
  `displayName`.
- **The account must exist on both sides under the same name.** Most SPs match
  on the username, not the NameID email. `a.brennan` here and `abrennan`
  there fails silently: the assertion validates, no user matches, the browser
  lands on the login page. Fix it in the directory (the `sAMAccountName`), so
  the two agree permanently.
- **`wantAuthnRequestsSigned` defaults to true** and is refused without the
  SP's certificate to check against. Turn it off only for an SP that does not
  sign.
- **Portal tiles.** With *Allow sign-in started from Syntra* on, the tile
  posts an assertion straight to the SP. Off (the default), the tile opens the
  application's launch address, which must be the SP's own SSO start page;
  with neither, the tile answers `409 not-launchable`.
- **Testing without a browser.** `GET /saml/start/<application-id>` with an
  administrator's session returns the IdP-initiated form; post its
  `SAMLResponse` to the SP's ACS, then **follow the SP's redirect to its own
  login route** — several SPs only establish the session there, so a test
  that stops at the ACS reads a working handshake as a rejection. Do not use
  `curl -L` (it re-POSTs into a GET route), and generate a fresh assertion for
  every attempt: they are single-use.

**Mail addresses come from the directory.** An account synced with `mail`
set to `user@example.local` is mailed there, and a real mail server will not
accept it. Fix `mail` in AD and re-run the sync — the source owns the field.
Links inside mail come from `PUBLIC_URL`, which must be the external name.

## Runbooks

Step-by-step procedures for a running deployment. Each says when to reach for
it, the exact commands and console screens, how to verify the result, how to
back out, and what it deliberately does not cover. Where the product has no
capability a procedure needs, the runbook says so rather than inventing one.
The deployment shapes they name are the three described under
[Upgrades](#upgrades).

### On-call quick reference

Every rule in `ops/prometheus-alerts.yml`, and where it leads:

| Alert | Fires on | Severity | Go to |
|---|---|---|---|
| `SyntraNotReady` | `syntra_readiness == 0` for 5m | critical | [Incident response: not ready](#not-ready), then by failing probe: `database` or `migrations`, [database migration](#runbook-database-migration); `vault` or `key-management`, [master-key recovery](#runbook-master-key-recovery); `web`, [the web probe](#the-web-probe) |
| `SyntraSchedulerDown` | `syntra_scheduler_running == 0` for 10m | critical | [Scheduler unavailable](#scheduler-unavailable) |
| `SyntraUndeliveredLogout` | `syntra_logout_deliveries_abandoned > 0` for 5m | critical | [An abandoned delivery](#an-abandoned-delivery): a relying party was never told an account ended |
| `SyntraLifecycleServiceLevelBreached` | `syntra_lifecycle_operations_slo_breached > 0` for 1m | critical | [Lifecycle work alerts](#lifecycle-work-alerts); for an urgent leaver, [exercise 4](#exercise-4-an-urgent-leaver-during-an-outage) is the drill. The operation page names the breach and who it was escalated to |
| `SyntraLifecycleWorkOverdue` | `syntra_lifecycle_operations_overdue > 0` for 15m | warning | [Lifecycle work alerts](#lifecycle-work-alerts); the queue is **Employee work** |
| `SyntraLifecycleWorkFailed` | `syntra_lifecycle_operations_failed > 0` for 5m | warning | [Lifecycle work alerts](#lifecycle-work-alerts); for a target-side cause, [target rollback](#runbook-target-rollback) |
| `SyntraLifecycleApprovalsWaiting` | `syntra_lifecycle_operations_awaiting_approval > 0` for 4h | warning | Somebody with `provision.manage` other than the requester opens the operation and approves or rejects |
| `SyntraLifecycleBacklogAging` | `syntra_lifecycle_oldest_unresolved_age_seconds > 2d` for 30m | warning | [Lifecycle work alerts](#lifecycle-work-alerts): **Employee work**, oldest first |
| `SyntraTenantSaturated` | `syntra_lifecycle_receipts_deferred > 0` for 15m | warning | Raise the cap in **Lifecycle policy**, or wait: deferred receipts retry every 30 s |
| `SyntraProvisioningRunsFailing` | `syntra_provision_runs_failed_24h > 0` for 5m | warning | [Target rollback](#runbook-target-rollback); an expired credential shows here first ([exercise 1](#exercise-1-expired-entra-client-secret)) |
| `SyntraProvisioningRetriesExhausted` | `syntra_provision_actions_pending_retry > 0` for 30m | warning | [Target rollback: a credential or target that stopped working](#a-credential-or-target-that-stopped-working) |
| `SyntraTargetStale` | `syntra_targets_stale > 0` for 1h | warning | [Target rollback](#runbook-target-rollback) |
| `SyntraReadinessEvidenceStale` | `syntra_target_readiness_age_seconds > 7d` for 1h | warning | **Test connection** on the target; [secret rotation](#runbook-secret-rotation) if it fails |
| `SyntraUndeliveredWebhook` | `syntra_webhook_deliveries_abandoned > 0` for 15m | warning | [An abandoned delivery](#an-abandoned-delivery) |
| `SyntraSigningKeyExpiring` | `syntra_signing_key_expires_in_seconds < 7d` for 1h | warning | [Secret rotation: signing keys](#signing-keys) |
| `SyntraJobQueueDeep` | `syntra_jobs_pending > 500` for 15m | warning | [Queue recovery: the queue is behind](#the-queue-is-behind) |
| `SyntraJobsOrphaned`, `SyntraJobsStuck`, `SyntraJobsPoisoned`, `SyntraJobsDelayed`, `SyntraJobsDuplicated`, `SyntraJobHealthBlind` | `syntra_job_health_findings{finding=…}`, `syntra_job_queue_readable` | warning | [Queue recovery](#runbook-queue-recovery); each tenant's **Operations** page names the work and offers the safe repair |

Worth a rule of your own: the rate of `syntra_accounts_locked` (credential
stuffing, or a broken upstream password change) and `syntra_jobs_pending`
**absent** (the scheduler has never run in this process).

Where things are, when you need them:

- **Readiness** — `GET /health/ready`, unauthenticated:
  `{ ready, version, probes: [{ name, status, detail }] }`, probes
  `database`, `migrations`, `vault`, `key-management` and `web`. A failing
  probe's detail is redacted to `this check did not pass` on the wire; the
  cause is in the process log. A probe slower than five seconds fails. `GET
  /health` is liveness only and answers 200 with the database down.
- **Incidents** — **Activity → Attention** (`/admin/activity?tab=attention`),
  or `GET /api/admin/incidents` (`audit.read`). See
  [What is broken: incidents](#what-is-broken-incidents).
- **Tenant status** — **Operations → Service status**, `GET
  /api/admin/status`; deployment-wide, `GET /api/admin/deployment/status`
  (`deployment.manage`). See [Status reporting](#status-reporting).
- **Audit log** — **Activity → All events**, or
  `GET /api/admin/audit?limit=200&before=<sequence>&subject=<uuid>`, newest
  first, `chainValid` on every page.
- **Process logs** — release layout `journalctl -u syntra`; compose `docker
  compose logs api`; Helm `kubectl -n <namespace> logs deploy/<release>-api`.
- **Backups** — `/opt/syntra/bin/syntra-backup list`; failed runs in
  `journalctl -p err -t syntra-backup --since -7d --no-pager`.
- **Update state** — `/opt/syntra/var/update.status`, or **Updates** in the
  console.

### Runbook: incident response

The starting point when something is wrong and the cause is not yet known:
an alert fires, **Activity → Attention** lists something critical, people
cannot sign in or a joiner, mover or leaver did not get what they should, or a
backup, update or restore did not end as it should. You need the host or
cluster (journal, `docker compose`, `kubectl`), an administrator with
`audit.read` (`provision.manage` and `deployment.manage` to act), and
somewhere to write the timeline as it happens.

**Severity.**

| Level | Definition | Examples | Response |
|---|---|---|---|
| **SEV1** | Syntra cannot do its job for everyone, or a control that revokes access has failed | `SyntraNotReady`; `SyntraUndeliveredLogout`; sign-in down for all tenants; a leaver's access provably live past its due date | Page now; work it until resolved; communicate every 30 minutes |
| **SEV2** | One function down or degraded for a tenant or a target | A target's runs all fail; an HR import fails; one webhook receiver abandoned; a mover stopped by a threshold | Within the hour; communicate at start and end |
| **SEV3** | Something gave up that has a manual path | One delegated task failing; one notification undelivered; a run held for confirmation | Next working day |

A SEV3 that recurs is a SEV2. A leaver is at least SEV2 while their access is
not confirmed revoked.

#### The first fifteen minutes

1. **What does the product think is wrong?** `curl -s
   http://127.0.0.1:3000/health/ready`, then **Activity → Attention** (or `GET
   /api/admin/incidents`) — critical first, then most recent, each with a link
   into the console. **Acknowledge** what you are taking, with a note, so the
   next person sees it is handled.
2. **What changed?** `GET /api/admin/audit?limit=50`, or **Activity → All
   events**: look for `deployment.*`, `provision.*`, `policy.*`,
   `tenant.settings_updated`, `notify.*`. On the release layout, `cat
   /opt/syntra/var/update.status` — an update in the last hour is the prime
   suspect.
3. **Stop the bleeding, not the product.** The levers in
   [target rollback](#stopping-a-target) stop a target without losing state.
   When you cannot yet say which target is wrong, press **Stop writes** on
   **Target systems → Tenant-wide external writes**: no connector writes
   anywhere until a second administrator resumes it or its expiry passes, and
   everything else keeps running. Do not restore a backup, disable a directory
   source or rotate a key in the first fifteen minutes unless the failure is
   exactly that.
4. **Declare the severity and open the record**: timestamp, what was seen, who
   is working it.
5. **Communicate** (below).

#### Not ready

`SyntraNotReady`: `syntra_readiness == 0` for five minutes. Read which probe
failed, then the unredacted cause:

```bash
curl -s http://127.0.0.1:3000/health/ready | tr ',' '\n'
journalctl -u syntra -n 200 --no-pager
```

| Probe | Meaning | Go to |
|---|---|---|
| `database` | This process cannot reach Postgres with its own credentials | The container or service (`docker ps`, `docker compose ps`, `kubectl get pods`), then credentials ([database role passwords](#database-role-passwords)) |
| `migrations` | Schema behind the code, or a migration half-applied | [Database migration](#runbook-database-migration) |
| `vault` | The master key does not unseal a signing key | [Master-key recovery](#runbook-master-key-recovery) |
| `key-management` | The external key provider (Vault Transit, AWS KMS) is not answering or refusing | [An external provider refuses](#an-external-key-provider-refuses) |
| `web` | `WEB_ROOT` set but no build there | [The web probe](#the-web-probe) |

#### The web probe

Only on a single-process deployment with `WEB_ROOT` set. The API refuses to
start on a path that is not a build, so this fails at runtime only if the
bundle vanished after start — for example a rollback that relinked `current`
while `WEB_ROOT` was an absolute path into the old release (`syntra-install`
rewrites `WEB_ROOT` at conversion for this reason). Fix the path in
`shared/.env`, restart.

#### Lifecycle work alerts

`SyntraLifecycleWorkOverdue`, `SyntraLifecycleWorkFailed`,
`SyntraLifecycleBacklogAging`, `SyntraLifecycleServiceLevelBreached`. The
queue is **Employee work** (`/admin/employee-work`, `GET
/api/admin/employee-work`), filterable by onboarding, offboarding and failed.
Each row links to the person and, for a lifecycle operation, to
`/admin/lifecycle-operations/:id`, where the operator can **Acknowledge
work**, **Retry operation** (which also re-queues the operation's unapplied
target receipts, and refuses with 503 while the scheduler is down rather than
pretending), **Record observed state**, and close it with a reason.

Metrics carry no tenant label; the queue is how you find the owner and
record. The overdue alert counts operations with an owner and a past due
date. Assigning one (`PATCH /api/admin/lifecycle-operations/:id/assignment`
with `ownerUserId`, `priority`, `dueAt`) queues a `lifecycle-assigned` mail,
and the hourly `lifecycle.maintenance` job mails owners about failed and
overdue work, once per operation.

#### An abandoned delivery

`SyntraUndeliveredLogout`: a back-channel logout was never delivered, so a
relying party still believes an ended session is live. There is no retry for
logout deliveries; the compensating action is at the relying party (end the
session there by hand), and the incident record must name which one.
`syntra_logout_deliveries_abandoned` says how many; the `LogoutDelivery`
table says which.

`SyntraUndeliveredWebhook`, and `webhook_undelivered` among the incidents, is
the webhook counterpart: `GET /api/admin/webhooks/:id/deliveries` shows them
and `POST /api/admin/webhooks/:id/deliveries/:deliveryId/retry` retries one.
Once handled, **Resolve** the incident so the next failure brings it back.

#### Scheduler unavailable

`scheduler_unavailable` at the top of the incidents, `SyntraSchedulerDown`,
`syntra_jobs_pending` absent. Nothing scheduled runs: no provisioning, sync,
retries, lifecycle maintenance or OIDC key rotation, and routes that need the
scheduler answer `503 scheduler-unavailable`. The API retries starting it;
read the log for the pg-boss error. It is almost always the database —
permissions on the `pgboss` schema, or a restore that dropped it. Restart the
API once the cause is fixed. An urgent leaver in the meantime is
[exercise 4](#exercise-4-an-urgent-leaver-during-an-outage).

#### Sign-in failing

- Password sign-in works, SSO does not: the vault (signing keys) — treat it as
  [Not ready](#not-ready) even if the alert has not fired.
- Everything 404s: the `Host` header is not a tenant's name. Check
  `PUBLIC_URL`, the proxy, and **Settings → Sign-in → Address** (*Also answers
  on*).
- Lockouts climbing (`syntra_accounts_locked`): `auth.lockout` in the audit
  log. Failures from one address are an attack; from many users at once, a
  broken upstream password change.

#### Communication

- **Who**: the operations channel; tenant administrators for anything they
  will see; application owners for SSO or webhook failures; HR for anything
  touching joiners, movers or leavers.
- **What**: severity, what is affected, what is not, the next update time.
  Never the cause until it is known.
- **Cadence**: SEV1 every 30 minutes; SEV2 at start, at any change of plan,
  and at close.
- **Close**: what happened, what was lost (an audit gap after a restore,
  abandoned deliveries), what remains to be done by hand (relying-party
  sessions, TOTP re-enrolment, SP metadata), and where the record is.

Syntra has no public status page; tenant administrators can read their own
**Operations → Service status**.

#### Evidence capture

Capture before fixing where the fix would overwrite the evidence.

| Evidence | How |
|---|---|
| Readiness | `curl -s http://127.0.0.1:3000/health/ready > ready-$(date -u +%Y%m%dT%H%M%SZ).json` |
| Incidents | `GET /api/admin/incidents`, saved as JSON |
| Audit log | An `audit_log` export (**Export these results** on the audit search), or `GET /api/admin/audit?limit=200` paged backwards with `before=`; repeat `subject=<uuid>` for one person and their accounts, or `correlation=<id>` for one request |
| Process log | `journalctl -u syntra --since '-2h' --no-pager > syntra.log`; `docker compose logs --since 2h api > api.log`; `kubectl -n <ns> logs deploy/<release>-api --since=2h` |
| Backup and update state | `syntra-backup list`; `cat /opt/syntra/var/update.status`; `journalctl -p err -t syntra-backup --since -7d` |
| Metrics | `curl -s -H "Authorization: Bearer $METRICS_TOKEN" http://127.0.0.1:3000/metrics > metrics.txt` |
| A run's plan | `GET /api/admin/targets/:id/runs/:runId` |
| A person's state | `GET /api/admin/persons/:id`, `/access`, `/offboarding`, `/provision-receipts` |
| Background work | `GET /api/admin/job-health`; for a support case, a [support bundle](#support-bundles) |
| Database counts | The [reconciliation queries](#reconciliation-checklist) |

The audit log is append-only and hash-chained; note `chainValid` in the
record. A `false` with `brokenAtSequence` is its own SEV1.

#### Closing an incident

- The triggering signal has cleared: a condition clears itself once fixed; an
  event (a failed run, an undelivered webhook) is **Resolved** by someone with
  the area's management permission.
- `/health/ready` is ready and `syntra_readiness` is 1.
- Any lifecycle operation involved reads `completed`.
- The record names every compensating action taken outside Syntra.

Incident response is not itself a change; the rollbacks belong to the runbooks
it sends you to. If something done during the incident made things worse,
record it as its own event before undoing it. Forensic preservation, legal
notification and alert routing (Alertmanager) are outside this runbook.

### Runbook: backup and restore

Take a backup known to be restorable, prove it, restore it, and reconcile what
came back. Use it before any change you cannot otherwise undo (a migration, a
bulk import, a first run against a large target, a key rotation), on the
schedule, when the database is lost or changed beyond the product's own
controls, and as a rehearsal before the first real restore is needed. The
tool is described under [Backups](#backups).

**Needs:** the release layout (`syntra-backup` reads
`/opt/syntra/shared/.env`, runs `pg_dump` inside the `PG_CONTAINER`
container, and stops the `syntra` unit to restore — other shapes are
[below](#compose-and-helm-backups)); root on the host; a role that bypasses
row-level security (the tool uses the user in `SUPERUSER_DATABASE_URL`,
otherwise a role named after the database — a dump taken as `syntra_app` is a
valid archive of no rows, and the tool refuses it); disk for
`SYNTRA_BACKUP_KEEP` copies; and `MASTER_KEY` kept somewhere other than this
host. For a host whose `shared/.env` is not the source of truth the tool
honours `SYNTRA_ROOT`, `SYNTRA_SERVICE`, `SYNTRA_PG_CONTAINER`,
`SYNTRA_PG_ROLE`, `SYNTRA_PG_DB`, `SYNTRA_DATABASE_URL`,
`SYNTRA_SUPERUSER_DATABASE_URL` and `SYNTRA_MASTER_KEY`.

#### Taking and proving a backup

```bash
/opt/syntra/bin/syntra-backup create
/opt/syntra/bin/syntra-backup list          # NAME SIZE VERSION TABLES KEY
/opt/syntra/bin/syntra-backup verify        # the newest; or: verify <name>
```

`create` dumps with `pg_dump -Fc` into `<name>.partial/`, checks the archive
starts with `PGDMP` and lists at least one `TABLE DATA` section, writes
`manifest.json` (time, running version, database, section and byte counts,
the salted key fingerprint), then renames it into place. An interrupted one
stays `.partial`, which `list` shows as `INCOMPLETE` and `restore` refuses.
`KEY` is `ok` when the fingerprint matches the running key, `MISMATCH` when it
does not, `unknown` when either side could not be read.

`verify` restores into a scratch `syntra_verify_<pid>` database in the same
container, runs `ANALYZE`, counts tables and rows, and drops it on exit —
`verified <name> -- N tables, ~M rows, restored and dropped`. Zero is a
failure. Record the figure with the backup's name: it is the first number a
reconciliation compares against.

#### Restoring the live database

This replaces the live database and stops the service while it does.

1. **Take a backup of the current state first** (`syntra-backup create`), so
   the state you are leaving is itself a named backup you can return to.
2. **Capture the before state** with the
   [reconciliation queries](#reconciliation-checklist).
3. **Confirm the key.** `syntra-backup list` must show `KEY ok` for the backup
   you mean to restore. `MISMATCH`: stop, and go to
   [master-key recovery](#a-restore-refuses-over-the-fingerprint). Do not
   reach for `--accept-secret-loss` as a first response.
4. **Tell people.** Sign-in and every SSO flow stop for the duration.
5. **Restore:** `/opt/syntra/bin/syntra-backup restore <name> --yes`. It
   re-checks the archive, compares fingerprints, stops `syntra`, drops and
   recreates `public`, runs `pg_restore --clean --if-exists`, counts tables
   and rows, and only then starts `syntra`. If nothing arrived it says so and
   **leaves the service stopped**, with the dump untouched at
   `/opt/syntra/backups/<name>/database.dump`.
6. **Wait for readiness:** every probe in `curl -s
   http://127.0.0.1:3000/health/ready` is `pass` or `skip`. `vault` failing
   means this host's key is not the one the backup was sealed under.
7. **Reconcile** — the after-state queries and the product checks below.

**A backup older than the running release** leaves the `migrations` probe
reporting pending migrations; the service starts, and the first request that
touches a missing column fails. Apply migrations
([database migration](#runbook-database-migration)) or roll the code back to
the version in `manifest.json`. Do not serve traffic on a half-matched schema.
`syntra-backup restore` drops only `public`; if the pg-boss schema changed
between the two releases, `DROP SCHEMA pgboss CASCADE` by hand before starting
the service.

**If `restore` left the service stopped** because nothing arrived, the live
database is empty and the dump intact: restore it by hand with the
`pg_restore` line from the rehearsal below pointed at the live database, check
the counts yourself, then `systemctl start syntra`.

#### Rehearsing a restore in isolation

Restore somewhere the live deployment cannot be reached from, then reconcile
as you would for real. Use a second host, or on the same host a separate
root, unit, port and database (`/opt/syntra-rehearsal`, `syntra-rehearsal`,
3999, `syntra_rehearsal`; `ops/rehearsal/README.md` uses the same separation
for the updater).

```bash
mkdir -p /opt/syntra-rehearsal/backups
cp -a /opt/syntra/backups/<name> /opt/syntra-rehearsal/backups/      # the directory, so the manifest travels
docker exec <PG_CONTAINER> createdb -U <PG_ROLE> syntra_rehearsal
docker exec -i <PG_CONTAINER> psql -v ON_ERROR_STOP=1 -U <PG_ROLE> -d syntra_rehearsal \
  -c 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;'
docker exec -i <PG_CONTAINER> pg_restore -U <PG_ROLE> -d syntra_rehearsal --clean --if-exists \
  < /opt/syntra-rehearsal/backups/<name>/database.dump
```

`pg_restore` exits non-zero on ownership notices; what arrived is the test,
not its status. (To prove restorability only, `SYNTRA_ROOT=/opt/syntra-rehearsal
SYNTRA_PG_CONTAINER=… SYNTRA_PG_ROLE=… SYNTRA_PG_DB=syntra_rehearsal
syntra-backup verify <name>` does the restore-count-drop cycle for you.)

To run an API against it: a copy of `shared/.env` with `DATABASE_URL` naming
`syntra_rehearsal`, `PORT=3999`, the **same** `MASTER_KEY`, a `PUBLIC_URL`
nothing real resolves to, and `SMTP_URL` pointed at a sink so it cannot mail
anybody. **Clear every target's schedule first** or the rehearsal runs real
provisioning against real directories. The safest rehearsal starts the API
and reads. Check readiness on 3999, reconcile, then stop the unit, `dropdb
syntra_rehearsal` and remove the copy. Write down the date, the backup, the
`tables/rows` figure and any discrepancy: a rehearsal that was not written
down did not happen.

#### Reconciliation checklist

Run before a restore (against the live database) and after (against the
restored one), as the RLS-bypassing role — otherwise every count is zero.
They only read.

```bash
docker exec -i <PG_CONTAINER> psql -U <PG_ROLE> -d <PG_DB> -tA <<'SQL'
SELECT 'tenants',              count(*) FROM "Tenant";
SELECT 'persons',              count(*) FROM "Person";
SELECT 'persons_active',       count(*) FROM "Person" WHERE status = 'active';
SELECT 'contracts',            count(*) FROM "Contract";
SELECT 'users',                count(*) FROM "User";
SELECT 'target_systems',       count(*) FROM "TargetSystem";
SELECT 'target_accounts',      count(*) FROM "TargetAccount";
SELECT 'account_entitlements', count(*) FROM "AccountEntitlement";
SELECT 'lifecycle_ops',        count(*) FROM "LifecycleOperation";
SELECT 'lifecycle_unresolved', count(*) FROM "LifecycleOperation" WHERE status NOT IN ('completed','cancelled');
SELECT 'provision_runs',       count(*) FROM "ProvisionRun";
SELECT 'provision_actions',    count(*) FROM "ProvisionAction";
SELECT 'secrets',              count(*) FROM "Secret";
SELECT 'audit_events',         count(*) FROM "AuditEvent";
SELECT 'audit_max_sequence',   coalesce(max(sequence),0) FROM "AuditEvent";
SELECT 'audit_newest',         coalesce(max("occurredAt")::text,'') FROM "AuditEvent";
SELECT 'migrations_applied',   count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;
SQL
```

Keep a before/after table of these. For a restore every difference should be
"what happened between the backup and now"; anything else is a question to
answer before serving traffic. The audit gap in particular goes into the
incident record: those events are gone, and the chain resumes from the
restored sequence. Then:

1. `GET /health/ready` is ready; `vault` is `pass` (or `skip` on an empty
   install).
2. `GET /api/admin/audit?limit=1` returns `chainValid: true`.
3. **Activity → Attention** lists nothing you cannot explain. A restore that
   brings back an old failure is normal if the fix came after the backup.
4. **Target systems → a target → Test connection** passes: it proves the key
   works for the secret you care about.
5. One SAML or OIDC sign-in succeeds. Signing keys are vault rows; password
   sign-in keeps working with a broken vault and proves nothing.
6. Before running any target, read its plan: accounts written between the
   backup and the restore are at the target and not in the backup, and Syntra
   should catch up with the target rather than pull it back.
7. If tenants were erased after the backup was taken, erase them again
   before serving traffic ([Deleted tenants and backups](#deleted-tenants-and-backups)).

#### Compose and Helm backups

**Compose.** There is no backup tool for it; take the dump with the same
checks the tool makes, and keep the Syntra version beside it by hand:

```bash
docker compose exec -T postgres pg_dump -U syntra -d syntra -Fc > syntra-$(date -u +%Y%m%dT%H%M%SZ).dump
head -c 5 syntra-<stamp>.dump | grep -q PGDMP && echo archive-ok
docker compose exec -T postgres pg_restore -l < syntra-<stamp>.dump | grep -c 'TABLE DATA'
```

Restore: `docker compose stop api web`, drop and recreate `public`,
`pg_restore --clean --if-exists` through `docker compose exec -T postgres`,
reconcile, `docker compose up -d`. The `api` container migrates on start, so a
dump older than the image is brought forward on the way up.

**Helm.** Managed-Postgres point-in-time recovery, or the chart's backup
CronJob, restored as described under
[Backups in Kubernetes](#backups-in-kubernetes). Record the chart's image tag
beside every backup.

Not covered: point-in-time recovery (this is `pg_dump`); getting backups off
the host (point `rsync`, `restic` or an object-store client at the directory);
keeping `MASTER_KEY` (a separate procedure with a separate custodian); and the
target side — accounts in AD or Entra are not in the backup.

### Runbook: master-key recovery

When `MASTER_KEY` is missing, wrong, or not the key a backup was taken under
— or, with Vault Transit or AWS KMS holding the master key, when that provider
stops unwrapping. **Read the whole of this before acting**: the wrong move is a
restore that reports success and has quietly made every stored credential
unusable.

The facts:

- `MASTER_KEY` is 32 random bytes, base64, from the environment (`shared/.env`,
  the compose environment, the Helm Secret). The API refuses to start without
  a well-formed one unless an external provider is configured.
- It is never stored in the database. A backup's manifest records a salted
  SHA-256 fingerprint and nothing else (with an external provider, a
  fingerprint of the key reference).
- Every stored secret is a `Secret` row sealed with its own data key; the data
  key is wrapped by the provider `MASTER_KEY_PROVIDER` names — `local` under
  `MASTER_KEY` with AES-256-GCM, or `vault-transit` / `aws-kms`
  ([Configuration](configure.md#key-management)). Every one authenticates, so
  a wrong key is a loud error, not garbage.
- **`pnpm rekey --status`** counts rows per provider and key version per
  tenant without calling any KMS. Run it first in every procedure below.
- `/health/ready`'s `vault` probe unseals one active signing key per tenant;
  its `key-management` probe wraps and unwraps a canary with the provider,
  bypassing the cache.

**What lives under the key**, and what re-entering it means if the key is
gone for good:

| Secret | How to re-enter |
|---|---|
| Provisioning target credential (AD bind password, SCIM token, Entra/HTTP client secret) | **Target systems → the target**, credential field, Save; or `PATCH /api/admin/targets/:id` with `bindPassword` |
| Directory source bind password | **Sources → the source**; or `PATCH /api/admin/sources/:id` |
| HR feed credential | **Sources → the person source**; or `PATCH /api/admin/person-sources/:id` |
| Upstream identity provider client secret | Re-create the upstream through its API |
| SAML and OIDC signing keys | New keys must be minted. OIDC rotates monthly on the scheduler; SAML has no console button (`rotateKey(tenantId, provider, 'saml')` in `packages/core/src/keys/signing-key-service.ts`), and every SP that pinned the old certificate needs new metadata |
| Webhook signing secrets | `POST /api/admin/webhooks/:id/secret`, then give it to the receiver |
| TOTP secrets | Users re-enrol; remove the dead factor with `DELETE /api/admin/users/:id/factors/:type` |
| Federation PKCE verifiers | Transient; in-flight sign-ins fail once |
| Initial passwords sealed for delivery | Not recoverable; the account gets a new one on the next create or reset |

The `Secret` table's `name` column is the complete inventory:
`SELECT "tenantId", name FROM "Secret" ORDER BY 1,2` as the RLS-bypassing
role.

#### The key is wrong, not lost

The common case: a rebuilt host, a copied `.env` with a fresh placeholder, a
recreated Helm Secret.

1. Confirm: `vault` is `fail` on `/health/ready`, and the log says why
   (`journalctl -u syntra -n 200 --no-pager | grep -i vault`).
2. Compare without exposing the key: `syntra-backup list` shows `KEY ok`
   beside backups taken under the running key. Every recent backup showing
   `MISMATCH` means the running key is the odd one out.
3. Put the original back: release layout, edit `/opt/syntra/shared/.env` and
   `systemctl restart syntra`; compose, export it and `docker compose up -d
   api`; Helm, update the Secret and restart the `api` Deployment.
4. Verify (below).

**Never "fix" a mismatch by generating a new key.** A new key runs, passes
every probe on a fresh install, and unseals nothing that already exists.

#### A restore refuses over the fingerprint

`syntra-backup: this backup was taken under a different MASTER_KEY` is the
control working. Do not add `--accept-secret-loss`. The fingerprint is
`sha256(salt || key)` with the fixed salt `syntra-backup-fingerprint-v1`, so
any candidate key can be checked against the manifest without restoring:

```bash
printf '%s%s' 'syntra-backup-fingerprint-v1' "$CANDIDATE_KEY" | sha256sum
# compare with masterKeyFingerprint in /opt/syntra/backups/<name>/manifest.json
```

Install the matching key as above, then [restore](#restoring-the-live-database)
normally.

#### An external key provider refuses

With `vault-transit` or `aws-kms` the key cannot be wrong in `.env`; access to
it is what fails. The wire answer is redacted; the journal keeps the
provider's own error:

```bash
journalctl -u syntra -n 200 --no-pager | grep -iE 'key-management|master-key provider'
```

| Error | Means | Fix |
|---|---|---|
| `vault-transit: … did not answer` | Vault unreachable (network, DNS, TLS) | Restore the path; check `VAULT_ADDR`, `NODE_EXTRA_CA_CERTS` |
| `vault-transit: … HTTP 503: Vault is sealed` | Sealed after a restart | Unseal Vault |
| `vault-transit: … HTTP 403: permission denied` | Token expired or revoked, AppRole secret id expired, policy changed | New `VAULT_SECRET_ID` / `VAULT_TOKEN`; restore the policy ([Configuration](configure.md#what-each-provider-needs)) |
| `vault-transit: … HTTP 400: … disallowed by policy (too old)` | The row's key version was retired | `pnpm rekey --status`; lower `min_decryption_version`, rekey, raise it again |
| `vault-transit: … HTTP 400: … message authentication failed` | The row is under a different Transit key, or was copied from another tenant | Configure the key `rekey --status` names as `VAULT_TRANSIT_PREVIOUS_KEY`; a row copied between tenants is tampering — open an incident |
| `aws-kms: … AccessDeniedException` | The role lost `kms:Encrypt` / `Decrypt` / `GenerateDataKey`, or the key policy changed | Restore the grant |
| `aws-kms: … DisabledException` | The key was disabled | `aws kms enable-key` |
| `aws-kms: … KMSInvalidStateException` | Pending deletion | `aws kms cancel-key-deletion`, then enable — only within the waiting period |
| `aws-kms: … IncorrectKeyException` | Rows sealed under a different key than `AWS_KMS_KEY_ID` | Configure it as `AWS_KMS_PREVIOUS_KEY_ID` |
| `aws-kms: … TimeoutError` / `NetworkingError` | Endpoint unreachable | Restore the path, or set `AWS_KMS_ENDPOINT` to the VPC endpoint |

Until access returns, data keys cached within `MASTER_KEY_CACHE_TTL_SECONDS`
still read, every other secret read and every secret write fails, and password
sign-in is unaffected ([Configuration](configure.md#outages-and-revocation));
nothing needs restarting once the provider answers. **Do not switch to a local
key to "get going"**: KMS-wrapped rows cannot be read by any local key. A KMS
key actually deleted after its waiting period is the case below; alarm on
`ScheduleKeyDeletion` in CloudTrail so it never gets there.

#### When the original key is genuinely gone

There is no recovery of the sealed values. The choice is between the database
without its secrets and no database.

1. **Decide, and record who decided** — this is an incident.
2. **Generate a new key once, and back it up before using it:**
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
3. If you were restoring: `syntra-backup restore <name> --yes
   --accept-secret-loss`. If the database is simply running under a lost key,
   install the new key and restart.
4. **Re-enter everything in the inventory**, in this order: signing keys (so
   SSO returns — the `vault` probe stays failed until they are replaced);
   target and source credentials, testing each; webhook secrets, telling each
   receiver; upstream IdP secrets; then announce TOTP re-enrolment.
5. **Take a fresh backup** and confirm `list` shows `KEY ok` for it.

`--accept-secret-loss` has no rollback. That is why the procedure insists on a
backup of the current state and a written decision first.

#### Verifying the key

- `/health/ready`: `vault` and `key-management` are `pass`; `syntra_readiness`
  is back to 1.
- **Test connection** succeeds on each target.
- One SAML and one OIDC sign-in succeed.
- A new `syntra-backup create` shows `KEY ok`.

Rotating a key that works, and moving to a KMS, are not recovery: see
[rotating the master key](#rotating-the-master-key). **Restoring a backup from
before a KMS migration** into a deployment that has moved: its rows are
wrapped by the old local key, so configure that key as `MASTER_KEY` beside the
KMS (decrypt-only), restore, `pnpm rekey --yes`, and remove it again. Azure
Key Vault and GCP KMS are not implemented.

### Runbook: database migration

Apply schema migrations and know whether the schema and the code agree. The
mechanism is `prisma migrate deploy`, run as `pnpm --filter @syntra/db
migrate` from `packages/db`, where Prisma 7 finds its configuration
(`packages/db/prisma.config.ts`; the CLI looks only in its working directory,
which is why every caller runs from there). **There is no down migration:
rollback is a database restore.** Use it when upgrading to a release with new
migrations, when the `migrations` probe fails, and after restoring a backup
older than the code.

Migrations run as the application role (`syntra_app`), so the tables they
create are owned by it — which is what makes `FORCE ROW LEVEL SECURITY` bind.
Take a verified backup immediately before; `syntra-update`'s own
pre-migration dump is not a substitute for your schedule. Nothing measures
migration duration for you; plan a window if the release notes say a
migration is long.

#### Checking migration state

- **Readiness** (`packages/db/src/migration-state.ts`): the `migrations` probe
  passes with `N applied`, or `N applied (M newer than this build)` after a
  rollback to older code; it fails with `K migration(s) not applied: …` or `K
  migration(s) started and did not finish: …`. The names are in the process
  log.
- **Prisma:** `cd /opt/syntra/current && pnpm --filter @syntra/db exec prisma
  migrate status` (compose: `docker compose exec api pnpm --filter @syntra/db
  exec prisma migrate status`).
- **The bookkeeping table**, which both read: `SELECT migration_name,
  finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY
  migration_name`. Applied means `finished_at` set and `rolled_back_at` null.

| State | Meaning | Action |
|---|---|---|
| `pending` | On disk, never applied: schema behind code | Apply |
| `failed` | Started and not finished, or rolled back: tables in a state no migration describes | Restore, then apply. Re-running `migrate deploy` over a failed row is refused by Prisma |
| `unknown` | Applied, absent from disk: code behind schema — normal right after a rollback to an older release | Reported, not failed. Move forward again, or restore a matching dump |

Migration names sort the replay order, and the tree holds migrations named
with dates ahead of the real clock. A new migration named with today's real
timestamp would sort before migrations production already applied and, on a
fresh database, run before the columns it references exist.
`packages/db/src/migration-order.ts` sets a floor
(`MIGRATION_NAME_FLOOR`) and its test refuses any new name at or below it:
rename what `prisma migrate dev --create-only` generates to sort after every
existing migration. An operator does not touch this; it is here because a
migration that sorts wrong looks like a corrupt database.

#### Migrating on the release layout

`syntra-update` migrates as one step of an update and rolls itself back if
readiness does not return (see [Updating](#updating)):

1. `syntra-backup create` and `syntra-backup verify`.
2. `syntra-update --check`.
3. `syntra-update <version>`, or **Update** in the console.
4. Watch `cat /opt/syntra/var/update.status` until `succeeded`,
   `rolled_back` or `failed`.
5. Verify (below). Rollback is `syntra-update --rollback`, which restores the
   pre-migration dump and relinks the previous release; anything written in
   between is lost — say so in the record.

#### Migrating on the compose path

The `api` image runs `pnpm --filter @syntra/db migrate` before it starts the
server; there is no separate step and no automatic rollback.

1. Take a dump ([compose backups](#compose-and-helm-backups)).
2. `export SYNTRA_VERSION=1.5.0 && docker compose pull api web && docker
   compose up -d`. The `web` service waits on the `api` health check
   (`/health/ready`), so nginx does not serve until migrations have applied.
3. Watch `docker compose logs -f api` and `docker compose ps`. An `api`
   container restarting repeatedly is a migration or startup that failed; read
   the log before touching anything.
4. Verify. If it failed: `docker compose stop api web`, restore the dump, set
   `SYNTRA_VERSION` back, `docker compose up -d`.

#### Migrating on Helm

The chart's `<release>-migrate` Job runs `pnpm --filter @syntra/db migrate` as
a `pre-install,pre-upgrade` hook (`backoffLimit: 1`; a failed Job is kept for
a day so its log can be read; `migration.enabled: false` turns it off). Under
PgBouncer it needs a direct connection (`secretKeys.migrationDatabaseUrl`).

1. Back up the database with the provider's tooling.
2. Set the new immutable image tags in the values file.
3. `helm upgrade --install syntra ./deploy/helm/syntra --namespace syntra -f
   values-<env>.yaml`. Helm aborts the upgrade if the Job fails, so the old
   Deployment keeps running on a schema that may be **partly ahead** of it;
   check the state before retrying.
4. A failed Job: `kubectl -n syntra get jobs`, `kubectl -n syntra logs
   job/syntra-migrate`.
5. Verify. `helm rollback` restores the images but **not** the database: the
   older code then reports `unknown` migrations and passes readiness, which is
   tolerable only if the release notes say the migration was additive.
   Otherwise restore the database too.

#### Verifying a migration

1. `/health/ready` is ready, with no pending and no failed names.
2. `_prisma_migrations` lists every directory in the release's
   `packages/db/prisma/migrations`, finished.
3. `syntra_build_info` reports the intended version; `syntra_readiness` is 1.
4. Sign in, open **Activity → Attention**, one target and one person — a
   half-applied migration fails on the first route that touches the new
   column, and these touch the most tables.
5. The [reconciliation counts](#reconciliation-checklist) have not moved.

`pnpm db:reset` has no place here: it empties a database and is refused for
anything not named in `SYNTRA_ALLOW_RESET`. Some releases carry a backfill
job that runs after start; the release notes say so.

### Runbook: secret rotation

Rotate each credential a deployment holds or issues, and know what rotating
it does to running sessions, integrations and scheduled work. Before any of
it, take a verified backup. Random values:
`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.

| Secret | Lives in | Rotate by | Effect |
|---|---|---|---|
| `SESSION_SECRET` | environment | new value, restart | Console and portal sessions **survive**; in-flight OIDC interactions fail once |
| Master key (`MASTER_KEY`, or the Transit / KMS key) | environment, or the KMS | old key decrypt-only, `pnpm rekey --yes`, remove old key | None if done in order ([below](#rotating-the-master-key)) |
| `METRICS_TOKEN` | environment | new value, restart, update scraper | Scrapes 401 until the scraper is updated |
| `SMTP_URL` credential | environment | new value, restart | Queued mail retries under the new credential |
| `MAIL_GRAPH_CLIENT_SECRET` | environment | second secret in Entra, new value, restart, delete the old | None if the old is deleted after the restart |
| `GOVERN_CHECKPOINT_KEY` / `_ID` | environment | new value and id, restart | One-time `critical` finding (below) |
| `RELEASE_TOKEN` | `shared/.env` | revoke in GitHub, new token; no restart | Updates fail with an auth error until replaced |
| Postgres passwords | environment and role | `ALTER ROLE`, then environment, restart | `database` probe fails until both agree |
| Target credential (AD bind password, SCIM token, Entra client secret) | vault | **Settings → Credentials → Rotate**, or `PATCH /api/admin/targets/:id` | Next run uses it; cached access tokens dropped |
| Directory source bind password | vault | **Settings → Credentials → Rotate**, or `PATCH /api/admin/sources/:id` | Next sync uses it |
| HR feed credential | vault | **Settings → Credentials → Rotate**, or `PATCH /api/admin/person-sources/:id` | Next import uses it |
| Upstream IdP client secret | vault | API only | Immediate |
| API tokens, including the SCIM machine token | hashed in `ApiToken` | issue new, install at the caller, revoke old | Old token refused from revocation |
| Webhook signing secret | vault | `POST /api/admin/webhooks/:id/secret` | Deliveries after the call are signed with the new secret |
| SAML signing key | vault | `rotateKey(tenantId, provider, 'saml')`; no console or CLI | Every SP that pinned the certificate breaks until reconfigured |
| OIDC signing key | vault | automatic, monthly | Outgoing key published beside the incoming one for a week |

For stored secrets you need the route's permission: `provision.manage`
(targets), `sync.manage` (sources), `token.manage` (API tokens),
`tenant.manage` (webhooks).

#### `SESSION_SECRET`

It signs the OIDC provider's interaction cookies; the session cookie itself
is a random token looked up by hash in the `Session` table, so sessions are
not tied to it. Generate a value (at least 32 characters; the
`.env.example` placeholder is refused), replace it, restart (`systemctl
restart syntra`, `docker compose up -d api`, or the `api` Deployment). There
is no dual-key window, so choose a quiet minute; an OIDC sign-in mid-flow at
the restart fails once and succeeds on retry.

#### Rotating the master key

The master key wraps every stored secret's data key, so changing it is a
**rewrap**, not a re-entry: `pnpm rekey --yes` (`packages/db/src/rekey.ts`,
operator-run, never a web route) unwraps each data key with whichever
configured key recognises it and wraps it again under the provider
`MASTER_KEY_PROVIDER` names. Secret values are never decrypted. Every variant
has the same shape and the same safety property — between the steps the
deployment reads both old and new rows, because the old key is configured
*decrypt-only*:

| Changing | Step 1: configure, restart | Step 3: remove, restart |
|---|---|---|
| Local key → new local key | `MASTER_KEY=<new>`, `MASTER_KEY_PREVIOUS=<old>` | `MASTER_KEY_PREVIOUS` |
| Local key → Vault Transit | `MASTER_KEY_PROVIDER=vault-transit` and its variables; keep `MASTER_KEY` | `MASTER_KEY` |
| Local key → AWS KMS | `MASTER_KEY_PROVIDER=aws-kms` and its variables; keep `MASTER_KEY` | `MASTER_KEY` |
| Transit key → another | `VAULT_TRANSIT_KEY=<new>`, `VAULT_TRANSIT_PREVIOUS_KEY=<old>` | `VAULT_TRANSIT_PREVIOUS_KEY` |
| KMS key → another | `AWS_KMS_KEY_ID=<new>`, `AWS_KMS_PREVIOUS_KEY_ID=<old>` | `AWS_KMS_PREVIOUS_KEY_ID` |
| A Transit key's version | `vault write -f transit/keys/<key>/rotate`; no Syntra change | raise `min_decryption_version` |
| A KMS key's backing material | KMS automatic rotation; nothing to do | nothing; no rekey needed |

Moving directly between Vault and AWS is not supported: go through a local
key.

1. **Back up** (`syntra-backup create`). With a local key, put the *new* key
   in the secret store now, before it seals anything.
2. **Configure and restart** (step 1 of the table). For an external provider,
   check it answers: `key-management: pass` on `/health/ready`, and the log
   line naming the provider (`journalctl -u syntra -n 50 | grep -i
   'master-key provider'`), which also warns about each decrypt-only key
   still configured.
3. **See what there is to move:** `pnpm rekey --status` (compose: `docker
   compose exec api pnpm rekey --status`). It calls no KMS.
4. **Rewrap:** `pnpm rekey --yes`. It checks the new provider with a canary
   first and touches nothing if that fails, then works one transaction per
   tenant; a failure rolls back that tenant and stops. It is safe to run
   again. Each tenant gets a `vault.data_keys_rewrapped` audit event.
5. **Check** `pnpm rekey --status` shows only the new provider (and, for
   Transit, only the latest version). `local=` anywhere is a tenant not
   finished — run step 4 again and read its error.
6. **Remove the old key** (step 3 of the table) and restart every replica.
   Then `vault` and `key-management` pass, one SAML and one OIDC sign-in
   succeed, and **Test connection** passes on a target.
7. **Take a fresh backup** and confirm `KEY ok`. With an external provider the
   manifest fingerprints the key reference, so backups keep matching after the
   move; backups from before it show `MISMATCH`. **Keep the old local key
   until those backups expire** — it is the only thing that reads them.

To **retire a Transit version**, run steps 3–5 with no configuration change
(rekey moves every row to the latest version), then `vault write
transit/keys/<key>/config min_decryption_version=<latest>`. Backups taken
before the rekey become unreadable with it; lower the setting again to
restore one.

Rollback before step 6: rows already moved are unreadable to the old
configuration, so rekey in the other direction first (swap current and
previous), then put it back. After step 6, add the old key back decrypt-only.
A master key that was **exposed** can still unwrap every data key in every
backup taken before the rekey; for an exposure that matters, also re-enter the
high-value secrets themselves after the rekey.

#### `METRICS_TOKEN`

Generate a value of at least 16 characters; set it in the scraper's
`bearer_token` without reloading; replace it in the environment and restart
the API; reload the scraper. Check `curl -s -o /dev/null -w '%{http_code}' -H
"Authorization: Bearer <new>" http://127.0.0.1:3000/metrics` is 200 and the
old value 401. Unsetting it unregisters the route (404).

#### Outgoing mail credentials

**`SMTP_URL`:** replace the credential, restart, then cause one mail — a
password reset for a test account, or assign a lifecycle operation to
yourself. A `notification_undelivered` incident means the outbox gave up after
five attempts; the outbox is the test.

**`MAIL_GRAPH_CLIENT_SECRET`** (`MAIL_TRANSPORT=graph`): an app registration
can hold two client secrets at once. Add a new one in Entra (**Certificates &
secrets**; copy the **value**, not the id), replace the variable (or the
Secret key `secretKeys.mailGraphClientSecret` names), restart — the Graph
token is cached per process — then check **Operations → Service status**'s
mail check (it acquires a token and sends nothing) and cause one mail.
`invalid_client` / `AADSTS7000215` means the value was copied wrong. Then
delete the old secret.

#### Connector credentials

Targets, directory sources and HR feeds share a **dual-secret rotation**
([Configuration](configure.md#rotating-a-connector-credential)):

1. Create the new credential at the issuer. **Keep the old one valid.**
2. **Settings → Credentials**, the entry, **Rotate**: paste the new secret
   (and its expiry at the issuer, if known), **Stage new secret**
   (`POST /api/admin/credentials/rotations`).
3. **Test staged secret** (`…/rotations/:id/verify`). Fix a failure at the
   issuer and test again, or cancel.
4. **Cut over** (`…/cutover`): refused unless the test passed within a day
   against the configuration as saved now. The old secret is kept.
5. Optionally **Run now** on the target for a full read under the new secret.
6. **Complete and erase old secret** (`…/complete`): tests again, and on
   success erases the kept secret and records a readiness check. On failure
   nothing is erased; **Roll back** (`…/rollback`) restores the old one.
7. Revoke the old credential at the issuer.

The rotation's evidence (`GET /api/admin/credentials/rotations/:id`) and its
`credential.rotation_*` audit events are the change record, and the declared
expiry schedules the next warning. Replacing the credential directly —
paste it into the target or source, **Test connection** (for an unsaved one,
`POST /api/admin/targets/test`, `/sources/test`), Save — still works and is
audited as `credential.changed`, with no overlap and no pre-test of the saved
configuration. For Entra the credential is the app registration's client
secret (the tenant and client ids are configuration); a wrong one comes back
as `the token endpoint answered HTTP 401 (AADSTS…)`, the AADSTS code being
the only part of Microsoft's answer kept.

Saving or cutting over clears the OAuth access-token caches **in the API
process that handled it**. Other API replicas keep a token minted under the
old secret for up to its lifetime (about an hour) — harmless after a correct
rotation, misleading after a wrong one: runs on those replicas keep working
until the cached token expires. Treat **Test connection** as the truth, and
restart the replicas if the cache must go now.

For an SFTP HR feed, the server's host key is pinned separately
(`POST /api/admin/person-sources/:id/host-key`); a rotated server key is a
different change from a rotated credential. Entra client secrets are read for
expiry only when the app registration was granted `Application.Read.All`;
otherwise declare the expiry on **Settings → Credentials**, or the first
warning is a failed run.

#### API tokens, including the SCIM machine token

Tokens are `syntra_pat_…` bearer credentials, hashed at rest and shown once.

1. Issue a new one on the same service account: **Users → Accounts → the
   account → API tokens**, or `POST /api/admin/users/:id/tokens`. Set an
   expiry (the console suggests ninety days).
2. Install it at the caller (the IdP's provisioning configuration).
3. Confirm the caller used it: the token list shows last use.
4. Revoke the old one: `DELETE /api/admin/users/:id/tokens/:tokenId`.

`api_token.issued` and `api_token.revoked` are in the **Credentials** webhook
group. Revoking the service account's role revokes every token it issued at
once — that is the emergency stop. Revoked tokens cannot be un-revoked.

#### Webhook signing secrets

`POST /api/admin/webhooks/:id/secret` returns `{ endpoint, secret }` with the
new secret **once** and records `notify.webhook_secret_rotated`. Deliveries
from then on are signed with it (pending retries are re-signed at send time),
and the receiver rejects them until updated — hand it over before or at once.

#### Signing keys

- **OIDC** keys rotate monthly on the scheduler; the failure mode is silent,
  which is what `SyntraSigningKeyExpiring` is for. When it fires, the
  scheduler is the first suspect ([scheduler unavailable](#scheduler-unavailable)).
- **SAML** keys last three years and are never rotated automatically.
  `rotateKey(tenantId, provider, 'saml')` is the only way — no console button
  or CLI — and every service provider that pasted the certificate must be
  reconfigured, so plan it as a change with every SP owner. The credential
  inventory warns ahead of the active key's `notAfter`, and every rotation is
  audited as `signing_key.rotated`.

#### `GOVERN_CHECKPOINT_KEY`

Optional; signs Govern's audit checkpoints. Turning it on for the first time
refuses the pre-existing unsigned checkpoint once, walks the chain from
genesis once, and raises one `critical` finding that clears on the following
run. A change of key is not further documented in the code beyond
`GOVERN_CHECKPOINT_KEY_ID` naming the key: expect the same one-time finding,
and keep the old key until a checkpoint has been established under the new
one.

#### Database role passwords

Compose path:

1. `docker compose exec postgres psql -U syntra -c "ALTER ROLE syntra_app
   PASSWORD '<new>'"`.
2. Export the new `SYNTRA_APP_PASSWORD` and `docker compose up -d api`.
3. The `database` probe passes.

`POSTGRES_PASSWORD` is read only when the volume is first initialised;
changing it later changes nothing. Use `ALTER ROLE syntra PASSWORD`, then
update the variable so a future re-initialisation matches. On the release
layout or Helm, the same order: `ALTER ROLE`, then the URL, then restart.

**Verifying any rotation:** `/health/ready` is ready; **Activity →
Attention** shows nothing new; the audit log carries the rotation event where
one exists; the old credential is refused where that can be tested. Rolling
back an environment secret is putting the old value back and restarting;
a stored credential's previous value cannot be read back out of Syntra.

### Runbook: target rollback

Stop a provisioning target from doing anything further, deal with a run that
is wrong or held, and put back what a bad mover changed. You need
`provision.read` to look and `provision.manage` to act (a mover also needs
`identity.write`), and the target's id.

The vocabulary: a **run** reads the target, computes a plan and lands
`previewed` or `blocked`; applying moves it through `applying` to `applied` or
`partially_applied`; a run that could not read the target is `failed`. Each
**action** is one proposed change: `create_account`, `update_account`,
`enable_account`, `disable_account`, `archive_account`, `rename_account`,
`grant_entitlement`, `revoke_entitlement`, `deactivate_syntra_user`,
`reactivate_syntra_user`, `create_container`. **There is no delete of any
kind, and no type that could become one.** Action statuses are `proposed`,
`in_flight`, `applied`, `failed`, `conflict`, `pending_retry`, `superseded`.

The guard is described under [Safety thresholds](#safety-thresholds); on the
API the settings are `createAccountThresholdPercent`,
`disableAccountThresholdPercent`, `archiveAccountThresholdPercent` (container
moves too), `revokeEntitlementThresholdPercent`,
`deactivateSyntraUserThresholdPercent`, `perEntitlementThresholdPercent` and
the absolute `maxContainerCreatesPerRun` — all confirmable — and
`personPopulationDropPercent`, which is **not**. Nor are an empty target that
has had a run applied, a threshold that is not a percentage, or an axis with
no denominator. `autoApply` never confirms anything. Additive actions (enable,
grant, rename, reactivate, attribute-only update) are not thresholded: they
are visible in the plan and reversible by the next run.

#### Stopping a target

From least to most disruptive; each takes effect on the scheduler at once.

1. **Turn off automatic apply** — runs still produce plans; nothing is applied
   without a person. Uncheck **Apply scheduled runs automatically**, or
   `PATCH /api/admin/targets/:id { "autoApply": false }`.
2. **Unschedule** — no runs; **Run now** still works.
   `PATCH /api/admin/targets/:id { "schedule": null }`.
3. **Disable** — unscheduled and marked disabled; incidents stop counting it
   as stale. Uncheck **Enabled**, or `{ "enabled": false }`. Nothing is lost,
   and re-enabling restores the saved schedule.

**Emergency write stops** change what a run may *do* rather than what runs:
while one is active no connector write is attempted, and every apply is
refused before the run enters `applying` — the run stays as previewed and can
be applied unchanged later. Reads, previews, drift and evidence keep working,
which is what the people investigating need. A manual account move is refused
too (its placement is still recorded), a scheduled automatic-apply run records
a visible skip, and a person's provisioning receipt is left `blocked`, not
`failed`.

| Scope | Console | API (`provision.manage`) |
|---|---|---|
| One target | **Target systems → the target → External writes → Stop writes** | `POST /api/admin/targets/:id/external-write-stop` / `external-write-resume` |
| Every target in the tenant | **Target systems → Tenant-wide external writes → Stop writes** | `POST /api/admin/provision/external-write-stop` / `external-write-resume` |

Placing one needs a `reason` and may carry an `expiresAt` up to 30 days out.
Resuming early needs a reason and a **different administrator** from the one
who placed it (`403 four-eyes-required`). Expiry is honoured at the apply
boundary the moment it passes, and a once-a-minute sweep closes the stop.
When both are active a refusal names the tenant stop (`409
external-writes-paused`, `scope: "tenant"`), because it is the one to lift
first. Every transition is audited (`provision.{tenant,target}.external_writes.pause`,
`.resume`, `.expire`) and is a security event, so a webhook endpoint
subscribed to **Emergency write stops** hears about it. Stopping the API
stops everything; the tenant stop contains writes and leaves everything else
running.

Deleting a target (`DELETE /api/admin/targets/:id?confirm=true`) removes
Syntra's record of the accounts it manages and never touches the accounts; it
is not a rollback.

#### A run that should not be applied

1. Open it: **Target systems → the target → Runs → the run**, or `GET
   /api/admin/targets/:id/runs/:runId` — actions in apply order, each with the
   person, and `requiresConfirmation` where the guard demands it.
2. **`previewed`**: leave it, or **Cancel** it
   (`POST /api/admin/targets/:id/runs/:runId/cancel`). An unapplied run
   applies nothing. On an automatic-apply target the next scheduled run
   computes a fresh plan and applies it, so [stop the target](#stopping-a-target)
   first if the fresh plan would be the same wrong plan.
3. **`blocked`, held for confirmation**: read the reason. Confirming is
   **Apply** with the confirmation box (`POST …/runs/:runId/apply` with
   `{ "confirm": true }`). Do not confirm a run you have not read to the end.
   A hold is never stepped over by a retry — only confirming or cancelling it
   resolves it, and until then later scheduled and hand-started runs on the
   target are skipped ([Runs that replace a waiting run](#runs-that-replace-a-waiting-run)).
4. **`blocked`, refused outright**: nobody can apply it (`409
   run-unconfirmable`). Fix the cause — the HR feed, the target's
   reachability, a threshold that is not a percentage — and run again; the
   new run supersedes it.

#### Applying part of a run

`POST /api/admin/targets/:id/runs/:runId/apply` with `{ "only": ["<actionId>",
…], "confirm": true }` when a chosen action needs confirmation; the console
has a box per action and **Apply N actions**. Applying part of a run **ends
it**: the rest is not attempted, the run ends `partially_applied`, and the
next run proposes again whatever is still wanted. Use it to let a leaver's
disable through while holding a hundred questionable revocations.

#### A run that was applied and was wrong

Nothing an apply does is a delete, so every applied action has an inverse the
next run proposes once the inputs are corrected — **correct the inputs, run,
review, apply**:

| Applied | The next run proposes |
|---|---|
| `disable_account` | `enable_account` (confirmation needed outside `reenableWithoutConfirmationDays`) |
| `archive_account` (a container move) | `update_account` moving it back, under the archive threshold |
| `revoke_entitlement` | `grant_entitlement`, unthresholded |
| `grant_entitlement` | `revoke_entitlement`, thresholded |
| `deactivate_syntra_user` | `reactivate_syntra_user` |
| `update_account` | another `update_account` |
| `create_account` | nothing removes it; it can be disabled |
| `create_container` | nothing removes it |

#### Reverting a mover

A mover is a contract change (department, job title, cost centre, employer,
location, manager, FTE) that changes which rules match a person. It arrives by
an HR import, by **Change employment** on the person (`POST
/api/admin/persons/:id/mover/preview`, then `/mover/apply`), or by editing a
contract (`PATCH /api/admin/persons/:id/contracts/:sequence`).

1. [Stop the target](#stopping-a-target), at least automatic apply.
2. Find what was applied: the run's actions for the person, or `GET
   /api/admin/audit?subject=<personId>`.
3. **Correct the data at its source.** A wrong feed: fix it and re-run the
   import (preview, then apply). A hand edit: edit it back. **Change
   employment**: use it again with the previous values — the preview shows the
   diff and the access it would keep; a stale preview is refused (`409
   stale-preview`).
4. **If the rule was wrong**, not the data: the target's **Business rules**;
   `POST /api/admin/targets/:id/rules/impact` previews how many people a
   condition matches before `PUT /api/admin/targets/:id/rules` saves it. A rule
   matching nobody after a change is usually a malformed condition.
5. **Run now** and read the plan: enables and grants for what the mover
   removed, revocations for what it wrongly granted — and expect the
   per-entitlement threshold to hold the run if a revocation is a large share
   of one group.
6. Apply, whole or in part.
7. A person wrongly deactivated as a leaver: `POST
   /api/admin/persons/:id/reactivate`, then run. Revoked sessions stay revoked;
   the person signs in again.
8. Verify on the person (`GET /api/admin/persons/:id/access`) and at the
   target, then restore the schedule and automatic apply.

#### A credential or target that stopped working

Runs start and fail; `lastRunAt` stops moving (it is written by a finished
preview); `provision_run_failed` appears at once and, after two days or twice
the cadence, `target_never_completed`. Replace the credential
([connector credentials](#connector-credentials)), then **Run now**. Actions
left `pending_retry` are picked up by the next run **only if its plan still
wants them**; actions left `in_flight` by a process that died are resolved by
the next preview asking the target what actually happened.

#### A canary adapter release that misbehaves

A target moved to the canary channel, or pinned to a new adapter release,
writes something unexpected or starts refusing actions.

1. Stop writes if anything is still applying.
2. On the target, **Adapter release → Rollback**, with a reason (`POST
   /api/admin/targets/:id/adapter/rollback { "reason": "…" }`). The target is
   pinned to the last certified release it ran, at once. Only the adapter
   selection changes; `provision.target.adapter.rollback` names both versions.
3. **Preview again.** A run previewed under the canary refuses to apply (`409
   adapter-version-changed`).
4. Resume writes once the new preview reads correctly.

#### Verifying a target

- `GET /api/admin/targets/:id` shows the `enabled`, `schedule` and
  `autoApply` you intended, and `consecutiveSkippedRuns` is 0 after the next
  scheduled run.
- The latest run is `applied`, or `partially_applied` with every unapplied
  action carrying a message you expected.
- `GET /api/admin/targets/:id/drift` has no new open findings you cannot
  explain; acknowledge the ones you can (`PATCH /api/admin/drift/:id`).
- The target is gone from **Activity → Attention**.

#### What cannot be undone

- **Provisioning never deletes anything at a target.** The AD connector
  refuses a delete before it binds; Entra's only removal is `DELETE
  /users/{id}`, which the connector cannot express. Archiving is a container
  move (AD) or `accountEnabled: false` (Entra); deletion after that is the
  target's own business ([leavers](#leavers-archive-in-syntra-delete-in-the-domain)).
  An unrecoverable write driven by a timer, from a service holding bind
  credentials for every tenant's directory, is a bad trade.
- **The one delete that exists** is a directory write-back delete of a Syntra
  login (`DELETE /api/admin/users/:id`), gated on `directory.delete` and the
  source's write-back delete switch, both off by default. It cannot be undone
  from Syntra.
- **Initial passwords** delivered on a create are not retrievable.
- **Revoked sessions and tokens** stay revoked.
- **The audit log** is append-only; only a restore removes entries, and it
  removes everything after the backup.

### Runbook: queue recovery

Background work has a **row** that says what state it is in and a pg-boss
**job** that moves it. This is for when the two disagree — a run that says
`queued` with nothing behind it, a provisioning apply whose process died, a
job that fails on the same payload again and again — after a
`SyntraJobs*` alert, a run page stuck far longer than usual, or a node drain,
OOM kill or database failover. Reading needs `audit.read`, repairing
`tenant.manage`. The metrics carry no tenant label: sign in to each tenant's
console (or ask its administrator) to see which work is affected. The
findings and repairs are described under
[Background work and job health](#background-work-and-job-health).

| Finding | Safe repairs |
|---|---|
| `orphaned` | A queued run, export or target operation: **requeue** or **mark failed**. A reading run or a generating export: **mark failed**. A provisioning apply: **release** |
| `stuck` | As for orphaned where no worker is running it; none while a live worker holds it |
| `delayed` | None: the queue is behind ([below](#the-queue-is-behind)) |
| `duplicated` | None needed: every worker claims its row conditionally, so the extra job does nothing. Find the double enqueue |
| `poisoned` | None: fix the cause (the finding names its error class) and let the schedule or a person start it again |
| `saturation_deferred` | None needed: it retries every 30 s. Raise the cap in **Lifecycle policy** if it persists |

Nothing is reported orphaned while the queue cannot be read —
`syntra_job_queue_readable` is 0 and the page says so.

1. **Open Operations → Background work** in the affected tenant, or `GET
   /api/admin/job-health`, and read the finding's sentence: what the row is
   doing and why it is a finding.
2. **Check the cause before repairing.** After a drain or a crash the repair is
   all that is needed. A finding that comes back after a repair means
   something is still wrong: the scheduler (`syntra_scheduler_running`), the
   database, or — for `poisoned` — the payload.
3. **Repair**, with a reason of at least ten characters (it goes into the
   audit event and, for mark failed, onto the row): **Requeue** enqueues the
   job the row is missing, only where no worker has started; **Mark failed**
   ends a row nothing is working on (a waiting cancellation is honoured
   instead); **Release** closes a dead provisioning apply as
   `partially_applied`, leaving its `in_flight` actions for the next preview to
   verify against the target. Nothing here re-runs a connector write.
4. **Verify:** reload — the finding is gone, a second press answers *nothing
   to do*, and the audit log has `job_health.requeue`, `.mark_failed` or
   `.release_lease` with the reason and the before and after status.

Deliberately not repairable here: **lifecycle operations** (retry them on the
operation's page, where a retry after an ambiguous target outcome needs fresh
verification evidence); **directory sync and HR import runs in `applying`**
(no heartbeat, so apply the run again — it resumes — or cancel it); and
**pg-boss's own rows**, which nothing here edits or deletes. A repair needs no
back-out: an unneeded requeue claims nothing, a run marked failed or released
is reviewable history that the next run re-proposes from, and released
actions are verified before anything new is planned.

#### The queue is behind

`delayed` findings, or `SyntraJobQueueDeep`: the scheduler is running and not
keeping up. Check the API's CPU and event-loop lag, the database's connection
pool ([connection-pool sizing](#connection-pool-sizing)), and whether one
tenant's scheduled work dominates. More API replicas are more workers.

For the record: the findings (the page, or the JSON from `GET
/api/admin/job-health`), each repair's audit event, and for a support case a
**support bundle** (**Operations → Support bundle**), which carries job health
and recent failures by error class with no personal data.

### Runbook: scale validation

A repeatable rehearsal of paging and restore at 10,000 people and 10,000
lifecycle operations. **Only ever against an isolated, disposable database** —
never the one behind a running deployment.

1. Restore a current schema into a disposable database.
2. Insert a dedicated fixture tenant, 10,000 synthetic people and 10,000
   lifecycle operations, every row carrying an obvious `scale-` marker.
3. `ANALYZE` after the bulk insert; plans before statistics are not evidence.
4. Capture `EXPLAIN (ANALYZE, BUFFERS)` for people paging and open-operation
   paging at page size 50, recording the database version, hardware, row
   counts, cold or warm cache, and the query text with the plan.
5. Back it up, restore to a second disposable database, and reconcile person,
   lifecycle-operation and migration counts before teardown.

Accept when person paging uses `Person_tenantId_familyName_givenName_idx`,
open-operation paging uses `LifecycleOperation_open_queue_updatedAt_id_idx`,
the restored copy's counts match, and no write command named the production
database.

The audit log's rehearsal runs inside the suite instead:
`packages/core/src/audit/audit-search.test.ts` inserts 100,000 events into one
tenant, runs `ANALYZE`, and asserts for the exact statement the service runs
that no plan sequentially scans, each filter uses its index, and no page
touches 500 or more blocks (`SYNTRA_PRINT_PLANS=1` prints the plans).
Recorded on 23 September 2026 (PostgreSQL in Docker on a workstation, warm
cache):

| Page | Plan | Blocks | Time |
| --- | --- | --- | --- |
| Newest, no filter | Index scan `AuditEvent_tenantId_sequence_key` | 6 | 0.03 ms |
| Keyset page at sequence 50,000 | same | 9 | 0.05 ms |
| Common actor (2 %) | `AuditEvent_tenantId_actorUserId_sequence_idx` | 54 | 0.09 ms |
| Rare actor (10 events) | same | 13 | 0.03 ms |
| One target (50 events) | `AuditEvent_tenantId_targetId_sequence_idx` | 53 | 0.08 ms |
| Failures (5 %) | `AuditEvent_tenantId_outcome_sequence_idx` | 43 | 0.07 ms |
| Action prefix `auth.` (20 %) | sequence index, filtered | 16 | 0.05 ms |
| Action prefix `export.download` (5 %) | sequence index, filtered | 53 | 0.14 ms |
| Rare, oldest action (50 events) | `AuditEvent_tenantId_action_prefix_idx` + sort | 6 | 0.06 ms |
| One day in the middle of the log | two one-row lookups on `AuditEvent_tenantId_occurredAt_idx`, then the sequence range | 14 | 0.08 ms |
| Two subjects, either direction | bitmap OR of the actor and target indexes | 67 | 0.15 ms |

This validates database paging and backup mechanics only — not connector
throughput, network latency, an object-store restore, or audit history in the
millions; and it times the search, not the full chain verification each audit
page still carries ([Audit search](#audit-search)).

### Runbook: tabletop exercises

Four incidents rehearsed on paper by the people who would handle them: before
a target's first production go-live, after changing the alert rules, the
rota or these runbooks, and quarterly. You need a facilitator who has read
the runbooks and holds the answers, the on-call operators, a tenant
administrator, someone who speaks for HR (exercises 3 and 4), a console to
look at — production read-only, or a lab: open the pages, find the buttons,
do not press the ones that write — and ninety minutes for all four.

1. The facilitator reads the opening line only.
2. Participants say what they would look at first and what they expect to
   see; the facilitator reveals the product's behaviour as they reach each
   surface and corrects mistaken expectations.
3. Participants walk the steps aloud; the facilitator times the
   [first fifteen minutes](#the-first-fifteen-minutes).
4. Score every place the product, the runbook or the team fell short. An
   exercise is done when the scorecard is filled in, every "no" has an owner
   and a date, and product gaps are filed.

#### Exercise 1: expired Entra client secret

**Opening line.** "Monday 08:10. Nobody has complained. Something is wrong with
the Entra ID target."

**What the product shows.** The scheduled run fails at the token endpoint with
`the token endpoint answered HTTP 401 (AADSTS7000222)` and is `failed`;
`provision_run_failed` appears in **Activity → Attention** and
`SyntraProvisioningRunsFailing` fires within minutes. `lastRunAt` stops
moving, and after two days (or twice the cadence) `target_never_completed`
names the target. If the app registration was granted `Application.Read.All`,
the credential inventory knew the expiry in advance, warned, and raises
`credential_expired`; otherwise nothing knew it was coming. A replica holding
a cached token may succeed for up to an hour past expiry, so the failure can
look intermittent for one cycle. Nothing was applied; sync and every other
target carry on. The target's readiness still shows the last **Test
connection**, passing with an old date — runs do not write readiness.

**Steps.** Follow the incident to the target and read the failed run. **Test
connection** — the same AADSTS failure, now recorded. In Entra add a new
client secret, keeping the old. Rotate on **Settings → Credentials** (stage,
test, cut over, complete) or paste it into **Application client secret**,
test, and save. Restart other API replicas if you need their cached tokens
gone now. **Run now** and read the plan — a missed weekend may propose a
weekend of changes; apply, or apply in part. Remove the old secret in Entra,
and declare the new secret's expiry on **Settings → Credentials** if Syntra
cannot read it.

**Done when** the latest run is `applied` and `lastRunAt` is today; the
target's incidents have cleared (resolve `provision_run_failed`, since it
otherwise counts a week of failures); readiness is `passed` and current; the
next expiry is known to the credential inventory.

| Scorecard | Yes / No / Partial |
|---|---|
| Noticed before a user reported it? | |
| Found the run's message without help? | |
| Tested before saving? | |
| Knew about cached tokens on other replicas? | |
| Old secret removed only after the new one worked? | |
| New expiry recorded where the inventory sees it? | |
| Time from opening line to the run applied | |

#### Exercise 2: Microsoft Graph outage

**Opening line.** "14:00. Microsoft's status page shows a Graph degradation in
your region. The Entra target runs hourly with automatic apply."

**What the product shows.** Runs fail at the read (`failed`, Graph answering
5xx or timing out), or read and then fail or stall on writes. Throttling
(`429` with `Retry-After`, `503`) is honoured: a write waits, up to 20
throttled attempts and 120 seconds per action, not counted against its
attempts. A retryable failure that runs out ends the action `pending_retry`
and the run `partially_applied`; the next run picks it up **only if its plan
still wants it**, so an afternoon's outage does not replay the afternoon's
decisions. A write whose answer was lost stays `in_flight` and the next run
asks Graph what happened. If Graph answers with an **empty** user list rather
than an error, the guard refuses the run outright — nobody can apply it. The
person-population guard protects against an HR feed collapsing at the same
time. Sign-in, sync and other targets are unaffected.

**Steps.** Confirm the outage is external. Turn **automatic apply off** so the
first, possibly large, run after recovery is read by a person — do not disable
the target, which hides it from the staleness check. Confirm no held run
during the outage. Tell HR and the service desk that joiners and leavers at
this target will land late; an urgent leaver is exercise 4. After recovery,
**Run now**, read it end to end, confirm thresholds if the numbers are the
outage's backlog and not a broken feed, apply, and watch `pending_retry` and
`in_flight` drain over the next runs. Turn automatic apply back on.

**Done when** a post-recovery run is applied (or partially, with every
remaining action explained), nothing `in_flight` or `pending_retry` predates
the outage, every lifecycle operation that touched the target is `completed`
in **Employee work**, and the record lists what landed late.

| Scorecard | Yes / No / Partial |
|---|---|
| Distinguished a failed read, an empty read and throttled writes? | |
| Proposed disabling the target? Corrected? | |
| Proposed confirming a held run? | |
| Knew `pending_retry` is re-planned, not replayed? | |
| Told HR about late joiners and leavers? | |
| Read the first post-recovery run before applying it? | |

#### Exercise 3: a mistakenly broad mover rule

**Opening line.** "At 09:30 an administrator edited a business rule on the AD
target so that everyone in `Department = Sales` gets `Sales-Team`. They typed
`Department is not Sales`. The target runs hourly with automatic apply."

**What the product shows.** Before save, the rule editor's impact preview
showed a count matching almost everybody. At the next run the plan grants the
group to everyone outside Sales (grants are not thresholded) and revokes it
from Sales, which trips the per-entitlement threshold: *would revoke
"Sales-Team" from N of N holders (100.0%)*. The run is held for confirmation
and automatic apply leaves it. If the group had few holders and the threshold
was generous, the run applies, and detection is a complaint, drift, or the
audit log. No alert fires. Nothing was deleted either way.

**Steps.** Turn off automatic apply (or unschedule), so the next run does not
compute the same plan and, if under threshold, apply it. Open the held run,
read the reason, and do **not** confirm it — **Cancel** it: while it is held,
later runs on the target are skipped. Find the rule change and its actor in
the audit log, correct the condition, use the impact preview to watch the
count fall, save. **Run now** and read the plan. If the wrong plan **was**
applied, the corrected run proposes the inverse — grants back to Sales,
revocations from everyone else — and trips the per-entitlement threshold
again, legitimately: read the numbers, confirm, apply. Spot-check one person
(`GET /api/admin/persons/:id/access` and the group in AD). Restore the
schedule and automatic apply.

**Done when** the impact preview matches the intended population, the latest
run is applied with no unexpected revocations, spot-checked people hold
exactly the intended entitlements, and open drift on the target is reviewed.

| Scorecard | Yes / No / Partial |
|---|---|
| Stopped automatic apply before editing the rule? | |
| Wanted to confirm the held run to "get it over with"? | |
| Knew a held run blocks later runs until confirmed or cancelled? | |
| Used the impact preview before saving the fix? | |
| Could explain why the inverse run is also held? | |
| Found the actor in the audit log? | |

#### Exercise 4: an urgent leaver during an outage

**Opening line.** "16:45. HR calls: an employee must lose all access now. The
Entra target is in exercise 2's Graph outage, and the job scheduler has been
restarting since a database failover at 16:20."

**What the product shows.** `scheduler_unavailable` at the top of **Activity →
Attention**; `syntra_jobs_pending` absent. **End employment** on the person
(`POST /api/admin/persons/:id/offboarding` with the reason and the preview's
`revision`) works **without the scheduler**: it marks the person inactive,
creates an `offboard` lifecycle operation with `local-access` and `targets`
steps, and for every linked Syntra login revokes sessions and refresh tokens
and disables it — a directory-owned login needs its source's disable
write-back on, or the result says to disable it in the directory. The target
step cannot be queued and is marked failed (*Background jobs are
unavailable. Target work remains in the employee queue.*), so the operation
appears under **Employee work → Failed** and `SyntraLifecycleWorkFailed`
fires. An administrator cannot end their own employment.

**Steps.** Open the person (**Users → People → the person**), **End
employment**, read the preview (which logins, which targets, each source's
write-back state), give the reason, **End employment now**. Read the result
line by line: every `failed` login can still sign in somewhere — disable it in
its directory by hand now, and record it. Assign the operation to yourself
with priority `critical` and a due time, so the overdue alert has a clock.
**Disable the account at the target by hand** — Syntra cannot reach Entra and
cannot queue the work; knowing who holds that access, and how long it takes,
is the point of the exercise. Relying parties with back-channel logout are
told when the sender runs, which needs the scheduler: check
`syntra_logout_deliveries_pending` after recovery. When the scheduler is back,
**Retry operation**; when Graph is back, the run proposes the disable and
finds it already done. **Record observed state** on the operation with what
you verified at the target, then **Acknowledge work**.

**Done when** every login shows `disabled` in the operation's evidence or the
record names where it was disabled by hand; the account at every target is
disabled, verified by reading the target; the operation is `completed` or
acknowledged with a written reason; the lifecycle alerts have cleared; and the
record states the time from the call to "no access anywhere".

| Scorecard | Yes / No / Partial |
|---|---|
| Time from the call to Syntra sessions revoked | |
| Time from the call to the target account disabled by hand | |
| Knew End employment works without the scheduler? | |
| Read each login's result rather than the banner? | |
| Had standing access to disable the account at the target directly? | |
| Assigned the operation an owner and a due time? | |
| Checked back-channel logout delivery after recovery? | |

## Further reading

- [Install](install.md) — development and container installs, TLS.
- [Configuration](configure.md) — every environment variable, directory
  sources, SSO and federation configuration.
- [The console, screen by screen](console-guide.md) — where each control in
  this document lives.
- [`deploy/helm/syntra/README.md`](../deploy/helm/syntra/README.md) — the Helm
  chart.
