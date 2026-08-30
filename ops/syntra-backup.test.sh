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

yes_no() { if "$@"; then echo yes; else echo no; fi; }

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

# ---------------------------------------------------------------------------

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
