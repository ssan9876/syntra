-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorUserId" UUID,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" UUID,
    "outcome" TEXT NOT NULL,
    "sourceIp" TEXT,
    "payload" JSONB NOT NULL,
    "prevHash" TEXT NOT NULL,
    "hash" TEXT NOT NULL,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuditEvent_tenantId_occurredAt_idx" ON "AuditEvent"("tenantId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "AuditEvent_tenantId_sequence_key" ON "AuditEvent"("tenantId", "sequence");

-- Row-level security.
ALTER TABLE "AuditEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditEvent" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "AuditEvent"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- Append-only. The rules make tampering through the application impossible;
-- the hash chain makes tampering through direct database access DETECTABLE.
-- Neither substitutes for the other. TRUNCATE is not affected by rules, so
-- test fixtures can still reset the table.
CREATE RULE audit_no_update AS ON UPDATE TO "AuditEvent" DO INSTEAD NOTHING;
CREATE RULE audit_no_delete AS ON DELETE TO "AuditEvent" DO INSTEAD NOTHING;
