-- A person's business email is unique per tenant, case-insensitively, and the
-- logins linked to that person carry it as their own email.
--
-- Each index is created only when the data already satisfies it. An install
-- holding duplicates still migrates; the NOTICE names the index, and the
-- duplicates are found with the query beside it. The application refuses new
-- duplicates either way.

-- Person: one business email per person.
--
--   SELECT "tenantId", lower("businessEmail"), count(*), array_agg("id")
--     FROM "Person" WHERE "businessEmail" IS NOT NULL
--     GROUP BY 1, 2 HAVING count(*) > 1;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "Person"
     WHERE "businessEmail" IS NOT NULL
     GROUP BY "tenantId", lower("businessEmail")
    HAVING count(*) > 1
  ) THEN
    RAISE NOTICE 'Person_tenantId_lower_businessEmail_key not created: two or more people share a business email';
  ELSE
    CREATE UNIQUE INDEX "Person_tenantId_lower_businessEmail_key"
      ON "Person" ("tenantId", lower("businessEmail"))
      WHERE "businessEmail" IS NOT NULL;
  END IF;
END
$$;

-- User: the local-email guard now leaves out logins linked to a person.
--
-- One person may hold two logins (an everyday one and an admin one), and both
-- carry the person's address. The address is unique per person through the
-- index above; this one keeps covering logins that belong to nobody. The new
-- predicate is narrower than the old one, so it cannot find duplicates the old
-- one allowed, but it is guarded the same way.
--
--   SELECT "tenantId", lower("email"), count(*), array_agg("id")
--     FROM "User"
--    WHERE "sourceId" IS NULL AND "status" = 'active' AND "personId" IS NULL
--    GROUP BY 1, 2 HAVING count(*) > 1;
DROP INDEX IF EXISTS "User_tenantId_lower_email_local_key";

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "User"
     WHERE "sourceId" IS NULL AND "status" = 'active' AND "personId" IS NULL
     GROUP BY "tenantId", lower("email")
    HAVING count(*) > 1
  ) THEN
    RAISE NOTICE 'User_tenantId_lower_email_local_key not created: two or more active local accounts share an email';
  ELSE
    CREATE UNIQUE INDEX "User_tenantId_lower_email_local_key"
      ON "User" ("tenantId", lower("email"))
      WHERE "sourceId" IS NULL AND "status" = 'active' AND "personId" IS NULL;
  END IF;
END
$$;
