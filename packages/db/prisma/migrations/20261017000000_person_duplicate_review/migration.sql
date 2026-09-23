CREATE TABLE "PersonDuplicateReview" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "runId" UUID NOT NULL,
  "changeId" UUID NOT NULL,
  "candidatePersonId" UUID NOT NULL,
  "matchKind" TEXT NOT NULL DEFAULT 'business_email',
  "matchedValue" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'open',
  "resolution" TEXT,
  "note" TEXT,
  "reviewedByUserId" UUID,
  "reviewedAt" TIMESTAMP(3),
  "restoreStatus" TEXT NOT NULL,
  "restoreBlockedReason" TEXT,
  "restoreRequiresConfirmation" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PersonDuplicateReview_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PersonDuplicateReview_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE,
  CONSTRAINT "PersonDuplicateReview_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PersonImportRun"("id") ON DELETE CASCADE,
  CONSTRAINT "PersonDuplicateReview_changeId_fkey" FOREIGN KEY ("changeId") REFERENCES "PersonImportChange"("id") ON DELETE CASCADE,
  CONSTRAINT "PersonDuplicateReview_candidatePersonId_fkey" FOREIGN KEY ("candidatePersonId") REFERENCES "Person"("id") ON DELETE RESTRICT,
  CONSTRAINT "PersonDuplicateReview_status_valid" CHECK ("status" IN ('open', 'resolved')),
  CONSTRAINT "PersonDuplicateReview_resolution_valid" CHECK ("resolution" IS NULL OR "resolution" IN ('keep_separate', 'skip_source_record'))
);
CREATE UNIQUE INDEX "PersonDuplicateReview_changeId_candidatePersonId_key" ON "PersonDuplicateReview"("changeId", "candidatePersonId");
CREATE INDEX "PersonDuplicateReview_tenantId_status_createdAt_idx" ON "PersonDuplicateReview"("tenantId", "status", "createdAt");
CREATE INDEX "PersonDuplicateReview_runId_status_idx" ON "PersonDuplicateReview"("runId", "status");
