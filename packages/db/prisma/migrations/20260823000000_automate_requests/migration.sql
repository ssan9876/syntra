-- AlterTable
ALTER TABLE "AccountEntitlement" ADD COLUMN     "grantedByRequestId" UUID;

-- AlterTable
ALTER TABLE "Entitlement" ADD COLUMN     "requestable" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "ProvisionAction" ADD COLUMN     "grantId" UUID;

-- CreateTable
CREATE TABLE "AutomateSettings" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "sweepSchedule" TEXT DEFAULT '0 2 * * *',
    "sweepThresholdPercent" INTEGER NOT NULL DEFAULT 10,
    "perProductSweepThresholdPercent" INTEGER NOT NULL DEFAULT 50,
    "personPopulationDropPercent" INTEGER NOT NULL DEFAULT 20,
    "fulfilmentSlaHours" INTEGER NOT NULL DEFAULT 24,
    "expiryWarningDays" INTEGER[] DEFAULT ARRAY[7, 1]::INTEGER[],
    "preHireHorizonDays" INTEGER NOT NULL DEFAULT 14,
    "maxDelegationDays" INTEGER NOT NULL DEFAULT 90,
    "maxApprovers" INTEGER NOT NULL DEFAULT 10,
    "delegatedBulkLimit" INTEGER NOT NULL DEFAULT 25,
    "lastAppliedSweepAt" TIMESTAMP(3),
    "personsWithActiveContractAtLastSweep" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomateSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "iconUrl" TEXT,
    "requestInstructions" TEXT,
    "kind" TEXT NOT NULL,
    "audienceCondition" JSONB,
    "workflowId" UUID NOT NULL,
    "formSchema" JSONB NOT NULL DEFAULT '[]',
    "durationMode" TEXT NOT NULL DEFAULT 'permanent',
    "defaultDurationDays" INTEGER,
    "maxDurationDays" INTEGER,
    "ownerPersonId" UUID,
    "ownerGroupId" UUID,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductGrant" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" UUID NOT NULL,
    "targetSystemId" UUID,
    "optional" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ProductGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalWorkflow" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApprovalWorkflow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalStage" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "workflowId" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "selector" TEXT NOT NULL,
    "selectorConfig" JSONB NOT NULL DEFAULT '{}',
    "quorum" TEXT NOT NULL DEFAULT 'any',
    "fallbackSelector" TEXT,
    "fallbackConfig" JSONB NOT NULL DEFAULT '{}',
    "slaHours" INTEGER NOT NULL DEFAULT 48,
    "onTimeout" TEXT NOT NULL DEFAULT 'remind',
    "escalationSelector" TEXT,
    "escalationConfig" JSONB NOT NULL DEFAULT '{}',
    "expiryHours" INTEGER,

    CONSTRAINT "ApprovalStage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccessRequest" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "productId" UUID,
    "subjectPersonId" UUID NOT NULL,
    "requestedByUserId" UUID NOT NULL,
    "requestedByPersonId" UUID,
    "origin" TEXT NOT NULL DEFAULT 'catalog',
    "resourceType" TEXT,
    "resourceId" UUID,
    "justification" TEXT,
    "formValues" JSONB NOT NULL DEFAULT '{}',
    "requestedDurationDays" INTEGER,
    "replacesGrantId" UUID,
    "status" TEXT NOT NULL DEFAULT 'pending_approval',
    "statusReason" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "fulfilledAt" TIMESTAMP(3),
    "dispatchedAt" TIMESTAMP(3),

    CONSTRAINT "AccessRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RequestItem" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" UUID NOT NULL,
    "targetSystemId" UUID,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "provisionActionId" UUID,
    "grantId" UUID,
    "message" TEXT,

    CONSTRAINT "RequestItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalStep" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "stageSnapshot" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'waiting',
    "openedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "slaDueAt" TIMESTAMP(3),
    "escalatedAt" TIMESTAMP(3),
    "lastRemindedAt" TIMESTAMP(3),

    CONSTRAINT "ApprovalStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalStepApprover" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "stepId" UUID NOT NULL,
    "personId" UUID NOT NULL,
    "via" TEXT NOT NULL,
    "onBehalfOfPersonId" UUID,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalStepApprover_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalDecision" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "stepId" UUID NOT NULL,
    "personId" UUID NOT NULL,
    "userId" UUID,
    "decision" TEXT NOT NULL,
    "comment" TEXT,
    "shortenedToDays" INTEGER,
    "via" TEXT NOT NULL,
    "onBehalfOfPersonId" UUID,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalDelegation" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "delegatorPersonId" UUID NOT NULL,
    "delegatePersonId" UUID NOT NULL,
    "category" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "createdByUserId" UUID,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalDelegation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccessGrant" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "subjectPersonId" UUID NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" UUID NOT NULL,
    "targetSystemId" UUID,
    "origin" TEXT NOT NULL DEFAULT 'request',
    "requestId" UUID,
    "productId" UUID,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'pending',
    "statusReason" TEXT,
    "needsReview" BOOLEAN NOT NULL DEFAULT false,
    "reviewReason" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "supersededByGrantId" UUID,
    "approvedByPersonId" UUID,
    "writtenRowIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "AccessGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResourceOwner" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" UUID NOT NULL,
    "ownerPersonId" UUID,
    "ownerGroupId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResourceOwner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResourceDelegation" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" UUID NOT NULL,
    "delegatePersonId" UUID,
    "delegateGroupId" UUID,
    "capabilities" TEXT[],
    "audienceCondition" JSONB,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "createdByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResourceDelegation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpirySweep" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "expireCount" INTEGER NOT NULL DEFAULT 0,
    "lapseCount" INTEGER NOT NULL DEFAULT 0,
    "reviewFlagCount" INTEGER NOT NULL DEFAULT 0,
    "personsWithActiveContract" INTEGER NOT NULL DEFAULT 0,
    "personsUnprocessable" INTEGER NOT NULL DEFAULT 0,
    "internalGrantsInTenant" INTEGER NOT NULL DEFAULT 0,
    "requiresConfirmation" BOOLEAN NOT NULL DEFAULT false,
    "blockedReason" TEXT,
    "confirmedByUserId" UUID,
    "error" TEXT,

    CONSTRAINT "ExpirySweep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SweepAction" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "sweepId" UUID NOT NULL,
    "grantId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "productId" UUID,
    "subjectPersonId" UUID NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" UUID NOT NULL,
    "targetSystemId" UUID,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "provisionActionId" UUID,
    "message" TEXT,

    CONSTRAINT "SweepAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SweepException" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "sweepId" UUID NOT NULL,
    "personId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SweepException_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationOutbox" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "template" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "vars" JSONB NOT NULL DEFAULT '{}',
    "requestId" UUID,
    "userId" UUID,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "sentAt" TIMESTAMP(3),
    "digest" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationPreference" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'immediate',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AutomateSettings_tenantId_key" ON "AutomateSettings"("tenantId");

-- CreateIndex
CREATE INDEX "AutomateSettings_tenantId_idx" ON "AutomateSettings"("tenantId");

-- CreateIndex
CREATE INDEX "Product_tenantId_idx" ON "Product"("tenantId");

-- CreateIndex
CREATE INDEX "Product_tenantId_status_idx" ON "Product"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Product_tenantId_slug_key" ON "Product"("tenantId", "slug");

-- CreateIndex
CREATE INDEX "ProductGrant_tenantId_idx" ON "ProductGrant"("tenantId");

-- CreateIndex
CREATE INDEX "ProductGrant_productId_idx" ON "ProductGrant"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductGrant_tenantId_productId_resourceType_resourceId_key" ON "ProductGrant"("tenantId", "productId", "resourceType", "resourceId");

-- CreateIndex
CREATE INDEX "ApprovalWorkflow_tenantId_idx" ON "ApprovalWorkflow"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalWorkflow_tenantId_name_key" ON "ApprovalWorkflow"("tenantId", "name");

-- CreateIndex
CREATE INDEX "ApprovalStage_tenantId_idx" ON "ApprovalStage"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalStage_workflowId_sequence_key" ON "ApprovalStage"("workflowId", "sequence");

-- CreateIndex
CREATE INDEX "AccessRequest_tenantId_idx" ON "AccessRequest"("tenantId");

-- CreateIndex
CREATE INDEX "AccessRequest_tenantId_status_idx" ON "AccessRequest"("tenantId", "status");

-- CreateIndex
CREATE INDEX "AccessRequest_tenantId_subjectPersonId_idx" ON "AccessRequest"("tenantId", "subjectPersonId");

-- CreateIndex
CREATE INDEX "RequestItem_tenantId_idx" ON "RequestItem"("tenantId");

-- CreateIndex
CREATE INDEX "RequestItem_tenantId_status_idx" ON "RequestItem"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "RequestItem_requestId_resourceType_resourceId_key" ON "RequestItem"("requestId", "resourceType", "resourceId");

-- CreateIndex
CREATE INDEX "ApprovalStep_tenantId_idx" ON "ApprovalStep"("tenantId");

-- CreateIndex
CREATE INDEX "ApprovalStep_tenantId_status_idx" ON "ApprovalStep"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalStep_requestId_sequence_key" ON "ApprovalStep"("requestId", "sequence");

-- CreateIndex
CREATE INDEX "ApprovalStepApprover_tenantId_idx" ON "ApprovalStepApprover"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalStepApprover_stepId_personId_key" ON "ApprovalStepApprover"("stepId", "personId");

-- CreateIndex
CREATE INDEX "ApprovalDecision_tenantId_idx" ON "ApprovalDecision"("tenantId");

-- CreateIndex
CREATE INDEX "ApprovalDecision_stepId_idx" ON "ApprovalDecision"("stepId");

-- CreateIndex
CREATE INDEX "ApprovalDelegation_tenantId_idx" ON "ApprovalDelegation"("tenantId");

-- CreateIndex
CREATE INDEX "ApprovalDelegation_tenantId_delegatorPersonId_idx" ON "ApprovalDelegation"("tenantId", "delegatorPersonId");

-- CreateIndex
CREATE INDEX "AccessGrant_tenantId_idx" ON "AccessGrant"("tenantId");

-- CreateIndex
CREATE INDEX "AccessGrant_tenantId_subjectPersonId_status_idx" ON "AccessGrant"("tenantId", "subjectPersonId", "status");

-- CreateIndex
CREATE INDEX "AccessGrant_tenantId_endsAt_idx" ON "AccessGrant"("tenantId", "endsAt");

-- CreateIndex
CREATE INDEX "AccessGrant_tenantId_productId_status_idx" ON "AccessGrant"("tenantId", "productId", "status");

-- CreateIndex
CREATE INDEX "ResourceOwner_tenantId_idx" ON "ResourceOwner"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ResourceOwner_tenantId_resourceType_resourceId_key" ON "ResourceOwner"("tenantId", "resourceType", "resourceId");

-- CreateIndex
CREATE INDEX "ResourceDelegation_tenantId_idx" ON "ResourceDelegation"("tenantId");

-- CreateIndex
CREATE INDEX "ResourceDelegation_tenantId_resourceType_resourceId_idx" ON "ResourceDelegation"("tenantId", "resourceType", "resourceId");

-- CreateIndex
CREATE INDEX "ExpirySweep_tenantId_idx" ON "ExpirySweep"("tenantId");

-- CreateIndex
CREATE INDEX "ExpirySweep_tenantId_startedAt_idx" ON "ExpirySweep"("tenantId", "startedAt");

-- CreateIndex
CREATE INDEX "SweepAction_sweepId_status_idx" ON "SweepAction"("sweepId", "status");

-- CreateIndex
CREATE INDEX "SweepAction_tenantId_idx" ON "SweepAction"("tenantId");

-- CreateIndex
CREATE INDEX "SweepException_tenantId_idx" ON "SweepException"("tenantId");

-- CreateIndex
CREATE INDEX "SweepException_sweepId_idx" ON "SweepException"("sweepId");

-- CreateIndex
CREATE INDEX "NotificationOutbox_tenantId_idx" ON "NotificationOutbox"("tenantId");

-- CreateIndex
CREATE INDEX "NotificationOutbox_tenantId_sentAt_createdAt_idx" ON "NotificationOutbox"("tenantId", "sentAt", "createdAt");

-- CreateIndex
CREATE INDEX "NotificationPreference_tenantId_idx" ON "NotificationPreference"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationPreference_userId_key" ON "NotificationPreference"("userId");

-- CreateIndex
CREATE INDEX "ProvisionAction_tenantId_grantId_idx" ON "ProvisionAction"("tenantId", "grantId");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "ApprovalWorkflow"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductGrant" ADD CONSTRAINT "ProductGrant_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalStage" ADD CONSTRAINT "ApprovalStage_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "ApprovalWorkflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessRequest" ADD CONSTRAINT "AccessRequest_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RequestItem" ADD CONSTRAINT "RequestItem_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "AccessRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalStep" ADD CONSTRAINT "ApprovalStep_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "AccessRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalStepApprover" ADD CONSTRAINT "ApprovalStepApprover_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "ApprovalStep"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalDecision" ADD CONSTRAINT "ApprovalDecision_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "ApprovalStep"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SweepAction" ADD CONSTRAINT "SweepAction_sweepId_fkey" FOREIGN KEY ("sweepId") REFERENCES "ExpirySweep"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SweepException" ADD CONSTRAINT "SweepException_sweepId_fkey" FOREIGN KEY ("sweepId") REFERENCES "ExpirySweep"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Row-level security. FORCE subjects the owning role to its own policies;
-- NULLIF is required because a GUC set with set_config(..., true) reverts to
-- an empty string, not NULL, when the transaction ends, and ''::uuid raises.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'AutomateSettings','Product','ProductGrant','ApprovalWorkflow','ApprovalStage',
    'AccessRequest','RequestItem','ApprovalStep','ApprovalStepApprover',
    'ApprovalDecision','ApprovalDelegation','AccessGrant','ResourceOwner',
    'ResourceDelegation','ExpirySweep','SweepAction','SweepException',
    'NotificationOutbox','NotificationPreference'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid) WITH CHECK ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid)',
      t);
  END LOOP;
END $$;

-- A person holds one LIVE grant of one resource at a time. `status` is NOT
-- NULL, but the rule is qualified by it, and a plain UNIQUE over the four
-- columns would forbid ever granting the same thing again after it expired --
-- which is exactly what an extension does. Partial is the only version that
-- says what is meant.
CREATE UNIQUE INDEX access_grant_one_live
  ON "AccessGrant" ("tenantId", "subjectPersonId", "resourceType", "resourceId")
  WHERE "status" IN ('scheduled', 'pending', 'active');

-- One sweep per tenant in a non-terminal state, for the reason Provision
-- gives for the same index on its runs: two overlapping plans can interleave
-- a removal from the older behind a grant from the newer, producing a state
-- neither plan described and nobody confirmed.
CREATE UNIQUE INDEX expiry_sweep_one_non_terminal
  ON "ExpirySweep" ("tenantId")
  WHERE "status" IN ('running', 'previewed', 'blocked', 'applying');

-- Percentages are percentages.
ALTER TABLE "AutomateSettings" ADD CONSTRAINT automate_settings_are_percent CHECK (
  "sweepThresholdPercent"           BETWEEN 0 AND 100 AND
  "perProductSweepThresholdPercent" BETWEEN 0 AND 100 AND
  "personPopulationDropPercent"     BETWEEN 0 AND 100
);

ALTER TABLE "AutomateSettings" ADD CONSTRAINT automate_settings_positive_limits CHECK (
  "fulfilmentSlaHours" > 0 AND
  "preHireHorizonDays" >= 0 AND
  "maxDelegationDays"  > 0 AND
  "maxApprovers"       > 0 AND
  "delegatedBulkLimit" > 0
);

ALTER TABLE "Product" ADD CONSTRAINT product_kind_is_known CHECK (
  "kind" IN ('targetEntitlement', 'application', 'localGroup')
);

ALTER TABLE "Product" ADD CONSTRAINT product_status_is_known CHECK (
  "status" IN ('draft', 'active', 'retired')
);

-- The duration rules, per spec section 12. `fixed` without a default runs
-- every grant for an unstated number of days; `requesterChoice` without a cap
-- is `permanent` with extra clicks.
ALTER TABLE "Product" ADD CONSTRAINT product_duration_is_coherent CHECK (
  "durationMode" IN ('permanent', 'fixed', 'requesterChoice')
  AND ("durationMode" <> 'fixed' OR "defaultDurationDays" IS NOT NULL)
  AND ("durationMode" <> 'requesterChoice' OR "maxDurationDays" IS NOT NULL)
  AND ("defaultDurationDays" IS NULL OR "maxDurationDays" IS NULL
       OR "defaultDurationDays" <= "maxDurationDays")
);

-- One owner, or none. Both at once has no defined meaning for the
-- productOwner selector and would make "who owns this" ambiguous.
ALTER TABLE "Product" ADD CONSTRAINT product_one_owner CHECK (
  NOT ("ownerPersonId" IS NOT NULL AND "ownerGroupId" IS NOT NULL)
);

ALTER TABLE "ProductGrant" ADD CONSTRAINT product_grant_resource_type CHECK (
  "resourceType" IN ('entitlement', 'application', 'group')
);

-- A target entitlement without a target cannot be routed to a Provision run,
-- and a target on anything else names a system the grant has nothing to do
-- with.
ALTER TABLE "ProductGrant" ADD CONSTRAINT product_grant_target_matches_type CHECK (
  ("resourceType" = 'entitlement') = ("targetSystemId" IS NOT NULL)
);

ALTER TABLE "ApprovalStage" ADD CONSTRAINT approval_stage_selector_is_known CHECK (
  "selector" IN ('manager','managerChain','productOwner','resourceOwner','role','group','person')
  AND ("fallbackSelector" IS NULL OR "fallbackSelector" IN
       ('manager','managerChain','productOwner','resourceOwner','role','group','person'))
  AND ("escalationSelector" IS NULL OR "escalationSelector" IN
       ('manager','managerChain','productOwner','resourceOwner','role','group','person'))
);

ALTER TABLE "ApprovalStage" ADD CONSTRAINT approval_stage_quorum_is_known CHECK (
  "quorum" IN ('any', 'all')
);

-- No timeout approves. The enum is the enforcement, and it is enforced in the
-- database so that adding a fourth value is a migration somebody has to write
-- rather than a string somebody can pass.
ALTER TABLE "ApprovalStage" ADD CONSTRAINT approval_stage_timeout_never_approves CHECK (
  "onTimeout" IN ('remind', 'escalate', 'expire')
  AND ("onTimeout" <> 'expire' OR "expiryHours" IS NOT NULL)
  AND ("onTimeout" <> 'escalate' OR "escalationSelector" IS NOT NULL)
  AND "slaHours" > 0
);

-- The three selectors that legitimately resolve to nobody must declare a
-- fallback. Validated at save time as well, because a constraint violation is
-- a 500 and a validation error is a message -- this is the backstop that
-- makes the rule true of the data.
ALTER TABLE "ApprovalStage" ADD CONSTRAINT approval_stage_fallback_required CHECK (
  "selector" NOT IN ('manager', 'managerChain', 'resourceOwner')
  OR "fallbackSelector" IS NOT NULL
);

-- A rejection requires a reason. Not a nicety: a refusal with no reason is an
-- unanswerable support call and a request the person will simply raise again.
ALTER TABLE "ApprovalDecision" ADD CONSTRAINT approval_decision_reject_has_comment CHECK (
  "decision" IN ('approve', 'reject')
  AND ("decision" <> 'reject' OR ("comment" IS NOT NULL AND btrim("comment") <> ''))
);

-- An approver may shorten a duration, never lengthen it, and never to zero.
ALTER TABLE "ApprovalDecision" ADD CONSTRAINT approval_decision_shortening_is_positive CHECK (
  "shortenedToDays" IS NULL OR "shortenedToDays" > 0
);

-- Append-only. The rules make tampering through the application impossible;
-- the audit chain makes tampering through direct database access detectable.
-- Neither substitutes for the other. TRUNCATE is not affected by rules, so
-- resetDatabase() still works.
CREATE RULE approval_decision_no_update AS ON UPDATE TO "ApprovalDecision" DO INSTEAD NOTHING;
CREATE RULE approval_decision_no_delete AS ON DELETE TO "ApprovalDecision" DO INSTEAD NOTHING;

ALTER TABLE "ApprovalDelegation" ADD CONSTRAINT approval_delegation_window CHECK (
  "endsAt" > "startsAt"
);

-- Delegation is not self-delegation. Depth 1 is enforced in code because it
-- needs a second row to see; this one needs only this row.
ALTER TABLE "ApprovalDelegation" ADD CONSTRAINT approval_delegation_not_self CHECK (
  "delegatorPersonId" <> "delegatePersonId"
);

ALTER TABLE "AccessGrant" ADD CONSTRAINT access_grant_status_is_known CHECK (
  "status" IN ('scheduled', 'pending', 'active', 'expired', 'lapsed', 'revoked')
);

ALTER TABLE "AccessGrant" ADD CONSTRAINT access_grant_window CHECK (
  "endsAt" IS NULL OR "endsAt" > "startsAt"
);

ALTER TABLE "AccessGrant" ADD CONSTRAINT access_grant_target_matches_type CHECK (
  ("resourceType" = 'entitlement') = ("targetSystemId" IS NOT NULL)
);

ALTER TABLE "ResourceOwner" ADD CONSTRAINT resource_owner_exactly_one CHECK (
  ("ownerPersonId" IS NOT NULL) <> ("ownerGroupId" IS NOT NULL)
);

ALTER TABLE "ResourceDelegation" ADD CONSTRAINT resource_delegation_exactly_one CHECK (
  ("delegatePersonId" IS NOT NULL) <> ("delegateGroupId" IS NOT NULL)
);

ALTER TABLE "ResourceDelegation" ADD CONSTRAINT resource_delegation_window CHECK (
  "endsAt" IS NULL OR "endsAt" > "startsAt"
);

-- Capabilities come from a closed set. An unknown capability string would be
-- silently ignored by every check, which reads as "denied" in some code paths
-- and "not checked" in others.
ALTER TABLE "ResourceDelegation" ADD CONSTRAINT resource_delegation_capabilities CHECK (
  "capabilities" <@ ARRAY['view_members','approve','grant','revoke']::text[]
  AND array_length("capabilities", 1) IS NOT NULL
);

ALTER TABLE "NotificationPreference" ADD CONSTRAINT notification_preference_mode CHECK (
  "mode" IN ('immediate', 'daily')
);
