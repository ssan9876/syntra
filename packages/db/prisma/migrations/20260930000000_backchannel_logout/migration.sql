-- Telling a relying party that a session ended.
--
-- Syntra's single logout has been local: ending a session ends it HERE and
-- answers the service provider that asked, while every other application the
-- person signed into keeps its own session until that session expires. This is
-- the OIDC half of closing that -- a signed logout token, delivered to each
-- relying party that asked to hear about it.

ALTER TABLE "OidcClient" ADD COLUMN "backchannelLogoutUri" TEXT;
ALTER TABLE "OidcClient" ADD COLUMN "backchannelLogoutSessionRequired" BOOLEAN NOT NULL DEFAULT false;

-- Its own table rather than a row in WebhookDelivery: an administrator filters
-- webhook deliveries by event group and configures endpoints per integration,
-- and a logout token has neither. The retry POLICY is shared in code.
CREATE TABLE "LogoutDelivery" (
    "id"            UUID NOT NULL,
    "tenantId"      UUID NOT NULL,
    "clientId"      UUID NOT NULL,
    "token"         TEXT NOT NULL,
    "attempts"      INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL,
    "deliveredAt"   TIMESTAMP(3),
    "lastStatus"    INTEGER,
    "lastError"     TEXT,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LogoutDelivery_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LogoutDelivery_tenantId_idx" ON "LogoutDelivery"("tenantId");
-- The sender's read: this tenant, undelivered, due. One indexed range scan.
CREATE INDEX "LogoutDelivery_tenantId_deliveredAt_nextAttemptAt_idx"
  ON "LogoutDelivery"("tenantId", "deliveredAt", "nextAttemptAt");

ALTER TABLE "LogoutDelivery" ADD CONSTRAINT "LogoutDelivery_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LogoutDelivery" ADD CONSTRAINT "LogoutDelivery_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "OidcClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security. A logout token names a subject and a client, so a row
-- leaking across tenants would leak who signed out of what.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['LogoutDelivery'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid) WITH CHECK ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid)',
      t);
  END LOOP;
END $$;
