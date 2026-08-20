-- CreateTable
CREATE TABLE "GovernSettings" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "snapshotSchedule" TEXT DEFAULT '0 1 * * *',
    "snapshotRetentionDays" INTEGER NOT NULL DEFAULT 400,
    "defaultFreshnessSlaHours" INTEGER NOT NULL DEFAULT 24,
    "maxSnapshotAgeDays" INTEGER NOT NULL DEFAULT 30,
    "batchThresholdPercent" INTEGER NOT NULL DEFAULT 10,
    "perResourceThresholdPercent" INTEGER NOT NULL DEFAULT 30,
    "personPopulationDropPercent" INTEGER NOT NULL DEFAULT 20,
    "minimumCoveragePercent" INTEGER NOT NULL DEFAULT 90,
    "bulkCertifyLimit" INTEGER NOT NULL DEFAULT 50,
    "dispatchSlaHours" INTEGER NOT NULL DEFAULT 72,
    "privilegedRecertifyDays" INTEGER NOT NULL DEFAULT 90,
    "maxExceptionDays" INTEGER NOT NULL DEFAULT 90,
    "exceptionWarningDays" INTEGER[] DEFAULT ARRAY[14, 3]::INTEGER[],
    "minReciprocalDecisions" INTEGER NOT NULL DEFAULT 3,
    "reciprocityWindowDays" INTEGER NOT NULL DEFAULT 180,
    "lastAppliedBatchAt" TIMESTAMP(3),
    "personsWithActiveContractAtLastBatch" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GovernSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GovernSourcePolicy" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "freshnessSlaHours" INTEGER NOT NULL DEFAULT 24,
    "inDefaultScope" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GovernSourcePolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResourceClassification" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "systemId" TEXT NOT NULL,
    "resourceKind" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "privileged" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "setByUserId" UUID,
    "setAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResourceClassification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccessSnapshot" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'building',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "asOf" TIMESTAMP(3) NOT NULL,
    "scope" JSONB,
    "holdingCount" INTEGER NOT NULL DEFAULT 0,
    "unattributableCount" INTEGER NOT NULL DEFAULT 0,
    "coverageGapCount" INTEGER NOT NULL DEFAULT 0,
    "unattributedAccountCount" INTEGER NOT NULL DEFAULT 0,
    "personCount" INTEGER NOT NULL DEFAULT 0,
    "personsWithActiveContract" INTEGER NOT NULL DEFAULT 0,
    "countsByResourceKind" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,

    CONSTRAINT "AccessSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SnapshotSource" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "snapshotId" UUID NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "sourceName" TEXT NOT NULL,
    "lastRunId" UUID,
    "lastSuccessfulReadAt" TIMESTAMP(3),
    "lastAttemptedReadAt" TIMESTAMP(3),
    "completeness" TEXT NOT NULL,
    "staleness" TEXT NOT NULL,
    "freshnessSlaHours" INTEGER NOT NULL,
    "gapCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "SnapshotSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Holding" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "snapshotId" UUID NOT NULL,
    "subjectKey" TEXT NOT NULL,
    "personId" UUID,
    "accountRef" TEXT,
    "systemKind" TEXT NOT NULL,
    "systemId" TEXT NOT NULL,
    "resourceKind" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "resourceName" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'held',
    "privileged" BOOLEAN NOT NULL DEFAULT false,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "observedVia" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "attributionCount" INTEGER NOT NULL DEFAULT 0,
    "unattributable" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Holding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HoldingAttribution" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "holdingId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "refType" TEXT NOT NULL,
    "refId" TEXT,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "resolvedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HoldingAttribution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoverageGap" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "snapshotId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "systemKind" TEXT,
    "systemId" TEXT,
    "resourceId" TEXT,
    "personId" UUID,
    "accountRef" TEXT,
    "reason" TEXT NOT NULL,
    "sourceRunId" UUID,

    CONSTRAINT "CoverageGap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HoldingEvent" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "fromSnapshotId" UUID NOT NULL,
    "toSnapshotId" UUID NOT NULL,
    "subjectKey" TEXT NOT NULL,
    "personId" UUID,
    "accountRef" TEXT,
    "systemId" TEXT NOT NULL,
    "resourceKind" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "resourceName" TEXT NOT NULL,
    "change" TEXT NOT NULL,
    "beforeAttributions" JSONB NOT NULL DEFAULT '[]',
    "afterAttributions" JSONB NOT NULL DEFAULT '[]',
    "auditEventSequence" INTEGER,
    "explained" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "HoldingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HoldingCertification" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "subjectRefType" TEXT NOT NULL,
    "subjectRefId" TEXT NOT NULL,
    "systemId" TEXT NOT NULL,
    "resourceKind" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "lastCertifiedAt" TIMESTAMP(3) NOT NULL,
    "lastCertifiedByPersonId" UUID NOT NULL,
    "lastCampaignId" UUID NOT NULL,
    "lastDecisionId" UUID NOT NULL,

    CONSTRAINT "HoldingCertification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountAttribution" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "systemId" TEXT NOT NULL,
    "accountRef" TEXT NOT NULL,
    "proposedPersonId" UUID NOT NULL,
    "method" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "decidedByUserId" UUID,
    "decidedAt" TIMESTAMP(3),
    "decidedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountAttribution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GovernFinding" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "subjectRefType" TEXT NOT NULL,
    "subjectRefId" TEXT NOT NULL,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "driftFindingId" UUID,
    "status" TEXT NOT NULL DEFAULT 'open',
    "ownerPersonId" UUID,
    "dueAt" TIMESTAMP(3),
    "acceptedReason" TEXT,
    "acceptedUntil" TIMESTAMP(3),
    "resolvedBySnapshotId" UUID,
    "resolvedAt" TIMESTAMP(3),
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GovernFinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RemediationItem" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "ownerPersonId" UUID NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "findingId" UUID,
    "campaignItemId" UUID,
    "description" TEXT NOT NULL,
    "deepLink" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "resolutionComment" TEXT,
    "resolvedByUserId" UUID,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RemediationItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvidencePack" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "scope" JSONB NOT NULL DEFAULT '{}',
    "snapshotId" UUID,
    "campaignId" UUID,
    "chainHeadSequence" INTEGER NOT NULL,
    "chainHeadHash" TEXT NOT NULL,
    "chainVerificationResult" TEXT NOT NULL,
    "chainFromSequence" INTEGER NOT NULL,
    "chainToSequence" INTEGER NOT NULL,
    "digest" TEXT NOT NULL,
    "storageRef" TEXT,
    "byteLength" INTEGER NOT NULL,
    "createdByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvidencePack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditCheckpoint" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "hash" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "signature" TEXT,
    "keyId" TEXT,

    CONSTRAINT "AuditCheckpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditChainCheck" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "fromSequence" INTEGER NOT NULL,
    "toSequence" INTEGER NOT NULL,
    "result" TEXT NOT NULL,
    "brokenAtSequence" INTEGER,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "durationMs" INTEGER NOT NULL,
    "mode" TEXT NOT NULL,

    CONSTRAINT "AuditChainCheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditAnchor" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "hash" TEXT NOT NULL,
    "anchoredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "method" TEXT NOT NULL,
    "receipt" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,

    CONSTRAINT "AuditAnchor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GovernSettings_tenantId_key" ON "GovernSettings"("tenantId");

-- CreateIndex
CREATE INDEX "GovernSettings_tenantId_idx" ON "GovernSettings"("tenantId");

-- CreateIndex
CREATE INDEX "GovernSourcePolicy_tenantId_idx" ON "GovernSourcePolicy"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "GovernSourcePolicy_tenantId_sourceKind_sourceId_key" ON "GovernSourcePolicy"("tenantId", "sourceKind", "sourceId");

-- CreateIndex
CREATE INDEX "ResourceClassification_tenantId_idx" ON "ResourceClassification"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ResourceClassification_tenantId_systemId_resourceKind_resou_key" ON "ResourceClassification"("tenantId", "systemId", "resourceKind", "resourceId");

-- CreateIndex
CREATE INDEX "AccessSnapshot_tenantId_idx" ON "AccessSnapshot"("tenantId");

-- CreateIndex
CREATE INDEX "AccessSnapshot_tenantId_status_asOf_idx" ON "AccessSnapshot"("tenantId", "status", "asOf");

-- CreateIndex
CREATE INDEX "SnapshotSource_tenantId_idx" ON "SnapshotSource"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "SnapshotSource_snapshotId_sourceKind_sourceId_key" ON "SnapshotSource"("snapshotId", "sourceKind", "sourceId");

-- CreateIndex
CREATE INDEX "Holding_tenantId_snapshotId_personId_idx" ON "Holding"("tenantId", "snapshotId", "personId");

-- CreateIndex
CREATE INDEX "Holding_tenantId_snapshotId_systemId_resourceId_idx" ON "Holding"("tenantId", "snapshotId", "systemId", "resourceId");

-- CreateIndex
CREATE UNIQUE INDEX "Holding_snapshotId_subjectKey_systemId_resourceKind_resourc_key" ON "Holding"("snapshotId", "subjectKey", "systemId", "resourceKind", "resourceId");

-- CreateIndex
CREATE INDEX "HoldingAttribution_tenantId_idx" ON "HoldingAttribution"("tenantId");

-- CreateIndex
CREATE INDEX "HoldingAttribution_holdingId_idx" ON "HoldingAttribution"("holdingId");

-- CreateIndex
CREATE INDEX "CoverageGap_tenantId_idx" ON "CoverageGap"("tenantId");

-- CreateIndex
CREATE INDEX "CoverageGap_snapshotId_kind_idx" ON "CoverageGap"("snapshotId", "kind");

-- CreateIndex
CREATE INDEX "HoldingEvent_tenantId_toSnapshotId_idx" ON "HoldingEvent"("tenantId", "toSnapshotId");

-- CreateIndex
CREATE INDEX "HoldingEvent_tenantId_personId_toSnapshotId_idx" ON "HoldingEvent"("tenantId", "personId", "toSnapshotId");

-- CreateIndex
CREATE INDEX "HoldingCertification_tenantId_idx" ON "HoldingCertification"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "HoldingCertification_tenantId_subjectRefType_subjectRefId_s_key" ON "HoldingCertification"("tenantId", "subjectRefType", "subjectRefId", "systemId", "resourceKind", "resourceId");

-- CreateIndex
CREATE INDEX "AccountAttribution_tenantId_idx" ON "AccountAttribution"("tenantId");

-- CreateIndex
CREATE INDEX "AccountAttribution_tenantId_status_idx" ON "AccountAttribution"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AccountAttribution_tenantId_systemId_accountRef_proposedPer_key" ON "AccountAttribution"("tenantId", "systemId", "accountRef", "proposedPersonId");

-- CreateIndex
CREATE INDEX "GovernFinding_tenantId_idx" ON "GovernFinding"("tenantId");

-- CreateIndex
CREATE INDEX "GovernFinding_tenantId_status_severity_idx" ON "GovernFinding"("tenantId", "status", "severity");

-- CreateIndex
CREATE UNIQUE INDEX "GovernFinding_tenantId_kind_subjectRefType_subjectRefId_key" ON "GovernFinding"("tenantId", "kind", "subjectRefType", "subjectRefId");

-- CreateIndex
CREATE INDEX "RemediationItem_tenantId_idx" ON "RemediationItem"("tenantId");

-- CreateIndex
CREATE INDEX "RemediationItem_tenantId_status_dueAt_idx" ON "RemediationItem"("tenantId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "RemediationItem_tenantId_ownerPersonId_status_idx" ON "RemediationItem"("tenantId", "ownerPersonId", "status");

-- CreateIndex
CREATE INDEX "EvidencePack_tenantId_idx" ON "EvidencePack"("tenantId");

-- CreateIndex
CREATE INDEX "EvidencePack_tenantId_kind_createdAt_idx" ON "EvidencePack"("tenantId", "kind", "createdAt");

-- CreateIndex
CREATE INDEX "AuditCheckpoint_tenantId_idx" ON "AuditCheckpoint"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "AuditCheckpoint_tenantId_sequence_key" ON "AuditCheckpoint"("tenantId", "sequence");

-- CreateIndex
CREATE INDEX "AuditChainCheck_tenantId_idx" ON "AuditChainCheck"("tenantId");

-- CreateIndex
CREATE INDEX "AuditChainCheck_tenantId_startedAt_idx" ON "AuditChainCheck"("tenantId", "startedAt");

-- CreateIndex
CREATE INDEX "AuditAnchor_tenantId_idx" ON "AuditAnchor"("tenantId");

-- CreateIndex
CREATE INDEX "AuditAnchor_tenantId_sequence_idx" ON "AuditAnchor"("tenantId", "sequence");

-- AddForeignKey
ALTER TABLE "SnapshotSource" ADD CONSTRAINT "SnapshotSource_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "AccessSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Holding" ADD CONSTRAINT "Holding_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "AccessSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HoldingAttribution" ADD CONSTRAINT "HoldingAttribution_holdingId_fkey" FOREIGN KEY ("holdingId") REFERENCES "Holding"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoverageGap" ADD CONSTRAINT "CoverageGap_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "AccessSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RemediationItem" ADD CONSTRAINT "RemediationItem_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "GovernFinding"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Closed vocabularies. Every one of these mirrors a union in
-- packages/core/src/govern/types.ts exactly; if one moves, both move.
-- ---------------------------------------------------------------------------

-- `not_held` is never a row. Spec section 6. A two-valued Govern takes an
-- unreadable group's 1500 readable members, finds nothing for the other 2500,
-- and prints "1500 people hold Domain Admins" under a heading that says the
-- report is complete.
ALTER TABLE "Holding" ADD CONSTRAINT holding_state_is_held_or_unknown
  CHECK ("state" IN ('held', 'unknown'));

ALTER TABLE "Holding" ADD CONSTRAINT holding_resource_kind CHECK (
  "resourceKind" IN ('targetEntitlement','targetAccount','syntraGroup',
                     'application','syntraRole','syntraUser'));

ALTER TABLE "Holding" ADD CONSTRAINT holding_system_kind CHECK (
  "systemKind" IN ('targetSystem','syntraInternal','directorySource'));

-- A subject is a person or an account, never both and never neither, and the
-- key spells out which. Without this, a row with both null is addressable only
-- by its own id and appears in no report.
ALTER TABLE "Holding" ADD CONSTRAINT holding_subject_key_agrees CHECK (
  ("personId" IS NOT NULL AND "accountRef" IS NULL
     AND "subjectKey" = 'person:' || "personId"::text)
  OR
  ("personId" IS NULL AND "accountRef" IS NOT NULL
     AND "subjectKey" = 'account:' || "systemId" || ':' || "accountRef")
);

ALTER TABLE "HoldingAttribution" ADD CONSTRAINT holding_attribution_kind CHECK (
  "kind" IN ('business_rule','request','delegated_admin','auto_granted',
             'direct_assignment','group_inheritance','org_unit_inheritance',
             'directory_source','discovered','manual','unattributable'));

ALTER TABLE "CoverageGap" ADD CONSTRAINT coverage_gap_kind CHECK (
  "kind" IN ('source_unread','source_stale','resource_unreadable',
             'account_unreadable','subject_unresolvable','person_unprocessable'));

ALTER TABLE "HoldingEvent" ADD CONSTRAINT holding_event_change CHECK (
  "change" IN ('gained','lost','attribution_changed','became_unknown','became_known'));

ALTER TABLE "SnapshotSource" ADD CONSTRAINT snapshot_source_completeness CHECK (
  "completeness" IN ('complete','partial','unread'));
ALTER TABLE "SnapshotSource" ADD CONSTRAINT snapshot_source_staleness CHECK (
  "staleness" IN ('fresh','stale'));

ALTER TABLE "AccessSnapshot" ADD CONSTRAINT access_snapshot_status CHECK (
  "status" IN ('building','complete','failed'));
ALTER TABLE "AccessSnapshot" ADD CONSTRAINT access_snapshot_kind CHECK (
  "kind" IN ('scheduled','manual','campaign'));

ALTER TABLE "GovernFinding" ADD CONSTRAINT govern_finding_status CHECK (
  "status" IN ('open','acknowledged','accepted','resolved'));
ALTER TABLE "GovernFinding" ADD CONSTRAINT govern_finding_severity CHECK (
  "severity" IN ('low','medium','high','critical'));

-- Acceptance with no expiry is not representable. A perpetual acceptance is a
-- decision nobody ever re-makes, and after two years nobody remembers who made
-- it or why.
ALTER TABLE "GovernFinding" ADD CONSTRAINT govern_finding_accepted_needs_expiry CHECK (
  "status" <> 'accepted'
  OR ("acceptedUntil" IS NOT NULL AND "acceptedReason" IS NOT NULL));

-- A resolved finding names the snapshot that showed it gone. "It went away and
-- we do not know why" is itself worth a row, and this is what makes it one.
--
-- `audit_chain_broken` is the ONE exemption, and it is exempt because it is not
-- a snapshot finding in either direction: no snapshot build raises it, and no
-- snapshot build can show it gone. It is raised by `verifyIncremental` (Task 10)
-- and closed by `verifyIncremental`, from an `AuditChainCheck` row written in
-- the same run. Without the exemption the only kind that CANNOT name a snapshot
-- would be the only kind that could never be resolved — a `critical` integrity
-- alarm that no clean verification could ever clear, which is the trap Ruling
-- G-12 refused. The exemption is written as an equality on one literal kind and
-- not as a general escape, so every other kind still names its snapshot.
ALTER TABLE "GovernFinding" ADD CONSTRAINT govern_finding_resolved_names_snapshot CHECK (
  "status" <> 'resolved'
  OR "resolvedBySnapshotId" IS NOT NULL
  OR "kind" = 'audit_chain_broken');

ALTER TABLE "RemediationItem" ADD CONSTRAINT remediation_item_status CHECK (
  "status" IN ('open','in_progress','done','wont_fix'));
ALTER TABLE "RemediationItem" ADD CONSTRAINT remediation_item_kind CHECK (
  "kind" IN ('rule_change_required','directory_source_change_required',
             'direct_assignment_change_required','role_assignment_change_required',
             'account_removal_required','syntra_user_change_required',
             'undecided_item','orphan_attribution'));

ALTER TABLE "AccountAttribution" ADD CONSTRAINT account_attribution_status CHECK (
  "status" IN ('proposed','confirmed','denied'));
ALTER TABLE "AccountAttribution" ADD CONSTRAINT account_attribution_confidence CHECK (
  "confidence" >= 0 AND "confidence" <= 1);

ALTER TABLE "AuditChainCheck" ADD CONSTRAINT audit_chain_check_result CHECK (
  "result" IN ('valid','broken'));
-- `full_fallback` is a full walk from genesis that an INCREMENTAL run had to
-- fall back to, because the checkpoint it would have seeded from does not carry
-- a valid signature. It is a distinct value from `full` so the integrity screen
-- can say which happened: an operator asking for a full verification and a
-- nightly run refusing a checkpoint are different events.
ALTER TABLE "AuditChainCheck" ADD CONSTRAINT audit_chain_check_mode CHECK (
  "mode" IN ('incremental','full','full_fallback'));
-- A broken result names the sequence. A break with no sequence is an alert
-- nobody can act on.
ALTER TABLE "AuditChainCheck" ADD CONSTRAINT audit_chain_check_broken_names_sequence CHECK (
  "result" <> 'broken' OR "brokenAtSequence" IS NOT NULL);

ALTER TABLE "AuditAnchor" ADD CONSTRAINT audit_anchor_method CHECK (
  "method" IN ('file','mail'));

-- Percentages are percentages. Validated on save as well, because a
-- constraint violation is a 500 and a validation error is a message; this is
-- the backstop that makes the rule true of the data rather than true of the
-- one code path that happens to check it.
ALTER TABLE "GovernSettings" ADD CONSTRAINT govern_settings_thresholds_are_percent CHECK (
  "batchThresholdPercent"       BETWEEN 0 AND 100 AND
  "perResourceThresholdPercent" BETWEEN 0 AND 100 AND
  "personPopulationDropPercent" BETWEEN 0 AND 100 AND
  "minimumCoveragePercent"      BETWEEN 0 AND 100
);

-- ---------------------------------------------------------------------------
-- Partial unique indexes. A plain UNIQUE over a nullable or status-qualified
-- column constrains nothing in PostgreSQL, so every one of these is written by
-- hand rather than declared with @@unique.
-- ---------------------------------------------------------------------------

-- One build at a time per tenant. Two concurrent builds would each write half
-- a picture into two snapshots and neither would say so.
--
-- THE ESCAPE HATCH IS IN THE SAME TASK, in snapshot-service.ts's
-- `beginSnapshot`: a `building` snapshot older than SNAPSHOT_STALL_MINUTES is
-- marked `failed` with error 'superseded by a later build' at the head of the
-- transaction that creates the new one. A one-non-terminal-row index with no
-- adoption path is how a crashed process permanently bricks a tenant, and this
-- programme has shipped that shape twice.
CREATE UNIQUE INDEX govern_snapshot_one_building
  ON "AccessSnapshot" ("tenantId")
  WHERE "status" = 'building';

-- Many candidates may be proposed for one orphan; exactly one may be confirmed.
CREATE UNIQUE INDEX account_attribution_one_confirmed
  ON "AccountAttribution" ("tenantId", "systemId", "accountRef")
  WHERE "status" = 'confirmed';

-- One live remediation item per finding and per campaign item, so a nightly
-- snapshot that re-observes the same problem chases it once rather than
-- creating a new row every night. Two indexes rather than one because
-- `findingId` and `campaignItemId` are both nullable and a single index over
-- both would constrain neither.
CREATE UNIQUE INDEX remediation_item_one_open_per_finding
  ON "RemediationItem" ("tenantId", "kind", "findingId")
  WHERE "findingId" IS NOT NULL AND "status" IN ('open', 'in_progress');

CREATE UNIQUE INDEX remediation_item_one_open_per_campaign_item
  ON "RemediationItem" ("tenantId", "kind", "campaignItemId")
  WHERE "campaignItemId" IS NOT NULL AND "status" IN ('open', 'in_progress');

-- The unattributable register is read as its own list, above the totals rather
-- than below them, so it gets its own partial index rather than sharing the
-- person index and filtering.
CREATE INDEX holding_unattributable_idx
  ON "Holding" ("tenantId", "snapshotId")
  WHERE "unattributable" = true;

-- ---------------------------------------------------------------------------
-- Append-only. The same RULE pair the audit log uses in
-- 20260814235217_audit/migration.sql. A checkpoint that can be rewritten is a
-- checkpoint that proves nothing.
-- ---------------------------------------------------------------------------
CREATE RULE govern_checkpoint_no_update AS ON UPDATE TO "AuditCheckpoint" DO INSTEAD NOTHING;
CREATE RULE govern_checkpoint_no_delete AS ON DELETE TO "AuditCheckpoint" DO INSTEAD NOTHING;

-- ---------------------------------------------------------------------------
-- Row-level security. FORCE subjects the owning role to its own policies;
-- NULLIF is required because a GUC set with set_config(..., true) reverts to
-- an empty string, not NULL, when the transaction ends, and ''::uuid raises.
--
-- This matters more here than anywhere else in the product: `Holding` is a
-- denormalized copy of who can reach what, across every system, for a whole
-- organization, and a cross-tenant read of it is the worst single disclosure
-- this platform could produce.
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'GovernSettings','GovernSourcePolicy','ResourceClassification',
    'AccessSnapshot','SnapshotSource','Holding','HoldingAttribution',
    'CoverageGap','HoldingEvent','HoldingCertification','AccountAttribution',
    'GovernFinding','RemediationItem','EvidencePack',
    'AuditCheckpoint','AuditChainCheck','AuditAnchor'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid) WITH CHECK ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid)',
      t);
  END LOOP;
END $$;
