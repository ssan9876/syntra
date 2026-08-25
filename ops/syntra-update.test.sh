#!/usr/bin/env bash
#
# Tests for the decision-making inside `syntra-update`.
#
# The functions are SOURCED OUT OF THE SHIPPED SCRIPT rather than copied here,
# for the same reason `syntra-reap.Tests.ps1` parses the reap script: a test
# that carries its own copy of the logic passes forever while the shipped code
# does something else entirely.
#
#   ./ops/syntra-update.test.sh

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The guard at the bottom of the script means sourcing it defines the helpers
# and runs nothing.
SYNTRA_UPDATE_SOURCE_ONLY=1
export SYNTRA_UPDATE_SOURCE_ONLY
# shellcheck source=/dev/null
. "$HERE/syntra-update"

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

# --- version_newer ----------------------------------------------------------

ok "1.4.1 is newer than 1.4.0"      "$(yes_no version_newer 1.4.1 1.4.0)" yes
ok "1.4.0 is not newer than 1.4.1"  "$(yes_no version_newer 1.4.0 1.4.1)" no
ok "a version is not newer than itself" "$(yes_no version_newer 1.4.0 1.4.0)" no

# The one a lexical comparison gets backwards, silently, and which would make
# the console offer a DOWNGRADE as an update.
ok "1.10.0 is newer than 1.9.0"     "$(yes_no version_newer 1.10.0 1.9.0)" yes
ok "1.9.0 is not newer than 1.10.0" "$(yes_no version_newer 1.9.0 1.10.0)" no
ok "2.0.0 is newer than 1.99.99"    "$(yes_no version_newer 2.0.0 1.99.99)" yes

# `dev` must never compare as older than a release: an install that is somebody's
# working tree has to be refused, not quietly overwritten.
ok "a release is not newer than dev" "$(yes_no version_newer 1.4.0 dev)" no

# --- version_valid ----------------------------------------------------------

ok "an ordinary version is accepted" "$(yes_no version_valid 1.4.0)" yes
ok "a two-part version is accepted"  "$(yes_no version_valid 2026.8)" yes

# This value is concatenated into a filesystem path. Every one of these would
# put the unpacked tree somewhere nobody chose.
ok "traversal is refused"            "$(yes_no version_valid ../../etc)" no
ok "a slash is refused"              "$(yes_no version_valid 1.4/0)" no
ok "an absolute path is refused"     "$(yes_no version_valid /etc/passwd)" no
ok "a leading dot is refused"        "$(yes_no version_valid .ssh)" no
ok "a dot-dot anywhere is refused"   "$(yes_no version_valid 1..4)" no
ok "an empty version is refused"     "$(yes_no version_valid '')" no
ok "a command substitution is refused" "$(yes_no version_valid '1.0;rm -rf /')" no
ok "dev is refused as a target"      "$(yes_no version_valid dev)" no

# --- adoption_allowed -------------------------------------------------------
#
# A converted in-place tree is `dev`, and `dev` must never be updatable FROM
# THE CONSOLE: a tarball unpacks cleanly over a working tree and takes
# uncommitted work with it without saying so. But `dev` is also the only
# deployment that exists, so refusing it everywhere leaves no path to a first
# release at all. The path is a person at a keyboard passing --adopt.

ok "an ordinary release may be updated"    "$(yes_no adoption_allowed 1.4.0 '')" yes
ok "dev is refused without adoption"       "$(yes_no adoption_allowed dev '')" no
ok "dev is permitted with adoption"        "$(yes_no adoption_allowed dev 1)" yes
# --adopt is for the FIRST release only. Passing it on a real install would
# skip the is-this-newer check, which is the guard against installing a
# downgrade by typing the wrong number.
ok "adoption is refused on a real release" "$(yes_no adoption_allowed 1.4.0 1)" no

# --- releases_to_prune ------------------------------------------------------

ok "nothing is pruned below the limit" \
  "$(releases_to_prune 3 1.4.0 1.2.0 1.3.0 1.4.0 | tr '\n' ' ' | sed 's/ $//')" ""

ok "the oldest goes first" \
  "$(releases_to_prune 3 1.5.0 1.1.0 1.2.0 1.3.0 1.4.0 1.5.0 | tr '\n' ' ' | sed 's/ $//')" \
  "1.1.0 1.2.0"

# Deleting the release you are running is how a rollback becomes impossible at
# the moment it is needed.
ok "the protected release is never pruned" \
  "$(releases_to_prune 1 1.1.0 1.1.0 1.2.0 1.3.0 | tr '\n' ' ' | sed 's/ $//')" \
  "1.2.0"

ok "versions are ordered numerically, not lexically" \
  "$(releases_to_prune 2 1.10.0 1.2.0 1.9.0 1.10.0 | tr '\n' ' ' | sed 's/ $//')" \
  "1.2.0"

# --- status_line ------------------------------------------------------------

ok "the status line is three tab-separated fields" \
  "$(status_line migrating 'applying migrations' | awk -F'\t' '{print NF}')" "3"

ok "the status line carries the step" \
  "$(status_line migrating 'applying migrations' | cut -f2)" "migrating"

ok "the status line carries the detail" \
  "$(status_line migrating 'applying migrations' | cut -f3)" "applying migrations"

# --- env_value --------------------------------------------------------------
#
# The updater has to learn the deployment's connection string, its port and its
# container name from the same file the service is started with. It must NOT
# learn them by sourcing it: that file holds MASTER_KEY and RELEASE_TOKEN, whose
# values are chosen by base64 and by GitHub rather than by anybody thinking
# about shell quoting.

ENVFILE="$(mktemp)"
cat > "$ENVFILE" <<'EOF'
# A comment, and a commented-out key that must not be found.
# PORT=9999
DATABASE_URL=postgresql://syntra_app:syntra_app@localhost:5432/syntra
PORT=3000
QUOTED="quoted value"
SINGLE='single value'
export EXPORTED=exported
TRAILING=value   
EOF

ok "reads a plain value"        "$(env_value DATABASE_URL "$ENVFILE")" \
  "postgresql://syntra_app:syntra_app@localhost:5432/syntra"
ok "reads a numeric value"      "$(env_value PORT "$ENVFILE")" "3000"
ok "strips double quotes"       "$(env_value QUOTED "$ENVFILE")" "quoted value"
ok "strips single quotes"       "$(env_value SINGLE "$ENVFILE")" "single value"
ok "reads an exported key"      "$(env_value EXPORTED "$ENVFILE")" "exported"
ok "strips trailing whitespace" "$(env_value TRAILING "$ENVFILE")" "value"
ok "ignores a commented key"    "$(env_value PORT "$ENVFILE")" "3000"
ok "an absent key is empty"     "$(env_value NOPE "$ENVFILE")" ""
# Not an error: an install may legitimately not have the file yet, and the
# caller decides what a missing value means. Exiting non-zero here would take
# the whole updater down under `set -e` for a key nobody required.
ok "an absent file is empty"    "$(env_value PORT /nonexistent/env)" ""
rm -f "$ENVFILE"

# --- pg_url_field -----------------------------------------------------------
#
# The dump, the restore and the migration all need to know WHICH database, and
# the answer is in DATABASE_URL rather than in this script.

PGURL="postgresql://syntra_app:s3cr3t@localhost:5432/syntra"
ok "reads the role"    "$(pg_url_field user "$PGURL")" "syntra_app"
ok "reads the database" "$(pg_url_field db  "$PGURL")" "syntra"
ok "drops query parameters" \
  "$(pg_url_field db 'postgresql://u:p@h:5432/syntra?schema=public&sslmode=require')" "syntra"
ok "reads a url with no password" "$(pg_url_field user 'postgresql://syntra@h:5432/syntra')" "syntra"
# Refused rather than guessed. A default database name is how a restore lands
# somewhere nobody chose.
ok "refuses a url with no database" "$(pg_url_field db 'postgresql://u:p@h:5432' || echo ERR)" "ERR"
ok "refuses a url with no role"     "$(pg_url_field user 'postgresql://h:5432/syntra' || echo ERR)" "ERR"
ok "refuses an unknown field"       "$(pg_url_field port "$PGURL" || echo ERR)" "ERR"

# --- rewritten_web_root -----------------------------------------------------
#
# WEB_ROOT is what makes one process serve the console as well as the API, and
# syntra-install used to copy .env verbatim. An absolute path kept serving the
# OLD tree's bundle forever -- with the readiness `web` probe passing, because
# a file was there -- and a relative one resolved against the new working
# directory and failed readiness, so every update rolled back.

ok "an absolute path under the old tree is re-anchored" \
  "$(rewritten_web_root /root/syntra/apps/web/dist /root/syntra /opt/syntra)" \
  "/opt/syntra/current/apps/web/dist"

# A relative WEB_ROOT resolves against the process's working directory, which
# systemd sets to <root>/apps/api. Made absolute here rather than left to
# resolve somewhere new.
ok "a relative path is made absolute against the release" \
  "$(rewritten_web_root apps/web/dist /root/syntra /opt/syntra)" \
  "/opt/syntra/current/apps/web/dist"

ok "a trailing slash does not double up" \
  "$(rewritten_web_root /root/syntra/apps/web/dist/ /root/syntra /opt/syntra)" \
  "/opt/syntra/current/apps/web/dist"

# Somebody serving a bundle from outside the tree meant it. Re-anchoring that
# would point the console at a directory that does not exist.
ok "a path outside the old tree is left alone" \
  "$(rewritten_web_root /srv/syntra-console /root/syntra /opt/syntra || echo LEAVE)" "LEAVE"

ok "a path already under the new root is left alone" \
  "$(rewritten_web_root /opt/syntra/current/apps/web/dist /root/syntra /opt/syntra || echo LEAVE)" "LEAVE"

ok "an unset WEB_ROOT is left alone" \
  "$(rewritten_web_root '' /root/syntra /opt/syntra || echo LEAVE)" "LEAVE"

# --- report -----------------------------------------------------------------

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
