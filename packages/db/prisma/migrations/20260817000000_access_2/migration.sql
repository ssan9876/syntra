-- AlterTable
ALTER TABLE "AuthPolicyRule" ADD COLUMN     "loginDomains" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "upstreamIdpId" UUID;

-- CreateTable
CREATE TABLE "SamlConfig" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "applicationId" UUID NOT NULL,
    "spEntityId" TEXT NOT NULL,
    "acsUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "defaultAcsUrl" TEXT,
    "acsBinding" TEXT NOT NULL DEFAULT 'HTTP-POST',
    "nameIdFormat" TEXT NOT NULL DEFAULT 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    "nameIdClaim" TEXT,
    "spCertificates" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "wantAuthnRequestsSigned" BOOLEAN NOT NULL DEFAULT false,
    "encryptAssertions" BOOLEAN NOT NULL DEFAULT false,
    "encryptionCertificate" TEXT,
    "sloUrl" TEXT,
    "sloBinding" TEXT NOT NULL DEFAULT 'HTTP-POST',
    "allowIdpInitiated" BOOLEAN NOT NULL DEFAULT false,
    "assertionLifetimeMs" INTEGER NOT NULL DEFAULT 300000,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SamlConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OidcClient" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "applicationId" UUID NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientSecretHash" TEXT NOT NULL,
    "redirectUris" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "postLogoutRedirectUris" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "grantTypes" TEXT[] DEFAULT ARRAY['authorization_code', 'refresh_token']::TEXT[],
    "clientCredentialsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "scopes" TEXT[] DEFAULT ARRAY['openid', 'profile', 'email']::TEXT[],
    "requirePkce" BOOLEAN NOT NULL DEFAULT true,
    "tokenEndpointAuthMethod" TEXT NOT NULL DEFAULT 'client_secret_basic',
    "idTokenSignedResponseAlg" TEXT NOT NULL DEFAULT 'RS256',
    "accessTokenTtlSeconds" INTEGER NOT NULL DEFAULT 3600,
    "refreshTokenTtlSeconds" INTEGER NOT NULL DEFAULT 1209600,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OidcClient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClaimMapping" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "applicationId" UUID NOT NULL,
    "protocol" TEXT NOT NULL,
    "claimName" TEXT NOT NULL,
    "nameFormat" TEXT NOT NULL DEFAULT 'urn:oasis:names:tc:SAML:2.0:attrname-format:basic',
    "sourceKind" TEXT NOT NULL,
    "sourceField" TEXT,
    "contractStrategy" TEXT NOT NULL DEFAULT 'primary',
    "literalValue" TEXT,
    "releaseScope" TEXT,
    "multiValued" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClaimMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UpstreamIdp" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "protocol" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "issuerUrl" TEXT,
    "clientId" TEXT,
    "clientSecretName" TEXT,
    "scopes" TEXT[] DEFAULT ARRAY['openid', 'profile', 'email']::TEXT[],
    "idpEntityId" TEXT,
    "ssoUrl" TEXT,
    "idpSloUrl" TEXT,
    "ssoBinding" TEXT NOT NULL DEFAULT 'HTTP-Redirect',
    "idpCertificates" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "wantAssertionsSigned" BOOLEAN NOT NULL DEFAULT true,
    "loginAttribute" TEXT NOT NULL DEFAULT 'preferred_username',
    "emailAttribute" TEXT NOT NULL DEFAULT 'email',
    "displayNameAttribute" TEXT NOT NULL DEFAULT 'name',
    "groupsAttribute" TEXT,
    "createUsers" BOOLEAN NOT NULL DEFAULT true,
    "refreshOnLogin" BOOLEAN NOT NULL DEFAULT true,
    "defaultOrgUnitId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UpstreamIdp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UpstreamLink" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "upstreamIdpId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "subject" TEXT NOT NULL,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UpstreamLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FederationRequest" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "upstreamIdpId" UUID NOT NULL,
    "state" TEXT NOT NULL,
    "nonce" TEXT,
    "verifierName" TEXT,
    "returnTo" TEXT NOT NULL,
    "applicationId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "FederationRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SigningKey" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "kid" TEXT NOT NULL,
    "alg" TEXT NOT NULL DEFAULT 'RS256',
    "publicJwk" JSONB NOT NULL,
    "certificate" TEXT,
    "secretName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "notBefore" TIMESTAMP(3) NOT NULL,
    "notAfter" TIMESTAMP(3) NOT NULL,
    "retiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SigningKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OidcArtifact" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "model" TEXT NOT NULL,
    "artifactId" TEXT NOT NULL,
    "uid" TEXT,
    "userCode" TEXT,
    "grantId" TEXT,
    "accountId" TEXT,
    "payload" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OidcArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SamlSsoSession" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "applicationId" UUID NOT NULL,
    "nameId" TEXT NOT NULL,
    "sessionIndex" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "SamlSsoSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthorizationDecision" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "clientId" TEXT NOT NULL,
    "interactionUid" TEXT NOT NULL,
    "satisfiedFactor" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "AuthorizationDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SamlAuthnRequest" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "applicationId" UUID NOT NULL,
    "handle" TEXT NOT NULL,
    "requestId" TEXT,
    "acsUrl" TEXT NOT NULL,
    "relayState" TEXT,
    "forceAuthn" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "SamlAuthnRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SamlConfig_applicationId_key" ON "SamlConfig"("applicationId");

-- CreateIndex
CREATE INDEX "SamlConfig_tenantId_idx" ON "SamlConfig"("tenantId");

-- CreateIndex
CREATE INDEX "SamlConfig_tenantId_spEntityId_idx" ON "SamlConfig"("tenantId", "spEntityId");

-- CreateIndex
CREATE UNIQUE INDEX "OidcClient_applicationId_key" ON "OidcClient"("applicationId");

-- CreateIndex
CREATE INDEX "OidcClient_tenantId_idx" ON "OidcClient"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "OidcClient_tenantId_clientId_key" ON "OidcClient"("tenantId", "clientId");

-- CreateIndex
CREATE INDEX "ClaimMapping_tenantId_idx" ON "ClaimMapping"("tenantId");

-- CreateIndex
CREATE INDEX "ClaimMapping_applicationId_idx" ON "ClaimMapping"("applicationId");

-- CreateIndex
CREATE UNIQUE INDEX "ClaimMapping_applicationId_protocol_claimName_key" ON "ClaimMapping"("applicationId", "protocol", "claimName");

-- CreateIndex
CREATE INDEX "UpstreamIdp_tenantId_idx" ON "UpstreamIdp"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "UpstreamIdp_tenantId_slug_key" ON "UpstreamIdp"("tenantId", "slug");

-- CreateIndex
CREATE INDEX "UpstreamLink_tenantId_idx" ON "UpstreamLink"("tenantId");

-- CreateIndex
CREATE INDEX "UpstreamLink_userId_idx" ON "UpstreamLink"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "UpstreamLink_upstreamIdpId_subject_key" ON "UpstreamLink"("upstreamIdpId", "subject");

-- CreateIndex
CREATE INDEX "FederationRequest_tenantId_idx" ON "FederationRequest"("tenantId");

-- CreateIndex
CREATE INDEX "FederationRequest_tenantId_state_idx" ON "FederationRequest"("tenantId", "state");

-- CreateIndex
CREATE INDEX "SigningKey_tenantId_idx" ON "SigningKey"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "SigningKey_tenantId_kind_kid_key" ON "SigningKey"("tenantId", "kind", "kid");

-- CreateIndex
CREATE INDEX "OidcArtifact_tenantId_idx" ON "OidcArtifact"("tenantId");

-- CreateIndex
CREATE INDEX "OidcArtifact_tenantId_grantId_idx" ON "OidcArtifact"("tenantId", "grantId");

-- CreateIndex
CREATE UNIQUE INDEX "OidcArtifact_tenantId_model_artifactId_key" ON "OidcArtifact"("tenantId", "model", "artifactId");

-- CreateIndex
CREATE INDEX "SamlSsoSession_tenantId_idx" ON "SamlSsoSession"("tenantId");

-- CreateIndex
CREATE INDEX "SamlSsoSession_sessionId_idx" ON "SamlSsoSession"("sessionId");

-- CreateIndex
CREATE INDEX "AuthorizationDecision_tenantId_idx" ON "AuthorizationDecision"("tenantId");

-- CreateIndex
CREATE INDEX "AuthorizationDecision_tenantId_userId_clientId_idx" ON "AuthorizationDecision"("tenantId", "userId", "clientId");

-- CreateIndex
CREATE INDEX "SamlAuthnRequest_tenantId_idx" ON "SamlAuthnRequest"("tenantId");

-- CreateIndex
CREATE INDEX "SamlAuthnRequest_tenantId_handle_idx" ON "SamlAuthnRequest"("tenantId", "handle");

-- AddForeignKey
ALTER TABLE "SamlConfig" ADD CONSTRAINT "SamlConfig_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OidcClient" ADD CONSTRAINT "OidcClient_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClaimMapping" ADD CONSTRAINT "ClaimMapping_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UpstreamLink" ADD CONSTRAINT "UpstreamLink_upstreamIdpId_fkey" FOREIGN KEY ("upstreamIdpId") REFERENCES "UpstreamIdp"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Row-level security. FORCE subjects the owning role to its own policies;
-- NULLIF is required because a GUC set with set_config(..., true) reverts to
-- an empty string, not NULL, when the transaction ends.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'SamlConfig','OidcClient','ClaimMapping','UpstreamIdp','UpstreamLink',
    'FederationRequest','SigningKey','OidcArtifact','SamlSsoSession',
    'SamlAuthnRequest','AuthorizationDecision'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid) WITH CHECK ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid)',
      t);
  END LOOP;
END $$;

-- PostgreSQL treats NULL as distinct from NULL, so a uniqueness rule that
-- involves a nullable column has to be a partial index or it constrains
-- nothing at all.

-- At most one active signing key per tenant and kind. 'outgoing' and
-- 'retired' rows are deliberately unconstrained: a rollover needs the
-- outgoing key to sit beside the active one.
CREATE UNIQUE INDEX signing_key_one_active
  ON "SigningKey" ("tenantId", "kind") WHERE "status" = 'active';

-- oidc-provider looks artifacts up by uid (Session, Interaction) and by
-- userCode (DeviceCode). Both columns are null on every other model, so a
-- plain UNIQUE would constrain neither.
CREATE UNIQUE INDEX oidc_artifact_unique_uid
  ON "OidcArtifact" ("tenantId", "model", "uid") WHERE "uid" IS NOT NULL;
CREATE UNIQUE INDEX oidc_artifact_unique_user_code
  ON "OidcArtifact" ("tenantId", "model", "userCode") WHERE "userCode" IS NOT NULL;

-- One live federation request per state. A consumed row must not block a
-- later request that happens to draw the same value.
CREATE UNIQUE INDEX federation_request_one_live
  ON "FederationRequest" ("tenantId", "state") WHERE "consumedAt" IS NULL;

-- One live SSO session per Syntra session and application, so a repeat launch
-- refreshes the row rather than accumulating rows single logout would notify
-- twice.
CREATE UNIQUE INDEX saml_sso_session_one_live
  ON "SamlSsoSession" ("sessionId", "applicationId") WHERE "endedAt" IS NULL;

-- One live parked AuthnRequest per handle. Consuming it is what stops a
-- captured handle being replayed into a second assertion.
CREATE UNIQUE INDEX saml_authn_request_one_live
  ON "SamlAuthnRequest" ("tenantId", "handle") WHERE "consumedAt" IS NULL;

-- One live decision per interaction. The interaction route writes one row per
-- resolved interaction, and the token endpoint spends it; a second write for
-- the same interaction would be a second token from one decision.
CREATE UNIQUE INDEX authorization_decision_one_live
  ON "AuthorizationDecision" ("tenantId", "interactionUid") WHERE "consumedAt" IS NULL;

-- A blank SP entity ID makes every audience restriction match.
ALTER TABLE "SamlConfig" ADD CONSTRAINT saml_config_entity_id_present
  CHECK (length("spEntityId") > 0);

-- A federate rule with no upstream cannot be honoured, and a non-federate
-- rule carrying one is a rule someone half-edited.
ALTER TABLE "AuthPolicyRule" ADD CONSTRAINT auth_policy_rule_federate_target CHECK (
  ("outcome" = 'federate') = ("upstreamIdpId" IS NOT NULL)
);
