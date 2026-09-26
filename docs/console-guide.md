# The administration console, screen by screen

A tour of what an administrator sees, in the order you would set up a new
installation. Each section says what the screen is for and what to do there;
the settings behind each screen are in [configure.md](configure.md), and the
day-to-day procedures in [operate.md](operate.md).

The screenshots come from a working installation with names and domains
replaced. Refresh them with `node scripts/docs-screenshots.mjs <url>` (see the
header of that script).

## Getting in

![Sign in](images/console/01-sign-in.png)

Everybody signs in at the same page. Employees land on the **portal** — one tile
per application they have been given. Clicking a tile signs them in to it.

![Portal](images/console/02-portal.png)

Administrators also see **Administration** in the header. Opening it asks for
the password again (and the second factor, when policy requires one): the
console runs in its own, shorter session.

## Overview

![Overview](images/console/03-overview.png)

Where the console opens.

- **Needs you** lists everything waiting on a person — overdue or blocked
  employee work, stopped writes, unreachable connectors, connector tests to
  repeat, locked accounts, accounts with no person. Each card links to the
  screen where it is dealt with. When nothing is waiting it says so.
- The figures below it count people, accounts, applications, target systems and
  sources, and link to each list.
- **Connected systems** shows every target and source with its state and when
  it last ran. **Recent activity** shows the latest audit events and who did
  them.

The badge beside the title is the service's own health; **Degraded** links to
Operations.

The rail on the left groups the console into Directory, Access, Connected
systems and System. Click a group's heading to fold it away; the console
remembers, and the group holding the page you are on always stays open.

## Directory

### Users

![People](images/console/04-people.png)

**People** are who works here — the records HR owns. **Accounts** are the
logins those people (and integrations) sign in with.

![Accounts](images/console/05-accounts.png)

- **Add someone** creates a person and, optionally, their account and first
  contract in one pass.
- A person's record shows their contracts, their accounts, where they sit, what
  access they hold and why, and every target system's view of them.

- An account's record holds everything that changes one account: status,
  second factors, password setup links, API tokens for a service account, and
  its slice of the audit log.
- **Import** takes a CSV of people.
- An account used only by an integration is marked a **service account** from
  its record. If it was linked to a person record, **Unlink** it first.

### Org units

![Org units](images/console/06-org-units.png)

The organisation's structure — sites, departments, teams — as a tree. A unit
scopes administrative roles, receives applications, and (for an Active
Directory target with mirroring on) becomes an OU.

## Access

### Applications

![Applications](images/console/07-applications.png)

- **Add from the catalog** configures SAML or OpenID Connect for a known
  application from a hostname; **Add by hand** for anything else.
- An application's record holds its sign-in configuration, who it is assigned
  to (people, groups or org units — an org unit reaches everyone in it and in
  the units beneath), its portal tile, and retiring or deleting it.

### Authentication policy

![Authentication policy](images/console/14-authentication-policy.png)

Rules that decide, per sign-in, whether to allow it, require a second factor,
or refuse it. The first rule that matches decides; the default applies when
none does.

## Connected systems

### Sources

![Sources](images/console/08-sources.png)

Where people and accounts come from: an LDAP or Active Directory directory
synchronised into Syntra, or an HR export read over SFTP. Each run is
previewed before it changes anything.

### Target systems

![Target systems](images/console/09-targets.png)

Where Syntra creates and maintains accounts: Active Directory, Microsoft Entra
ID, SCIM 2.0, or any REST API described by a connector document (Snipe-IT
ships as one).

A target's record holds its connection, schedule, safety thresholds, account
profile (names and placement), access rules, org-unit mirroring, and its runs.
**Stop writes** halts every change to that system at once.

### Provisioning setup

![Provisioning setup](images/console/10-provisioning-setup.png)

A checklist per target, from connecting HR to the first applied run. Each step
shows whether it is verified and links to where it is done.

### Employee work

![Employee work](images/console/11-employee-work.png)

Every joiner, mover and leaver that is not finished, sorted into lanes by what
it needs: overdue, blocked, needs action, waiting for a target to confirm.

### Lifecycle policy

![Lifecycle policy](images/console/12-lifecycle-policy.png)

Which changes need a second administrator's approval, and how quickly hires,
changes and departures are expected to complete.

## System

### Roles

![Roles](images/console/13-roles.png)

Who may do what in the console.

- Each role on the left shows its holders and how much of the permission
  catalogue it carries.
- The selected role shows the people holding it — revoke with the ✕, add with
  **Grant to someone**, optionally limited to one org unit — and its
  permissions grouped by area.
- **Edit** turns the same grid into toggles. **Add a preset** creates a
  ready-made role (Auditor, Target administrator, …) in one click.

![Editing a role](images/console/23-role-edit.png)

### Activity

![Activity](images/console/15-activity.png)

The audit log. **Attention** shows what needs a look; **All events** is the
complete, tamper-evident record; **Exports** sends it elsewhere.

### Operations

![Operations](images/console/16-operations.png)

Service health, background work that is stuck or failing (with a repair where
one is safe), and a redacted support bundle.

### Settings

![Settings](images/console/17-settings.png)

Sign-in and session rules, branding, webhooks, stored credentials, security
alerts, change control, break-glass access and offboarding.

### Updates

![Updates](images/console/18-updates.png)

The running version, the last update's outcome, and newer releases — installed
from here on a release-layout installation (see [operate.md](operate.md)).
