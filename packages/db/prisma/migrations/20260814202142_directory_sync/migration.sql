-- AlterTable
ALTER TABLE "Group" ADD COLUMN     "sourceAnchor" TEXT,
ADD COLUMN     "sourceId" UUID,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'active',
ADD COLUMN     "statusReason" TEXT;

-- AlterTable
ALTER TABLE "OrgUnit" ADD COLUMN     "sourceAnchor" TEXT,
ADD COLUMN     "sourceId" UUID;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "sourceAnchor" TEXT,
ADD COLUMN     "sourceId" UUID;

-- CreateTable
CREATE TABLE "DirectorySource" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'ldap',
    "config" JSONB NOT NULL,
    "secretName" TEXT NOT NULL,
    "schedule" TEXT,
    "autoApply" BOOLEAN NOT NULL DEFAULT false,
    "deactivationThresholdPercent" INTEGER NOT NULL DEFAULT 10,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DirectorySource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttributeMapping" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "objectType" TEXT NOT NULL,
    "sourceAttribute" TEXT NOT NULL,
    "targetField" TEXT NOT NULL,
    "transform" TEXT NOT NULL DEFAULT 'none',
    "isCorrelation" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "AttributeMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncRun" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "recordsRead" INTEGER NOT NULL DEFAULT 0,
    "requiresConfirmation" BOOLEAN NOT NULL DEFAULT false,
    "blockedReason" TEXT,
    "error" TEXT,
    "unresolvedMembers" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "SyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncChange" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "changeType" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" UUID,
    "sourceAnchor" TEXT,
    "before" JSONB,
    "after" JSONB,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "message" TEXT,

    CONSTRAINT "SyncChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DirectorySource_tenantId_idx" ON "DirectorySource"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "DirectorySource_tenantId_name_key" ON "DirectorySource"("tenantId", "name");

-- CreateIndex
CREATE INDEX "AttributeMapping_tenantId_idx" ON "AttributeMapping"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "AttributeMapping_sourceId_objectType_targetField_key" ON "AttributeMapping"("sourceId", "objectType", "targetField");

-- CreateIndex
CREATE INDEX "SyncRun_tenantId_startedAt_idx" ON "SyncRun"("tenantId", "startedAt");

-- CreateIndex
CREATE INDEX "SyncRun_sourceId_idx" ON "SyncRun"("sourceId");

-- CreateIndex
CREATE INDEX "SyncChange_tenantId_idx" ON "SyncChange"("tenantId");

-- CreateIndex
CREATE INDEX "SyncChange_runId_changeType_idx" ON "SyncChange"("runId", "changeType");

-- CreateIndex
CREATE UNIQUE INDEX "Group_tenantId_sourceId_sourceAnchor_key" ON "Group"("tenantId", "sourceId", "sourceAnchor");

-- CreateIndex
CREATE UNIQUE INDEX "OrgUnit_tenantId_sourceId_sourceAnchor_key" ON "OrgUnit"("tenantId", "sourceId", "sourceAnchor");

-- CreateIndex
CREATE UNIQUE INDEX "User_tenantId_sourceId_sourceAnchor_key" ON "User"("tenantId", "sourceId", "sourceAnchor");

-- AddForeignKey
ALTER TABLE "AttributeMapping" ADD CONSTRAINT "AttributeMapping_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "DirectorySource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncRun" ADD CONSTRAINT "SyncRun_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "DirectorySource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncChange" ADD CONSTRAINT "SyncChange_runId_fkey" FOREIGN KEY ("runId") REFERENCES "SyncRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Row-level security. FORCE subjects the owning role to its own policies;
-- NULLIF is required because a GUC set with set_config(..., true) reverts to
-- an empty string, not NULL, when the transaction ends.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['DirectorySource','AttributeMapping','SyncRun','SyncChange'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid) WITH CHECK ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid)',
      t);
  END LOOP;
END $$;
