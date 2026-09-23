ALTER TABLE "AccountProfile"
  ADD COLUMN "sensitiveApprovalReason" TEXT,
  ADD COLUMN "sensitiveApprovedByUserId" UUID,
  ADD COLUMN "sensitiveApprovedAt" TIMESTAMP(3);

ALTER TABLE "AccountProfile" ADD CONSTRAINT "AccountProfile_sensitive_approval_complete"
  CHECK (
    ("sensitiveApprovalReason" IS NULL AND "sensitiveApprovedByUserId" IS NULL AND "sensitiveApprovedAt" IS NULL)
    OR
    ("sensitiveApprovalReason" IS NOT NULL AND "sensitiveApprovedByUserId" IS NOT NULL AND "sensitiveApprovedAt" IS NOT NULL)
  );
