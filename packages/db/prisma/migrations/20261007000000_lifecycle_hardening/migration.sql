-- Lifecycle pilot hardening: approvals, service levels, append-only attempt
-- history, a per-tenant policy row, persisted no-write simulations, and the
-- entitlement flags a connector reports (manageable / dynamic / privileged).

ALTER TABLE "LifecycleOperation"
  ADD COLUMN "approvalRequired" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "approvalReason" TEXT,
  ADD COLUMN "requestedByUserId" UUID,
  ADD COLUMN "approvedAt" TIMESTAMP(3),
  ADD COLUMN "approvedByUserId" UUID,
  ADD COLUMN "rejectedAt" TIMESTAMP(3),
  ADD COLUMN "rejectedByUserId" UUID,
  ADD COLUMN "rejectionReason" TEXT,
  ADD COLUMN "sloMinutes" INTEGER,
  ADD COLUMN "sloDeadlineAt" TIMESTAMP(3),
  ADD COLUMN "sloBreachedAt" TIMESTAMP(3),
  ADD COLUMN "escalatedAt" TIMESTAMP(3),
  ADD COLUMN "escalatedToUserId" UUID;
CREATE INDEX "LifecycleOperation_tenantId_sloDeadlineAt_status_idx" ON "LifecycleOperation"("tenantId", "sloDeadlineAt", "status");

ALTER TABLE "LifecycleStep" ADD COLUMN "responseCategory" TEXT;

CREATE TABLE "LifecycleStepAttempt" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL REFERENCES "Tenant"("id") ON DELETE CASCADE,
  "operationId" UUID NOT NULL REFERENCES "LifecycleOperation"("id") ON DELETE CASCADE,
  "stepId" UUID NOT NULL REFERENCES "LifecycleStep"("id") ON DELETE CASCADE,
  "stepKey" TEXT NOT NULL,
  "attempt" INTEGER NOT NULL,
  "status" TEXT NOT NULL,
  "message" TEXT,
  "evidence" JSONB,
  "responseCategory" TEXT,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "LifecycleStepAttempt_tenantId_operationId_attempt_idx" ON "LifecycleStepAttempt"("tenantId", "operationId", "attempt");
CREATE INDEX "LifecycleStepAttempt_tenantId_stepId_recordedAt_idx" ON "LifecycleStepAttempt"("tenantId", "stepId", "recordedAt");

CREATE TABLE "LifecyclePolicy" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL REFERENCES "Tenant"("id") ON DELETE CASCADE,
  "requireApprovalForAccountCreation" BOOLEAN NOT NULL DEFAULT false,
  "requireApprovalForPrivilegedGroups" BOOLEAN NOT NULL DEFAULT true,
  "privilegedGroupPatterns" TEXT[] NOT NULL DEFAULT ARRAY['admin', 'privileged', 'domain admins', 'global admin']::TEXT[],
  "requireApprovalForUrgentDeparture" BOOLEAN NOT NULL DEFAULT false,
  "requireApprovalForBulkRequeue" BOOLEAN NOT NULL DEFAULT true,
  "bulkRequeueThreshold" INTEGER NOT NULL DEFAULT 10,
  "urgentLeaverSloMinutes" INTEGER NOT NULL DEFAULT 15,
  "onboardSloHours" INTEGER NOT NULL DEFAULT 24,
  "moveSloHours" INTEGER NOT NULL DEFAULT 24,
  "offboardSloHours" INTEGER NOT NULL DEFAULT 24,
  "escalationOwnerUserId" UUID,
  "notifyOnFailure" BOOLEAN NOT NULL DEFAULT true,
  "notifyOnOverdue" BOOLEAN NOT NULL DEFAULT true,
  "notifyOnAccessBlocked" BOOLEAN NOT NULL DEFAULT true,
  "receiptRetentionDays" INTEGER NOT NULL DEFAULT 365,
  "observationRetentionDays" INTEGER NOT NULL DEFAULT 90,
  "notificationRetentionDays" INTEGER NOT NULL DEFAULT 180,
  "simulationRetentionDays" INTEGER NOT NULL DEFAULT 30,
  "auditRetentionDays" INTEGER,
  "updatedByUserId" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "LifecyclePolicy_tenantId_key" ON "LifecyclePolicy"("tenantId");

CREATE TABLE "LifecycleSimulation" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL REFERENCES "Tenant"("id") ON DELETE CASCADE,
  "kind" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "personId" UUID,
  "department" TEXT,
  "input" JSONB NOT NULL DEFAULT '{}',
  "result" JSONB NOT NULL,
  "peopleCount" INTEGER NOT NULL DEFAULT 0,
  "writesPerformed" BOOLEAN NOT NULL DEFAULT false,
  "createdByUserId" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3)
);
CREATE INDEX "LifecycleSimulation_tenantId_createdAt_idx" ON "LifecycleSimulation"("tenantId", "createdAt");
CREATE INDEX "LifecycleSimulation_tenantId_expiresAt_idx" ON "LifecycleSimulation"("tenantId", "expiresAt");

ALTER TABLE "Entitlement"
  ADD COLUMN "manageable" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "unmanageableReason" TEXT,
  ADD COLUMN "membershipKind" TEXT,
  ADD COLUMN "privileged" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "LifecycleStepAttempt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LifecycleStepAttempt" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "LifecycleStepAttempt" USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid) WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
ALTER TABLE "LifecyclePolicy" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LifecyclePolicy" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "LifecyclePolicy" USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid) WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
ALTER TABLE "LifecycleSimulation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LifecycleSimulation" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "LifecycleSimulation" USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid) WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
