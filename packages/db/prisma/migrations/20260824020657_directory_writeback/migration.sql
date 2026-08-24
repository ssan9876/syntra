-- AlterTable
ALTER TABLE "DirectorySource" ADD COLUMN     "writebackDisable" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "writebackEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "writebackPassword" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Person" ADD COLUMN     "departureOverride" TIMESTAMP(3),
ADD COLUMN     "departureOverrideBy" UUID,
ADD COLUMN     "departureOverrideNote" TEXT;
