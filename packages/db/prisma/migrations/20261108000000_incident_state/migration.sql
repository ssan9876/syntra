-- What somebody said about an incident on the attention list: acknowledged
-- (being handled) or resolved (a watermark: only what happens afterwards
-- counts). One row per tenant and incident kind. FORCE RLS like every tenant
-- table.

CREATE TABLE "IncidentState" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedById" UUID,
    "acknowledgeNote" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" UUID,
    "resolveNote" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IncidentState_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "IncidentState_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "IncidentState_note_length" CHECK (
      ("acknowledgeNote" IS NULL OR length("acknowledgeNote") <= 500) AND
      ("resolveNote" IS NULL OR length("resolveNote") <= 500)
    )
);

CREATE UNIQUE INDEX "IncidentState_tenantId_kind_key" ON "IncidentState"("tenantId", "kind");

ALTER TABLE "IncidentState" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "IncidentState" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "IncidentState"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
