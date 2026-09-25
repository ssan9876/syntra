-- Where somebody who cannot sign in, or cannot find an application, is sent.
--
-- Both nullable, and null means no link -- every existing tenant looks exactly
-- as it did, with the generic "contact your IT administrator" line. The URL is
-- restricted to https: and mailto: in the application (`isSupportUrl`), not
-- here: a CHECK constraint would have to restate a URL parser in SQL, and the
-- value is re-checked on render anyway.
ALTER TABLE "Tenant" ADD COLUMN "brandSupportUrl" TEXT;
ALTER TABLE "Tenant" ADD COLUMN "brandSupportLabel" TEXT;
