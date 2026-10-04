#!/bin/sh
# Resets the Syntra demo: wipes its data, starts it, seeds the demo tenant and
# puts the demo credentials on the sign-in page. Safe to run from cron:
#
#   0 3 * * * /opt/syntra/deploy/demo/reset.sh >> /var/log/syntra-demo-reset.log 2>&1
#
# On first use it writes .env beside this script. These variables, if set in
# the environment at that point, go into it; afterwards edit .env instead.
#
#   DEMO_HOST       Hostname the demo answers on. Default acme.localhost.
#   PUBLIC_URL      Origin people type. Default http://$DEMO_HOST:$DEMO_PORT.
#   DEMO_PORT       Loopback port for the web container. Default 8090.
#   DEMO_INFO_URL   https: link behind the credentials on the sign-in page.
#   SYNTRA_VERSION  Release to run. Unset runs :latest.
#
# See README.md beside this file.

set -eu

here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
cd "$here"

dc() {
  docker compose -f "$here/docker-compose.demo.yml" "$@"
}

rand_b64() { openssl rand -base64 "$1" | tr -d '\r\n'; }
rand_hex() { openssl rand -hex 32 | tr -d '\r\n'; }

if [ ! -e .env ]; then
  command -v openssl >/dev/null 2>&1 || { echo "reset: openssl not found." >&2; exit 1; }
  host=${DEMO_HOST:-acme.localhost}
  port=${DEMO_PORT:-8090}
  # Short enough to fit the 40-character sign-in page label, long enough for
  # the seed's 12-character minimum. Printed publicly: it protects nothing.
  password="demo-$(rand_hex | cut -c1-8)"
  umask 077
  ( set -C; : > .env )
  {
    echo "# Written by reset.sh on $(date -u '+%Y-%m-%d %H:%M UTC'). Demo values only."
    if [ -n "${SYNTRA_VERSION:-}" ]; then echo "SYNTRA_VERSION=$SYNTRA_VERSION"; fi
    echo "DEMO_HOST=$host"
    echo "DEMO_PORT=$port"
    echo "PUBLIC_URL=${PUBLIC_URL:-http://$host:$port}"
    echo "DEMO_PASSWORD=$password"
    echo "DEMO_INFO_URL=${DEMO_INFO_URL:-https://github.com/ssan9876/syntra}"
    echo "MASTER_KEY=$(rand_b64 32)"
    echo "SESSION_SECRET=$(rand_b64 32)"
    echo "POSTGRES_PASSWORD=$(rand_hex)"
    echo "SYNTRA_APP_PASSWORD=$(rand_hex)"
  } >> .env
  echo "Wrote $here/.env."
fi

# Read the demo's own settings back from .env. Compose reads the rest itself.
setting() { sed -n "s/^$1=//p" .env | tail -n 1; }
host=$(setting DEMO_HOST)
password=$(setting DEMO_PASSWORD)
info_url=$(setting DEMO_INFO_URL)
public_url=$(setting PUBLIC_URL)
[ -n "$host" ] && [ -n "$password" ] && [ -n "$public_url" ] \
  || { echo "reset: DEMO_HOST, DEMO_PASSWORD and PUBLIC_URL must be set in $here/.env." >&2; exit 1; }
[ ${#password} -ge 12 ] \
  || { echo "reset: DEMO_PASSWORD in $here/.env is shorter than 12 characters." >&2; exit 1; }

label="Sign in as admin or jdoe: $password"
if [ ${#label} -gt 40 ]; then label="Password: $password"; fi
[ ${#label} -le 40 ] \
  || { echo "reset: DEMO_PASSWORD in $here/.env is longer than 30 characters." >&2; exit 1; }

echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') Demo reset started."
dc pull --quiet
dc down -v --remove-orphans
dc up -d --wait --wait-timeout 300

dc exec -T -e SEED_DEMO=1 -e SEED_ADMIN_PASSWORD="$password" \
  api pnpm --silent --filter @syntra/db seed

# The seed's tenant answers on acme.localhost. Point it at DEMO_HOST, and
# brand its sign-in page. psql variables, not string splicing, so a quote in
# any value cannot break out of its literal. As the database superuser, which
# row-level security does not apply to.
dc exec -T postgres psql -q -U syntra -d syntra -v ON_ERROR_STOP=1 \
  -v host="$host" -v label="$label" -v url="$info_url" <<'SQL'
UPDATE "Tenant"
   SET "primaryDomain" = :'host',
       "brandName" = 'Demo — resets nightly',
       "brandSupportUrl" = NULLIF(:'url', ''),
       "brandSupportLabel" = CASE WHEN :'url' = '' THEN NULL ELSE :'label' END
 WHERE slug = 'acme';
SQL

echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') Demo reset finished: $public_url, admin or jdoe, password $password."
