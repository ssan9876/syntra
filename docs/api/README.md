# The administration API

Syntra's console is a client of its own HTTP API, and that API is published so
that integrations can call it too. This directory is its contract:

- [`openapi.json`](openapi.json) — the OpenAPI 3.1 description of every
  `/api/admin/…` operation. Generated, committed, and checked in CI.
- This file — the promises the description cannot express: versioning,
  deprecation, errors, idempotency, rate limits, and generating a client.

A running deployment serves the same document at **`GET /api/openapi.json`**.
It needs no session, answers on any hostname, and contains nothing from any
tenant, so it can be fetched before anybody has an account.

## What it covers, and what it does not

**Covered:** the administration API under `/api/admin` — directory, people,
lifecycle, provisioning, governance, access, tenant settings and the rest —
including the handful of routes a machine token is refused at. Those are
published with session-only security so an integrator can see that they exist
and why a token cannot call them.

**Not covered, deliberately:**

- **SCIM** (`/scim/v2`). It follows its own standard, RFC 7643 and RFC 7644,
  and its clients are built against that.
- **Protocols**: OpenID Connect (`/oidc`), SAML (`/saml`), WS-Federation and
  upstream federation (`/federation`). Each is described by its own discovery
  or metadata document.
- **Sign-in and the portal** (`/api/auth`, `/api/portal`). These are for
  people, and a token is refused at both.

## Authenticating

An integration presents an **API token** issued to a service account:

```
Authorization: Bearer syntra_pat_…
```

See [Machine access](../configure.md#machine-access) for issuing tokens. In
short, a token can do what its account's roles allow, narrowed to the token's
own scopes. It is the intersection of the two, never the union. The
description names both schemes: `bearerToken` for integrations, and
`sessionCookie` for the console's own session.

Each operation carries two Syntra extensions that answer "can my token call
this?" without trial and error:

| Extension | Meaning |
| --- | --- |
| `x-syntra-permission` | The permissions the operation checks, as an array. **All** of them are required. Read from the route's own guards when the document is generated, so it cannot disagree with the server. |
| `x-syntra-token-allowed` | `false` for the routes that refuse a bearer token whatever it holds: password setting, token minting, the tenant-wide session revoke, and tenant deletion. The server answers those with `403 token-not-accepted`. |
| `x-syntra-paginated` | The operation takes `page` and `pageSize` and returns the paging envelope described below. |
| `x-syntra-rate-limit` | A per-route limit (`max` per `window`), where the route has one. |
| `x-syntra-deprecation` | `since`, `sunset` and, when there is one, `replacement`. |

## Versioning

The contract's version is `info.version` in the document, and it follows
semantic versioning. It is the version of the **API**, not of the product: a
release that changes no operation leaves it where it was.

**Within major version 1, only additive changes ship.** These count as
additive:

- a new operation;
- a new optional request field or query parameter;
- a new response field;
- a new value in a response enum;
- a new problem `type`;
- a new, looser limit on an input.

These are **breaking**, and happen only in a new major version, after the
deprecation notice below:

- removing or renaming an operation, a path, or a field;
- making an optional input required;
- narrowing an input's type or limits;
- changing a success status code;
- changing the meaning of an existing field;
- changing an `operationId`. Generated clients name their methods after it, so
  an `operationId` is as much a part of the contract as a path.

A client should therefore **ignore response fields it does not know, and
tolerate enum values it does not know**. Both are additive changes, and a
client that rejects them will break on a minor version.

The minor version goes up for an addition. The patch version goes up for a
correction to the description that changes no behaviour, such as a clearer
summary or a schema that now states a limit the server already enforced.

The route prefix carries no version (`/api/admin`, not `/api/v1/admin`). If a
version 2 is ever needed, it will be served beside version 1 under a new
prefix for at least the deprecation period. Existing paths will not be
repurposed.

## Deprecation

Before anything is removed or changed incompatibly, it is deprecated with
**at least six months' notice**:

1. The operation is marked `deprecated: true` in the description, with an
   `x-syntra-deprecation` object giving `since`, `sunset` (the earliest date
   it may be removed) and, where there is one, `replacement`. The same dates
   head the operation's description in plain English.
2. **Every response from the route carries the standard headers**, so a
   client that never rereads the document still hears about it:
   - `Deprecation: @<unix time>` (RFC 9745);
   - `Sunset: <HTTP-date>` (RFC 8594);
   - `Link: <replacement>; rel="successor-version"` when there is a
     replacement.
3. The release notes of the release that deprecates it say so.

The six months is enforced rather than hoped for: a deprecation whose sunset
is less than six months after its start fails the test suite
(`apps/api/src/openapi/openapi.test.ts`).

Nothing is deprecated today.

A reasonable client-side practice is to log, or alert on, any response that
carries a `Deprecation` header.

## Errors

Every error is an RFC 9457 **problem**, served as `application/problem+json`:

```json
{
  "type": "https://syntra.dev/problems/forbidden",
  "title": "Forbidden",
  "status": 403,
  "detail": "Requires directory.write"
}
```

- **Branch on `type`**, which is stable. `title` and `detail` are prose for
  people and may be reworded in any release.
- **Some problems carry extension members**: data a client can act on,
  alongside the standard four fields. A schema failure is always
  `validation-failed`, with an `errors` array of `{ path, message }`, where
  `path` is the dotted path to the field.
- **Request bodies and query strings are strict.** An unknown field or
  parameter is a `400`, not something the server silently ignores.
  `?confirm=false` is not a confirmation. Where a route asks for one, only the
  exact value `true` counts.

The types every operation can return:

| Status | `type` | When |
| --- | --- | --- |
| 400 | `validation-failed` | The body, query or path failed its schema. |
| 400 | `bad-request` | The request was malformed before validation (for example, invalid JSON). |
| 401 | `unauthenticated` | No valid session or token. |
| 403 | `forbidden` | The account lacks the permission, or the token's scopes do not include it. |
| 403 | `token-not-accepted` | The route refuses tokens whatever they hold (`x-syntra-token-allowed: false`). |
| 404 | `not-found` | No such resource **in this tenant**. Another tenant's identifier is indistinguishable from one that never existed. |
| 503 | `unavailable` | The database did not answer within the transaction budget. The transaction was rolled back, so the request is safe to retry after a short delay. |
| 500 | `internal-error` | A bug. The response deliberately carries no detail, and the server log has it. |

Operations add their own domain types, mostly `409`s: `stale-preview` or
`preview-stale` when a preview's revision has moved on, `approval-required`,
`four-eyes-required`, `run-not-appliable`, `write-stop-state`, and others.
Operation descriptions name the ones a client is likely to meet.

## Idempotency

There is **no general `Idempotency-Key` header**. Retrying safely depends on
the operation.

- **`GET`** never changes anything.
- **`PUT`** replaces a resource with the representation sent. Repeating it
  gives the same result.
- **`DELETE`** of something already deleted answers `404`. Treat that as
  success when retrying.
- **`POST`** is not idempotent in general. Where a duplicate would be harmful,
  the operation takes a key of its own:
  - **`POST /api/admin/lifecycle-operations/onboard`** takes a body
    `idempotencyKey` (1–200 characters), unique per tenant.
    - The first call answers `201`.
    - A repeat with the same key and the same input answers `200` with what
      the first call created, and creates nothing.
    - The same key with **different** input is refused with
      `409 idempotency-key-reused`, and nothing is written.
    - A key is held until lifecycle retention removes its operation. The
      retention period is a tenant setting.
  - **`POST /api/admin/persons/{id}/provision-receipts`** takes a body
    `requestKey` (a UUID), unique per person and target. A repeat returns the
    existing receipts without queuing the work again. It answers `202` either
    way.
  - **Bulk retry** (`POST /api/admin/lifecycle-operations/bulk`,
    `action: "retry"`) needs approval when policy requires it. The approval
    operation it creates is keyed on the caller, the set of operations and the
    UTC minute, so an immediate duplicate returns the same pending approval.
- **Preview-then-apply operations** are guarded by a **revision** rather than a
  key. These include the mover flow, offboarding, and provisioning and sync
  runs. Applying a preview whose data has since changed is refused with a
  `409` naming the stale preview, rather than applying something nobody
  reviewed. Take a new preview and apply that.

## Rate limits

The limits that exist today:

- **Two operations have per-route limits**, because they are expensive or
  reveal a great deal:
  - `POST /api/admin/policy/rules/impact`;
  - `POST /api/admin/targets/test`.

  Each allows `AUTH_RATE_LIMIT_MAX` requests a minute (10 by default,
  configurable per deployment), counted per tenant and client address. The
  committed document shows the default. Each operation's
  `x-syntra-rate-limit` gives the value.
- **`GET /api/openapi.json`** is limited to 60 requests a minute per address.
- **Every other administration operation has no per-route limit.** An
  integration should still pace itself: the database's transaction budget is
  the real ceiling, and exceeding it produces `503 unavailable`.

A request over a limit is answered `429`, with a `Retry-After` header giving
the seconds to wait and `x-ratelimit-limit`, `x-ratelimit-remaining` and
`x-ratelimit-reset` headers describing the bucket. Its problem `type` is the
generic `bad-request`, so **branch on the status `429`**, not on the type.

Counters are **per API process**. A deployment running several replicas allows
the limit per replica. See the multi-replica notes in
[operate.md](../operate.md).

## Pagination

Lists that can grow without bound are paged. The operation is marked
`x-syntra-paginated`.

- **Request:** `page` (1-based, default 1) and `pageSize` (default 50,
  maximum 200). A `pageSize` over the maximum is refused, not clamped: a
  caller who asked for a thousand rows and quietly received two hundred would
  have a bug they could not see. Many lists also take `q`, a search term
  (empty means no search), and some take `status`.
- **Response:**

  ```json
  { "rows": [ … ], "total": 1234, "page": 2, "pageSize": 50 }
  ```

  `total` counts the rows that match the filters, not the rows in the table.
  Stop when `page * pageSize >= total`.

## Generating a client

Point any OpenAPI 3.1 generator at the committed file or at a deployment's
`/api/openapi.json`. Pin the file you generate from, so the version your
client was built against is recorded. Two examples:

**TypeScript types**, with
[openapi-typescript](https://openapi-ts.dev) and its `openapi-fetch` client:

```sh
npx openapi-typescript https://syntra.example.com/api/openapi.json -o syntra-api.d.ts
```

```ts
import createClient from 'openapi-fetch';
import type { paths } from './syntra-api';

const syntra = createClient<paths>({
  baseUrl: 'https://syntra.example.com',
  headers: { Authorization: `Bearer ${process.env.SYNTRA_TOKEN}` },
});

const { data, error } = await syntra.GET('/api/admin/users', {
  params: { query: { page: 1, pageSize: 100 } },
});
if (error) throw new Error(`${error.status} ${error.type}`); // a problem
```

**Other languages**, with [OpenAPI Generator](https://openapi-generator.tech):

```sh
npx @openapitools/openapi-generator-cli generate \
  -i docs/api/openapi.json -g python -o ./syntra-client
```

Or with no generator at all:

```sh
curl -fsS https://syntra.example.com/api/admin/users?pageSize=100 \
  -H "Authorization: Bearer $SYNTRA_TOKEN"
```

**Response bodies.** Request bodies, query strings and path parameters are
fully described. Most response bodies are not yet: they are published as "a
JSON object", apart from the paging envelope and the operations whose response
already has a contracts schema (webhooks and some applications, policy and
target responses). Describing responses is the next step of this work.
Adding a response schema is an additive, minor-version change.

## Maintaining the description

The document is generated from two inputs.

- **The route table the API registers.** This supplies the method, the path,
  the permissions its guards check, whether a token may call it, and its rate
  limit. None of these is written down by hand, so none can drift.
- **A description beside each route module**, in
  `apps/api/src/routes/admin/<module>.openapi.ts`. This supplies a summary
  and the contracts Zod schemas the handler already parses with.

To add or change a route:

1. Describe it in the module's `.openapi.ts`. Give it a one-line summary, the
   `body`, `query` or `params` schema the handler parses, and the success
   `status` when that is not 200.
2. Run `pnpm openapi:generate` and commit `docs/api/openapi.json` with the
   change. The diff is the contract change a reviewer should read.

Two checks enforce this:

- `apps/api/src/openapi/openapi.test.ts` fails when an `/api/admin` route has
  no description, or a description names a route that no longer exists. Its
  commented allow-list is the only way to leave a route out on purpose, and
  it is empty.
- The CI `openapi document` job regenerates the file and fails if the
  committed copy differs. `pnpm openapi:check` asks the same question
  locally.
