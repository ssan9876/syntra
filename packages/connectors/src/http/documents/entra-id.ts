import type { HttpConnectorDocument } from '../document.js';

/**
 * Microsoft Entra ID, through Microsoft Graph v1.0.
 *
 * The `{tenant}` in `tokenUrl` is a placeholder an administrator replaces with
 * their own directory id — it is not a template this connector substitutes,
 * deliberately: the tenant id belongs to the deployment, not to a request, and
 * a value that changed per request would be a different directory each time.
 *
 * **Application permissions this needs:** `User.ReadWrite.All` and
 * `GroupMember.ReadWrite.All`. `Directory.ReadWrite.All` also works and is
 * much broader; the two above are the least that does the job, which is the
 * point of listing them.
 *
 * **There is no `archive`.** Graph's only way to remove an account is
 * `DELETE /users/{id}`, and this connector cannot express that — see
 * `accountMethod` in `document.ts` for why that refusal is structural.
 * `disable` sets `accountEnabled: false`, which is what archiving means here:
 * the account, its mailbox and its OneDrive stay where they are. An
 * organization that genuinely wants the object gone does it in Entra, once,
 * having decided to.
 */
export const entraIdDocument: HttpConnectorDocument = {
  name: 'Microsoft Entra ID',
  version: 1,
  baseUrl: 'https://graph.microsoft.com/v1.0',
  auth: {
    type: 'oauth2',
    tokenUrl: 'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token',
    clientId: '{clientId}',
    scope: 'https://graph.microsoft.com/.default',
  },
  headers: {},
  failures: {
    // Graph answers 429 with Retry-After, which `runWrite` honours, and 503
    // during a throttle it has not classified. Both are the defaults.
    unauthorized: [401, 403],
    notFound: [404],
    conflict: [409],
    throttled: [429],
  },
  account: {
    list: {
      path: '/users',
      query: {
        $select: 'id,userPrincipalName,displayName,givenName,surname,mail,jobTitle,department,accountEnabled',
        $top: '999',
      },
      itemsAt: 'value',
      // `@odata.nextLink` is ONE property whose name contains a dot. `readPath`
      // tries the whole path as a literal key before splitting, which is what
      // makes this expressible without an escaping syntax.
      paging: { style: 'cursor', nextAt: '@odata.nextLink', kind: 'url' },
    },
    anchorAt: 'id',
    correlationAt: 'userPrincipalName',
    fields: {
      userPrincipalName: 'userPrincipalName',
      displayName: 'displayName',
      givenName: 'givenName',
      surname: 'familyName',
      mail: 'mail',
      jobTitle: 'title',
      department: 'department',
      accountEnabled: 'accountEnabled',
    },
    create: {
      method: 'POST',
      path: '/users',
      body: {
        accountEnabled: '{{enabled}}',
        displayName: '{{attr.displayName}}',
        givenName: '{{attr.givenName}}',
        surname: '{{attr.familyName}}',
        mailNickname: '{{correlationKey}}',
        userPrincipalName: '{{attr.userPrincipalName}}',
        jobTitle: '{{attr.title}}',
        department: '{{attr.department}}',
        passwordProfile: {
          password: '{{initialPassword}}',
          forceChangePasswordNextSignIn: true,
        },
        // Where the action that proposed this write is recorded, so a
        // non-idempotent create is safe to retry: a second attempt can find
        // the object the first one made.
        employeeId: '{{actionId}}',
      },
      anchorAt: 'id',
    },
    update: {
      method: 'PATCH',
      path: '/users/{{anchor}}',
      body: {
        displayName: '{{attr.displayName}}',
        givenName: '{{attr.givenName}}',
        surname: '{{attr.familyName}}',
        jobTitle: '{{attr.title}}',
        department: '{{attr.department}}',
      },
    },
    enable: {
      method: 'PATCH',
      path: '/users/{{anchor}}',
      body: { accountEnabled: true },
    },
    disable: {
      method: 'PATCH',
      path: '/users/{{anchor}}',
      body: { accountEnabled: false },
    },
    rename: {
      method: 'PATCH',
      path: '/users/{{anchor}}',
      body: { userPrincipalName: '{{correlationKey}}' },
    },
  },
  entitlement: {
    list: {
      path: '/groups',
      query: { $select: 'id,displayName,description', $top: '999' },
      itemsAt: 'value',
      paging: { style: 'cursor', nextAt: '@odata.nextLink', kind: 'url' },
    },
    anchorAt: 'id',
    displayNameAt: 'displayName',
    descriptionAt: 'description',
    type: 'group',
    members: {
      path: '/groups/{{entitlementId}}/members',
      query: { $select: 'id', $top: '999' },
      itemsAt: 'value',
      paging: { style: 'cursor', nextAt: '@odata.nextLink', kind: 'url' },
      memberAnchorAt: 'id',
    },
    grant: {
      method: 'POST',
      path: '/groups/{{entitlementId}}/members/$ref',
      body: { '@odata.id': 'https://graph.microsoft.com/v1.0/directoryObjects/{{anchor}}' },
    },
    revoke: {
      // DELETE, and permitted: what it removes is the membership edge, which
      // is exactly as reversible as granting it again. The account is
      // untouched. See `membershipMethod`.
      method: 'DELETE',
      path: '/groups/{{entitlementId}}/members/{{anchor}}/$ref',
    },
  },
};
