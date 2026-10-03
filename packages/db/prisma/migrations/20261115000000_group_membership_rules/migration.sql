-- Dynamic groups: a group may carry a membership rule over person and
-- contract attributes. Memberships the rule writes are marked 'rule' and are
-- the only ones it ever removes; every other membership is 'direct'.

ALTER TABLE "Group" ADD COLUMN "membershipRule" JSONB;
ALTER TABLE "Group" ADD COLUMN "ruleEvaluatedAt" TIMESTAMP(3);
-- Set while a pass is held for removing too many members; cleared by the
-- next pass that applies.
ALTER TABLE "Group" ADD COLUMN "ruleHeldAt" TIMESTAMP(3);
ALTER TABLE "Group" ADD COLUMN "ruleHeldRemoveCount" INTEGER;

ALTER TABLE "GroupMembership" ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'direct';
ALTER TABLE "GroupMembership" ADD CONSTRAINT "GroupMembership_origin_check"
  CHECK ("origin" IN ('direct', 'rule'));
