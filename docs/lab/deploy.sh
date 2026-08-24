#!/usr/bin/env bash
#
# Push the working tree to the lab host and restart the service.
#
# The lab is NOT a git clone, and deliberately so: the repository is private,
# and putting a credential that can read it on a machine whose whole job is to
# be experimented with trades a real secret for a convenience. So the source of
# truth stays here and the host receives files.
#
# What it sends is `git ls-files` — the tracked tree, nothing else. Not the
# working directory: an rsync of that would carry node_modules, dist, editor
# leftovers and any scratch script left lying around, and a deploy that ships
# whatever happened to be on disk is how a lab ends up running code that exists
# nowhere else.
#
#   ./docs/lab/deploy.sh                 # sync, build, restart, verify
#   ./docs/lab/deploy.sh --check         # report drift and change nothing
#
# Refuses to deploy uncommitted work unless --force is given. What runs in the
# lab should be something you can point at a commit.

set -euo pipefail

HOST="${SYNTRA_LAB_HOST:-root@192.168.88.20}"
REMOTE="${SYNTRA_LAB_PATH:-/root/syntra}"
SERVICE="${SYNTRA_LAB_SERVICE:-syntra}"
HEALTH="${SYNTRA_LAB_HEALTH:-https://syntra.ssander.xyz/health}"

CHECK=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --check) CHECK=1 ;;
    --force) FORCE=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

cd "$(git rev-parse --show-toplevel)"

if [ -n "$(git status --porcelain)" ] && [ "$FORCE" -eq 0 ] && [ "$CHECK" -eq 0 ]; then
  echo "The working tree is dirty. Commit first, or pass --force." >&2
  git status --short >&2
  exit 1
fi

echo "commit : $(git rev-parse --short HEAD) $(git log -1 --format=%s)"
echo "host   : $HOST:$REMOTE"

# --- what differs -----------------------------------------------------------

# Line endings are normalised out of the comparison. A Windows checkout stores
# CRLF and the host stores LF, so a byte-for-byte hash reports every file as
# drifted and tells you nothing.
#
# The tracked tree MINUS what the running system has no use for. `docs/` alone
# is fourteen screenshots and a set of PowerShell scripts meant for a domain
# controller; shipping them makes every check report drift that will never be
# resolved, and a drift report nobody can act on is one nobody reads.
git ls-files -- . \
  ':(exclude)docs/**' \
  ':(exclude)e2e/**' \
  ':(exclude).github/**' \
  ':(exclude)*.md' \
  > /tmp/syntra-manifest.txt
scp -q "$HOST":/dev/null /dev/null 2>/dev/null || true
scp -q /tmp/syntra-manifest.txt "$HOST":/tmp/syntra-manifest.txt

local_hashes() {
  while IFS= read -r f; do
    [ -f "$f" ] || continue
    printf '%s\t%s\n' "$(tr -d '\r' < "$f" | md5sum | cut -d' ' -f1)" "$f"
  done < /tmp/syntra-manifest.txt
}

remote_hashes() {
  # shellcheck disable=SC2016
  ssh "$HOST" 'cd '"$REMOTE"' && while IFS= read -r f; do
      if [ -f "$f" ]; then printf "%s\t%s\n" "$(tr -d "\r" < "$f" | md5sum | cut -d" " -f1)" "$f";
      else printf "MISSING\t%s\n" "$f"; fi
    done < /tmp/syntra-manifest.txt'
}

local_hashes  | sort -t"$(printf '\t')" -k2 > /tmp/syntra-local.md5
remote_hashes | sort -t"$(printf '\t')" -k2 > /tmp/syntra-remote.md5

DRIFT=$(join -t"$(printf '\t')" -j2 -o 0,1.1,2.1 /tmp/syntra-local.md5 /tmp/syntra-remote.md5 \
  | awk -F'\t' '$2 != $3 { print $1 }')
ONLY_LOCAL=$(comm -23 <(cut -f2 /tmp/syntra-local.md5) <(cut -f2 /tmp/syntra-remote.md5) || true)
CHANGED=$(printf '%s\n%s\n' "$DRIFT" "$ONLY_LOCAL" | grep -v '^$' | sort -u || true)
COUNT=$(printf '%s' "$CHANGED" | grep -c . || true)

if [ "$COUNT" -eq 0 ]; then
  echo "in sync: nothing to send"
else
  echo "drifted ($COUNT):"
  printf '%s\n' "$CHANGED" | sed 's/^/  /'
fi

if [ "$CHECK" -eq 1 ]; then exit 0; fi

# --- send -------------------------------------------------------------------

if [ "$COUNT" -gt 0 ]; then
  # One tar over one ssh connection. A loop of scp calls pays a handshake per
  # file, which for a wide change is most of the wall clock.
  printf '%s\n' "$CHANGED" | tar -czf - -T - | ssh "$HOST" "tar -xzf - -C '$REMOTE'"
  echo "sent $COUNT file(s)"
fi

# --- dependencies, schema, bundle -------------------------------------------

# The lock file changing is the only reason to reinstall; pnpm is fast when
# nothing moved, but not free, and this runs on every deploy.
if printf '%s\n' "$CHANGED" | grep -qx 'pnpm-lock.yaml'; then
  echo "lock file changed -- installing"
  ssh "$HOST" "cd '$REMOTE' && pnpm install --frozen-lockfile"
fi

if printf '%s\n' "$CHANGED" | grep -q '^packages/db/prisma/migrations/'; then
  echo "new migrations -- applying"
  ssh "$HOST" "cd '$REMOTE' && pnpm --filter @syntra/db exec prisma migrate deploy"
fi

# The API runs from TypeScript through tsx, so it needs no build. The WEB app
# is served from a built bundle by `registerWebApp`, so a source change that is
# never rebuilt is a change that never reaches a browser -- invisible, because
# the API restarts cleanly and every endpoint still answers.
if printf '%s\n' "$CHANGED" | grep -qE '^(apps/web|packages/ui)/'; then
  echo "web or ui changed -- rebuilding the bundle"
  ssh "$HOST" "cd '$REMOTE' && pnpm --filter @syntra/web build 2>&1 | tail -3"
fi

# --- restart and prove it came back -----------------------------------------

ssh "$HOST" "systemctl restart '$SERVICE'"
for _ in $(seq 1 30); do
  code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$HEALTH" || true)
  if [ "$code" = "200" ]; then
    echo "healthy: $HEALTH -> 200"
    exit 0
  fi
  sleep 2
done

echo "the service did not become healthy within 60s" >&2
ssh "$HOST" "systemctl status '$SERVICE' --no-pager -n 20" >&2 || true
exit 1
