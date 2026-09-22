CREATE TABLE "LifecycleOperation" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL REFERENCES "Tenant"("id") ON DELETE CASCADE,
  "personId" UUID REFERENCES "Person"("id") ON DELETE SET NULL,
  "kind" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "attempt" INTEGER NOT NULL DEFAULT 1,
  "input" JSONB NOT NULL DEFAULT '{}',
  "inputFingerprint" TEXT NOT NULL,
  "ownerUserId" UUID,
  "priority" TEXT NOT NULL DEFAULT 'normal',
  "dueAt" TIMESTAMP(3),
  "acknowledgedAt" TIMESTAMP(3),
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "LifecycleOperation_tenantId_idempotencyKey_key" ON "LifecycleOperation"("tenantId", "idempotencyKey");
CREATE INDEX "LifecycleOperation_tenantId_status_updatedAt_idx" ON "LifecycleOperation"("tenantId", "status", "updatedAt");
CREATE INDEX "LifecycleOperation_tenantId_personId_createdAt_idx" ON "LifecycleOperation"("tenantId", "personId", "createdAt");
CREATE INDEX "LifecycleOperation_tenantId_ownerUserId_status_idx" ON "LifecycleOperation"("tenantId", "ownerUserId", "status");
CREATE INDEX "LifecycleOperation_tenantId_dueAt_status_idx" ON "LifecycleOperation"("tenantId", "dueAt", "status");

CREATE TABLE "LifecycleStep" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL REFERENCES "Tenant"("id") ON DELETE CASCADE,
  "operationId" UUID NOT NULL REFERENCES "LifecycleOperation"("id") ON DELETE CASCADE,
  "key" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  "required" BOOLEAN NOT NULL DEFAULT true,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "message" TEXT,
  "evidence" JSONB,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "LifecycleStep_operationId_key_key" ON "LifecycleStep"("operationId", "key");
CREATE UNIQUE INDEX "LifecycleStep_operationId_position_key" ON "LifecycleStep"("operationId", "position");
CREATE INDEX "LifecycleStep_tenantId_status_updatedAt_idx" ON "LifecycleStep"("tenantId", "status", "updatedAt");

CREATE TABLE "LifecycleObservation" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL REFERENCES "Tenant"("id") ON DELETE CASCADE,
  "stepId" UUID NOT NULL REFERENCES "LifecycleStep"("id") ON DELETE CASCADE,
  "targetSystemId" UUID,
  "completeness" TEXT NOT NULL,
  "matches" BOOLEAN NOT NULL,
  "expected" JSONB NOT NULL,
  "observed" JSONB,
  "differences" JSONB NOT NULL DEFAULT '[]',
  "fingerprint" TEXT,
  "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3)
);
CREATE INDEX "LifecycleObservation_tenantId_stepId_observedAt_idx" ON "LifecycleObservation"("tenantId", "stepId", "observedAt");
CREATE INDEX "LifecycleObservation_tenantId_expiresAt_idx" ON "LifecycleObservation"("tenantId", "expiresAt");

CREATE TABLE "ConnectionReadinessCheck" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL REFERENCES "Tenant"("id") ON DELETE CASCADE,
  "systemKind" TEXT NOT NULL,
  "systemId" UUID NOT NULL,
  "configurationFingerprint" TEXT NOT NULL,
  "capabilities" TEXT[] NOT NULL DEFAULT '{}',
  "status" TEXT NOT NULL,
  "latencyMs" INTEGER,
  "message" TEXT,
  "actorUserId" UUID,
  "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "ConnectionReadinessCheck_tenantId_systemKind_systemId_checkedAt_idx" ON "ConnectionReadinessCheck"("tenantId", "systemKind", "systemId", "checkedAt");
CREATE INDEX "ConnectionReadinessCheck_tenantId_status_checkedAt_idx" ON "ConnectionReadinessCheck"("tenantId", "status", "checkedAt");

ALTER TABLE "LifecycleOperation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LifecycleOperation" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "LifecycleOperation" USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid) WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
ALTER TABLE "LifecycleStep" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LifecycleStep" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "LifecycleStep" USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid) WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
ALTER TABLE "LifecycleObservation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LifecycleObservation" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "LifecycleObservation" USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid) WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
ALTER TABLE "ConnectionReadinessCheck" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ConnectionReadinessCheck" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ConnectionReadinessCheck" USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid) WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
