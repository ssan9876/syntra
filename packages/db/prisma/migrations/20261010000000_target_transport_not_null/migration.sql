-- A CHECK constraint passes when its expression is NULL, and `config ->> 'tlsMode'`
-- is NULL when the key is absent -- so a target whose config said nothing about
-- its transport was the one config that got through. Every branch is wrapped so
-- silence reads as false.
ALTER TABLE "TargetSystem"
  DROP CONSTRAINT "target_system_encrypted_transport";

ALTER TABLE "TargetSystem"
  ADD CONSTRAINT "target_system_encrypted_transport" CHECK (
    coalesce(
      (
        "type" = 'activeDirectory'
        AND ("config" ->> 'tlsMode') IN ('ldaps', 'starttls')
      )
      OR (
        "type" = 'scim2'
        AND ("config" ->> 'baseUrl') LIKE 'https://%'
      )
      OR (
        "type" = 'httpJson'
        AND ("config" #>> '{document,baseUrl}') LIKE 'https://%'
      )
      OR (
        "type" = 'entraId'
        AND coalesce("config" ->> 'graphBaseUrl', 'https://graph.microsoft.com/v1.0') LIKE 'https://%'
        AND coalesce("config" ->> 'tokenUrl', 'https://login.microsoftonline.com/') LIKE 'https://%'
      ),
      false
    )
  );
