-- Binds an in-flight upstream login to the browser that started it.
--
-- The identity-provider half of this branch closed exactly this defect on
-- `SamlAuthnRequest`; the consuming half has the identical shape and had
-- nothing. Without the column, `state` (OIDC) and `RelayState` (SAML) identify
-- an in-flight login and no particular browser: an attacker signs in at the
-- upstream as themselves, keeps the callback URL instead of following it, and
-- sends it to a victim. The PKCE verifier and the expected AuthnRequest ID
-- come off the ROW rather than the browser, so every check passes and the
-- victim ends up holding a Syntra session for the attacker's account --
-- login CSRF, RFC 6819 section 4.4.1.8.
--
-- NOT NULL with no default, and existing rows are deleted rather than
-- back-filled, for the same reason the SamlAuthnRequest migration gives: a
-- FederationRequest is an unfinished sign-in with a ten-minute lifetime, there
-- is no such thing as one worth preserving across a deployment, and a default
-- would be a value every row shared -- which is the unbound ticket this column
-- exists to end.
DELETE FROM "FederationRequest";

ALTER TABLE "FederationRequest" ADD COLUMN "browserBinding" TEXT NOT NULL;
