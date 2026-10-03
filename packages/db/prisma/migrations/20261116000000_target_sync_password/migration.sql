-- `TargetSystem.syncPassword` pushes a person's new Syntra password to their
-- account on this target when it is set. Off for every existing target.
ALTER TABLE "TargetSystem" ADD COLUMN "syncPassword" BOOLEAN NOT NULL DEFAULT false;
