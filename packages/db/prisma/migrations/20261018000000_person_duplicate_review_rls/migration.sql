ALTER TABLE "PersonDuplicateReview" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PersonDuplicateReview" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PersonDuplicateReview"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
