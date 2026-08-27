-- A named set of claim mappings, applied to many applications at once.
--
-- Applied by COPY, not by reference: `ClaimMapping` stays the single thing the
-- assertion builder reads, so there is no second lookup path at sign-in and no
-- way for a set to silently change what an application already sends.

CREATE TABLE "ClaimMappingSet" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "protocol" TEXT NOT NULL,
    "mappings" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClaimMappingSet_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ClaimMappingSet_tenantId_name_key" ON "ClaimMappingSet"("tenantId", "name");
CREATE INDEX "ClaimMappingSet_tenantId_idx" ON "ClaimMappingSet"("tenantId");

-- A set belongs to one protocol. The same claim is a different wire format in
-- each, and a set spanning both would be two sets wearing one name.
ALTER TABLE "ClaimMappingSet" ADD CONSTRAINT claim_mapping_set_protocol
  CHECK ("protocol" IN ('saml', 'oidc'));

-- Row-level security.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ClaimMappingSet'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid) WITH CHECK ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid)',
      t);
  END LOOP;
END $$;
