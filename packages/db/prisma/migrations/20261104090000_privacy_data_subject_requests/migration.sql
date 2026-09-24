-- Data-subject requests (backlog #70): the case table, the person's
-- restriction and erasure markers, the access bundle as an export kind, and
-- the permission that governs all of it.

-- ---- Person: restriction and erasure markers ------------------------------

ALTER TABLE "Person"
  ADD COLUMN "processingRestrictedAt" TIMESTAMP(3),
  ADD COLUMN "processingRestrictedCaseId" UUID,
  ADD COLUMN "erasedAt" TIMESTAMP(3),
  ADD COLUMN "erasedCaseId" UUID;

-- A restriction names the case that placed it, and an erasure the case that
-- performed it. Either half without the other is a marker nobody can explain.
ALTER TABLE "Person"
  ADD CONSTRAINT "Person_restriction_attributed" CHECK (
    ("processingRestrictedAt" IS NULL) = ("processingRestrictedCaseId" IS NULL)
  ),
  ADD CONSTRAINT "Person_erasure_attributed" CHECK (
    ("erasedAt" IS NULL) = ("erasedCaseId" IS NULL)
  );

-- ---- The case --------------------------------------------------------------

CREATE TABLE "PrivacyCase" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "personId" UUID NOT NULL,
  "reference" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'open',
  "requestTypes" TEXT[],
  "reason" TEXT NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL,
  "dueAt" TIMESTAMP(3) NOT NULL,
  "verificationMethod" TEXT NOT NULL,
  "verificationAttestation" TEXT NOT NULL,
  "verifiedByUserId" UUID NOT NULL,
  "openedByUserId" UUID NOT NULL,
  "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "accessExportId" UUID,
  "erasureStatus" TEXT,
  "erasureRequestedByUserId" UUID,
  "erasureRequestedAt" TIMESTAMP(3),
  "erasureApprovedByUserId" UUID,
  "erasureApprovedAt" TIMESTAMP(3),
  "erasureApproverStepUpAt" TIMESTAMP(3),
  "erasureCompletedAt" TIMESTAMP(3),
  "erasureCancelledByUserId" UUID,
  "erasureCancelledAt" TIMESTAMP(3),
  "erasureReceipt" JSONB,
  "closedAt" TIMESTAMP(3),
  "closedByUserId" UUID,
  "closureNote" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PrivacyCase_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PrivacyCase_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PrivacyCase_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "PrivacyCase_status_known" CHECK ("status" IN ('open', 'closed')),
  CONSTRAINT "PrivacyCase_request_types_known" CHECK (
    cardinality("requestTypes") > 0
    AND "requestTypes" <@ ARRAY['access', 'rectification', 'restriction', 'erasure']::TEXT[]
  ),
  CONSTRAINT "PrivacyCase_verification_method_known" CHECK (
    "verificationMethod" IN ('in_person', 'known_channel', 'document', 'authenticated_session', 'other')
  ),
  -- An identity verification nobody described is not one.
  CONSTRAINT "PrivacyCase_attestation_present" CHECK (char_length(btrim("verificationAttestation")) >= 10),
  CONSTRAINT "PrivacyCase_reason_present" CHECK (char_length(btrim("reason")) >= 10),
  CONSTRAINT "PrivacyCase_due_after_receipt" CHECK ("dueAt" > "receivedAt"),
  CONSTRAINT "PrivacyCase_closed_attributed" CHECK (
    ("status" = 'closed') = ("closedAt" IS NOT NULL AND "closedByUserId" IS NOT NULL)
  ),
  CONSTRAINT "PrivacyCase_erasure_status_known" CHECK (
    "erasureStatus" IS NULL OR "erasureStatus" IN ('pending_approval', 'completed', 'cancelled')
  ),
  CONSTRAINT "PrivacyCase_erasure_requested" CHECK (
    "erasureStatus" IS NULL
    OR ("erasureRequestedByUserId" IS NOT NULL AND "erasureRequestedAt" IS NOT NULL)
  ),
  -- Four eyes, enforced where no code path can forget it.
  CONSTRAINT "PrivacyCase_erasure_four_eyes" CHECK (
    "erasureApprovedByUserId" IS NULL OR "erasureApprovedByUserId" <> "erasureRequestedByUserId"
  ),
  -- A completed erasure carries its approver, its step-up evidence and its
  -- receipt; nothing else may carry an approval.
  CONSTRAINT "PrivacyCase_erasure_completed" CHECK (
    ("erasureStatus" = 'completed') = (
      "erasureApprovedByUserId" IS NOT NULL AND "erasureApprovedAt" IS NOT NULL
      AND "erasureApproverStepUpAt" IS NOT NULL AND "erasureCompletedAt" IS NOT NULL
      AND "erasureReceipt" IS NOT NULL
    )
  ),
  CONSTRAINT "PrivacyCase_erasure_cancelled" CHECK (
    ("erasureStatus" = 'cancelled') = ("erasureCancelledByUserId" IS NOT NULL AND "erasureCancelledAt" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "PrivacyCase_tenantId_reference_key" ON "PrivacyCase"("tenantId", "reference");
CREATE INDEX "PrivacyCase_tenantId_status_dueAt_idx" ON "PrivacyCase"("tenantId", "status", "dueAt");
CREATE INDEX "PrivacyCase_tenantId_personId_idx" ON "PrivacyCase"("tenantId", "personId");

-- One erasure awaiting approval per person. Two would be two authorisations
-- for one irreversible act.
CREATE UNIQUE INDEX "PrivacyCase_one_pending_erasure_per_person"
  ON "PrivacyCase"("tenantId", "personId")
  WHERE "erasureStatus" = 'pending_approval';

ALTER TABLE "PrivacyCase" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PrivacyCase" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PrivacyCase"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- ---- The access bundle is an export ----------------------------------------

ALTER TABLE "DataExport" DROP CONSTRAINT "DataExport_kind_known";
-- Every kind that exists, not just this migration's: the support bundle
-- (20261103101500) widened this same constraint first, and replacing it with
-- a list that omits it would make every support-bundle request fail.
ALTER TABLE "DataExport" ADD CONSTRAINT "DataExport_kind_known"
  CHECK ("kind" IN ('audit_log', 'govern_access', 'support_bundle', 'dsar_bundle'));
ALTER TABLE "DataExport" DROP CONSTRAINT "DataExport_format_known";
ALTER TABLE "DataExport" ADD CONSTRAINT "DataExport_format_known"
  CHECK ("format" IN ('jsonl', 'csv', 'json'));

-- ---- `privacy.manage` reaches deployments that already exist ---------------
--
-- Role.permissions is a stored snapshot of the catalogue written once by the
-- seed (see 20260907000000_directory_delete_backfill for the failure this
-- prevents). Granted to built-in roles that already hold `tenant.manage`:
-- that is the administrator who can already export and erase the whole
-- tenant, so handling one person's request adds no authority they lacked. A
-- role somebody wrote by hand is left as its author chose.
DO $$
DECLARE
  t       record;
  granted integer;
  total   integer := 0;
BEGIN
  FOR t IN SELECT id FROM "Tenant" LOOP
    PERFORM set_config('app.current_tenant', t.id::text, true);

    UPDATE "Role"
       SET permissions = array_append(permissions, 'privacy.manage')
     WHERE "builtIn"
       AND 'tenant.manage' = ANY(permissions)
       AND NOT ('privacy.manage' = ANY(permissions));

    GET DIAGNOSTICS granted = ROW_COUNT;
    total := total + granted;
  END LOOP;

  RAISE NOTICE 'privacy.manage granted to % built-in role(s)', total;
END $$;
