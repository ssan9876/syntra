CREATE TABLE "LifecycleLegalHold" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "subjectType" TEXT NOT NULL,
  "subjectId" UUID NOT NULL,
  "reference" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "placedByUserId" UUID,
  "placedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "releasedByUserId" UUID,
  "releasedAt" TIMESTAMP(3),
  CONSTRAINT "LifecycleLegalHold_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LifecycleLegalHold_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "LifecycleLegalHold_tenantId_subjectType_subjectId_releasedAt_idx"
  ON "LifecycleLegalHold"("tenantId", "subjectType", "subjectId", "releasedAt");
CREATE INDEX "LifecycleLegalHold_tenantId_reference_idx" ON "LifecycleLegalHold"("tenantId", "reference");
