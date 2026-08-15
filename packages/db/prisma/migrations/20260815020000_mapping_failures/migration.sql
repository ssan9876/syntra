-- Records the source returned but that could not be mapped into a directory
-- object. They used to be dropped on the floor, which made every one of them
-- look absent and therefore a candidate for deactivation.
--
-- The timestamp on this directory sorts after 20260815010000_directory_sync,
-- which creates "SyncRun". Prisma applies migrations in lexicographic order of
-- the directory name, so a migration named earlier than the table it alters
-- fails on any fresh database — and resetDatabase() only truncates, so the
-- test suite cannot catch it.
ALTER TABLE "SyncRun" ADD COLUMN     "mappingFailures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "mappingFailureReasons" TEXT[] DEFAULT ARRAY[]::TEXT[];
