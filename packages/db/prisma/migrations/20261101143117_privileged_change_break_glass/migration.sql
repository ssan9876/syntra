-- Separation of duties for privileged administrative changes, and the
-- break-glass (emergency access) lifecycle.
--
-- Both are four-eyes state machines in the same idiom as tenant deletion and
-- the tenant write stop: the rules that must hold whatever the application
-- does are CHECK constraints here, not only code.

-- ---- Tenant policy --------------------------------------------------------

ALTER TABLE "Tenant"
  ADD COLUMN "privilegedChangeClasses" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "breakGlassActivationDelayMinutes" INTEGER NOT NULL DEFAULT 60;

-- Only the classes that are implemented end to end. A class the code does not
-- gate would read as protection that does not exist.
ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_privileged_change_classes_check" CHECK (
  "privilegedChangeClasses" <@ ARRAY['role_grant', 'admin_token', 'auth_policy', 'webhook_endpoint']::TEXT[]
);
ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_break_glass_delay_check" CHECK (
  "breakGlassActivationDelayMinutes" BETWEEN 15 AND 1440
);

-- ---- Sessions minted under a break-glass activation ------------------------

ALTER TABLE "Session" ADD COLUMN "breakGlassActivationId" UUID;
CREATE INDEX "Session_breakGlassActivationId_idx" ON "Session"("breakGlassActivationId")
  WHERE "breakGlassActivationId" IS NOT NULL;

-- ---- Privileged change requests ------------------------------------------

CREATE TABLE "PrivilegedChangeRequest" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "changeClass" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "targetType" TEXT NOT NULL,
  "targetId" TEXT,
  "summary" TEXT NOT NULL,
  "proposed" JSONB NOT NULL,
  "baseRevision" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "requestedByUserId" UUID NOT NULL,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "decidedByUserId" UUID,
  "decidedAt" TIMESTAMP(3),
  "deciderStepUpAt" TIMESTAMP(3),
  "decisionNote" TEXT,
  "closedReason" TEXT,
  "result" JSONB,

  CONSTRAINT "PrivilegedChangeRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PrivilegedChangeRequest_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PrivilegedChangeRequest_status_check" CHECK ("status" IN (
    'pending', 'applied', 'rejected', 'withdrawn', 'expired', 'invalidated'
  )),
  CONSTRAINT "PrivilegedChangeRequest_class_check" CHECK ("changeClass" IN (
    'role_grant', 'admin_token', 'auth_policy', 'webhook_endpoint', 'change_control'
  )),
  CONSTRAINT "PrivilegedChangeRequest_revision_check" CHECK ("baseRevision" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "PrivilegedChangeRequest_reason_check" CHECK (char_length(btrim("reason")) >= 10),
  CONSTRAINT "PrivilegedChangeRequest_window_check" CHECK ("expiresAt" > "requestedAt"),
  -- Four eyes, where no code path can forget it: whoever decides is never
  -- whoever asked.
  CONSTRAINT "PrivilegedChangeRequest_four_eyes" CHECK (
    "decidedByUserId" IS NULL OR "decidedByUserId" <> "requestedByUserId"
  ),
  -- A decision is all-or-nothing, and only approved or rejected requests
  -- carry one.
  CONSTRAINT "PrivilegedChangeRequest_decision_complete" CHECK (
    ("status" IN ('applied', 'rejected') AND "decidedByUserId" IS NOT NULL AND "decidedAt" IS NOT NULL)
    OR ("status" NOT IN ('applied', 'rejected') AND "decidedByUserId" IS NULL)
  ),
  -- An applied change carries its step-up evidence, and that evidence is
  -- fresh: the approver's console session was at most ten minutes old.
  CONSTRAINT "PrivilegedChangeRequest_applied_step_up" CHECK (
    "status" <> 'applied' OR (
      "deciderStepUpAt" IS NOT NULL
      AND "deciderStepUpAt" <= "decidedAt"
      AND "decidedAt" - "deciderStepUpAt" <= INTERVAL '10 minutes'
    )
  )
);

CREATE INDEX "PrivilegedChangeRequest_tenantId_status_idx" ON "PrivilegedChangeRequest"("tenantId", "status");
CREATE INDEX "PrivilegedChangeRequest_tenantId_requestedAt_idx" ON "PrivilegedChangeRequest"("tenantId", "requestedAt");

ALTER TABLE "PrivilegedChangeRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PrivilegedChangeRequest" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "PrivilegedChangeRequest"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- ---- Break-glass accounts ------------------------------------------------

CREATE TABLE "BreakGlassAccount" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "credentialHash" TEXT NOT NULL,
  "designatedByUserId" UUID NOT NULL,
  "designatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "credentialIssuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "BreakGlassAccount_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BreakGlassAccount_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "BreakGlassAccount_hash_check" CHECK ("credentialHash" ~ '^[a-f0-9]{64}$'),
  -- Nobody designates their own emergency account.
  CONSTRAINT "BreakGlassAccount_not_self" CHECK ("designatedByUserId" <> "userId")
);

CREATE UNIQUE INDEX "BreakGlassAccount_tenantId_userId_key" ON "BreakGlassAccount"("tenantId", "userId");
CREATE INDEX "BreakGlassAccount_tenantId_idx" ON "BreakGlassAccount"("tenantId");

ALTER TABLE "BreakGlassAccount" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BreakGlassAccount" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "BreakGlassAccount"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- ---- Break-glass activations ---------------------------------------------

CREATE TABLE "BreakGlassActivation" (
  "id" UUID NOT NULL,
  "tenantId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "reason" TEXT NOT NULL,
  "durationMinutes" INTEGER NOT NULL,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "requestedFromIp" TEXT,
  "activatesAt" TIMESTAMP(3) NOT NULL,
  "activatedAt" TIMESTAMP(3),
  "activatedBy" TEXT,
  "approvedByUserId" UUID,
  "approverStepUpAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  "endedAt" TIMESTAMP(3),
  "endedByUserId" UUID,
  "reviewStatus" TEXT NOT NULL DEFAULT 'not_due',
  "reviewedByUserId" UUID,
  "reviewedAt" TIMESTAMP(3),
  "reviewerStepUpAt" TIMESTAMP(3),
  "reviewNotes" TEXT,

  CONSTRAINT "BreakGlassActivation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BreakGlassActivation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "BreakGlassActivation_status_check" CHECK ("status" IN ('pending', 'active', 'ended', 'expired', 'cancelled')),
  CONSTRAINT "BreakGlassActivation_review_status_check" CHECK ("reviewStatus" IN ('not_due', 'pending', 'completed')),
  CONSTRAINT "BreakGlassActivation_reason_check" CHECK (char_length(btrim("reason")) >= 20),
  -- Time-bound by construction: fifteen minutes to four hours.
  CONSTRAINT "BreakGlassActivation_duration_check" CHECK ("durationMinutes" BETWEEN 15 AND 240),
  CONSTRAINT "BreakGlassActivation_activated_by_check" CHECK ("activatedBy" IS NULL OR "activatedBy" IN ('delay', 'approval')),
  -- The second person is never the emergency account itself.
  CONSTRAINT "BreakGlassActivation_approver_not_self" CHECK ("approvedByUserId" IS NULL OR "approvedByUserId" <> "userId"),
  CONSTRAINT "BreakGlassActivation_reviewer_not_self" CHECK ("reviewedByUserId" IS NULL OR "reviewedByUserId" <> "userId"),
  -- Early approval carries its step-up evidence.
  CONSTRAINT "BreakGlassActivation_approval_complete" CHECK (
    ("approvedByUserId" IS NULL AND "approverStepUpAt" IS NULL)
    OR ("approvedByUserId" IS NOT NULL AND "approverStepUpAt" IS NOT NULL AND "activatedBy" = 'approval')
  ),
  -- An activation that took effect has a bounded window.
  CONSTRAINT "BreakGlassActivation_window_check" CHECK (
    "status" IN ('pending', 'cancelled')
    OR ("activatedAt" IS NOT NULL AND "expiresAt" IS NOT NULL AND "activatedBy" IS NOT NULL
        AND "expiresAt" <= "activatedAt" + ("durationMinutes" * INTERVAL '1 minute'))
  ),
  -- Every activation that took effect owes a review once it is over.
  CONSTRAINT "BreakGlassActivation_review_owed" CHECK (
    "status" NOT IN ('ended', 'expired') OR "reviewStatus" IN ('pending', 'completed')
  ),
  CONSTRAINT "BreakGlassActivation_review_complete" CHECK (
    ("reviewStatus" <> 'completed' AND "reviewedByUserId" IS NULL)
    OR ("reviewStatus" = 'completed' AND "reviewedByUserId" IS NOT NULL AND "reviewedAt" IS NOT NULL
        AND "reviewerStepUpAt" IS NOT NULL AND char_length(btrim(coalesce("reviewNotes", ''))) >= 20)
  )
);

CREATE INDEX "BreakGlassActivation_tenantId_status_idx" ON "BreakGlassActivation"("tenantId", "status");
CREATE INDEX "BreakGlassActivation_tenantId_userId_idx" ON "BreakGlassActivation"("tenantId", "userId");
-- One open activation per account at a time.
CREATE UNIQUE INDEX "BreakGlassActivation_one_open"
  ON "BreakGlassActivation"("tenantId", "userId")
  WHERE "status" IN ('pending', 'active');

ALTER TABLE "BreakGlassActivation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "BreakGlassActivation" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "BreakGlassActivation"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
