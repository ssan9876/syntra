-- `directory.delete` reaches a deployment that already exists.
--
-- Role.permissions is a STORED SNAPSHOT of the catalogue, written once by the
-- seed, which returns early on an already-seeded database. Without this
-- backfill the permission the delete routes are gated on would be held by
-- nobody, every request would answer 403, and the controls would be hidden
-- from the administrator the feature was built for -- the same failure
-- `20260905000000_deployment_manage_backfill` was written to repair.
--
-- EVERY TENANT, unlike that one, and the difference is what the permission
-- reaches. `deployment.manage` restarts the installation and migrates
-- everybody's database, so choosing which tenant holds it is not a decision a
-- migration may make. `directory.delete` reaches one tenant's own directory
-- and nothing outside it, so granting it per tenant reproduces no conflation.
--
-- Built-in roles that already hold `directory.write`. A role somebody wrote by
-- hand is a role somebody chose the permissions of, and a migration that edits
-- it is a migration overruling an administrator. Requiring `directory.write`
-- keeps it off a read-only built-in role, if a deployment has one.
DO $$
DECLARE
  t       record;
  granted integer;
  total   integer := 0;
BEGIN
  FOR t IN SELECT id FROM "Tenant" LOOP
    -- Role carries FORCE ROW LEVEL SECURITY and migrations run as syntra_app,
    -- which is NOSUPERUSER NOBYPASSRLS and therefore subject to its own
    -- policies. Without this the UPDATE matches zero rows, commits happily,
    -- and reports success. `true` scopes the setting to this transaction, the
    -- same way withTenant does.
    PERFORM set_config('app.current_tenant', t.id::text, true);

    UPDATE "Role"
       SET permissions = array_append(permissions, 'directory.delete')
     WHERE "builtIn"
       AND 'directory.write' = ANY(permissions)
       AND NOT ('directory.delete' = ANY(permissions));

    GET DIAGNOSTICS granted = ROW_COUNT;
    total := total + granted;
  END LOOP;

  RAISE NOTICE 'directory.delete granted to % built-in role(s)', total;
END $$;
