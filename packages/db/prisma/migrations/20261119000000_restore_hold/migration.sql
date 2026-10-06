-- A restore that has not been released yet. Installation-wide, so no
-- tenantId and no row-level security (see RateLimitBucket). The restore tool
-- inserts a row after putting a backup back; the API holds background work
-- and writes to target systems until it is released.
--
-- IF NOT EXISTS because ops/restore-hold.sql creates the same table when a
-- backup from before this migration is restored by hand.

CREATE TABLE IF NOT EXISTS "RestoreHold" (
    "id" UUID NOT NULL,
    "backupName" TEXT NOT NULL,
    "backupTakenAt" TIMESTAMP(3),
    "backupVersion" TEXT,
    "restoredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMP(3),

    CONSTRAINT "RestoreHold_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "RestoreHold_releasedAt_idx" ON "RestoreHold"("releasedAt");
