# Changelog

All notable changes to Syntra. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/) as described in
[docs/releases.md](docs/releases.md). Each release's full notes are its tag
message, shown on the GitHub release and in Administration → Updates.

## [Unreleased]

### Added
- After `syntra-backup restore`, the installation starts on hold: sign-in and the console work, but scheduled runs, queued jobs and writes to target systems wait until somebody with `deployment.manage` selects **Resume** on the console banner. Recorded as `deployment.restore_resumed`. `ops/restore-hold.sql` does the same for Compose and Helm restores.
- `syntra-backup restore` refuses a backup taken on a newer release, and migrates an older one before the service starts.

### Changed
- Console on phones: fields are 16px so iOS no longer zooms on tap, count cards sit two per row, menu links are 44px tall, and side margins are 16px. Desktop layout is unchanged.

### Fixed
- `syntra-update` and `syntra-backup restore` failed at the migration step on installs without `SHADOW_DATABASE_URL`: "The shadow database you configured appears to be the same as the main database".
- `syntra-backup restore` left the pg-boss schema from before the restore in place and created `public` owned by the superuser instead of the application role.
- After a restore rewound the audit chain, writing a governance anchor for an already-anchored sequence failed every time. The new anchor is written beside the old one, named by its hash.
- The Helm backup CronJob recorded a `null` key fingerprint on Vault Transit and AWS KMS deployments.

## [1.20.0] - 2026-10-04

### Added
- First-run setup in the browser: while no tenant exists, the API log shows a one-time link (valid 1 hour) to create the organisation and its first Owner. The bootstrap script still works; both record `tenant.created`.
- Critical incidents for insecure defaults: "Database password is a default" and "Site is not served over HTTPS".
- `scripts/quickstart.sh` and `scripts/quickstart.ps1`: secrets, `.env`, start and health check in one step, for localhost, a real domain with automatic TLS, or behind your own proxy.
- `deploy/demo` (a public demo that resets nightly) and `deploy/unraid` notes.
- Releases carry SPDX SBOMs for the tarball and both images, and signed build provenance (`gh attestation verify`).
- The Helm chart is published to `oci://ghcr.io/ssan9876/charts/syntra`.
- Docs site at https://ssan9876.github.io/syntra/ with task guides, a compatibility table and a comparison page.
- SECURITY.md, CONTRIBUTING.md, CODE_OF_CONDUCT.md, issue templates, release policy and roadmap.

### Fixed
- The TLS overlay answered 502 to every request: Caddy now reaches the web container on 8080.
- The container images reported their version as `dev`.

## [1.19.1] - 2026-10-03

### Changed
- New Syntra mark, favicon, 19 console navigation icons and 20 built-in application icons. Icon keys are unchanged; tenant logos still replace the wordmark.

### Fixed
- Portal: Tasks, an open task and Reviews keep the header and navigation.

## [1.19.0] - 2026-10-03

### Added
- Password sync: a password set or reset in Syntra is written to Active Directory, then Entra ID, on targets with the setting on. Migration `20261116000000_target_sync_password`.
- Target page → Left out: leave one person out of a target, with a reason. Migration `20261118000000_target_person_exclusions`.
- Mattermost: switch users to SAML sign-in, and adopt all conflicting accounts at once.
- Applications: Add by hand sets up SAML or OIDC sign-in in the same step.
- Catalog entries for Miro, Figma, Lucid, Rocket.Chat, Box, PagerDuty, Sentry and Jenkins.
- Save as catalog entry turns any application into your own entry. Migration `20261117000000_catalog_templates`.
- Overview → Sign-in security lists administrators without a second factor, console MFA off, lockout off and no break-glass account.
- Incidents for mail going to a test server and for targets whose runs keep ending partially applied.
- Settings → Email → Send test email.
- `syntra-backup` can copy each backup off the host with `SYNTRA_BACKUP_COPY_COMMAND`.
- `ops/postgres/docker-compose.yml`: a production database stack for the single-process install.

### Changed
- `syntra-update` deletes old release downloads and refreshes the backup units from the release.
- Snipe-IT catalog entry sends the business email as the username.

### Fixed
- Unknown `/scim` and `/metrics` paths answer 404 instead of the console page.
- The pg warning "Calling client.query() when the client is already executing a query" no longer appears.

## [1.18.6] - 2026-10-03

### Added
- Dynamic groups: a membership rule on Department, Job title, Cost centre, Employer, Location, FTE and Person status. Migration `20261115000000_group_membership_rules`.
- REST API → Another application: a guided connector builder that edits any connector document as a form, validated as you type.

### Changed
- Condition editors show field names (Department) instead of paths (`contract.department`).

## [1.18.5] - 2026-10-03

### Added
- SAML: Sign the whole response, per application. Needed for Mattermost. Migration `20261114000000_saml_sign_response`.

## [1.18.4] - 2026-10-03

### Changed
- Adopt finds a person's existing account by business email when no account has the reserved name.

## [1.18.3] - 2026-10-03

### Added
- REST API connector: page-number and Link-header paging, typed values, form-encoded bodies, `find`, `enabledWhen`, `exclude`, `createsEnabled` and classified 4xx errors.
- REST API connector: OAuth2 `client_secret_basic`, extra token fields, and API keys as a query parameter.
- Shipped connector document for Mattermost users and team membership.
- Test connection shows the first accounts as the document maps them.

### Changed
- Reads retry a 429 or 5xx page up to four times, honouring `Retry-After`.

### Security
- Test connection no longer reuses a saved REST credential when the document names a different host, token URL or authentication.

## [1.18.2] - 2026-09-30

### Added
- SCIM target editor: User and Group resource paths, including lowercase `/users` and `/groups`.
- Profile mapping `%person.syntraUserId%` and `oidc_subject` mappings.

### Security
- Fastify 5.12.5 and brace-expansion 5.0.12 for high-severity advisories.

## [1.18.1] - 2026-09-27

### Fixed
- Govern no longer flags accounts, logins and grants that Syntra itself created.

## [1.18.0] - 2026-09-27

### Added
- Data deletion role and Delete permanently for inactive people. Migration `20261111000000_data_deletion_role`.
- Active Directory and Entra ID targets delete a leaver's disabled accounts after N days (new targets: 30).
- Optional daily deletion of leavers from Syntra once their accounts are deleted (Settings → Data deletion).

### Changed
- A person and their login share one email, unique per tenant.

## [1.17.0] - 2026-09-27

### Added
- Settings → Domains: verified email domains. Business emails and generated addresses must be in a verified domain.
- Every failed background job attempt logs one error line with its ids.

### Changed
- Console, API and log messages rewritten in plain words.
- A previewed run that proposes nothing no longer blocks the schedule.

### Fixed
- A failed lifecycle operation whose case was resolved leaves the attention list.

## [1.16.2] - 2026-09-26

### Added
- Incidents list what failed by name, and can be acknowledged and resolved.

### Changed
- Confirming the password for the console lands on Overview.

### Fixed
- Service accounts are no longer listed as accounts with no person.

## [1.16.1] - 2026-09-26

### Changed
- Documentation brought up to date with the code.
- Stop writes is one button until used; Entra ID targets and SAML/OIDC applications show their type by name.

## [1.16.0] - 2026-09-26

### Added
- Console Overview page and folding navigation groups.

### Changed
- Roles redesigned as a list and a record, with presets as one-click chips.
- Explanatory prose removed from the console.

## [1.15.6] - 2026-09-25

### Added
- Unlink an account from its person.

### Fixed
- SAML single logout uses the binding the service provider published.
- Editing an application no longer resets its type and visibility.

## [1.15.5] - 2026-09-25

### Fixed
- App access by org unit falls back to the linked person's org unit.
- SAML tiles with IdP-initiated sign-in off launch through the app's launch URL.

## [1.15.4] - 2026-09-25

### Added
- Correlation-key character rules per target.
- Delete, retire and reactivate an application.

### Changed
- Org unit mirroring: switch every hand-typed org unit at once.

## [1.15.3] - 2026-09-25

### Added
- Mirror org units as OUs, per target.

## [1.15.2] - 2026-09-25

### Added
- Snipe-IT user provisioning.
- One-time password link for new accounts, Send login info, and mail through Microsoft Graph (`MAIL_FROM`).
- Apply renames automatically, per target, and approve held actions after an auto-applied run.
- Run now on the target page.

### Changed
- Active Directory forces a password change at first sign-in by default.

## [1.15.1] - 2026-09-25

### Added
- Console-wide attention banner for work held for review.

### Fixed
- Onboarding completes when the target already matches; empty preview runs no longer block the target.

## [1.15.0] - 2026-09-25

### Added
- Employee work organised as Overdue, Blocked, Needs action and Waiting for verification, with saved views and bulk actions.
- Application logos: 20 built-in marks or an uploaded image. Migration `20261105010000_application_icons`.
- Portal: pinned and recent applications, categories, and a Get help link. Migration `20261105000000_tenant_support_destination`.

### Changed
- A person's page leads with one readiness answer; provisioning setup is an 8-step checklist.
- Long forms split into sections with an error summary and a save bar.

### Fixed
- Overdue work reported as on time when PostgreSQL ran outside UTC.
- A rotated OIDC client secret could disappear before it was copied.

## [1.14.4] - 2026-09-24

### Fixed
- Entra ID and SCIM: attribute updates no longer count as container moves.

## [1.14.3] - 2026-09-24

### Fixed
- Entra ID, SCIM and REST targets correlate existing accounts, so they can be adopted.
- `syntra-update` no longer fails when asked for the version already running.

## [1.14.2] - 2026-09-24

### Added
- Entra ID: User principal name domain setting.

### Fixed
- Entra ID and SCIM targets create accounts through a provisioning run.

## [1.14.1] - 2026-09-24

### Fixed
- Installing 1.14.0 with `syntra-update` or Helm failed to find the Prisma config.

## [1.14.0] - 2026-09-24

### Added
- Target write stops, session policy, tenant deletion and run cancellation.
- Helm chart.
- Change control, break-glass access, data-subject requests and the tenant-isolation probe.
- OpenAPI document, tracing, external key providers (KMS) and exports.

### Changed
- TypeScript 6 and Prisma 7.

### Security
- CodeQL redirect and parsing findings fixed; containers run without root.

## [1.13.1] - 2026-09-23

### Added
- Lifecycle cases and legal holds, maintenance windows, duplicate-person review and tenant offboarding export.
- Connector certification and Entra ID write safeguards.

## [1.13.0] - 2026-09-22

### Added
- Native Microsoft Entra ID target.
- Lifecycle policy: approvals, service levels, escalation and evidence retention.
- Prometheus alert rules (`ops/prometheus-alerts.yml`), runbooks and role presets.

### Changed
- Six migrations, including a rewrite of the TargetSystem transport check constraint.

## [1.12.0] - 2026-08-30

### Added
- Search, status filter and paging on People, Accounts and Groups.

### Changed
- `/persons`, `/users` and `/groups` responses include `total`, `page` and `pageSize`. `pageSize` above 200 is refused.

## [1.11.3] - 2026-08-30

### Changed
- Sources → HR feeds: the HR feed is labelled as one.

## [1.11.2] - 2026-08-30

### Fixed
- `syntra-update` failed with `cfg: unbound variable`, so 1.11.1 could not be installed. Replace `bin/syntra-update` by hand once, then update.

## [1.11.1] - 2026-08-30

### Fixed
- Rebuild of 1.11.0, whose build failed. Not installable; take 1.11.2.

## [1.11.0] - 2026-08-30

Not published. The changes below first install with 1.11.2.

### Added
- Sessions panel on every account, with revoke, and Where you are signed in for each person.
- OIDC token revocation, introspection and back-channel logout.
- Webhook groups for Sign-in security, Credentials and Configuration changes.
- Optional Prometheus endpoint at `/metrics`, enabled by `METRICS_TOKEN`.
- `syntra-backup` takes, verifies and restores backups, with daily and weekly timers.
- API tokens for service accounts.
- Inbound SCIM 2.0 server at `/scim/v2`.

### Changed
- Signing out notifies OIDC relying parties that have a back-channel logout endpoint.

## [1.10.0] - 2026-08-29

### Added
- Published container images, a TLS overlay and first-tenant bootstrap.

### Fixed
- A fresh install works.

## [1.9.0] - 2026-08-29

### Added
- HR feed: a delimited export over SFTP, mapped onto people and contracts, previewed before apply.

### Changed
- Directory sources became Sources, with one list of runs.
- Fields an HR feed maps can no longer be edited by hand.

## [1.8.1] - 2026-08-29

### Fixed
- A directory error containing a NUL byte left sync runs stuck at running with no error.

## [1.8.0] - 2026-08-29

### Added
- Adopt an existing directory account for a person whose account is in conflict.

## [1.7.0] - 2026-08-28

### Added
- Set a person's password on their behalf, flagged must-change.
- Edit a contract in place and an account's org unit.

### Changed
- Duplicate logins and emails are refused with 409; a likely duplicate person warns first.
- A materialised org unit container is created on the next run even when empty.

### Fixed
- Onboarding records the org unit it asked for.

## [1.6.3] - 2026-08-28

### Fixed
- A provisioning action whose error contained a NUL byte was left in flight.

## [1.6.2] - 2026-08-28

### Fixed
- Updates says why an update check failed instead of "Nothing to show".

## [1.6.1] - 2026-08-28

### Fixed
- Updates can read the release list from GitHub again.

## [1.6.0] - 2026-08-28

### Added
- Org units materialised against a target set where accounts are created. Migration `20260921000000_org_unit_container`.
- Narrower roles, and roles granted over a single org unit.
- Record screens for org units and groups.

### Fixed
- Deleting an org unit is refused while people are assigned to it.

## [1.5.0] - 2026-08-27

### Added
- Record screens for each person and account, with their own audit log.

### Changed
- Per-row controls moved from the Users tabs onto the record.

### Fixed
- Eleven background jobs that were never scheduled now run.

## [1.4.0] - 2026-08-27

### Changed
- Console redesign: 29 navigation links became 13. Retired paths redirect.

### Fixed
- Elevation no longer drops the query string; six pages no longer go blank on a response missing its collection.

## [1.3.0] - 2026-08-27

### Added
- Authentication policy conditions on device and country.
- Tenant branding: name, logo and colours.
- WS-Federation sign-in.
- Govern suggests rules from existing access.
- Sign-in screens and portal in Dutch and German.

### Fixed
- Emailed codes were offered to tenants that had them switched off.

## [1.2.0] - 2026-08-26

### Added
- Roles screen and role-management API.
- Access reviews and approval workflows managed from the console.
- Allow deletion per directory source from the console.

### Fixed
- A database transaction timeout answers 503 instead of 500.
- SAML ForceAuthn no longer loops.

### Security
- Session cookies take their Secure flag from `PUBLIC_URL`.

## [1.1.1] - 2026-08-25

### Added
- Add someone shows the DN each target would create the account at.

### Fixed
- Deletion per directory source had no console control.

## [1.1.0] - 2026-08-25

### Added
- Add someone: a person, first contract and optional login in one form.
- Delete a user or an empty org unit through directory write-back, off by default. New permission `directory.delete`.

## [1.0.4] - 2026-08-25

### Fixed
- `syntra-update` could not find release assets in GitHub's API response. First installable release.

## [1.0.3] - 2026-08-25

### Fixed
- Release tooling only. Not installable.

## [1.0.2] - 2026-08-25

### Fixed
- Release tooling only. Not published.

## [1.0.1] - 2026-08-25

### Fixed
- Release tooling only. Not published.

## [1.0.0] - 2026-08-25

Not published. The changes below first install with 1.0.4.

### Added
- First release: SCIM 2.0 target connector, compound AND/OR/NOT business rules, and the self-updater (`syntra-update`) with rollback.

[Unreleased]: https://github.com/ssan9876/syntra/compare/v1.20.0...HEAD
[1.20.0]: https://github.com/ssan9876/syntra/compare/v1.19.1...v1.20.0
[1.19.1]: https://github.com/ssan9876/syntra/compare/v1.19.0...v1.19.1
[1.19.0]: https://github.com/ssan9876/syntra/compare/v1.18.6...v1.19.0
[1.18.6]: https://github.com/ssan9876/syntra/compare/v1.18.5...v1.18.6
[1.18.5]: https://github.com/ssan9876/syntra/compare/v1.18.4...v1.18.5
[1.18.4]: https://github.com/ssan9876/syntra/compare/v1.18.3...v1.18.4
[1.18.3]: https://github.com/ssan9876/syntra/compare/v1.18.2...v1.18.3
[1.18.2]: https://github.com/ssan9876/syntra/compare/v1.18.1...v1.18.2
[1.18.1]: https://github.com/ssan9876/syntra/compare/v1.18.0...v1.18.1
[1.18.0]: https://github.com/ssan9876/syntra/compare/v1.17.0...v1.18.0
[1.17.0]: https://github.com/ssan9876/syntra/compare/v1.16.2...v1.17.0
[1.16.2]: https://github.com/ssan9876/syntra/compare/v1.16.1...v1.16.2
[1.16.1]: https://github.com/ssan9876/syntra/compare/v1.16.0...v1.16.1
[1.16.0]: https://github.com/ssan9876/syntra/compare/v1.15.6...v1.16.0
[1.15.6]: https://github.com/ssan9876/syntra/compare/v1.15.5...v1.15.6
[1.15.5]: https://github.com/ssan9876/syntra/compare/v1.15.4...v1.15.5
[1.15.4]: https://github.com/ssan9876/syntra/compare/v1.15.3...v1.15.4
[1.15.3]: https://github.com/ssan9876/syntra/compare/v1.15.2...v1.15.3
[1.15.2]: https://github.com/ssan9876/syntra/compare/v1.15.1...v1.15.2
[1.15.1]: https://github.com/ssan9876/syntra/compare/v1.15.0...v1.15.1
[1.15.0]: https://github.com/ssan9876/syntra/compare/v1.14.4...v1.15.0
[1.14.4]: https://github.com/ssan9876/syntra/compare/v1.14.3...v1.14.4
[1.14.3]: https://github.com/ssan9876/syntra/compare/v1.14.2...v1.14.3
[1.14.2]: https://github.com/ssan9876/syntra/compare/v1.14.1...v1.14.2
[1.14.1]: https://github.com/ssan9876/syntra/compare/v1.14.0...v1.14.1
[1.14.0]: https://github.com/ssan9876/syntra/compare/v1.13.1...v1.14.0
[1.13.1]: https://github.com/ssan9876/syntra/compare/v1.13.0...v1.13.1
[1.13.0]: https://github.com/ssan9876/syntra/compare/v1.12.0...v1.13.0
[1.12.0]: https://github.com/ssan9876/syntra/compare/v1.11.3...v1.12.0
[1.11.3]: https://github.com/ssan9876/syntra/compare/v1.11.2...v1.11.3
[1.11.2]: https://github.com/ssan9876/syntra/compare/v1.11.1...v1.11.2
[1.11.1]: https://github.com/ssan9876/syntra/compare/v1.11.0...v1.11.1
[1.11.0]: https://github.com/ssan9876/syntra/compare/v1.10.0...v1.11.0
[1.10.0]: https://github.com/ssan9876/syntra/compare/v1.9.0...v1.10.0
[1.9.0]: https://github.com/ssan9876/syntra/compare/v1.8.1...v1.9.0
[1.8.1]: https://github.com/ssan9876/syntra/compare/v1.8.0...v1.8.1
[1.8.0]: https://github.com/ssan9876/syntra/compare/v1.7.0...v1.8.0
[1.7.0]: https://github.com/ssan9876/syntra/compare/v1.6.3...v1.7.0
[1.6.3]: https://github.com/ssan9876/syntra/compare/v1.6.2...v1.6.3
[1.6.2]: https://github.com/ssan9876/syntra/compare/v1.6.1...v1.6.2
[1.6.1]: https://github.com/ssan9876/syntra/compare/v1.6.0...v1.6.1
[1.6.0]: https://github.com/ssan9876/syntra/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/ssan9876/syntra/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/ssan9876/syntra/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/ssan9876/syntra/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/ssan9876/syntra/compare/v1.1.1...v1.2.0
[1.1.1]: https://github.com/ssan9876/syntra/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/ssan9876/syntra/compare/v1.0.4...v1.1.0
[1.0.4]: https://github.com/ssan9876/syntra/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/ssan9876/syntra/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/ssan9876/syntra/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/ssan9876/syntra/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/ssan9876/syntra/releases/tag/v1.0.0
