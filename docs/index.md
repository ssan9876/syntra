---
title: Free, self-hosted identity and access management
hide:
  - navigation
---

# ![Syntra](assets/syntra-logo.svg#only-light){ .hero-logo }![Syntra](assets/syntra-logo-dark.svg#only-dark){ .hero-logo }

Syntra is free, self-hosted identity and access management, licensed Apache-2.0.
It holds your people, signs them in to applications over SAML 2.0 and OpenID
Connect, and creates, changes and disables their accounts in Active Directory,
Microsoft Entra ID, SCIM 2.0 and REST systems. Every directory sync and
provisioning run is a preview first: you see the plan, then apply it.

[Install](install.md){ .md-button .md-button--primary }
[Guides](guides/index.md){ .md-button }
[Compatibility](compatibility.md){ .md-button }

## Who it is for

- IT teams that run their own infrastructure and want one place for joiners,
  movers and leavers instead of scripts per system.
- Organisations with Active Directory or LDAP, an HR export, and a mix of SaaS
  and self-hosted applications.
- Anyone who needs to show an auditor who had access to what, and who approved it.

It runs as two containers and PostgreSQL 16, or as one Node.js process beside
PostgreSQL. There is no paid edition.

## What it does

<div class="feature-grid" markdown>

<div markdown>
**Single sign-on**

SAML 2.0 and OpenID Connect identity provider, a 17-entry application catalog,
second factors (authenticator app, security key), and an ordered sign-in policy.
</div>

<div markdown>
**People, not just logins**

A person, their contracts and their accounts are separate records. A contractor
with two engagements or a service account with nobody behind it fits.
</div>

<div markdown>
**Sources**

Sync from LDAP or Active Directory, an HR export over SFTP, or inbound SCIM 2.0.
Each run is a reviewable diff.
</div>

<div markdown>
**Provisioning**

Accounts in Active Directory, Entra ID, any SCIM 2.0 service, or any REST API
described by a connector document. Business rules decide who gets what.
</div>

<div markdown>
**Lifecycle**

Joiners, movers and leavers tracked as employee work until every target
confirms, with service levels and second-approval rules.
</div>

<div markdown>
**Governance**

Access reviews, segregation of duties, orphan accounts, and a tamper-evident
audit log.
</div>

<div markdown>
**Safety**

Safety thresholds on every run, a person confirms the first run, and
**Stop writes** halts one target or all of them.
</div>

<div markdown>
**Operations**

Backups that verify themselves, incidents in the console, health checks, and
updates installed from the console.
</div>

</div>

![The Syntra administration console](images/console/03-overview.png)

## Where to go next

| You want to | Read |
|---|---|
| Try it | [Install](install.md) |
| See every screen | [Console tour](console-guide.md) |
| Do one task, step by step | [Guides](guides/index.md) |
| Check a system or application is supported | [Compatibility](compatibility.md) |
| Decide between Syntra and another IAM | [Comparison](comparison.md) |
| Look up a setting | [Configure](configure.md) |
| Run it in production | [Operate](operate.md) |

Source, issues and releases: [github.com/ssan9876/syntra](https://github.com/ssan9876/syntra).
