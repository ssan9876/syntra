# Compatibility

What Syntra connects to, how far each one is tested, and what it does not do.
Status comes from the code: the connector release catalog in
`packages/connectors/src/metadata.ts` and the application catalog in
`packages/core/src/access/catalog/entries.ts`.

| Status | Meaning |
|---|---|
| **Supported** | Generally available. Passes the shared certification suite, or was checked against a real system. |
| **Preview** | Works and is tested, but marked preview in the code (controlled rollout) or missing a console screen. Check runs closely before turning on automatic apply. |
| **Untested** | Built from the vendor's documentation. Not yet verified against the real service. |

Found something that works, or does not? Open an issue or a discussion on
[GitHub](https://github.com/ssan9876/syntra) and this page will be updated.

## Provisioning targets

Where Syntra creates, updates, disables and archives accounts. All four types
are adapter release 1.0.0 on the stable channel.

| Target | Status | Tested against | Known limits |
|---|---|---|---|
| Active Directory | Supported | Samba AD domain controller (`nowsci/samba-domain`, pinned) in the integration suite; a Windows domain behind HTTPS, written up in [Active Directory in practice](operate.md#active-directory-in-practice). Windows Server versions are not recorded. Runs every 15 minutes against a Windows domain controller over LDAPS in the maintainer's lab. | LDAPS or StartTLS only. The only target that places accounts in OUs and mirrors org units. |
| Microsoft Entra ID (native) | Preview | A fake Microsoft Graph in the test suite. Certification is `partial`: evidence against a real tenant with direct groups is still required. `pnpm entra:validate` checks a real tenant. Runs every 15 minutes against a real tenant in the maintainer's lab (user accounts; group membership not exercised there). | Direct group memberships only; nested and dynamic groups are not managed. No containers. Account delete is verified against the fake Graph only. |
| SCIM 2.0 | Supported | A disposable SCIM service in the test suite, and a self-hosted SCIM 2.0 application in the maintainer's lab. | No containers. Entitlements are group memberships only. |
| REST API (connector document) | Preview | The shared certification suite. | Only what the document declares. No document can delete an account. Containers only if the document describes them. |

### Shipped connector documents

Starting points for a REST API target. Each is copied into the target and can
be edited there.

| System | Status | Tested against | Known limits |
|---|---|---|---|
| Snipe-IT (REST API v1) | Preview | An in-memory Snipe-IT that follows the API reference, and Snipe-IT 8.7.2 in the maintainer's lab: create, update (including job title) and SAML sign-in of the provisioned users. | Users only: no groups, permissions, departments, locations or companies. No delete or archive; leavers are deactivated. |
| Mattermost (REST API v4) | Preview | An in-memory Mattermost that follows the API v4 reference, and Mattermost 11.11.1 in the maintainer's lab: create, update, adopting existing users, and switching existing users to SAML sign-in, followed by a SAML sign-in. | Users and team membership. No channels, archive or delete. SAML sign-in switch needs Mattermost Enterprise. |
| Google Workspace (Admin SDK Directory API) | Untested | Not yet verified against a real tenant. | The `oauth2` type cannot do service-account JWT with domain-wide delegation; use a bearer token refreshed outside Syntra. No archive: suspension only. |
| Microsoft Entra ID (document) | Preview | As REST API. | Superseded by the native connector; a document target converts in place. |

For Snipe-IT and Mattermost, the docs ask for one real create, change and
deactivate against a test instance before you turn on writes.

## Sources

Where people and accounts come from. Every run is previewed before it applies.

| Source | Status | Tested against | Known limits |
|---|---|---|---|
| LDAP directory (OpenLDAP) | Supported | `osixia/openldap:1.5.0` in the test suite, over plain LDAP, StartTLS and LDAPS. | Reads users, groups and org units. |
| Active Directory | Supported | Write-back tested against Samba AD; a Windows domain (see above). | Write-back (disable, password, delete) is off until turned on per source. |
| HR feed over SFTP | Supported | Delimited-file parsing unit-tested; host-key pinning checked against `atmoz/sftp`. | Delimited (CSV-style) exports. |
| Inbound SCIM 2.0 (Syntra as the SCIM server) | Untested | Built to the filters Entra ID and Okta send. Not yet verified against either. | `DELETE` deactivates. Passwords are ignored. Filters: `userName`, `externalId`, `displayName` with `eq` only. No `/Me`, bulk or ETags. |

## Single sign-on protocols

| Protocol | Status | Known limits |
|---|---|---|
| SAML 2.0 identity provider | Supported | Single logout ends the session at Syntra only; it is not propagated to other service providers. LogoutResponse is not signed. Metadata is unsigned (served over TLS). No SOAP binding. |
| OpenID Connect provider | Supported | Back-channel logout supported. Client credentials grant off unless turned on per client. |
| WS-Federation (passive) | Supported | Turned on per SAML application (**Also accept WS-Federation**). Not yet verified against a real relying party. |
| Upstream SAML or OIDC identity provider | Preview | API only, no console form. Groups asserted upstream grant nothing. HS256 `id_token`s are refused. |

## Application catalog

**Applications → Add from the catalog** fills in an application's SSO
settings from a hostname or account name. Every entry links to the vendor's
own SSO page, which is authoritative. Where an application publishes SAML
metadata, importing it is more exact than a catalog entry.

| Application | Protocol | Status | Notes |
|---|---|---|---|
| Snipe-IT | SAML | Supported | Entity ID and SSO start page checked against a live instance. `username` is sent as the business email; see [Add SSO to an application](guides/sso-from-catalog.md). |
| AWS IAM Identity Center | SAML | Untested | Entity ID and ACS URL are per instance; copy both from Identity Center. Persistent Name ID. |
| Box | SAML | Untested | |
| Figma | SAML | Untested | Needs the tenant ID from Figma's SAML settings. |
| GitLab (self-managed) | OIDC | Untested | |
| Google Workspace | SAML | Untested | Google matches by primary email. |
| Grafana | OIDC | Untested | Generic OAuth provider. |
| Jenkins | SAML | Untested | SAML plugin. Enter the attribute names in the plugin. |
| Lucid | SAML | Untested | Enterprise accounts. |
| Miro | SAML | Untested | One identity provider per account; with several, register by hand. |
| Nextcloud | SAML | Untested | SSO & SAML app. |
| PagerDuty | SAML | Untested | |
| Rocket.Chat | SAML | Untested | Premium feature. Importing its SP metadata is better. |
| Salesforce | SAML | Untested | |
| Sentry (sentry.io) | SAML | Untested | Enter the attribute names under Map IdP Attributes. |
| Slack | SAML | Untested | |
| Zoom | SAML | Untested | |

### Applications without an entry

**Applications → Add by hand** takes any SAML service provider (metadata URL,
pasted metadata, or typed values) or OpenID Connect relying party. Known
requirements:

- **Mattermost** (SAML, Enterprise): turn on
  **Sign the whole response, not only the assertion**. See
  [Switch Mattermost users to SAML](guides/mattermost-saml.md).
- **FMX** (SCIM target and SSO): map `oidc_subject` to
  `%person.syntraUserId%`. See [SCIM 2.0 targets](configure.md#scim-20-targets).

## Platform

| Component | Version |
|---|---|
| PostgreSQL | 16 |
| Node.js | 22 or later |
| Container images | `ghcr.io/ssan9876/syntra-api`, `ghcr.io/ssan9876/syntra-web` |
| Kubernetes | Helm chart in `deploy/helm/syntra` |
