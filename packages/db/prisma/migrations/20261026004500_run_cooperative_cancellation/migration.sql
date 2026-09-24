-- Cooperative cancellation for directory sync runs, HR person imports and
-- provisioning runs.
--
-- `cancelState` is a column beside `status`, not a new status: a run asked to
-- stop is still running until one of its checkpoints observes the request, and
-- the status has to keep saying what the worker is doing. The honoured request
-- ends the run in status `cancelled`; the three tables carry `status` as free
-- text, so that value needs no DDL of its own.
--
-- The tables already have FORCE ROW LEVEL SECURITY with a tenant_isolation
-- policy; adding columns changes neither.

ALTER TABLE "SyncRun"
  ADD COLUMN "cancelState" TEXT,
  ADD COLUMN "cancelRequestedAt" TIMESTAMP(3),
  ADD COLUMN "cancelRequestedByUserId" UUID,
  ADD COLUMN "cancelResolvedAt" TIMESTAMP(3);

ALTER TABLE "PersonImportRun"
  ADD COLUMN "cancelState" TEXT,
  ADD COLUMN "cancelRequestedAt" TIMESTAMP(3),
  ADD COLUMN "cancelRequestedByUserId" UUID,
  ADD COLUMN "cancelResolvedAt" TIMESTAMP(3);

ALTER TABLE "ProvisionRun"
  ADD COLUMN "cancelState" TEXT,
  ADD COLUMN "cancelRequestedAt" TIMESTAMP(3),
  ADD COLUMN "cancelRequestedByUserId" UUID,
  ADD COLUMN "cancelResolvedAt" TIMESTAMP(3);

-- The vocabulary, and the evidence each state must carry. A request with no
-- time on it cannot be ordered against the checkpoint that honoured it, and a
-- resolved request with no resolution time cannot say which came first.
ALTER TABLE "SyncRun" ADD CONSTRAINT "SyncRun_cancel_state_valid" CHECK (
  ("cancelState" IS NULL AND "cancelRequestedAt" IS NULL AND "cancelResolvedAt" IS NULL)
  OR ("cancelState" = 'requested' AND "cancelRequestedAt" IS NOT NULL AND "cancelResolvedAt" IS NULL)
  OR ("cancelState" IN ('cancelled', 'moot') AND "cancelRequestedAt" IS NOT NULL AND "cancelResolvedAt" IS NOT NULL)
);
ALTER TABLE "PersonImportRun" ADD CONSTRAINT "PersonImportRun_cancel_state_valid" CHECK (
  ("cancelState" IS NULL AND "cancelRequestedAt" IS NULL AND "cancelResolvedAt" IS NULL)
  OR ("cancelState" = 'requested' AND "cancelRequestedAt" IS NOT NULL AND "cancelResolvedAt" IS NULL)
  OR ("cancelState" IN ('cancelled', 'moot') AND "cancelRequestedAt" IS NOT NULL AND "cancelResolvedAt" IS NOT NULL)
);
ALTER TABLE "ProvisionRun" ADD CONSTRAINT "ProvisionRun_cancel_state_valid" CHECK (
  ("cancelState" IS NULL AND "cancelRequestedAt" IS NULL AND "cancelResolvedAt" IS NULL)
  OR ("cancelState" = 'requested' AND "cancelRequestedAt" IS NOT NULL AND "cancelResolvedAt" IS NULL)
  OR ("cancelState" IN ('cancelled', 'moot') AND "cancelRequestedAt" IS NOT NULL AND "cancelResolvedAt" IS NOT NULL)
);

-- An honoured request is the ONLY way into status `cancelled`, so the status
-- can never claim a cancellation the evidence columns do not record.
ALTER TABLE "SyncRun" ADD CONSTRAINT "SyncRun_cancelled_has_request" CHECK (
  "status" <> 'cancelled' OR "cancelState" = 'cancelled'
);
ALTER TABLE "PersonImportRun" ADD CONSTRAINT "PersonImportRun_cancelled_has_request" CHECK (
  "status" <> 'cancelled' OR "cancelState" = 'cancelled'
);
ALTER TABLE "ProvisionRun" ADD CONSTRAINT "ProvisionRun_cancelled_has_request" CHECK (
  "status" <> 'cancelled' OR "cancelState" = 'cancelled'
);

-- Cancelling an HR import that is waiting on duplicate review closes those
-- reviews: the run they belong to will never apply, and leaving them open
-- keeps a dead run in the review queue.
ALTER TABLE "PersonDuplicateReview" DROP CONSTRAINT "PersonDuplicateReview_resolution_valid";
ALTER TABLE "PersonDuplicateReview" ADD CONSTRAINT "PersonDuplicateReview_resolution_valid"
  CHECK ("resolution" IS NULL OR "resolution" IN ('keep_separate', 'link_existing', 'skip_source_record', 'run_cancelled'));
