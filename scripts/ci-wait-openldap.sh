#!/usr/bin/env bash
#
# Waits for the test OpenLDAP to answer with its seeded entry, and recreates
# the container when it does not.
#
# osixia/openldap seeds on its first start and then restarts slapd, so "the
# port answers" is not "the directory is ready" -- the wait is for an entry
# the tests will read. And that first start sometimes dies outright
# ("/container/run/startup/slapd failed with status 255") and never comes
# back: waiting longer for it only times out. A fresh container does not
# share the failure, so up to three are tried.

set -uo pipefail

COMPOSE=(docker compose -f infra/docker-compose.yml)

ready() {
  docker exec infra-openldap-1 ldapsearch -x -H ldap://localhost:389 \
    -D cn=admin,dc=acme,dc=test -w adminpassword \
    -b ou=Shared,dc=acme,dc=test -s base dn >/dev/null 2>&1
}

for attempt in 1 2 3; do
  for _ in $(seq 1 30); do
    ready && { echo "OpenLDAP ready (attempt $attempt)"; exit 0; }
    # A container that has stopped will not become ready; recreate it now.
    [ "$(docker inspect -f '{{.State.Running}}' infra-openldap-1 2>/dev/null)" = true ] || break
    sleep 2
  done
  echo "OpenLDAP not ready on attempt $attempt; recreating it"
  "${COMPOSE[@]}" logs --tail 20 openldap
  "${COMPOSE[@]}" rm -sf openldap >/dev/null
  "${COMPOSE[@]}" up -d openldap >/dev/null
done

echo "OpenLDAP never became ready"
"${COMPOSE[@]}" logs openldap
exit 1
