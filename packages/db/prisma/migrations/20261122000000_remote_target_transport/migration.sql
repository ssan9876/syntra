-- Connector-service targets (`remote`): stored only with an https:// service URL.
-- Every other branch is unchanged from 20261010000000_target_transport_not_null.
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
      )
      OR (
        "type" = 'remote'
        AND ("config" ->> 'baseUrl') LIKE 'https://%'
      ),
      false
    )
  );
