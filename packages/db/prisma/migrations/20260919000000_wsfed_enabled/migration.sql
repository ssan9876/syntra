-- Whether a SAML application may also sign in over WS-Federation.
--
-- A flag on SamlConfig rather than a model of its own: WS-Fed reuses every
-- field there — the realm is the SP entity ID, the reply URL is checked
-- against the registered ACS URLs, and the token is the same signed assertion.
--
-- Default false. WS-Fed carries no request signature, so an application that
-- never asked for it does not get a second unauthenticated way in.
ALTER TABLE "SamlConfig" ADD COLUMN "wsFedEnabled" BOOLEAN NOT NULL DEFAULT false;
