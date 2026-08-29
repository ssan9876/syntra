-- Indexes for foreign-key columns that had none. An unindexed FK forces a
-- sequential scan for every lookup by parent, every join, and (on Postgres)
-- every check the database itself would otherwise want to run on the
-- referencing side of a delete/update against the parent's key.
CREATE INDEX "User_orgUnitId_idx" ON "User"("orgUnitId");
CREATE INDEX "DriftFinding_runId_idx" ON "DriftFinding"("runId");
CREATE INDEX "Product_workflowId_idx" ON "Product"("workflowId");
CREATE INDEX "AccessRequest_productId_idx" ON "AccessRequest"("productId");
CREATE INDEX "RemediationItem_findingId_idx" ON "RemediationItem"("findingId");
CREATE INDEX "RevocationBatch_campaignId_idx" ON "RevocationBatch"("campaignId");
CREATE INDEX "SodException_ruleId_idx" ON "SodException"("ruleId");
CREATE INDEX "SodException_violationId_idx" ON "SodException"("violationId");
