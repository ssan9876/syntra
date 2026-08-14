-- The compound unique on (roleId, userId, scopeOrgUnitId) does not constrain
-- unscoped assignments: SQL treats NULL as distinct from NULL, so the same
-- tenant-wide grant could be inserted repeatedly. A partial unique index over
-- the NULL case closes it.
CREATE UNIQUE INDEX role_assignment_unscoped_unique
  ON "RoleAssignment" ("roleId", "userId")
  WHERE "scopeOrgUnitId" IS NULL;
