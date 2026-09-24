-- Capability enforcement and certification-aware adapter rollout
-- (enterprise-readiness backlog items 18 and 33).
--
-- Per target: which adapter release runs it (a channel, and optionally an
-- exact pin), the certified release a rollback returns to, and a
-- time-bounded, version-bound override for writing through a release past
-- its deprecation date. Per run: which release the plan was computed for,
-- and how many of its actions were refused for want of certification or an
-- advertised capability.
--
-- Both tables already have FORCE ROW LEVEL SECURITY with a tenant_isolation
-- policy; adding columns changes neither. `ProvisionAction.status` is free
-- text, so the new `refused` value needs no DDL.

ALTER TABLE "TargetSystem"
  ADD COLUMN "adapterChannel" TEXT NOT NULL DEFAULT 'stable',
  ADD COLUMN "adapterVersionPin" TEXT,
  ADD COLUMN "adapterRollbackVersion" TEXT,
  ADD COLUMN "adapterSelectionChangedAt" TIMESTAMP(3),
  ADD COLUMN "adapterSelectionChangedByUserId" UUID,
  ADD COLUMN "adapterSelectionReason" TEXT,
  ADD COLUMN "deprecationOverrideVersion" TEXT,
  ADD COLUMN "deprecationOverrideReason" TEXT,
  ADD COLUMN "deprecationOverrideAt" TIMESTAMP(3),
  ADD COLUMN "deprecationOverrideExpiresAt" TIMESTAMP(3),
  ADD COLUMN "deprecationOverrideByUserId" UUID;

ALTER TABLE "TargetSystem" ADD CONSTRAINT "TargetSystem_adapter_channel_valid"
  CHECK ("adapterChannel" IN ('stable', 'canary'));

-- The catalog holds only `major.minor.patch`; anything else could never
-- resolve and would refuse every run on the target.
ALTER TABLE "TargetSystem" ADD CONSTRAINT "TargetSystem_adapter_versions_valid" CHECK (
  ("adapterVersionPin" IS NULL OR "adapterVersionPin" ~ '^[0-9]+\.[0-9]+\.[0-9]+$')
  AND ("adapterRollbackVersion" IS NULL OR "adapterRollbackVersion" ~ '^[0-9]+\.[0-9]+\.[0-9]+$')
  AND ("deprecationOverrideVersion" IS NULL OR "deprecationOverrideVersion" ~ '^[0-9]+\.[0-9]+\.[0-9]+$')
);

-- An override is all of its evidence or none of it: a version, a reason that
-- says something, who granted it and when, and an expiry after the grant and
-- no more than 30 days later. An open-ended override to a deprecated adapter
-- is the permanent exception the deprecation date exists to prevent.
ALTER TABLE "TargetSystem" ADD CONSTRAINT "TargetSystem_deprecation_override_valid" CHECK (
  (
    "deprecationOverrideVersion" IS NULL
    AND "deprecationOverrideReason" IS NULL
    AND "deprecationOverrideAt" IS NULL
    AND "deprecationOverrideExpiresAt" IS NULL
    AND "deprecationOverrideByUserId" IS NULL
  )
  OR (
    "deprecationOverrideVersion" IS NOT NULL
    AND "deprecationOverrideReason" IS NOT NULL
    AND length(btrim("deprecationOverrideReason")) >= 10
    AND "deprecationOverrideAt" IS NOT NULL
    AND "deprecationOverrideExpiresAt" IS NOT NULL
    AND "deprecationOverrideByUserId" IS NOT NULL
    AND "deprecationOverrideExpiresAt" > "deprecationOverrideAt"
    AND "deprecationOverrideExpiresAt" <= "deprecationOverrideAt" + INTERVAL '30 days'
  )
);

ALTER TABLE "ProvisionRun"
  ADD COLUMN "adapterVersion" TEXT,
  ADD COLUMN "capabilityRefusedCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "capabilityRefusal" TEXT;

ALTER TABLE "ProvisionRun" ADD CONSTRAINT "ProvisionRun_capability_refusal_consistent" CHECK (
  "capabilityRefusedCount" >= 0
  AND (("capabilityRefusedCount" = 0) = ("capabilityRefusal" IS NULL))
);
