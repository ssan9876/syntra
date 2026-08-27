-- Account lockout. The tenant policy, and the per-user counter it drives.
--
-- Defaults are deliberately inert: `lockoutThreshold` 0 means no tenant that
-- already exists changes behaviour when this migration runs.
ALTER TABLE "Tenant" ADD COLUMN "lockoutThreshold" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Tenant" ADD COLUMN "lockoutWindowMinutes" INTEGER NOT NULL DEFAULT 15;
ALTER TABLE "Tenant" ADD COLUMN "lockoutDurationMinutes" INTEGER NOT NULL DEFAULT 15;

ALTER TABLE "Tenant" ADD CONSTRAINT tenant_lockout_threshold CHECK ("lockoutThreshold" >= 0);
ALTER TABLE "Tenant" ADD CONSTRAINT tenant_lockout_window CHECK ("lockoutWindowMinutes" > 0);
ALTER TABLE "Tenant" ADD CONSTRAINT tenant_lockout_duration CHECK ("lockoutDurationMinutes" >= 0);

CREATE TABLE "LoginLockout" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "firstFailedAt" TIMESTAMP(3) NOT NULL,
    "lastFailedAt" TIMESTAMP(3) NOT NULL,
    "lockedAt" TIMESTAMP(3),
    "lockedUntil" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoginLockout_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LoginLockout_userId_key" ON "LoginLockout"("userId");
CREATE INDEX "LoginLockout_tenantId_idx" ON "LoginLockout"("tenantId");

-- A lock that lifts itself must lift itself after it was applied. A lock with
-- no `lockedUntil` is one an administrator has to lift, which is legal.
ALTER TABLE "LoginLockout" ADD CONSTRAINT login_lockout_lifts_after_it_locks CHECK (
  "lockedUntil" IS NULL OR ("lockedAt" IS NOT NULL AND "lockedUntil" > "lockedAt")
);

-- Row-level security.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['LoginLockout'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid) WITH CHECK ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid)',
      t);
  END LOOP;
END $$;
