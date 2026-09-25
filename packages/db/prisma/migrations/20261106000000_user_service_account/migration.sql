-- Service accounts.
--
-- An account used only by an integration, through an API token, is a
-- different thing from a person's account, and until now nothing said so. The
-- difference that forced this column: an administrator setting a password on
-- a person's behalf flags it must-change (two people know it), and a
-- must-change account's API tokens are refused until somebody signs in
-- interactively and changes it -- which nobody ever does for an integration,
-- so the integration simply stopped.
--
-- 'person' (the default, and every existing row) keeps today's behaviour
-- exactly. 'service' is set at creation or by an administrator with
-- directory.write, audited either way. The CHECK keeps a hand-edited row from
-- inventing a third kind the code would treat as neither. A new column on an
-- existing tenant-scoped table, so the table's row-level security policy
-- already covers it -- no new policy.
ALTER TABLE "User" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'person';
ALTER TABLE "User" ADD CONSTRAINT "User_kind_check"
  CHECK ("kind" IN ('person', 'service'));
