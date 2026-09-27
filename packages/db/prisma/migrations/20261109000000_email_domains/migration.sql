-- Domains a tenant has proved it controls. Only a verified domain may appear
-- in an address Syntra writes. FORCE RLS like every tenant table.

CREATE TABLE "EmailDomain" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "domain" TEXT NOT NULL,
    "verificationToken" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3),
    "lastCheckError" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailDomain_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "EmailDomain_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "EmailDomain_domain_shape" CHECK ("domain" = lower("domain") AND length("domain") <= 253),
    CONSTRAINT "EmailDomain_error_length" CHECK ("lastCheckError" IS NULL OR length("lastCheckError") <= 500)
);

CREATE UNIQUE INDEX "EmailDomain_tenantId_domain_key" ON "EmailDomain"("tenantId", "domain");

ALTER TABLE "EmailDomain" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EmailDomain" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "EmailDomain"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
