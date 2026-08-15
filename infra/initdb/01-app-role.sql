-- Syntra connects as a NON-SUPERUSER role.
--
-- This is load-bearing, not hygiene: PostgreSQL superusers bypass row-level
-- security unconditionally, and BYPASSRLS defeats it too. Tenant isolation is
-- enforced by RLS policies, so a superuser connection would silently disable
-- the single control the whole model rests on.
--
-- The role also OWNS the tables and runs migrations. That is safe only because
-- every tenant-scoped table is declared FORCE ROW LEVEL SECURITY, which subjects
-- the owner to its own policies. Without FORCE, an owner ignores them.

CREATE ROLE syntra_app WITH
  LOGIN
  PASSWORD 'syntra_app'
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
