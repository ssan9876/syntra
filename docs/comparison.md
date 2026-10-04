# How Syntra compares

Syntra combines an identity provider with identity governance: sign-in, sync,
provisioning, lifecycle and access reviews in one install. Most open-source
projects do one half. This page compares capability categories with four
well-known projects. It is written by Syntra's maintainer, so check each
project's own documentation before you decide; they change faster than this page.

## At a glance

| | Syntra | Keycloak | Authentik | Zitadel | midPoint |
|---|---|---|---|---|---|
| **Main focus** | IdP plus governance | Identity provider | Identity provider | Identity platform for apps and SaaS | Identity governance (IGA) |
| **SSO protocols** | SAML 2.0, OpenID Connect, WS-Federation | SAML 2.0, OpenID Connect, OAuth 2.0 | SAML 2.0, OpenID Connect, plus LDAP, RADIUS and proxy providers | OpenID Connect, OAuth 2.0, SAML 2.0 | None; pairs with an IdP |
| **Directory sync in** | LDAP, Active Directory, HR export over SFTP, inbound SCIM | LDAP and AD user federation, Kerberos | LDAP and other sources | LDAP and external IdPs at sign-in; check their docs for sync | Many sources through connectors, HR among them |
| **Provisioning out** | Active Directory, Entra ID, SCIM 2.0, REST by connector document | Not built in; extensions exist | SCIM, plus Google Workspace and Entra ID (check which edition) | Not a core feature; check their docs | Core feature, with a large connector library |
| **Joiner, mover, leaver** | Driven by HR contracts, tracked until every target confirms | Not built in | Not built in | Not built in | Core feature |
| **Access reviews** | Campaigns with manager or owner reviewers | Not built in | Not built in | Not built in | Certification campaigns |
| **Approvals** | Access requests, second approval for lifecycle and privileged changes | Not built in | Check their docs | Check their docs | Approval workflows |
| **Runs as** | Node.js and PostgreSQL 16: two containers or one process | Java (Quarkus) and a SQL database | Python server and worker with PostgreSQL | Go binary with PostgreSQL | Java with PostgreSQL |
| **License** | Apache-2.0, no paid edition | Apache-2.0 | Open-source core with a paid Enterprise edition | AGPL-3.0 for current releases | Apache-2.0 and EUPL-1.2 |
| **Project** | One maintainer, young | Large community, CNCF project | Company-backed, active community | Company-backed, hosted offering | Company-backed (Evolveum), long history |

"Not built in" means not part of the core product as generally documented.
Plugins, extensions or paid editions may add it.

## What Syntra does differently

- **Preview before apply.** Every directory sync and provisioning run is a
  plan you read first. Safety thresholds hold a run that would change too
  much, and the first run on a target always waits for a person.
- **People are not logins.** A person, their contracts and their accounts are
  separate records. Lifecycle follows contracts; sign-in follows accounts.
- **One install.** SSO, provisioning, lifecycle and reviews share one database,
  one audit log and one policy engine.

## Where they are a better fit

**Keycloak**: you need a proven identity provider for your own applications,
with custom authentication flows, broad client library support and a large
community. You handle provisioning elsewhere, or do not need it.

**Authentik**: you want SSO in front of applications that have none, through
its proxy, or LDAP and RADIUS for older systems. Popular for small teams and
home labs, with a visual flow editor.

**Zitadel**: you are building a product and need customer identity: many
organisations, self-service sign-up, passkeys, and APIs first. A hosted
service is available.

**midPoint**: you need full identity governance at enterprise scale: role
modelling, complex policy, many connected systems, and commercial support.
It does not sign anybody in; you pair it with an IdP.

**Syntra**: you are an IT team that wants SSO, AD and Entra provisioning,
joiner-mover-leaver and access reviews in one self-hosted install, with every
change previewed. It is younger than all four, maintained by one person, and
some connectors are still preview: see [Compatibility](compatibility.md).

## Using them together

Syntra can delegate sign-in to an upstream SAML or OpenID Connect provider,
such as Keycloak or Zitadel, and still handle provisioning, lifecycle and
reviews. Upstream federation is configured through the API; see
[Configure](configure.md#signing-in-to-applications).
