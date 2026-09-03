-- The person list orders by family name then given name within a tenant, and
-- filters on status. Without these every page sorted the whole tenant.
CREATE INDEX "Person_tenantId_familyName_givenName_idx" ON "Person"("tenantId", "familyName", "givenName");
CREATE INDEX "Person_tenantId_status_idx" ON "Person"("tenantId", "status");
