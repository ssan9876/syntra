-- Held actions, approved after the fact, and renames a target may confirm on
-- its own.
--
-- A target with `autoApply` on applies every run it starts, and an unattended
-- apply confirms nothing: a rename, a re-enable outside the window or the
-- re-create of a vanished account is left `proposed` on a run that has ended,
-- and a finished run cannot be applied again. So with auto-apply on, a held
-- action could never be confirmed through the console at all.
--
-- `ProvisionActionApproval` is a standing, single-use, 24-hour approval of ONE
-- change, keyed by a fingerprint of its type, account and before/after values.
-- The next run that proposes exactly that change applies it; any other change
-- is not covered. It never overrides a run the guard held.
--
-- `TargetSystem.autoConfirmRenames` lets an apply confirm `rename_account`
-- actions -- and only those -- by the target's own setting. Off for every
-- existing target, so nothing that runs today behaves differently.

ALTER TABLE "TargetSystem" ADD COLUMN "autoConfirmRenames" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "ProvisionActionApproval" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "targetSystemId" UUID NOT NULL,
  "accountId" UUID NOT NULL,
  "actionType" TEXT NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "sourceActionId" UUID NOT NULL,
  "approvedByUserId" UUID NOT NULL,
  "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "consumedByActionId" UUID,
  "revokedAt" TIMESTAMP(3),
  "revokedByUserId" UUID,

  CONSTRAINT "ProvisionActionApproval_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProvisionActionApproval_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ProvisionActionApproval_targetSystemId_fkey" FOREIGN KEY ("targetSystemId") REFERENCES "TargetSystem"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  -- A SHA-256, hex. Anything else is a fingerprint no apply could ever match,
  -- which is an approval that silently approves nothing.
  CONSTRAINT "ProvisionActionApproval_fingerprint_sha256" CHECK ("fingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ProvisionActionApproval_expires_after_approval" CHECK ("expiresAt" > "approvedAt"),
  -- Consumed names the action that consumed it, and revoked names who revoked
  -- it. Either half without the other is a state nobody can explain.
  CONSTRAINT "ProvisionActionApproval_consumed_attributed" CHECK (
    ("consumedAt" IS NULL) = ("consumedByActionId" IS NULL)
  ),
  CONSTRAINT "ProvisionActionApproval_revoked_attributed" CHECK (
    ("revokedAt" IS NULL) = ("revokedByUserId" IS NULL)
  ),
  -- Single-use in the strict sense: an approval is consumed OR revoked, never
  -- both, so "was this change applied on a person's word" has one answer.
  CONSTRAINT "ProvisionActionApproval_consumed_or_revoked" CHECK (
    "consumedAt" IS NULL OR "revokedAt" IS NULL
  )
);

CREATE INDEX "ProvisionActionApproval_lookup_idx" ON "ProvisionActionApproval"("tenantId", "targetSystemId", "accountId", "actionType");
CREATE INDEX "ProvisionActionApproval_tenantId_sourceActionId_idx" ON "ProvisionActionApproval"("tenantId", "sourceActionId");
CREATE INDEX "ProvisionActionApproval_tenantId_idx" ON "ProvisionActionApproval"("tenantId");

ALTER TABLE "ProvisionActionApproval" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ProvisionActionApproval" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ProvisionActionApproval"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
