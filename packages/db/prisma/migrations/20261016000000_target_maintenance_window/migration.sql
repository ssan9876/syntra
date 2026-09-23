ALTER TABLE "TargetSystem"
  ADD COLUMN "maintenanceWindowEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "maintenanceWindowDays" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
  ADD COLUMN "maintenanceWindowStartMinute" INTEGER,
  ADD COLUMN "maintenanceWindowDurationMinutes" INTEGER;

ALTER TABLE "TargetSystem" ADD CONSTRAINT "TargetSystem_maintenance_window_valid" CHECK (
  (NOT "maintenanceWindowEnabled") OR (
    cardinality("maintenanceWindowDays") BETWEEN 1 AND 7 AND
    "maintenanceWindowDays" <@ ARRAY[0,1,2,3,4,5,6]::INTEGER[] AND
    "maintenanceWindowStartMinute" BETWEEN 0 AND 1439 AND
    "maintenanceWindowDurationMinutes" BETWEEN 1 AND 1440
  )
);
