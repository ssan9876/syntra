-- Deletion stays refused until a source is deliberately allowed it, so an
-- existing source does not acquire the ability to remove directory objects
-- merely because the deployment was upgraded.
ALTER TABLE "DirectorySource"
  ADD COLUMN "writebackDelete" BOOLEAN NOT NULL DEFAULT false;
