-- Mirror org units as OUs.
--
-- Until now an org unit reached a directory only when an administrator typed
-- a DN for it, per unit, per target, and the org-unit tree (`parentId`) played
-- no part: `ssander.local -> IT` materialised as `OU=IT,OU=Syntra,...` came out
-- flat. A mirroring target derives every active unit's container from its
-- ancestor path instead, and a run keeps the directory in step with the tree.
--
-- Off for every existing target, so nothing that runs today behaves
-- differently. Turning it on writes nothing to any directory by itself: the
-- OUs are created, and moved, only by a provisioning run, under the guard.

-- `orgUnitRootDn` null means "the target's base DN". Validated on write, by
-- `validateContainerDn`, to sit below that base.
ALTER TABLE "TargetSystem"
  ADD COLUMN "mirrorOrgUnits" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "orgUnitRootDn" TEXT;

-- A root that is blank is not "the base" -- null is -- and a blank DN is a
-- write at a location nobody chose.
ALTER TABLE "TargetSystem" ADD CONSTRAINT target_system_org_unit_root_dn_not_blank
  CHECK ("orgUnitRootDn" IS NULL OR btrim("orgUnitRootDn") <> '');

-- Where a materialisation's DN came from. 'manual' is a DN an administrator
-- typed, and it always wins over the derived one; 'mirrored' is a DN the
-- target's mirroring derived from the tree, and the next run re-derives it.
-- Every existing row was typed by somebody, so the default is 'manual'.
ALTER TABLE "OrgUnitContainer"
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN "previousDn" TEXT;

ALTER TABLE "OrgUnitContainer" ADD CONSTRAINT org_unit_container_source_known
  CHECK ("source" IN ('manual', 'mirrored'));

-- `previousDn` is the DN the target last confirmed for a row whose `dn` has
-- since changed -- a unit renamed or re-parented, or a manual row switched to
-- mirrored. It is what lets a run MOVE the existing OU, and the accounts in
-- it, rather than create a second one and leave the first behind. Blank would
-- name no container to move from.
ALTER TABLE "OrgUnitContainer" ADD CONSTRAINT org_unit_container_previous_dn_not_blank
  CHECK ("previousDn" IS NULL OR btrim("previousDn") <> '');
