CREATE TABLE "PersonProvisionReceipt" (
 "id" UUID PRIMARY KEY, "tenantId" UUID NOT NULL REFERENCES "Tenant"("id") ON DELETE CASCADE,
 "personId" UUID NOT NULL REFERENCES "Person"("id") ON DELETE CASCADE, "targetSystemId" UUID NOT NULL, "requestKey" UUID NOT NULL,
 "targetName" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'pending', "jobId" TEXT,
 "runId" UUID, "runIds" TEXT[] NOT NULL DEFAULT '{}', "evidence" JSONB, "message" TEXT,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "PersonProvisionReceipt_tenantId_personId_targetSystemId_requestKey_key" ON "PersonProvisionReceipt"("tenantId","personId","targetSystemId","requestKey");
CREATE INDEX "PersonProvisionReceipt_tenantId_personId_createdAt_idx" ON "PersonProvisionReceipt"("tenantId","personId","createdAt");
CREATE INDEX "PersonProvisionReceipt_tenantId_status_idx" ON "PersonProvisionReceipt"("tenantId","status");
ALTER TABLE "PersonProvisionReceipt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PersonProvisionReceipt" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PersonProvisionReceipt" USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid) WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
