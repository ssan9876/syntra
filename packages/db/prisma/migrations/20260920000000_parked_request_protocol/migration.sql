-- Which protocol parked this sign-in request.
--
-- On the row rather than looked up from the application: an application may be
-- reachable over both SAML and WS-Federation, and reading the protocol back
-- off configuration would answer a WS-Fed sign-in with a SAML Response the
-- moment somebody enabled SAML on the same application.
--
-- Every existing row is a SAML row, which is what the default says.
ALTER TABLE "SamlAuthnRequest" ADD COLUMN "protocol" TEXT NOT NULL DEFAULT 'saml';
