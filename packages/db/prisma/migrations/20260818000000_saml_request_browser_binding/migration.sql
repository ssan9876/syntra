-- Binds a parked AuthnRequest to the browser that created it.
--
-- Without this, `handle` is an unbound bearer credential: an unsigned
-- AuthnRequest for any registered service provider entity ID returns a 302
-- whose Location carries the handle, and feeding that URL to a logged-in
-- victim mints an assertion for the victim. `browserBinding` holds the
-- SHA-256 of a nonce set as a cookie at park time and required to match at
-- `/saml/continue`.
--
-- NOT NULL with no default, and existing rows are deleted rather than
-- back-filled. A `SamlAuthnRequest` is an unfinished sign-in with a ten-minute
-- lifetime; there is no such thing as one worth preserving across a
-- deployment, and a default would be a value every row shared -- which is
-- exactly the unbound handle this column exists to end.
DELETE FROM "SamlAuthnRequest";

ALTER TABLE "SamlAuthnRequest" ADD COLUMN "browserBinding" TEXT NOT NULL;
