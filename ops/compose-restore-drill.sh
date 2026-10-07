#!/usr/bin/env bash
#
# A restore drill against the real Compose stack: back up, change something,
# restore, and check what came back -- through the `backup` service, the way
# Administration -> Backups does it.
#
#   ops/compose-restore-drill.sh <env-file> [project]
#
# The env file needs POSTGRES_PASSWORD, SYNTRA_APP_PASSWORD, SESSION_SECRET,
# MASTER_KEY and PUBLIC_URL; BACKUP_S3_* and the s3 service are added here. The project (default syntra-drill) is brought up
# and left running; `docker compose -p <project> down -v` removes it.

set -euo pipefail
# Git Bash would otherwise rewrite /v1/... arguments into Windows paths.
export MSYS_NO_PATHCONV=1

ENV_FILE="${1:?usage: compose-restore-drill.sh <env-file> [project]}"
PROJECT="${2:-syntra-drill}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Git Bash: a path Docker for Windows can open.
command -v cygpath >/dev/null 2>&1 && HERE="$(cygpath -m "$HERE")"
# The stack, plus an S3-compatible bucket for the off-site copy (ops/compose-drill.yml).
compose() { docker compose -p "$PROJECT" --env-file "$ENV_FILE" -f "$HERE/../docker-compose.yml" -f "$HERE/compose-drill.yml" "$@"; }
log() { printf '%s  %s\n' "$(date -u +%H:%M:%S)" "$*"; }
die() {
  printf 'drill failed: %s\n' "$*" >&2
  # Enough to tell "exited and was not restarted" from "restarted and hung".
  local id
  id="$(compose ps -aq api 2>/dev/null)" && [ -n "$id" ] && docker inspect -f \
    'api: status={{.State.Status}} exit={{.State.ExitCode}} restarts={{.RestartCount}} started={{.State.StartedAt}} finished={{.State.FinishedAt}} health={{if .State.Health}}{{.State.Health.Status}}{{end}}' \
    "$id" >&2 || true
  compose ps -a >&2 || true
  exit 1
}
psql_q() { compose exec -T postgres psql -U syntra -d syntra -tAc "$1" | tr -d '\r'; }

value() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -1; }
SESSION_SECRET="$(value SESSION_SECRET)"
TOKEN="$(value BACKUP_AGENT_TOKEN)"
[ -n "$TOKEN" ] || TOKEN="$(printf '%s' 'syntra-backup-agent-v1' | openssl dgst -sha256 -hmac "$SESSION_SECRET" -r | cut -d' ' -f1)"

# Calls the backup service from inside its own container. Not from `api`:
# the api container restarts twice during a restore, by design, and a call
# made through it in that moment gets no answer at all.
agent() {
  compose exec -T -e TOKEN="$TOKEN" backup node -e "
    const [method, path, body] = process.argv.slice(1);
    fetch('http://127.0.0.1:3100' + path, {
      method, headers: { authorization: 'Bearer ' + process.env.TOKEN, 'content-type': 'application/json' },
      body: body || undefined,
    }).then(async (r) => { const t = await r.text(); if (!r.ok) { console.error(r.status, t); process.exit(1); } console.log(t); });
  " "$@"
}
field() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log($1))"; }

wait_job() {
  local id="$1" job state
  for _ in $(seq 180); do
    job="$(agent GET "/v1/jobs/$id" 2>/dev/null)" || job=''
    state="$(printf '%s' "$job" | field 'JSON.parse(s).job.state' 2>/dev/null)" || state=''
    # Only a finished job ends the wait. No answer is not an answer.
    case "$state" in succeeded|failed) printf '%s' "$job"; return 0 ;; esac
    sleep 1
  done
  die "job $id did not finish"
}

# The off-site bucket: ops/compose-drill.yml's S3Mock.
DRILL_PASSPHRASE="drill-offsite-passphrase"
export BACKUP_S3_BUCKET=syntra-drill BACKUP_S3_ENDPOINT=http://s3:9090 BACKUP_S3_PASSPHRASE="$DRILL_PASSPHRASE"   BACKUP_S3_ACCESS_KEY_ID=drill BACKUP_S3_SECRET_ACCESS_KEY=drill-secret

log "starting $PROJECT"
compose up -d --wait postgres api backup

log "bootstrapping a tenant"
compose exec -T \
  -e BOOTSTRAP_TENANT_NAME=Drill -e BOOTSTRAP_TENANT_SLUG=drill -e BOOTSTRAP_TENANT_DOMAIN=drill.localhost \
  -e BOOTSTRAP_ADMIN_LOGIN=owner -e BOOTSTRAP_ADMIN_EMAIL=owner@drill.example \
  -e BOOTSTRAP_ADMIN_PASSWORD='Drill-Passw0rd-Long!' \
  api pnpm --filter @syntra/db bootstrap >/dev/null 2>&1 || true
[ "$(psql_q "SELECT count(*) FROM \"Tenant\" WHERE slug = 'drill'")" = 1 ] || die "bootstrap left no tenant"

log "backing up"
job="$(agent POST /v1/backups '{"requestedBy":"drill"}' | field 'JSON.parse(s).job.id')"
done_job="$(wait_job "$job")"
[ "$(printf '%s' "$done_job" | field 'JSON.parse(s).job.state')" = succeeded ] || die "backup: $done_job"
name="$(printf '%s' "$done_job" | field 'JSON.parse(s).job.backupName')"
log "took $name"

log "checking the off-site copy"
status="$(agent GET /v1/status)"
[ "$(printf '%s' "$status" | field 'JSON.parse(s).health.lastCopy.ok')" = true ]   || die "off-site copy failed: $(printf '%s' "$status" | field 'JSON.stringify(JSON.parse(s).health.lastCopy)')"
# Fetched back from the bucket and decrypted with the passphrase, in the
# agent's own container: an upload that happened is not a file that opens.
opened="$(compose exec -T -e NAME="$name" -e PASSPHRASE="$DRILL_PASSPHRASE" backup node --import tsx --input-type=module -e "
  import { Readable } from 'node:stream';
  import { pipeline } from 'node:stream/promises';
  import { createBackupDecryptor } from '@syntra/core';
  const r = await fetch('http://s3:9090/syntra-drill/syntra/' + process.env.NAME + '.syntra-backup');
  if (!r.ok) { console.error('GET', r.status); process.exit(1); }
  const d = createBackupDecryptor(process.env.PASSPHRASE);
  let head = Buffer.alloc(0);
  d.on('data', (c) => { if (head.length < 5) head = Buffer.concat([head, c]); });
  await pipeline(Readable.fromWeb(r.body), d);
  const m = await d.manifest;
  console.log(head.subarray(0, 5).toString() + ' ' + m.createdAt);
")" || die "the off-site copy of $name could not be fetched and decrypted"
case "$opened" in PGDMP\ *) log "off-site copy decrypts: $opened" ;; *) die "the off-site copy of $name did not decrypt to a dump: $opened" ;; esac

log "testing a restore of $name"
job="$(agent POST /v1/verifies "{\"name\":\"$name\",\"requestedBy\":\"drill\"}" | field 'JSON.parse(s).job.id')"
done_job="$(wait_job "$job")"
[ "$(printf '%s' "$done_job" | field 'JSON.parse(s).job.state')" = succeeded ] || die "restore test: $done_job"
printf '%s' "$done_job" | field 'JSON.parse(s).job.message'

# Unique per run: tenants are never deleted, so a rerun cannot reuse one.
marker="after-$(date -u +%s)"
psql_q "INSERT INTO \"Tenant\" (id, name, slug) VALUES (gen_random_uuid(), 'After', '$marker')" >/dev/null
api_started_before="$(docker inspect -f '{{.State.StartedAt}}' "$(compose ps -q api)")"

log "restoring $name"
job="$(agent POST /v1/restores "{\"name\":\"$name\",\"requestedBy\":\"drill\"}" | field 'JSON.parse(s).job.id')"
done_job="$(wait_job "$job")"
printf '%s' "$done_job" | field 'JSON.parse(s).job.message'
[ "$(printf '%s' "$done_job" | field 'JSON.parse(s).job.state')" = succeeded ] || die "restore: $done_job"

log "checking what came back"
[ "$(psql_q "SELECT count(*) FROM \"Tenant\" WHERE slug = '$marker'")" = 0 ] || die "the tenant created after the backup survived"
[ "$(psql_q "SELECT count(*) FROM \"Tenant\" WHERE slug = 'drill'")" = 1 ] || die "the backed-up tenant is missing"
[ "$(psql_q "SELECT rolcanlogin FROM pg_roles WHERE rolname = 'syntra_app'")" = t ] || die "syntra_app was left locked out"
[ "$(psql_q "SELECT count(*) FROM \"RestoreHold\" WHERE \"releasedAt\" IS NULL AND \"backupName\" = '$name'")" = 1 ] || die "no hold on the restored database"
[ "$(psql_q "SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'public'")" = syntra_app ] || die "public is not owned by syntra_app"

log "waiting for the api to come back healthy"
# The api restarts twice after a restore, so one healthy answer can come
# between the two. Healthy five polls running (10 s) is past both.
steady=0
for _ in $(seq 120); do
  if [ "$(docker inspect -f '{{.State.Health.Status}}' "$(compose ps -q api)" 2>/dev/null)" = healthy ]; then
    steady=$((steady + 1))
    [ "$steady" -ge 5 ] && break
  else
    steady=0
  fi
  sleep 2
done
[ "$steady" -ge 5 ] || die "api did not come back healthy"
api_started_after="$(docker inspect -f '{{.State.StartedAt}}' "$(compose ps -q api)")"
[ "$api_started_after" != "$api_started_before" ] || die "the api did not restart after the restore"
compose logs api 2>/dev/null | grep -q "background work held: restored from $name" || die "the api did not report the hold"

log "restore drill passed"
