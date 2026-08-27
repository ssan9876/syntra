-- How the portal groups a tile.
--
-- Nullable, and every existing application stays null: an uncategorised tile
-- belongs under one heading with the others rather than under a category
-- somebody's migration invented for it.
ALTER TABLE "Application" ADD COLUMN "category" TEXT;
