-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "satisfiedFactor" TEXT;

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "adminMfaRequired" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "passwordMinLength" INTEGER NOT NULL DEFAULT 12,
ADD COLUMN     "selfEnrolmentEnabled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "passwordSource" TEXT NOT NULL DEFAULT 'local',
ADD COLUMN     "passwordSourceHint" TEXT;

-- CreateTable
CREATE TABLE "AuthPolicy" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "defaultOutcome" TEXT NOT NULL DEFAULT 'allow',
    "defaultFactorType" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthPolicyRule" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "policyId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "outcome" TEXT NOT NULL,
    "factorType" TEXT,
    "applicationIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "groupIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "contractField" TEXT,
    "contractValues" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ipRanges" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "daysOfWeek" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "startMinute" INTEGER,
    "endMinute" INTEGER,
    "timezone" TEXT,

    CONSTRAINT "AuthPolicyRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Application" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "iconUrl" TEXT,
    "launchUrl" TEXT,
    "type" TEXT NOT NULL DEFAULT 'bookmark',
    "visibility" TEXT NOT NULL DEFAULT 'assigned',
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Application_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppAssignment" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "applicationId" UUID NOT NULL,
    "subjectType" TEXT NOT NULL,
    "userId" UUID,
    "groupId" UUID,
    "orgUnitId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TotpCredential" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "secretName" TEXT NOT NULL,
    "algorithm" TEXT NOT NULL DEFAULT 'SHA1',
    "digits" INTEGER NOT NULL DEFAULT 6,
    "period" INTEGER NOT NULL DEFAULT 30,
    "lastCounter" INTEGER,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TotpCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebAuthnCredential" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "credentialId" TEXT NOT NULL,
    "publicKey" BYTEA NOT NULL,
    "counter" BIGINT NOT NULL DEFAULT 0,
    "transports" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "attestationType" TEXT NOT NULL DEFAULT 'none',
    "rpId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "WebAuthnCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebAuthnChallenge" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "challenge" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebAuthnChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecoveryCode" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecoveryCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PasswordResetToken" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthAttempt" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "applicationId" UUID,
    "sourceIp" TEXT,
    "purpose" TEXT NOT NULL DEFAULT 'verify',
    "scope" TEXT NOT NULL DEFAULT 'portal',
    "requiredOutcome" TEXT NOT NULL,
    "requiredFactor" TEXT,
    "ruleId" UUID,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "clientId" TEXT,
    "scope" TEXT NOT NULL DEFAULT 'portal',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "absoluteExpiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AuthPolicy_tenantId_key" ON "AuthPolicy"("tenantId");

-- CreateIndex
CREATE INDEX "AuthPolicyRule_tenantId_idx" ON "AuthPolicyRule"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "AuthPolicyRule_policyId_position_key" ON "AuthPolicyRule"("policyId", "position");

-- CreateIndex
CREATE INDEX "Application_tenantId_idx" ON "Application"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Application_tenantId_slug_key" ON "Application"("tenantId", "slug");

-- CreateIndex
CREATE INDEX "AppAssignment_tenantId_idx" ON "AppAssignment"("tenantId");

-- CreateIndex
CREATE INDEX "AppAssignment_applicationId_idx" ON "AppAssignment"("applicationId");

-- CreateIndex
CREATE UNIQUE INDEX "TotpCredential_userId_key" ON "TotpCredential"("userId");

-- CreateIndex
CREATE INDEX "TotpCredential_tenantId_idx" ON "TotpCredential"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "WebAuthnCredential_credentialId_key" ON "WebAuthnCredential"("credentialId");

-- CreateIndex
CREATE INDEX "WebAuthnCredential_tenantId_idx" ON "WebAuthnCredential"("tenantId");

-- CreateIndex
CREATE INDEX "WebAuthnCredential_userId_idx" ON "WebAuthnCredential"("userId");

-- CreateIndex
CREATE INDEX "WebAuthnChallenge_tenantId_idx" ON "WebAuthnChallenge"("tenantId");

-- CreateIndex
CREATE INDEX "WebAuthnChallenge_userId_purpose_idx" ON "WebAuthnChallenge"("userId", "purpose");

-- CreateIndex
CREATE INDEX "RecoveryCode_tenantId_idx" ON "RecoveryCode"("tenantId");

-- CreateIndex
CREATE INDEX "RecoveryCode_userId_idx" ON "RecoveryCode"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "RecoveryCode_userId_codeHash_key" ON "RecoveryCode"("userId", "codeHash");

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PasswordResetToken_tenantId_idx" ON "PasswordResetToken"("tenantId");

-- CreateIndex
CREATE INDEX "PasswordResetToken_userId_idx" ON "PasswordResetToken"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AuthAttempt_tokenHash_key" ON "AuthAttempt"("tokenHash");

-- CreateIndex
CREATE INDEX "AuthAttempt_tenantId_idx" ON "AuthAttempt"("tenantId");

-- CreateIndex
CREATE INDEX "AuthAttempt_userId_idx" ON "AuthAttempt"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshToken_tenantId_idx" ON "RefreshToken"("tenantId");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");

-- AddForeignKey
ALTER TABLE "AuthPolicyRule" ADD CONSTRAINT "AuthPolicyRule_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "AuthPolicy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppAssignment" ADD CONSTRAINT "AppAssignment_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security. FORCE subjects the owning role to its own policies;
-- NULLIF is required because a GUC set with set_config(..., true) reverts to
-- an empty string, not NULL, when the transaction ends.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'AuthPolicy','AuthPolicyRule','Application','AppAssignment',
    'TotpCredential','WebAuthnCredential','WebAuthnChallenge','RecoveryCode',
    'PasswordResetToken','AuthAttempt','RefreshToken'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid) WITH CHECK ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid)',
      t);
  END LOOP;
END $$;

-- An assignment names exactly one subject. Without this, a row with every
-- subject column null is a grant to nobody that still resolves as a row.
ALTER TABLE "AppAssignment" ADD CONSTRAINT app_assignment_one_subject CHECK (
  (CASE WHEN "userId"    IS NULL THEN 0 ELSE 1 END) +
  (CASE WHEN "groupId"   IS NULL THEN 0 ELSE 1 END) +
  (CASE WHEN "orgUnitId" IS NULL THEN 0 ELSE 1 END) = 1
);

-- PostgreSQL treats NULL as distinct from NULL, so a plain
-- UNIQUE("applicationId","userId") would not constrain group or org-unit
-- assignments at all, and would let the same user be granted twice. Three
-- partial indexes, one per subject kind, is what actually constrains them.
CREATE UNIQUE INDEX app_assignment_unique_user
  ON "AppAssignment" ("applicationId", "userId") WHERE "userId" IS NOT NULL;
CREATE UNIQUE INDEX app_assignment_unique_group
  ON "AppAssignment" ("applicationId", "groupId") WHERE "groupId" IS NOT NULL;
CREATE UNIQUE INDEX app_assignment_unique_org_unit
  ON "AppAssignment" ("applicationId", "orgUnitId") WHERE "orgUnitId" IS NOT NULL;

-- At most one live WebAuthn challenge per user and purpose. Same reason:
-- "consumedAt" is nullable, so only a partial index constrains the live rows.
CREATE UNIQUE INDEX webauthn_challenge_one_live
  ON "WebAuthnChallenge" ("userId", "purpose") WHERE "consumedAt" IS NULL;

-- One live reset token per user, for the same reason. Requesting a second
-- reset consumes the first rather than leaving two valid tokens in the wild.
CREATE UNIQUE INDEX password_reset_token_one_live
  ON "PasswordResetToken" ("userId") WHERE "consumedAt" IS NULL;

