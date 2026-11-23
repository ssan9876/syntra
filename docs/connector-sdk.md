# Connector SDK

A **connector service** is a small HTTPS service you run that provisions into
one system. Syntra calls it; it calls the system. Use it when no built-in
target type and no [REST connector document](configure.md#rest-api-connector-documents)
can express the system: a multi-step create, a SOAP API, a database, a
command-line tool.

Your code runs in your process, on your host. Syntra loads none of it.

```
Syntra ──HTTPS, signed──▶ your connector service ──whatever it speaks──▶ the system
```

This page is the protocol, version 1. The package `@syntra/connector-sdk`
([`packages/connector-sdk`](../packages/connector-sdk/)) implements both ends of it in TypeScript: the
schemas, a request handler for `node:http` that does the signing, versioning,
validation and error mapping, and a certification runner. A service in another
language follows this page and
[`protocol.schema.json`](../packages/connector-sdk/protocol.schema.json),
which is generated from the same schemas Syntra validates against.

## Quick start

```ts
import { createConnectorServer, ConnectorError } from '@syntra/connector-sdk';

const server = createConnectorServer({
  secrets: process.env.CONNECTOR_SECRET!,
  connector: {
    name: 'Acme HR',
    version: '1.0.0',
    schema: { objectClasses: ['user'], attributes: ['displayName', 'mail'] },
    accounts: {
      async list({ cursor, pageSize }) { /* … */ },
      async read({ anchor }) { /* … */ },
    },
    write: {
      async create_account(op) { /* … return { ok: true, message: 'Created.', anchor } */ },
      async update_account(op) { /* … */ },
      async disable_account(op) {
        throw new ConnectorError('not_found', `Account ${op.anchor} not found.`);
      },
    },
  },
});
server.listen(8080, '127.0.0.1');
```

A complete connector over an in-memory store is
[`src/example/in-memory.ts`](../packages/connector-sdk/src/example/in-memory.ts). Run it with:

```bash
CONNECTOR_SECRET=$(openssl rand -base64 32) PORT=8080 \
  npx tsx packages/connector-sdk/src/example/serve.ts
```

Then in Syntra: **Target systems → New target**, type **Connector service**,
the service URL and the same secret, and **Test connection**. Syntra saves
only `https://` service URLs, so put a TLS proxy in front of the service, or
mount `createConnectorRequestListener` on `https.createServer`.

## Calls

Every call is `POST {baseUrl}/{method}` with a JSON body, answered `200` with
JSON. The methods map one to one onto Syntra's own target connector interface.

| Method | Request | Answer | Required |
|---|---|---|---|
| `describe` | `{}` | protocol versions, connector name and version, capabilities, schema | yes |
| `test` | `{}` | `{ ok, message }`: can the service reach the system | no (default: ok) |
| `accounts.list` | `{ cursor, pageSize }` | `{ accounts, nextCursor }` | yes |
| `accounts.read` | `{ anchor }` | `{ account, entitlementIds, entitlementsComplete }` | yes |
| `entitlements.list` | `{ cursor, pageSize }` | `{ entitlements, nextCursor }` | with entitlements |
| `entitlements.members` | `{ entitlementId }` | `{ members }`: every member's anchor | with entitlements |
| `containers.list` | `{ cursor, pageSize }` | `{ containers, nextCursor }` | with containers |
| `write` | `{ operation }` | `{ ok: true, message, anchor? }` or `{ ok: false, failure, message, retryAfterMs? }` | one handler per write |

**Paging.** `cursor` is `null` for the first page and the previous answer's
`nextCursor` after that; `nextCursor: null` ends the list. `pageSize` is an
upper bound. A service that returns the same cursor twice fails the read.

**An account** is `{ anchor, correlationKey, dn?, attributes, enabled, readFailure? }`:

- `anchor`: the system's immutable id. Never the login.
- `correlationKey`: the login Syntra matches people on, the value
  `create_account` and `rename_account` set.
- `attributes`: multi-valued, `{ "mail": ["anna@acme.test"] }`, under the
  names Syntra writes them with in the account profile.
- `enabled`: `true`, `false`, or `null` when the system does not say. `null`
  leaves every read-back incomplete.
- `readFailure`: set when the account exists but could not be read in full.
  Syntra counts it as present and leaves it out of the plan.
- The attribute names `active`, `enabled`, `accountEnabled`,
  `userAccountControl` and `correlationKey` are reserved, compared without
  case. An answer that uses one is refused.

**An entitlement** is `{ id, type, displayName, description?, manageable?, unmanageableReason?, membershipKind? }`,
with `type` one of `group`, `licence`, `role`. `manageable: false` lists one
Syntra must not grant, such as a dynamic group.

**Read-back.** After a write Syntra calls `accounts.read` and checks the
result. `entitlementIds` is every entitlement the account holds;
`entitlementsComplete` is `false` when any membership could not be read.
`entitlements.members` answers every member or an error, never part of a list:
half a membership read as the whole one makes a run grant or revoke for
everybody in the other half.

## Writes

`operation` is one of these, the same set Syntra plans:

| `op` | Fields | Notes |
|---|---|---|
| `create_account` | `correlationKey`, `attributes`, `enabled`, `initialPassword`, `requirePasswordChange?` | Answer with the new `anchor`. Never log the password. |
| `update_account` | `anchor`, `attributes` | The complete set Syntra manages, not a change list. |
| `enable_account` | `anchor` | |
| `disable_account` | `anchor`, `reason` | |
| `archive_account` | `anchor`, `entitlementDns` | Disable, and revoke exactly these entitlement ids. |
| `rename_account` | `anchor`, `correlationKey` | |
| `grant_entitlement` / `revoke_entitlement` | `anchor`, `entitlementId` | |
| `create_container` / `move_container` | `dn` / `fromDn`, `toDn` | A missing parent is `not_found`. |
| `delete_account` | `anchor` | Delete only a disabled account. |

Syntra's `remote` adapter 1.0.0 is certified for the account and entitlement
writes only, so it does not send `create_container`, `move_container` or
`delete_account` yet. They are in the protocol so a service can implement them
now.

Every operation carries `actionId`.

**Idempotency.** `actionId` is the idempotency key. Syntra sends the same
operation with the same `actionId` again after a timeout, a dropped connection
or a `transient` failure, and the service must answer the retry the way it
answered the first attempt. A retried `create_account` returns the anchor of
the account the first attempt created: record the `actionId` on the account
where the system has room for it, and look it up before creating. The rest are
naturally idempotent because they set state rather than change it.

The SDK does not keep an idempotency cache for you. The first attempt may have
reached the system before the service restarted, so only the system itself
can say whether it happened.

**Failures.** A failure the system reported is a `200` answer with `ok: false`
and one of:

| `failure` | Meaning | Retried |
|---|---|---|
| `transient` | Try again. | yes |
| `throttled` | Try again after `retryAfterMs`. | yes |
| `conflict` | The object exists and is not this action's. | no |
| `rejected` | The system refused the values. | no |
| `unauthorized` | The system refused the service's own credential. | no |
| `not_found` | No such account, entitlement or parent container. | no |

With the SDK, throw `ConnectorError(failure, message)` from a handler. Any
other error becomes `transient` with a generic message, and is passed to
`onError` for your log. A write with no handler is answered `rejected`.
Messages reach the administrator: name the object and the cause,
`Account 4711 not found.`

## Signing

Every request carries:

| Header | Value |
|---|---|
| `Syntra-Protocol-Version` | `1` |
| `Syntra-Timestamp` | Unix time in seconds |
| `Syntra-Nonce` | a fresh UUID |
| `Syntra-Signature` | `v1=` and the hex HMAC-SHA256 below |
| `Syntra-Timeout-Ms` | how long Syntra waits |

The signature is HMAC-SHA256, keyed with the shared secret, over:

```
v1 \n <timestamp> \n <nonce> \n <method> \n <hex SHA-256 of the body>
```

`<method>` is the last path segment (`accounts.list`), not the full path, so a
proxy that rewrites the prefix does not break it. The service refuses with
`401` a request that is unsigned, signed with another secret, more than 300 s
from its clock, or carrying a nonce it has already seen.

**Why a signature and not a bearer token.** The secret never travels. A bearer
token read from one request, in a proxy log or a debugging dump, is the
credential itself and works from anywhere until it is rotated. A signature
covers one body and one method for five minutes, and the nonce makes it work
once.

The SDK keeps seen nonces in memory, which protects one process. A service run
as several replicas passes a shared `NonceStore`. A replay that reaches another
replica repeats a write that already happened, because writes are idempotent.

**The secret** is at least 32 characters (`openssl rand -base64 32`). Both
ends refuse a shorter one. To rotate it, start the service with both,
`secrets: [next, current]`, change it on the target, then drop the old one.

Syntra authenticates the service by its TLS certificate. Responses are not
signed.

## Versions

`describe` is the handshake. It answers `protocolVersions`, every version the
service speaks, and Syntra's **Test connection** refuses a service that does
not speak Syntra's: `Connector service "Acme HR" speaks protocol 2. Syntra
speaks 1. Update the connector service or Syntra.` Every other call carries
`Syntra-Protocol-Version`, and the service answers one it does not speak with
`400 unsupported_version` and its `supportedVersions`.

Within a version, both ends ignore fields they do not know. A change to the
meaning of an existing field is a new version. `describe` keeps its shape in
every version.

## Errors and timeouts

A call that cannot be answered at all gets a non-2xx status and
`{ "error": { "code", "message", "supportedVersions"?, "retryAfterMs"? } }`:

| Code | Status | What Syntra does with a write |
|---|---|---|
| `unauthenticated` | 401 | `unauthorized` |
| `unsupported_version`, `invalid_request` | 400 | `rejected` |
| `unknown_method` | 404 | `rejected` |
| `payload_too_large` | 413 | `rejected` |
| `throttled` | 429 | `throttled`, after `retryAfterMs` or `Retry-After` |
| `internal` | 500 | `transient` |
| `not_implemented` | 501 | `rejected` |
| `unavailable` | 503 | `transient` |

No answer within the target's `timeoutMs` (30 s by default), a dropped
connection and an answer that is not the protocol are all `transient`: the
write may or may not have happened, and the retry is safe because of
idempotency. The target's **Maximum attempts per action** bounds the retries.
A read that fails any of these ways is an error, never an empty or shorter
list.

A handler is given a `signal` that fires when Syntra stops waiting.

Requests go through Syntra's outbound guard: the service URL may not resolve
to a private address unless the target sets `allowPrivateAddresses`, and
redirects are not followed. An answer may be up to 8 MiB.

## Certify your service

Point the runner at a running service and a disposable system. It checks the
protocol first (an unsigned request, a wrong secret, a stale timestamp, a
replayed nonce, a changed body and a foreign version are all refused), then
the lifecycle every built-in target passes: create, the retried create returns
the same anchor, read-back, update twice, grant and revoke, disable twice, and
`not_found` for a missing account.

```ts
import { certifyConnectorService } from '@syntra/connector-sdk';

const report = await certifyConnectorService({
  baseUrl: 'http://127.0.0.1:8080',
  secret: process.env.CONNECTOR_SECRET!,
  create: {
    op: 'create_account',
    actionId: 'cert-create-1',
    correlationKey: 'cert.user',
    attributes: { displayName: ['Certification User'] },
    enabled: true,
    initialPassword: 'Initial-Passw0rd!',
  },
  update: (anchor) => ({ op: 'update_account', actionId: 'cert-update-1', anchor, attributes: { displayName: ['Updated'] } }),
  disable: (anchor) => ({ op: 'disable_account', actionId: 'cert-disable-1', anchor, reason: 'certification' }),
  entitlement: {
    id: 'staff',
    grant: (anchor) => ({ op: 'grant_entitlement', actionId: 'cert-grant-1', anchor, entitlementId: 'staff' }),
    revoke: (anchor) => ({ op: 'revoke_entitlement', actionId: 'cert-revoke-1', anchor, entitlementId: 'staff' }),
  },
  missingAnchor: 'does-not-exist',
});
console.log(report.checks);
```

It throws at the first check that fails, naming it. Leave out `update`,
`disable` or `entitlement` and those operations are not certified.

## Target settings

The Syntra side, type `remote`, is in
[Configure → Connector service targets](configure.md#connector-service-targets).
