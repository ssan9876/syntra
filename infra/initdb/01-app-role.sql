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
