-- How long after departure a person is deleted for good. Off (null) on every
-- existing tenant: switching automatic deletion on is a decision for a holder
-- of person.purge, never a side effect of an update.

ALTER TABLE "Tenant" ADD COLUMN "personPurgeAfterDays" INTEGER;
ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_personPurgeAfterDays_range"
  CHECK ("personPurgeAfterDays" IS NULL OR "personPurgeAfterDays" BETWEEN 1 AND 3650);
