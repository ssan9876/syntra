-- One-time links to a created account's initial password, and the account
-- profile setting that decides whether that password must be changed at first
-- sign-in.
--
-- 1. `AccountProfile.requirePasswordChangeAtFirstSignIn`: default true, so an
--    Active Directory profile that existed before this migration starts
--    setting `pwdLastSet = 0` on create. That is the behaviour the old email
--    already promised ("you will be asked to change it") and did not deliver.
-- 2. `CredentialPickup`: the right to read one sealed initial password once.
--    Only the SHA-256 of the token is stored, and no recipient address at all.
--
-- FORCE RLS like every tenant table.

ALTER TABLE "AccountProfile"
  ADD COLUMN "requirePasswordChangeAtFirstSignIn" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "CredentialPickup" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "targetAccountId" UUID NOT NULL,
    "secretName" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "recipientKind" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "viewedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByUserId" UUID,

    CONSTRAINT "CredentialPickup_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CredentialPickup_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CredentialPickup_targetAccountId_fkey" FOREIGN KEY ("targetAccountId") REFERENCES "TargetAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CredentialPickup_recipientKind_known" CHECK ("recipientKind" IN ('personalEmail', 'manager', 'admin')),
    -- A SHA-256 in hex, and nothing that could be the token itself.
    CONSTRAINT "CredentialPickup_tokenHash_shape" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$'),
    -- The only secret a pickup may point at is an initial password.
    CONSTRAINT "CredentialPickup_secretName_shape" CHECK ("secretName" ~ '^target/[0-9a-f-]{36}/initial/[0-9a-f-]{36}$')
);

CREATE UNIQUE INDEX "CredentialPickup_tokenHash_key" ON "CredentialPickup"("tokenHash");
CREATE INDEX "CredentialPickup_tenantId_idx" ON "CredentialPickup"("tenantId");
CREATE INDEX "CredentialPickup_targetAccountId_createdAt_idx" ON "CredentialPickup"("targetAccountId", "createdAt");

ALTER TABLE "CredentialPickup" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CredentialPickup" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "CredentialPickup"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
