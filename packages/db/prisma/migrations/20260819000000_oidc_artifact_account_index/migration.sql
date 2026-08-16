-- Revoking every artifact one account holds is what a password reset now does
-- (spec section 9.4 point 4), and `accountId` had no index of its own -- only
-- `(tenantId)` and `(tenantId, grantId)`. Without this, a reset scans every
-- live token in the tenant.
--
-- `accountId` is nullable: a client-credentials access token has no account.
-- A plain index takes NULLs happily; nothing here is a uniqueness claim.
CREATE INDEX "OidcArtifact_tenantId_accountId_idx" ON "OidcArtifact"("tenantId", "accountId");
