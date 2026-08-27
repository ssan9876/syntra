-- What a tenant calls itself on the screens their staff actually see.
--
-- All four nullable, and null everywhere means Syntra's own name and palette —
-- every existing tenant looks exactly as it did.
--
-- The logo is a `data:` URI rather than a path or a URL. This product is
-- installed on premises and often air-gapped, and the sign-in page is the one
-- page that has to render when everything else is unreachable.
ALTER TABLE "Tenant" ADD COLUMN "brandName" TEXT;
ALTER TABLE "Tenant" ADD COLUMN "brandLogo" TEXT;
ALTER TABLE "Tenant" ADD COLUMN "brandPrimary" TEXT;
ALTER TABLE "Tenant" ADD COLUMN "brandAccent" TEXT;
