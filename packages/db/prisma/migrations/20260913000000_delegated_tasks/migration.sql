-- Delegated tasks: a form somebody may fill in to make one narrow change,
-- without holding the permission that change would normally need.
--
-- The authority is Syntra's, not the runner's. `actionKey` names one entry in
-- a closed library in code -- there is no script and no column that could
-- become one -- and a run is refused when the account it would act on holds a
-- permission the runner does not.

CREATE TABLE "DelegatedTask" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "actionKey" TEXT NOT NULL,
    "formSchema" JSONB NOT NULL DEFAULT '[]',
    "audienceCondition" JSONB,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DelegatedTask_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DelegatedTask_tenantId_name_key" ON "DelegatedTask"("tenantId", "name");
CREATE INDEX "DelegatedTask_tenantId_idx" ON "DelegatedTask"("tenantId");

CREATE TABLE "DelegatedTaskRun" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "runByUserId" UUID NOT NULL,
    "subjectUserId" UUID,
    "values" JSONB NOT NULL DEFAULT '{}',
    "outcome" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DelegatedTaskRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "DelegatedTaskRun_tenantId_idx" ON "DelegatedTaskRun"("tenantId");
CREATE INDEX "DelegatedTaskRun_taskId_createdAt_idx" ON "DelegatedTaskRun"("taskId", "createdAt");

-- The runs go when the task goes. They are still in the audit chain, which is
-- the record that has to outlive everything -- this table is the console's
-- copy, and a run addressed to a task that no longer exists has no screen to
-- appear on.
ALTER TABLE "DelegatedTaskRun"
  ADD CONSTRAINT "DelegatedTaskRun_taskId_fkey"
  FOREIGN KEY ("taskId") REFERENCES "DelegatedTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DelegatedTaskRun" ADD CONSTRAINT delegated_task_run_outcome
  CHECK ("outcome" IN ('success', 'failure', 'refused'));

-- Row-level security.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['DelegatedTask', 'DelegatedTaskRun'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid) WITH CHECK ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid)',
      t);
  END LOOP;
END $$;
