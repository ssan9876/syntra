-- The tenant-wide emergency stop for connector writes. See the model comment
-- on `TenantExternalWriteStop`: one row per tenant, the same columns as the
-- per-target stop on "TargetSystem", and FORCE RLS like every tenant table.
CREATE TABLE "TenantExternalWriteStop" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId" UUID NOT NULL,
  "pausedAt" TIMESTAMP(3),
  "pausedByUserId" UUID,
  "pauseReason" TEXT,
  "pauseExpiresAt" TIMESTAMP(3),
  "resumedAt" TIMESTAMP(3),
  "resumedByUserId" UUID,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TenantExternalWriteStop_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TenantExternalWriteStop_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  -- An active stop always says who placed it and why. Resume is four-eyes
  -- against `pausedByUserId`, and a stop with no reason is an outage nobody
  -- can explain afterwards.
  CONSTRAINT "TenantExternalWriteStop_pause_complete" CHECK (
    "pausedAt" IS NULL OR ("pausedByUserId" IS NOT NULL AND "pauseReason" IS NOT NULL)
  ),
  CONSTRAINT "TenantExternalWriteStop_expiry_after_pause" CHECK (
    "pauseExpiresAt" IS NULL OR ("pausedAt" IS NOT NULL AND "pauseExpiresAt" > "pausedAt")
  )
);
CREATE UNIQUE INDEX "TenantExternalWriteStop_tenantId_key" ON "TenantExternalWriteStop"("tenantId");
ALTER TABLE "TenantExternalWriteStop" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TenantExternalWriteStop" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "TenantExternalWriteStop"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

