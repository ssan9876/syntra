-- A refused risk acceptance needs a remediation kind of its own.
--
-- Section 15: a refusal REVOKES NOTHING. Auto-revoking on a refused exception
-- would make an exception decision an unattended access removal at one remove
-- — the reviewer refuses a piece of paper and somebody loses access to the
-- payments system an hour later, with no revocation batch, no guard and nobody
-- named. What happens instead is that the violation stays open and a human is
-- given the job, and that job is a `RemediationItem`.
--
-- The kind vocabulary is a closed CHECK on purpose, and the six routing kinds
-- plus `undecided_item` and `orphan_attribution` have no member that means
-- "somebody declined to accept this risk and the access still has to be
-- separated". Filing it under `direct_assignment_change_required` would put a
-- refused risk acceptance in the same queue and the same count as a console
-- assignment somebody has to undo, which is precisely the conflation the
-- vocabulary exists to prevent.
ALTER TABLE "RemediationItem" DROP CONSTRAINT remediation_item_kind;
ALTER TABLE "RemediationItem" ADD CONSTRAINT remediation_item_kind CHECK (
  "kind" IN ('rule_change_required','directory_source_change_required',
             'direct_assignment_change_required','role_assignment_change_required',
             'account_removal_required','syntra_user_change_required',
             'undecided_item','orphan_attribution',
             'sod_violation_unaccepted'));
