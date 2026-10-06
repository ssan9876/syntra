-- Puts a restored database on hold: the API starts no background work and
-- writes nothing to target systems until an administrator resumes it from
-- the console. Run it after pg_restore and before the API starts.
--
--   psql -v ON_ERROR_STOP=1 -v backup_name=<name> -v app_role=syntra_app \
--        -U <superuser> -d <database> -f ops/restore-hold.sql
--
-- The table is created here when the backup predates it (the migration that
-- adds it is IF NOT EXISTS for this reason), and handed to the role the API
-- connects as, which owns every other table.

CREATE TABLE IF NOT EXISTS "RestoreHold" (
    "id" UUID NOT NULL,
    "backupName" TEXT NOT NULL,
    "backupTakenAt" TIMESTAMP(3),
    "backupVersion" TEXT,
    "restoredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMP(3),

    CONSTRAINT "RestoreHold_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "RestoreHold_releasedAt_idx" ON "RestoreHold"("releasedAt");
ALTER TABLE "RestoreHold" OWNER TO :"app_role";

INSERT INTO "RestoreHold" ("id", "backupName") VALUES (gen_random_uuid(), :'backup_name');
