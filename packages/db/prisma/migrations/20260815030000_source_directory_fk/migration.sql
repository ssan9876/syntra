-- Gives User.sourceId, Group.sourceId and OrgUnit.sourceId the foreign key
-- they never had.
--
-- Without it a source could be deleted out from under the rows it owned,
-- leaving them carrying a sourceId that resolves to nothing: never synced
-- again, and invisible as a problem because nothing in the schema said the
-- reference had to mean anything. ON DELETE RESTRICT rather than SET NULL,
-- because silently turning a directory-owned account into a locally managed
-- one is the same loss wearing a tidier face. Releasing those rows -- see
-- deleteSource in packages/core/src/sync/source-service.ts -- is now the
-- only way a source can be removed, and it is explicit.
--
-- The timestamp on this directory sorts after 20260815020000_mapping_failures
-- and after 20260815010000_directory_sync, which creates "DirectorySource".
-- Prisma applies migrations in lexicographic order of the directory name, and
-- resetDatabase() only truncates, so a migration named earlier than the table
-- it references passes the test suite and fails every fresh install.
--
-- ## Why NOT VALID
--
-- An install already carrying a stranded sourceId -- only reachable by hand
-- today, since nothing in the application could produce one, but the whole
-- point of this constraint is that such a row must not exist -- would make a
-- validating ADD CONSTRAINT fail outright, on a migration whose job is to
-- prevent that state rather than to punish it.
--
-- The obvious alternative, an UPDATE detaching stranded rows before the
-- constraint, does not work here and would be worse than nothing: every one
-- of these tables is FORCE ROW LEVEL SECURITY with a policy keyed on
-- `app.current_tenant`, and a migration binds no tenant. NULLIF(NULL) leaves
-- the policy neither true nor false, so the UPDATE matches zero rows in every
-- tenant and reports success. A repair statement that silently repairs
-- nothing, above a constraint that then passes for the wrong reason, is
-- exactly the sort of thing the rest of this work exists to stop shipping.
--
-- NOT VALID skips only the initial scan of existing rows. Every trigger is
-- still installed: an INSERT or UPDATE naming a source that does not exist is
-- refused from this moment on, and so is a DELETE of a source that still has
-- rows pointing at it -- the behaviour deleteSource depends on. A pre-existing
-- stranded row survives, and is visible to
--   SELECT id FROM "User" u WHERE u."sourceId" IS NOT NULL
--     AND NOT EXISTS (SELECT 1 FROM "DirectorySource" s WHERE s.id = u."sourceId");
-- run per tenant with app.current_tenant bound. Detach anything it returns,
-- then ALTER TABLE ... VALIDATE CONSTRAINT to close the gap for good.

-- AddForeignKey
ALTER TABLE "OrgUnit" ADD CONSTRAINT "OrgUnit_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "DirectorySource"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "DirectorySource"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

-- AddForeignKey
ALTER TABLE "Group" ADD CONSTRAINT "Group_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "DirectorySource"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
