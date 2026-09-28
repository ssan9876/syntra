-- The built-in Data deletion role, and a stable identity for system roles.
--
-- `person.purge` (hard-deleting a person) is held through this role only. The
-- Owner role does not carry it, and only an Owner may assign it (enforced in
-- rbac-service.ts). The CHECK at the end makes the first half a database
-- fact: no other role can carry `person.purge`, and this role carries nothing
-- else -- so a hand re-run of `20260926000000_builtin_role_permissions_repair`,
-- which widens every built-in role, fails instead of widening this one.
--
-- `systemKey` names the roles the product installs. Names can be edited;
-- rules key on this.

ALTER TABLE "Role" ADD COLUMN IF NOT EXISTS "systemKey" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "Role_tenantId_systemKey_key" ON "Role"("tenantId", "systemKey");

-- Per tenant, with `app.current_tenant` bound: "Role" is FORCE ROW LEVEL
-- SECURITY and migrations run as syntra_app (see the repair migration).
-- A tenant that already has a hand-made role called "Data deletion" is
-- skipped with a notice.
DO $$
DECLARE
  t record;
  owners integer := 0;
  created integer := 0;
  n integer;
BEGIN
  FOR t IN SELECT id FROM "Tenant" LOOP
    PERFORM set_config('app.current_tenant', t.id::text, true);

    UPDATE "Role"
       SET "systemKey" = 'owner'
     WHERE "builtIn"
       AND "name" = 'Owner'
       AND "systemKey" IS NULL
       AND NOT EXISTS (SELECT 1 FROM "Role" r2 WHERE r2."systemKey" = 'owner');
    GET DIAGNOSTICS n = ROW_COUNT;
    owners := owners + n;

    INSERT INTO "Role" ("id", "tenantId", "name", "description", "permissions", "builtIn", "systemKey")
    VALUES (
      gen_random_uuid(),
      t.id,
      'Data deletion',
      'Permanently delete people from Syntra.',
      ARRAY['person.purge']::text[],
      true,
      'data-deletion'
    )
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS n = ROW_COUNT;
    created := created + n;
    IF n = 0 AND NOT EXISTS (SELECT 1 FROM "Role" WHERE "systemKey" = 'data-deletion') THEN
      RAISE NOTICE 'Data deletion role not created for tenant %: a role named "Data deletion" already exists', t.id;
    END IF;
  END LOOP;

  RAISE NOTICE 'data-deletion-role: % Owner role(s) keyed, % Data deletion role(s) created', owners, created;
END $$;

ALTER TABLE "Role" DROP CONSTRAINT IF EXISTS "Role_person_purge_only_data_deletion";
ALTER TABLE "Role" ADD CONSTRAINT "Role_person_purge_only_data_deletion" CHECK (
  CASE
    WHEN "systemKey" = 'data-deletion' THEN "permissions" = ARRAY['person.purge']::text[]
    ELSE NOT ('person.purge' = ANY("permissions"))
  END
);
