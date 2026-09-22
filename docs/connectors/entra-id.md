# Microsoft Entra ID (native connector)

Target type `entraId`. Talks to Microsoft Graph v1.0 directly, through the
same outbound guard every administrator-supplied URL in Syntra goes through.
The shipped `entra-id` document for the `httpJson` connector keeps working;
this connector is what that document could not express: an idempotent
create, a per-user membership read that is complete or says it is not, a
refusal to touch dynamic groups, and a read-back after every write.

Code: `packages/connectors/src/entra/`. Fake for tests:
`packages/connectors/src/testing/fake-graph-server.ts`.

## Capability matrix (version 1)

`ENTRA_CAPABILITY_MATRIX` in `entra/capabilities.ts`, served by
`GET /api/admin/targets/:id/capabilities` and rendered on the target page.

| Capability | Status | Validation | What it does |
| --- | --- | --- | --- |
| readAccounts | available | automated + tenant evidence | Paged `GET /users`; direct memberships per user through `$batch` (20 per call). A user whose membership read fails is returned with `readFailure`, never dropped. |
| createAccount | available | automated + tenant evidence | `POST /users` with the ProvisionAction id in the correlation field. A retry finds the object by that marker and returns its anchor. |
| updateAccount | available | automated + tenant evidence | `PATCH /users/{id}` with the intersection of the requested attributes and `managedAttributes`. Never the UPN, `accountEnabled` or the marker. |
| enableAccount / disableAccount | available | automated + tenant evidence | `PATCH accountEnabled`. |
| renameAccount | available | automated only | `PATCH userPrincipalName` and `mailNickname`. |
| archiveAccount | available | automated + tenant evidence | Revoke each managed membership, then `accountEnabled: false`. No container, no delete. |
| grantEntitlement | available | automated + tenant evidence | `POST /groups/{id}/members/$ref`. Refused before any request for a dynamic group. "Already exists" is success. |
| revokeEntitlement | available | automated + tenant evidence | `DELETE /groups/{id}/members/{user}/$ref`. Absent membership is success; a missing group is `not_found`. |
| readBack | available | automated + tenant evidence | `GET /users/{id}` plus direct `memberOf`. `complete: false` when the membership read fails. |
| searchEntitlements | available | automated only | `$search="displayName:..."` with `ConsistencyLevel: eventual`, falling back to `startswith` on 400. |
| nestedGroups | unsupported | — | Direct memberships only. |
| dynamicGroups | unsupported | — | Listed as `manageable: false`; grants refused. |
| deleteAccount | never | — | No code path issues `DELETE /users`. |

"Automated" means `packages/connectors/src/entra/connector.test.ts` covers
it against the fake Graph. That proves protocol handling and nothing about
Graph itself. An entry marked "tenant evidence" is not proven until a
`pnpm entra:validate --write` evidence file records it passing against a
disposable tenant. Do not claim otherwise in a release note.

## Permissions

Application permissions, with admin consent, and no more:

- `User.ReadWrite.All`
- `GroupMember.ReadWrite.All`
- `Group.Read.All`

Graph does not publish effective application permissions, so the connection
test reports every right as `unverified` with that reason. It does
distinguish a refused credential (401) from missing consent (403) in its
message. Record consent in the readiness check rather than assuming it.

## Configuration

| Key | Default | Notes |
| --- | --- | --- |
| `tenantId` | required | Directory id or a verified domain. A domain lets a correlation key without `@` be completed to a UPN. |
| `clientId` | required | Application (client) id. Not a secret. |
| client secret | vault | Arrives at the connector as `bindPassword`, like every target's one credential. |
| `graphBaseUrl` | `https://graph.microsoft.com/v1.0` | Page pointers are pinned to this origin. |
| `tokenUrl` | `https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token` | |
| `correlationField` | `employeeId` | Or `extensionAttribute1`..`15`. See below. |
| `managedAttributes` | all ten | Subset of: displayName, givenName, familyName (`surname`), mail, title (`jobTitle`), department, officeLocation, companyName, employeeType, usageLocation. |
| `groupScope.securityEnabledOnly` | `true` | Microsoft 365 groups are not entitlements. |
| `groupScope.includeMailEnabled` | `false` | Mail-enabled security groups are excluded unless set. |
| `allowPrivateAddresses` | `false` | Tests only. |
| `timeoutMs` | `30000` | |

There is no option for nested or dynamic groups. See below.

## Database constraint (outstanding)

`TargetSystem` carries a CHECK constraint, `target_system_encrypted_transport`
(migration `20261006000000_http_target_encrypted_transport`), that admits only
`activeDirectory`, `scim2` and `httpJson` rows. **An `entraId` target cannot be
saved until it is extended.** The connector's own schema already refuses a
non-HTTPS `graphBaseUrl` or `tokenUrl` unless `allowPrivateAddresses` is set,
so the database clause mirrors that:

```sql
ALTER TABLE "TargetSystem" DROP CONSTRAINT "target_system_encrypted_transport";
ALTER TABLE "TargetSystem" ADD CONSTRAINT "target_system_encrypted_transport" CHECK (
  ("type" = 'activeDirectory' AND ("config" ->> 'tlsMode') IN ('ldaps', 'starttls'))
  OR ("type" = 'scim2' AND ("config" ->> 'baseUrl') LIKE 'https://%')
  OR ("type" = 'httpJson' AND ("config" #>> '{document,baseUrl}') LIKE 'https://%')
  OR (
    "type" = 'entraId'
    AND coalesce("config" ->> 'graphBaseUrl', 'https://graph.microsoft.com/v1.0') LIKE 'https://%'
    AND coalesce("config" ->> 'tokenUrl', 'https://login.microsoftonline.com/') LIKE 'https://%'
  )
);
```

Two tests are marked `it.skip` with this reason and should be un-skipped when
the migration lands: `target-service.test.ts` ("refuses to borrow an Entra
secret...") and `apps/api/.../provision.test.ts` ("reports the versioned
matrix for a native Entra target").

## The correlation marker

Every `create_account` carries the id of the ProvisionAction that proposed
it. The connector writes that id into `correlationField` on the new user and
never touches it again: an update cannot reach it (`managedAttributes` cannot
name it) and a rename changes only the UPN.

Before any `POST /users`, the connector queries
`$filter=<field> eq '<actionId>'` (with `ConsistencyLevel: eventual` and
`$count=true` for an extension attribute, which is an advanced query). A hit
returns that object's id as the anchor and creates nothing. A query that
fails is reported as a failure, not as "not found", because "not found" is
what leads to a second account.

`userPrincipalName` is the correlation key and the login. It is written on
create and on `rename_account` only.

## Nested and dynamic groups

Not managed, and there is no setting that makes them so.

- **Nested.** `read` and `readBack` report direct memberships only. A group
  somebody holds through another group is not a holding Provision can
  revoke, so it is not one Provision reports as held. A rule naming such a
  group will propose a direct grant.
- **Dynamic.** Entra computes the membership from a rule. A grant would be
  refused by Graph; a revoke would be undone at the next evaluation, so
  Provision would propose it forever. The connector lists dynamic groups in
  the catalog with `manageable: false`, `membershipKind: 'dynamic'` and the
  reason, so a rule author sees what the group is, and refuses a
  `grant_entitlement` against one before making any request.

## Error classification

`classifyGraph` in `entra/graph.ts`. Messages carry the HTTP status and
Graph's stable `error.code`; never `error.message`, never a request body.

| Graph answer | `WriteFailure` | Retried by the run? |
| --- | --- | --- |
| 401, 403 | `unauthorized` | No. Credential or consent. |
| 404 | `not_found` | No. Stale object or group; manual work. |
| 409 | `conflict` | No. |
| 429 | `throttled` with `retryAfterMs` from `Retry-After` | Yes, after the delay, within the run's throttle budget. |
| 5xx, connection failure | `transient` | Yes, bounded by `maxAttempts`. |
| anything else | `rejected` | No. |

Inside a `$batch`, only the throttled sub-requests are retried, after the
largest `Retry-After` among them, at most four rounds.

Token endpoint failures surface as `the token endpoint answered HTTP <n>
(AADSTS<code>)`. The body is never surfaced: it can echo the request.

## Credential rotation

1. Add the new secret to the app registration.
2. Edit the target and type the new secret into the client secret field.
   Saving does three things: writes the vault entry the row names, clears
   the in-memory token caches (`forgetAccessTokens()` and
   `forgetEntraTokens()`), and tests the saved configuration with the new
   secret, recording a readiness check whose message starts with
   `credential rotated:`.
3. Check the readiness history on the target. A failed check there means the
   new secret does not work and the old one is still cached nowhere.
4. Remove the old secret from the app registration.

The token cache is keyed on a digest of the secret as well as the client id,
so a rotated secret can never be served a token the old one obtained, and a
wrong secret can never be masked by a token a right one left behind.

## Validating against a disposable tenant

```
ENTRA_TENANT_ID=contoso.onmicrosoft.com \
ENTRA_CLIENT_ID=... ENTRA_CLIENT_SECRET=... \
pnpm entra:validate
```

Read-only: token, users with paging, groups, search, read-back of the first
user. Add `--write` (refused unless `ENTRA_DISPOSABLE_TENANT=yes`) to create a
user named `${ENTRA_TEST_USER_PREFIX}<runid>@${ENTRA_TEST_DOMAIN}`, create it
again under the same action id (expecting the same anchor), update a managed
field, grant and revoke each id in `ENTRA_TEST_GROUP_IDS`, and disable it,
reading back after every step with a short wait for Graph to catch up. The
user is left disabled and is never deleted.

Evidence is written to `test-results/entra-evidence-<iso>.json` as rows of
`{ capability, operationId, anchor, expected, observed, timestamp, pass }`
and printed as a table. Attach that file to the release that claims the
capability.
