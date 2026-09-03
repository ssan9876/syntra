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

# --- report -----------------------------------------------------------------

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
