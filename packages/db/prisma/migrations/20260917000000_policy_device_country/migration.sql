-- Device and country conditions on an authentication policy rule.
--
-- Both default to empty, which is unconstrained — every existing rule keeps
-- exactly the meaning it had.
--
-- Country is read from a header the deployment names rather than from a GeoIP
-- database: that is a licensed, monthly-updated binary, and bundling one into
-- an air-gapped installation means shipping stale data or requiring a feed
-- from a product whose whole point is running without one.
ALTER TABLE "AuthPolicyRule" ADD COLUMN "devicePlatforms" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "AuthPolicyRule" ADD COLUMN "countries" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
