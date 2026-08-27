-- A one-time code mailed to the address on the account.
--
-- Off by default at the tenant. A code mailed to the address on the account is
-- a weak second factor wherever that same mailbox can also reset the password:
-- an attacker holding the mailbox holds both. It is a real answer for people
-- with no phone and no security key, and the organizations where that is true
-- should be the ones turning it on.
ALTER TABLE "Tenant" ADD COLUMN "emailOtpEnabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "EmailOtpCredential" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "codeHash" TEXT,
    "expiresAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailOtpCredential_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EmailOtpCredential_userId_key" ON "EmailOtpCredential"("userId");
CREATE INDEX "EmailOtpCredential_tenantId_idx" ON "EmailOtpCredential"("tenantId");

ALTER TABLE "EmailOtpCredential" ADD CONSTRAINT email_otp_attempts CHECK ("attempts" >= 0);
-- A hash without an expiry is a code that never dies. The two are written
-- together or not at all.
ALTER TABLE "EmailOtpCredential" ADD CONSTRAINT email_otp_code_has_expiry
  CHECK (("codeHash" IS NULL) = ("expiresAt" IS NULL));

-- Row-level security.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['EmailOtpCredential'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid) WITH CHECK ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid)',
      t);
  END LOOP;
END $$;
