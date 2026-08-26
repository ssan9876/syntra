-- Give every built-in role the permissions the catalogue has grown since it
-- was seeded.
--
-- `Role.permissions` is a stored snapshot. The seed writes it once, exits
-- early on an already-seeded database, and nothing else has ever written it:
-- no migration, no backfill, and until this release no API. The catalogue grew
-- in six commits after the seed that created most installations' Owner role,
-- so those installations' administrators hold a set of permissions frozen at
-- whatever the product had on the day they installed it.
--
-- What that looks like in the product: `deployment.manage` was added for the
-- in-console updater, the Updates page is hidden because the console filters
-- navigation on permissions, and every /api/admin/update route answers 403.
-- The one feature whose purpose is repairing a deployment cannot be reached by
-- the deployment that needs repairing. `govern.export`, `provision.read` and
-- `govern.accept_risk` are in the same position, more quietly.
--
-- ADDITIVE, AND ONLY FOR `builtIn` ROLES. An administrator who deliberately
-- narrowed a custom role must not have it widened by a deploy, and nobody
-- loses anything here: the DISTINCT union over both arrays takes what is
-- there and adds what is missing. A built-in role is the one the seed wrote
-- with the full catalogue as its intent, so restoring that intent is what this
-- is.
--
-- The list below is a SNAPSHOT of `ALL_PERMISSIONS` at the time of writing,
-- because SQL cannot read a TypeScript constant. It does not need to be
-- updated when the catalogue grows again: that is what the role API is for,
-- and `builtin-role-permissions.test.ts` asserts only that everything named
-- here is a permission the catalogue actually has.
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
