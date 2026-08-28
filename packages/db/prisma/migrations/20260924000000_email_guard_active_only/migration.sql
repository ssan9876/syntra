-- The local-email guard covers ACTIVE accounts only.
--
-- Two independent reasons, either of which would be enough.
--
-- Deleting a directory source deactivates the accounts it owned and then
-- detaches them (`sourceId` to null), which moved every one of them out of the
-- index's exemption and into its scope in a single statement. Two synced
-- accounts sharing an address — which a directory is entitled to have, and
-- which the exemption exists to tolerate — collided the moment their source
-- was removed, and the deletion failed with a constraint violation the
-- administrator could do nothing about.
--
-- And this directory deactivates, never deletes. Without the status clause a
-- leaver's inactive account reserves their address for ever, so the
-- replacement hired into their post cannot be created with the mailbox they
-- have been given. The guard exists to stop an administrator creating a second
-- USABLE account on one address; an inactive account is a record, not a login.
--
-- `login` is deliberately NOT given the same treatment. It has been unique per
-- tenant regardless of status since Core, reusing a leaver's login is
-- genuinely ambiguous because the audit trail is read by it, and relaxing that
-- is a separate decision from introducing this one.
DROP INDEX "User_tenantId_lower_email_local_key";

CREATE UNIQUE INDEX "User_tenantId_lower_email_local_key"
  ON "User" ("tenantId", lower("email"))
  WHERE "sourceId" IS NULL AND "status" = 'active';
