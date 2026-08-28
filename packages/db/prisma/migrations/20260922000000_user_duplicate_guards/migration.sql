-- Two accounts differing only in case are two accounts, and both can sign in.
--
-- `@@unique([tenantId, login])` is case-sensitive in Postgres, so `MOkafor`
-- and `mokafor` coexist today. `createUser` keeps its own pre-check so the
-- caller gets a domain error to map to 409 rather than a driver error; this
-- index is the backstop for the race a pre-check cannot close.
--
-- This migration FAILS on a tenant that already holds a case-collision, and
-- that is correct: deciding which of two accounts is real needs a human. Find
-- them with:
--
--   SELECT "tenantId", lower("login"), count(*), array_agg("id")
--     FROM "User" GROUP BY 1, 2 HAVING count(*) > 1;
CREATE UNIQUE INDEX "User_tenantId_lower_login_key"
  ON "User" ("tenantId", lower("login"));

-- Email, for locally managed accounts only.
--
-- Partial, and that is the whole of the design. A directory is authoritative
-- over the accounts it owns: refusing what LDAP says would fail a sync run
-- mid-apply over a shared mailbox somebody set up years ago. The index covers
-- exactly what Syntra itself created, which is what an administrator typing
-- into the create form can collide with.
--
--   SELECT "tenantId", lower("email"), count(*), array_agg("id")
--     FROM "User" WHERE "sourceId" IS NULL
--     GROUP BY 1, 2 HAVING count(*) > 1;
CREATE UNIQUE INDEX "User_tenantId_lower_email_local_key"
  ON "User" ("tenantId", lower("email")) WHERE "sourceId" IS NULL;
