# Backup and restore

## Purpose

Take a database backup that is known to be restorable, prove that it is,
restore it when necessary, and reconcile what came back against what was
there before. The design behind the tool is in
[`docs/superpowers/specs/2026-08-30-backup-and-restore-design.md`](../superpowers/specs/2026-08-30-backup-and-restore-design.md);
the operator-facing summary is in [Operate, "Backups"](../operate.md#backups).

Two things make a Syntra backup, and one alone is not enough:

- **The database.** The whole state: tenants, persons, contracts, accounts,
  policy, the audit log, every application's configuration, the vault rows.
- **`MASTER_KEY`.** Not in the database, so it does not come back with a
  restore. Without it every vault row is unreadable. See
  [Master-key recovery](master-key-recovery.md).

## When to use

- Before any change you cannot otherwise undo: a migration, a bulk import, a
  first provisioning run against a large target, a key or secret rotation.
- On a schedule (daily backup, weekly verify), which the timers below provide.
- When the database is lost, corrupt, or has been changed in a way the
  product's own controls cannot reverse.
- As a rehearsal, at least once before the first real restore is needed.

## Prerequisites

- **Release layout only.** `ops/syntra-backup` reads `/opt/syntra/shared/.env`,
  runs `pg_dump` inside the Postgres container named by `PG_CONTAINER`, and on
  `restore` runs `systemctl stop syntra`. The compose path and Helm have no
  equivalent tool; see [Other deployment shapes](#other-deployment-shapes)
  for the by-hand procedure.
- Root on the host (the tool reads `MASTER_KEY` from `shared/.env` and talks to
  the Docker socket).
- A role that bypasses row-level security. The tool prefers the user in
  `SUPERUSER_DATABASE_URL` from `shared/.env`, otherwise a role named after the
  database. A dump taken as `syntra_app` is a structurally valid archive of no
  rows, and the tool refuses it.
- Disk space under `/opt/syntra/backups` (or `SYNTRA_BACKUP_DIR`) for
  `SYNTRA_BACKUP_KEEP` copies (default seven).
- `MASTER_KEY` kept somewhere other than this host, as its own secret.

The tool's own usage text:

```
syntra-backup -- backups that can be told apart from things shaped like backups

  syntra-backup create               take a backup
  syntra-backup verify [name]        restore one into a scratch database, then drop it
  syntra-backup restore <name> --yes replace the live database with one
  syntra-backup list                 what is here, and whether it can be restored

  SYNTRA_BACKUP_DIR   where they live (default /opt/syntra/backups)
  SYNTRA_BACKUP_KEEP  how many to keep (default 7)
```

`restore` also accepts `--accept-secret-loss`, which is described under
[Master-key recovery](master-key-recovery.md#when-the-original-key-is-genuinely-gone).
It does not imply `--yes`.

Environment overrides the tool honours, for a host whose `shared/.env` is not
the source of truth: `SYNTRA_ROOT`, `SYNTRA_SERVICE`, `SYNTRA_PG_CONTAINER`,
`SYNTRA_PG_ROLE`, `SYNTRA_PG_DB`, `SYNTRA_DATABASE_URL`,
`SYNTRA_SUPERUSER_DATABASE_URL`, `SYNTRA_MASTER_KEY`.

## Procedure A: turn the schedule on

The units are installed by `ops/syntra-install` and left disabled.

```bash
systemctl enable --now syntra-backup.timer          # daily, randomised by up to 30 min
systemctl enable --now syntra-backup-verify.timer   # weekly, ordered after the daily dump
```

Enable both. A backup schedule nobody verifies is a directory of files shaped
like backups.

Verify the schedule is live:

```bash
systemctl list-timers 'syntra-backup*'
```

Both service units carry `OnFailure=syntra-backup-failed@%n.service`, which
writes an `err`-priority journal line naming the unit that failed. Put this in
whatever already watches the host's journal:

```bash
journalctl -p err -t syntra-backup --since -7d --no-pager
```

Do not trust the timer's state as the backup's state: a failed oneshot leaves
the timer `active (waiting)`. Ask the service:

```bash
systemctl is-failed syntra-backup.service      # prints "failed" and exits 0 when it failed
journalctl -u syntra-backup.service -n 50 --no-pager
```

## Procedure B: take a backup now

```bash
/opt/syntra/bin/syntra-backup create
```

What it does: dumps with `pg_dump -Fc` into `<name>.partial/`, checks the
archive starts with `PGDMP`, checks it lists at least one `TABLE DATA`
section, writes `manifest.json` (created-at, running version, database name,
table-data section count, byte count, salted `MASTER_KEY` fingerprint), then
renames the directory into place. A backup that was interrupted stays as
`.partial`, which `list` shows as `INCOMPLETE` and `restore` refuses.

Then:

```bash
/opt/syntra/bin/syntra-backup list
```

Columns: `NAME SIZE VERSION TABLES KEY`. `KEY` is `ok` when the manifest's
fingerprint matches the running `MASTER_KEY`, `MISMATCH` when it does not, and
`unknown` when either side could not be read. `unknown` never counts as a
match.

## Procedure C: prove a backup restores

```bash
/opt/syntra/bin/syntra-backup verify            # newest
/opt/syntra/bin/syntra-backup verify <name>     # a particular one
```

This restores into a scratch database named `syntra_verify_<pid>` inside the
same container, runs `ANALYZE`, counts tables and live rows from
`pg_stat_user_tables`, and drops the scratch database on exit (including on
interruption). It never touches the live database. The success line reads
`verified <name> -- N tables, ~M rows, restored and dropped`. Zero tables or
zero rows is a failure by design.

Record the `N tables, ~M rows` figure with the backup name; it is the first
number the reconciliation below compares against.

## Procedure D: restore the live database

This replaces the live database and stops the service while it does so.

1. **Capture the before state.** Run the
   [reconciliation queries](#read-only-reconciliation-checklist) against the
   live database and keep the output.
2. **Confirm the key.** `syntra-backup list` must show `KEY ok` for the backup
   you intend to restore. If it shows `MISMATCH`, stop and go to
   [Master-key recovery](master-key-recovery.md). Do not reach for
   `--accept-secret-loss` as a first response.
3. **Tell people.** Sign-in and every SSO flow will stop for the duration.
   See [Incident response, communication](incident-response.md#communication).
4. **Restore.**

   ```bash
   /opt/syntra/bin/syntra-backup restore <name> --yes
   ```

   What it does, in order: re-checks the archive (`PGDMP`, table-data
   sections), compares fingerprints, `systemctl stop syntra`,
   `DROP SCHEMA public CASCADE; CREATE SCHEMA public;`, `pg_restore --clean
   --if-exists`, `SELECT 1`, counts tables and rows, and only then
   `systemctl start syntra`. If nothing arrived it says so and **leaves the
   service stopped**; the dump is untouched on disk at
   `/opt/syntra/backups/<name>/database.dump` for a restore by hand.
5. **Wait for readiness.**

   ```bash
   curl -s http://127.0.0.1:3000/health/ready
   ```

   All four probes (`database`, `migrations`, `vault`, `web`) must be `pass`
   or `skip`. A `vault` failure after a restore means the key on this host is
   not the key the backup was sealed under; see
   [Master-key recovery](master-key-recovery.md).
6. **Reconcile.** Run the after-state queries and compare.

### If the restored backup is older than the running release

The `migrations` probe reports `pending` migrations when the schema in the dump
is behind the code. The service will still start, and the first request to
touch a missing column fails. Either apply migrations (see
[Database migration](database-migration.md)) or roll the code back to the
release the dump was taken under (`manifest.json` records `version`). Do not
run traffic against a half-matched schema.

## Procedure E: restore rehearsal into an isolated environment

The point of the rehearsal is to restore somewhere the live deployment cannot
be reached from, then run the same reconciliation you would run for real.
`ops/rehearsal/README.md` describes an analogous isolation for the updater
(own root, own unit, own port, own database in the same Postgres container),
and the same separation applies here.

1. **Pick the isolation.** Either a second host with the same release, or on
   the same host a separate root, unit, port and database:

   | | Live | Rehearsal |
   |---|---|---|
   | Root | `/opt/syntra` | `/opt/syntra-rehearsal` |
   | Unit | `syntra` | `syntra-rehearsal` |
   | Port | 3000 | 3999 |
   | Database | `syntra` | `syntra_rehearsal` |

2. **Copy the backup directory**, not just the dump, so the manifest travels:

   ```bash
   cp -a /opt/syntra/backups/<name> /opt/syntra-rehearsal/backups/
   ```

3. **Create the rehearsal database** in the container, as the RLS-bypassing
   role:

   ```bash
   docker exec <PG_CONTAINER> createdb -U <PG_ROLE> syntra_rehearsal
   ```

4. **Restore into it by hand.** `syntra-backup restore` targets the database
   named in `shared/.env` and stops the `syntra` unit, so for a rehearsal use
   the same steps it runs, pointed at the rehearsal database:

   ```bash
   docker exec -i <PG_CONTAINER> psql -v ON_ERROR_STOP=1 -U <PG_ROLE> -d syntra_rehearsal \
     -c 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;'
   docker exec -i <PG_CONTAINER> pg_restore -U <PG_ROLE> -d syntra_rehearsal --clean --if-exists \
     < /opt/syntra-rehearsal/backups/<name>/database.dump
   ```

   `pg_restore` exits non-zero on ownership and role notices; its status is
   not the test. What arrived is.

   Alternatively, with the overrides the tool honours, `verify` can be pointed
   at the copied directory to do the restore-count-drop cycle for you:

   ```bash
   SYNTRA_ROOT=/opt/syntra-rehearsal SYNTRA_PG_CONTAINER=<PG_CONTAINER> \
     SYNTRA_PG_ROLE=<PG_ROLE> SYNTRA_PG_DB=syntra_rehearsal \
     /opt/syntra/bin/syntra-backup verify <name>
   ```

   That proves restorability but drops the database again; use the by-hand
   restore when you want to run the API against it.

5. **Point a rehearsal API at it.** A copy of `shared/.env` with
   `DATABASE_URL` naming `syntra_rehearsal`, `PORT=3999`, the **same**
   `MASTER_KEY`, and a `PUBLIC_URL` nothing real resolves to. Set
   `SMTP_URL` to a sink (the development stack's MailDev, for example) so a
   rehearsal cannot mail anybody. Disable or clear every target's schedule
   before starting the scheduler against restored data, or the rehearsal will
   run real provisioning against real directories: see
   [Target rollback, "Stop a target"](target-rollback.md#procedure-a-stop-a-target).
   The safest rehearsal starts the API and reads; it does not apply anything.

6. **Check readiness on the rehearsal port** and run the reconciliation below
   against `syntra_rehearsal`.

7. **Tear down:** stop the rehearsal unit, `dropdb syntra_rehearsal`, remove
   the copied backup.

Record the date, the backup name, the `tables/rows` figure and any
discrepancy in the reconciliation. A rehearsal that was not written down did
not happen.

## Read-only reconciliation checklist

Run these before a restore (against the live database) and after (against
the restored one). They read; they change nothing. Run them as the
RLS-bypassing role, otherwise every count is zero:

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

Fill in and keep:

| Count | Before | After | Expected difference | Explained? |
|---|---|---|---|---|
| tenants | | | 0 | |
| persons / persons_active | | | 0 | |
| contracts | | | 0 | |
| users | | | 0 | |
| target_systems | | | 0 | |
| target_accounts | | | 0 | |
| account_entitlements | | | 0 | |
| lifecycle_ops / unresolved | | | 0 | |
| provision_runs / actions | | | 0 | |
| secrets | | | 0 | |
| audit_events / max_sequence / newest | | | everything after the backup's `createdAt` is lost | |
| migrations_applied | | | see [Database migration](database-migration.md) | |

For a same-backup restore every difference is "what happened between the
backup and now". Anything else is a question to answer before the deployment
serves traffic again. The audit gap in particular must be written into the
incident record: those events are gone and the hash chain resumes from the
restored sequence.

Then the product-level checks:

1. `GET /health/ready` is ready, `vault` is `pass` (or `skip` on an empty
   install).
2. `GET /api/admin/audit?limit=1` returns `chainValid: true`.
3. `GET /api/admin/incidents` lists nothing you cannot explain. A restore that
   reintroduces an old `target_never_completed` or `webhook_undelivered` is
   normal if the fix happened after the backup.
4. Open one target: **Target systems → the target → Test connection**. A
   `vault` pass says the key works for at least one secret; this says it
   works for the one you care about.
5. Sign in through one SAML or OIDC application. Signing keys are vault rows;
   password sign-in keeps working with a broken vault and proves nothing
   about it.

## Rollback

A restore's rollback is another restore. Take a backup of the current state
**before** restoring an older one (`syntra-backup create`), so the pre-restore
state is itself a named, verified backup you can return to.

If `restore` left the service stopped because nothing arrived, the live
database is empty and the dump is intact. Restore it by hand with the
`pg_restore` line from Procedure E against the live database name, check
`restored_counts` yourself with the reconciliation queries, then
`systemctl start syntra`.

## Other deployment shapes

**Compose path.** There is no backup tool for it. The container is the
`postgres` service; the superuser is `POSTGRES_USER=syntra`. Take a dump with
the same checks the tool performs:

```bash
docker compose exec -T postgres pg_dump -U syntra -d syntra -Fc > syntra-$(date -u +%Y%m%dT%H%M%SZ).dump
head -c 5 syntra-*.dump | grep -q PGDMP && echo archive-ok
docker compose exec -T postgres pg_restore -l < syntra-<stamp>.dump | grep -c 'TABLE DATA'
```

Restore: `docker compose stop api web`, drop and recreate the `public` schema,
`pg_restore --clean --if-exists` through `docker compose exec -T postgres`,
run the reconciliation queries, `docker compose up -d`. The `api` container
runs `prisma migrate deploy` on start, so a dump older than the image will
be migrated forward on the way up. Keep the dump's Syntra version with it by
hand; nothing writes a manifest here. Keep `MASTER_KEY` with the same care
as on the release layout.

**Helm.** The chart ships no backup. Back up whatever provides the database
named in the `syntra-runtime` Secret's `DATABASE_URL` using that provider's
tooling, and record the chart's image tag alongside it. See
[Database migration](database-migration.md#procedure-c-helm) for what
happens to the schema on upgrade.

## What this does not cover

- **Point-in-time recovery.** This is `pg_dump`, not WAL archiving.
- **Getting backups off the host.** Point `rsync`, `restic` or an object
  store client at `/opt/syntra/backups`; each backup is a self-contained
  directory with a sortable name.
- **Backing up `MASTER_KEY`.** The manifest holds a salted fingerprint, never
  the key. Keeping the key is a separate procedure with a separate custodian.
- **The AD or Entra side.** Accounts at targets are not in this backup.
  A restored Syntra will reconcile against whatever the target holds now.
- **Compose and Helm automation.** See the gaps in the final report of this
  runbook set; `ops/syntra-backup` is release-layout only.
