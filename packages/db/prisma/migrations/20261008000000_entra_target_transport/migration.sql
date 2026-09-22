-- The native Entra ID connector talks to Microsoft Graph and the Microsoft
-- identity platform over HTTPS only. Its own configuration schema refuses a
-- non-HTTPS Graph or token URL unless the test-only private-address escape
-- hatch is set; the database clause states the same invariant in the shape
-- the other three connector types already use, so an `entraId` row can be
-- saved at all.
ALTER TABLE "TargetSystem"
  DROP CONSTRAINT "target_system_encrypted_transport";

ALTER TABLE "TargetSystem"
  ADD CONSTRAINT "target_system_encrypted_transport" CHECK (
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
  );
