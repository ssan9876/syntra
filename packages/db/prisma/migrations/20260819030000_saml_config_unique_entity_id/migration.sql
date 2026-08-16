-- One service provider entity ID per tenant.
--
-- `findSamlConfigByEntityId` resolves an incoming AuthnRequest to a
-- configuration by entity ID with `findFirst`. Two applications in one tenant
-- could register the same one, and which of them answered was whatever the
-- planner returned. No escalation follows -- the assignment check and the
-- audience both track `config.applicationId`, so a user not assigned to the
-- winning application gets a 403 -- but the entry point of an allowlist-based
-- control is not a thing to leave resolving non-deterministically, and the
-- symptom (one of two integrations intermittently stops working) is miserable
-- to diagnose.
--
-- `SamlConfig` is created by 20260817000000_access_2 on this same unreleased
-- branch, so there is no deployment that can hold a duplicate for this to fail
-- on. A deployment that somehow did should fail here rather than have one of
-- the two silently chosen for it.
DROP INDEX "SamlConfig_tenantId_spEntityId_idx";

CREATE UNIQUE INDEX "SamlConfig_tenantId_spEntityId_key" ON "SamlConfig"("tenantId", "spEntityId");
