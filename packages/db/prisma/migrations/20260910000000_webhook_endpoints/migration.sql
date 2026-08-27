-- Outbound webhooks: an endpoint per receiver, and a delivery per (event,
-- endpoint) pair so that two receivers fail independently of each other.
--
-- No signing secret here. It is written to `Secret`, sealed under the master
-- key, and named `webhook:<endpoint id>`.

CREATE TABLE "WebhookEndpoint" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "events" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookEndpoint_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WebhookEndpoint_tenantId_name_key" ON "WebhookEndpoint"("tenantId", "name");
CREATE INDEX "WebhookEndpoint_tenantId_idx" ON "WebhookEndpoint"("tenantId");

CREATE TABLE "WebhookDelivery" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "endpointId" UUID NOT NULL,
    "event" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL,
    "deliveredAt" TIMESTAMP(3),
    "lastStatus" INTEGER,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WebhookDelivery_tenantId_idx" ON "WebhookDelivery"("tenantId");
CREATE INDEX "WebhookDelivery_endpointId_idx" ON "WebhookDelivery"("endpointId");
-- The sender's read: undelivered rows that are due, oldest first.
CREATE INDEX "WebhookDelivery_tenantId_deliveredAt_nextAttemptAt_idx"
  ON "WebhookDelivery"("tenantId", "deliveredAt", "nextAttemptAt");

-- Cascade, unlike most foreign keys here. A delivery is addressed to an
-- endpoint and means nothing without one -- there is no "who was this for?"
-- question left to answer once the endpoint is gone, which is the reason the
-- audit-adjacent tables keep their rows.
ALTER TABLE "WebhookDelivery"
  ADD CONSTRAINT "WebhookDelivery_endpointId_fkey"
  FOREIGN KEY ("endpointId") REFERENCES "WebhookEndpoint"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WebhookDelivery" ADD CONSTRAINT webhook_delivery_attempts CHECK ("attempts" >= 0);

-- Row-level security.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['WebhookEndpoint', 'WebhookDelivery'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid) WITH CHECK ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid)',
      t);
  END LOOP;
END $$;
