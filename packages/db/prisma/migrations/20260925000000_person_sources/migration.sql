-- The HR feed: a source family that reads persons and contracts.
--
-- Separate from DirectorySource because a person is not a user, a group or an
-- org unit, and because SourceConnector has no write path -- the four
-- write-back flags a directory source carries would be permanently false here.

CREATE TABLE "PersonSource" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "secretName" TEXT NOT NULL,
    "feedMode" TEXT NOT NULL,
    "schedule" TEXT,
    "autoApply" BOOLEAN NOT NULL DEFAULT false,
    "deactivationThresholdPercent" INTEGER NOT NULL DEFAULT 10,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PersonSource_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PersonSource_tenantId_name_key" ON "PersonSource"("tenantId", "name");
CREATE INDEX "PersonSource_tenantId_idx" ON "PersonSource"("tenantId");

-- NOT NULL with no default, so every writer has to state it. Reading a delta
-- file as a snapshot departs everyone who did not change yesterday, and a
-- default is how that happens without anybody choosing it.
ALTER TABLE "PersonSource" ADD CONSTRAINT person_source_feed_mode_known
  CHECK ("feedMode" IN ('snapshot', 'delta'));

CREATE TABLE "PersonFieldMapping" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "recordType" TEXT NOT NULL,
    "sourceColumn" TEXT NOT NULL,
    "targetField" TEXT NOT NULL,
    "transform" TEXT NOT NULL DEFAULT 'none',
    "isCorrelation" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "PersonFieldMapping_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PersonFieldMapping_sourceId_recordType_targetField_key"
  ON "PersonFieldMapping"("sourceId", "recordType", "targetField");
CREATE INDEX "PersonFieldMapping_tenantId_idx" ON "PersonFieldMapping"("tenantId");

ALTER TABLE "PersonFieldMapping" ADD CONSTRAINT person_field_mapping_record_type_known
  CHECK ("recordType" IN ('person', 'contract'));

CREATE TABLE "PersonImportRun" (
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
    "mappingFailures" INTEGER NOT NULL DEFAULT 0,
    "mappingFailureReasons" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "personsAbsent" INTEGER NOT NULL DEFAULT 0,
    "confirmedBy" UUID,

    CONSTRAINT "PersonImportRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PersonImportRun_tenantId_startedAt_idx" ON "PersonImportRun"("tenantId", "startedAt");
CREATE INDEX "PersonImportRun_sourceId_idx" ON "PersonImportRun"("sourceId");

CREATE TABLE "PersonImportChange" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "changeType" TEXT NOT NULL,
    "recordType" TEXT NOT NULL,
    "targetId" UUID,
    "externalId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "message" TEXT,

    CONSTRAINT "PersonImportChange_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PersonImportChange_tenantId_idx" ON "PersonImportChange"("tenantId");
-- Both. The console reads a run's changes by type; apply reads and counts them
-- by status. SyncChange records that the second was missing and every apply
-- sequential-scanned the run's changes.
CREATE INDEX "PersonImportChange_runId_changeType_idx" ON "PersonImportChange"("runId", "changeType");
CREATE INDEX "PersonImportChange_runId_status_idx" ON "PersonImportChange"("runId", "status");

-- The seven the diff can emit. There is no delete of either kind, and an
-- eighth arriving by typo would be applied by nothing and reported as proposed
-- forever.
ALTER TABLE "PersonImportChange" ADD CONSTRAINT person_import_change_type_known
  CHECK ("changeType" IN (
    'create_person', 'update_person', 'depart_person', 'reactivate_person',
    'create_contract', 'update_contract', 'end_contract'));

ALTER TABLE "PersonFieldMapping"
  ADD CONSTRAINT "PersonFieldMapping_sourceId_fkey"
  FOREIGN KEY ("sourceId") REFERENCES "PersonSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PersonImportRun"
  ADD CONSTRAINT "PersonImportRun_sourceId_fkey"
  FOREIGN KEY ("sourceId") REFERENCES "PersonSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PersonImportChange"
  ADD CONSTRAINT "PersonImportChange_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "PersonImportRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Ownership of a person row.
--
-- RESTRICT, not SET NULL: a person whose source has gone is not a hand-managed
-- person, they are a person nothing feeds. deletePersonSource deactivates and
-- detaches them explicitly, in the same transaction as the delete, so
-- releasing them is an act of the code and not only of the schema.
ALTER TABLE "Person" ADD COLUMN "sourceId" UUID;
-- Why this person is inactive. An absence-derived departure writes this and
-- never departureOverride, which means a human knew something the contract
-- table did not.
ALTER TABLE "Person" ADD COLUMN "statusReason" TEXT;
ALTER TABLE "Person"
  ADD CONSTRAINT "Person_sourceId_fkey"
  FOREIGN KEY ("sourceId") REFERENCES "PersonSource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "Person_sourceId_idx" ON "Person"("sourceId");

-- The HR system's own employment id. Nullable: a file carrying none falls back
-- to matching on sequence, which the mapping screen warns about.
ALTER TABLE "Contract" ADD COLUMN "externalId" TEXT;
CREATE UNIQUE INDEX "Contract_personId_externalId_key" ON "Contract"("personId", "externalId");

-- Row-level security.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['PersonSource', 'PersonFieldMapping', 'PersonImportRun', 'PersonImportChange'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid) WITH CHECK ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid)',
      t);
  END LOOP;
END $$;
