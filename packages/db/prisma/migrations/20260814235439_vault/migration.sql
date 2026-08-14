-- CreateTable
CREATE TABLE "Secret" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "iv" BYTEA NOT NULL,
    "tag" BYTEA NOT NULL,
    "wrappedDek" BYTEA NOT NULL,
    "dekIv" BYTEA NOT NULL,
    "dekTag" BYTEA NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Secret_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Secret_tenantId_idx" ON "Secret"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Secret_tenantId_name_key" ON "Secret"("tenantId", "name");

-- Row-level security.
ALTER TABLE "Secret" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Secret" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "Secret"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
