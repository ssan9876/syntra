-- The original transport guard was written when Active Directory was the
-- only target type. It required `config.tlsMode` on every row, which rejects
-- the declarative HTTPS connector before its own document validation can run.
--
-- Keep the database-level encrypted-transport invariant, but express it in
-- the native shape of each supported target configuration. HTTP JSON
-- documents are accepted only when their target API base URL is HTTPS.
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
  );
