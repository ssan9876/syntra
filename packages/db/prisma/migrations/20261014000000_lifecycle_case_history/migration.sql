ALTER TABLE "LifecycleOperation"
  ADD COLUMN "caseStatus" TEXT NOT NULL DEFAULT 'open',
  ADD COLUMN "resolvedAt" TIMESTAMP(3),
  ADD COLUMN "resolvedByUserId" UUID,
  ADD COLUMN "resolutionCode" TEXT,
  ADD COLUMN "resolutionSummary" TEXT;

CREATE TABLE "LifecycleCaseEvent" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "operationId" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "actorUserId" UUID,
  "message" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LifecycleCaseEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LifecycleCaseEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "LifecycleCaseEvent_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "LifecycleOperation"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "LifecycleCaseEvent_tenantId_operationId_createdAt_idx"
  ON "LifecycleCaseEvent"("tenantId", "operationId", "createdAt");
