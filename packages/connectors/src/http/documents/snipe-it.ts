import type { HttpConnectorDocument } from '../document.js';

/**
 * Snipe-IT user accounts, through the REST API v1.
 *
 * `{instance}` in `baseUrl` is a placeholder an administrator replaces with
 * their own Snipe-IT host, e.g. `https://assets.example.com/api/v1`.
 *
 * **Credential:** a Personal API key (Snipe-IT → your user menu → Manage API
 * Keys → Create New Token) of an account allowed to view, create and edit
 * users. Sent as `Authorization: Bearer <key>`.
 *
 * **Users only.** No groups, no departments or locations (Snipe-IT takes
 * those by numeric id, which a template cannot know).
 *
 * **Snipe-IT answers `200 OK` to a refused request**, with
 * `{"status":"error","messages":...}` in the body. `failures.body` is what
 * makes a taken username a `conflict` and a vanished user `not_found` rather
 * than a success nobody can find afterwards.
 *
 * **`employee_num` is Syntra's.** A create writes its action id there, so a
 * retried create can find the account the first attempt made; updates never
 * touch it. An organisation already using employee numbers in Snipe-IT
 * should change `provenance.path` and the create body to a field it does not
 * use before creating anyone.
 *
 * **There is no `archive` and no delete.** Snipe-IT keeps a user's asset
 * history; a leaver is deactivated (`activated: false`, "can log in" off),
 * which is reversible.
 *
 * **The `User-Agent` is not decoration.** Instances behind Cloudflare refuse
 * requests with no or a default bot user agent (error 1010), and Node sends
 * none.
 */
export const snipeItDocument: HttpConnectorDocument = {
  name: 'Snipe-IT',
  version: 1,
  baseUrl: 'https://{instance}/api/v1',
  auth: { type: 'bearer' },
  headers: {
    // `Accept: application/json` on every request and `Content-Type:
    // application/json` on every request with a body are sent by the
    // connector itself.
    'User-Agent': 'Syntra-Provisioning/1',
  },
  failures: {
    unauthorized: [401, 403],
    notFound: [404],
    conflict: [409],
    // Snipe-IT's API throttle (120 requests a minute by default) answers 429.
    throttled: [429],
    body: {
      at: 'status',
      equals: 'error',
      messageAt: 'messages',
      // Laravel's unique-rule message: "The username has already been taken."
      conflictWhen: ['already been taken'],
      // "User not found" / "... does not exist", answered with 200 as well.
      notFoundWhen: ['not found', 'does not exist'],
    },
  },
  account: {
    list: {
      path: '/users',
      // Ordered by id so an offset walk sees a stable sequence.
      query: { sort: 'id', order: 'asc' },
      itemsAt: 'rows',
      // `total` is declared because Snipe-IT caps `limit` at its own
      // `max_results` setting without saying so; see `totalAt`.
      paging: { style: 'offset', limitParam: 'limit', offsetParam: 'offset', pageSize: 500, totalAt: 'total' },
    },
    anchorAt: 'id',
    correlationAt: 'username',
    provenance: { kind: 'scalar', path: 'employee_num' },
    fields: {
      username: 'userName',
      first_name: 'givenName',
      last_name: 'familyName',
      email: 'mail',
      jobtitle: 'title',
      activated: 'enabled',
    },
    read: { path: '/users/{{anchor}}' },
    create: {
      method: 'POST',
      path: '/users',
      body: {
        first_name: '{{attr.givenName}}',
        last_name: '{{attr.familyName}}',
        username: '{{correlationKey}}',
        email: '{{attr.mail}}',
        jobtitle: '{{attr.title}}',
        // Snipe-IT requires both on create.
        password: '{{initialPassword}}',
        password_confirmation: '{{initialPassword}}',
        activated: '{{enabled}}',
        employee_num: '{{actionId}}',
      },
      anchorAt: 'payload.id',
    },
    update: {
      method: 'PATCH',
      path: '/users/{{anchor}}',
      body: {
        first_name: '{{attr.givenName}}',
        last_name: '{{attr.familyName}}',
        email: '{{attr.mail}}',
        jobtitle: '{{attr.title}}',
      },
    },
    enable: {
      method: 'PATCH',
      path: '/users/{{anchor}}',
      body: { activated: true },
    },
    disable: {
      method: 'PATCH',
      path: '/users/{{anchor}}',
      body: { activated: false },
    },
    rename: {
      method: 'PATCH',
      path: '/users/{{anchor}}',
      body: { username: '{{correlationKey}}' },
    },
  },
};
