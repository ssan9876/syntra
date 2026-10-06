#!/usr/bin/env bash
#
# A restore drill against the real Compose stack: back up, change something,
# restore, and check what came back -- through the `backup` service, the way
# Administration -> Backups does it.
#
#   ops/compose-restore-drill.sh <env-file> [project]
#
# The env file needs POSTGRES_PASSWORD, SYNTRA_APP_PASSWORD, SESSION_SECRET,
# MASTER_KEY and PUBLIC_URL. The project (default syntra-drill) is brought up
# and left running; `docker compose -p <project> down -v` removes it.

set -euo pipefail
# Git Bash would otherwise rewrite /v1/... arguments into Windows paths.
export MSYS_NO_PATHCONV=1

ENV_FILE="${1:?usage: compose-restore-drill.sh <env-file> [project]}"
PROJECT="${2:-syntra-drill}"
compose() { docker compose -p "$PROJECT" --env-file "$ENV_FILE" "$@"; }
log() { printf '%s  %s\n' "$(date -u +%H:%M:%S)" "$*"; }
die() { printf 'drill failed: %s\n' "$*" >&2; exit 1; }
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
for _ in $(seq 120); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$(compose ps -q api)")" = healthy ] && break
  sleep 2
done
[ "$(docker inspect -f '{{.State.Health.Status}}' "$(compose ps -q api)")" = healthy ] || die "api did not come back healthy"
api_started_after="$(docker inspect -f '{{.State.StartedAt}}' "$(compose ps -q api)")"
[ "$api_started_after" != "$api_started_before" ] || die "the api did not restart after the restore"
compose logs api 2>/dev/null | grep -q "background work held: restored from $name" || die "the api did not report the hold"

log "restore drill passed"
