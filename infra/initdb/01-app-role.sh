#!/bin/sh
#
# Syntra connects as a NON-SUPERUSER role.
#
# This is load-bearing, not hygiene: PostgreSQL superusers bypass row-level
# security unconditionally, and BYPASSRLS defeats it too. Tenant isolation is
# enforced by RLS policies, so a superuser connection would silently disable
# the single control the whole model rests on.
#
# The role also OWNS the tables and runs migrations. That is safe only because
# every tenant-scoped table is declared FORCE ROW LEVEL SECURITY, which subjects
# the owner to its own policies. Without FORCE, an owner ignores them.
#
# A shell script rather than the .sql file this replaces, because the role's
# password can no longer be a literal in a file checked into git. It comes
# from SYNTRA_APP_PASSWORD -- defaulted to `syntra_app` for a development
# checkout by infra/docker-compose.yml, and required with no default by the
# root docker-compose.yml the same way POSTGRES_PASSWORD is -- and is bound
# into the SQL as a psql variable (`:'app_password'`), not interpolated into
# this script's text, so a password containing a quote or a backslash cannot
# break out of the literal it is meant to be.
#
# docker-entrypoint-initdb.d runs *.sh scripts by sourcing them (`. "$f"`), so
# this does not need to be executable, and it inherits POSTGRES_USER and
# POSTGRES_DB from the container's own environment exactly as the entrypoint
# set them up.

set -eu

if [ -z "${SYNTRA_APP_PASSWORD:-}" ]; then
  echo "01-app-role.sh: SYNTRA_APP_PASSWORD is required and was not set" >&2
  exit 1
fi

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set app_password="$SYNTRA_APP_PASSWORD" <<-'SQL'
	CREATE ROLE syntra_app WITH
	  LOGIN
	  PASSWORD :'app_password'
	  NOSUPERUSER
	  NOCREATEDB
	  NOCREATEROLE
	  NOBYPASSRLS
	  NOINHERIT;

	ALTER SCHEMA public OWNER TO syntra_app;
	GRANT ALL ON SCHEMA public TO syntra_app;

	-- Prisma's `migrate dev` diffs the schema in a throwaway shadow database.
	-- Rather than granting syntra_app CREATEDB (a privilege it should not carry
	-- in production), the shadow database is provisioned here and referenced by
	-- SHADOW_DATABASE_URL. Development-only; `migrate deploy` never touches it.
	CREATE DATABASE syntra_shadow OWNER syntra_app;

	-- pg-boss keeps its queue tables in a schema of its own, creates it on first
	-- start, and migrates it between versions. That needs CREATE on the database.
	--
	-- This is a deliberately narrow widening: CREATE permits new schemas, and
	-- nothing more. The two privileges the isolation model actually depends on -
	-- NOSUPERUSER and NOBYPASSRLS - are untouched, so row-level security still
	-- applies to every query this role makes.
	GRANT CREATE ON DATABASE syntra TO syntra_app;
	SQL
