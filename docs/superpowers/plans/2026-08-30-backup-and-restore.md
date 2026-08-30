# Backup and Restore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A backup an operator can schedule, verify and restore — one that refuses to be mistaken for a backup when it is not one.

**Architecture:** One POSIX shell script, `ops/syntra-backup`, in the idiom of `syntra-install` and `syntra-update`. Backups are directories under `$ROOT/backups`, written as `.partial` and renamed atomically once every check passes. Each carries a manifest with a fingerprint of `MASTER_KEY` — never the key — so restore can refuse a database whose secrets were sealed under a key this deployment no longer holds. Two systemd timers, installed and left disabled.

**Tech Stack:** POSIX shell (`bash`, `set -euo pipefail`), `docker exec` into the Postgres container for `pg_dump` / `pg_restore` / `psql`, systemd units, a sourced-function test script in the shape of `syntra-update.test.sh`.

**Spec:** `docs/superpowers/specs/2026-08-30-backup-and-restore-design.md`

## Global Constraints

- **Never source `$SHARED/.env`.** It holds `MASTER_KEY` and `RELEASE_TOKEN` — values produced by `base64` and by GitHub, not by anybody thinking about shell quoting. Read keys with `env_value`, which does not execute the file.
- **Backups live in `$ROOT/backups`**, never `$SHARED/backups`: `syntra-update` prunes the latter to three on every upgrade.
- **`install -m 0600` before writing a dump**, never `chmod` after. A dump is an unfiltered copy of every tenant's data.
- **`pg_dump` runs as the RLS-bypassing role.** The application role is `NOSUPERUSER NOBYPASSRLS`; a dump taken as it is a well-formed archive of nothing.
- **Every dump is checked for `TABLE DATA` sections**, not just for `PGDMP` magic and non-emptiness.
- **`.partial` directories are not backups**: never listed as one, never counted toward retention, never restorable.
- Shell only — the host has no `jq` and no Node.
- The script ends with a `SYNTRA_BACKUP_SOURCE_ONLY` guard so the test can source it.

## File Structure

- Create `ops/syntra-backup` — the tool
- Create `ops/syntra-backup.test.sh` — sourced-function tests
- Create `ops/systemd/syntra-backup.service` and `.timer`
- Create `ops/systemd/syntra-backup-verify.service` and `.timer`
- Modify `ops/syntra-install` — install the binary and the units, enable nothing
- Modify `docs/operate.md` — rewrite Backups

---

### Task 1: The script, its paths, and its pure functions

**Files:**
- Create: `ops/syntra-backup`
- Create: `ops/syntra-backup.test.sh`

**Interfaces:**
- Produces: `backup_name_for`, `backups_to_prune`, `fingerprint_of`, `fingerprints_match`, `manifest_field`, `env_value`, `pg_url_field`, and a `SYNTRA_BACKUP_SOURCE_ONLY` guard.

- [ ] **Step 1: Write the failing test**

Create `ops/syntra-backup.test.sh` modelled on `syntra-update.test.sh` — the same `ok`/`yes_no` helpers, the same sourcing comment, the same exit-code tail.

```bash
SYNTRA_BACKUP_SOURCE_ONLY=1
export SYNTRA_BACKUP_SOURCE_ONLY
. "$HERE/syntra-backup"

# --- backup_name_for --------------------------------------------------------
ok "names a backup after its UTC instant" \
   "$(backup_name_for 1756515064)" "syntra-20260830T021104Z"
ok "sorts lexically in time order" \
   "$(printf '%s\n%s\n' "$(backup_name_for 1756515064)" "$(backup_name_for 1756515063)" | sort | head -1)" \
   "syntra-20260830T021103Z"

# --- backups_to_prune -------------------------------------------------------
ok "prunes nothing when there are fewer than KEEP" \
   "$(backups_to_prune 3 syntra-3 syntra-2 syntra-1)" ""
ok "prunes the oldest beyond KEEP" \
   "$(backups_to_prune 2 syntra-3 syntra-2 syntra-1)" "syntra-1"
ok "keeps the newest, whatever order it was given them in" \
   "$(backups_to_prune 1 syntra-1 syntra-3 syntra-2)" "$(printf 'syntra-2\nsyntra-1')"
ok "never prunes a partial directory" \
   "$(backups_to_prune 1 syntra-3.partial syntra-2 syntra-1)" "syntra-1"
ok "never COUNTS a partial toward the retention asked for" \
   "$(backups_to_prune 2 syntra-3.partial syntra-2 syntra-1)" ""

# --- fingerprints_match -----------------------------------------------------
ok "equal fingerprints match"        "$(yes_no fingerprints_match abc abc)" yes
ok "different fingerprints do not"   "$(yes_no fingerprints_match abc def)" no
ok "an unknown backup fingerprint does not match" "$(yes_no fingerprints_match "" abc)" no
ok "an unknown running key does not match"        "$(yes_no fingerprints_match abc "")" no
ok "two unknowns do not match either" "$(yes_no fingerprints_match "" "")" no

# --- manifest_field ---------------------------------------------------------
m=$(mktemp)
printf '{\n  "version": "1.7.2",\n  "masterKeyFingerprint": "sha256:9f2b",\n  "tableDataSections": 87\n}\n' > "$m"
ok "reads a string field"  "$(manifest_field version "$m")" "1.7.2"
ok "reads a field with a colon in its value" \
   "$(manifest_field masterKeyFingerprint "$m")" "sha256:9f2b"
ok "reads a numeric field" "$(manifest_field tableDataSections "$m")" "87"
ok "answers empty for a field that is not there" "$(manifest_field nope "$m")" ""
ok "answers empty for a file that is not there"  "$(manifest_field version /nope)" ""
rm -f "$m"
```

The two `fingerprints_match` cases with an empty side are the ones that matter: an unknown fingerprint must never read as a match, or the refusal this whole feature rests on is skipped exactly when the manifest is damaged.

- [ ] **Step 2: Run it to verify it fails**

Run: `bash ops/syntra-backup.test.sh`
Expected: FAIL — the script does not exist.

- [ ] **Step 3: Write the script's head and pure functions**

Header comment in the voice of `syntra-update`: what this is, that backups live outside `$SHARED/backups` and why, and that a `.partial` directory is not a backup.

```bash
#!/usr/bin/env bash
set -euo pipefail

ROOT="${SYNTRA_ROOT:-/opt/syntra}"
SHARED="$ROOT/shared"
# NOT $SHARED/backups. `syntra-update` prunes that directory to its last three
# dumps on every upgrade, and a backup history silently truncated by an
# unrelated update is a history somebody discovers during a recovery.
BACKUPS="${SYNTRA_BACKUP_DIR:-$ROOT/backups}"
KEEP="${SYNTRA_BACKUP_KEEP:-7}"
SERVICE="${SYNTRA_SERVICE:-syntra}"

PG_CONTAINER="${SYNTRA_PG_CONTAINER:-}"
PG_ROLE="${SYNTRA_PG_ROLE:-}"
PG_DB="${SYNTRA_PG_DB:-}"

# A fixed, non-secret salt. It exists so a fingerprint cannot be matched
# against a precomputed table of common keys -- it is not itself a secret and
# there is nothing to gain by rotating it.
FINGERPRINT_SALT='syntra-backup-fingerprint-v1'
```

Then the pure functions. `env_value` and `pg_url_field` are **copied verbatim from `syntra-update`**, comments included, with a line saying where they came from and why they are duplicated rather than sourced: these are two standalone operator tools and one must not fail to run because the other is missing.

```bash
backup_name_for() { date -u -d "@$1" +syntra-%Y%m%dT%H%M%SZ 2>/dev/null || date -u -r "$1" +syntra-%Y%m%dT%H%M%SZ; }

# The backups to delete, newest kept. Never a `.partial`: it is not a backup,
# so it is neither deleted as one nor counted toward the retention an operator
# asked for -- counting it would silently keep one fewer real backup than they
# configured.
backups_to_prune() {
  local keep="$1"; shift
  printf '%s\n' "$@" | grep -v '\.partial$' | sort -r | tail -n +$(( keep + 1 ))
}

fingerprint_of() { printf '%s%s' "$FINGERPRINT_SALT" "$1" | sha256sum | cut -d' ' -f1 | sed 's/^/sha256:/'; }

# Unknown never matches. A damaged or absent fingerprint must not read as
# agreement, because agreement is what skips the refusal.
fingerprints_match() {
  [ -n "$1" ] && [ -n "$2" ] && [ "$1" = "$2" ]
}

# One field out of the manifest, without a JSON parser -- the host has no jq.
# The manifest is written by this script and its shape is known, so a line
# match is honest here in a way it would not be for arbitrary JSON.
manifest_field() {
  local key="$1" file="$2"
  [ -f "$file" ] || return 0
  sed -n "s/^[[:space:]]*\"${key}\"[[:space:]]*:[[:space:]]*\"\{0,1\}\([^\",]*\)\"\{0,1\},\{0,1\}[[:space:]]*\$/\1/p" "$file" | head -1
}
```

End the file with:

```bash
if [ "${SYNTRA_BACKUP_SOURCE_ONLY:-}" != "1" ]; then
  main "$@"
fi
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bash ops/syntra-backup.test.sh`
Expected: every case passes, exit 0. `backup_name_for` uses GNU `date -d @` with a BSD `date -r` fallback; if neither is available on the dev machine, adjust the test's expected value rather than the function.

- [ ] **Step 5: Commit**

```bash
git add ops/syntra-backup ops/syntra-backup.test.sh
git commit -m "feat(ops): the pure half of a backup tool"
```

---

### Task 2: `create`

**Files:**
- Modify: `ops/syntra-backup`

**Interfaces:**
- Consumes: Task 1's helpers
- Produces: `resolve_environment`, `dump_database`, `write_manifest`, `cmd_create`, `prune_backups`

- [ ] **Step 1: Implement `resolve_environment`**

Resolve `PG_CONTAINER`, `PG_ROLE`, `PG_DB` exactly as `syntra-update`'s `resolve_environment` does — read `DATABASE_URL` and `SUPERUSER_DATABASE_URL` from `$SHARED/.env` with `env_value`, take the role from the superuser URL where there is one, and `die` with a message naming the file when a required value is missing. Read that function before writing this one and follow it; the fallbacks it chose are not arbitrary.

Also read `MASTER_KEY` with `env_value` — absent is not fatal here, it makes the fingerprint `null`.

- [ ] **Step 2: Implement `dump_database`**

Lift `syntra-update`'s `dump_database` and adapt the messages. **Keep all four checks**: `install -m 0600` first, non-empty, `PGDMP` magic, and at least one `TABLE DATA` section. Keep the comment explaining the last one — it is the check that can tell a backup from something shaped like one, and it exists because an RLS-filtered dump passes the other three.

Return the section count so the manifest can record it.

- [ ] **Step 3: Implement `cmd_create`**

```
name=$(backup_name_for "$(date -u +%s)")
dir="$BACKUPS/$name.partial"
mkdir -p "$dir"
dump_database "$dir/database.dump"
write_manifest "$dir/manifest.json"
mv "$dir" "$BACKUPS/$name"        # atomic; nothing is a backup until this line
prune_backups
```

`write_manifest` emits the JSON from the spec with `printf`, and `masterKeyFingerprint` is `null` (unquoted) when the key could not be read — so a reader can tell "no key" from a fingerprint of the empty string.

- [ ] **Step 4: Implement `prune_backups`**

```
backups_to_prune "$KEEP" $(ls -1 "$BACKUPS" 2>/dev/null) | while read -r old; do
  [ -n "$old" ] || continue
  rm -rf "${BACKUPS:?}/$old"
done
```

`${BACKUPS:?}` so an unset variable cannot expand into `rm -rf /$old`.

- [ ] **Step 5: Test it against the real container**

Run:
```bash
SYNTRA_PG_CONTAINER=infra-postgres-1 SYNTRA_PG_ROLE=syntra SYNTRA_PG_DB=syntra \
SYNTRA_BACKUP_DIR=/tmp/syntra-backups ./ops/syntra-backup create
```
Expected: a `syntra-<timestamp>/` directory with a `database.dump` over a few kilobytes and a manifest naming a non-zero `tableDataSections`. Confirm no `.partial` remains.

- [ ] **Step 6: Commit**

```bash
git add ops/syntra-backup
git commit -m "feat(ops): take a backup, and refuse to call a half-written one that"
```

---

### Task 3: `verify`

**Files:**
- Modify: `ops/syntra-backup`

**Interfaces:**
- Produces: `cmd_verify`

- [ ] **Step 1: Implement**

```
scratch="syntra_verify_$$"
trap 'docker exec "$PG_CONTAINER" dropdb -U "$PG_ROLE" --if-exists "$scratch" >/dev/null 2>&1 || true' EXIT
```

The trap is registered **before** the database is created, so an interrupted verify cannot leave one behind.

Then `createdb`, `pg_restore` into it (tolerating the ownership notices a cross-database restore always emits — check the exit of a following `psql` probe rather than trusting `pg_restore`'s status), and count:

```sql
SELECT COALESCE(SUM(n_live_tup), 0) FROM pg_stat_user_tables;
```

Zero rows is a **failure**, for the same reason an empty dump is. Report tables and rows, then let the trap drop the scratch database.

`pg_stat_user_tables` is an estimate; run `ANALYZE` first so the number is real, and say so in a comment — a verify that reports "0 rows" because statistics were never gathered is a false alarm that teaches operators to ignore it.

- [ ] **Step 2: Test it**

Run:
```bash
SYNTRA_PG_CONTAINER=infra-postgres-1 SYNTRA_PG_ROLE=syntra SYNTRA_PG_DB=syntra \
SYNTRA_BACKUP_DIR=/tmp/syntra-backups ./ops/syntra-backup verify latest
```
Expected: a table and row count, exit 0, and `docker exec infra-postgres-1 psql -U syntra -l` shows no `syntra_verify_*` left behind.

Then truncate a copy of a dump (`head -c 2000`) and verify it: expected to FAIL, which is the case structural checks miss.

- [ ] **Step 3: Commit**

```bash
git add ops/syntra-backup
git commit -m "feat(ops): prove a backup restores, into a database nobody is using"
```

---

### Task 4: `restore` and `list`

**Files:**
- Modify: `ops/syntra-backup`

**Interfaces:**
- Produces: `cmd_restore`, `cmd_list`, `main`

- [ ] **Step 1: Implement `cmd_list`**

Name, age, size, version, table count, and a fingerprint column reading `ok`, `MISMATCH` or `unknown` against the running key. The answer to "can I restore this?" belongs on the screen before the incident.

- [ ] **Step 2: Implement `cmd_restore`**

In order, refusing before anything is written:

1. The directory exists and is not `.partial`.
2. `database.dump` passes the same four checks `create` applied. A backup can rot on disk.
3. The fingerprint matches, or `--accept-secret-loss` was given. The refusal names both fingerprints and says what restoring anyway would cost, in the words the spec gives.
4. `--yes` was given.

Then stop the service, restore with `syntra-update`'s sequence — **schemas dropped first**, for the reason that file documents at length — and start the service. Read `restore_database` in `syntra-update` and follow it; the ordering there is a fix for a real defect.

- [ ] **Step 3: Implement `main`**

`create`, `verify`, `restore`, `list`, `help`. An unknown or absent subcommand prints usage and exits non-zero — never defaults to `create`, because a tool whose bare invocation writes something is a tool that writes something by accident.

- [ ] **Step 4: Test the refusals**

Run each and confirm the exit code and the message:
```bash
./ops/syntra-backup restore syntra-...          # refuses: no --yes
./ops/syntra-backup restore syntra-....partial --yes   # refuses: partial
SYNTRA_MASTER_KEY_OVERRIDE=wrong ./ops/syntra-backup restore syntra-... --yes  # refuses: fingerprint
./ops/syntra-backup                              # usage, non-zero
```

- [ ] **Step 5: Commit**

```bash
git add ops/syntra-backup
git commit -m "feat(ops): restore, and every reason not to"
```

---

### Task 5: Timers, installed and disabled

**Files:**
- Create: `ops/systemd/syntra-backup.service`, `.timer`
- Create: `ops/systemd/syntra-backup-verify.service`, `.timer`
- Modify: `ops/syntra-install`

- [ ] **Step 1: Write the units**

Both services are `Type=oneshot` running `/opt/syntra/bin/syntra-backup create` and `… verify latest`. Daily and weekly timers with `Persistent=true`, so a host that was off does not silently skip a week.

- [ ] **Step 2: Install them, enable nothing**

In `syntra-install`, beside the updater install, copy the binary and the units and print the two `systemctl enable --now` lines. **Do not enable them.** A tool that silently starts writing gigabytes to a disk nobody sized is a tool that gets uninstalled — and enabling a unit on an operator's behalf is a change they did not ask for on a host they own.

- [ ] **Step 3: Verify the install path is syntactically sound**

Run: `bash -n ops/syntra-install && bash -n ops/syntra-backup`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add ops/systemd ops/syntra-install
git commit -m "feat(ops): timers for both, enabled by nobody but the operator"
```

---

### Task 6: Documentation

**Files:**
- Modify: `docs/operate.md`
- Modify: `README.md`

- [ ] **Step 1: Rewrite Backups**

Keep the two things to keep, in the same words — the tool detects a key mismatch, it does not fix one, and an operator who reads only the tool's help must still be told to keep `MASTER_KEY`.

Add: the four commands, where backups land and why not in `$SHARED/backups`, the two timers and the lines that enable them, and what the fingerprint refusal means when they meet it, including when `--accept-secret-loss` is the right answer.

Say plainly that **off-host copies are not this tool's job** and name `rsync` and `restic` as the tools that do it.

- [ ] **Step 2: Say the verify timer is the point**

A backup schedule nobody checks produces a directory of files shaped like backups. The weekly verify is what makes the schedule mean something, and the documentation should say so rather than listing it as one command among four.

- [ ] **Step 3: README**

The Core row mentions backup and restore with verification.

- [ ] **Step 4: Verify every claim against the code**

Every command name, flag, path and default in the prose must exist in the script. The stale revocation paragraph in cluster A is what happens when this step is skipped.

- [ ] **Step 5: Commit**

```bash
git add docs/operate.md README.md
git commit -m "docs: how to take a backup, and how to know it is one"
```

---

## Self-Review

**Spec coverage.** The artifact layout and manifest → Task 2. The fingerprint and its refusal → Tasks 1 (comparison) and 4 (refusal). `create`, `verify`, `restore`, `list` → Tasks 2, 3, 4. Atomic `.partial` rename → Task 2. Retention that ignores partials → Task 1's `backups_to_prune` and Task 2's `prune_backups`. Timers installed-not-enabled → Task 5. Testing → Task 1's sourced-function tests plus the container checks in Tasks 2 and 3. Documentation → Task 6. The spec's non-goals — off-host copies, point-in-time recovery, volume-level copies, a console screen — have no tasks, correctly.

**Type consistency.** `backup_name_for`, `backups_to_prune`, `fingerprint_of`, `fingerprints_match`, `manifest_field`, `env_value`, `pg_url_field`, `resolve_environment`, `dump_database`, `write_manifest`, `prune_backups`, `cmd_create`, `cmd_verify`, `cmd_restore`, `cmd_list`, `main` are each named once and used with those names throughout.

**Known soft spots.** Three places where the repository or the host has the final say: whether `date -u -d @` or `date -u -r` is available (Task 1); the exact fallbacks in `syntra-update`'s `resolve_environment`, which must be read and followed rather than guessed (Task 2); and whether `pg_restore`'s exit status is trustworthy across a cross-database restore, which is why Task 3 probes with `psql` afterwards instead.
