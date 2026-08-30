# Inbound SCIM Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A SCIM 2.0 target an IdP can provision into — Users and Groups, discovery, a bounded filter subset — where everything pushed is owned by the source that pushed it and `DELETE` deactivates.

**Architecture:** A `DirectorySource` of `type: 'scim'` provides ownership through the existing `sourceId` field, so every ownership rule in the product applies unchanged. A Fastify plugin at `/scim/v2` authenticates with a C1 machine token, serialises errors in SCIM's shape rather than RFC 9457, and maps SCIM resources onto `User` and `Group` through pure functions that can be tested without HTTP.

**Tech Stack:** TypeScript (ESM, NodeNext), Fastify 5, Prisma 6 / PostgreSQL with RLS, Zod, Vitest against a real database.

**Spec:** `docs/superpowers/specs/2026-08-30-inbound-scim-design.md`

## Global Constraints

- **`pnpm typecheck` must stay clean.** `exactOptionalPropertyTypes` is on.
- **Tests run against a real PostgreSQL.** Never run concurrent suites; never `docker compose down`.
- **Errors under `/scim/v2` are SCIM errors**, `urn:ietf:params:scim:api:messages:2.0:Error`, never problem+json. The exception is bounded to this plugin.
- **`DELETE` deactivates.** There is no Delete in this directory, and SCIM does not get one.
- **A SCIM write never sets a password.** The attribute is accepted and ignored.
- **A SCIM write never takes over another source's account.** Uniqueness is a 409.
- Imports are extensionful ESM.

## File Structure

- Modify `packages/core/src/sync/source-service.ts` — `createScimSource`
- Create `packages/core/src/scim/resource.ts` + test — the pure mapping, both directions
- Create `packages/core/src/scim/filter.ts` + test — the bounded filter parser
- Create `packages/core/src/scim/patch.ts` + test — the PATCH operation subset
- Create `apps/api/src/routes/scim/index.ts` — the plugin, auth, error shape
- Create `apps/api/src/routes/scim/discovery.ts` — ServiceProviderConfig, ResourceTypes, Schemas
- Create `apps/api/src/routes/scim/users.ts` + test
- Create `apps/api/src/routes/scim/groups.ts` + test
- Modify `apps/api/src/app.ts`, `packages/core/src/notify/webhook-event.ts`
- Modify `docs/configure.md`, `README.md`

The mapping, the filter and the PATCH interpreter are in **core and pure**, so the hard parts are tested without a server and the route files stay about HTTP.

---

### Task 1: A source of type 'scim'

**Files:**
- Modify: `packages/core/src/sync/source-service.ts`
- Modify: `packages/core/src/sync/source-service.test.ts`

**Interfaces:**
- Produces: `createScimSource(tx, input: { name: string }): Promise<DirectorySource>`

- [ ] **Step 1: Write the failing test**

```ts
it('creates a source that owns what SCIM pushes', async () => {
  const source = await withTenant(tenantId, (tx) => createScimSource(tx, { name: 'Entra' }));
  expect(source.type).toBe('scim');
});

it('has no schedule, because nothing polls a push', async () => {
  const source = await withTenant(tenantId, (tx) => createScimSource(tx, { name: 'Entra' }));
  expect(source.schedule).toBeNull();
});

it('stores no credential, because the client authenticates to us', async () => {
  // A DirectorySource carries secretName for an outbound bind. There is no
  // outbound bind here, and a secret name pointing at a vault entry that does
  // not exist would be a rotation somebody eventually tries to perform.
  const source = await withTenant(tenantId, (tx) => createScimSource(tx, { name: 'Entra' }));
  expect(source.secretName).toBe('');
});

it('cannot write back, whatever a later upgrade adds', async () => {
  // The three write-back flags default false and must stay false: SCIM is an
  // inbound push, and Syntra has nowhere to write back to.
  const source = await withTenant(tenantId, (tx) => createScimSource(tx, { name: 'Entra' }));
  expect(source.writeBackEnabled).toBe(false);
});
```

Read the real write-back field names off the model before writing that last case.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/core/src/sync/source-service.test.ts -t "SCIM"`
Expected: FAIL — `createScimSource` is not a function.

- [ ] **Step 3: Implement**

Beside `createSource`, which hardcodes `type: 'ldap'` and parses an LDAP config. `createScimSource` writes `type: 'scim'`, an empty `config`, an empty `secretName`, a null `schedule` and `autoApply: false`.

A docstring saying what the spec says: a `DirectorySource` carries several fields a SCIM source has no use for, they are inert here, and that wart is smaller than a second ownership model.

- [ ] **Step 4: Run, typecheck, commit**

```bash
pnpm vitest run packages/core/src/sync/source-service.test.ts && pnpm typecheck
git add packages/core/src/sync/source-service.ts packages/core/src/sync/source-service.test.ts
git commit -m "feat(core): a directory source that is pushed to, not polled"
```

---

### Task 2: The mapping, both directions

**Files:**
- Create: `packages/core/src/scim/resource.ts` + `.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces:

```ts
export const SCIM_USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const SCIM_GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
export interface ScimUserInput {
  userName: string; externalId: string | null; email: string | null;
  displayName: string; active: boolean;
  givenName: string | null; familyName: string | null;
}
export function parseScimUser(body: unknown): ScimUserInput;   // throws ScimError
export function toScimUser(user: {...}, baseUrl: string): Record<string, unknown>;
export function toScimGroup(group: {...}, members: {...}[], baseUrl: string): Record<string, unknown>;
export function toScimList(resources: unknown[], total: number, startIndex: number): Record<string, unknown>;
```

- [ ] **Step 1: Write the failing test**

```ts
describe('parseScimUser', () => {
  it('takes the primary email when several are given', () => {
    expect(parseScimUser({ userName: 'a', emails: [
      { value: 'alt@x.test' }, { value: 'main@x.test', primary: true },
    ]}).email).toBe('main@x.test');
  });

  it('falls back to the first email when none is primary', () => {
    // Okta omits `primary` on a single address.
  });

  it('builds a display name from the name object when displayName is absent', () => {
    expect(parseScimUser({ userName: 'a', name: { givenName: 'Ada', familyName: 'Lovelace' } })
      .displayName).toBe('Ada Lovelace');
  });

  it('defaults active to true, because a POST without it means create an active user', () => {});

  it('IGNORES a password, silently and completely', () => {
    // Syntra's password rules live in authorize() and the password services. A
    // provisioning protocol is not the place to route around them.
    const parsed = parseScimUser({ userName: 'a', password: 'hunter2' });
    expect(JSON.stringify(parsed)).not.toContain('hunter2');
  });

  it('refuses a body with no userName', () => {
    expect(() => parseScimUser({})).toThrow(/userName/);
  });
});

describe('toScimUser', () => {
  it('carries the schemas urn, the id and a meta location', () => {});
  it('never carries a password field', () => {});
  it('reports an inactive account as active:false', () => {});
});

describe('toScimList', () => {
  it('is 1-based, as the RFC says and everybody gets wrong once', () => {
    expect(toScimList([], 0, 1).startIndex).toBe(1);
  });
  it('reports totalResults independently of the page returned', () => {});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/core/src/scim/resource.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Pure functions, no database. `parseScimUser` throws a `ScimError` carrying a status and a `scimType`, which the plugin turns into a body.

**The password is dropped in the parser**, not at the route, so no route can forget it. Comment it.

- [ ] **Step 4: Run, export, commit**

```bash
pnpm vitest run packages/core/src/scim/resource.test.ts && pnpm typecheck
git add packages/core/src/scim packages/core/src/index.ts
git commit -m "feat(core): SCIM resources, in and out, without a server"
```

---

### Task 3: The filter subset

**Files:**
- Create: `packages/core/src/scim/filter.ts` + `.test.ts`

**Interfaces:**
- Produces: `parseScimFilter(filter: string | undefined, allowed: string[]): { attribute: string; value: string } | null`

- [ ] **Step 1: Write the failing test**

```ts
it('parses the two filters an IdP actually sends', () => {
  expect(parseScimFilter('userName eq "ada"', ['userName'])).toEqual({
    attribute: 'userName', value: 'ada',
  });
  expect(parseScimFilter('externalId eq "abc-123"', ['externalId'])).toEqual({
    attribute: 'externalId', value: 'abc-123',
  });
});

it('is case-insensitive about the operator, as the RFC requires', () => {
  expect(parseScimFilter('userName EQ "ada"', ['userName'])).not.toBeNull();
});

it('returns null for no filter at all', () => {
  expect(parseScimFilter(undefined, ['userName'])).toBeNull();
});

it('refuses an attribute that is not on the list', () => {
  expect(() => parseScimFilter('title eq "x"', ['userName'])).toThrow();
});

it('refuses an operator it does not implement, rather than guessing', () => {
  // A filter this server pretends to understand and applies wrongly returns
  // the wrong users, which is worse than a 400 an integrator can read.
  expect(() => parseScimFilter('userName co "ad"', ['userName'])).toThrow();
  expect(() => parseScimFilter('userName eq "a" and active eq true', ['userName'])).toThrow();
});

it('does not let a value escape the quotes', () => {
  // The value goes into a Prisma `where` as data, never into SQL, but a parser
  // that mis-slices a quoted string is a parser that returns the wrong rows.
  expect(parseScimFilter('userName eq "a\\"b"', ['userName'])?.value).toBe('a"b');
});
```

- [ ] **Step 2: Run to verify it fails**

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

One regular expression for `<attr> eq "<value>"`, case-insensitive on the operator, with escaped quotes handled. Anything else throws a `ScimError` with `scimType: 'invalidFilter'` naming what **is** supported.

A docstring saying why the grammar stops here: this is what Entra and Okta send to correlate, and the rest of the grammar is a parser with its own surface written for no client this will meet.

- [ ] **Step 4: Run and commit**

```bash
pnpm vitest run packages/core/src/scim/filter.test.ts
git add packages/core/src/scim/filter.ts packages/core/src/scim/filter.test.ts
git commit -m "feat(core): the two SCIM filters an IdP actually sends"
```

---

### Task 4: The plugin, its authentication and its error shape

**Files:**
- Create: `apps/api/src/routes/scim/index.ts`, `discovery.ts`
- Create: `apps/api/src/routes/scim/scim.test.ts`
- Modify: `apps/api/src/app.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('refuses an unauthenticated request in SCIM\'s error shape', async () => {
  const res = await get('/scim/v2/Users');
  expect(res.statusCode).toBe(401);
  expect(res.json().schemas).toContain('urn:ietf:params:scim:api:messages:2.0:Error');
  // NOT problem+json: a client that cannot parse the error cannot tell a
  // conflict from a crash.
  expect(res.json()).not.toHaveProperty('type');
});

it('refuses a cookie session', async () => {
  // A browser has no business here, and every SCIM client sends a bearer token.
});

it('accepts a machine token', async () => {});

it('serves ServiceProviderConfig, which Entra reads before it will provision', async () => {
  const res = await get('/scim/v2/ServiceProviderConfig', bearer(token));
  expect(res.statusCode).toBe(200);
  expect(res.json().patch.supported).toBe(true);
  expect(res.json().bulk.supported).toBe(false);
  expect(res.json().filter.supported).toBe(true);
  expect(res.json().filter.maxResults).toEqual(expect.any(Number));
});

it('says plainly that DELETE deactivates', async () => {
  // The one place a client can learn this before it matters.
  const res = await get('/scim/v2/ServiceProviderConfig', bearer(token));
  expect(JSON.stringify(res.json())).toMatch(/deactivat/i);
});

it('serves ResourceTypes and Schemas', async () => {});
```

- [ ] **Step 2: Run to verify it fails**

Expected: FAIL — 404 everywhere.

- [ ] **Step 3: Implement**

The plugin sets `setErrorHandler` to SCIM's shape, `{ schemas: [...Error], status: "409", scimType: "uniqueness", detail: "…" }` with `status` as a **string**, which the RFC requires and clients check.

A `preHandler` that requires a bearer principal — reusing `resolveBearerPrincipal` from C1 — and refuses a cookie session. Then `requirePermission` per route, so the C1 intersection applies and a read-only token can GET.

`ServiceProviderConfig` reports: patch supported, bulk not, filter supported with `maxResults`, changePassword **not** supported, sort not, etag not. The `documentationUri` points at the configure page, and a `deactivat` word appears in it so the DELETE behaviour is discoverable.

- [ ] **Step 4: Run, typecheck, commit**

```bash
pnpm vitest run apps/api/src/routes/scim && pnpm typecheck
git add apps/api/src/routes/scim apps/api/src/app.ts
git commit -m "feat(api): a SCIM endpoint that speaks SCIM, including its errors"
```

---

### Task 5: `/Users` — read, create, replace

**Files:**
- Create: `apps/api/src/routes/scim/users.ts`
- Modify: `apps/api/src/routes/scim/scim.test.ts`

- [ ] **Step 1: Write the failing test**

The setup round trip first, because it is what a client actually does:

```ts
it('completes the round trip an IdP performs at setup', async () => {
  await get('/scim/v2/ServiceProviderConfig', bearer(token));
  const empty = await get('/scim/v2/Users?filter=userName eq "ada"', bearer(token));
  expect(empty.json().totalResults).toBe(0);

  const created = await post('/scim/v2/Users', bearer(token), {
    schemas: [SCIM_USER_SCHEMA], userName: 'ada', externalId: 'e-1',
    name: { givenName: 'Ada', familyName: 'Lovelace' },
    emails: [{ value: 'ada@acme.test', primary: true }],
  });
  expect(created.statusCode).toBe(201);
  expect(created.headers.location).toContain(created.json().id);

  const read = await get(`/scim/v2/Users/${created.json().id}`, bearer(token));
  expect(read.json().userName).toBe('ada');
});

it('answers 409 uniqueness for a second POST of one userName', async () => {
  // Not a 500, and not a second account.
});

it('refuses to take over an account another source owns', async () => {
  // The account belongs to the system that anchored it.
  const ldap = await seedLdapOwnedUser('ada');
  const res = await post('/scim/v2/Users', bearer(token), { userName: 'ada' });
  expect(res.statusCode).toBe(409);
  const after = await readUser(ldap.id);
  expect(after.sourceId).toBe(ldap.sourceId);
});

it('owns what it creates, so a hand edit is refused', async () => {
  // The existing rule, asserted for the new writer.
  const created = await post('/scim/v2/Users', bearer(token), { userName: 'ada' });
  const res = await patchAdmin(`/api/admin/users/${created.json().id}`, adminCookie, {
    displayName: 'Changed',
  });
  expect(res.statusCode).toBe(409);
  expect(res.json().type).toContain('source-owned');
});

it('ignores a password and leaves the account without one', async () => {});

it('creates a Person only when the names are there', async () => {
  // An IdP that knows a login and an address should not fill the register with
  // half-records no HR feed will reconcile against.
});

it('filters by externalId, which is how an IdP correlates', async () => {});
it('refuses an unsupported filter with 400 invalidFilter, naming what works', async () => {});

it('paginates from 1, and refuses startIndex=0', async () => {
  // The RFC is 1-based and everybody gets it wrong once. Silently treating 0
  // as 1 hides the client's bug until a page is skipped.
});

it('does not return another tenant\'s users', async () => {});
```

- [ ] **Step 2: Run to verify it fails**

Expected: FAIL — 404.

- [ ] **Step 3: Implement**

`GET /Users` with the filter, `startIndex`, `count` capped. `GET /Users/{id}` 404s in SCIM's shape. `POST` maps, checks uniqueness against **any** source, creates the user with `sourceId` set to the SCIM source and `sourceAnchor` from `externalId`, and creates a linked Person only when both names are present. `PUT` replaces.

Resolving **which** SCIM source: the token's service account is the identity, and the source is looked up by the tenant's single `type: 'scim'` source for now. If there are several, refuse with a message saying so rather than guessing — a guess here writes ownership somebody has to unpick.

- [ ] **Step 4: Run, typecheck, commit**

```bash
pnpm vitest run apps/api/src/routes/scim && pnpm typecheck
git add apps/api/src/routes/scim
git commit -m "feat(api): SCIM Users, owned by the source that pushed them"
```

---

### Task 6: `DELETE` and `PATCH`

**Files:**
- Create: `packages/core/src/scim/patch.ts` + `.test.ts`
- Modify: `apps/api/src/routes/scim/users.ts`, `scim.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// patch.ts, pure:
it('reads a replace of active', () => {
  expect(interpretPatch({ Operations: [{ op: 'replace', path: 'active', value: false }] }))
    .toEqual([{ kind: 'setActive', value: false }]);
});
it('reads Entra\'s shape, which omits the path and sends an object value', () => {
  // { op: 'replace', value: { active: false } } -- this is what actually
  // arrives, and a server that only handles the pathed form fails silently.
});
it('reads add and remove of members', () => {});
it('refuses an op it does not implement rather than reporting success', () => {
  // A PATCH that answers 200 and changes nothing is the failure that takes
  // days to find, because the IdP believes the change landed.
  expect(() => interpretPatch({ Operations: [{ op: 'replace', path: 'title', value: 'x' }] }))
    .toThrow();
});

// over HTTP:
it('DELETE deactivates and does not delete', async () => {
  const created = await post('/scim/v2/Users', bearer(token), { userName: 'ada' });
  expect((await del(`/scim/v2/Users/${created.json().id}`, bearer(token))).statusCode).toBe(204);

  const row = await readUser(created.json().id);
  expect(row).not.toBeNull();          // THE assertion
  expect(row!.status).toBe('inactive');
});

it('PATCH replace active:false deactivates, because that is what Entra sends', async () => {});
it('PATCH reactivates', async () => {});
```

- [ ] **Step 2: Run to verify they fail**

- [ ] **Step 3: Implement**

`interpretPatch` returns a list of typed operations. **Both shapes**: `{op, path:'active', value:false}` and `{op, value:{active:false}}`. Unknown paths throw.

`DELETE` calls the existing deactivation path so leaver steps and session revocation happen exactly as they do for an administrator's deactivation — cluster A's `endSessions` funnel included, which means a SCIM offboarding now also tells the relying parties.

- [ ] **Step 4: Run, typecheck, commit**

```bash
pnpm vitest run packages/core/src/scim apps/api/src/routes/scim && pnpm typecheck
git add packages/core/src/scim apps/api/src/routes/scim
git commit -m "feat(api): SCIM DELETE deactivates, and PATCH speaks Entra's dialect"
```

---

### Task 7: `/Groups`

**Files:**
- Create: `apps/api/src/routes/scim/groups.ts`
- Modify: `apps/api/src/routes/scim/scim.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('creates a group with members', async () => {});
it('adds and removes members by PATCH', async () => {});
it('filters by displayName', async () => {});
it('refuses a member id that is not a user in this tenant', async () => {});
it('DELETE deactivates the group, and its members keep their record', async () => {
  // Deactivating a group revokes access and grants nothing; the membership
  // record is what makes reactivation put back exactly what was there.
});
it('owns what it creates, so the group refuses a hand edit', async () => {});
```

- [ ] **Step 2: Run, implement, run**

`Group` has `sourceId` and `sourceAnchor` exactly as `User` does, so ownership works the same way. Membership goes through the existing `addMember`/`removeMember`.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/routes/scim
git commit -m "feat(api): SCIM Groups, and membership an IdP can push"
```

---

### Task 8: Audit and the webhook group

**Files:**
- Modify: `apps/api/src/routes/scim/*.ts`, `packages/core/src/notify/webhook-event.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('records who did it as the service account the token acts as', async () => {});
it('audits a create, an update and a deactivation', async () => {});
it('carries no password and no token in any payload', async () => {});
```

- [ ] **Step 2: Implement**

Seven actions as the spec lists, into the **Configuration changes** group — an IdP that starts creating accounts is a configuration change somebody should be able to watch. Run the group test that asserts no action is in two groups.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/routes/scim packages/core/src/notify/webhook-event.ts
git commit -m "feat(api): a SCIM write is an auditable act"
```

---

### Task 9: Documentation

**Files:**
- Modify: `docs/configure.md`, `README.md`

- [ ] **Step 1: Setting up a SCIM source**

Creating the source, issuing a token with `directory.write`, the base URL, and what to expect: **DELETE deactivates**, passwords are ignored, a SCIM-owned account is not editable by hand, which filters are supported, and that a read-only token is a good way to test the connection before trusting it to write.

- [ ] **Step 2: README**

The module table gains inbound SCIM; the Directory Sync row says it is a **push** alternative to the pull connectors rather than a replacement.

- [ ] **Step 3: Verify every claim against the code**

Every route, filter, behaviour and field name. This is the step that caught a documented-but-unbuilt metric in cluster B.

- [ ] **Step 4: Full suite and commit**

```bash
pnpm vitest run && pnpm typecheck && pnpm --filter @syntra/web test
git add docs README.md
git commit -m "docs: point an identity provider at Syntra"
```

---

## Self-Review

**Spec coverage.** The source ruling → Task 1. Mapping and the Person rule → Tasks 2, 5. Filtering → Task 3. Auth, error shape and discovery → Task 4. Users → Task 5. The DELETE ruling and PATCH → Task 6. Groups → Task 7. Audit and the webhook group → Task 8. Documentation → Task 9. The spec's non-goals — `/Me`, bulk, ETags, outbound SCIM — have no tasks, correctly.

**Type consistency.** `createScimSource`, `parseScimUser`, `toScimUser`, `toScimGroup`, `toScimList`, `parseScimFilter`, `interpretPatch`, `ScimError` are each declared once and used with those names throughout.

**Known soft spots.** Three the repository decides: the real write-back field names on `DirectorySource` (Task 1); whether `resolveBearerPrincipal` can be reused as a plugin `preHandler` without the deny-list applying, since `/scim/v2` is not in it (Task 4); and how the existing deactivation path is invoked so a SCIM offboarding reaches cluster A's `endSessions` funnel rather than setting a status column directly (Task 6).
