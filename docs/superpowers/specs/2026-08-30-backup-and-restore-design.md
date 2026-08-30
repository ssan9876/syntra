# Backup and restore

Status: designed, 2026-08-30
Based on `81559da`

`docs/operate.md` describes what to keep and says the updater's pre-migration
dump is "a safety net for the update itself, not a substitute for a real backup
schedule." There is no real backup schedule, and nothing in the repository
produces one. This is that.

Sub-project D of four. A (ending access) and B (watching Syntra) are built. C
is machine access — API tokens, then an inbound SCIM server — and is separate.

## Why

Two sentences in `operate.md` are the specification.

The first is what to keep: the Postgres volume, **and** `MASTER_KEY`, because
"a restored database with a lost `MASTER_KEY` means every stored secret is
unreadable and every SAML integration has to be reconfigured." That is a
documented footgun with nothing standing in front of it. Nobody discovers a key
mismatch at restore time; they discover it later, one unreadable secret at a
time, while trying to recover.

The second is the admission: the only dump this product takes is the updater's,
it exists to roll back one update, and `syntra-update` prunes it to the last
three. An operator who wants a backup schedule is told to arrange one
themselves, against a volume, with no tool for checking that what they arranged
is restorable.

**Almost none of the hard part is new work.** `syntra-update`'s
`dump_database` already knows the thing that is genuinely difficult here:

> AND IT CONTAINS ROWS. The two checks above pass on a structurally perfect
> archive of nothing, which is exactly what an RLS-filtered dump is. This is
> the check that can tell a backup from something shaped like one.

Every tenant-scoped table is `FORCE ROW LEVEL SECURITY` and the application
role is `NOSUPERUSER NOBYPASSRLS`, so a dump taken as the wrong role is a
valid, well-formed archive of nothing. That lesson is paid for and is reused
here rather than rediscovered.

## Ruling: scheduled backups do not live where the updater prunes

`syntra-update` keeps the last three of `$SHARED/backups/*.dump` and deletes
the rest, on every update. A backup tool writing there would have its history
silently truncated by an unrelated upgrade — and the operator would find out
during a recovery.

**Backups live in `$ROOT/backups`, a directory the updater does not touch**,
overridable with `SYNTRA_BACKUP_DIR`. The two prunes are then incapable of
interfering, rather than merely configured not to.

## Ruling: a half-written backup is never a backup

Each backup is a **directory**, written as `<name>.partial/` and renamed to
`<name>/` only after every check has passed. Rename within a filesystem is
atomic, so an interrupted run — a full disk, a killed process, a reboot —
leaves a `.partial` directory that `list` reports as incomplete and `restore`
refuses outright.

The alternative, writing files in place and hoping, produces the one thing this
whole document exists to prevent: something that looks like a backup and is
not.

## The artifact

```
$ROOT/backups/
  syntra-20260830T021104Z/
    database.dump      pg_dump -Fc, taken as a role that bypasses RLS
    manifest.json
```

```json
{
  "createdAt": "2026-08-30T02:11:04Z",
  "version": "1.7.2",
  "database": "syntra",
  "tableDataSections": 87,
  "bytes": 4718592,
  "masterKeyFingerprint": "sha256:9f2b…"
}
```

### The fingerprint, and what it is for

`masterKeyFingerprint` is `sha256(salt || MASTER_KEY)` with a fixed,
non-secret, in-repository salt — the salt exists so the value cannot be matched
against a rainbow table of common keys, not to keep a secret.

**The key itself never enters the backup.** A backup travels: to another host,
an object store, somebody's laptop during an incident. A backup carrying the
credential that decrypts every tenant's secrets is a different risk from a
backup of the database, and combining them means the safer artifact inherits
the more dangerous one's handling requirements.

What the fingerprint buys is that **restore can refuse**. Restoring a database
whose secrets were sealed under a key this deployment no longer has is a
restore that appears to succeed and has quietly destroyed every stored
credential's usability. With the fingerprint, that is a refusal naming the
problem, before anything is written:

```
this backup was taken under a different MASTER_KEY
  backup:  sha256:9f2b…
  running: sha256:41c7…
Restoring it would leave every stored secret unreadable and every SAML
integration to be reconfigured. Recover the original MASTER_KEY, or restore
with --accept-secret-loss if that is genuinely what you want.
```

`--accept-secret-loss` exists because the answer is sometimes yes — a
development host, a deployment whose secrets are all being rotated anyway — and
a check with no override is a check people work around by editing the manifest.

A backup taken where `MASTER_KEY` could not be read records
`"masterKeyFingerprint": null`, and restore says it cannot check rather than
implying it did.

## The commands

`ops/syntra-backup`, in the same idiom as `syntra-install` and `syntra-update`:
POSIX shell, `set -euo pipefail`, a `SYNTRA_BACKUP_SOURCE_ONLY` guard at the
bottom so the pure functions can be sourced by a test.

### `create`

1. Resolve `PG_CONTAINER`, `PG_ROLE`, `PG_DB` from `$SHARED/.env` — reusing
   `syntra-update`'s `env_value` and `pg_url_field` logic, which reads the file
   without executing it, because it holds `MASTER_KEY` and `RELEASE_TOKEN`.
2. `install -m 0600` the destination before writing. A dump is an unfiltered
   copy of every tenant's data and must never exist, even briefly, at the
   shell's default umask.
3. `pg_dump -Fc` through the container, as the RLS-bypassing role.
4. Check: non-empty, `PGDMP` magic, **and at least one `TABLE DATA` section**.
5. Write the manifest.
6. Rename `.partial` into place.
7. Prune to the last `KEEP` (default 7, `SYNTRA_BACKUP_KEEP`), newest first,
   ignoring `.partial` directories — which are not backups and are not counted
   toward the retention an operator asked for.

Exit non-zero on any failure, with nothing renamed into place.

### `verify [name|latest]`

Restores the archive into a **scratch database** in the same container, counts
what arrived, and drops it. This is the difference between an archive that is
well-formed and one that is restorable; a truncated file passes all three
structural checks and fails here.

- `createdb` a name like `syntra_verify_<pid>`; drop it in a trap so an
  interrupted verify does not leave it behind.
- `pg_restore` into it, non-fatal on the ownership and role notices a restore
  into a different database always produces.
- Count rows across the restored public schema. **Zero rows is a failure**,
  for the same reason an empty dump is.
- Report the table count and row count, and drop the scratch database.

It never touches the live database. That is the property that makes it safe to
run from cron, which is the only way it will ever be run regularly.

### `restore <name>`

The one that changes things, and the one that refuses most.

- Refuses a `.partial` directory.
- Refuses a manifest whose fingerprint differs from the running `MASTER_KEY`,
  unless `--accept-secret-loss`.
- Requires `--yes`, because it is not recoverable and a confirmation prompt in
  a script is a prompt that gets answered by a stray newline.
- Stops the service first, restores, starts it. Reuses `syntra-update`'s
  restore sequence — **schemas first**, for the reason that file documents:
  `pg_restore --clean --if-exists` drops only what is in the archive, so
  anything a later migration created survives a restore that was supposed to
  remove it.

### `list`

Name, age, size, version, table count, and whether the fingerprint matches the
running key — so the answer to "can I restore this?" is visible before the
incident rather than during it.

## Scheduling

A `syntra-backup.timer` and `.service` beside the existing units, daily, and a
`syntra-backup-verify.timer` weekly. Both are **installed but not enabled** by
`syntra-install`: a tool that silently starts writing gigabytes to a disk
nobody sized for it is a tool that gets uninstalled. `operate.md` gives the
`systemctl enable --now` line.

The verify timer is the point of the whole design. A backup schedule nobody
checks produces a directory full of files with the shape of backups, and the
first time anybody learns otherwise is the worst possible time.

## Testing

`ops/syntra-backup.test.sh`, in the shape of `syntra-update.test.sh`: source
the shipped script with the `SOURCE_ONLY` guard and test the pure functions,
because "a test that carries its own copy of the logic passes forever while the
shipped code does something else entirely."

Pure functions worth testing:

- `backup_name_for` — a stable, sortable, filesystem-safe UTC name.
- `backups_to_prune` — given a list and a `KEEP`, the ones to delete. That
  `.partial` entries are never counted and never pruned. That fewer backups
  than `KEEP` prunes nothing. That it is newest-first, not lexical luck.
- `fingerprint_matches` — equal, different, and **null on either side**, which
  is the case that must not silently pass.
- `manifest_field` — reading a value out of a manifest without a JSON parser,
  since the host has no `jq`.

Then an integration test against the real Postgres container, gated the way the
SFTP tests are: create, verify, and a restore into a scratch database, plus the
case that matters most — **a dump taken as the application role is rejected**,
which is the RLS trap `syntra-update` already found and the one thing here that
must never regress.

## Documentation

`operate.md`'s Backups section is rewritten. It currently describes what to
keep and tells the operator to arrange it; it will describe the tool, the two
timers, how to enable them, and what the fingerprint refusal means when they
meet it.

The `MASTER_KEY` warning stays, in the same words. The tool detects the
mismatch; it does not fix it, and an operator who reads only the tool's help
must still be told to keep the key.

## Not in this document

**Off-host copies.** `rsync`, `restic` and every object-store client already do
this better than a shell script bolted to this one would. The tool produces a
directory with a stable name; getting it elsewhere is a job for a tool that
does that.

**Point-in-time recovery.** WAL archiving is a different feature with different
operational requirements, and `pg_dump` is not a step toward it.

**Backing up the volume rather than the database.** A file-level copy of a
running Postgres data directory is not a backup, and offering one would be
offering the exact thing this document exists to distinguish from a backup.

**A console screen.** Restoring a database from a web page that is served by
the process being restored is a design with an obvious problem.
