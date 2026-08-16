-- Ruling A2-10: a newly registered service provider requires signed
-- AuthnRequests unless an administrator says otherwise.
--
-- An unsigned AuthnRequest is something anyone can send. A logged-in victim
-- who follows a link to `/saml/sso` carrying an attacker's unsigned request
-- has an assertion minted for them and auto-posted to the service provider's
-- real assertion consumer service. That path parks and completes inside one
-- request, so the browser binding on `SamlAuthnRequest` cannot reach it, and
-- the only remaining control is the service provider validating
-- `InResponseTo` -- which Syntra cannot rely on. Requiring a signature makes
-- the attacker need the service provider's signing key.
--
-- SET DEFAULT ONLY. Existing rows keep whatever value they carry: choosing
-- what a new registration inherits is one decision, and changing the
-- behaviour of a deployment that already works is a different one that is not
-- being made here. A `SET DEFAULT` touches no row -- it is metadata on the
-- column, applied to future inserts that omit it.
ALTER TABLE "SamlConfig"
  ALTER COLUMN "wantAuthnRequestsSigned" SET DEFAULT true;
