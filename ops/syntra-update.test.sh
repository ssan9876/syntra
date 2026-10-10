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

# Only the exit status. The function's own stdout is discarded, because
# `empty_restore_reason` both prints WHY and fails -- and letting that reason
# through would concatenate it with the verdict below.
yes_no() { if "$@" >/dev/null; then echo yes; else echo no; fi; }

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

# `sort -V` puts the literal `dev` and any `<v>.partial` AFTER real versions,
# so both used to land in the newest-three and count against the limit -- which
# means a half-unpacked download could evict a release somebody may need to
# roll back to, and the conversion's copy of the working tree was never pruned
# at all.

ok "a partial directory is not a release" \
  "$(releases_to_prune 2 1.3.0 1.1.0 1.2.0 1.3.0 1.4.0.partial | tr '\n' ' ' | sed 's/ $//')" \
  "1.1.0"

ok "dev does not count against the limit" \
  "$(releases_to_prune 2 1.3.0 dev 1.1.0 1.2.0 1.3.0 | tr '\n' ' ' | sed 's/ $//')" \
  "1.1.0"

# It is the recovery point for a bad conversion. Deleting it is how somebody
# loses the tree they were told was still sitting there.
ok "dev is never pruned" \
  "$(releases_to_prune 1 1.3.0 dev 1.1.0 1.2.0 1.3.0 | tr '\n' ' ' | sed 's/ $//')" \
  "1.1.0 1.2.0"

# --- previous_release_of ----------------------------------------------------
#
# Where a rollback goes. Sorting the raw listing meant it could go to a
# half-unpacked download that failed its checksum, or to an unversioned copy
# of somebody's working tree.

ok "the newest older release" \
  "$(previous_release_of 1.5.0 1.3.0 1.4.0 1.5.0)" "1.4.0"

ok "ordered numerically, not lexically" \
  "$(previous_release_of 1.10.0 1.2.0 1.9.0 1.10.0)" "1.9.0"

ok "a partial download is never a rollback target" \
  "$(previous_release_of 1.5.0 1.4.0 1.5.0 1.6.0.partial)" "1.4.0"

# After an adoption there is exactly one release and the tree it replaced.
# Going back to that tree is the correct and only answer.
ok "falls back to the adopted working tree" \
  "$(previous_release_of 1.0.0 dev 1.0.0)" "dev"

ok "refuses when there is nowhere to go" \
  "$(previous_release_of 1.0.0 1.0.0 || echo NONE)" "NONE"

# THE BUG THIS FUNCTION USED TO HAVE: a release newer than $now is not a
# "previous" release, it is the one that was just judged broken. Returning
# it sent --rollback FORWARD into a failed release with a much-older dump.
ok "never answers with a release newer than now" \
  "$(previous_release_of 1.4.0 1.4.0 1.5.0 || echo NONE)" "NONE"

# --- previous_release ---------------------------------------------------------
#
# previous_release_of() above is pure -- it only sees a list already believed
# to be real releases. previous_release() is what actually builds that list,
# by default from ls -1 on releases/ -- and a directory there means something
# was UNPACKED, not that it ever ran. Update rehearsal Step 10 (a migration
# that fails on purpose) leaves exactly that kind of orphan: a release
# directory sitting on disk, numerically between the true previous version
# and the one that failed to replace it, that no unit test above this line
# can tell apart from a real one. Running the full rehearsal in the plan's own
# order hit this for real -- `--rollback` after Step 10's orphan landed on
# v1.0.2's code paired with v1.0.1's restored data, a genuine version
# mismatch, rather than the v1.0.1 the plan asserts. record_previous() and the
# PREVIOUS_FILE it writes are the fix; these tests are against
# previous_release() itself, with real files, because the bug lived in how it
# gathers its candidates, not in how they are compared.

PR_ROOT="$(mktemp -d)"
mkdir -p "$PR_ROOT/releases/1.0.1" "$PR_ROOT/releases/1.0.2" "$PR_ROOT/releases/1.0.3" \
  "$PR_ROOT/current" "$PR_ROOT/var"
printf '{"version": "1.0.3"}' > "$PR_ROOT/current/RELEASE.json"
RELEASES="$PR_ROOT/releases"
CURRENT="$PR_ROOT/current"
VAR="$PR_ROOT/var"
PREVIOUS_FILE="$VAR/previous-version"

# THE BUG, reproduced: releases/1.0.2 is an orphan (unpacked, never adopted --
# nothing ever recorded a successful transition), and with no history to
# consult, the scan has no way to tell it from a real predecessor.
ok "with no recorded history, an orphaned unpack is indistinguishable from a real predecessor (the bug)" \
  "$(previous_release)" "1.0.2"

# THE FIX: a prior successful update recorded 1.0.1 as the version it left.
printf '1.0.1\n' > "$PREVIOUS_FILE"
ok "recorded history is trusted over the directory scan" \
  "$(previous_release)" "1.0.1"

# A recorded version that is no longer on disk (pruned, or never real) must
# not be trusted blindly -- that would point --rollback at nothing.
printf '9.9.9\n' > "$PREVIOUS_FILE"
ok "a recorded version missing from disk falls back to the scan" \
  "$(previous_release)" "1.0.2"

# A recorded version equal to the one currently running is stale -- left over
# from before the update that is running now -- and must not be echoed back
# as its own rollback target.
printf '1.0.3\n' > "$PREVIOUS_FILE"
ok "a recorded version matching the current one falls back to the scan" \
  "$(previous_release)" "1.0.2"

# The state immediately after --adopt: no PREVIOUS_FILE would exist this
# early in the real sequence, but a recorded "dev" must still resolve, since
# that IS the correct answer immediately after a first adoption.
printf 'dev\n' > "$PREVIOUS_FILE"
ok "a recorded dev is trusted like any other recorded version" \
  "$(previous_release)" "dev"

rm -rf "$PR_ROOT"

# --- parse_asset_url ---------------------------------------------------------
#
# Cutting v1.0.0-v1.0.3 was the first time asset_url() (the network-calling
# wrapper around this) ever ran against the real API, and it failed every
# time -- the old implementation split the response on `,` and assumed an
# asset's own "url" key sat on the line immediately before its "name" key.
# GitHub's real response, pretty-printed with one field per line, puts "id"
# and "node_id" in between, and `grep -A0 -B0` inserts a `--` group separator
# between non-adjacent matches -- which then became "the line before name"
# instead of the actual url. This is a real capture of that shape (trimmed to
# the fields that matter), not a guess at it.

GITHUB_SHAPED_RESPONSE='{
  "tag_name": "v1.0.3",
  "assets": [
    {
      "url": "https://api.github.com/repos/ssan9876/syntra/releases/assets/529772609",
      "id": 529772609,
      "node_id": "RA_kwDOT6fZdc4fk7BB",
      "name": "syntra-1.0.3.tar.gz",
      "label": "",
      "uploader": {
        "login": "github-actions[bot]",
        "id": 41898282,
        "url": "https://api.github.com/users/github-actions%5Bbot%5D"
      },
      "content_type": "application/x-gtar",
      "browser_download_url": "https://github.com/ssan9876/syntra/releases/download/v1.0.3/syntra-1.0.3.tar.gz"
    },
    {
      "url": "https://api.github.com/repos/ssan9876/syntra/releases/assets/529772610",
      "id": 529772610,
      "node_id": "RA_kwDOT6fZdc4fk7BC",
      "name": "syntra-1.0.3.tar.gz.sha256",
      "label": "",
      "uploader": {
        "login": "github-actions[bot]",
        "id": 41898282,
        "url": "https://api.github.com/users/github-actions%5Bbot%5D"
      }
    }
  ]
}'

ok "finds the tarball's url in a real-GitHub-shaped, multi-line response" \
  "$(parse_asset_url "$GITHUB_SHAPED_RESPONSE" "syntra-1.0.3.tar.gz")" \
  "https://api.github.com/repos/ssan9876/syntra/releases/assets/529772609"

ok "finds the checksum file's url, not the tarball's, in the same response" \
  "$(parse_asset_url "$GITHUB_SHAPED_RESPONSE" "syntra-1.0.3.tar.gz.sha256")" \
  "https://api.github.com/repos/ssan9876/syntra/releases/assets/529772610"

# THE BUG ITSELF: the old grep -A0 -B0 / -B1 pipeline, run against exactly
# this fixture, returns nothing -- proving this is a real regression test,
# not a test that would have passed against the broken implementation too.
OLD_BROKEN_ASSET_URL() {
  local name="$2"
  printf '%s' "$1" | tr ',' '\n' \
    | grep -A0 -B0 "\"url\": \"[^\"]*assets/[0-9]*\"\|\"name\": \"$name\"" \
    | grep -B1 "\"name\": \"$name\"" | grep '"url"' \
    | sed -n 's/.*"url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1
}
ok "the OLD implementation is confirmed broken against this exact fixture" \
  "$(OLD_BROKEN_ASSET_URL "$GITHUB_SHAPED_RESPONSE" "syntra-1.0.3.tar.gz" || echo EMPTY)" \
  "EMPTY"

# The uploader sub-object has its own "url" key, and it must never be
# mistaken for the asset's own url just because it appears somewhere in the
# same object -- it never ends in `/assets/<digits>`, which is what
# distinguishes the two.
ok "a nested uploader url is never returned in place of the asset's own" \
  "$(parse_asset_url "$GITHUB_SHAPED_RESPONSE" "syntra-1.0.3.tar.gz" \
     | grep -c '/users/')" \
  "0"

ok "an asset name that does not exist in the response resolves to nothing" \
  "$(parse_asset_url "$GITHUB_SHAPED_RESPONSE" "syntra-1.0.3.tar.gz.does-not-exist")" \
  ""

# The shape make-release.sh's stub server actually emits: everything on one
# line, no whitespace after colons. The real bug was about DISTANCE between
# keys, not formatting, so this is a second, differently-shaped fixture
# proving the fix is not accidentally tied to one JSON layout.
COMPACT_RESPONSE='{"tag_name":"v1.0.0","assets":[{"url":"http://127.0.0.1:8899/assets/0","name":"syntra-1.0.0.tar.gz"},{"url":"http://127.0.0.1:8899/assets/1","name":"syntra-1.0.0.tar.gz.sha256"}]}'

ok "also works against a compact, single-line response" \
  "$(parse_asset_url "$COMPACT_RESPONSE" "syntra-1.0.0.tar.gz")" \
  "http://127.0.0.1:8899/assets/0"

ok "picks the right one of two compact-JSON assets by name" \
  "$(parse_asset_url "$COMPACT_RESPONSE" "syntra-1.0.0.tar.gz.sha256")" \
  "http://127.0.0.1:8899/assets/1"

# --- parse_tag_name ---------------------------------------------------------
#
# The bug these cover was never in the parsing. `latest_version()` read the
# right version and `do_check` printed "latest: unknown" anyway, because
# `latest=$(latest_version) || latest=""` believed a non-zero status that came
# from auth_curl's leaked RETURN trap rather than from the lookup. Hence the
# last case, which asserts the STATUS and not just the answer: a helper that
# is right and non-zero is what took the lab off updates for a day.

ok "reads the version out of a real-GitHub-shaped response, without the v" \
  "$(parse_tag_name "$GITHUB_SHAPED_RESPONSE")" "1.0.3"

ok "reads it out of a compact, single-line response too" \
  "$(parse_tag_name "$COMPACT_RESPONSE")" "1.0.0"

ok "takes a tag that carries no v prefix as it stands" \
  "$(parse_tag_name '{"tag_name": "1.2.3"}')" "1.2.3"

ok "keeps a v that is part of the version rather than a prefix" \
  "$(parse_tag_name '{"tag_name": "v1.2.3-rc.1"}')" "1.2.3-rc.1"

ok "fails, rather than answering emptily, on a response with no tag" \
  "$(yes_no parse_tag_name '{"message": "Not Found"}')" "no"

ok "succeeds -- the status, not just the answer, is what do_check reads" \
  "$(latest=$(parse_tag_name "$GITHUB_SHAPED_RESPONSE") || latest=""; echo "${latest:-unknown}")" \
  "1.0.3"

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

# --- empty_restore_reason ---------------------------------------------------
#
# restore_database drops every schema and then cannot trust pg_restore's exit
# status, so its last word used to be `SELECT 1` -- which an empty database
# answers. A pg_restore that failed during a rollback therefore ended with the
# service restarted over nothing and the console reading "restored v1.4.0".
# This is the count that tells the two apart; restore_database returns
# non-zero on it and restore_after_failure then says RESTORE IT BY HAND.

ok "a restore with tables and rows is a restore" \
  "$(yes_no empty_restore_reason 87 4096)" yes

ok "an empty database is not a restore" "$(yes_no empty_restore_reason 0 0)" no
ok "and says so" "$(empty_restore_reason 0 0)" "no tables"

ok "tables without rows is not a restore either" \
  "$(yes_no empty_restore_reason 87 0)" no
ok "and names the count" \
  "$(empty_restore_reason 87 0)" "87 table(s) and no rows at all"

# A psql that could not connect prints nothing, and nothing is not rows.
ok "no answer at all is not a restore" "$(yes_no empty_restore_reason '' '')" no
ok "a non-numeric answer is not a restore" \
  "$(yes_no empty_restore_reason ERROR ERROR)" no

# --- do_update: a version that is not newer ---------------------------------
#
# Refused before anything starts, so update.status -- what the console shows --
# keeps the record of the update that succeeded. It used to be overwritten
# with `failed`. In a subshell: refuse() exits.

NN_ROOT="$(mktemp -d)"
mkdir -p "$NN_ROOT/current" "$NN_ROOT/var"
printf '{"version": "1.4.2"}' > "$NN_ROOT/current/RELEASE.json"
printf 'x\tsucceeded\tnow running v1.4.2\n' > "$NN_ROOT/var/update.status"
NN_OUT="$(
  CURRENT="$NN_ROOT/current" VAR="$NN_ROOT/var" STATUS="$NN_ROOT/var/update.status" \
    RELEASES="$NN_ROOT/releases"
  do_update 1.4.2 '' 2>&1
)" && NN_CODE=0 || NN_CODE=$?
ok "updating to the running version exits non-zero" "$([ "$NN_CODE" -ne 0 ] && echo yes || echo no)" yes
ok "and says why" \
  "$(printf '%s' "$NN_OUT" | grep -c 'REFUSED: 1.4.2 is not newer than the running 1.4.2')" 1
ok "and leaves the previous success in update.status" \
  "$(cut -f2 "$NN_ROOT/var/update.status")" succeeded
ok "and downloads nothing" "$([ -d "$NN_ROOT/releases" ] && echo yes || echo no)" no
rm -rf "$NN_ROOT"

# --- every other pre-flight refusal -----------------------------------------
#
# The same promise as above, for each check that can fail before the first
# `status` call: exit non-zero, say REFUSED, and leave update.status holding
# the previous success. Each of these used die() and wrote `failed` over it.
#
# `preflight <running-version|dev> <function> [args...]` runs the function in
# a subshell against a scratch install and prints "<code>|<status>|<output>".

preflight() {
  local running="$1"; shift
  local root; root="$(mktemp -d)"
  mkdir -p "$root/current" "$root/var" "$root/shared" "$root/backups"
  if [ "$running" != dev ]; then
    printf '{"version": "%s"}' "$running" > "$root/current/RELEASE.json"
  fi
  printf 'x\tsucceeded\tnow running v%s\n' "$running" > "$root/var/update.status"
  : > "$root/shared/.env"
  local out code
  out="$(
    CURRENT="$root/current" VAR="$root/var" STATUS="$root/var/update.status" \
      RELEASES="$root/releases" SHARED="$root/shared" BACKUPS="$root/backups" \
      PREVIOUS_FILE="$root/var/previous"
    "$@" 2>&1
  )" && code=0 || code=$?
  printf '%s|%s|%s' "$code" "$(cut -f2 "$root/var/update.status")" "$out"
  [ -d "$root/releases" ] && printf '|DOWNLOADED'
  rm -rf "$root"
}

# Asserts one refusal: non-zero, REFUSED with `$3` in the message, the
# previous success intact, and nothing downloaded.
refused() {
  local name="$1" result="$2" says="$3"
  ok "$name: exits non-zero" "$([ "${result%%|*}" != 0 ] && echo yes || echo no)" yes
  ok "$name: says REFUSED" \
    "$(printf '%s' "$result" | grep -c "REFUSED: .*$says")" 1
  ok "$name: leaves the previous success in update.status" \
    "$(printf '%s' "$result" | cut -d'|' -f2)" succeeded
  ok "$name: downloads nothing" \
    "$(printf '%s' "$result" | grep -c '|DOWNLOADED')" 0
}

refused "an invalid version" \
  "$(SYNTRA_RELEASE_TOKEN=t preflight 1.4.2 do_update '../../etc' '')" \
  'is not a version this will install'

refused "--adopt on a real release" \
  "$(SYNTRA_RELEASE_TOKEN=t preflight 1.4.2 do_update 1.5.0 1)" \
  '--adopt is for a working tree'

refused "a working tree without --adopt" \
  "$(SYNTRA_RELEASE_TOKEN=t preflight dev do_update 1.5.0 '')" \
  'this install is a working tree'

refused "no release token" \
  "$(SYNTRA_RELEASE_TOKEN='' preflight 1.4.2 do_update 1.5.0 '')" \
  'no release token was provided'

refused "no DATABASE_URL" \
  "$(SYNTRA_DATABASE_URL='' preflight 1.4.2 resolve_environment)" \
  'no DATABASE_URL'

refused "a rollback with nowhere to go" \
  "$(preflight 1.4.2 do_rollback)" \
  'there is no previous release to go back to'

refused "no arguments at all" \
  "$(preflight 1.4.2 main)" \
  'usage: syntra-update'

refused "--adopt with no version" \
  "$(preflight dev main --adopt)" \
  'usage: syntra-update --adopt'

# die() is still what a failure AFTER work began uses: the console must see
# `failed` then. Asserted so a future sweep does not convert the wrong ones.
DIE_OUT="$(
  ROOT="$(mktemp -d)"; mkdir -p "$ROOT/var"
  VAR="$ROOT/var" STATUS="$ROOT/var/update.status"
  ( die "the downloaded release does not match its checksum" ) >/dev/null 2>&1
  cut -f2 "$ROOT/var/update.status"; rm -rf "$ROOT"
)"
ok "a failure once work began still records failed" "$DIE_OUT" failed

# --- downloads_to_prune -----------------------------------------------------
#
# The download step removed only the target's own tarball, so every update
# ever taken stayed in var/: one install held 30 of them, 94 MB.

ok "keeps the running and previous downloads, removes older ones" \
  "$(downloads_to_prune 1.5.0 1.4.0 \
      syntra-1.3.0.tar.gz syntra-1.3.0.tar.gz.sha256 \
      syntra-1.4.0.tar.gz syntra-1.4.0.tar.gz.sha256 \
      syntra-1.5.0.tar.gz syntra-1.5.0.tar.gz.sha256 | tr '\n' ' ' | sed 's/ $//')" \
  "syntra-1.3.0.tar.gz syntra-1.3.0.tar.gz.sha256"

ok "a checksum without its tarball is still removed" \
  "$(downloads_to_prune 1.5.0 1.4.0 syntra-1.1.0.tar.gz.sha256)" "syntra-1.1.0.tar.gz.sha256"

# var/ also holds update.status, the lock and previous-version. None of them
# is a download, and a name that only looks like one is not this function's.
ok "never removes anything that is not a release download" \
  "$(downloads_to_prune 1.5.0 1.4.0 update.status update.lock previous-version \
      replaced-units syntra-update.log syntra-.tar.gz syntra-../x.tar.gz notes.tar.gz)" ""

ok "versions compare exactly, not as prefixes" \
  "$(downloads_to_prune 1.5.0 1.4.0 syntra-1.5.0.1.tar.gz syntra-1.4.tar.gz | tr '\n' ' ' | sed 's/ $//')" \
  "syntra-1.5.0.1.tar.gz syntra-1.4.tar.gz"

# After an adoption the previous version is `dev`, which has no download.
ok "after an adoption only the running download is kept" \
  "$(downloads_to_prune 1.0.0 dev syntra-1.0.0.tar.gz syntra-0.9.0.tar.gz)" "syntra-0.9.0.tar.gz"

ok "nothing to prune in an empty var/" "$(downloads_to_prune 1.5.0 1.4.0)" ""

# --- prune_downloads --------------------------------------------------------

PD_ROOT="$(mktemp -d)"
for v in 1.1.0 1.2.0 1.3.0 1.4.0 1.5.0; do
  head -c 2048 /dev/zero > "$PD_ROOT/syntra-$v.tar.gz"
  printf 'abc  syntra-%s.tar.gz\n' "$v" > "$PD_ROOT/syntra-$v.tar.gz.sha256"
done
printf 'x\tsucceeded\tnow running v1.5.0\n' > "$PD_ROOT/update.status"
PD_OUT="$(VAR="$PD_ROOT"; prune_downloads 1.5.0 1.4.0 2>&1)"
ok "prune_downloads leaves the running and previous downloads and nothing else of var/" \
  "$(cd "$PD_ROOT" && printf '%s ' * | sed 's/ $//')" \
  "syntra-1.4.0.tar.gz syntra-1.4.0.tar.gz.sha256 syntra-1.5.0.tar.gz syntra-1.5.0.tar.gz.sha256 update.status"
ok "and says how many, from where, and what it kept" \
  "$(printf '%s' "$PD_OUT" | grep -c "removed 6 old download file(s) from $PD_ROOT, .* KB; kept v1.5.0 and v1.4.0")" 1
PD_OUT="$(VAR="$PD_ROOT"; prune_downloads 1.5.0 1.4.0 2>&1)"
ok "and says nothing when there is nothing to remove" "$PD_OUT" ""
rm -rf "$PD_ROOT"

ok "sizes from 1 MB up read in MB" "$(human_size 98566144)" "94 MB"
ok "sizes below 1 MB read in KB"   "$(human_size 6000)" "6 KB"

# --- owned_unit -------------------------------------------------------------
#
# An update refreshes the units Syntra ships and nothing else. syntra.service
# is the operator's, rewritten once by syntra-install; replacing it would undo
# their WorkingDirectory, environment and hardening.

ok "the backup service is Syntra's"          "$(yes_no owned_unit syntra-backup.service)" yes
ok "the backup timer is Syntra's"            "$(yes_no owned_unit syntra-backup.timer)" yes
ok "the verify service is Syntra's"          "$(yes_no owned_unit syntra-backup-verify.service)" yes
ok "the verify timer is Syntra's"            "$(yes_no owned_unit syntra-backup-verify.timer)" yes
ok "the OnFailure handler is Syntra's"       "$(yes_no owned_unit syntra-backup-failed@.service)" yes
ok "syntra.service is never touched"         "$(yes_no owned_unit syntra.service)" no
ok "the database unit is not refreshed"      "$(yes_no owned_unit syntra-postgres.service)" no
ok "a drop-in directory is not a unit"       "$(yes_no owned_unit syntra-backup.service.d)" no
ok "a README is not a unit"                  "$(yes_no owned_unit README)" no

# --- refresh_units ----------------------------------------------------------
#
# The case that prompted it: an install whose units predate OnFailure=, with
# the handler never installed, and syntra.service beside them.

RU_ROOT="$(mktemp -d)"
mkdir -p "$RU_ROOT/release/ops/systemd" "$RU_ROOT/etc" "$RU_ROOT/var"
printf '[Service]\nExecStart=new-backup\nOnFailure=x\n' > "$RU_ROOT/release/ops/systemd/syntra-backup.service"
printf '[Timer]\nOnCalendar=daily\n'     > "$RU_ROOT/release/ops/systemd/syntra-backup.timer"
printf '[Service]\nExecStart=handler\n'  > "$RU_ROOT/release/ops/systemd/syntra-backup-failed@.service"
printf '[Service]\nExecStart=release-copy-of-syntra\n' > "$RU_ROOT/release/ops/systemd/syntra.service"
printf '[Service]\nExecStart=old-backup\n' > "$RU_ROOT/etc/syntra-backup.service"
printf '[Timer]\nOnCalendar=daily\n'       > "$RU_ROOT/etc/syntra-backup.timer"
printf '[Service]\nExecStart=operators-own\n' > "$RU_ROOT/etc/syntra.service"
: > "$RU_ROOT/calls"

ru_run() {
  # systemctl is a function here, so the test records the call instead of
  # reloading the machine it runs on.
  # shellcheck disable=SC2329  # called by refresh_units
  systemctl() { printf '%s\n' "$*" >> "$RU_ROOT/calls"; }
  UNIT_DIR="$RU_ROOT/etc" UNIT_BACKUPS="$RU_ROOT/var/replaced-units"
  refresh_units "$RU_ROOT/release/ops/systemd" 1.5.0 2>&1
}
RU_OUT="$(ru_run)"

ok "a changed unit is replaced" \
  "$(grep -c new-backup "$RU_ROOT/etc/syntra-backup.service")" 1
ok "the file it replaced is kept" \
  "$(grep -c old-backup "$RU_ROOT/var/replaced-units/syntra-backup.service")" 1
ok "a missing unit is installed" \
  "$([ -f "$RU_ROOT/etc/syntra-backup-failed@.service" ] && echo yes || echo no)" yes
ok "syntra.service is left exactly as it was" \
  "$(cat "$RU_ROOT/etc/syntra.service")" "$(printf '[Service]\nExecStart=operators-own')"
ok "one daemon-reload, and no enable, disable, start or restart" \
  "$(cat "$RU_ROOT/calls")" "daemon-reload"
ok "the log names each unit it changed" \
  "$(printf '%s\n' "$RU_OUT" | grep -cE 'unit syntra-backup(-failed@)?\.service (installed|updated) from v1\.5\.0')" 2
ok "and totals what it did" \
  "$(printf '%s\n' "$RU_OUT" | grep -c 'units from v1.5.0: 1 installed, 1 updated, 1 unchanged, 0 failed')" 1

: > "$RU_ROOT/calls"
RU_OUT="$(ru_run)"
ok "a second run changes nothing and does not reload" "$(cat "$RU_ROOT/calls")" ""
ok "and says so" \
  "$(printf '%s\n' "$RU_OUT" | grep -c 'units from v1.5.0: 0 installed, 0 updated, 3 unchanged, 0 failed')" 1

RU_OUT="$(UNIT_DIR="$RU_ROOT/etc"; refresh_units "$RU_ROOT/no-such-dir" 1.5.0 2>&1)"
ok "a release with no ops/systemd is skipped, and says so" \
  "$RU_OUT" "[syntra-update] unit refresh skipped: v1.5.0 has no ops/systemd"

# The rehearsal runs under its own root on a host with a live install. The
# shipped units name /opt/syntra, so they are the live install's, and an
# update rehearsed elsewhere must not replace them.
RU_OUT="$(
  SYNTRA_ROOT=/opt/syntra-rehearsal SYNTRA_UNIT_DIR=""
  # shellcheck source=/dev/null
  . "$HERE/syntra-update"
  refresh_units "$RU_ROOT/release/ops/systemd" 1.5.0 2>&1
)"
ok "an install under another root does not refresh the units, and says so" \
  "$RU_OUT" \
  "[syntra-update] unit refresh skipped: the units name /opt/syntra and this install is /opt/syntra-rehearsal; set SYNTRA_UNIT_DIR to refresh them"
ok "and /opt/syntra itself refreshes /etc/systemd/system" \
  "$(SYNTRA_ROOT=/opt/syntra SYNTRA_UNIT_DIR=""; . "$HERE/syntra-update"; echo "$UNIT_DIR")" \
  "/etc/systemd/system"
rm -rf "$RU_ROOT"

# --- refresh_backup_tool ----------------------------------------------------
#
# The units run bin/syntra-backup, not the release's copy. Without this a fix
# to the tool -- the copy step among them -- never reached a timer.

RB_ROOT="$(mktemp -d)"
mkdir -p "$RB_ROOT/bin" "$RB_ROOT/release/ops"
printf '#!/bin/sh\necho new\n' > "$RB_ROOT/release/ops/syntra-backup"
printf '#!/bin/sh\necho old\n' > "$RB_ROOT/bin/syntra-backup"
RB_OUT="$(ROOT="$RB_ROOT"; refresh_backup_tool "$RB_ROOT/release/ops/syntra-backup" 1.5.0 2>&1)"
ok "bin/syntra-backup is replaced when the release's differs" \
  "$(grep -c new "$RB_ROOT/bin/syntra-backup")" 1
ok "and is executable" "$([ -x "$RB_ROOT/bin/syntra-backup" ] && echo yes || echo no)" yes
ok "and the log says where and from which version" \
  "$RB_OUT" "[syntra-update] updated $RB_ROOT/bin/syntra-backup from v1.5.0"
RB_OUT="$(ROOT="$RB_ROOT"; refresh_backup_tool "$RB_ROOT/release/ops/syntra-backup" 1.5.0 2>&1)"
ok "an unchanged tool is left alone, silently" "$RB_OUT" ""
rm -rf "$RB_ROOT"

# --- restart_backup_agent ---------------------------------------------------
#
# The agent kept running the release it started on after every update, and
# stamped that release's version on every backup it took.

BA_DIR="$(mktemp -d)"
ok "no jobs.json is not busy" "$(yes_no agent_busy "$BA_DIR")" no
printf '[\n  {\n    "id": "a",\n    "state": "running"\n  },\n  {\n    "id": "b",\n    "state": "succeeded"\n  }\n]\n' > "$BA_DIR/jobs.json"
ok "a running newest job is busy" "$(yes_no agent_busy "$BA_DIR")" yes
printf '[\n  {\n    "id": "b",\n    "state": "succeeded"\n  },\n  {\n    "id": "a",\n    "state": "running"\n  }\n]\n' > "$BA_DIR/jobs.json"
ok "only the newest job counts" "$(yes_no agent_busy "$BA_DIR")" no

# systemctl, stubbed: $BA_ACTIVE says whether the agent runs, and every call
# is appended to $BA_DIR/calls.
systemctl() {
  echo "$*" >> "$BA_DIR/calls"
  case "$1" in
    is-active) [ "${BA_ACTIVE:-yes}" = yes ] ;;
    show) echo "BACKUP_DIR=$BA_DIR BACKUP_AGENT_HOST=127.0.0.1" ;;
    restart) return 0 ;;
  esac
}
sleep() { :; }
current_version() { echo 1.5.0; }

ok "BACKUP_DIR is read from the agent's unit" "$(agent_dir)" "$BA_DIR"

: > "$BA_DIR/calls"
BA_OUT="$(BA_ACTIVE=no restart_backup_agent 2>&1)"
ok "a stopped agent is left stopped" "$(grep -c '^restart' "$BA_DIR/calls")" 0
ok "and nothing is logged" "$BA_OUT" ""

: > "$BA_DIR/calls"
BA_OUT="$(restart_backup_agent 2>&1)"
ok "an idle agent is restarted" "$(grep -c '^restart syntra-backup-agent$' "$BA_DIR/calls")" 1
ok "and the log names the release" "$BA_OUT" "[syntra-update] backup agent restarted on 1.5.0"

printf '[\n  {\n    "id": "a",\n    "state": "running"\n  }\n]\n' > "$BA_DIR/jobs.json"
: > "$BA_DIR/calls"
BA_OUT="$(AGENT_WAIT=30 restart_backup_agent 2>&1)"
ok "an agent still busy after AGENT_WAIT is not restarted" "$(grep -c '^restart' "$BA_DIR/calls")" 0
ok "and the log says what to run" "$BA_OUT" \
  "[syntra-update] backup agent restart skipped: a job is still running after 30s. Run: systemctl restart syntra-backup-agent"

unset -f systemctl sleep current_version
rm -rf "$BA_DIR"

# --- report -----------------------------------------------------------------

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
