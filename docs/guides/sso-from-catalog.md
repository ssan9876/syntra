# Add SSO to an application from the catalog

This guide signs people in to **Snipe-IT** through Syntra over SAML. The steps
are the same for the other 16 catalog entries; only the values you type and
the application's own settings differ. A Grafana (OpenID Connect) variant is at
the end.

**You need:** a Snipe-IT instance on HTTPS, an administrator account in it,
and the hostname, for example `assets.example.com`.

## 1. Register the application in Syntra

1. **Applications → Add from the catalog → Snipe-IT**.
2. **Snipe-IT hostname**: `assets.example.com`. Not a URL, just the host.
3. **Add Snipe-IT**.

The entry fills in the entity ID `https://assets.example.com`, the ACS URL
`https://assets.example.com/saml/acs`, an email Name ID, single logout, the
`username`, `email`, `firstname` and `lastname` attributes, and the portal
tile's launch address `https://assets.example.com/login/saml`.

## 2. Check the username claim

Snipe-IT signs a person in by matching an attribute against its own
**username**. The catalog sends `username` as the person's business email.

On the application's page, open **Claims** and check the `username` row reads
**The person · businessEmail**. If it reads **The account** (an application
created from an older catalog entry sent the Syntra login), change it:

1. **Remove** the `username` row.
2. **Add a mapping**: **Protocol** SAML, **Sent as** `username`,
   **From** The person, **Field on the person** `businessEmail`.
3. **Add mapping**.

!!! warning "The usual cause of a failed Snipe-IT sign-in"
    If the claim and the Snipe-IT username differ (`jdoe` against
    `jdoe@example.com`), the assertion is valid, no user matches, and Snipe-IT
    shows its login form again. Make the Snipe-IT username the business email,
    or provision accounts with the [Snipe-IT connector](../configure.md#snipe-it),
    which names them that way.

## 3. Give Snipe-IT Syntra's details

Syntra's side, on your tenant's primary domain. The application id is the last
part of the application page's address in the console.

| Field | Value |
|---|---|
| IdP metadata | `https://<primary domain>/saml/metadata/<application id>` |
| IdP entity ID | `https://<primary domain>/saml/idp` |
| SSO URL | `https://<primary domain>/saml/sso` |
| SLO URL | `https://<primary domain>/saml/slo` |

In Snipe-IT's SAML settings: turn SAML on, give it the IdP metadata, and set
the SAML username attribute to `username`. Field names differ between
Snipe-IT versions; follow
[Snipe-IT's SAML page](https://snipe-it.readme.io/docs/saml) for where each one is.

## 4. Assign it

On the application's page, under **Assigned to**, choose a **User**, **Group**
or **Org unit** and **Assign**. An org unit reaches everyone in it and in the
units below.

## 5. Test it

1. Sign in to the portal as an assigned person whose Snipe-IT account exists
   under their business email.
2. Click the **Snipe-IT** tile. Snipe-IT sends you to Syntra and back, signed in.

Snipe-IT redirects to its own login route after the ACS; that redirect is part
of a working sign-in. Each attempt needs a fresh assertion, so start again from
the tile. Failures are in **Activity** as `application.launch` and SAML events.

## Grafana (OpenID Connect)

1. **Applications → Add from the catalog → Grafana**, **Grafana hostname**,
   **Add Grafana**.
2. Copy the **Client ID** and **Client secret**. The secret is shown once.
3. In Grafana's generic OAuth settings, set the client ID and secret, scopes
   `openid profile email`, and the authorization, token and userinfo URLs from
   `https://<primary domain>/oidc/.well-known/openid-configuration`.
   The redirect URI Syntra registered is `https://<grafana host>/login/generic_oauth`.
4. Assign and test as above.
