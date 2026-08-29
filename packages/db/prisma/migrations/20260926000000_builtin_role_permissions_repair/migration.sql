-- Repairs `20260903000000_builtin_role_permissions`, which never ran.
--
-- That migration's UPDATE joins "Role" against itself with no tenant bound.
-- Role carries FORCE ROW LEVEL SECURITY, and migrations run as `syntra_app`,
-- which is NOSUPERUSER NOBYPASSRLS -- so it is subject to its own policies
-- exactly like application code. With no `app.current_tenant` set, the
-- policy predicate `"tenantId" = NULLIF(current_setting('app.current_tenant',
-- true), '')::uuid` compares every row's tenantId against NULL, which is
-- never true. The UPDATE matched zero rows, committed, and reported success.
-- `builtin-role-permissions.test.ts` did not catch it because it exercised
-- the SQL through `withTenant`, which binds a tenant the real migration never
-- did.
--
-- The fix is the pattern `20260905000000_deployment_manage_backfill` and
-- `20260909000000_password_ageing` already use: loop over every tenant and
-- bind `app.current_tenant` before touching tenant-scoped rows. Same
-- permission list as the original migration, same ADDITIVE-and-`builtIn`-only
-- semantics; only the missing tenant binding is new.
--
-- `20260909000000_password_ageing` (line 44) has a second, similarly unscoped
-- UPDATE after its own per-tenant loop, intended as a "belt and braces"
-- catch-all. It is also dead under RLS -- `set_config(..., true)` scopes to
-- the transaction, so by the time that statement runs, `app.current_tenant`
-- is still whatever the loop left it at (the last tenant), and the statement
-- can only ever re-touch rows the loop's own final iteration already
-- reached. It adds nothing beyond what its preceding per-tenant loop already
-- does, and that loop already covers every `PasswordCredential` row in every
-- tenant that exists (a row whose `tenantId` names a tenant that does not
-- exist cannot happen: `tenantId` is `NOT NULL` and, as of
-- `20260928000000_tenant_foreign_keys`, foreign-keyed to `Tenant` with
-- `ON DELETE CASCADE`). There is nothing for this migration to repair there.
DO $$
DECLARE
  t record;
  total integer := 0;
  granted integer;
BEGIN
  FOR t IN SELECT id FROM "Tenant" LOOP
    PERFORM set_config('app.current_tenant', t.id::text, true);

    UPDATE "Role" AS r
    SET "permissions" = sub.merged
    FROM (
      SELECT
        r2.id,
        ARRAY(
          SELECT DISTINCT p
          FROM unnest(
            r2."permissions" || ARRAY[
              'directory.read',
              'directory.write',
              'identity.read',
              'identity.write',
              'audit.read',
              'secrets.write',
              'rbac.manage',
              'tenant.manage',
              'deployment.manage',
              'sync.read',
              'sync.manage',
              'access.read',
              'access.manage',
              'policy.read',
              'policy.manage',
              'automate.read',
              'automate.manage',
              'automate.request_on_behalf',
              'provision.read',
              'provision.manage',
              'govern.read',
              'govern.manage',
              'govern.accept_risk',
              'govern.export'
            ]::text[]
          ) AS p
          ORDER BY p
        ) AS merged
      FROM "Role" AS r2
      WHERE r2."builtIn" = true
    ) AS sub
    WHERE r.id = sub.id;

    GET DIAGNOSTICS granted = ROW_COUNT;
    total := total + granted;
  END LOOP;

  RAISE NOTICE 'builtin-role-permissions repair: % built-in role(s) updated across every tenant', total;
END $$;
