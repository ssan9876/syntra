# Security policy

## Supported versions

The latest minor release and the one before it get security fixes. Older
releases do not; update to a supported one.

| Version | Security fixes |
|---|---|
| 1.23.x | Yes |
| 1.22.x | Yes |
| 1.21.x and older | No |

When a new minor is released, the oldest row drops off. See
[docs/releases.md](docs/releases.md).

## Reporting a vulnerability

Report privately through GitHub: the repository's **Security** tab →
**Report a vulnerability**. Do not open a public issue, discussion or pull
request for a vulnerability. There is no security email address.

Include:

- The Syntra version (Administration → Updates) and install method.
- The affected component: API route, console page, connector, SAML/OIDC flow,
  updater or backup script.
- Steps to reproduce, or a proof of concept.
- What an attacker gains, and what access they need first.
- Any logs or requests, with secrets and tokens removed.

## What happens next

| Step | Target |
|---|---|
| Acknowledgement | Within 3 days |
| Assessment (confirmed or not, and severity) | Within 10 days |
| Fix or mitigation plan, high and critical | Within 30 days |

Syntra is maintained by one person. If a target slips, you will be told in the
advisory thread.

## Coordinated disclosure

- The fix is developed in a private GitHub security advisory. You are invited
  to it and can review the fix.
- The advisory and a CVE (where one applies) are published when a fixed release
  is available.
- Please wait for that release before publishing details. If 90 days pass
  without a fix, agree a date with the maintainer in the advisory.
- Reporters are credited in the advisory unless they ask not to be.

## Scope

In scope:

- Authentication bypass, including MFA, step-up and session handling.
- Tenant isolation: reading or changing another tenant's data.
- Secret exposure: stored credentials, `MASTER_KEY`, signing keys, API tokens,
  secrets in logs, exports or support bundles.
- SAML, OIDC and WS-Federation flaws: signature validation, assertion or token
  replay, redirect handling.
- Provisioning that writes outside its target: another target, another base DN
  or container, or an account Syntra does not manage.
- Privilege escalation: a role, API token or portal user doing more than its
  permissions allow.

Out of scope:

- Findings that need administrator access already, such as an Owner changing
  configuration.
- Volumetric denial of service.
- Missing security headers with no demonstrated impact.
- Self-XSS.
- Vulnerabilities in a dependency with no path to exploit them in Syntra.
  Dependabot and CodeQL already track these.
