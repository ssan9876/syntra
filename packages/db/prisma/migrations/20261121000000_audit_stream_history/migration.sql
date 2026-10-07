-- SIEM streams: which events each one sends, and a history of what was sent.

ALTER TABLE "AuditStream" ADD COLUMN "actionPrefixes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "AuditStream" ADD COLUMN "outcome" TEXT;
ALTER TABLE "AuditStream" ADD COLUMN "generation" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AuditStream" ADD CONSTRAINT "AuditStream_outcome_check" CHECK ("outcome" IS NULL OR "outcome" IN ('success', 'failure'));

CREATE TABLE "AuditStreamDelivery" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "streamId" UUID NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL,
    "firstSequence" INTEGER,
    "lastSequence" INTEGER,
    "count" INTEGER NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "error" TEXT,
    "durationMs" INTEGER NOT NULL,

    CONSTRAINT "AuditStreamDelivery_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AuditStreamDelivery_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AuditStreamDelivery_streamId_fkey" FOREIGN KEY ("streamId") REFERENCES "AuditStream"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AuditStreamDelivery_kind_check" CHECK ("kind" IN ('batch', 'test'))
);

CREATE INDEX "AuditStreamDelivery_tenantId_idx" ON "AuditStreamDelivery"("tenantId");
CREATE INDEX "AuditStreamDelivery_streamId_at_idx" ON "AuditStreamDelivery"("streamId", "at");

ALTER TABLE "AuditStreamDelivery" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditStreamDelivery" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "AuditStreamDelivery"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
