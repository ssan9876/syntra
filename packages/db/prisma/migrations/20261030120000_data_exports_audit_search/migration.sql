-- Backlog #48 (secure export service) and #73 (audit search at scale).
--
-- 1. `DataExport`: the asynchronous, permission-checked, watermarked export.
--    See the model comment. FORCE RLS like every tenant table; the ciphertext
--    lives here as `bytea`, sealed under a per-export data key wrapped by the
--    master key, and is erased (set NULL) at revocation, expiry or failure.
-- 2. `AuditSavedView`: a named set of audit-search filters per administrator.
-- 3. Indexes that the audit search's filters and keyset pagination need.
--
-- A NOTE FOR LARGE INSTALLATIONS. Prisma runs a migration in a transaction,
-- so the four `AuditEvent` indexes below are built with plain CREATE INDEX,
-- which blocks writes to the audit log (and therefore every audited action)
-- while each builds. On a log of a few million rows that is seconds; on a
-- very large one an operator may create them beforehand with
-- `CREATE INDEX CONCURRENTLY ... IF NOT EXISTS` under the same names, and
-- the `IF NOT EXISTS` here then makes this migration a no-op for them. See
-- docs/operate.md, "Audit search".

CREATE TABLE "DataExport" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "params" JSONB NOT NULL,
    "format" TEXT NOT NULL,
    "requestedByUserId" UUID NOT NULL,
    "requestedViaToken" BOOLEAN NOT NULL DEFAULT false,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ttlHours" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "authorityFingerprint" TEXT,
    "rowCount" INTEGER,
    "byteLength" INTEGER,
    "sha256" TEXT,
    "filename" TEXT,
    "contentType" TEXT,
    "error" TEXT,
    "ciphertext" BYTEA,
    "iv" BYTEA,
    "tag" BYTEA,
    "wrappedDek" BYTEA,
    "dekIv" BYTEA,
    "dekTag" BYTEA,
    "revokedAt" TIMESTAMP(3),
    "revokedByUserId" UUID,
    "purgedAt" TIMESTAMP(3),
    "downloadCount" INTEGER NOT NULL DEFAULT 0,
    "lastDownloadedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DataExport_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DataExport_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DataExport_kind_known" CHECK ("kind" IN ('audit_log', 'govern_access')),
    CONSTRAINT "DataExport_format_known" CHECK ("format" IN ('jsonl', 'csv')),
    CONSTRAINT "DataExport_status_known" CHECK (
      "status" IN ('queued', 'running', 'ready', 'failed', 'revoked', 'expired')
    ),
    -- The documented bound. A longer-lived artifact is a standing copy of the
    -- data outside every control that governs the data itself.
    CONSTRAINT "DataExport_ttl_bounded" CHECK ("ttlHours" BETWEEN 1 AND 72),
    -- A ready export is downloadable, so everything a download verifies must
    -- be present: the sealed bytes, their digest, and when they stop existing.
    CONSTRAINT "DataExport_ready_complete" CHECK (
      "status" <> 'ready' OR (
        "ciphertext" IS NOT NULL AND "iv" IS NOT NULL AND "tag" IS NOT NULL
        AND "wrappedDek" IS NOT NULL AND "dekIv" IS NOT NULL AND "dekTag" IS NOT NULL
        AND "sha256" IS NOT NULL AND "expiresAt" IS NOT NULL AND "completedAt" IS NOT NULL
      )
    ),
    -- A terminal export holds no ciphertext. This is the erasure, enforced by
    -- the database rather than trusted to every code path that ends one.
    CONSTRAINT "DataExport_terminal_erased" CHECK (
      "status" NOT IN ('failed', 'revoked', 'expired') OR "ciphertext" IS NULL
    ),
    CONSTRAINT "DataExport_revocation_attributed" CHECK (
      "status" <> 'revoked' OR "revokedAt" IS NOT NULL
    )
);

CREATE INDEX "DataExport_tenantId_requestedByUserId_requestedAt_idx" ON "DataExport"("tenantId", "requestedByUserId", "requestedAt" DESC);
CREATE INDEX "DataExport_tenantId_status_expiresAt_idx" ON "DataExport"("tenantId", "status", "expiresAt");

ALTER TABLE "DataExport" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DataExport" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "DataExport"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

CREATE TABLE "AuditSavedView" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "filters" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuditSavedView_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AuditSavedView_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AuditSavedView_name_bounded" CHECK (char_length("name") BETWEEN 1 AND 80)
);

CREATE UNIQUE INDEX "AuditSavedView_tenantId_userId_name_key" ON "AuditSavedView"("tenantId", "userId", "name");

ALTER TABLE "AuditSavedView" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditSavedView" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "AuditSavedView"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- Audit search. Every filter is paired with `sequence` so a filtered page is
-- an index range read in keyset order rather than a scan and a sort.
CREATE INDEX IF NOT EXISTS "AuditEvent_tenantId_actorUserId_sequence_idx" ON "AuditEvent"("tenantId", "actorUserId", "sequence" DESC);
CREATE INDEX IF NOT EXISTS "AuditEvent_tenantId_targetId_sequence_idx" ON "AuditEvent"("tenantId", "targetId", "sequence" DESC);
CREATE INDEX IF NOT EXISTS "AuditEvent_tenantId_outcome_sequence_idx" ON "AuditEvent"("tenantId", "outcome", "sequence" DESC);
-- `text_pattern_ops` so `action LIKE 'prefix%'` is a range read under any
-- database collation. Prisma cannot express this operator class on a B-tree,
-- so this index exists here only; the schema comment names it.
CREATE INDEX IF NOT EXISTS "AuditEvent_tenantId_action_prefix_idx" ON "AuditEvent"("tenantId", "action" text_pattern_ops, "sequence");
