-- AlterTable
ALTER TABLE "ProvisionAction" ADD COLUMN     "revocationOrderId" UUID;

-- CreateTable
CREATE TABLE "Campaign" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "scope" JSONB NOT NULL,
    "snapshotId" UUID NOT NULL,
    "rebasedFromSnapshotId" UUID,
    "reviewerSelector" TEXT NOT NULL,
    "reviewerConfig" JSONB NOT NULL DEFAULT '{}',
    "fallbackSelector" TEXT NOT NULL,
    "fallbackConfig" JSONB NOT NULL DEFAULT '{}',
    "ownerPersonId" UUID NOT NULL,
    "opensAt" TIMESTAMP(3) NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "originalDueAt" TIMESTAMP(3) NOT NULL,
    "extensionCount" INTEGER NOT NULL DEFAULT 0,
    "recurrence" TEXT,
    "allowBulkCertify" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "totalItems" INTEGER NOT NULL DEFAULT 0,
    "certifiedItems" INTEGER NOT NULL DEFAULT 0,
    "revokedItems" INTEGER NOT NULL DEFAULT 0,
    "mootItems" INTEGER NOT NULL DEFAULT 0,
    "undecidedItems" INTEGER NOT NULL DEFAULT 0,
    "blockedItems" INTEGER NOT NULL DEFAULT 0,
    "requiresChangeItems" INTEGER NOT NULL DEFAULT 0,
    "coveragePercent" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignItem" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "campaignId" UUID NOT NULL,
    "holdingSnapshotId" UUID NOT NULL,
    "subjectKey" TEXT NOT NULL,
    "personId" UUID,
    "accountRef" TEXT,
    "systemId" TEXT NOT NULL,
    "resourceKind" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "resourceName" TEXT NOT NULL,
    "attributions" JSONB NOT NULL DEFAULT '[]',
    "observedAt" TIMESTAMP(3) NOT NULL,
    "coverageStatus" TEXT NOT NULL,
    "riskFlags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'pending',
    "statusReason" TEXT,
    "outcomeRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignItemReviewer" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "personId" UUID NOT NULL,
    "via" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unassignedAt" TIMESTAMP(3),
    "unassignedReason" TEXT,
    "lastRemindedAt" TIMESTAMP(3),
    "openedAt" TIMESTAMP(3),

    CONSTRAINT "CampaignItemReviewer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignDecision" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "personId" UUID NOT NULL,
    "decidedByUserId" UUID,
    "decision" TEXT NOT NULL,
    "comment" TEXT,
    "itemOpenedAt" TIMESTAMP(3) NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "neverOpened" BOOLEAN NOT NULL DEFAULT false,
    "viaBulk" BOOLEAN NOT NULL DEFAULT false,
    "bulkSize" INTEGER,
    "sessionDecisionOrdinal" INTEGER NOT NULL,
    "coverageAtDecision" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "CampaignDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewQualitySignal" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "campaignId" UUID NOT NULL,
    "personId" UUID NOT NULL,
    "itemsAssigned" INTEGER NOT NULL,
    "itemsDecided" INTEGER NOT NULL,
    "certifiedShare" DOUBLE PRECISION NOT NULL,
    "medianIntervalMs" INTEGER NOT NULL,
    "bulkShare" DOUBLE PRECISION NOT NULL,
    "largestBurst" INTEGER NOT NULL,
    "largestBurstMs" INTEGER NOT NULL DEFAULT 0,
    "neverOpenedShare" DOUBLE PRECISION NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewQualitySignal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RevocationBatch" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "campaignId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'computing',
    "proposedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "dispatchedCount" INTEGER NOT NULL DEFAULT 0,
    "confirmedCount" INTEGER NOT NULL DEFAULT 0,
    "appliedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "requiresChangeCount" INTEGER NOT NULL DEFAULT 0,
    "cancelledCount" INTEGER NOT NULL DEFAULT 0,
    "requiresConfirmation" BOOLEAN NOT NULL DEFAULT false,
    "blockedReason" TEXT,
    "confirmedByUserId" UUID,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "RevocationBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RevocationDispatch" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "itemId" UUID,
    "holdingDescriptor" JSONB NOT NULL,
    "route" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "grantId" UUID,
    "revocationOrderId" UUID,
    "remediationItemId" UUID,
    "message" TEXT,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "dispatchedAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "appliedAt" TIMESTAMP(3),

    CONSTRAINT "RevocationDispatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RevocationOrder" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "targetSystemId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "entitlementId" UUID NOT NULL,
    "decidedByPersonId" UUID NOT NULL,
    "campaignDecisionId" UUID,
    "decidedByPersonName" TEXT NOT NULL,
    "campaignName" TEXT,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "cancelledReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "plannedAt" TIMESTAMP(3),
    "appliedAt" TIMESTAMP(3),

    CONSTRAINT "RevocationOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessFunction" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "ownerPersonId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessFunction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessFunctionResource" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "functionId" UUID NOT NULL,
    "systemId" TEXT NOT NULL,
    "resourceKind" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,

    CONSTRAINT "BusinessFunctionResource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SodRule" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "functionAId" UUID NOT NULL,
    "functionBId" UUID NOT NULL,
    "severity" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "exceptionWorkflowId" UUID,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SodRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SodViolation" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "ruleId" UUID NOT NULL,
    "personId" UUID NOT NULL,
    "holdingsA" JSONB NOT NULL,
    "holdingsB" JSONB NOT NULL,
    "contractsA" JSONB NOT NULL DEFAULT '[]',
    "contractsB" JSONB NOT NULL DEFAULT '[]',
    "severity" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "exceptionId" UUID,
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSnapshotId" UUID NOT NULL,

    CONSTRAINT "SodViolation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SodException" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "ruleId" UUID NOT NULL,
    "personId" UUID NOT NULL,
    "violationId" UUID NOT NULL,
    "justification" TEXT NOT NULL,
    "compensatingControl" TEXT NOT NULL,
    "basisContractIds" JSONB,
    "approvalRequestId" UUID,
    "approvedByPersonId" UUID,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "revokedReason" TEXT,
    "revokedByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SodException_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Campaign_tenantId_idx" ON "Campaign"("tenantId");

-- CreateIndex
CREATE INDEX "Campaign_tenantId_status_idx" ON "Campaign"("tenantId", "status");

-- CreateIndex
CREATE INDEX "CampaignItem_campaignId_status_idx" ON "CampaignItem"("campaignId", "status");

-- CreateIndex
CREATE INDEX "CampaignItem_campaignId_personId_idx" ON "CampaignItem"("campaignId", "personId");

-- CreateIndex
CREATE INDEX "CampaignItem_tenantId_idx" ON "CampaignItem"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignItem_campaignId_subjectKey_systemId_resourceKind_re_key" ON "CampaignItem"("campaignId", "subjectKey", "systemId", "resourceKind", "resourceId");

-- CreateIndex
CREATE INDEX "CampaignItemReviewer_tenantId_idx" ON "CampaignItemReviewer"("tenantId");

-- CreateIndex
CREATE INDEX "CampaignItemReviewer_itemId_unassignedAt_idx" ON "CampaignItemReviewer"("itemId", "unassignedAt");

-- CreateIndex
CREATE INDEX "CampaignItemReviewer_tenantId_personId_unassignedAt_idx" ON "CampaignItemReviewer"("tenantId", "personId", "unassignedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignItemReviewer_itemId_personId_assignedAt_key" ON "CampaignItemReviewer"("itemId", "personId", "assignedAt");

-- CreateIndex
CREATE INDEX "CampaignDecision_tenantId_idx" ON "CampaignDecision"("tenantId");

-- CreateIndex
CREATE INDEX "CampaignDecision_itemId_idx" ON "CampaignDecision"("itemId");

-- CreateIndex
CREATE INDEX "CampaignDecision_tenantId_personId_decidedAt_idx" ON "CampaignDecision"("tenantId", "personId", "decidedAt");

-- CreateIndex
CREATE INDEX "ReviewQualitySignal_tenantId_idx" ON "ReviewQualitySignal"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewQualitySignal_campaignId_personId_key" ON "ReviewQualitySignal"("campaignId", "personId");

-- CreateIndex
CREATE INDEX "RevocationBatch_tenantId_idx" ON "RevocationBatch"("tenantId");

-- CreateIndex
CREATE INDEX "RevocationBatch_tenantId_status_idx" ON "RevocationBatch"("tenantId", "status");

-- CreateIndex
CREATE INDEX "RevocationDispatch_batchId_status_idx" ON "RevocationDispatch"("batchId", "status");

-- CreateIndex
CREATE INDEX "RevocationDispatch_batchId_sequence_idx" ON "RevocationDispatch"("batchId", "sequence");

-- CreateIndex
CREATE INDEX "RevocationDispatch_tenantId_idx" ON "RevocationDispatch"("tenantId");

-- CreateIndex
CREATE INDEX "RevocationOrder_tenantId_idx" ON "RevocationOrder"("tenantId");

-- CreateIndex
CREATE INDEX "RevocationOrder_tenantId_status_idx" ON "RevocationOrder"("tenantId", "status");

-- CreateIndex
CREATE INDEX "BusinessFunction_tenantId_idx" ON "BusinessFunction"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessFunction_tenantId_name_key" ON "BusinessFunction"("tenantId", "name");

-- CreateIndex
CREATE INDEX "BusinessFunctionResource_tenantId_idx" ON "BusinessFunctionResource"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessFunctionResource_tenantId_functionId_systemId_resou_key" ON "BusinessFunctionResource"("tenantId", "functionId", "systemId", "resourceKind", "resourceId");

-- CreateIndex
CREATE INDEX "SodRule_tenantId_idx" ON "SodRule"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "SodRule_tenantId_name_key" ON "SodRule"("tenantId", "name");

-- CreateIndex
CREATE INDEX "SodViolation_tenantId_idx" ON "SodViolation"("tenantId");

-- CreateIndex
CREATE INDEX "SodViolation_tenantId_status_severity_idx" ON "SodViolation"("tenantId", "status", "severity");

-- CreateIndex
CREATE UNIQUE INDEX "SodViolation_tenantId_ruleId_personId_key" ON "SodViolation"("tenantId", "ruleId", "personId");

-- CreateIndex
CREATE INDEX "SodException_tenantId_idx" ON "SodException"("tenantId");

-- CreateIndex
CREATE INDEX "SodException_tenantId_status_endsAt_idx" ON "SodException"("tenantId", "status", "endsAt");

-- CreateIndex
CREATE INDEX "ApprovalDecision_tenantId_decidedAt_idx" ON "ApprovalDecision"("tenantId", "decidedAt");

-- AddForeignKey
ALTER TABLE "CampaignItem" ADD CONSTRAINT "CampaignItem_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignItemReviewer" ADD CONSTRAINT "CampaignItemReviewer_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "CampaignItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignDecision" ADD CONSTRAINT "CampaignDecision_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "CampaignItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewQualitySignal" ADD CONSTRAINT "ReviewQualitySignal_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RevocationBatch" ADD CONSTRAINT "RevocationBatch_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RevocationDispatch" ADD CONSTRAINT "RevocationDispatch_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "RevocationBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessFunctionResource" ADD CONSTRAINT "BusinessFunctionResource_functionId_fkey" FOREIGN KEY ("functionId") REFERENCES "BusinessFunction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SodRule" ADD CONSTRAINT "SodRule_functionAId_fkey" FOREIGN KEY ("functionAId") REFERENCES "BusinessFunction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SodRule" ADD CONSTRAINT "SodRule_functionBId_fkey" FOREIGN KEY ("functionBId") REFERENCES "BusinessFunction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SodViolation" ADD CONSTRAINT "SodViolation_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "SodRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SodException" ADD CONSTRAINT "SodException_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "SodRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SodException" ADD CONSTRAINT "SodException_violationId_fkey" FOREIGN KEY ("violationId") REFERENCES "SodViolation"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Closed vocabularies and the invariants the code must not be able to forget.
-- ---------------------------------------------------------------------------

ALTER TABLE "Campaign" ADD CONSTRAINT campaign_status CHECK (
  "status" IN ('draft','generating','open','executing','closed_complete','closed_incomplete','cancelled'));

-- The due date can move, and moving it is an act. It can never move BACKWARDS
-- past the original, which would rewrite how long reviewers actually had.
ALTER TABLE "Campaign" ADD CONSTRAINT campaign_due_not_before_original CHECK (
  "dueAt" >= "originalDueAt");

-- THERE IS NO STATUS THAT MEANS "CERTIFIED BECAUSE TIME RAN OUT".
ALTER TABLE "CampaignItem" ADD CONSTRAINT campaign_item_status CHECK (
  "status" IN ('pending','certified','revoke_decided','revocation_dispatched',
               'revocation_confirmed','revocation_applied','revocation_requires_change',
               'revocation_failed','undecided','moot','blocked_no_reviewer'));

ALTER TABLE "CampaignItem" ADD CONSTRAINT campaign_item_subject_key_agrees CHECK (
  ("personId" IS NOT NULL AND "accountRef" IS NULL
     AND "subjectKey" = 'person:' || "personId"::text)
  OR
  ("personId" IS NULL AND "accountRef" IS NOT NULL
     AND "subjectKey" = 'account:' || "systemId" || ':' || "accountRef"));

ALTER TABLE "CampaignDecision" ADD CONSTRAINT campaign_decision_kind CHECK (
  "decision" IN ('certify','revoke'));
-- A bulk decision names its size. A `viaBulk` with no size cannot be reported.
ALTER TABLE "CampaignDecision" ADD CONSTRAINT campaign_decision_bulk_has_size CHECK (
  "viaBulk" = false OR "bulkSize" IS NOT NULL);
-- Revoking is one at a time, with a comment. There is no bulk revoke at all.
ALTER TABLE "CampaignDecision" ADD CONSTRAINT campaign_decision_revoke_needs_comment CHECK (
  "decision" <> 'revoke' OR ("comment" IS NOT NULL AND length(btrim("comment")) > 0));
ALTER TABLE "CampaignDecision" ADD CONSTRAINT campaign_decision_revoke_is_not_bulk CHECK (
  "decision" <> 'revoke' OR "viaBulk" = false);

ALTER TABLE "CampaignItemReviewer" ADD CONSTRAINT campaign_item_reviewer_via CHECK (
  "via" IN ('selector','fallback','escalation','reassignment'));

ALTER TABLE "RevocationBatch" ADD CONSTRAINT revocation_batch_status CHECK (
  "status" IN ('computing','previewed','blocked','applying','applied',
               'partially_applied','failed','superseded'));
ALTER TABLE "RevocationBatch" ADD CONSTRAINT revocation_batch_blocked_names_reason CHECK (
  "status" <> 'blocked' OR "blockedReason" IS NOT NULL);

ALTER TABLE "RevocationDispatch" ADD CONSTRAINT revocation_dispatch_status CHECK (
  "status" IN ('proposed','skipped','dispatched','confirmed','applied','failed',
               'requires_change','cancelled'));
-- The vocabulary rule, in SQL. `applied` requires BOTH a confirmation and a
-- subsequent observation, and a dispatch that reached `applied` with no
-- `confirmedAt` behind it would be a report claiming an outcome it never had.
ALTER TABLE "RevocationDispatch" ADD CONSTRAINT revocation_dispatch_applied_was_confirmed CHECK (
  "status" <> 'applied' OR ("confirmedAt" IS NOT NULL AND "appliedAt" IS NOT NULL));
ALTER TABLE "RevocationDispatch" ADD CONSTRAINT revocation_dispatch_requires_change_has_item CHECK (
  "status" <> 'requires_change' OR "remediationItemId" IS NOT NULL);

ALTER TABLE "RevocationOrder" ADD CONSTRAINT revocation_order_status CHECK (
  "status" IN ('open','planned','applied','cancelled'));
ALTER TABLE "RevocationOrder" ADD CONSTRAINT revocation_order_cancelled_names_reason CHECK (
  "status" <> 'cancelled' OR "cancelledReason" IS NOT NULL);
-- An order with no named human is indistinguishable from the inference the
-- remit rule forbids. Enforced rather than remembered.
ALTER TABLE "RevocationOrder" ADD CONSTRAINT revocation_order_names_a_human CHECK (
  length(btrim("decidedByPersonName")) > 0 AND length(btrim("reason")) > 0);

-- A rule may not name the same function twice. Validated at save as well; this
-- is the backstop that makes it true of the data.
ALTER TABLE "SodRule" ADD CONSTRAINT sod_rule_functions_differ CHECK (
  "functionAId" <> "functionBId");
ALTER TABLE "SodRule" ADD CONSTRAINT sod_rule_severity CHECK (
  "severity" IN ('low','medium','high','critical'));
ALTER TABLE "SodRule" ADD CONSTRAINT sod_rule_rationale_not_blank CHECK (
  length(btrim("rationale")) > 0);

ALTER TABLE "SodViolation" ADD CONSTRAINT sod_violation_status CHECK (
  "status" IN ('open','excepted','resolved','unevaluable'));

ALTER TABLE "SodException" ADD CONSTRAINT sod_exception_status CHECK (
  "status" IN ('pending','active','refused','blocked_no_approver','lapsed','revoked'));
ALTER TABLE "SodException" ADD CONSTRAINT sod_exception_ends_after_it_starts CHECK (
  "endsAt" > "startsAt");
ALTER TABLE "SodException" ADD CONSTRAINT sod_exception_justified CHECK (
  length(btrim("justification")) > 0 AND length(btrim("compensatingControl")) > 0);

-- ---------------------------------------------------------------------------
-- Partial unique indexes, each with its escape hatch in the SAME TASK that
-- writes it. A "one non-terminal row per X" constraint with no adoption path is
-- how a crashed process permanently bricks a tenant, and this programme has
-- shipped that shape twice.
-- ---------------------------------------------------------------------------

-- One non-terminal batch per campaign. Superseded by `computeRevocationBatch`
-- at the head of the transaction that creates the new one.
CREATE UNIQUE INDEX govern_revocation_batch_one_non_terminal_campaign
  ON "RevocationBatch" ("tenantId", "campaignId")
  WHERE "status" IN ('computing', 'previewed', 'blocked', 'applying');

-- There is NO second index for standalone batches. `RevocationBatch.campaignId`
-- is NOT NULL, because nothing in this plan ever created a batch without a
-- campaign: the remedy for a refused or lapsed exception is a
-- `RemediationItem`, and nothing is revoked when an exception lapses. An index
-- guarding a population no code path produces is a control that cannot fire.

-- One live order per holding, so a holding cannot carry two contradictory
-- instructions. Superseded by `createRevocationOrder`, which cancels an
-- existing open order for the same holding before creating a new one.
CREATE UNIQUE INDEX govern_revocation_order_one_open
  ON "RevocationOrder" ("tenantId", "targetSystemId", "accountId", "entitlementId")
  WHERE "status" = 'open';

-- Append-only. A reversal is a new decision with its own reason.
CREATE RULE govern_decision_no_update AS ON UPDATE TO "CampaignDecision" DO INSTEAD NOTHING;
CREATE RULE govern_decision_no_delete AS ON DELETE TO "CampaignDecision" DO INSTEAD NOTHING;

-- Row-level security.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'Campaign','CampaignItem','CampaignItemReviewer','CampaignDecision',
    'ReviewQualitySignal','RevocationBatch','RevocationDispatch','RevocationOrder',
    'BusinessFunction','BusinessFunctionResource','SodRule','SodViolation','SodException'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid) WITH CHECK ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid)',
      t);
  END LOOP;
END $$;
