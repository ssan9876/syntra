-- `deployment.manage` reaches a deployment that already exists.
--
-- Role.permissions is a STORED SNAPSHOT of the catalogue, written once by the
-- seed -- which returns early on an already-seeded database. So the permission
-- the update routes are gated on was held by nobody: every request answered
-- 403 and the Updates page was hidden from the person the feature was built
-- for, with raw SQL as the only remedy.
--
-- ONE TENANT ONLY, and that is the whole design of this backfill rather than a
-- limitation of it. This permission restarts the installation, migrates
-- everybody's database and signs everybody out for a minute. In a
-- single-tenant deployment its holder already had that power under
-- `tenant.manage` and nothing changes; in a shared one, handing it to every
-- tenant's Owner by migration would reproduce exactly the conflation the
-- permission was separated out to prevent. A multi-tenant install grants it
-- deliberately, through the role API, or not at all.
--
-- Built-in roles only. A role somebody wrote by hand is a role somebody chose
-- the permissions of, and a migration that edits it is a migration overruling
-- an administrator.
DO $$
DECLARE
  tenant_count integer;
  only_tenant  uuid;
  granted      integer;
BEGIN
  SELECT count(*) INTO tenant_count FROM "Tenant";

  IF tenant_count <> 1 THEN
    RAISE NOTICE
      'deployment.manage was not granted: this deployment has % tenants, and choosing which one may restart the installation is not a decision a migration should make. Grant it deliberately.',
      tenant_count;
    RETURN;
  END IF;

  SELECT id INTO only_tenant FROM "Tenant";

  -- Role carries FORCE ROW LEVEL SECURITY and migrations run as syntra_app,
  -- which is NOSUPERUSER NOBYPASSRLS and therefore subject to its own
  -- policies. Without this the UPDATE below matches zero rows, commits
  -- happily, and reports success. `true` scopes the setting to this
  -- transaction, the same way withTenant does.
  PERFORM set_config('app.current_tenant', only_tenant::text, true);

  UPDATE "Role"
     SET permissions = array_append(permissions, 'deployment.manage')
   WHERE "builtIn"
     AND 'tenant.manage' = ANY(permissions)
     AND NOT ('deployment.manage' = ANY(permissions));

  GET DIAGNOSTICS granted = ROW_COUNT;
  RAISE NOTICE 'deployment.manage granted to % built-in role(s)', granted;
END $$;
