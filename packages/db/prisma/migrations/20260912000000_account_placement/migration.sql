-- A person's account pinned to a container by hand.
--
-- Without this row a manual move is undone by the next run: the container is
-- computed from the account profile's template, and the planner proposes an
-- `update_account` carrying a `modifyDN` whenever the account is not where the
-- template says. A Move button that silently reverts within the hour is worse
-- than no Move button.

CREATE TABLE "AccountPlacement" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "personId" UUID NOT NULL,
    "targetSystemId" UUID NOT NULL,
    "container" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "movedByUserId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountPlacement_pkey" PRIMARY KEY ("id")
);

-- One placement per person per target. A person may hold accounts in several
-- targets, and where they sit in one says nothing about where they sit in
-- another.
CREATE UNIQUE INDEX "AccountPlacement_personId_targetSystemId_key"
  ON "AccountPlacement"("personId", "targetSystemId");
CREATE INDEX "AccountPlacement_tenantId_idx" ON "AccountPlacement"("tenantId");
CREATE INDEX "AccountPlacement_targetSystemId_idx" ON "AccountPlacement"("targetSystemId");

-- A container may not be blank. An empty DN is a write into somebody else's
-- directory at a location nobody chose, and `desiredState` already fails
-- closed on one -- this stops it being stored in the first place.
ALTER TABLE "AccountPlacement" ADD CONSTRAINT account_placement_container_not_blank
  CHECK (btrim("container") <> '');
ALTER TABLE "AccountPlacement" ADD CONSTRAINT account_placement_reason_not_blank
  CHECK (btrim("reason") <> '');

-- Cascade from both parents. A placement is a fact about a person in a target
-- and means nothing once either is gone.
ALTER TABLE "AccountPlacement"
  ADD CONSTRAINT "AccountPlacement_personId_fkey"
  FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AccountPlacement"
  ADD CONSTRAINT "AccountPlacement_targetSystemId_fkey"
  FOREIGN KEY ("targetSystemId") REFERENCES "TargetSystem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['AccountPlacement'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid) WITH CHECK ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid)',
      t);
  END LOOP;
END $$;
