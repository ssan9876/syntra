-- One OrgUnit's container on one target.
--
-- An OrgUnit is tenant-wide and target-agnostic; a container is a
-- distinguished name under one target's base. This row is the join, and it is
-- what lets a run compare what Syntra intends against what the target holds.
-- Without it the intent lives only in the shape of the tree, and a container
-- renamed or removed behind Syntra's back is undetectable.

CREATE TABLE "OrgUnitContainer" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "orgUnitId" UUID NOT NULL,
    "targetSystemId" UUID NOT NULL,
    "dn" TEXT NOT NULL,
    "anchor" TEXT,
    "state" TEXT NOT NULL DEFAULT 'desired',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrgUnitContainer_pkey" PRIMARY KEY ("id")
);

-- One materialisation per unit per target. A unit materialised against two
-- targets has two DNs, and where it sits in one says nothing about the other.
CREATE UNIQUE INDEX "OrgUnitContainer_tenantId_orgUnitId_targetSystemId_key"
  ON "OrgUnitContainer"("tenantId", "orgUnitId", "targetSystemId");

-- One unit per container. Two units claiming one DN would converge two
-- departments' accounts into a single container with no error raised
-- anywhere, and the drift check would then read one row's intent as the
-- other's reality.
CREATE UNIQUE INDEX "OrgUnitContainer_tenantId_targetSystemId_dn_key"
  ON "OrgUnitContainer"("tenantId", "targetSystemId", "dn");

CREATE INDEX "OrgUnitContainer_tenantId_idx" ON "OrgUnitContainer"("tenantId");
CREATE INDEX "OrgUnitContainer_targetSystemId_idx"
  ON "OrgUnitContainer"("targetSystemId");

-- A DN may not be blank, for the reason AccountPlacement's container may not:
-- an empty DN is a write into somebody else's directory at a location nobody
-- chose.
ALTER TABLE "OrgUnitContainer" ADD CONSTRAINT org_unit_container_dn_not_blank
  CHECK (btrim("dn") <> '');

-- The three states the run distinguishes. A fourth arriving by typo would
-- read as "not desired" everywhere and silently stop proposing creates.
ALTER TABLE "OrgUnitContainer" ADD CONSTRAINT org_unit_container_state_known
  CHECK ("state" IN ('desired', 'live', 'adopted'));

-- `anchor` is deliberately NOT constrained to be present on a confirmed row.
--
-- It is tempting: 'live' and 'adopted' both mean the target confirmed the
-- object, so both should carry its identifier. But the two states learn it by
-- different routes. A 'live' row comes from `createContainer`, which reads the
-- anchor back and has it. An 'adopted' row comes from `listContainers`, which
-- by contract yields `{ dn }` and nothing else -- so adoption knows the
-- container exists without knowing its anchor, and a NOT NULL check here would
-- reject every adoption rather than catching a bug.
--
-- Widening `listContainers` to carry an anchor would make the constraint
-- possible and is the right change if drift ever needs to follow an adopted
-- container across a rename. It is not needed for placement, which matches on
-- DN.

-- Cascade from both parents. A materialisation is a fact about a unit in a
-- target and means nothing once either is gone. Safe on the OrgUnit side
-- because `deleteDirectoryOrgUnit` already refuses any unit holding users or
-- children, so a unit that can be deleted is empty.
ALTER TABLE "OrgUnitContainer"
  ADD CONSTRAINT "OrgUnitContainer_orgUnitId_fkey"
  FOREIGN KEY ("orgUnitId") REFERENCES "OrgUnit"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrgUnitContainer"
  ADD CONSTRAINT "OrgUnitContainer_targetSystemId_fkey"
  FOREIGN KEY ("targetSystemId") REFERENCES "TargetSystem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Where a person sits, which places their account in the container their unit
-- is materialised at. Separate from User.orgUnitId, which is unchanged.
--
-- SET NULL rather than CASCADE: deleting a unit must not delete people.
ALTER TABLE "Person" ADD COLUMN "orgUnitId" UUID;
ALTER TABLE "Person"
  ADD CONSTRAINT "Person_orgUnitId_fkey"
  FOREIGN KEY ("orgUnitId") REFERENCES "OrgUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Person_orgUnitId_idx" ON "Person"("orgUnitId");

-- An absolute count, not a share. Containers have no population to be a
-- percentage of. See the schema comment on the column.
ALTER TABLE "TargetSystem"
  ADD COLUMN "maxContainerCreatesPerRun" INTEGER NOT NULL DEFAULT 5;

-- Row-level security.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['OrgUnitContainer'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid) WITH CHECK ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid)',
      t);
  END LOOP;
END $$;
