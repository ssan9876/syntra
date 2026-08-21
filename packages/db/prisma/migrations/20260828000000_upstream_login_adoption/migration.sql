-- A first federated login could take over any existing local account whose
-- login matched, silently.
--
-- The upstream chooses what it asserts. An identity provider that names
-- `admin` — whether because it was configured to, because somebody created
-- that user upstream, or because it was compromised — was handed the Syntra
-- account called `admin`, with its roles and its password credential intact
-- and an `UpstreamLink` now attached to it. Directory Sync refuses the same
-- move for the same reason and calls it a conflict rather than an adoption.
--
-- FALSE, not true, and no backfill to true for existing rows: a security
-- default that arrives switched on for everybody who already exists is not a
-- default, it is a migration that opens the hole it was written to close.
ALTER TABLE "UpstreamIdp"
  ADD COLUMN "allowLoginAdoption" BOOLEAN NOT NULL DEFAULT false;
