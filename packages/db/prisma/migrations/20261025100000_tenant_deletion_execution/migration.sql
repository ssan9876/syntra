-- Revision-bound, four-eyes tenant deletion.
--
-- Two pieces. The request table is the durable state machine and, once
-- completed, the deletion receipt. The binding function is the fence that
-- makes "no tenant rows remain" true under concurrency rather than only at
-- the instant the erasure commits.

CREATE TABLE "TenantDeletionRequest" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending_approval',
  "assessmentDigest" TEXT NOT NULL,
  "assessmentAuditEventId" UUID NOT NULL,
  "exportDigest" TEXT NOT NULL,
  "exportAuditEventId" UUID NOT NULL,
  "dataRevision" TEXT NOT NULL,
  "reason" TEXT,
  "requestedByUserId" UUID NOT NULL,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "approvalExpiresAt" TIMESTAMP(3) NOT NULL,
  "approvedByUserId" UUID,
  "approvedAt" TIMESTAMP(3),
  "approverStepUpAt" TIMESTAMP(3),
  "executeNotBefore" TIMESTAMP(3),
  "executeBefore" TIMESTAMP(3),
  "executedByUserId" UUID,
  "executorStepUpAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "cancelledByUserId" UUID,
  "cancelledAt" TIMESTAMP(3),
  "closedReason" TEXT,
  "receipt" JSONB,

  CONSTRAINT "TenantDeletionRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TenantDeletionRequest_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TenantDeletionRequest_status_check" CHECK ("status" IN (
    'pending_approval', 'approved', 'executing', 'completed', 'cancelled', 'expired', 'invalidated'
  )),
  CONSTRAINT "TenantDeletionRequest_digests_check" CHECK (
    "assessmentDigest" ~ '^[a-f0-9]{64}$' AND "exportDigest" ~ '^[a-f0-9]{64}$' AND "dataRevision" ~ '^[a-f0-9]{64}$'
  ),
  -- Four eyes, enforced where no code path can forget it.
  CONSTRAINT "TenantDeletionRequest_four_eyes" CHECK (
    "approvedByUserId" IS NULL OR "approvedByUserId" <> "requestedByUserId"
  ),
  -- Approval evidence is all-or-nothing: an approver without a time, or a
  -- time without a step-up, is a partial record that proves nothing.
  CONSTRAINT "TenantDeletionRequest_approval_complete" CHECK (
    ("approvedByUserId" IS NULL AND "approvedAt" IS NULL AND "approverStepUpAt" IS NULL
      AND "executeNotBefore" IS NULL AND "executeBefore" IS NULL)
    OR
    ("approvedByUserId" IS NOT NULL AND "approvedAt" IS NOT NULL AND "approverStepUpAt" IS NOT NULL
      AND "executeNotBefore" IS NOT NULL AND "executeBefore" IS NOT NULL AND "executeBefore" > "executeNotBefore")
  ),
  CONSTRAINT "TenantDeletionRequest_approved_states" CHECK (
    "status" NOT IN ('approved', 'executing', 'completed') OR "approvedByUserId" IS NOT NULL
  ),
  -- A completed request is the receipt: it must carry its counts, and it must
  -- no longer carry the free text a person typed.
  CONSTRAINT "TenantDeletionRequest_completed_receipt" CHECK (
    "status" <> 'completed'
    OR ("receipt" IS NOT NULL AND "completedAt" IS NOT NULL AND "executedByUserId" IS NOT NULL AND "reason" IS NULL)
  )
);

CREATE INDEX "TenantDeletionRequest_tenantId_status_idx" ON "TenantDeletionRequest"("tenantId", "status");

-- One open request per tenant. Two approved requests would be two
-- authorisations for one irreversible act, and the second is never needed.
CREATE UNIQUE INDEX "TenantDeletionRequest_one_open"
  ON "TenantDeletionRequest"("tenantId")
  WHERE "status" IN ('pending_approval', 'approved', 'executing');

ALTER TABLE "TenantDeletionRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TenantDeletionRequest" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "TenantDeletionRequest"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- Binds a transaction to a tenant, and fences it against that tenant's
-- erasure.
--
-- `withTenant` used to issue `set_config` alone. That was enough while a
-- tenant could only ever exist, but an erasure has a race a single DELETE
-- cannot close: a job or request whose transaction began before the erasure
-- committed still resolves the tenant row -- the tombstone keeps its id, so
-- every foreign key still holds -- and writes a fresh row into a tenant that
-- no longer exists. Nothing afterwards would ever remove it.
--
-- So every tenant-bound transaction takes a SHARED advisory lock on the
-- tenant, and the erasure takes it EXCLUSIVELY. The erasure waits for every
-- transaction already bound; every transaction that binds after it waits for
-- the erasure and then reads the tombstone. Advisory locks live in shared
-- memory, not on the Tenant row, so the shared acquisition costs no heap
-- write on a row every request touches.
--
-- The status is read AFTER the lock, in its own statement. A VOLATILE
-- plpgsql function takes a fresh snapshot per statement under READ
-- COMMITTED; a single SQL statement would have taken its snapshot before
-- waiting and read 'active' from before the erasure.
--
-- The two-key form keeps these locks out of the single-key space
-- `recordEvent` uses for the audit chain (1398362708 is 'SYNT').
CREATE FUNCTION syntra_bind_tenant(p_tenant UUID, p_exclusive BOOLEAN DEFAULT FALSE)
RETURNS TEXT
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  tenant_status TEXT;
BEGIN
  PERFORM set_config('app.current_tenant', p_tenant::text, true);
  IF p_exclusive THEN
    PERFORM pg_advisory_xact_lock(1398362708, hashtext(p_tenant::text));
  ELSE
    PERFORM pg_advisory_xact_lock_shared(1398362708, hashtext(p_tenant::text));
  END IF;
  SELECT "status" INTO tenant_status FROM "Tenant" WHERE "id" = p_tenant;
  RETURN tenant_status;
END;
$$;

-- Row-level security for the two lifecycle tables created without it.
--
-- "LifecycleLegalHold" and "LifecycleCaseEvent" were created with a tenant
-- foreign key and no policy, so `tx.lifecycleLegalHold.count({ where: {
-- releasedAt: null } })` inside `withTenant` counted EVERY tenant's holds.
-- That was a disclosure before this migration; with a deletion gate built on
-- that count it would also let one tenant's litigation hold refuse another
-- tenant's erasure, and the preflight would be reasoning about rows that are
-- not the tenant's at all. Guarded so a parallel fix of the same gap cannot
-- make either migration fail.
ALTER TABLE "LifecycleLegalHold" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LifecycleLegalHold" FORCE ROW LEVEL SECURITY;
ALTER TABLE "LifecycleCaseEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LifecycleCaseEvent" FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'LifecycleLegalHold' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY tenant_isolation ON "LifecycleLegalHold"
      USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
      WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'LifecycleCaseEvent' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY tenant_isolation ON "LifecycleCaseEvent"
      USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
      WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
  END IF;
END $$;
