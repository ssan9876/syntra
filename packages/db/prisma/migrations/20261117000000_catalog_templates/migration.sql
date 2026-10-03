-- A tenant's own catalog entries for Access → Applications: the shape of a
-- built-in entry (variables, SAML or OpenID Connect settings, claims), saved
-- from an application configured by hand. Applications are made from an
-- entry by COPY, so editing or deleting an entry changes no application.

CREATE TABLE "CatalogTemplate" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'other',
    "description" TEXT NOT NULL DEFAULT '',
    "docsUrl" TEXT,
    "entry" JSONB NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogTemplate_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CatalogTemplate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CatalogTemplate_name_length" CHECK (length("name") BETWEEN 1 AND 128)
);

CREATE UNIQUE INDEX "CatalogTemplate_tenantId_name_key" ON "CatalogTemplate"("tenantId", "name");
CREATE INDEX "CatalogTemplate_tenantId_idx" ON "CatalogTemplate"("tenantId");

ALTER TABLE "CatalogTemplate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CatalogTemplate" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "CatalogTemplate"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
