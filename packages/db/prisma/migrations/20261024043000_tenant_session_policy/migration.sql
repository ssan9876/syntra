-- Tenant session policy: configurable idle and absolute lifetimes per session
-- scope, and a phishing-resistant requirement for console elevation.
--
-- Every default is the value `session-service.ts` hardcoded before this
-- migration, so no tenant that exists today changes behaviour when it runs:
-- portal 60 minutes idle / 12 hours absolute, admin 15 minutes idle / 2 hours
-- absolute, and the WebAuthn requirement off.
--
-- Columns on `Tenant`, beside `adminMfaRequired` and the lockout policy,
-- rather than a table of their own. `Tenant` is not a tenant-owned table (it
-- is the tenant), so there is no RLS policy to add: every reader already
-- reaches it by the id `withTenant` bound.
ALTER TABLE "Tenant" ADD COLUMN "portalSessionIdleMinutes" INTEGER NOT NULL DEFAULT 60;
ALTER TABLE "Tenant" ADD COLUMN "portalSessionAbsoluteMinutes" INTEGER NOT NULL DEFAULT 720;
ALTER TABLE "Tenant" ADD COLUMN "adminSessionIdleMinutes" INTEGER NOT NULL DEFAULT 15;
ALTER TABLE "Tenant" ADD COLUMN "adminSessionAbsoluteMinutes" INTEGER NOT NULL DEFAULT 120;
ALTER TABLE "Tenant" ADD COLUMN "adminWebauthnRequired" BOOLEAN NOT NULL DEFAULT false;

-- The platform bounds, enforced by the database as well as by the request
-- schema. A row written by SQL, a seed or a future route that forgets the
-- contract must still not be able to hold an administrative session open for
-- a week. The numbers are `SESSION_POLICY_BOUNDS` in
-- `packages/contracts/src/tenant.ts`; see there for why each is what it is.
ALTER TABLE "Tenant" ADD CONSTRAINT tenant_portal_session_idle
  CHECK ("portalSessionIdleMinutes" BETWEEN 5 AND 1440);
ALTER TABLE "Tenant" ADD CONSTRAINT tenant_portal_session_absolute
  CHECK ("portalSessionAbsoluteMinutes" BETWEEN 60 AND 43200);
ALTER TABLE "Tenant" ADD CONSTRAINT tenant_admin_session_idle
  CHECK ("adminSessionIdleMinutes" BETWEEN 5 AND 60);
ALTER TABLE "Tenant" ADD CONSTRAINT tenant_admin_session_absolute
  CHECK ("adminSessionAbsoluteMinutes" BETWEEN 15 AND 720);

-- An idle timeout longer than the absolute lifetime is not a policy anybody
-- means: the idle rule could never fire. Refused rather than silently
-- clamped, so the number an operator reads back is the number that applies.
ALTER TABLE "Tenant" ADD CONSTRAINT tenant_portal_session_idle_within_absolute
  CHECK ("portalSessionIdleMinutes" <= "portalSessionAbsoluteMinutes");
ALTER TABLE "Tenant" ADD CONSTRAINT tenant_admin_session_idle_within_absolute
  CHECK ("adminSessionIdleMinutes" <= "adminSessionAbsoluteMinutes");

-- An administrative session may never outlast a portal one. Elevation is the
-- stronger, rarer state, and a tenant whose console session outlived its
-- portal session would have the two backwards.
ALTER TABLE "Tenant" ADD CONSTRAINT tenant_admin_session_not_longer_than_portal
  CHECK ("adminSessionAbsoluteMinutes" <= "portalSessionAbsoluteMinutes");
