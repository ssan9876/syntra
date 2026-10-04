-- One person left out of one target. Provision creates nothing for them
-- there and stops managing the account they already have, whatever the
-- business rules say. Deleting the row hands them back to the rules.

CREATE TABLE "TargetPersonExclusion" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "targetSystemId" UUID NOT NULL,
    "personId" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "createdByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TargetPersonExclusion_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TargetPersonExclusion_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TargetPersonExclusion_targetSystemId_fkey" FOREIGN KEY ("targetSystemId") REFERENCES "TargetSystem"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TargetPersonExclusion_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "TargetPersonExclusion_targetSystemId_personId_key" ON "TargetPersonExclusion"("targetSystemId", "personId");
CREATE INDEX "TargetPersonExclusion_tenantId_idx" ON "TargetPersonExclusion"("tenantId");
CREATE INDEX "TargetPersonExclusion_personId_idx" ON "TargetPersonExclusion"("personId");

ALTER TABLE "TargetPersonExclusion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TargetPersonExclusion" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "TargetPersonExclusion"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
