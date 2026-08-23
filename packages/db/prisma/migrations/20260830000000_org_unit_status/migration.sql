-- Org units can be deactivated, like users and groups before them.
--
-- They were the one part of the directory with no way to retire it. A
-- department that closes had to be left standing and granting, or deleted --
-- and deleting an org unit takes the record of who was in it, silently drops
-- every application assignment made on it, and orphans any administrative role
-- scoped to it. "Deactivation never deletes" is the rule this product runs on,
-- and the column that makes it possible was simply missing here.
--
-- Defaults to 'active' with no reason, so every existing row keeps behaving
-- exactly as it does today. The reason is nullable in the schema and REQUIRED
-- by the service that sets it -- a deactivation with no reason is a row saying
-- access was taken away that will not say why, which is precisely the question
-- asked six months later.
ALTER TABLE "OrgUnit"
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN "statusReason" TEXT;
