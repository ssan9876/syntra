CREATE TABLE "IdentityReferenceValue" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "normalizedValue" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdByUserId" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "IdentityReferenceValue_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "IdentityReferenceValue_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "IdentityReferenceValue_tenantId_kind_normalizedValue_key"
  ON "IdentityReferenceValue"("tenantId", "kind", "normalizedValue");
CREATE INDEX "IdentityReferenceValue_tenantId_kind_active_idx"
  ON "IdentityReferenceValue"("tenantId", "kind", "active");
ALTER TABLE "IdentityReferenceValue" ADD CONSTRAINT "IdentityReferenceValue_kind_valid"
  CHECK ("kind" IN ('department', 'location'));

ALTER TABLE "IdentityReferenceValue" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "IdentityReferenceValue" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "IdentityReferenceValue"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
