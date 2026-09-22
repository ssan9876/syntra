# Database migration

## Purpose

Apply Prisma schema migrations to a running deployment, know whether the
schema and the code agree, and get back to a working state when they do not.
The mechanism is `prisma migrate deploy`, wrapped as
`pnpm --filter @syntra/db migrate` (`packages/db/package.json`). There is no
down migration: **rollback is a database restore**.

## When to use

- Upgrading to a release whose `packages/db/prisma/migrations` has new
  directories.
- `/health/ready` reports the `migrations` probe failed.
- After a restore of a backup older than the running code.
- Before shipping a new migration: the naming floor below.

## Prerequisites

- A verified backup taken immediately before
  ([Backup and restore, Procedure B and C](backup-and-restore.md#procedure-b-take-a-backup-now)).
  On the release layout `syntra-update` takes its own pre-migration dump into
  `/opt/syntra/shared/backups/`, keeps the last three, and stops if the dump
  fails; that dump is the updater's, not a substitute for your schedule.
- `DATABASE_URL` for the `syntra_app` role. Migrations run as the application
  role so that the tables it creates are owned by it, which is what makes
  `FORCE ROW LEVEL SECURITY` bind the owner.
- A maintenance window if the release notes say a migration is long. Nothing
  in the tree measures migration duration for you.

## How to check migration state

Three ways, in increasing depth.

**The readiness probe** (`packages/db/src/migration-state.ts`, surfaced by
`packages/core/src/health/readiness.ts`):

```bash
curl -s http://127.0.0.1:3000/health/ready
```

The `migrations` probe passes with `N applied`, or `N applied (M newer than
this build)` after a rollback to older code. It fails with
`K migration(s) not applied: …` (schema behind the code) or
`K migration(s) started and did not finish: …` (a migration that ran partly).
Failed details are redacted on the wire; read the process log for the names.

**Prisma's own status**, from the deployed tree:

```bash
# release layout
cd /opt/syntra/current && pnpm --filter @syntra/db exec prisma migrate status
# compose
docker compose exec api pnpm --filter @syntra/db exec prisma migrate status
```

**The bookkeeping table**, which is what both of the above read:

```bash
docker exec -i <PG_CONTAINER> psql -U <PG_ROLE> -d <PG_DB> -tA -c \
  'SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY migration_name'
```

Applied means `finished_at` set and `rolled_back_at` null. `finished_at` null
means started and never finished. Compare the list against
`ls packages/db/prisma/migrations` in the release you are running.

The three states and what they mean:

| State | Meaning | Action |
|---|---|---|
| `pending` | On disk, never applied. Schema behind code. | Apply |
| `failed` | Started, not finished, or rolled back. Tables in a state no migration describes. | Restore, then apply |
| `unknown` | Applied, absent from disk. Code behind schema; the normal state right after a rollback to an older release. | Reported, not failed. Move forward again or restore a matching dump |

## The migration-name floor

`packages/db/src/migration-order.ts` sets `MIGRATION_NAME_FLOOR =
'20260928000000'` and lists every migration that predates the rule. The tree
contains migrations hand-named with dates ahead of the real clock, and
`prisma migrate deploy` replays in name order. A new migration named with
today's real timestamp would sort **before** migrations production has
already applied, and on a fresh database would run before the columns it
references exist. The test `migration-order.test.ts` refuses any new name at
or below the floor.

When adding a migration:

```bash
npx prisma migrate dev --create-only --name add_a_column
mv prisma/migrations/2026092X.._add_a_column prisma/migrations/<name above the floor>_add_a_column
```

Name blocks are allocated per plan in
`docs/superpowers/specs/2026-08-24-audit-findings.md` section 11. An operator
does not normally touch this; it is here because a migration that sorts wrong
is an incident that looks like a corrupt database.

## Procedure A: release layout (`syntra-update`)

The updater migrates as one step of an update and rolls back on its own if
readiness does not return. From `docs/lab/README.md` and the script header:

```bash
/opt/syntra/bin/syntra-update --check        # what is running, what is available
/opt/syntra/bin/syntra-update 1.5.0          # update
/opt/syntra/bin/syntra-update --rollback     # go back deliberately
cat /opt/syntra/var/update.status            # what it is doing right now
```

`syntra-update --adopt <version>` is the once-only conversion of a `dev`
working tree; not for routine upgrades.

What an update does, in order (`do_update` in `ops/syntra-update`): download
and check SHA-256; unpack beside the running release; install dependencies;
generate the client; **dump the database and stop if that fails**; run
`prisma migrate deploy`; swap `current`; restart; poll `/health/ready` for 90
seconds. If readiness does not return it stops the service, restores the
pre-migration dump (dropping every non-system schema first, so tables the new
migration created do not survive), relinks the previous release, restarts, and
writes `rolled_back` to `update.status`. If the restore itself leaves an empty
database it writes `failed` and leaves the service **stopped** with the dump
path in the message.

From the console the same thing is **Settings → Updates** (`POST
/api/admin/update`, `POST /api/admin/update/rollback`; permission
`deployment.manage`). The console cannot downgrade.

Steps:

1. `syntra-backup create` and `syntra-backup verify` (your own backup, in your
   own directory).
2. `syntra-update --check`.
3. `syntra-update <version>`, or press Update.
4. Watch `cat /opt/syntra/var/update.status` until `succeeded`, `rolled_back`
   or `failed`.
5. Verify (below).

## Procedure B: compose path

The `api` image's runtime stage runs `pnpm --filter @syntra/db migrate` and
then starts the server (`apps/api/Dockerfile`, described in
[Install](../install.md#running-the-built-application-as-one-process)). There
is no separate migration step and no automatic rollback.

1. Take a dump ([Backup and restore, Other deployment shapes](backup-and-restore.md#other-deployment-shapes)).
2. Pin the new version and pull:

   ```bash
   export SYNTRA_VERSION=1.5.0
   docker compose pull api web
   docker compose up -d
   ```

   The `web` service waits on the `api` healthcheck, which is `/health/ready`,
   so nginx does not serve until migrations have applied and readiness passes.
3. Watch:

   ```bash
   docker compose logs -f api
   docker compose ps
   ```

   An `api` container that restarts repeatedly is a migration or startup that
   failed; read the log before touching anything.
4. Verify (below).

If it fails: `docker compose stop api web`, restore the dump by hand, set
`SYNTRA_VERSION` back, `docker compose up -d`. The old image will run its own
`migrate deploy` against the restored schema and find nothing to do.

## Procedure C: Helm

`deploy/helm/syntra/templates/migrate.yaml` runs a Job named
`<release>-migrate` as a `pre-install,pre-upgrade` hook at weight `-10`,
from the API image, with `command: ["pnpm", "--filter", "@syntra/db",
"migrate"]`, `backoffLimit: 1`, `ttlSecondsAfterFinished: 86400` and delete
policy `before-hook-creation,hook-succeeded`. A failed Job is therefore kept
for a day so its log can be read. `migration.enabled: false` turns the hook
off for deployments that migrate some other way.

1. Back up the database with the provider's tooling.
2. Set the new immutable tags in the environment values file (`api.image`,
   `web.image`).
3. Upgrade:

   ```bash
   helm upgrade --install syntra ./deploy/helm/syntra --namespace syntra -f values-<env>.yaml
   ```

   Helm runs the migration Job first and aborts the upgrade if it fails, so
   the old Deployment keeps running on a schema that may now be **partly
   ahead** of it (a failed migration leaves a `failed` row). Check the
   migration state before retrying.
4. Read the Job if it failed:

   ```bash
   kubectl -n syntra get jobs
   kubectl -n syntra logs job/syntra-migrate
   ```

5. Verify (below), against the `api` readiness probe the Deployment already
   uses (`/health/ready`, period 5s).

Rolling back: `helm rollback syntra <revision>` puts the previous images
back but does **not** touch the database. If the migration finished, the
older code runs against a newer schema; the readiness probe reports
`unknown` migrations and passes, which is tolerable only if the release notes
say the migration was additive. Otherwise restore the database backup as
well.

## Verification

1. `/health/ready` is ready and the `migrations` probe passes with no
   pending and no failed names.
2. `_prisma_migrations` lists every directory in the release's
   `prisma/migrations` with `finished_at` set.
3. `syntra_build_info` on `/metrics` reports the intended version;
   `syntra_readiness` is 1.
4. Sign in; open **Activity → Attention**; open one target and one person.
   A half-applied migration fails on the first route that touches the new
   column, and these are the routes that touch the most tables.
5. Run the [reconciliation queries](backup-and-restore.md#read-only-reconciliation-checklist)
   and compare with the pre-upgrade capture. Counts must not have moved.

## Rollback

There is no down migration. The rollback for a schema change is:

- Release layout: `syntra-update --rollback`, which restores the
  pre-migration dump and relinks the previous release. Anything written
  between the update and the rollback is lost; say so in the incident record.
- Compose and Helm: put the previous image back **and** restore the dump
  taken in step 1 of the procedure. Follow
  [Backup and restore, Procedure D](backup-and-restore.md#procedure-d-restore-the-live-database)
  and its reconciliation.

A migration in the `failed` state cannot be repaired by re-running
`migrate deploy`; Prisma refuses. Restore, then apply again.

## What this does not cover

- **Data backfills that are not migrations.** Some releases carry a job that
  runs after start; the release notes say so.
- **Downgrading a schema in place.** Not possible with this toolchain.
- **`pnpm db:reset`.** It empties a database and is refused for anything not
  named in `SYNTRA_ALLOW_RESET` (`packages/db/src/reset-guard.ts`). It has no
  place in a migration on a real deployment.
- **The pg-boss schema.** pg-boss migrates its own `pgboss` schema on start.
  A restore drops it along with `public`, which the updater's
  `restore_database` handles by dropping every non-system schema; the backup
  tool's `restore` drops only `public`, so a restore over a database whose
  pg-boss schema moved between releases may need `DROP SCHEMA pgboss CASCADE`
  by hand before the service starts cleanly.
