# Syntra documentation

- [Install](install.md) — development install, the container path, TLS, and
  the single-process alternative.
- [Console guide](console-guide.md) — every screen of the administration
  console, with screenshots, in the order you would set one up.
- [Configure](configure.md) — every environment variable, tenants and
  hostnames, directory sources, SSO and federation configuration.
- [Operate](operate.md) — upgrades, backups, deactivate-never-delete, CI,
  tests, troubleshooting.
- [privacy/](privacy/data-inventory.md) — the data inventory: every column
  Syntra stores, classified, with purpose, source, retention and exactly what
  a data-subject erasure does to it (generated from code).
- [api/](api/README.md) — the administration API's published OpenAPI 3.1
  description, and its versioning, deprecation, error, idempotency and
  rate-limit conventions.
- [connectors/](connectors/certification-and-rollout.md) — connector
  certification, capability enforcement, canary rollout and rollback, and
  deprecation; plus the native [Microsoft Entra ID](connectors/entra-id.md)
  connector and the [Snipe-IT](connectors/snipe-it.md) document for the
  REST API connector.
- [lab/](lab/) — a complete worked build: Syntra over HTTPS, an Active
  Directory domain behind it, sync in both directions, and SAML single
  sign-on to a third-party application.
- [runbooks/](runbooks/README.md) — operational procedures: backup and
  restore, master-key recovery, database migration, secret rotation,
  incident response, target rollback, and tabletop exercises; with an on-call
  quick reference mapping each alert to its runbook.
- [superpowers/](superpowers/) — design and plan documents.

Start at the [repository README](../README.md) for what Syntra is and how it
is put together.
