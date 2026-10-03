-- Sign the whole SAML Response as well as the Assertion, per application.
ALTER TABLE "SamlConfig" ADD COLUMN "signResponse" BOOLEAN NOT NULL DEFAULT false;
