-- Which catalog entry an application was created from.
--
-- Nullable, and every existing row stays null: an application configured by
-- hand did not come from an entry, and backfilling a guess would make the
-- console claim a provenance nobody chose.
ALTER TABLE "Application" ADD COLUMN "catalogKey" TEXT;
