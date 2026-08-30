-- A credential a program can hold.
--
-- Issued against a service account -- a User with a null personId -- so that
-- RBAC, the audit log, deactivation and recertification all reach a machine
-- through the paths they already reach a person through, rather than through a
-- second one that could forget it.
--
-- ONLY A DIGEST IS STORED. The token value is shown once, at issue, and never
-- again; there is no column here it could be read back from.
CREATE TABLE "ApiToken" (
    "id"         UUID NOT NULL,
    "tenantId"   UUID NOT NULL,
    "userId"     UUID NOT NULL,
    "name"       TEXT NOT NULL,
    "tokenHash"  TEXT NOT NULL,
    "scopes"     TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "expiresAt"  TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt"  TIMESTAMP(3),
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy"  UUID,

    CONSTRAINT "ApiToken_pkey" PRIMARY KEY ("id")
);

-- Unique across the installation, not per tenant: the digest is what a
-- presented token is looked up by, before any tenant is known.
CREATE UNIQUE INDEX "ApiToken_tokenHash_key" ON "ApiToken"("tokenHash");
CREATE INDEX "ApiToken_tenantId_idx" ON "ApiToken"("tenantId");
CREATE INDEX "ApiToken_userId_idx" ON "ApiToken"("userId");

ALTER TABLE "ApiToken" ADD CONSTRAINT "ApiToken_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Cascade: a deleted account must not leave behind a live credential that
-- authenticates as a user who no longer exists.
ALTER TABLE "ApiToken" ADD CONSTRAINT "ApiToken_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ApiToken'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid) WITH CHECK ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid)',
      t);
  END LOOP;
END $$;
