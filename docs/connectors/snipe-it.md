# Snipe-IT (document-driven HTTP connector)

Target type `httpJson`, with the shipped **Snipe-IT** connector document
(`packages/connectors/src/http/documents/snipe-it.ts`). It provisions
Snipe-IT **user accounts** through the REST API v1. It runs on the
document-driven HTTP adapter, which is `preview` / `controlled` in the
connector catalog (see [certification and rollout](certification-and-rollout.md)).

## What is supported

| Operation | Request | Notes |
| --- | --- | --- |
| Read accounts | `GET /api/v1/users?sort=id&order=asc&limit=500&offset=N` | Offset paging, held to the response's `total`. |
| Create | `POST /api/v1/users` | `first_name`, `last_name`, `username`, `email`, `jobtitle`, `password` + `password_confirmation` (the run's initial password), `activated`, `employee_num` (Syntra's marker). The new id is read from `payload.id`. |
| Update | `PATCH /api/v1/users/{id}` | `first_name`, `last_name`, `email`, `jobtitle`. |
| Rename | `PATCH /api/v1/users/{id}` | `username`. |
| Deactivate (leaver) | `PATCH /api/v1/users/{id}` | `activated: false`. Snipe-IT's "This user can login" switch. |
| Reactivate | `PATCH /api/v1/users/{id}` | `activated: true`. |
| Read-back | `GET /api/v1/users/{id}` | One request per check; a missing user reads back as absent. |

Target capabilities advertised: read-back, create, update, disable/enable.
Entitlements are not.

## What is not supported

- **Groups, permissions and entitlements.** The document declares none.
- **Deletion and archive.** Snipe-IT keeps a user's checkout and asset
  history; a leaver is deactivated, never deleted. The HTTP connector cannot
  express `DELETE` on an account at all, and the document declares no
  `archive`, so an archive action is refused.
- **Departments, locations, companies, managers.** Snipe-IT takes these by
  numeric id (`department_id`, `location_id`, …), which an account-profile
  template cannot know. Set them in Snipe-IT.

## Refusals answered with 200 OK

Snipe-IT answers "200 OK" whenever the HTTP request itself was sound, and
puts refusals in the body:

```json
{"status":"error","messages":{"username":["The username has already been taken."]},"payload":null}
```

The document declares this through `failures.body`:

```json
"body": {
  "at": "status",
  "equals": "error",
  "messageAt": "messages",
  "conflictWhen": ["already been taken"],
  "notFoundWhen": ["not found", "does not exist"]
}
```

A 2xx whose `status` is `error` is a failure: `conflict` when the message
says a value is already taken, `not_found` when the user is gone, otherwise
`rejected`. The message shown on the run is Snipe-IT's own `messages`,
flattened, cut to 300 characters and passed through the connector redaction
rules; the API key and the initial password are removed by value, e-mail
addresses and token-shaped strings by shape. Request bodies are never shown.
HTTP 401/403 are `unauthorized`, 404 `not_found`, 429 `throttled` (Snipe-IT
throttles the API at 120 requests a minute by default).

## The API key

1. Sign in to Snipe-IT as the account Syntra should act as. It needs
   permission to view, create and edit users (a superuser works; a narrower
   permission group with the Users permissions is better).
2. Your user menu (top right) → **Manage API Keys** → **Create New Token**.
3. Copy the token. Snipe-IT shows it once.
4. In Syntra: **Targets → New target → Type: REST API →
   Snipe-IT**, paste the token as **Personal API key**. It is stored in the
   vault and sent as `Authorization: Bearer <key>`.
5. Open **Edit the connector document** and replace `{instance}` in
   `baseUrl` with your host, e.g. `https://assets.example.com/api/v1`.
   Set `allowPrivateAddresses: true` only when the instance is on a private
   network address.

## The marker in `employee_num`

A create writes the id of the ProvisionAction that proposed it into
`employee_num`. A retried create (after a lost response) lists users, finds
the username, and adopts the account only when `employee_num` holds that same
action id; any other account with the name is a `conflict`, never adopted
silently. Updates never write `employee_num`.

If your Snipe-IT already uses employee numbers, change `provenance.path` and
the `employee_num` key in the create body to a field you do not use before
the first create. Without a provenance field the connector refuses to create.

## Account-profile values

The document maps these Snipe-IT fields to Syntra attribute names:

| Snipe-IT field | Syntra attribute | Written by |
| --- | --- | --- |
| `username` | `userName` (correlation) | create (from the correlation key), rename |
| `first_name` | `givenName` | create, update |
| `last_name` | `familyName` | create, update |
| `email` | `mail` | create, update |
| `jobtitle` | `title` | create, update |
| `activated` | `enabled` | create (`{{enabled}}`), enable, disable |
| `employee_num` | — (provenance, not an attribute) | create only |

A starting account profile:

- **Correlation key template:** `%person.givenName.initial%%person.familyName%`
  (`jdoe`), or `%person.givenName%.%person.familyName%` (`jane.doe`).
  Syntra lowercases it and keeps letters, digits, `.` and `-`.
- **Attribute templates:**
  - `givenName`: `%person.givenName%` (required: Snipe-IT refuses a user
    without a first name)
  - `familyName`: `%person.familyName%`
  - `mail`: `%person.businessEmail%`
  - `title`: `%contract.jobTitle%`
- **Initial password:** Snipe-IT requires one on create (at least 8
  characters by default, or your instance's password policy). The run's
  generated initial password (16 characters or more, per the profile's
  initial-password policy) is sent as both `password` and
  `password_confirmation`.

Do not add a `displayName` template: Snipe-IT derives `name` from first and
last name and the document neither reads nor writes it.

## Cloudflare and the User-Agent

Instances fronted by Cloudflare (including many hosted ones) refuse
requests with no or a default bot user agent with **error 1010**, which
looks like an authentication failure. Node sends no `User-Agent` by
default, so the document sets `"User-Agent": "Syntra-Provisioning/1"` under
`headers`. Keep it, or replace it with another explicit value your
Cloudflare rules allow. `Accept: application/json` and, on writes,
`Content-Type: application/json` are sent by the connector itself.

## Verification status

- Shapes follow the official API reference at
  <https://snipe-it.readme.io/reference> (users list/create fields, the
  `{total, rows}` list, `200` + `"status":"error"` refusals). The exact
  wording of Snipe-IT's "not found" message and the create response's
  `payload` shape come from the Snipe-IT source's standard API response
  and have not been checked against a live instance by this release.
- Automated: `packages/connectors/src/http/snipe-it.test.ts` runs the shared
  certification contract and the cases above against an in-memory Snipe-IT
  (`packages/connectors/src/testing/fake-snipe-it.ts`). That proves protocol
  handling, not Snipe-IT itself: run a lifecycle simulation and one real
  create/deactivate against a test instance before enabling external writes.
