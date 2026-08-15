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

-- AddForeignKey
ALTER TABLE "OrgUnit" ADD CONSTRAINT "OrgUnit_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "DirectorySource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "DirectorySource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Group" ADD CONSTRAINT "Group_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "DirectorySource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
