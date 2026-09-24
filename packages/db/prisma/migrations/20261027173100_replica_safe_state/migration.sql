-- Replica-safe state: the two pieces of per-process state that made running
-- more than one API replica incorrect.
--
-- 1. Tenant."oidcConfigGeneration", bumped by trigger whenever anything a
--    cached OIDC Provider was built from changes. Every replica compares it
--    before serving from its cache (packages/protocols provider-factory.ts).
--
-- 2. "RateLimitBucket", the shared fixed-window counter store for
--    @fastify/rate-limit (apps/api/src/plugins/rate-limit-store.ts).

ALTER TABLE "Tenant" ADD COLUMN "oidcConfigGeneration" INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- The generation bump.
--
-- Triggers rather than a call in each service, so the counter moves in the
-- SAME transaction as the change on every write path there is: the admin
-- route, a catalog install (which created OIDC clients and invalidated
-- nothing, before this), a cascade, the key-rotation job running in the
-- worker process, and whatever is written next. A service-level call would be
-- correct only for the callers that remembered it, which is the defect the
-- in-process `invalidateProvider` already had across replicas.
--
-- The Tenant table carries no row-level security, so the UPDATE below needs
-- no tenant binding; it runs as the invoking role, which already updates
-- Tenant for the settings route.
-- ---------------------------------------------------------------------------

CREATE FUNCTION syntra_bump_oidc_generation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  affected UUID;
BEGIN
  -- SigningKey holds SAML keys too, and those are not part of a Provider.
  -- Nested rather than one boolean: PL/pgSQL does not promise to
  -- short-circuit, and OLD/NEW do not exist on every operation.
  IF TG_TABLE_NAME = 'SigningKey' THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW."kind" <> 'oidc' THEN RETURN NULL; END IF;
    ELSIF TG_OP = 'DELETE' THEN
      IF OLD."kind" <> 'oidc' THEN RETURN NULL; END IF;
    ELSE
      IF NEW."kind" <> 'oidc' AND OLD."kind" <> 'oidc' THEN RETURN NULL; END IF;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    affected := OLD."tenantId";
  ELSE
    affected := NEW."tenantId";
  END IF;

  -- A cascade from deleting the tenant itself finds no row here, which is
  -- the right answer: there is no Provider left to invalidate.
  UPDATE "Tenant"
     SET "oidcConfigGeneration" = "oidcConfigGeneration" + 1
   WHERE "id" = affected;

  -- A row moved between tenants (not something any path does) would leave
  -- the old tenant's cache stale; bump it as well rather than reason about it.
  IF TG_OP = 'UPDATE' AND OLD."tenantId" IS DISTINCT FROM NEW."tenantId" THEN
    UPDATE "Tenant"
       SET "oidcConfigGeneration" = "oidcConfigGeneration" + 1
     WHERE "id" = OLD."tenantId";
  END IF;

  RETURN NULL;
END;
$$;

CREATE TRIGGER "OidcClient_bump_oidc_generation"
  AFTER INSERT OR UPDATE OR DELETE ON "OidcClient"
  FOR EACH ROW EXECUTE FUNCTION syntra_bump_oidc_generation();

CREATE TRIGGER "SigningKey_bump_oidc_generation"
  AFTER INSERT OR UPDATE OR DELETE ON "SigningKey"
  FOR EACH ROW EXECUTE FUNCTION syntra_bump_oidc_generation();

-- The hostnames fix the issuer, and oidc-provider never re-reads its issuer.
-- A BEFORE trigger that edits NEW, so the bump is part of the same row write
-- and cannot recurse.
CREATE FUNCTION syntra_bump_oidc_generation_on_hostname() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."primaryDomain" IS DISTINCT FROM OLD."primaryDomain"
     OR NEW."additionalDomains" IS DISTINCT FROM OLD."additionalDomains" THEN
    NEW."oidcConfigGeneration" := OLD."oidcConfigGeneration" + 1;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Tenant_bump_oidc_generation_on_hostname"
  BEFORE UPDATE OF "primaryDomain", "additionalDomains" ON "Tenant"
  FOR EACH ROW EXECUTE FUNCTION syntra_bump_oidc_generation_on_hostname();

-- ---------------------------------------------------------------------------
-- The shared rate-limit counters. Not tenant data and not RLS-protected: see
-- the model's comment in schema.prisma.
-- ---------------------------------------------------------------------------

CREATE TABLE "RateLimitBucket" (
    "key" TEXT NOT NULL,
    "hits" INTEGER NOT NULL,
    "resetAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimitBucket_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "RateLimitBucket_resetAt_idx" ON "RateLimitBucket"("resetAt");
