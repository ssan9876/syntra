-- Password ageing: expiry, and a reuse check.
--
-- Both default to inert. `passwordMaxAgeDays` is 0 (never expires) and
-- `passwordHistoryDepth` is 0 (no reuse check), so no tenant that already
-- exists changes behaviour when this migration runs.
ALTER TABLE "Tenant" ADD COLUMN "passwordMaxAgeDays" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Tenant" ADD COLUMN "passwordHistoryDepth" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "Tenant" ADD CONSTRAINT tenant_password_max_age CHECK ("passwordMaxAgeDays" >= 0);
ALTER TABLE "Tenant" ADD CONSTRAINT tenant_password_history_depth CHECK (
  "passwordHistoryDepth" >= 0 AND "passwordHistoryDepth" <= 24
);

-- Existing credentials are dated from `updatedAt` rather than from now.
--
-- `now()` would be the easy default and the wrong one: it would reset every
-- password in every tenant to age zero, so the first tenant to switch expiry
-- on would get a full period of grace for passwords that are already years
-- old. `updatedAt` is the closest true statement this table can make about
-- when each password was last chosen.
ALTER TABLE "PasswordCredential" ADD COLUMN "changedAt" TIMESTAMP(3);

DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT id FROM "Tenant" LOOP
    -- PasswordCredential carries FORCE ROW LEVEL SECURITY and migrations run
    -- as syntra_app, which is NOSUPERUSER NOBYPASSRLS and therefore subject to
    -- its own policies. Without this the UPDATE matches zero rows and commits
    -- happily -- and then the SET NOT NULL below fails on the rows it did not
    -- reach, which is how this was found. `true` scopes the setting to this
    -- transaction, the same way withTenant does.
    PERFORM set_config('app.current_tenant', t.id::text, true);

    UPDATE "PasswordCredential"
       SET "changedAt" = "updatedAt"
     WHERE "changedAt" IS NULL;
  END LOOP;
END $$;

-- Belt and braces: a credential belonging to no tenant cannot exist (the
-- column is NOT NULL and carries a policy), but a NULL surviving the loop
-- would fail the SET NOT NULL below with nothing to say why.
UPDATE "PasswordCredential" SET "changedAt" = "updatedAt" WHERE "changedAt" IS NULL;

ALTER TABLE "PasswordCredential" ALTER COLUMN "changedAt" SET NOT NULL;
ALTER TABLE "PasswordCredential" ALTER COLUMN "changedAt" SET DEFAULT CURRENT_TIMESTAMP;

CREATE TABLE "PasswordHistory" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "hash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordHistory_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PasswordHistory_tenantId_idx" ON "PasswordHistory"("tenantId");
CREATE INDEX "PasswordHistory_userId_createdAt_idx" ON "PasswordHistory"("userId", "createdAt");

-- Row-level security.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['PasswordHistory'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid) WITH CHECK ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid)',
      t);
  END LOOP;
END $$;
