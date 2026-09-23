-- The employee-work and lifecycle operation queues page unresolved work by
-- newest update. A partial index keeps completed history out of that hot path
-- and avoids sorting every open row for each page request.
CREATE INDEX "LifecycleOperation_open_queue_updatedAt_id_idx"
  ON "LifecycleOperation" ("tenantId", "updatedAt" DESC, id ASC)
  WHERE status NOT IN ('completed', 'cancelled', 'rejected');
