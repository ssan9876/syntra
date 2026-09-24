-- Backlog #34 (credential lifecycle), #52 (security notification policy) and
-- the in-product half of #67 (certificate and key expiry inventory).
--
-- 1. Two tenant settings: which security notification categories also email
--    tenant.manage holders, and the advance-alert thresholds for credential
--    expiry. Both are additive with defaults that change nothing a tenant
--    already receives.
-- 2. `CredentialRecord`: owner, declared/discovered expiry and alert state for
--    one inventory entry. Never a credential.
-- 3. `CredentialRotation`: the dual-secret rotation workflow and its evidence.
--
-- Both tables are FORCE RLS like every tenant table.

ALTER TABLE "Tenant"
  ADD COLUMN "securityEmailCategories" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "credentialAlertDays" INTEGER[] NOT NULL DEFAULT ARRAY[30, 14, 7, 1]::INTEGER[];

ALTER TABLE "Tenant"
  ADD CONSTRAINT "Tenant_credentialAlertDays_bounded" CHECK (
    cardinality("credentialAlertDays") BETWEEN 1 AND 8
    AND 1 <= ALL ("credentialAlertDays")
    AND 365 >= ALL ("credentialAlertDays")
  ),
  ADD CONSTRAINT "Tenant_securityEmailCategories_known" CHECK (
    "securityEmailCategories" <@ ARRAY[
      'credential_changes',
      'privileged_role_grants',
      'data_exports',
      'write_stops',
      'suspicious_authentication',
      'credential_expiry'
    ]::TEXT[]
  );

CREATE TABLE "CredentialRecord" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "credentialKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "ownerUserId" UUID,
    "note" TEXT,
    "declaredExpiresAt" TIMESTAMP(3),
    "discoveredExpiresAt" TIMESTAMP(3),
    "discoveryStatus" TEXT,
    "discoveryMessage" TEXT,
    "discoveredAt" TIMESTAMP(3),
    "effectiveExpiresAt" TIMESTAMP(3),
    "alertedExpiresAt" TIMESTAMP(3),
    "alertedThresholdDays" INTEGER,
    "alertedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CredentialRecord_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CredentialRecord_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CredentialRecord_key_shape" CHECK ("credentialKey" ~ '^[a-z_]+\.[0-9a-f-]{36}(\.[0-9a-f]{16,64})?$'),
    CONSTRAINT "CredentialRecord_note_bounded" CHECK ("note" IS NULL OR char_length("note") <= 500),
    CONSTRAINT "CredentialRecord_discovery_known" CHECK (
      "discoveryStatus" IS NULL OR "discoveryStatus" IN ('found', 'unmatched', 'not_permitted', 'failed')
    )
);

CREATE UNIQUE INDEX "CredentialRecord_tenantId_credentialKey_key" ON "CredentialRecord"("tenantId", "credentialKey");
CREATE INDEX "CredentialRecord_tenantId_effectiveExpiresAt_idx" ON "CredentialRecord"("tenantId", "effectiveExpiresAt");

ALTER TABLE "CredentialRecord" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CredentialRecord" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "CredentialRecord"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

CREATE TABLE "CredentialRotation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "systemKind" TEXT NOT NULL,
    "systemId" UUID NOT NULL,
    "credentialKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'staged',
    "reason" TEXT,
    "stagedSecretName" TEXT,
    "previousSecretName" TEXT,
    "newExpiresAt" TIMESTAMP(3),
    "stagedByUserId" UUID,
    "stagedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedAt" TIMESTAMP(3),
    "verifiedByUserId" UUID,
    "verificationOk" BOOLEAN,
    "verificationMessage" TEXT,
    "verificationFingerprint" TEXT,
    "cutOverAt" TIMESTAMP(3),
    "cutOverByUserId" UUID,
    "completedAt" TIMESTAMP(3),
    "completedByUserId" UUID,
    "closedAt" TIMESTAMP(3),
    "closedByUserId" UUID,
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CredentialRotation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CredentialRotation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CredentialRotation_systemKind_known" CHECK ("systemKind" IN ('target', 'source', 'person_source')),
    CONSTRAINT "CredentialRotation_status_known" CHECK (
      "status" IN ('staged', 'verified', 'verification_failed', 'cut_over', 'completed', 'rolled_back', 'cancelled')
    ),
    -- Cut over only from a passed verification: the database refuses a
    -- cut-over row that carries no successful test, whatever the code does.
    CONSTRAINT "CredentialRotation_cutover_verified" CHECK (
      "status" NOT IN ('cut_over', 'completed') OR ("verificationOk" = true AND "cutOverAt" IS NOT NULL)
    ),
    -- A closed rotation holds no sealed secret of its own.
    CONSTRAINT "CredentialRotation_closed_erased" CHECK (
      "status" NOT IN ('completed', 'rolled_back', 'cancelled')
      OR ("stagedSecretName" IS NULL AND "previousSecretName" IS NULL)
    ),
    CONSTRAINT "CredentialRotation_reason_bounded" CHECK ("reason" IS NULL OR char_length("reason") <= 500)
);

CREATE INDEX "CredentialRotation_tenantId_systemKind_systemId_stagedAt_idx" ON "CredentialRotation"("tenantId", "systemKind", "systemId", "stagedAt");
CREATE INDEX "CredentialRotation_tenantId_status_idx" ON "CredentialRotation"("tenantId", "status");
-- One open rotation per system. Two would each stage, verify and cut over a
-- different secret, and the second cut-over would retain the first's NEW
-- secret as its "previous" one.
CREATE UNIQUE INDEX "CredentialRotation_one_open_per_system" ON "CredentialRotation"("tenantId", "systemKind", "systemId")
  WHERE "status" IN ('staged', 'verified', 'verification_failed', 'cut_over');

ALTER TABLE "CredentialRotation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CredentialRotation" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "CredentialRotation"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
