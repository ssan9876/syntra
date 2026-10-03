import type { HttpConnectorDocument } from '../document.js';

/**
 * Mattermost user accounts and team membership, through the REST API v4.
 *
 * `{instance}` in `baseUrl` is a placeholder an administrator replaces with
 * their own Mattermost host, e.g. `https://chat.example.com/api/v4`.
 *
 * **Credential:** a personal access token of a System Admin account, or of a
 * bot account given the System Admin role. Sent as `Authorization: Bearer`.
 * Personal access tokens are off by default: System Console → Integrations →
 * Integration Management → Enable Personal Access Tokens.
 *
 * **Paging** is numbered from 0, `per_page` at most 200, with no total. The
 * walk ends at the first empty page.
 *
 * **Enabled state is `delete_at`.** Mattermost has no `active` field on a
 * user: a deactivated user has `delete_at` set to the time of deactivation,
 * an active one has `0`. Deactivation is `PUT /users/{id}/active`, which
 * keeps the user's posts, channels and teams.
 *
 * **Bots are not people.** `GET /users` returns bot accounts too; they are
 * excluded by `is_bot` so they never look like unmanaged accounts.
 *
 * **Refusals are `400` with a message.** A taken username or email is
 * `400 {"id": "app.user.save.username_exists.app_error", "message": "An
 * account with that username already exists."}`; `failures.error` makes it a
 * `conflict`.
 *
 * **`props.syntra_action_id` is Syntra's.** A create writes its action id
 * there so a retried create adopts only its own account. Updates never touch
 * it.
 *
 * **Teams are the entitlements.** Granting adds the user to the team;
 * revoking removes the membership and leaves the user and their posts alone.
 * Channels are not modelled.
 *
 * **There is no archive and no delete.** `DELETE /users/{id}` in Mattermost
 * deactivates; a permanent delete needs server settings Syntra does not ask
 * for.
 */
export const mattermostDocument: HttpConnectorDocument = {
  name: 'Mattermost',
  version: 1,
  baseUrl: 'https://{instance}/api/v4',
  auth: { type: 'bearer' },
  headers: { 'User-Agent': 'Syntra-Provisioning/1' },
  failures: {
    unauthorized: [401, 403],
    notFound: [404],
    conflict: [409],
    throttled: [429],
    error: {
      messageAt: 'message',
      conflictWhen: ['already exists'],
      notFoundWhen: ['unable to find'],
    },
  },
  account: {
    list: {
      path: '/users',
      paging: { style: 'page', pageParam: 'page', sizeParam: 'per_page', pageSize: 200, firstPage: 0 },
    },
    anchorAt: 'id',
    correlationAt: 'username',
    provenance: { kind: 'scalar', path: 'props.syntra_action_id' },
    fields: {
      username: 'userName',
      first_name: 'givenName',
      last_name: 'familyName',
      email: 'mail',
      position: 'title',
    },
    enabledWhen: { at: 'delete_at', equals: '0' },
    exclude: [{ at: 'is_bot', equals: 'true' }],
    find: { path: '/users/username/{{correlationKey}}' },
    // Mattermost has no inactive create; a pre-hire is created, then deactivated.
    createsEnabled: true,
    read: { path: '/users/{{anchor}}' },
    create: {
      method: 'POST',
      path: '/users',
      body: {
        username: '{{correlationKey}}',
        email: '{{attr.mail}}',
        first_name: '{{attr.givenName}}',
        last_name: '{{attr.familyName}}',
        position: '{{attr.title}}',
        password: '{{initialPassword}}',
        props: { syntra_action_id: '{{actionId}}' },
      },
      anchorAt: 'id',
    },
    update: {
      method: 'PUT',
      path: '/users/{{anchor}}/patch',
      body: {
        first_name: '{{attr.givenName}}',
        last_name: '{{attr.familyName}}',
        email: '{{attr.mail}}',
        position: '{{attr.title}}',
      },
    },
    rename: {
      method: 'PUT',
      path: '/users/{{anchor}}/patch',
      body: { username: '{{correlationKey}}' },
    },
    enable: { method: 'PUT', path: '/users/{{anchor}}/active', body: { active: true } },
    disable: { method: 'PUT', path: '/users/{{anchor}}/active', body: { active: false } },
  },
  entitlement: {
    list: {
      path: '/teams',
      paging: { style: 'page', pageParam: 'page', sizeParam: 'per_page', pageSize: 200, firstPage: 0 },
    },
    anchorAt: 'id',
    displayNameAt: 'display_name',
    descriptionAt: 'description',
    type: 'group',
    members: {
      path: '/teams/{{entitlementId}}/members',
      paging: { style: 'page', pageParam: 'page', sizeParam: 'per_page', pageSize: 200, firstPage: 0 },
      memberAnchorAt: 'user_id',
    },
    grant: {
      method: 'POST',
      path: '/teams/{{entitlementId}}/members',
      body: { team_id: '{{entitlementId}}', user_id: '{{anchor}}' },
    },
    revoke: { method: 'DELETE', path: '/teams/{{entitlementId}}/members/{{anchor}}' },
  },
};
