# Microsoft Entra ID (native connector)

## Migrating a document-driven Entra target

An existing `httpJson` target pointed at Microsoft Graph can be converted in
place from its target page. Syntra first produces a revision-bound preview of
the derived native configuration and the accounts, entitlements, rules, run
history, schedule, profile, target identifier, and saved credential that will
be preserved. Applying the preview changes only the adapter type and config;
the credential is never returned to the browser. The apply writes
`provision.target.connector-migrate` to the audit chain and refuses a preview
if the target changed after it was generated.

The migration accepts only the supported Microsoft Graph base URL and the
standard HTTPS Microsoft identity v2 token endpoint. After applying it, test
the native connection and run a lifecycle simulation before enabling external
writes. Earlier readiness evidence is intentionally stale because the
configuration fingerprint changed.

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

| Capability | Status | Required Graph application permission(s) | Validation | What it does |
| --- | --- | --- | --- | --- |
| readAccounts | available | `User.Read.All`, `GroupMember.Read.All` | automated + tenant evidence | Paged `GET /users`; direct memberships per user through `$batch` (20 per call). A user whose membership read fails is returned with `readFailure`, never dropped. |
| createAccount | available | `User.ReadWrite.All` | automated + tenant evidence | `POST /users` with the ProvisionAction id in the correlation field. A retry finds the object by that marker and returns its anchor. |
| updateAccount | available | `User.ReadWrite.All` | automated + tenant evidence | `PATCH /users/{id}` with the intersection of the requested attributes and `managedAttributes`. Never the UPN, `accountEnabled` or the marker. |
| enableAccount / disableAccount | available | `User.ReadWrite.All` | automated + tenant evidence | `PATCH accountEnabled`. |
| renameAccount | available | `User.ReadWrite.All` | automated only | `PATCH userPrincipalName` and `mailNickname`. |
| archiveAccount | available | `User.ReadWrite.All`, `GroupMember.ReadWrite.All` | automated + tenant evidence | Revoke each managed membership, then `accountEnabled: false`. No container, no delete. |
| grantEntitlement | available | `GroupMember.ReadWrite.All` | automated + tenant evidence | `POST /groups/{id}/members/$ref`. Refused before any request for a dynamic group. "Already exists" is success. |
| revokeEntitlement | available | `GroupMember.ReadWrite.All` | automated + tenant evidence | `DELETE /groups/{id}/members/{user}/$ref`. Absent membership is success; a missing group is `not_found`. |
| readBack | available | `User.Read.All`, `GroupMember.Read.All` | automated + tenant evidence | `GET /users/{id}` plus direct `memberOf`. `complete: false` when the membership read fails. |
| searchEntitlements | available | `Group.Read.All` | automated only | `$search="displayName:..."` with `ConsistencyLevel: eventual`, falling back to `startswith` on 400. |
| nestedGroups | unsupported | — | Direct memberships only. |
| dynamicGroups | unsupported | — | Listed as `manageable: false`; grants refused. |
| deleteAccount | never | — | No code path issues `DELETE /users`. |
| readCredentialExpiry | available (optional) | `Application.Read.All` | automated only | Reads the app registration's own `passwordCredentials` so the credential inventory can show the client secret's expiry. Without consent Graph answers 403 and the expiry stays declared or unknown; nothing else changes. |

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

Optionally `Application.Read.All`, only so the credential inventory can
discover the client secret's expiry (`readCredentialExpiry`; see
[Credentials and security notifications](../configure.md#the-credential-inventory)).
Provisioning never needs it.

Graph does not publish effective application permissions, so the connection
test reports every right as `unverified` with that reason. It does
distinguish a refused credential (401) from missing consent (403) in its
message. Record consent in the readiness check rather than assuming it.

## Configuration

| Key | Default | Notes |
| --- | --- | --- |
| `tenantId` | required | Directory id (the GUID, which Microsoft recommends) or a verified domain. |
| `clientId` | required | Application (client) id. Not a secret. |
| `userPrincipalDomain` | none | The domain new users sign in with, e.g. `contoso.com`. Must be a verified domain of the tenant; a lowercase domain name only (no `@`, scheme or path). Required whenever `tenantId` is the directory GUID. See *User principal names*. Console: **User principal name domain**. |
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

## Database transport constraint

Native Entra targets are admitted by migration
`20261008000000_entra_target_transport`; migration
`20261010000000_target_transport_not_null` closes PostgreSQL's NULL pass-through
in the same CHECK constraint. The database therefore requires HTTPS Graph and
token endpoints for `entraId`, matching the connector schema. A native Entra
target can be saved once both migrations are applied.

## The correlation marker

Every `create_account` carries the id of the ProvisionAction that proposed
it. The connector writes a deterministic marker into `correlationField` on
the new user and never touches it again: an update cannot reach it
(`managedAttributes` cannot name it) and a rename changes only the UPN. When
the field is `employeeId`, Microsoft Graph limits it to 16 characters, so a
long action id is represented by the first 16 base64url characters of its
SHA-256 digest. Retries derive the same marker; the 96-bit value avoids the
unsafe UUID truncation that would otherwise make the field fit.

Before any `POST /users`, the connector queries
`$filter=<field> eq '<actionId>'` (with `ConsistencyLevel: eventual` and
`$count=true` for an extension attribute, which is an advanced query). A hit
returns that object's id as the anchor and creates nothing. A query that
fails is reported as a failure, not as "not found", because "not found" is
what leads to a second account.

`userPrincipalName` is the correlation key and the login. It is written on
create and on `rename_account` only.

## User principal names

A generated correlation key never contains `@`: the account-name template is
normalised to lowercase letters, digits, `.` and `-`. The connector therefore
completes it to a UPN, in this order:

1. a key that already contains `@` is used as it is;
2. otherwise `<key>@<userPrincipalDomain>`;
3. otherwise `<key>@<tenantId>`, when `tenantId` is itself a domain;
4. otherwise the create is refused, naming `userPrincipalDomain`.

With the directory GUID as `tenantId` and no `userPrincipalDomain`, no account
can be created. This is caught before apply: the account-profile preview
(`POST /api/admin/targets/:id/profile/preview`, the **Preview** button on the
account profile) shows the full UPN each person would get, and reports a
problem when none can be formed.

`userPrincipalDomain` is not part of the transport. Changing it never
requires re-entering the client secret, and a connection test may still
borrow the saved secret, because it changes what users are called, not where
the secret is sent.

## Existing users and adoption

Syntra compares a user it reads from Graph with a correlation key by the
**local part** of the user's `userPrincipalName`, and only when the UPN's
domain is the one Syntra would create it in (`userPrincipalDomain`, else a
domain `tenantId`). `anna.novak@contoso.com` holds the key `anna.novak` on a
target whose domain is `contoso.com`; `anna.novak@partner.example` holds no
key at all and is never matched. The domain is compared case-insensitively.

What that means for users who already exist in the tenant:

- **A run never takes an existing user over.** A provisioning run binds a
  person to a Graph user only by its object id (the anchor), never by name. An
  in-domain user whose name a person would be generated reserves that name,
  exactly as a hand-made `sAMAccountName` does in Active Directory: the person
  is proposed the next free name (`anna.novak2`), and the existing user is not
  written to.
- **A collision is a `conflict`.** When Graph refuses a create because the UPN
  is taken (the user appeared after the plan was made, or before this
  behaviour existed), the account is marked `conflict` and the person is left
  alone by every later run.
- **Adoption is the way out, and it is a person's decision.** On the person's
  account, **Adopt** first shows the specific Graph user it would bind
  (`GET /api/admin/targets/:id/accounts/:personId/adoption-candidate`), found
  by the same local-part rule, then binds it on a written reason
  (`POST …/adopt`). Adoption performs one read and no write in Entra; managed
  attributes converge on the next run, in a plan somebody reviews. A user in
  another domain is not offered: the candidate lookup answers `404
  candidate-not-visible` ("no account named … is visible in the target").

## Containers are not used

Entra ID has no organizational units. The connector declares that it places
accounts in no container (`placesAccountsInContainers` is `false`), so a
provisioning run skips the container check entirely for this target: no
`container_missing`, no `container_vanished`, no container creation. The
account profile's **Container template** and **Fallback container** are
ignored; the schema still requires them, and `/` is the conventional value.
Manually moving an account on this target is refused with `409
no-containers`, and so is mapping an org unit to a container on it; turning
on **Mirror org units as OUs** is refused too (`422 mirror-unsupported`).

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
