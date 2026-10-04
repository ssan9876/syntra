# Back up Syntra and copy backups off the host

Two things must survive the loss of the host: the database and `MASTER_KEY`.
`syntra-backup` handles the database. The key is yours to keep, somewhere
else.

**You need:** the release layout under `/opt/syntra` (see [Install](../install.md)),
root on the host, and a destination: an rclone remote, an SSH host or an S3
bucket. For Docker Compose or Helm, see
[Compose and Helm backups](../operate.md#compose-and-helm-backups).

## 1. Store `MASTER_KEY` somewhere else

`MASTER_KEY` encrypts every stored credential and signs SAML. It is not in the
database and not in any backup. A backup restored without it leaves every
stored secret unreadable and every SAML integration to be set up again.

1. Copy the value from `/opt/syntra/shared/.env`.
2. Put it in a password manager or secrets vault. Not in the backup bucket.

With `MASTER_KEY_PROVIDER` set to `vault-transit` or `aws-kms`, the key lives
in that service instead: keep that service's own backups.

## 2. Take and verify a backup by hand

```bash
syntra-backup create
syntra-backup verify
syntra-backup list
```

`verify` restores the newest backup into a scratch database, counts what
arrived, and drops it. It never touches the live database.

## 3. Set the copy command

Add one line to `/opt/syntra/shared/.env`. It runs after every `create`, with
the backup directory as `$1`. Pick one:

```ini
# rclone, to any remote `rclone config` has set up
SYNTRA_BACKUP_COPY_COMMAND=rclone copy "$1" "offsite:syntra-backups/$SYNTRA_BACKUP_NAME"

# rsync over SSH, with a key in /root/.ssh
SYNTRA_BACKUP_COPY_COMMAND=rsync -a "$1" backup@vault.example.com:/srv/syntra-backups/

# S3, with credentials from /root/.aws or an instance role
SYNTRA_BACKUP_COPY_COMMAND=aws s3 cp --recursive "$1" "s3://example-syntra-backups/$SYNTRA_BACKUP_NAME/"
```

The command runs as root and does not see `MASTER_KEY`. Credentials for the
destination come from the tool's own configuration.

## 4. Try the copy

```bash
syntra-backup copy
```

This copies the newest backup. Check it arrived at the destination.

## 5. Turn on the timers

```bash
systemctl enable --now syntra-backup.timer          # daily
systemctl enable --now syntra-backup-verify.timer   # weekly
```

Both are installed disabled. Turn on both: a backup nobody verifies is not
known to restore.

## 6. Watch for failures

A failed backup or copy leaves the timer looking healthy. Each failure is
logged at error priority; add this to whatever watches the host's journal:

```bash
journalctl -p err -t syntra-backup --since -7d --no-pager
```

A failed copy keeps the local backup and names the retry command:
`syntra-backup copy <name>`.

## 7. Set retention at the destination

`SYNTRA_BACKUP_KEEP` (default 7) prunes this host only. Nothing deletes old
copies at the destination. Set a lifecycle rule on the bucket, or prune in
your own script.

## Restoring

`syntra-backup restore <name> --yes` replaces the live database. It refuses a
backup taken under a different `MASTER_KEY`. Rehearse a restore before you
need one: [Runbook: backup and restore](../operate.md#runbook-backup-and-restore).
