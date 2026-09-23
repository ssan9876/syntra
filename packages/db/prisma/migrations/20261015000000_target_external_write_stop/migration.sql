ALTER TABLE "TargetSystem"
  ADD COLUMN "externalWritesPausedAt" TIMESTAMP(3),
  ADD COLUMN "externalWritesPausedByUserId" UUID,
  ADD COLUMN "externalWritesPauseReason" TEXT,
  ADD COLUMN "externalWritesPauseExpiresAt" TIMESTAMP(3),
  ADD COLUMN "externalWritesResumedAt" TIMESTAMP(3),
  ADD COLUMN "externalWritesResumedByUserId" UUID;

CREATE INDEX "TargetSystem_tenantId_externalWritesPausedAt_idx"
  ON "TargetSystem"("tenantId", "externalWritesPausedAt");
