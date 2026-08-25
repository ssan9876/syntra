-- "Revoked" means APPLIED, and the other four outcomes each need a line.
--
-- §10 of the Govern design defines the word once: "'Revoked' means the removal
-- was applied at the system that holds it, confirmed by that system, and
-- observed by a subsequent read." `closeDueCampaigns` computed it as "items
-- whose latest decision is revoke", which swept in
-- `revocation_requires_change` -- the case §13 says is NEVER counted in a
-- revoked figure and calls "a lie with a signature on it" -- plus
-- `revocation_failed`, plus every item still sitting in `revoke_decided` with
-- nothing dispatched at all. A campaign that removed nothing reported 91
-- revocations, on the artifact somebody signs.
--
-- Three columns rather than one narrower figure, because a campaign that
-- closes with 91 decisions, 0 applied and 3 that Govern cannot execute has to
-- be able to say all three numbers. Folding them into one is precisely the
-- report §13's vocabulary section exists to forbid.
--
-- Default 0 on every existing row. Historical campaigns are not backfilled:
-- the statuses they were computed from are still on their items, and inventing
-- a number for a closed campaign nobody re-counted would be the same class of
-- claim this change exists to remove.
ALTER TABLE "Campaign"
  ADD COLUMN "revokeDecidedItems" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "dispatchedItems"    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "failedItems"        INTEGER NOT NULL DEFAULT 0;
