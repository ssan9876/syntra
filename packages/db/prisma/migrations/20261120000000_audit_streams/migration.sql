-- Audit log streaming to a SIEM, over HTTPS or syslog. Tenant-scoped with
-- row-level security like every tenant table; the credential is in the vault.

CREATE TABLE "AuditStream" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "transport" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "url" TEXT,
    "host" TEXT,
    "port" INTEGER,
    "tls" BOOLEAN NOT NULL DEFAULT true,
    "authHeader" TEXT,
    "cursor" INTEGER NOT NULL DEFAULT 0,
    "lastDeliveredAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "leaseUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuditStream_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AuditStream_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AuditStream_transport_check" CHECK ("transport" IN ('https', 'syslog')),
    CONSTRAINT "AuditStream_format_check" CHECK ("format" IN ('json', 'splunk-hec', 'cef'))
);

CREATE UNIQUE INDEX "AuditStream_tenantId_name_key" ON "AuditStream"("tenantId", "name");
CREATE INDEX "AuditStream_tenantId_idx" ON "AuditStream"("tenantId");

ALTER TABLE "AuditStream" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditStream" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "AuditStream"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
