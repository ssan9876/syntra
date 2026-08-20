-- `applyRun` asks three questions of this table on every apply — the proposed
-- changes to walk, and then the remaining and failed counts that decide whether
-- the run reports `applied` or `partially_applied` — and every one of them is
-- keyed on (runId, status). The only index available was (runId, changeType),
-- which answers a different question: the console's per-run listing.
--
-- Added rather than swapped. Both queries are real.
CREATE INDEX "SyncChange_runId_status_idx" ON "SyncChange"("runId", "status");
