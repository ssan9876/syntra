-- A queued logout records WHO signed out, not the token that says so.
--
-- Minting needs the tenant's issuer and its active signing key. The callers
-- that end sessions -- a sync-driven leaver, a deactivation, a password reset,
-- a self-service sign-out -- have neither, and making every one of them
-- acquire both in order to revoke access is how propagation ends up being
-- something only some callers remember to do. Minting moves to the sender,
-- which runs per tenant and already has both.
--
-- It also means a key rotation between enqueue and delivery no longer strands
-- a queued token signed with a key that is no longer published.
--
-- No rows are preserved: the table was added one migration ago and nothing has
-- released with it, so there is nothing in flight to migrate.
DELETE FROM "LogoutDelivery";

ALTER TABLE "LogoutDelivery" DROP COLUMN "token";
ALTER TABLE "LogoutDelivery" ADD COLUMN "userId" UUID NOT NULL;
ALTER TABLE "LogoutDelivery" ADD COLUMN "sessionId" UUID;
