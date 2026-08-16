-- CreateTable
CREATE TABLE "TargetSystem" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'activeDirectory',
    "config" JSONB NOT NULL,
    "secretName" TEXT NOT NULL,
    "pairedDirectorySourceId" UUID,
    "schedule" TEXT,
    "autoApply" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "enforcementMode" TEXT NOT NULL DEFAULT 'additive',
    "preHireDays" INTEGER NOT NULL DEFAULT 0,
    "entitlementRevocationDelayDays" INTEGER NOT NULL DEFAULT 0,
    "disableGraceDays" INTEGER NOT NULL DEFAULT 0,
    "archiveAfterDays" INTEGER,
    "reenableWithoutConfirmationDays" INTEGER NOT NULL DEFAULT 7,
    "createAccountThresholdPercent" INTEGER NOT NULL DEFAULT 20,
    "disableAccountThresholdPercent" INTEGER NOT NULL DEFAULT 10,
    "archiveAccountThresholdPercent" INTEGER NOT NULL DEFAULT 2,
    "revokeEntitlementThresholdPercent" INTEGER NOT NULL DEFAULT 10,
    "deactivateSyntraUserThresholdPercent" INTEGER NOT NULL DEFAULT 10,
    "perEntitlementThresholdPercent" INTEGER NOT NULL DEFAULT 50,
    "personPopulationDropPercent" INTEGER NOT NULL DEFAULT 20,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "concurrency" INTEGER NOT NULL DEFAULT 4,
    "renameEnabled" BOOLEAN NOT NULL DEFAULT false,
    "lastRunAt" TIMESTAMP(3),
    "lastAppliedRunAt" TIMESTAMP(3),
    "consecutiveSkippedRuns" INTEGER NOT NULL DEFAULT 0,
    "lastSkippedAt" TIMESTAMP(3),
    "lastSkipReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TargetSystem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountProfile" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "targetSystemId" UUID NOT NULL,
    "correlationKeyTemplate" TEXT NOT NULL,
    "uniquenessStrategy" TEXT NOT NULL DEFAULT 'numericSuffix',
    "maxUniquenessAttempts" INTEGER NOT NULL DEFAULT 20,
    "containerTemplate" TEXT NOT NULL,
    "fallbackContainer" TEXT NOT NULL,
    "attributeTemplates" JSONB NOT NULL,
    "initialPasswordPolicy" JSONB NOT NULL,
    "initialPasswordDelivery" TEXT NOT NULL DEFAULT 'vaultOnly',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessRule" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "targetSystemId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "condition" JSONB NOT NULL,
    "grantsAccount" BOOLEAN NOT NULL DEFAULT true,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RuleEntitlement" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "ruleId" UUID NOT NULL,
    "entitlementId" UUID NOT NULL,

    CONSTRAINT "RuleEntitlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Entitlement" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "targetSystemId" UUID NOT NULL,
    "externalId" TEXT NOT NULL,
    "dn" TEXT,
    "type" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'present',
    "holderCount" INTEGER NOT NULL DEFAULT 0,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Entitlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TargetAccount" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "targetSystemId" UUID NOT NULL,
    "personId" UUID NOT NULL,
    "anchor" TEXT,
    "correlationKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "statusReason" TEXT,
    "disabledAt" TIMESTAMP(3),
    "disableDueAt" TIMESTAMP(3),
    "archiveDueAt" TIMESTAMP(3),
    "createdActionId" UUID,
    "lastReconciledAt" TIMESTAMP(3),
    "lastAppliedAttributes" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TargetAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountEntitlement" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "entitlementId" UUID NOT NULL,
    "origin" TEXT NOT NULL,
    "grantedByRuleId" UUID,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "state" TEXT NOT NULL DEFAULT 'held',

    CONSTRAINT "AccountEntitlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProvisionRun" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "targetSystemId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "createAccountCount" INTEGER NOT NULL DEFAULT 0,
    "updateAccountCount" INTEGER NOT NULL DEFAULT 0,
    "enableAccountCount" INTEGER NOT NULL DEFAULT 0,
    "disableAccountCount" INTEGER NOT NULL DEFAULT 0,
    "archiveAccountCount" INTEGER NOT NULL DEFAULT 0,
    "renameAccountCount" INTEGER NOT NULL DEFAULT 0,
    "grantEntitlementCount" INTEGER NOT NULL DEFAULT 0,
    "revokeEntitlementCount" INTEGER NOT NULL DEFAULT 0,
    "deactivateSyntraUserCount" INTEGER NOT NULL DEFAULT 0,
    "reactivateSyntraUserCount" INTEGER NOT NULL DEFAULT 0,
    "personsEvaluated" INTEGER NOT NULL DEFAULT 0,
    "personsWithActiveContract" INTEGER NOT NULL DEFAULT 0,
    "personsUnprocessable" INTEGER NOT NULL DEFAULT 0,
    "accountsReadFromTarget" INTEGER NOT NULL DEFAULT 0,
    "entitlementsReadFromTarget" INTEGER NOT NULL DEFAULT 0,
    "requiresConfirmation" BOOLEAN NOT NULL DEFAULT false,
    "blockedReason" TEXT,
    "confirmedByUserId" UUID,
    "error" TEXT,

    CONSTRAINT "ProvisionRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProvisionAction" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "actionType" TEXT NOT NULL,
    "personId" UUID,
    "accountId" UUID,
    "entitlementId" UUID,
    "before" JSONB,
    "after" JSONB,
    "attributedRuleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "message" TEXT,
    "appliedAt" TIMESTAMP(3),
    "requiresConfirmation" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProvisionAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProvisionException" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "personId" UUID NOT NULL,
    "targetSystemId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProvisionException_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DriftFinding" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "targetSystemId" UUID NOT NULL,
    "runId" UUID,
    "accountId" UUID,
    "entitlementId" UUID,
    "subjectAnchor" TEXT,
    "kind" TEXT NOT NULL,
    "detail" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "fingerprint" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DriftFinding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TargetSystem_tenantId_idx" ON "TargetSystem"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "TargetSystem_tenantId_name_key" ON "TargetSystem"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "AccountProfile_targetSystemId_key" ON "AccountProfile"("targetSystemId");

-- CreateIndex
CREATE INDEX "AccountProfile_tenantId_idx" ON "AccountProfile"("tenantId");

-- CreateIndex
CREATE INDEX "BusinessRule_tenantId_idx" ON "BusinessRule"("tenantId");

-- CreateIndex
CREATE INDEX "BusinessRule_targetSystemId_idx" ON "BusinessRule"("targetSystemId");

-- CreateIndex
CREATE INDEX "RuleEntitlement_tenantId_idx" ON "RuleEntitlement"("tenantId");

-- CreateIndex
CREATE INDEX "RuleEntitlement_entitlementId_idx" ON "RuleEntitlement"("entitlementId");

-- CreateIndex
CREATE UNIQUE INDEX "RuleEntitlement_ruleId_entitlementId_key" ON "RuleEntitlement"("ruleId", "entitlementId");

-- CreateIndex
CREATE INDEX "Entitlement_tenantId_idx" ON "Entitlement"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Entitlement_tenantId_targetSystemId_externalId_key" ON "Entitlement"("tenantId", "targetSystemId", "externalId");

-- CreateIndex
CREATE INDEX "TargetAccount_tenantId_idx" ON "TargetAccount"("tenantId");

-- CreateIndex
CREATE INDEX "TargetAccount_targetSystemId_status_idx" ON "TargetAccount"("targetSystemId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "TargetAccount_tenantId_targetSystemId_personId_key" ON "TargetAccount"("tenantId", "targetSystemId", "personId");

-- CreateIndex
CREATE UNIQUE INDEX "TargetAccount_tenantId_targetSystemId_correlationKey_key" ON "TargetAccount"("tenantId", "targetSystemId", "correlationKey");

-- CreateIndex
CREATE INDEX "AccountEntitlement_tenantId_idx" ON "AccountEntitlement"("tenantId");

-- CreateIndex
CREATE INDEX "AccountEntitlement_accountId_idx" ON "AccountEntitlement"("accountId");

-- CreateIndex
CREATE INDEX "AccountEntitlement_entitlementId_state_idx" ON "AccountEntitlement"("entitlementId", "state");

-- CreateIndex
CREATE INDEX "ProvisionRun_tenantId_idx" ON "ProvisionRun"("tenantId");

-- CreateIndex
CREATE INDEX "ProvisionRun_targetSystemId_startedAt_idx" ON "ProvisionRun"("targetSystemId", "startedAt");

-- CreateIndex
CREATE INDEX "ProvisionAction_runId_status_idx" ON "ProvisionAction"("runId", "status");

-- CreateIndex
CREATE INDEX "ProvisionAction_runId_sequence_idx" ON "ProvisionAction"("runId", "sequence");

-- CreateIndex
CREATE INDEX "ProvisionAction_tenantId_idx" ON "ProvisionAction"("tenantId");

-- CreateIndex
CREATE INDEX "ProvisionAction_personId_idx" ON "ProvisionAction"("personId");

-- CreateIndex
CREATE INDEX "ProvisionException_tenantId_idx" ON "ProvisionException"("tenantId");

-- CreateIndex
CREATE INDEX "ProvisionException_runId_idx" ON "ProvisionException"("runId");

-- CreateIndex
CREATE INDEX "ProvisionException_personId_idx" ON "ProvisionException"("personId");

-- CreateIndex
CREATE INDEX "DriftFinding_tenantId_idx" ON "DriftFinding"("tenantId");

-- CreateIndex
CREATE INDEX "DriftFinding_targetSystemId_status_idx" ON "DriftFinding"("targetSystemId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DriftFinding_tenantId_targetSystemId_fingerprint_key" ON "DriftFinding"("tenantId", "targetSystemId", "fingerprint");

-- AddForeignKey
ALTER TABLE "AccountProfile" ADD CONSTRAINT "AccountProfile_targetSystemId_fkey" FOREIGN KEY ("targetSystemId") REFERENCES "TargetSystem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessRule" ADD CONSTRAINT "BusinessRule_targetSystemId_fkey" FOREIGN KEY ("targetSystemId") REFERENCES "TargetSystem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuleEntitlement" ADD CONSTRAINT "RuleEntitlement_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "BusinessRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuleEntitlement" ADD CONSTRAINT "RuleEntitlement_entitlementId_fkey" FOREIGN KEY ("entitlementId") REFERENCES "Entitlement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Entitlement" ADD CONSTRAINT "Entitlement_targetSystemId_fkey" FOREIGN KEY ("targetSystemId") REFERENCES "TargetSystem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TargetAccount" ADD CONSTRAINT "TargetAccount_targetSystemId_fkey" FOREIGN KEY ("targetSystemId") REFERENCES "TargetSystem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TargetAccount" ADD CONSTRAINT "TargetAccount_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountEntitlement" ADD CONSTRAINT "AccountEntitlement_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TargetAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountEntitlement" ADD CONSTRAINT "AccountEntitlement_entitlementId_fkey" FOREIGN KEY ("entitlementId") REFERENCES "Entitlement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProvisionRun" ADD CONSTRAINT "ProvisionRun_targetSystemId_fkey" FOREIGN KEY ("targetSystemId") REFERENCES "TargetSystem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProvisionAction" ADD CONSTRAINT "ProvisionAction_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ProvisionRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProvisionException" ADD CONSTRAINT "ProvisionException_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ProvisionRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProvisionException" ADD CONSTRAINT "ProvisionException_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DriftFinding" ADD CONSTRAINT "DriftFinding_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ProvisionRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Row-level security. FORCE subjects the owning role to its own policies;
-- NULLIF is required because a GUC set with set_config(..., true) reverts to
-- an empty string, not NULL, when the transaction ends, and ''::uuid raises.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'TargetSystem','AccountProfile','BusinessRule','RuleEntitlement',
    'Entitlement','TargetAccount','AccountEntitlement','ProvisionRun',
    'ProvisionAction','ProvisionException','DriftFinding'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid) WITH CHECK ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid)',
      t);
  END LOOP;
END $$;

-- One profile per target is enforced by "AccountProfile_targetSystemId_key",
-- generated above from `@unique` on AccountProfile.targetSystemId, rather than
-- by a hand-written `account_profile_one_per_target` index here. Prisma refuses
-- a one-to-one relation whose defining side is not unique -- P1012, "A
-- one-to-one relation must use unique fields on the defining side" -- and
-- `TargetSystem.profile` is `AccountProfile?`, so the schema does not compile
-- without it. The generated index states exactly the same rule over exactly
-- the same NOT NULL column; a second one beside it would only cost a write.

-- PostgreSQL treats NULL as distinct from NULL, so a uniqueness rule that
-- involves a nullable column has to be a partial index or it constrains
-- nothing at all.

-- The anchor is unique within a target, but it is NULL for every `pending`
-- account, and PostgreSQL treats NULL as distinct from NULL. A plain
-- UNIQUE("tenantId","targetSystemId","anchor") would therefore permit two
-- accounts on the SAME anchor as long as it constrained nothing else, and
-- would not constrain the pending rows at all. Partial is the only version
-- that constrains what matters.
CREATE UNIQUE INDEX target_account_anchor_unique
  ON "TargetAccount" ("tenantId", "targetSystemId", "anchor")
  WHERE "anchor" IS NOT NULL;

-- A live holding is unique per (account, entitlement). Revoked rows stay for
-- history, so only the live ones are constrained -- same NULL reasoning.
CREATE UNIQUE INDEX account_entitlement_one_live
  ON "AccountEntitlement" ("accountId", "entitlementId")
  WHERE "revokedAt" IS NULL;

-- Spec section 10: "A target system has at most one run in a non-terminal
-- state." Enforced by the database rather than by the code that starts runs,
-- for the same reason the correlation key reservation is: two concurrent
-- starts are a race the database refuses, not one the application is trusted
-- to avoid. Two overlapping plans against one target can interleave a
-- revocation from the older behind a grant from the newer, producing a state
-- neither plan described and nobody approved.
CREATE UNIQUE INDEX provision_run_one_non_terminal
  ON "ProvisionRun" ("tenantId", "targetSystemId")
  WHERE "status" IN ('running', 'previewed', 'blocked', 'applying');

-- The ladder ordering, per spec section 9. Validated on save as well, because
-- a constraint violation is a 500 and a validation error is a message; this
-- is the backstop that makes the rule true of the data rather than true of
-- the one code path that happens to check it.
ALTER TABLE "TargetSystem" ADD CONSTRAINT target_system_ladder_order CHECK (
  "entitlementRevocationDelayDays" <= "disableGraceDays"
  AND ("archiveAfterDays" IS NULL OR "disableGraceDays" < "archiveAfterDays")
);

-- Percentages are percentages.
ALTER TABLE "TargetSystem" ADD CONSTRAINT target_system_thresholds_are_percent CHECK (
  "createAccountThresholdPercent"        BETWEEN 0 AND 100 AND
  "disableAccountThresholdPercent"       BETWEEN 0 AND 100 AND
  "archiveAccountThresholdPercent"       BETWEEN 0 AND 100 AND
  "revokeEntitlementThresholdPercent"    BETWEEN 0 AND 100 AND
  "deactivateSyntraUserThresholdPercent" BETWEEN 0 AND 100 AND
  "perEntitlementThresholdPercent"       BETWEEN 0 AND 100 AND
  "personPopulationDropPercent"          BETWEEN 0 AND 100
);

-- Writes to a target require an encrypted transport unconditionally. A
-- target that could be configured to write in the clear is a target that
-- eventually does, and Active Directory refuses a password write over an
-- unencrypted connection anyway.
-- The IS NOT NULL half is not redundant. `"config" ->> 'tlsMode'` yields SQL
-- NULL for a config object with no `tlsMode` key at all, `NULL IN (...)` is
-- NULL, and a CHECK constraint PASSES on NULL. Without it, the one config
-- shape that says nothing about its transport is the one shape this
-- constraint waves through.
ALTER TABLE "TargetSystem" ADD CONSTRAINT target_system_encrypted_transport CHECK (
  ("config" ->> 'tlsMode') IS NOT NULL
  AND ("config" ->> 'tlsMode') IN ('ldaps', 'starttls')
);
