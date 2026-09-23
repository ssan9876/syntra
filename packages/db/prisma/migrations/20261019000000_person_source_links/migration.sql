CREATE TABLE "PersonSourceLink" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "sourceId" UUID NOT NULL,
  "personId" UUID NOT NULL,
  "externalId" TEXT NOT NULL,
  "linkedByUserId" UUID,
  "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PersonSourceLink_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PersonSourceLink_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE,
  CONSTRAINT "PersonSourceLink_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "PersonSource"("id") ON DELETE CASCADE,
  CONSTRAINT "PersonSourceLink_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "PersonSourceLink_sourceId_externalId_key" ON "PersonSourceLink"("sourceId", "externalId");
CREATE INDEX "PersonSourceLink_tenantId_personId_idx" ON "PersonSourceLink"("tenantId", "personId");
CREATE INDEX "PersonSourceLink_sourceId_personId_idx" ON "PersonSourceLink"("sourceId", "personId");

INSERT INTO "PersonSourceLink" ("id", "tenantId", "sourceId", "personId", "externalId", "linkedAt")
SELECT gen_random_uuid(), "tenantId", "sourceId", "id", "externalId", "createdAt"
FROM "Person" WHERE "sourceId" IS NOT NULL AND "externalId" IS NOT NULL;

ALTER TABLE "PersonSourceLink" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PersonSourceLink" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PersonSourceLink"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
