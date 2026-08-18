-- The staleness check's own timestamp, separate from `startedAt`.
--
-- Nullable and with no default: an existing row's last sign of life is not
-- known, and stamping every one of them with the migration's clock would
-- declare every genuinely abandoned run fresh. Readers fall back to
-- `startedAt`, which is the column they used before this one existed.
ALTER TABLE "ProvisionRun" ADD COLUMN "lastProgressAt" TIMESTAMP(3);
