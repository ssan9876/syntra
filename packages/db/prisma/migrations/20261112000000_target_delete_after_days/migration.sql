-- The last rung of the leaver ladder: delete a disabled account N days after
-- departure. Null means never, and every existing target stays null.
ALTER TABLE "TargetSystem" ADD COLUMN "deleteAfterDays" INTEGER;

-- Its own guard threshold, defaulting like the archive's.
ALTER TABLE "TargetSystem" ADD COLUMN "deleteAccountThresholdPercent" INTEGER NOT NULL DEFAULT 2;

ALTER TABLE "ProvisionRun" ADD COLUMN "deleteAccountCount" INTEGER NOT NULL DEFAULT 0;

-- Delete falls at or after the disable and the archive.
ALTER TABLE "TargetSystem" ADD CONSTRAINT target_system_delete_after_ladder CHECK (
  "deleteAfterDays" IS NULL OR (
    "deleteAfterDays" >= 0
    AND "deleteAfterDays" >= "disableGraceDays"
    AND ("archiveAfterDays" IS NULL OR "deleteAfterDays" >= "archiveAfterDays")
  )
);

ALTER TABLE "TargetSystem" ADD CONSTRAINT target_system_delete_threshold_is_percent CHECK (
  "deleteAccountThresholdPercent" BETWEEN 0 AND 100
);
