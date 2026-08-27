import type { HttpConnectorDocument } from '../document.js';

/**
 * Google Workspace, through the Admin SDK Directory API.
 *
 * **Scopes:** `admin.directory.user` and `admin.directory.group.member`.
 *
 * **A caveat worth reading before configuring this.** Google's own
 * client-credentials flow is a signed JWT assertion, not the
 * `client_id`/`client_secret` post this connector's `oauth2` performs — a
 * service account authenticates by signing, and domain-wide delegation
 * requires impersonating an administrator through the `sub` claim. So the
 * `tokenUrl` below works only where an OAuth client with a secret has been
 * configured for the domain. Where it has not, this document is still the
 * right shape and the token has to come from elsewhere; `auth: { type:
 * "bearer" }` with a token refreshed outside Syntra is the honest interim.
 *
 * Recorded here rather than discovered by an administrator at three in the
 * afternoon, because a connector document that looks complete and is not is
 * worse than one that says where it stops.
 *
 * **There is no `archive`.** The Directory API's removal is
 * `DELETE /users/{key}`, which this connector cannot express. Suspension is
 * what archiving means here, and it is reversible.
 */
export const googleWorkspaceDocument: HttpConnectorDocument = {
  name: 'Google Workspace',
  version: 1,
  baseUrl: 'https://admin.googleapis.com/admin/directory/v1',
  auth: {
    type: 'oauth2',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    clientId: '{clientId}',
    scope:
      'https://www.googleapis.com/auth/admin.directory.user https://www.googleapis.com/auth/admin.directory.group.member',
  },
  headers: {},
  failures: {
    unauthorized: [401, 403],
    notFound: [404],
    conflict: [409],
    // Google answers 429 for a rate limit and 403 for a quota one. 403 is
    // left as `unauthorized` deliberately: a quota failure retried on our
    // schedule is a quota failure repeated, and reading it as a permission
    // problem puts a human in front of it, which is what it needs.
    throttled: [429],
  },
  account: {
    list: {
      path: '/users',
      query: { customer: 'my_customer', maxResults: '500' },
      itemsAt: 'users',
      paging: { style: 'cursor', nextAt: 'nextPageToken', kind: 'token', tokenParam: 'pageToken' },
    },
    anchorAt: 'id',
    correlationAt: 'primaryEmail',
    fields: {
      primaryEmail: 'userPrincipalName',
      'name.fullName': 'displayName',
      'name.givenName': 'givenName',
      'name.familyName': 'familyName',
      suspended: 'suspended',
      orgUnitPath: 'orgUnitPath',
    },
    create: {
      method: 'POST',
      path: '/users',
      body: {
        primaryEmail: '{{attr.userPrincipalName}}',
        name: {
          givenName: '{{attr.givenName}}',
          familyName: '{{attr.familyName}}',
        },
        password: '{{initialPassword}}',
        changePasswordAtNextLogin: true,
        orgUnitPath: '{{attr.orgUnitPath}}',
        // The Directory API has no free-text field a connector may safely
        // claim, so the action id goes in an external id of its own type.
        // A retried create can find what the first attempt made.
        externalIds: [{ type: 'organization', value: '{{actionId}}' }],
      },
      anchorAt: 'id',
    },
    update: {
      method: 'PUT',
      path: '/users/{{anchor}}',
      body: {
        name: {
          givenName: '{{attr.givenName}}',
          familyName: '{{attr.familyName}}',
        },
        orgUnitPath: '{{attr.orgUnitPath}}',
      },
    },
    enable: {
      method: 'PUT',
      path: '/users/{{anchor}}',
      body: { suspended: false },
    },
    disable: {
      method: 'PUT',
      path: '/users/{{anchor}}',
      body: { suspended: true },
    },
    rename: {
      method: 'PUT',
      path: '/users/{{anchor}}',
      body: { primaryEmail: '{{correlationKey}}' },
    },
  },
  entitlement: {
    list: {
      path: '/groups',
      query: { customer: 'my_customer', maxResults: '200' },
      itemsAt: 'groups',
      paging: { style: 'cursor', nextAt: 'nextPageToken', kind: 'token', tokenParam: 'pageToken' },
    },
    anchorAt: 'id',
    displayNameAt: 'name',
    descriptionAt: 'description',
    type: 'group',
    members: {
      path: '/groups/{{entitlementId}}/members',
      query: { maxResults: '200' },
      itemsAt: 'members',
      paging: { style: 'cursor', nextAt: 'nextPageToken', kind: 'token', tokenParam: 'pageToken' },
      memberAnchorAt: 'id',
    },
    grant: {
      method: 'POST',
      path: '/groups/{{entitlementId}}/members',
      body: { id: '{{anchor}}', role: 'MEMBER' },
    },
    revoke: {
      method: 'DELETE',
      path: '/groups/{{entitlementId}}/members/{{anchor}}',
    },
  },
  /**
   * Google's org units are a real tree, and an account is placed in one. This
   * is what makes `container_missing` meaningful for this target rather than
   * vacuous.
   */
  container: {
    list: {
      path: '/customer/my_customer/orgunits',
      query: { type: 'all' },
      itemsAt: 'organizationUnits',
      paging: { style: 'none' },
    },
    dnAt: 'orgUnitPath',
  },
};
