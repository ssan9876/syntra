-- CreateTable
CREATE TABLE "Person" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "givenName" TEXT NOT NULL,
    "familyName" TEXT NOT NULL,
    "nameConvention" TEXT NOT NULL DEFAULT 'familyName',
    "businessEmail" TEXT,
    "personalEmail" TEXT,
    "externalId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Person_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contract" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "personId" UUID NOT NULL,
    "sequence" INTEGER NOT NULL DEFAULT 1,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "jobTitle" TEXT,
    "department" TEXT,
    "costCentre" TEXT,
    "employer" TEXT,
    "location" TEXT,
    "managerPersonId" UUID,
    "fte" DECIMAL(4,3),

    CONSTRAINT "Contract_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Person_tenantId_idx" ON "Person"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Person_tenantId_externalId_key" ON "Person"("tenantId", "externalId");

-- CreateIndex
CREATE INDEX "Contract_tenantId_idx" ON "Contract"("tenantId");

-- CreateIndex
CREATE INDEX "Contract_personId_idx" ON "Contract"("personId");

-- CreateIndex
CREATE UNIQUE INDEX "Contract_personId_sequence_key" ON "Contract"("personId", "sequence");

-- AddForeignKey
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security for the identity tables.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['Person','Contract'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid) WITH CHECK ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid)',
      t);
  END LOOP;
END $$;

-- Exactly one primary contract per person.
--
-- The predicate covers ALL of a person's contracts, not only the active ones:
-- a date comparison is not IMMUTABLE and PostgreSQL will not index it. Whether
-- the primary contract is currently in force is a query-time question, which
-- resolveContractForMapping answers explicitly.
CREATE UNIQUE INDEX contract_one_primary_per_person
  ON "Contract" ("personId") WHERE "isPrimary";
