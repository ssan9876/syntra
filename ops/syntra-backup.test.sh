#!/usr/bin/env bash
#
# Tests for the decision-making inside `syntra-backup`.
#
# The functions are SOURCED OUT OF THE SHIPPED SCRIPT rather than copied here,
# for the reason `syntra-update.test.sh` gives: a test that carries its own
# copy of the logic passes forever while the shipped code does something else
# entirely.
#
#   ./ops/syntra-backup.test.sh

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The guard at the bottom of the script means sourcing it defines the helpers
# and runs nothing.
SYNTRA_BACKUP_SOURCE_ONLY=1
export SYNTRA_BACKUP_SOURCE_ONLY
# shellcheck source=/dev/null
. "$HERE/syntra-backup"

pass=0
fail=0

ok() {
  if [ "$2" = "$3" ]; then
    pass=$(( pass + 1 ))
  else
    fail=$(( fail + 1 ))
    printf 'FAIL: %s\n  expected: %s\n  actual:   %s\n' "$1" "$3" "$2" >&2
  fi
}

# Only the exit status. The function's own stdout is discarded, because
# `empty_restore_reason` both prints WHY and fails -- and letting that reason
# through would concatenate it with the verdict below.
yes_no() { if "$@" >/dev/null; then echo yes; else echo no; fi; }

# 2026-08-30T02:11:04Z, and the second before it.
T=1788055864

# --- backup_name_for --------------------------------------------------------

ok "names a backup after its UTC instant" \
   "$(backup_name_for "$T")" "syntra-20260830T021104Z"

ok "sorts lexically in time order" \
   "$(printf '%s\n%s\n' "$(backup_name_for "$T")" "$(backup_name_for $(( T - 1 )))" | sort | head -1)" \
   "syntra-20260830T021103Z"

ok "is filesystem-safe" \
   "$(backup_name_for "$T" | tr -d 'A-Za-z0-9:-' | wc -c)" "1"

# --- backups_to_prune -------------------------------------------------------

ok "prunes nothing when there are fewer than KEEP" \
   "$(backups_to_prune 3 syntra-3 syntra-2 syntra-1)" ""

ok "prunes nothing when there are exactly KEEP" \
   "$(backups_to_prune 3 syntra-3 syntra-2 syntra-1)" ""

ok "prunes the oldest beyond KEEP" \
   "$(backups_to_prune 2 syntra-3 syntra-2 syntra-1)" "syntra-1"

ok "keeps the newest whatever order it was given them in" \
   "$(backups_to_prune 1 syntra-1 syntra-3 syntra-2)" "$(printf 'syntra-2\nsyntra-1')"

# A `.partial` is not a backup. Deleting one as though it were would remove
# the evidence of an interrupted run; COUNTING one would silently keep one
# fewer real backup than the operator configured.
ok "never prunes a partial directory" \
   "$(backups_to_prune 1 syntra-3.partial syntra-2 syntra-1)" "syntra-1"

ok "never counts a partial toward the retention asked for" \
   "$(backups_to_prune 2 syntra-3.partial syntra-2 syntra-1)" ""

ok "prunes nothing when given nothing" "$(backups_to_prune 3)" ""

# --- fingerprint_of ---------------------------------------------------------

ok "fingerprints a key stably" \
   "$(fingerprint_of hunter2)" "$(fingerprint_of hunter2)"

ok "fingerprints different keys differently" \
   "$(yes_no test "$(fingerprint_of a)" != "$(fingerprint_of b)")" yes

ok "does not contain the key" \
   "$(fingerprint_of hunter2 | grep -c hunter2)" "0"

ok "is salted, so it is not a bare digest of the key" \
   "$(yes_no test "$(fingerprint_of hunter2)" != "sha256:$(printf 'hunter2' | sha256sum | cut -d' ' -f1)")" yes

# --- fingerprints_match -----------------------------------------------------

ok "equal fingerprints match"      "$(yes_no fingerprints_match abc abc)" yes
ok "different fingerprints do not" "$(yes_no fingerprints_match abc def)" no

# The cases that matter. An unknown fingerprint must never read as agreement,
# because agreement is what skips the refusal -- and a damaged manifest is
# exactly when the refusal is most wanted.
ok "an unknown backup fingerprint does not match" "$(yes_no fingerprints_match "" abc)" no
ok "an unknown running key does not match"        "$(yes_no fingerprints_match abc "")" no
ok "two unknowns do not match either"             "$(yes_no fingerprints_match "" "")" no
ok "the literal string null does not match itself" \
   "$(yes_no fingerprints_match null null)" no

# --- manifest_field ---------------------------------------------------------

m=$(mktemp)
cat > "$m" <<'JSON'
{
  "createdAt": "2026-08-30T02:11:04Z",
  "version": "1.7.2",
  "database": "syntra",
  "tableDataSections": 87,
  "bytes": 4718592,
  "masterKeyFingerprint": "sha256:9f2b"
}
JSON

ok "reads a string field"  "$(manifest_field version "$m")" "1.7.2"
ok "reads a field whose value contains a colon" \
   "$(manifest_field masterKeyFingerprint "$m")" "sha256:9f2b"
ok "reads a numeric field" "$(manifest_field tableDataSections "$m")" "87"
ok "reads the last field, with no trailing comma" \
   "$(manifest_field masterKeyFingerprint "$m")" "sha256:9f2b"
ok "answers empty for a field that is not there" "$(manifest_field nope "$m")" ""
ok "answers empty for a file that is not there"  "$(manifest_field version /nonexistent)" ""

# A key that was not readable is recorded as JSON null, not as "". A reader
# must be able to tell "there was no key" from "the key was empty".
cat > "$m" <<'JSON'
{
  "version": "1.7.2",
  "masterKeyFingerprint": null
}
JSON
ok "reads an unquoted null as empty" "$(manifest_field masterKeyFingerprint "$m")" "null"

rm -f "$m"

# --- running_version --------------------------------------------------------
#
# The manifest's version is how a restore tells which schema a dump belongs
# to. This read the workspace root package.json, which is `private` and
# carries no `version` key at all -- so every backup taken on a real install
# recorded "unknown", and the field was decoration. RELEASE.json, written by
# the release into the same directory, is the file that knows.

RV_ROOT=$(mktemp -d)
mkdir -p "$RV_ROOT/current"
RV_SAVED="$ROOT"
ROOT="$RV_ROOT"

ok "unknown when the install has neither file" "$(running_version)" "unknown"

cat > "$RV_ROOT/current/package.json" <<'JSON'
{
  "name": "syntra",
  "private": true,
  "type": "module"
}
JSON
ok "unknown for the real workspace package.json" "$(running_version)" "unknown"

cat > "$RV_ROOT/current/RELEASE.json" <<'JSON'
{
  "version": "1.11.3",
  "released": "2026-08-30T23:59:00Z",
  "commit": "1775771"
}
JSON
ok "reads the version the release wrote" "$(running_version)" "1.11.3"

rm -f "$RV_ROOT/current/RELEASE.json"
cat > "$RV_ROOT/current/package.json" <<'JSON'
{
  "version": "9.9.9"
}
JSON
ok "falls back to package.json in a working tree" "$(running_version)" "9.9.9"

ROOT="$RV_SAVED"
rm -rf "$RV_ROOT"

# --- empty_restore_reason ---------------------------------------------------
#
# `restore` dropped the public schema, ran pg_restore with its status thrown
# away (it reports ownership notices as errors), asked `SELECT 1`, and logged
# "restored". A pg_restore that failed outright therefore left an EMPTY
# database, a started service, and a log line saying everything was fine.
# `verify` already counted tables and rows; this is that count, extracted so
# both commands ask it and the tests can reach it.

ok "a restore with tables and rows is a restore" \
   "$(yes_no empty_restore_reason 87 4096)" yes

ok "an empty database is not a restore" \
   "$(yes_no empty_restore_reason 0 0)" no
ok "and says so" \
   "$(empty_restore_reason 0 0)" "no tables"

# The shape an RLS-filtered dump restores to: every table, none of the rows.
ok "tables without rows is not a restore either" \
   "$(yes_no empty_restore_reason 87 0)" no
ok "and names the count, so the operator can tell it from no tables" \
   "$(empty_restore_reason 87 0)" "87 table(s) and no rows at all"

# A psql that could not connect prints nothing. Nothing is not evidence.
ok "no answer at all is not a restore"  "$(yes_no empty_restore_reason '' '')" no
ok "a non-numeric answer is not a restore" \
   "$(yes_no empty_restore_reason 'ERROR' 'ERROR')" no
ok "no arguments at all is not a restore" "$(yes_no empty_restore_reason)" no

# ---------------------------------------------------------------------------

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
