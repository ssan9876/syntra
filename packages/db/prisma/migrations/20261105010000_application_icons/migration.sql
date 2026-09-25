-- Self-hosted application logos.
--
-- The page's security policy allows images only from this origin, so a remote
-- `iconUrl` never rendered: every tile fell back to its monogram. A logo is now
-- either a built-in mark the web app serves (`iconKey`) or a small raster an
-- administrator uploaded, stored on the row and served by the API
-- (`iconImage`, with its checked media type, its length -- so a list can report
-- it without reading every picture -- and a SHA-256 for cache-busting).
--
-- All nullable, and every existing application stays null: its tile looks
-- exactly as it did. New columns on an existing tenant-scoped table, so the
-- table's row-level security policy already covers them -- no new policy.
--
-- A built-in mark and an uploaded image are one-of. The service always writes
-- all five columns together; the CHECK is what keeps a hand-edited row from
-- carrying both, where which one the tile shows would be an accident of code
-- order rather than anybody's decision.
ALTER TABLE "Application" ADD COLUMN "iconKey" TEXT;
ALTER TABLE "Application" ADD COLUMN "iconImage" BYTEA;
ALTER TABLE "Application" ADD COLUMN "iconType" TEXT;
ALTER TABLE "Application" ADD COLUMN "iconSize" INTEGER;
ALTER TABLE "Application" ADD COLUMN "iconHash" TEXT;
ALTER TABLE "Application" ADD CONSTRAINT "Application_icon_one_of"
  CHECK ("iconKey" IS NULL OR "iconImage" IS NULL);
