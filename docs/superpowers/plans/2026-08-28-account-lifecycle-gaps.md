# Account Lifecycle Gaps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close five gaps around the account: duplicates can be created four ways, a contract cannot be corrected, accounts created from the Accounts tab orphan themselves, the org unit picked there is half a decision, and there is no way for an administrator to set somebody's password.

**Architecture:** Two migrations carry the enforcement that belongs in the database — two functional unique indexes on `User`, and a `mustChange` flag on `PasswordCredential`. Everything else is a new function beside an existing one: a person matcher in `identity/`, an admin set-password beside `changeOwnPassword`, a contract patch beside the contract create. The console gains one shared primitive, `RecordPanel`'s `confirmable` prop, which both confirmable 409s use.

**Tech Stack:** TypeScript (ESM, `exactOptionalPropertyTypes` on), Prisma + PostgreSQL 16 with `FORCE ROW LEVEL SECURITY`, Fastify, React 19, Zod, Vitest, Testing Library. pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-08-28-account-lifecycle-gaps-design.md`

## Global Constraints

- **Tenant isolation is enforced by PostgreSQL.** Every new query goes through a `TenantClient` obtained from `withTenant`. Never `prisma.*` directly outside test setup.
- **Run the test suites one at a time.** Concurrent runs against the shared database produce phantom failures. There is no linter in this repo; `pnpm typecheck` is the static gate.
- **`exactOptionalPropertyTypes` is on repo-wide.** An optional interface field a caller may pass as `undefined` must be typed `| undefined` explicitly.
- **A password never reaches an audit payload, a log line, or an error message.** Neither does a hash.
- **Argon2id never runs inside a Prisma interactive transaction.** It exceeds the 5000 ms budget. Hash outside, pass the hash in — the shape `setPasswordHash` already forces.
- **Deactivation, never deletion.** Nothing in this plan adds a delete.
- **Refusal vocabulary.** Hard refusals are `ProblemError` 409 with no override. Confirmable refusals are 409 whose `type` slug is `second-account` or `possible-duplicate`, carrying the candidates as RFC 9457 extension members, and are passed by a named boolean in the request body.
- **Commit after every task,** with the message given in the task's final step.

---

### Task 1: Migration and `createUser` — case-insensitive login, local-unique email

**Files:**
- Create: `packages/db/prisma/migrations/20260922000000_user_duplicate_guards/migration.sql`
- Modify: `packages/core/src/directory/user-service.ts`
- Test: `packages/core/src/directory/user-service.test.ts` (append to the existing `describe('createUser')`)

**Interfaces:**
- Consumes: nothing.
- Produces: `createUser` throws `Error` whose message matches `/login already exists/i` or `/email already in use/i`. Task 2 maps both to 409.

- [ ] **Step 1: Write the failing tests**

Append inside `describe('createUser', ...)` in `packages/core/src/directory/user-service.test.ts`:

```ts
it('rejects a login that differs only in case', async () => {
  await withTenant(tenantId, (tx) =>
    createUser(tx, { login: 'jdoe', email: 'a@acme.test', displayName: 'A' }),
  );
  await expect(
    withTenant(tenantId, (tx) =>
      createUser(tx, { login: 'JDoe', email: 'b@acme.test', displayName: 'B' }),
    ),
  ).rejects.toThrow(/login already exists/i);
});

it('rejects an email already used by a locally managed account', async () => {
  await withTenant(tenantId, (tx) =>
    createUser(tx, { login: 'a', email: 'shared@acme.test', displayName: 'A' }),
  );
  await expect(
    withTenant(tenantId, (tx) =>
      createUser(tx, { login: 'b', email: 'SHARED@acme.test', displayName: 'B' }),
    ),
  ).rejects.toThrow(/email already in use/i);
});

it('allows a source-owned account to share an email with a local one', async () => {
  const source = await withTenant(tenantId, (tx) =>
    tx.directorySource.create({
      data: { tenantId, name: 'Corporate LDAP', kind: 'ldap', config: {} },
    }),
  );
  await withTenant(tenantId, (tx) =>
    createUser(tx, { login: 'local', email: 'shared@acme.test', displayName: 'L' }),
  );
  // Written directly rather than through createUser: a synced account is
  // created by the sync apply path, which is exempt from this guard by design.
  const synced = await withTenant(tenantId, (tx) =>
    tx.user.create({
      data: {
        tenantId,
        login: 'synced',
        email: 'shared@acme.test',
        displayName: 'S',
        sourceId: source.id,
        sourceAnchor: 'anchor-1',
      },
    }),
  );
  expect(synced.email).toBe('shared@acme.test');
});
```

If `DirectorySource` requires fields beyond `name`/`kind`/`config`, read `packages/db/prisma/schema.prisma` and supply them; the point of the row is only that `sourceId` is non-null.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/core/src/directory/user-service.test.ts`
Expected: the two rejection tests FAIL because `createUser` resolves instead of throwing.

- [ ] **Step 3: Write the migration**

Create `packages/db/prisma/migrations/20260922000000_user_duplicate_guards/migration.sql`:

```sql
-- Two accounts differing only in case are two accounts, and both can sign in.
--
-- `@@unique([tenantId, login])` is case-sensitive in Postgres, so `MOkafor`
-- and `mokafor` coexist today. `createUser` keeps its own pre-check so the
-- caller gets a domain error to map to 409 rather than a driver error; this
-- index is the backstop for the race a pre-check cannot close.
--
-- This migration FAILS on a tenant that already holds a case-collision, and
-- that is correct: deciding which of two accounts is real needs a human. Find
-- them with:
--
--   SELECT "tenantId", lower("login"), count(*), array_agg("id")
--     FROM "User" GROUP BY 1, 2 HAVING count(*) > 1;
CREATE UNIQUE INDEX "User_tenantId_lower_login_key"
  ON "User" ("tenantId", lower("login"));

-- Email, for locally managed accounts only.
--
-- Partial, and that is the whole of the design. A directory is authoritative
-- over the accounts it owns: refusing what LDAP says would fail a sync run
-- mid-apply over a shared mailbox somebody set up years ago. The index covers
-- exactly what Syntra itself created, which is what an administrator typing
-- into the create form can collide with.
--
--   SELECT "tenantId", lower("email"), count(*), array_agg("id")
--     FROM "User" WHERE "sourceId" IS NULL
--     GROUP BY 1, 2 HAVING count(*) > 1;
CREATE UNIQUE INDEX "User_tenantId_lower_email_local_key"
  ON "User" ("tenantId", lower("email")) WHERE "sourceId" IS NULL;
```

No `schema.prisma` change: Prisma has no syntax for a functional or partial index, so these live in SQL only. Add a comment above `@@unique([tenantId, login])` in `packages/db/prisma/schema.prisma` saying so, so the next reader does not conclude the case rule is unenforced:

```prisma
  /// Case-SENSITIVE. The case-insensitive rule, and the local-only email rule,
  /// are functional indexes in migration 20260922000000_user_duplicate_guards
  /// — Prisma has no syntax for either. `createUser` pre-checks both.
  @@unique([tenantId, login])
```

- [ ] **Step 4: Apply the migration**

Run: `pnpm db:migrate`
Expected: the migration applies. If it fails on a duplicate, run the detection queries in the comments — that is the migration doing its job.

- [ ] **Step 5: Implement the checks in `createUser`**

Replace the existing pre-check block in `packages/core/src/directory/user-service.ts`:

```ts
export async function createUser(tx: TenantClient, input: CreateUserInput) {
  // Checked explicitly rather than relying on the unique constraints, so the
  // caller gets a domain error it can map to 409 instead of a driver error.
  // Both are case-insensitive because both indexes are: a login that differs
  // only in case is the same login to everyone except Postgres.
  const existing = await tx.user.findFirst({
    where: { login: { equals: input.login, mode: 'insensitive' } },
  });
  if (existing) {
    throw new Error(`login already exists: ${input.login}`);
  }

  // Locally managed accounts only, matching the partial index. A directory
  // owns the addresses on the accounts it syncs, and Syntra refusing one of
  // them would fail a sync run over a shared mailbox rather than stop a typo.
  const sharing = await tx.user.findFirst({
    where: {
      email: { equals: input.email, mode: 'insensitive' },
      sourceId: null,
    },
  });
  if (sharing) {
    throw new Error(`email already in use: ${input.email}`);
  }

  const tenantId = await currentTenant(tx);
  return tx.user.create({
    data: {
      tenantId,
      login: input.login,
      email: input.email,
      displayName: input.displayName,
      orgUnitId: input.orgUnitId ?? null,
    },
  });
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm vitest run packages/core/src/directory/user-service.test.ts`
Expected: PASS, including the pre-existing tests.

- [ ] **Step 7: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/db/prisma/migrations/20260922000000_user_duplicate_guards packages/db/prisma/schema.prisma packages/core/src/directory/user-service.ts packages/core/src/directory/user-service.test.ts
git commit -m "feat(directory): refuse a duplicate login by case, and a duplicate local email"
```

---

### Task 2: The API refuses both duplicates with a 409

**Files:**
- Modify: `apps/api/src/routes/admin/users.ts:177-209` (the `POST /users` catch), and the `PATCH /users/:id/details` handler at `:536`
- Test: `apps/api/src/routes/admin/users.test.ts`

**Interfaces:**
- Consumes: `createUser`'s two error messages from Task 1.
- Produces: `POST /users` and `PATCH /users/:id/details` answer 409 `type` slug `conflict` for either duplicate.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/routes/admin/users.test.ts`. Follow the file's existing pattern for obtaining a cookie — read the top of the file and reuse its `seedAdmin` and login helper rather than inventing one.

```ts
it('refuses a login that differs only in case', async () => {
  const cookie = await signInAs([PERMISSIONS.DIRECTORY_WRITE]);
  await ctx.app.inject({
    method: 'POST',
    url: '/api/admin/users',
    headers: { cookie },
    payload: { login: 'jdoe', email: 'a@acme.test', displayName: 'A' },
  });
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/admin/users',
    headers: { cookie },
    payload: { login: 'JDoe', email: 'b@acme.test', displayName: 'B' },
  });
  expect(res.statusCode).toBe(409);
});

it('refuses a second local account on one email', async () => {
  const cookie = await signInAs([PERMISSIONS.DIRECTORY_WRITE]);
  await ctx.app.inject({
    method: 'POST',
    url: '/api/admin/users',
    headers: { cookie },
    payload: { login: 'a', email: 'shared@acme.test', displayName: 'A' },
  });
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/admin/users',
    headers: { cookie },
    payload: { login: 'b', email: 'shared@acme.test', displayName: 'B' },
  });
  expect(res.statusCode).toBe(409);
  expect(res.json().detail).toMatch(/email already in use/i);
});

it('refuses an edit that collides with another local account email', async () => {
  const cookie = await signInAs([PERMISSIONS.DIRECTORY_WRITE]);
  await ctx.app.inject({
    method: 'POST',
    url: '/api/admin/users',
    headers: { cookie },
    payload: { login: 'a', email: 'taken@acme.test', displayName: 'A' },
  });
  const other = await ctx.app.inject({
    method: 'POST',
    url: '/api/admin/users',
    headers: { cookie },
    payload: { login: 'b', email: 'free@acme.test', displayName: 'B' },
  });
  const res = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/admin/users/${other.json().id}/details`,
    headers: { cookie },
    payload: { email: 'TAKEN@acme.test' },
  });
  expect(res.statusCode).toBe(409);
});
```

`signInAs` stands for whatever the file already uses to seed an admin with permissions and return a cookie header. Use the existing helper's real name.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run apps/api/src/routes/admin/users.test.ts`
Expected: the case test FAILS with 201 (Task 1 fixed the service, so this may already pass — if so, note it and move on); the email tests FAIL, the third with 200.

- [ ] **Step 3: Widen the `POST /users` error mapping**

In `apps/api/src/routes/admin/users.ts`, the catch around `createUser`:

```ts
        } catch (error) {
          // Both pre-checks in `createUser` raise a plain Error so the domain
          // stays free of HTTP; both are the same answer to the caller.
          if (
            error instanceof Error &&
            /(login already exists|email already in use)/i.test(error.message)
          ) {
            throw new ProblemError(409, 'conflict', 'Conflict', error.message);
          }
          throw error;
        }
```

- [ ] **Step 4: Add the email check to `PATCH /users/:id/details`**

In the handler, after the existing `sourceId` refusal and before the org-unit lookup:

```ts
        if (body.email !== undefined) {
          // Same rule as the create path and the partial index behind it:
          // among locally managed accounts only, and case-insensitively.
          const sharing = await tx.user.findFirst({
            where: {
              email: { equals: body.email, mode: 'insensitive' },
              sourceId: null,
              id: { not: id },
            },
          });
          if (sharing) {
            throw new ProblemError(
              409,
              'conflict',
              'Conflict',
              `email already in use: ${body.email}`,
            );
          }
        }
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm vitest run apps/api/src/routes/admin/users.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/admin/users.ts apps/api/src/routes/admin/users.test.ts
git commit -m "feat(api): answer 409 for a duplicate login or a duplicate local email"
```

---

### Task 3: `updateContract` and its route

**Files:**
- Modify: `packages/contracts/src/identity.ts` (after `createContractRequest`)
- Modify: `packages/core/src/identity/person-service.ts`
- Modify: `apps/api/src/routes/admin/persons.ts`
- Test: `apps/api/src/routes/admin/persons.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `patchContractRequest` — Zod schema, `.strict()`, every field optional, at least one required.
  - `updateContract(tx: TenantClient, personId: string, sequence: number, data: UpdateContractInput): Promise<Contract>` exported from `person-service.ts`.
  - `PATCH /api/admin/persons/:id/contracts/:sequence` under `identity.write`.

- [ ] **Step 1: Write the schema**

In `packages/contracts/src/identity.ts`, after `createContractRequest`:

```ts
/**
 * Correcting a contract.
 *
 * Same idiom as `patchPersonRequest`: every field optional, at least one
 * required, unknown keys refused. Before this the only way to fix a mistyped
 * department was a SECOND contract with a new sequence, which records a
 * different fact about the person than the one anybody meant to record.
 *
 * `startDate` is not nullable — a contract with no start is not a correction
 * anybody meant to make. Everything else is, so it can be cleared.
 */
export const patchContractRequest = z
  .object({
    isPrimary: z.boolean().optional(),
    startDate: z.coerce.date().optional(),
    endDate: z.coerce.date().nullable().optional(),
    jobTitle: z.string().max(256).nullable().optional(),
    department: z.string().max(256).nullable().optional(),
    costCentre: z.string().max(128).nullable().optional(),
    employer: z.string().max(256).nullable().optional(),
    location: z.string().max(256).nullable().optional(),
    managerPersonId: z.string().uuid().nullable().optional(),
    fte: z.number().min(0).max(2).nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change' });

export const contractParams = z.object({
  id: z.string().uuid(),
  sequence: z.coerce.number().int().positive(),
});
```

- [ ] **Step 2: Write the failing tests**

Append to `apps/api/src/routes/admin/persons.test.ts`, following the file's existing helpers for seeding a person with a contract and obtaining a cookie:

```ts
it('corrects a contract in place', async () => {
  const cookie = await signInAs([PERMISSIONS.IDENTITY_WRITE, PERMISSIONS.IDENTITY_READ]);
  const person = await ctx.app.inject({
    method: 'POST',
    url: '/api/admin/persons',
    headers: { cookie },
    payload: { givenName: 'Maya', familyName: 'Okafor' },
  });
  const id = person.json().id;
  await ctx.app.inject({
    method: 'POST',
    url: `/api/admin/persons/${id}/contracts`,
    headers: { cookie },
    payload: { sequence: 1, isPrimary: true, startDate: '2026-01-01', department: 'Slaes' },
  });

  const res = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/admin/persons/${id}/contracts/1`,
    headers: { cookie },
    payload: { department: 'Sales', jobTitle: 'Account Executive' },
  });

  expect(res.statusCode).toBe(200);
  expect(res.json().department).toBe('Sales');
  expect(res.json().jobTitle).toBe('Account Executive');
  // Untouched fields survive a partial patch.
  expect(res.json().isPrimary).toBe(true);
});

it('clears a field with null', async () => {
  const cookie = await signInAs([PERMISSIONS.IDENTITY_WRITE, PERMISSIONS.IDENTITY_READ]);
  const person = await ctx.app.inject({
    method: 'POST',
    url: '/api/admin/persons',
    headers: { cookie },
    payload: { givenName: 'Sam', familyName: 'Roe' },
  });
  const id = person.json().id;
  await ctx.app.inject({
    method: 'POST',
    url: `/api/admin/persons/${id}/contracts`,
    headers: { cookie },
    payload: { sequence: 1, isPrimary: true, startDate: '2026-01-01', jobTitle: 'Temp' },
  });
  const res = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/admin/persons/${id}/contracts/1`,
    headers: { cookie },
    payload: { jobTitle: null },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().jobTitle).toBeNull();
});

it('demotes the incumbent when a second contract is promoted to primary', async () => {
  const cookie = await signInAs([PERMISSIONS.IDENTITY_WRITE, PERMISSIONS.IDENTITY_READ]);
  const person = await ctx.app.inject({
    method: 'POST',
    url: '/api/admin/persons',
    headers: { cookie },
    payload: { givenName: 'Kaycen', familyName: 'Tyre' },
  });
  const id = person.json().id;
  await ctx.app.inject({
    method: 'POST',
    url: `/api/admin/persons/${id}/contracts`,
    headers: { cookie },
    payload: { sequence: 1, isPrimary: true, startDate: '2026-01-01' },
  });
  await ctx.app.inject({
    method: 'POST',
    url: `/api/admin/persons/${id}/contracts`,
    headers: { cookie },
    payload: { sequence: 2, isPrimary: false, startDate: '2026-02-01' },
  });

  await ctx.app.inject({
    method: 'PATCH',
    url: `/api/admin/persons/${id}/contracts/2`,
    headers: { cookie },
    payload: { isPrimary: true },
  });

  const detail = await ctx.app.inject({
    method: 'GET',
    url: `/api/admin/persons/${id}`,
    headers: { cookie },
  });
  const contracts = detail.json().contracts as { sequence: number; isPrimary: boolean }[];
  expect(contracts.find((c) => c.sequence === 1)!.isPrimary).toBe(false);
  expect(contracts.find((c) => c.sequence === 2)!.isPrimary).toBe(true);
});

it('refuses a patch with nothing in it', async () => {
  const cookie = await signInAs([PERMISSIONS.IDENTITY_WRITE, PERMISSIONS.IDENTITY_READ]);
  const person = await ctx.app.inject({
    method: 'POST',
    url: '/api/admin/persons',
    headers: { cookie },
    payload: { givenName: 'No', familyName: 'One' },
  });
  const id = person.json().id;
  await ctx.app.inject({
    method: 'POST',
    url: `/api/admin/persons/${id}/contracts`,
    headers: { cookie },
    payload: { sequence: 1, isPrimary: true, startDate: '2026-01-01' },
  });
  const res = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/admin/persons/${id}/contracts/1`,
    headers: { cookie },
    payload: {},
  });
  expect(res.statusCode).toBe(400);
});

it('404s for a sequence this person does not hold', async () => {
  const cookie = await signInAs([PERMISSIONS.IDENTITY_WRITE, PERMISSIONS.IDENTITY_READ]);
  const person = await ctx.app.inject({
    method: 'POST',
    url: '/api/admin/persons',
    headers: { cookie },
    payload: { givenName: 'Nobody', familyName: 'Here' },
  });
  const res = await ctx.app.inject({
    method: 'PATCH',
    url: `/api/admin/persons/${person.json().id}/contracts/9`,
    headers: { cookie },
    payload: { jobTitle: 'Ghost' },
  });
  expect(res.statusCode).toBe(404);
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm vitest run apps/api/src/routes/admin/persons.test.ts`
Expected: all five FAIL with 404, because no such route is registered.

- [ ] **Step 4: Implement `updateContract`**

In `packages/core/src/identity/person-service.ts`:

```ts
export interface UpdateContractInput {
  isPrimary?: boolean | undefined;
  startDate?: Date | undefined;
  endDate?: Date | null | undefined;
  jobTitle?: string | null | undefined;
  department?: string | null | undefined;
  costCentre?: string | null | undefined;
  employer?: string | null | undefined;
  location?: string | null | undefined;
  managerPersonId?: string | null | undefined;
  fte?: number | null | undefined;
}

/**
 * Correcting a contract in place.
 *
 * The alternative — and what the console forced until now — was adding a
 * second contract with a new sequence, which does not say "that department was
 * a typo". It says "they took a second job", and the planner reads it that
 * way.
 *
 * Promoting to primary demotes the incumbent in the same transaction, the same
 * rule the create path applies: two primary contracts would make
 * `resolveContractForMapping` return whichever the planner happened to reach
 * first, which is a claim mapping that changes on its own.
 *
 * Returns null when this person holds no contract at that sequence, so the
 * caller decides what a 404 is.
 */
export async function updateContract(
  tx: TenantClient,
  personId: string,
  sequence: number,
  data: UpdateContractInput,
) {
  const existing = await tx.contract.findFirst({ where: { personId, sequence } });
  if (!existing) return null;

  if (data.isPrimary === true) {
    await tx.contract.updateMany({
      where: { personId, isPrimary: true, sequence: { not: sequence } },
      data: { isPrimary: false },
    });
  }

  return tx.contract.update({
    where: { id: existing.id },
    // Spread key by key rather than passing `data` whole: an omitted field
    // must leave the column alone, and Prisma treats an explicit `undefined`
    // in an object literal differently from an absent one depending on how it
    // was built. Being explicit here costs ten lines and removes the question.
    data: {
      ...(data.isPrimary === undefined ? {} : { isPrimary: data.isPrimary }),
      ...(data.startDate === undefined ? {} : { startDate: data.startDate }),
      ...(data.endDate === undefined ? {} : { endDate: data.endDate }),
      ...(data.jobTitle === undefined ? {} : { jobTitle: data.jobTitle }),
      ...(data.department === undefined ? {} : { department: data.department }),
      ...(data.costCentre === undefined ? {} : { costCentre: data.costCentre }),
      ...(data.employer === undefined ? {} : { employer: data.employer }),
      ...(data.location === undefined ? {} : { location: data.location }),
      ...(data.managerPersonId === undefined
        ? {}
        : { managerPersonId: data.managerPersonId }),
      ...(data.fte === undefined ? {} : { fte: data.fte }),
    },
  });
}
```

- [ ] **Step 5: Register the route**

In `apps/api/src/routes/admin/persons.ts`, importing `patchContractRequest`, `contractParams` from `@syntra/contracts` and `updateContract` from `@syntra/core`:

```ts
  /**
   * Correcting a contract, addressed by the sequence the person holds it at.
   *
   * By sequence rather than by contract id because that is how the console
   * reads them — `GET /persons/:id` returns contracts under the person, and a
   * row on that screen knows its sequence and not its uuid.
   */
  app.patch(
    '/persons/:id/contracts/:sequence',
    { preHandler: requirePermission(PERMISSIONS.IDENTITY_WRITE) },
    async (request) => {
      const { id, sequence } = contractParams.parse(request.params);
      const body = patchContractRequest.parse(request.body);

      return request.db(async (tx) => {
        const person = await tx.person.findUnique({ where: { id } });
        if (!person) throw new ProblemError(404, 'not-found', 'Person not found');

        const before = await tx.contract.findFirst({ where: { personId: id, sequence } });
        const updated = await updateContract(tx, id, sequence, body);
        if (!updated) throw new ProblemError(404, 'not-found', 'Contract not found');

        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'person.updateContract',
          targetType: 'Person',
          targetId: id,
          outcome: 'success',
          sourceIp: request.ip,
          payload: {
            sequence,
            from: {
              jobTitle: before?.jobTitle ?? null,
              department: before?.department ?? null,
              isPrimary: before?.isPrimary ?? null,
            },
            to: {
              jobTitle: updated.jobTitle,
              department: updated.department,
              isPrimary: updated.isPrimary,
            },
          },
        });
        return updated;
      });
    },
  );
```

- [ ] **Step 6: Run to verify pass**

Run: `pnpm vitest run apps/api/src/routes/admin/persons.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck**

Run: `pnpm typecheck`
Expected: no errors. If `Decimal` complains about `fte`, pass it through as the schema's `number`; Prisma accepts a number for a `Decimal` column.

- [ ] **Step 8: Commit**

```bash
git add packages/contracts/src/identity.ts packages/core/src/identity/person-service.ts apps/api/src/routes/admin/persons.ts apps/api/src/routes/admin/persons.test.ts
git commit -m "feat(identity): correct a contract in place instead of adding a second one"
```

---

### Task 4: Editing a contract on the person's screen

**Files:**
- Modify: `apps/web/src/pages/admin/PersonDetailPage.tsx` (the `Contracts` panel around `:230-340`)
- Test: `apps/web/src/pages/admin/PersonDetailPage.test.tsx`

**Interfaces:**
- Consumes: `PATCH /api/admin/persons/:id/contracts/:sequence` from Task 3.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the failing test**

Append to `apps/web/src/pages/admin/PersonDetailPage.test.tsx`, following the file's existing fetch-mocking helper:

```ts
it('opens an edit form on a contract row, prefilled', async () => {
  mockPerson({
    contracts: [
      {
        id: 'c1',
        sequence: 1,
        isPrimary: true,
        startDate: '2026-01-01',
        endDate: null,
        jobTitle: 'Analyst',
        department: 'Slaes',
      },
    ],
  });
  render(
    <MemoryRouter initialEntries={['/admin/people/p1']}>
      <PersonDetailPage />
    </MemoryRouter>,
  );

  await screen.findByText('Slaes');
  await userEvent.click(screen.getByRole('button', { name: /edit contract 1/i }));

  expect(await screen.findByLabelText('Department')).toHaveValue('Slaes');
  expect(screen.getByLabelText('Job title')).toHaveValue('Analyst');
});
```

`mockPerson` stands for whatever the file already uses; read it and reuse it, extending its default person shape rather than duplicating it.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run apps/web/src/pages/admin/PersonDetailPage.test.tsx`
Expected: FAIL — no button named "Edit contract 1".

- [ ] **Step 3: Implement**

Add one piece of state beside the page's existing state:

```tsx
  // WHICH contract is being edited, held as its sequence. One at a time and
  // one panel, the shape AccountsTab's rework settled on: a collapsed panel
  // per row would put a block-level form inside a table cell.
  const [editingSequence, setEditingSequence] = useState<number | null>(null);
```

In the contracts table, add a trailing cell per row:

```tsx
                    <td>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setEditingSequence(contract.sequence)}
                      >
                        {/* Named with its sequence: a table of identical
                            "Edit" buttons is unreadable to a screen reader,
                            which announces them one after another with no way
                            to tell which row it is on. */}
                        Edit contract {contract.sequence}
                      </Button>
                    </td>
```

and add the matching `<th scope="col"><span className="sr-only">Actions</span></th>` to the header row.

Above the table, render the edit panel when a sequence is selected. `editing` is the contract from `data.contracts`:

```tsx
        {editingSequence !== null &&
          (() => {
            const editing = data.contracts.find((c) => c.sequence === editingSequence);
            if (!editing) return null;
            return (
              <RecordPanel
                title={`Edit contract ${editing.sequence}`}
                submitLabel="Save"
                method="PATCH"
                path={`/api/admin/persons/${data.id}/contracts/${editing.sequence}`}
                initial={{
                  jobTitle: editing.jobTitle ?? '',
                  department: editing.department ?? '',
                  costCentre: editing.costCentre ?? '',
                  employer: editing.employer ?? '',
                  location: editing.location ?? '',
                  endDate: editing.endDate?.slice(0, 10) ?? '',
                }}
                onCancel={() => setEditingSequence(null)}
                onCreated={() => {
                  setEditingSequence(null);
                  reload();
                }}
                // An emptied box CLEARS the field rather than being dropped.
                // This is an edit form: the difference between "leave it" and
                // "there is no department" is the whole reason the schema
                // takes a null, and dropping the empty string would make a
                // typo uncorrectable in the direction of removing it.
                build={(v) => ({
                  jobTitle: v.jobTitle?.trim() ? v.jobTitle : null,
                  department: v.department?.trim() ? v.department : null,
                  costCentre: v.costCentre?.trim() ? v.costCentre : null,
                  employer: v.employer?.trim() ? v.employer : null,
                  location: v.location?.trim() ? v.location : null,
                  endDate: v.endDate?.trim() ? v.endDate : null,
                })}
                fields={(v, set, errs) => (
                  <>
                    <Field
                      label="Job title"
                      value={v.jobTitle ?? ''}
                      onChange={(x) => set('jobTitle', x)}
                      error={errs.jobTitle}
                    />
                    <Field
                      label="Department"
                      value={v.department ?? ''}
                      onChange={(x) => set('department', x)}
                      error={errs.department}
                    />
                    <Field
                      label="Cost centre"
                      value={v.costCentre ?? ''}
                      onChange={(x) => set('costCentre', x)}
                      error={errs.costCentre}
                    />
                    <Field
                      label="Employer"
                      value={v.employer ?? ''}
                      onChange={(x) => set('employer', x)}
                      error={errs.employer}
                    />
                    <Field
                      label="Location"
                      value={v.location ?? ''}
                      onChange={(x) => set('location', x)}
                      error={errs.location}
                    />
                    <Field
                      label="End date"
                      type="date"
                      value={v.endDate ?? ''}
                      onChange={(x) => set('endDate', x)}
                      error={errs.endDate}
                    />
                  </>
                )}
              />
            );
          })()}
```

Add `costCentre`, `employer` and `location` to the `Contract` interface at `:20` if they are not already there, typed `string | null`.

`isPrimary` is deliberately not on this form. Promoting a contract is a different decision from correcting one, the API supports it, and a checkbox for it next to a typo fix is how somebody demotes a primary contract while fixing a department.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run apps/web/src/pages/admin/PersonDetailPage.test.tsx`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm typecheck
git add apps/web/src/pages/admin/PersonDetailPage.tsx apps/web/src/pages/admin/PersonDetailPage.test.tsx
git commit -m "feat(console): edit a contract's department and job title in place"
```

---

### Task 5: `mustChange` — schema, `setPasswordHash`, and the renewal gate

**Files:**
- Modify: `packages/db/prisma/schema.prisma` (`PasswordCredential`)
- Create: `packages/db/prisma/migrations/20260923000000_password_must_change/migration.sql`
- Modify: `packages/core/src/auth/password.ts` (`setPasswordHash`)
- Modify: `packages/core/src/auth/password-ageing.ts` (`passwordExpired` → `mustRenewPassword`)
- Modify: `packages/core/src/auth/authorize.ts:493`
- Test: `packages/core/src/auth/password-ageing.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `setPasswordHash(tx, userId, hash, opts?: { now?: Date; mustChange?: boolean })` — `mustChange` defaults to `false`, so every existing caller clears the flag.
  - `mustRenewPassword(tx, userId, policy: AgeingPolicy, now: Date): Promise<boolean>` — replaces `passwordExpired`, same signature.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/auth/password-ageing.test.ts`, importing `mustRenewPassword` and `setPasswordHash`:

```ts
describe('mustRenewPassword', () => {
  it('is true for a flagged credential even with expiry switched off', async () => {
    const hash = await hashPassword('a-long-enough-password');
    const user = await withTenant(tenantId, async (tx) => {
      const u = await createUser(tx, {
        login: 'flagged',
        email: 'flagged@acme.test',
        displayName: 'F',
      });
      await setPasswordHash(tx, u.id, hash, { mustChange: true });
      return u;
    });

    const result = await withTenant(tenantId, (tx) =>
      // Zero means scheduled expiry is off, which is the default and the
      // recommended setting. An administrator's demand must survive it.
      mustRenewPassword(tx, user.id, { passwordMaxAgeDays: 0, passwordHistoryDepth: 0 }, new Date()),
    );
    expect(result).toBe(true);
  });

  it('is cleared by the next write of a password', async () => {
    const first = await hashPassword('a-long-enough-password');
    const second = await hashPassword('a-different-long-password');
    const user = await withTenant(tenantId, async (tx) => {
      const u = await createUser(tx, {
        login: 'cleared',
        email: 'cleared@acme.test',
        displayName: 'C',
      });
      await setPasswordHash(tx, u.id, first, { mustChange: true });
      return u;
    });

    // No `mustChange` option: the default is false, so every existing caller
    // clears the flag by construction rather than by remembering to.
    await withTenant(tenantId, (tx) => setPasswordHash(tx, user.id, second));

    const result = await withTenant(tenantId, (tx) =>
      mustRenewPassword(tx, user.id, { passwordMaxAgeDays: 0, passwordHistoryDepth: 0 }, new Date()),
    );
    expect(result).toBe(false);
  });

  it('is false for an upstream account however it is flagged', async () => {
    const hash = await hashPassword('a-long-enough-password');
    const user = await withTenant(tenantId, async (tx) => {
      const u = await createUser(tx, {
        login: 'federated',
        email: 'federated@acme.test',
        displayName: 'U',
      });
      await setPasswordHash(tx, u.id, hash, { mustChange: true });
      await tx.user.update({ where: { id: u.id }, data: { passwordSource: 'upstream' } });
      return u;
    });

    const result = await withTenant(tenantId, (tx) =>
      mustRenewPassword(tx, user.id, { passwordMaxAgeDays: 90, passwordHistoryDepth: 0 }, new Date()),
    );
    // Expiring them would strand them in front of a form that changes nothing
    // at their provider — the reason the existing guard is there.
    expect(result).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/core/src/auth/password-ageing.test.ts`
Expected: FAIL to compile — `mustRenewPassword` is not exported and `setPasswordHash` takes no `mustChange`.

- [ ] **Step 3: Schema and migration**

In `packages/db/prisma/schema.prisma`, inside `PasswordCredential`:

```prisma
  /// Whether this user must choose a new password before they get a session.
  ///
  /// Set only by an administrator setting a password on somebody's behalf.
  /// Cleared by any write of a password the user chose themselves, which
  /// `setPasswordHash` does by defaulting the option to false — one entry
  /// point that cannot do the wrong thing, the same reason the reuse check
  /// lives in there rather than in the callers.
  ///
  /// Honoured independently of `passwordMaxAgeDays`. Scheduled expiry is off
  /// by default and should usually stay off; that recommendation must not
  /// switch off a change somebody demanded this morning.
  mustChange Boolean @default(false)
```

Create `packages/db/prisma/migrations/20260923000000_password_must_change/migration.sql`:

```sql
-- Must the user choose a new password before they get a session?
--
-- Set by an administrator setting a password on somebody's behalf, and cleared
-- by any password the user chooses themselves. Independent of
-- `passwordMaxAgeDays`, which is off by default: a policy that has switched
-- scheduled expiry off must not switch off a demand made this morning.
ALTER TABLE "PasswordCredential"
  ADD COLUMN "mustChange" BOOLEAN NOT NULL DEFAULT false;
```

Run: `pnpm db:migrate && pnpm db:generate`

- [ ] **Step 4: Widen `setPasswordHash`**

In `packages/core/src/auth/password.ts`, change the signature and the upsert:

```ts
export async function setPasswordHash(
  tx: TenantClient,
  userId: string,
  hash: string,
  opts: { now?: Date; mustChange?: boolean } = {},
): Promise<void> {
```

and at the end:

```ts
  // Defaulted to false rather than left to the caller, so self-service change,
  // renewal and reset completion all CLEAR the flag by construction. A caller
  // that had to remember is a caller that will not, and the failure mode is a
  // user asked to change their password again immediately after changing it.
  const mustChange = opts.mustChange ?? false;

  await tx.passwordCredential.upsert({
    where: { userId },
    create: { tenantId, userId, hash, changedAt: now, mustChange },
    update: { hash, changedAt: now, mustChange },
  });
```

- [ ] **Step 5: Rename and widen the gate**

In `packages/core/src/auth/password-ageing.ts`, rename `passwordExpired` to `mustRenewPassword`, keeping its signature, and read the flag:

```ts
/**
 * Whether this user must choose a new password before they get a session.
 *
 * Two independent reasons, and the order matters: an administrator's demand is
 * honoured whatever the ageing policy says, because `passwordMaxAgeDays` is
 * zero in most tenants and should be — see the note above — and a flag that
 * only fired where scheduled expiry was switched on would be a control that
 * silently did nothing almost everywhere.
 *
 * Answers false for anything Syntra does not own. A user whose password lives
 * upstream cannot be helped by a change form here, and a user with no password
 * credential at all has nothing to renew.
 */
export async function mustRenewPassword(
  tx: TenantClient,
  userId: string,
  policy: AgeingPolicy,
  now: Date,
): Promise<boolean> {
  const user = await tx.user.findUnique({
    where: { id: userId },
    select: { passwordSource: true },
  });
  if (!user || user.passwordSource !== 'local') return false;

  const credential = await tx.passwordCredential.findUnique({
    where: { userId },
    select: { changedAt: true, mustChange: true },
  });
  if (!credential) return false;

  if (credential.mustChange) return true;

  if (policy.passwordMaxAgeDays <= 0) return false;
  const age = now.getTime() - credential.changedAt.getTime();
  return age > policy.passwordMaxAgeDays * DAY_MS;
}
```

Note the reordering: the `passwordMaxAgeDays <= 0` early return moved below the credential read, because the flag has to be consulted even when expiry is off.

Update the import and the call at `packages/core/src/auth/authorize.ts:493` to `mustRenewPassword`. Update `packages/core/src/auth/password-ageing.test.ts`'s existing `passwordExpired` tests to the new name — behaviour is unchanged for every one of them.

- [ ] **Step 6: Run the auth suites**

Run: `pnpm vitest run packages/core/src/auth`
Expected: PASS, including `authorize.test.ts` and `password-change.test.ts` untouched.

- [ ] **Step 7: Typecheck**

Run: `pnpm typecheck`
Expected: no errors. Any remaining reference to `passwordExpired` shows up here.

- [ ] **Step 8: Commit**

```bash
git add packages/db/prisma/schema.prisma packages/db/prisma/migrations/20260923000000_password_must_change packages/core/src/auth
git commit -m "feat(auth): a credential can be flagged must-change, and the renewal gate honours it"
```

---

### Task 6: `setPasswordAsAdmin`

**Files:**
- Modify: `packages/core/src/auth/password-change.ts`
- Test: `packages/core/src/auth/password-change.test.ts`

**Interfaces:**
- Consumes: `setPasswordHash`'s `mustChange` option from Task 5.
- Produces:

```ts
export type SetPasswordAsAdminOutcome =
  | { ok: true; sessionsRevoked: number }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'upstream'; hint: string | null }
  | { ok: false; reason: 'directory_owned'; sourceId: string }
  | { ok: false; reason: 'weak_password'; detail: string }
  | { ok: false; reason: 'reused'; depth: number };

export async function setPasswordAsAdmin(
  tenantId: string,
  input: {
    userId: string;
    actorUserId: string;
    newPassword: string;
    sourceIp: string | null;
    now?: Date | undefined;
  },
): Promise<SetPasswordAsAdminOutcome>;
```

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/auth/password-change.test.ts`, reusing its existing tenant and user setup:

```ts
describe('setPasswordAsAdmin', () => {
  it('sets the password, flags it must-change, and revokes every session', async () => {
    const { admin, target } = await seedAdminAndTarget();
    await issueSessionFor(target.id);

    const outcome = await setPasswordAsAdmin(tenantId, {
      userId: target.id,
      actorUserId: admin.id,
      newPassword: 'a-long-enough-password',
      sourceIp: null,
    });

    expect(outcome).toMatchObject({ ok: true });
    const credential = await withTenant(tenantId, (tx) =>
      tx.passwordCredential.findUnique({ where: { userId: target.id } }),
    );
    expect(credential!.mustChange).toBe(true);
    const live = await withTenant(tenantId, (tx) =>
      tx.session.count({ where: { userId: target.id, revokedAt: null } }),
    );
    expect(live).toBe(0);
  });

  it('refuses an upstream account', async () => {
    const { admin, target } = await seedAdminAndTarget();
    await withTenant(tenantId, (tx) =>
      tx.user.update({
        where: { id: target.id },
        data: { passwordSource: 'upstream', passwordSourceHint: 'Okta' },
      }),
    );

    const outcome = await setPasswordAsAdmin(tenantId, {
      userId: target.id,
      actorUserId: admin.id,
      newPassword: 'a-long-enough-password',
      sourceIp: null,
    });

    expect(outcome).toEqual({ ok: false, reason: 'upstream', hint: 'Okta' });
  });

  it('refuses an account whose directory writes passwords', async () => {
    const { admin, target } = await seedAdminAndTarget();
    const source = await withTenant(tenantId, (tx) =>
      tx.directorySource.create({
        data: {
          tenantId,
          name: 'Corporate LDAP',
          kind: 'ldap',
          config: {},
          writebackEnabled: true,
          writebackPassword: true,
        },
      }),
    );
    await withTenant(tenantId, (tx) =>
      tx.user.update({
        where: { id: target.id },
        data: { sourceId: source.id, sourceAnchor: 'anchor-1' },
      }),
    );

    const outcome = await setPasswordAsAdmin(tenantId, {
      userId: target.id,
      actorUserId: admin.id,
      newPassword: 'a-long-enough-password',
      sourceIp: null,
    });

    // The connector's only password call takes a currentPassword, which an
    // administrator does not have. Writing a local hash alone is exactly the
    // divergence changeOwnPassword refuses to create.
    expect(outcome).toMatchObject({ ok: false, reason: 'directory_owned' });
  });

  it('refuses a password the policy rejects', async () => {
    const { admin, target } = await seedAdminAndTarget();
    const outcome = await setPasswordAsAdmin(tenantId, {
      userId: target.id,
      actorUserId: admin.id,
      newPassword: 'x',
      sourceIp: null,
    });
    expect(outcome).toMatchObject({ ok: false, reason: 'weak_password' });
  });

  it('refuses a password this user has already retired', async () => {
    const { admin, target } = await seedAdminAndTarget();
    await withTenant(tenantId, (tx) =>
      tx.tenant.update({ where: { id: tenantId }, data: { passwordHistoryDepth: 3 } }),
    );
    const first = 'a-long-enough-password';
    await setPasswordAsAdmin(tenantId, {
      userId: target.id,
      actorUserId: admin.id,
      newPassword: first,
      sourceIp: null,
    });
    await setPasswordAsAdmin(tenantId, {
      userId: target.id,
      actorUserId: admin.id,
      newPassword: 'a-second-long-password',
      sourceIp: null,
    });

    const outcome = await setPasswordAsAdmin(tenantId, {
      userId: target.id,
      actorUserId: admin.id,
      newPassword: first,
      sourceIp: null,
    });
    expect(outcome).toMatchObject({ ok: false, reason: 'reused', depth: 3 });
  });
});
```

Write `seedAdminAndTarget` and `issueSessionFor` as small local helpers at the top of the `describe`, using `createUser`, `setPasswordHash` and the session helper the file already imports. If the file has equivalents, use those instead.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/core/src/auth/password-change.test.ts`
Expected: FAIL to compile — `setPasswordAsAdmin` is not exported.

- [ ] **Step 3: Implement**

Append to `packages/core/src/auth/password-change.ts`, importing `revokeAllForUser` from `./session-service.js` alongside the existing `revokeAllForUserExcept`:

```ts
export type SetPasswordAsAdminOutcome =
  | { ok: true; sessionsRevoked: number }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'upstream'; hint: string | null }
  /** A directory owns this password. Carries the source so the caller names it. */
  | { ok: false; reason: 'directory_owned'; sourceId: string }
  | { ok: false; reason: 'weak_password'; detail: string }
  | { ok: false; reason: 'reused'; depth: number };

export interface SetPasswordAsAdminInput {
  userId: string;
  actorUserId: string;
  newPassword: string;
  sourceIp: string | null;
  now?: Date | undefined;
}

/**
 * An administrator setting somebody else's password.
 *
 * The gap it fills: `password-setup` mints a one-time link, which is right for
 * a joiner and wrong for the support call where somebody is reading a password
 * down the phone to a person who cannot reach their mailbox.
 *
 * Distinct from `changeOwnPassword` in what it can prove and therefore in what
 * it demands. There is no current password to re-type here — the administrator
 * does not know it, and that is the whole point — so the authority comes from
 * the permission and the audit record, and the account's own sessions are all
 * revoked rather than all-but-one. `changeOwnPassword` keeps the caller's
 * session because the caller is the account. Here they are not.
 *
 * The new password is flagged must-change. An administrator who typed it knows
 * it, so it is a handover credential and not the user's password until the
 * user has chosen one.
 */
export async function setPasswordAsAdmin(
  tenantId: string,
  input: SetPasswordAsAdminInput,
): Promise<SetPasswordAsAdminOutcome> {
  const now = input.now ?? new Date();

  const context = await withTenant(tenantId, async (tx) => {
    const user = await tx.user.findUnique({ where: { id: input.userId } });
    if (!user) return null;
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const source =
      user.sourceId === null
        ? null
        : await tx.directorySource.findUnique({
            where: { id: user.sourceId },
            select: { id: true, writebackEnabled: true, writebackPassword: true },
          });
    return {
      user,
      minLength: tenant.passwordMinLength,
      historyDepth: tenant.passwordHistoryDepth,
      writesPassword: Boolean(source?.writebackEnabled && source.writebackPassword),
      sourceId: source?.id ?? null,
    };
  });

  if (!context) return { ok: false, reason: 'not_found' };

  if (context.user.passwordSource !== 'local') {
    return { ok: false, reason: 'upstream', hint: context.user.passwordSourceHint };
  }

  // The directory owns this password, and there is no admin-set writeback:
  // `SourceWriteback.changePassword` takes a `currentPassword` an
  // administrator does not have. Writing a local hash alone would leave Syntra
  // accepting a password the domain refuses, which is precisely the divergence
  // `changeOwnPassword` refuses to create and the support call with no visible
  // cause that follows it. Refuse, and name the source.
  if (context.writesPassword) {
    return { ok: false, reason: 'directory_owned', sourceId: context.sourceId! };
  }

  const policy = validateNewPassword(input.newPassword, {
    minLength: context.minLength,
    login: context.user.login,
    email: context.user.email,
  });
  if (!policy.ok) {
    return { ok: false, reason: 'weak_password', detail: policy.reason };
  }

  if (context.historyDepth > 0) {
    const reused = await withTenant(tenantId, (tx) =>
      passwordWasUsedBefore(tx, input.userId, input.newPassword, context.historyDepth),
    );
    if (reused) {
      return { ok: false, reason: 'reused', depth: context.historyDepth };
    }
  }

  // Outside the transaction: Argon2id is deliberately expensive and has no
  // business inside Prisma's 5000 ms budget.
  const hash = await hashPassword(input.newPassword);

  const sessionsRevoked = await withTenant(tenantId, async (tx) => {
    await setPasswordHash(tx, input.userId, hash, { now, mustChange: true });
    // Every session, not all-but-one. An administrator setting a password
    // because an account is compromised is the case this exists for, and a
    // credential change whose sessions outlive it reads as done and is not.
    const revoked = await revokeAllForUser(tx, input.userId);
    await revokeAllRefreshTokensForUser(tx, input.userId);
    await recordEvent(tx, {
      actorUserId: input.actorUserId,
      action: 'user.setPassword',
      targetType: 'User',
      targetId: input.userId,
      outcome: 'success',
      sourceIp: input.sourceIp,
      // Neither the plaintext nor the hash appears here, or anywhere else.
      payload: { at: now.toISOString(), sessionsRevoked: revoked, mustChange: true },
    });
    return revoked;
  });

  return { ok: true, sessionsRevoked };
}
```

Check `passwordWasUsedBefore`'s real signature in `password-ageing.ts` before writing the call — match it exactly rather than the shape assumed here. Likewise `revokeAllForUser`'s return: if it returns `void` rather than a count, drop `sessionsRevoked` from the success variant and from the audit payload rather than inventing a number.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run packages/core/src/auth/password-change.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm typecheck
git add packages/core/src/auth/password-change.ts packages/core/src/auth/password-change.test.ts
git commit -m "feat(auth): an administrator can set a password, flagged must-change"
```

---

### Task 7: `POST /api/admin/users/:id/password`

**Files:**
- Modify: `apps/api/src/routes/admin/users.ts` (after the `password-setup` handler at `:412`)
- Modify: `packages/contracts/src/directory.ts`
- Test: `apps/api/src/routes/admin/users.test.ts`

**Interfaces:**
- Consumes: `setPasswordAsAdmin` from Task 6.
- Produces: `POST /api/admin/users/:id/password` under `directory.write`, body `{ password: string }`, 200 `{ sessionsRevoked: number, mustChange: true }`.

- [ ] **Step 1: Add the request schema**

In `packages/contracts/src/directory.ts`:

```ts
/**
 * An administrator setting a password on somebody's behalf.
 *
 * The ceiling matches `validateNewPassword`'s: Argon2id's cost is proportional
 * to input, and an unbounded password field is a way to spend a server's
 * memory on demand. The floor is 1 rather than the tenant's minimum, because
 * the policy check belongs in one place and refusing here would report the
 * rule twice and disagree with it eventually.
 */
export const setUserPasswordRequest = z
  .object({ password: z.string().min(1).max(1024) })
  .strict();
```

- [ ] **Step 2: Write the failing tests**

Append to `apps/api/src/routes/admin/users.test.ts`:

```ts
it('sets a password and reports what it revoked', async () => {
  const cookie = await signInAs([PERMISSIONS.DIRECTORY_WRITE]);
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/admin/users',
    headers: { cookie },
    payload: { login: 'target', email: 'target@acme.test', displayName: 'T' },
  });

  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/admin/users/${created.json().id}/password`,
    headers: { cookie },
    payload: { password: 'a-long-enough-password' },
  });

  expect(res.statusCode).toBe(200);
  expect(res.json().mustChange).toBe(true);
});

it('refuses a weak password with a 422', async () => {
  const cookie = await signInAs([PERMISSIONS.DIRECTORY_WRITE]);
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/admin/users',
    headers: { cookie },
    payload: { login: 'weak', email: 'weak@acme.test', displayName: 'W' },
  });
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/admin/users/${created.json().id}/password`,
    headers: { cookie },
    payload: { password: 'x' },
  });
  expect(res.statusCode).toBe(422);
});

it('refuses without directory.write', async () => {
  const cookie = await signInAs([PERMISSIONS.DIRECTORY_READ]);
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/api/admin/users/${crypto.randomUUID()}/password`,
    headers: { cookie },
    payload: { password: 'a-long-enough-password' },
  });
  expect(res.statusCode).toBe(403);
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm vitest run apps/api/src/routes/admin/users.test.ts`
Expected: the first two FAIL with 404.

- [ ] **Step 4: Implement the route**

```ts
  /**
   * Setting a password on somebody's behalf.
   *
   * Guarded by `directory.write` and no step-up, matching `password-setup`
   * immediately above. The two are the same authority over the same account
   * and must not disagree about what it takes to exercise it; if step-up is
   * wanted it belongs on both, as one change to how credential operations are
   * guarded, and not as an inconsistency introduced here.
   */
  app.post(
    '/users/:id/password',
    { preHandler: requirePermission(PERMISSIONS.DIRECTORY_WRITE) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const { password } = setUserPasswordRequest.parse(request.body);

      const outcome = await setPasswordAsAdmin(request.tenantId, {
        userId: id,
        actorUserId: request.session.userId,
        newPassword: password,
        sourceIp: request.ip,
      });

      if (outcome.ok) {
        return { sessionsRevoked: outcome.sessionsRevoked, mustChange: true };
      }

      switch (outcome.reason) {
        case 'not_found':
          throw new ProblemError(404, 'not-found', 'User not found');
        case 'upstream':
          throw new ProblemError(
            409,
            'upstream-password',
            'Managed by an identity provider',
            `This account signs in through ${
              outcome.hint ?? 'an upstream provider'
            }, which holds the password. Change it there.`,
          );
        case 'directory_owned':
          throw new ProblemError(
            409,
            'directory-owned-password',
            'Managed by a directory',
            'This account’s password lives in the directory that syncs it, and Syntra can only change a directory password when the current one is supplied. Change it in the directory, or send a password link instead.',
          );
        case 'weak_password':
          // 422 rather than 400: the body parsed, and the value was
          // understood and refused. A 400 would read as a malformed request
          // and send somebody looking at their JSON.
          throw new ProblemError(
            422,
            'weak-password',
            'That password was refused',
            outcome.detail,
          );
        case 'reused':
          throw new ProblemError(
            422,
            'reused-password',
            'That password was refused',
            `It is one of this account’s last ${outcome.depth} passwords.`,
          );
      }
    },
  );
```

`request.tenantId` is how the neighbouring handlers reach the tenant; confirm against `password-setup` above and match it.

- [ ] **Step 5: Run to verify pass**

Run: `pnpm vitest run apps/api/src/routes/admin/users.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm typecheck
git add apps/api/src/routes/admin/users.ts packages/contracts/src/directory.ts apps/api/src/routes/admin/users.test.ts
git commit -m "feat(api): POST /users/:id/password sets a password on somebody's behalf"
```

---

### Task 8: The "Set password" control

**Files:**
- Modify: `apps/web/src/pages/admin/AccountDetailPage.tsx` (the Sign-in panel, around `:290-330`)
- Test: `apps/web/src/pages/admin/AccountDetailPage.test.tsx`

**Interfaces:**
- Consumes: `POST /api/admin/users/:id/password` from Task 7.

- [ ] **Step 1: Write the failing test**

```ts
it('sets a password and says what it cost', async () => {
  mockAccount({ sourceId: null, passwordSource: 'local' });
  render(
    <MemoryRouter initialEntries={['/admin/users/u1']}>
      <AccountDetailPage />
    </MemoryRouter>,
  );

  await userEvent.click(await screen.findByRole('button', { name: 'Set password' }));
  await userEvent.type(screen.getByLabelText('New password'), 'a-long-enough-password');

  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ sessionsRevoked: 2, mustChange: true }), { status: 200 }),
  );
  await userEvent.click(screen.getByRole('button', { name: 'Set it' }));

  // Says what happened, in order and in full: the setup-link block above is
  // the precedent, and it says the previous link stopped working because
  // nothing else would tell anybody.
  expect(await screen.findByText(/2 sessions were revoked/i)).toBeInTheDocument();
  expect(screen.getByText(/must choose their own/i)).toBeInTheDocument();
});
```

`mockAccount` and `fetchMock` stand for whatever the file already uses; read the top of `AccountDetailPage.test.tsx` and reuse them.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run apps/web/src/pages/admin/AccountDetailPage.test.tsx`
Expected: FAIL — no "Set password" button.

- [ ] **Step 3: Implement**

Add state beside the existing `setupLink`:

```tsx
  /**
   * The set-password form, open or not, and its outcome.
   *
   * Held here rather than in a child for the same reason `setupLink` is: it
   * can only ever be about the account on screen, which is what lets the
   * result sentence name what happened to THIS account's sessions.
   */
  const [settingPassword, setSettingPassword] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [passwordDone, setPasswordDone] = useState<string | null>(null);
```

Add the button beside "Password link", under the same condition:

```tsx
              {data.passwordSource !== 'upstream' && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setPasswordDone(null);
                    setSettingPassword(true);
                  }}
                >
                  Set password
                </Button>
              )}
```

And the form, below the setup-link block:

```tsx
            {settingPassword && (
              <div className="rounded border border-border-subtle p-4">
                <h3 className="font-medium text-ink">Set a password</h3>
                <p className="mt-1 text-sm text-muted">
                  {/* The rule BEFORE they type, not after the server refuses.
                      A policy stated only in a rejection is a guessing game
                      played one round at a time. */}
                  At least 12 characters, and not the login or the email
                  address. Every session is revoked, and they must choose their
                  own password the next time they sign in.
                </p>
                <Field
                  label="New password"
                  type="password"
                  value={newPassword}
                  onChange={setNewPassword}
                />
                <div className="mt-3 flex gap-2">
                  <Button
                    size="sm"
                    loading={busy}
                    disabled={newPassword.length === 0}
                    onClick={() =>
                      void run(async () => {
                        try {
                          const result = await api<{ sessionsRevoked: number }>(
                            `/api/admin/users/${data.id}/password`,
                            {
                              method: 'POST',
                              body: JSON.stringify({ password: newPassword }),
                            },
                          );
                          setPasswordDone(
                            `Password set. ${result.sessionsRevoked} session${
                              result.sessionsRevoked === 1 ? ' was' : 's were'
                            } revoked, and they must choose their own the next time they sign in.`,
                          );
                          setSettingPassword(false);
                          // Cleared the moment it is spent. It is a credential
                          // and has no reason to sit in a React tree.
                          setNewPassword('');
                        } catch (cause) {
                          failed(cause, 'That password could not be set.');
                        }
                      })
                    }
                  >
                    Set it
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setSettingPassword(false);
                      setNewPassword('');
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}

            {passwordDone && <Alert tone="warning">{passwordDone}</Alert>}
```

The literal "12 characters" must match the tenant's `passwordMinLength` default. Read it from `packages/db/prisma/schema.prisma`'s `Tenant.passwordMinLength` and write whatever the default actually is; if the account detail response does not carry the tenant policy, say "at least the length your policy requires" rather than a number that can be wrong.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run apps/web/src/pages/admin/AccountDetailPage.test.tsx`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm typecheck
git add apps/web/src/pages/admin/AccountDetailPage.tsx apps/web/src/pages/admin/AccountDetailPage.test.tsx
git commit -m "feat(console): set an account's password from its own screen"
```

---

### Task 9: The org unit picked on the create form reaches the person

**Files:**
- Modify: `apps/web/src/pages/admin/AccountsTab.tsx`
- Test: `apps/web/src/pages/admin/AccountsTab.test.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing later tasks depend on. Task 14 edits the same form and must preserve this.

Note: this task shows the container hints. Linking the unit to the person needs a person, which arrives in Task 10 — the `PATCH /persons/:id` call that carries the unit is added there, and this task only adds the hint and the `orgUnitId` field on the account's own edit form.

- [ ] **Step 1: Write the failing tests**

```ts
it('shows where the account would land on each enabled target', async () => {
  mockBoth(users, [], {
    targets: [{ id: 't1', name: 'Corporate AD', enabled: true }],
  });
  render(<MemoryRouter><AccountsTab /></MemoryRouter>);
  await userEvent.click(await screen.findByRole('button', { name: 'New user' }));
  expect(await screen.findByText(/Corporate AD/)).toBeInTheDocument();
});
```

Extend `mockBoth` to accept and serve `/api/admin/targets` — read its current implementation and add the branch rather than writing a second helper.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run apps/web/src/pages/admin/AccountsTab.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add the targets read and the hints, mirroring `OnboardPersonPage:52-72`:

```tsx
  const { data: targetsData } = useApiResource<{
    targets: { id: string; name: string; enabled: boolean }[];
  }>('/api/admin/targets');
```

`useContainerHints` needs contract fields this form does not collect. Pass what it has and empty strings for the rest, and render the hint under the org-unit picker. Read `apps/web/src/pages/admin/use-container-hint.ts` for its exact input shape before writing the call — do not guess it.

The hint is shown and, unlike `OnboardPersonPage`, does **not** block submission. That page refuses a fallback placement because somebody is typing a department one keystroke away from correct. Here there is no department field to correct: the account's placement follows the person's unit, and refusing would leave the administrator with a form they cannot satisfy.

Add `orgUnitId` to the account's own edit form on `AccountDetailPage` too — the PATCH already accepts and validates it and only the UI is missing. That is a `Select` beside the existing display-name and email fields, options from `/api/admin/org-units`, with `''` sent as `null`.

- [ ] **Step 4: Run, typecheck, commit**

```bash
pnpm vitest run apps/web/src/pages/admin/AccountsTab.test.tsx apps/web/src/pages/admin/AccountDetailPage.test.tsx
pnpm typecheck
git add apps/web/src/pages/admin/AccountsTab.tsx apps/web/src/pages/admin/AccountsTab.test.tsx apps/web/src/pages/admin/AccountDetailPage.tsx
git commit -m "feat(console): show the container a new account would land in, and edit its org unit"
```

---

### Task 10: The person matcher

**Files:**
- Create: `packages/core/src/identity/person-match.ts`
- Create: `packages/core/src/identity/person-match.test.ts`
- Modify: `packages/core/src/index.ts` (add the export)

**Interfaces:**
- Consumes: nothing.
- Produces:

```ts
export type MatchRule = 'businessEmail' | 'personalEmail' | 'displayName';

export interface PersonCandidate {
  personId: string;
  givenName: string;
  familyName: string;
  rule: MatchRule;
  /** True when this person already has an active account. */
  hasActiveAccount: boolean;
}

export interface PersonMatch {
  confident: PersonCandidate | null;
  candidates: PersonCandidate[];
}

export async function matchPersonForAccount(
  tx: TenantClient,
  input: { email: string; displayName: string },
): Promise<PersonMatch>;
```

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/identity/person-match.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { createUser } from '../directory/user-service.js';
import { linkUserToPerson } from './person-service.js';
import { matchPersonForAccount } from './person-match.js';

let tenantId: string;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
});

const person = (data: Record<string, unknown>) =>
  withTenant(tenantId, (tx) =>
    tx.person.create({
      data: { tenantId, givenName: 'Maya', familyName: 'Okafor', ...data },
    }),
  );

describe('matchPersonForAccount', () => {
  it('is confident about a unique business-email match', async () => {
    const p = await person({ businessEmail: 'maya.okafor@acme.test' });
    const match = await withTenant(tenantId, (tx) =>
      matchPersonForAccount(tx, {
        // Case-insensitively: an address is not two addresses.
        email: 'Maya.Okafor@ACME.test',
        displayName: 'Unrelated Name',
      }),
    );
    expect(match.confident?.personId).toBe(p.id);
    expect(match.confident?.rule).toBe('businessEmail');
  });

  it('demotes an ambiguous business-email match to candidates', async () => {
    await person({ businessEmail: 'shared@acme.test', givenName: 'A' });
    await person({ businessEmail: 'shared@acme.test', givenName: 'B' });
    const match = await withTenant(tenantId, (tx) =>
      matchPersonForAccount(tx, { email: 'shared@acme.test', displayName: '' }),
    );
    // Picking the first would link an account to whichever row the planner
    // happened to return.
    expect(match.confident).toBeNull();
    expect(match.candidates).toHaveLength(2);
  });

  it('never auto-links on a personal email', async () => {
    await person({ personalEmail: 'maya@gmail.test' });
    const match = await withTenant(tenantId, (tx) =>
      matchPersonForAccount(tx, { email: 'maya@gmail.test', displayName: '' }),
    );
    expect(match.confident).toBeNull();
    expect(match.candidates[0]?.rule).toBe('personalEmail');
  });

  it('never auto-links on a name', async () => {
    await person({ givenName: 'Maya', familyName: 'Okafor' });
    const match = await withTenant(tenantId, (tx) =>
      matchPersonForAccount(tx, { email: 'nobody@acme.test', displayName: '  maya   okafor ' }),
    );
    expect(match.confident).toBeNull();
    expect(match.candidates[0]?.rule).toBe('displayName');
  });

  it('ignores inactive people', async () => {
    await person({ businessEmail: 'gone@acme.test', status: 'inactive' });
    const match = await withTenant(tenantId, (tx) =>
      matchPersonForAccount(tx, { email: 'gone@acme.test', displayName: '' }),
    );
    expect(match.confident).toBeNull();
    expect(match.candidates).toEqual([]);
  });

  it('returns nothing when nothing matches', async () => {
    await person({ businessEmail: 'someone@acme.test' });
    const match = await withTenant(tenantId, (tx) =>
      matchPersonForAccount(tx, { email: 'nobody@acme.test', displayName: 'No Body' }),
    );
    expect(match).toEqual({ confident: null, candidates: [] });
  });

  it('reports that a candidate already holds an active account', async () => {
    const p = await person({ businessEmail: 'taken@acme.test' });
    await withTenant(tenantId, async (tx) => {
      const u = await createUser(tx, {
        login: 'taken',
        email: 'taken-login@acme.test',
        displayName: 'T',
      });
      await linkUserToPerson(tx, u.id, p.id);
    });
    const match = await withTenant(tenantId, (tx) =>
      matchPersonForAccount(tx, { email: 'taken@acme.test', displayName: '' }),
    );
    // Still confident by rule; the caller decides what to do about the
    // existing account. Keeping the two facts separate is what lets the create
    // path demote it while the suggestion list still shows it.
    expect(match.confident?.hasActiveAccount).toBe(true);
  });

  it('does not see another tenant’s people', async () => {
    const other = await prisma.tenant.create({ data: { name: 'Other', slug: 'other' } });
    await withTenant(other.id, (tx) =>
      tx.person.create({
        data: { tenantId: other.id, givenName: 'Maya', familyName: 'Okafor', businessEmail: 'maya@acme.test' },
      }),
    );
    const match = await withTenant(tenantId, (tx) =>
      matchPersonForAccount(tx, { email: 'maya@acme.test', displayName: 'Maya Okafor' }),
    );
    expect(match).toEqual({ confident: null, candidates: [] });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/core/src/identity/person-match.test.ts`
Expected: FAIL to resolve `./person-match.js`.

- [ ] **Step 3: Implement**

Create `packages/core/src/identity/person-match.ts`:

```ts
import type { TenantClient } from '@syntra/db';

export type MatchRule = 'businessEmail' | 'personalEmail' | 'displayName';

export interface PersonCandidate {
  personId: string;
  givenName: string;
  familyName: string;
  rule: MatchRule;
  /**
   * Whether this person already signs in somewhere.
   *
   * Reported rather than acted on. The create path demotes a confident match
   * carrying it — auto-linking would silently produce the second account the
   * warning exists for — while the suggestion list still shows it, because an
   * administrator looking at an orphan may well be linking a contractor's
   * second account deliberately.
   */
  hasActiveAccount: boolean;
}

export interface PersonMatch {
  confident: PersonCandidate | null;
  candidates: PersonCandidate[];
}

const key = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Which person, if any, this account belongs to.
 *
 * Distinct from `sync/correlate.ts`, which answers a different question:
 * correlation resolves a DIRECTORY OBJECT to a `User`, and this resolves a
 * `User` to a `Person`. They are not two implementations of one idea and are
 * deliberately not shared.
 *
 * Exactly one rule is strong enough to act on unasked. A business email is an
 * address the organization issued and controls, so a unique match on it is a
 * statement by the organization about who somebody is. A personal address is a
 * guess about somebody's private life, and two people share a name often
 * enough that treating a name match as an answer would eventually link a
 * joiner's account to their namesake's record — with the group memberships,
 * entitlements and claim mappings that follow from it.
 *
 * Ambiguity always demotes. Two rows matching the strong rule is not a strong
 * match; it is a data problem, and picking the first would resolve it by
 * whichever order the query planner chose that afternoon.
 *
 * No match returns nothing and says nothing. Silence is the default, because
 * the population this runs over includes every service account Syntra will
 * ever hold, and a suggestion on each of them would train people to dismiss
 * the control.
 */
export async function matchPersonForAccount(
  tx: TenantClient,
  input: { email: string; displayName: string },
): Promise<PersonMatch> {
  const email = key(input.email);
  const name = key(input.displayName);

  const people = await tx.person.findMany({
    where: { status: 'active' },
    select: {
      id: true,
      givenName: true,
      familyName: true,
      businessEmail: true,
      personalEmail: true,
    },
  });

  // One query for the whole set rather than one per candidate: the candidate
  // list is short, but a person with several accounts would otherwise be read
  // once per account.
  const withAccounts = new Set(
    (
      await tx.user.findMany({
        where: { status: 'active', personId: { not: null } },
        select: { personId: true },
      })
    ).map((row) => row.personId!),
  );

  const build = (
    person: (typeof people)[number],
    rule: MatchRule,
  ): PersonCandidate => ({
    personId: person.id,
    givenName: person.givenName,
    familyName: person.familyName,
    rule,
    hasActiveAccount: withAccounts.has(person.id),
  });

  const byBusiness = email
    ? people.filter((p) => p.businessEmail && key(p.businessEmail) === email)
    : [];
  const byPersonal = email
    ? people.filter((p) => p.personalEmail && key(p.personalEmail) === email)
    : [];
  const byName = name
    ? people.filter((p) => key(`${p.givenName} ${p.familyName}`) === name)
    : [];

  if (byBusiness.length === 1) {
    return { confident: build(byBusiness[0]!, 'businessEmail'), candidates: [] };
  }

  // Deduplicated by person, keeping the strongest rule that matched them: a
  // person whose business AND personal address are the same string should
  // appear once, described by the better reason.
  const seen = new Map<string, PersonCandidate>();
  for (const [rule, rows] of [
    ['businessEmail', byBusiness],
    ['personalEmail', byPersonal],
    ['displayName', byName],
  ] as const) {
    for (const person of rows) {
      if (!seen.has(person.id)) seen.set(person.id, build(person, rule));
    }
  }

  return { confident: null, candidates: [...seen.values()] };
}
```

Add `export * from './identity/person-match.js';` to `packages/core/src/index.ts` beside the `person-service` export.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run packages/core/src/identity/person-match.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm typecheck
git add packages/core/src/identity/person-match.ts packages/core/src/identity/person-match.test.ts packages/core/src/index.ts
git commit -m "feat(identity): match an account to a person, confidently only on a business email"
```

---

### Task 11: `POST /users` links, auto-links, and warns

**Files:**
- Modify: `packages/contracts/src/directory.ts` (`createUserRequest`)
- Modify: `apps/api/src/routes/admin/users.ts` (`POST /users`)
- Test: `apps/api/src/routes/admin/users.test.ts`

**Interfaces:**
- Consumes: `matchPersonForAccount` (Task 10), `linkUserToPerson` (existing).
- Produces: `POST /users` accepts `personId?: string | null` and `allowSecondAccount?: boolean`; answers 409 slug `second-account` with extension members `existingAccount: { id, login }`.

- [ ] **Step 1: Widen the schema**

```ts
export const createUserRequest = z.object({
  login: z.string().min(1).max(256),
  email: z.string().email(),
  displayName: z.string().min(1).max(256),
  orgUnitId: z.string().uuid().optional(),
  /**
   * Three states, and they are three different requests.
   *
   * A uuid links to that person. `null` says "service account" and suppresses
   * matching entirely. OMITTED runs the matcher and links on a confident
   * result — which is why this is `.optional()` as well as `.nullable()`, and
   * why the route must distinguish `undefined` from `null` rather than
   * collapsing them the way most of these schemas do.
   */
  personId: z.string().uuid().nullable().optional(),
  /** Confirms a second account for a person who already has one. */
  allowSecondAccount: z.boolean().optional(),
});
```

- [ ] **Step 2: Write the failing tests**

```ts
it('links to the person it was given', async () => {
  const cookie = await signInAs([PERMISSIONS.DIRECTORY_WRITE, PERMISSIONS.IDENTITY_WRITE, PERMISSIONS.IDENTITY_READ]);
  const person = await ctx.app.inject({
    method: 'POST', url: '/api/admin/persons', headers: { cookie },
    payload: { givenName: 'Maya', familyName: 'Okafor' },
  });
  const res = await ctx.app.inject({
    method: 'POST', url: '/api/admin/users', headers: { cookie },
    payload: { login: 'mokafor', email: 'm@acme.test', displayName: 'Maya Okafor', personId: person.json().id },
  });
  expect(res.statusCode).toBe(201);
  const detail = await ctx.app.inject({
    method: 'GET', url: `/api/admin/users/${res.json().id}`, headers: { cookie },
  });
  expect(detail.json().person.id).toBe(person.json().id);
});

it('auto-links on a unique business email when no person was named', async () => {
  const cookie = await signInAs([PERMISSIONS.DIRECTORY_WRITE, PERMISSIONS.IDENTITY_WRITE, PERMISSIONS.IDENTITY_READ]);
  const person = await ctx.app.inject({
    method: 'POST', url: '/api/admin/persons', headers: { cookie },
    payload: { givenName: 'Maya', familyName: 'Okafor', businessEmail: 'maya@acme.test' },
  });
  const res = await ctx.app.inject({
    method: 'POST', url: '/api/admin/users', headers: { cookie },
    payload: { login: 'mokafor', email: 'maya@acme.test', displayName: 'Maya Okafor' },
  });
  const detail = await ctx.app.inject({
    method: 'GET', url: `/api/admin/users/${res.json().id}`, headers: { cookie },
  });
  expect(detail.json().person.id).toBe(person.json().id);
});

it('does not auto-link when the caller said service account', async () => {
  const cookie = await signInAs([PERMISSIONS.DIRECTORY_WRITE, PERMISSIONS.IDENTITY_WRITE, PERMISSIONS.IDENTITY_READ]);
  await ctx.app.inject({
    method: 'POST', url: '/api/admin/persons', headers: { cookie },
    payload: { givenName: 'Maya', familyName: 'Okafor', businessEmail: 'maya@acme.test' },
  });
  const res = await ctx.app.inject({
    method: 'POST', url: '/api/admin/users', headers: { cookie },
    payload: { login: 'svc', email: 'maya@acme.test', displayName: 'Service', personId: null },
  });
  const detail = await ctx.app.inject({
    method: 'GET', url: `/api/admin/users/${res.json().id}`, headers: { cookie },
  });
  expect(detail.json().person).toBeNull();
});

it('warns before giving one person a second account, and is confirmable', async () => {
  const cookie = await signInAs([PERMISSIONS.DIRECTORY_WRITE, PERMISSIONS.IDENTITY_WRITE, PERMISSIONS.IDENTITY_READ]);
  const person = await ctx.app.inject({
    method: 'POST', url: '/api/admin/persons', headers: { cookie },
    payload: { givenName: 'Kaycen', familyName: 'Tyre' },
  });
  const id = person.json().id;
  await ctx.app.inject({
    method: 'POST', url: '/api/admin/users', headers: { cookie },
    payload: { login: 'ktyre', email: 'k@acme.test', displayName: 'K', personId: id },
  });

  const warned = await ctx.app.inject({
    method: 'POST', url: '/api/admin/users', headers: { cookie },
    payload: { login: 'ktyre-admin', email: 'k2@acme.test', displayName: 'K admin', personId: id },
  });
  expect(warned.statusCode).toBe(409);
  expect(warned.json().type).toMatch(/second-account/);
  expect(warned.json().existingAccount.login).toBe('ktyre');

  const confirmed = await ctx.app.inject({
    method: 'POST', url: '/api/admin/users', headers: { cookie },
    payload: {
      login: 'ktyre-admin', email: 'k2@acme.test', displayName: 'K admin',
      personId: id, allowSecondAccount: true,
    },
  });
  expect(confirmed.statusCode).toBe(201);
});

it('does not auto-link to a person who already has an account', async () => {
  const cookie = await signInAs([PERMISSIONS.DIRECTORY_WRITE, PERMISSIONS.IDENTITY_WRITE, PERMISSIONS.IDENTITY_READ]);
  const person = await ctx.app.inject({
    method: 'POST', url: '/api/admin/persons', headers: { cookie },
    payload: { givenName: 'Maya', familyName: 'Okafor', businessEmail: 'maya@acme.test' },
  });
  await ctx.app.inject({
    method: 'POST', url: '/api/admin/users', headers: { cookie },
    payload: { login: 'mokafor', email: 'first@acme.test', displayName: 'M', personId: person.json().id },
  });

  // Same business email, no personId. Auto-linking would silently create the
  // second account the warning above exists for.
  const res = await ctx.app.inject({
    method: 'POST', url: '/api/admin/users', headers: { cookie },
    payload: { login: 'mokafor2', email: 'maya@acme.test', displayName: 'M' },
  });
  expect(res.statusCode).toBe(201);
  const detail = await ctx.app.inject({
    method: 'GET', url: `/api/admin/users/${res.json().id}`, headers: { cookie },
  });
  expect(detail.json().person).toBeNull();
});

it('403s an explicit personId without identity.write', async () => {
  const cookie = await signInAs([PERMISSIONS.DIRECTORY_WRITE]);
  const res = await ctx.app.inject({
    method: 'POST', url: '/api/admin/users', headers: { cookie },
    payload: { login: 'x', email: 'x@acme.test', displayName: 'X', personId: crypto.randomUUID() },
  });
  expect(res.statusCode).toBe(403);
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm vitest run apps/api/src/routes/admin/users.test.ts`
Expected: the linking tests FAIL — `personId` is ignored.

- [ ] **Step 4: Implement**

Replace the body of the `POST /users` handler's transaction. `hasPermission` stands for however the route file already reads a session's permissions — find it (`request.session` carries them; see `requirePermission`) and use that.

```ts
      const body = createUserRequest.parse(request.body);
      // Linking writes to a Person, which is `identity.write`. A caller who
      // may create accounts but not touch people gets a 403 for an explicit
      // person, and has the matcher skipped entirely — a convenience feature
      // does not get to step over a permission boundary.
      const mayLink = request.session.permissions.includes(PERMISSIONS.IDENTITY_WRITE);
      if (body.personId && !mayLink) {
        throw new ProblemError(
          403,
          'forbidden',
          'Forbidden',
          'Linking an account to a person needs identity.write.',
        );
      }

      const user = await request.db(async (tx) => {
        let personId: string | null = body.personId ?? null;

        if (body.personId) {
          const person = await tx.person.findUnique({ where: { id: body.personId } });
          if (!person) throw new ProblemError(404, 'not-found', 'Person not found');

          if (!body.allowSecondAccount) {
            // Active only. Replacing a leaver's account is not a duplicate.
            const existing = await tx.user.findFirst({
              where: { personId: body.personId, status: 'active' },
              select: { id: true, login: true },
            });
            if (existing) {
              throw new ProblemError(
                409,
                'second-account',
                'They already have an account',
                `${person.givenName} ${person.familyName} already signs in as ${existing.login}. A contractor with two contracts legitimately has two accounts — confirm to create this one as well.`,
                { existingAccount: existing },
              );
            }
          }
        } else if (body.personId === undefined && mayLink) {
          // Omitted, not null: null is somebody saying "service account", and
          // matching one would be answering a question they already answered.
          const match = await matchPersonForAccount(tx, {
            email: body.email,
            displayName: body.displayName,
          });
          // A confident match who already signs in somewhere is demoted here
          // rather than in the matcher: auto-linking it would produce the
          // second account the warning above exists for, without the warning.
          // It still surfaces as a suggestion on the account's own screen.
          if (match.confident && !match.confident.hasActiveAccount) {
            personId = match.confident.personId;
          }
        }

        let created;
        try {
          created = await createUser(tx, body);
        } catch (error) {
          if (
            error instanceof Error &&
            /(login already exists|email already in use)/i.test(error.message)
          ) {
            throw new ProblemError(409, 'conflict', 'Conflict', error.message);
          }
          throw error;
        }

        if (personId) {
          await linkUserToPerson(tx, created.id, personId);
          if (!body.personId) {
            // Named, and never silent. An administrator who wonders why an
            // account has a person can read which rule decided it.
            await recordEvent(tx, {
              actorUserId: request.session.userId,
              action: 'user.autolinked',
              targetType: 'User',
              targetId: created.id,
              outcome: 'success',
              sourceIp: request.ip,
              payload: { personId, rule: 'businessEmail' },
            });
          }
        }

        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'user.create',
          targetType: 'User',
          targetId: created.id,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { login: created.login, email: created.email, personId },
        });
        return created;
      });
```

`createUser` receives `body`, which now carries `personId` and `allowSecondAccount`. `CreateUserInput` names only four fields so the extras are ignored by TypeScript's structural check on a variable — but pass the four explicitly rather than relying on that:

```ts
          created = await createUser(tx, {
            login: body.login,
            email: body.email,
            displayName: body.displayName,
            ...(body.orgUnitId ? { orgUnitId: body.orgUnitId } : {}),
          });
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm vitest run apps/api/src/routes/admin/users.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm typecheck
git add apps/api/src/routes/admin/users.ts packages/contracts/src/directory.ts apps/api/src/routes/admin/users.test.ts
git commit -m "feat(api): POST /users links to a person, auto-links on a confident match, warns on a second account"
```

---

### Task 12: The duplicate-person warning

**Files:**
- Modify: `packages/contracts/src/identity.ts` (`createPersonRequest`)
- Modify: `apps/api/src/routes/admin/persons.ts` (`POST /persons` at `:46`)
- Test: `apps/api/src/routes/admin/persons.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `POST /persons` accepts `allowDuplicate?: boolean`; answers 409 slug `possible-duplicate` with extension member `candidates: { id, givenName, familyName, businessEmail }[]`.

- [ ] **Step 1: Widen the schema**

```ts
export const createPersonRequest = z.object({
  givenName: z.string().min(1).max(128),
  familyName: z.string().min(1).max(128),
  businessEmail: z.string().email().optional(),
  personalEmail: z.string().email().optional(),
  externalId: z.string().max(128).optional(),
  /**
   * Confirms a person who looks like somebody already here.
   *
   * A warning rather than a refusal, because two real people do share a name
   * and the alternative to creating the second one is not creating them at
   * all.
   */
  allowDuplicate: z.boolean().optional(),
});
```

- [ ] **Step 2: Write the failing tests**

```ts
it('warns about a person who looks like one already here', async () => {
  const cookie = await signInAs([PERMISSIONS.IDENTITY_WRITE, PERMISSIONS.IDENTITY_READ]);
  await ctx.app.inject({
    method: 'POST', url: '/api/admin/persons', headers: { cookie },
    payload: { givenName: 'Maya', familyName: 'Okafor' },
  });
  const res = await ctx.app.inject({
    method: 'POST', url: '/api/admin/persons', headers: { cookie },
    payload: { givenName: 'maya', familyName: 'OKAFOR' },
  });
  expect(res.statusCode).toBe(409);
  expect(res.json().type).toMatch(/possible-duplicate/);
  expect(res.json().candidates).toHaveLength(1);
});

it('warns on a shared business email under a different name', async () => {
  const cookie = await signInAs([PERMISSIONS.IDENTITY_WRITE, PERMISSIONS.IDENTITY_READ]);
  await ctx.app.inject({
    method: 'POST', url: '/api/admin/persons', headers: { cookie },
    payload: { givenName: 'Maya', familyName: 'Okafor', businessEmail: 'm@acme.test' },
  });
  const res = await ctx.app.inject({
    method: 'POST', url: '/api/admin/persons', headers: { cookie },
    payload: { givenName: 'Different', familyName: 'Name', businessEmail: 'M@acme.test' },
  });
  expect(res.statusCode).toBe(409);
});

it('creates anyway when confirmed', async () => {
  const cookie = await signInAs([PERMISSIONS.IDENTITY_WRITE, PERMISSIONS.IDENTITY_READ]);
  await ctx.app.inject({
    method: 'POST', url: '/api/admin/persons', headers: { cookie },
    payload: { givenName: 'Maya', familyName: 'Okafor' },
  });
  const res = await ctx.app.inject({
    method: 'POST', url: '/api/admin/persons', headers: { cookie },
    payload: { givenName: 'Maya', familyName: 'Okafor', allowDuplicate: true },
  });
  expect(res.statusCode).toBe(201);
});

it('does not warn about an inactive namesake', async () => {
  const cookie = await signInAs([PERMISSIONS.IDENTITY_WRITE, PERMISSIONS.IDENTITY_READ]);
  const first = await ctx.app.inject({
    method: 'POST', url: '/api/admin/persons', headers: { cookie },
    payload: { givenName: 'Maya', familyName: 'Okafor' },
  });
  await ctx.app.inject({
    method: 'POST', url: `/api/admin/persons/${first.json().id}/deactivate`,
    headers: { cookie }, payload: {},
  });
  const res = await ctx.app.inject({
    method: 'POST', url: '/api/admin/persons', headers: { cookie },
    payload: { givenName: 'Maya', familyName: 'Okafor' },
  });
  expect(res.statusCode).toBe(201);
});
```

Check the deactivate route's real path and payload in `persons.ts` before writing that last test; if it needs a reason, supply one.

- [ ] **Step 3: Run to verify failure**

Run: `pnpm vitest run apps/api/src/routes/admin/persons.test.ts`
Expected: the warning tests FAIL with 201.

- [ ] **Step 4: Implement**

At the top of the `POST /persons` transaction, before the create:

```ts
        if (!body.allowDuplicate) {
          // Active only, and both rules at once. A leaver's record is not a
          // reason to refuse their replacement, and a namesake who left last
          // year is exactly the kind of false alarm that teaches people to
          // click through a warning without reading it.
          const candidates = await tx.person.findMany({
            where: {
              status: 'active',
              OR: [
                {
                  givenName: { equals: body.givenName.trim(), mode: 'insensitive' },
                  familyName: { equals: body.familyName.trim(), mode: 'insensitive' },
                },
                ...(body.businessEmail
                  ? [{ businessEmail: { equals: body.businessEmail, mode: 'insensitive' as const } }]
                  : []),
              ],
            },
            select: { id: true, givenName: true, familyName: true, businessEmail: true },
            take: 5,
          });
          if (candidates.length > 0) {
            throw new ProblemError(
              409,
              'possible-duplicate',
              'Somebody here already looks like this',
              'Check whether this is the same person before creating a second record — there is no way to merge two afterwards.',
              { candidates },
            );
          }
        }
```

The `take: 5` is not arbitrary: the form lists the candidates, and an unbounded list on a common name would be a page of links nobody reads.

- [ ] **Step 5: Run, typecheck, commit**

```bash
pnpm vitest run apps/api/src/routes/admin/persons.test.ts
pnpm typecheck
git add packages/contracts/src/identity.ts apps/api/src/routes/admin/persons.ts apps/api/src/routes/admin/persons.test.ts
git commit -m "feat(api): warn before creating a person who looks like one already here"
```

---

### Task 13: `RecordPanel` learns a confirmable refusal

**Files:**
- Modify: `apps/web/src/pages/admin/RecordPanel.tsx`
- Test: `apps/web/src/pages/admin/RecordPanel.test.tsx` (create if absent)

**Interfaces:**
- Consumes: nothing.
- Produces: a new optional prop —

```tsx
confirmable?(problem: Problem): { message: ReactNode; retryWith: Record<string, unknown> } | null;
```

Returning a descriptor renders the message with a Continue button that re-posts `{ ...build(values), ...retryWith }`. Returning `null` falls through to the ordinary error banner. Used by Task 14 and Task 15.

- [ ] **Step 1: Write the failing test**

```tsx
it('turns a confirmable refusal into a Continue button, and re-posts with the flag', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ type: 'about:blank/second-account', title: 'They already have an account', status: 409 }),
        { status: 409, headers: { 'content-type': 'application/problem+json' } },
      ),
    )
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'u1' }), { status: 201 }));
  vi.stubGlobal('fetch', fetchMock);
  const onCreated = vi.fn();

  render(
    <RecordPanel
      title="New user"
      submitLabel="New user"
      path="/api/admin/users"
      onCreated={onCreated}
      build={() => ({ login: 'x' })}
      confirmable={(problem) =>
        problem.type.endsWith('second-account')
          ? { message: 'They already have an account.', retryWith: { allowSecondAccount: true } }
          : null
      }
      fields={() => <></>}
    />,
  );

  await userEvent.click(screen.getByRole('button', { name: 'New user' }));
  await userEvent.click(screen.getByRole('button', { name: 'New user' }));

  expect(await screen.findByText('They already have an account.')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

  await waitFor(() => expect(onCreated).toHaveBeenCalled());
  expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toMatchObject({
    login: 'x',
    allowSecondAccount: true,
  });
});
```

Read `apps/web/src/session/api.ts` to confirm how a problem response becomes an `ApiError`, and shape the mocked response to match exactly — content type included.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run apps/web/src/pages/admin/RecordPanel.test.tsx`
Expected: FAIL — the prop does not exist and the error lands in the banner.

- [ ] **Step 3: Implement**

Add the prop to the destructuring and the type block:

```tsx
  /**
   * Turns a rejected submit into a question rather than an error.
   *
   * Two refusals in this console are warnings and not verdicts: a second
   * account for one person, and a person who looks like one already here.
   * Both are legitimate often enough that refusing outright would be wrong,
   * and both are mistakes often enough that creating silently would be worse.
   *
   * It lives here rather than in the two forms because the alternative is two
   * implementations of "show the refusal, keep what they typed, re-post with a
   * flag" — and the shape of every bug in this file has been two copies of one
   * behaviour drifting apart.
   *
   * Returning null falls through to the ordinary error banner, so a form can
   * claim one problem type and leave the rest alone.
   */
  confirmable?(problem: Problem): {
    message: ReactNode;
    retryWith: Record<string, unknown>;
  } | null;
```

Add state and rework `submit` to take the extra body:

```tsx
  const [pending, setPending] = useState<{
    message: ReactNode;
    retryWith: Record<string, unknown>;
  } | null>(null);

  async function submit(extra: Record<string, unknown> = {}) {
    setBusy(true);
    setProblem(null);
    setErrors({});
    setPending(null);
    try {
      await api(path, {
        method,
        body: JSON.stringify({ ...(build(values) as object), ...extra }),
      });
      close();
      onCreated();
    } catch (cause) {
      if (cause instanceof ApiError) {
        const ask = confirmable?.(cause.problem) ?? null;
        if (ask) {
          // Deliberately NOT auto-retrying, and deliberately keeping the
          // typed values: the whole point is that somebody reads the warning
          // and decides. A confirmation that resubmits what it just refused
          // without being asked is a 409 spelled slowly.
          setPending(ask);
          setBusy(false);
          return;
        }
      }
      const marked = fieldErrors(cause);
      setErrors(marked);
      if (Object.keys(marked).length > 0) {
        setProblem(null);
      } else if (cause instanceof ApiError) {
        setProblem(cause.problem.detail ?? cause.problem.title);
      } else {
        setProblem('That could not be saved.');
      }
    } finally {
      setBusy(false);
    }
  }
```

Add `setPending(null)` to `close()`. Render the block above the form's buttons:

```tsx
        {pending && (
          <Alert tone="warning" title="Check this first">
            <div className="space-y-3">
              <div>{pending.message}</div>
              <div className="flex gap-2">
                <Button size="sm" loading={busy} onClick={() => void submit(pending.retryWith)}>
                  Continue
                </Button>
                <Button size="sm" variant="secondary" onClick={close}>
                  Cancel
                </Button>
              </div>
            </div>
          </Alert>
        )}
```

The form's own submit button calls `submit()` with no argument. Confirm `Alert` accepts children and a `title`; if it does not, render the heading as plain markup inside it.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm vitest run apps/web/src/pages/admin/RecordPanel.test.tsx`
Expected: PASS. Then run the whole admin page suite — `RecordPanel` has eight consumers:

Run: `pnpm vitest run apps/web/src/pages/admin`
Expected: PASS, unchanged.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm typecheck
git add apps/web/src/pages/admin/RecordPanel.tsx apps/web/src/pages/admin/RecordPanel.test.tsx
git commit -m "feat(console): RecordPanel can turn a refusal into a confirmable warning"
```

---

### Task 14: The create form picks a person, and both warnings are confirmable

**Files:**
- Modify: `apps/web/src/pages/admin/AccountsTab.tsx`
- Modify: `apps/web/src/pages/admin/PeopleTab.tsx`
- Test: `apps/web/src/pages/admin/AccountsTab.test.tsx`, `apps/web/src/pages/admin/PeopleTab.test.tsx`

**Interfaces:**
- Consumes: `confirmable` (Task 13), the `personId` states (Task 11), `allowDuplicate` (Task 12).

- [ ] **Step 1: Write the failing tests**

```tsx
// AccountsTab.test.tsx
it('offers a person, and service account as an explicit choice', async () => {
  mockBoth(users, [], { persons: [{ id: 'p1', givenName: 'Maya', familyName: 'Okafor', status: 'active' }] });
  render(<MemoryRouter><AccountsTab /></MemoryRouter>);
  await userEvent.click(await screen.findByRole('button', { name: 'New user' }));

  const picker = await screen.findByLabelText('Person');
  expect(within(picker).getByRole('option', { name: /service account/i })).toBeInTheDocument();
  expect(within(picker).getByRole('option', { name: /Maya Okafor/ })).toBeInTheDocument();
});

it('confirms a second account for one person', async () => {
  mockBoth(users, [], {
    persons: [{ id: 'p1', givenName: 'Maya', familyName: 'Okafor', status: 'active' }],
  });
  render(<MemoryRouter><AccountsTab /></MemoryRouter>);
  await userEvent.click(await screen.findByRole('button', { name: 'New user' }));
  await userEvent.type(screen.getByLabelText('Login'), 'mokafor2');
  await userEvent.type(screen.getByLabelText('Email'), 'm2@acme.test');
  await userEvent.selectOptions(screen.getByLabelText('Person'), 'p1');

  const problem = {
    type: 'about:blank/second-account',
    title: 'They already have an account',
    status: 409,
    detail: 'Maya Okafor already signs in as mokafor. A contractor with two contracts legitimately has two accounts — confirm to create this one as well.',
    existingAccount: { id: 'u9', login: 'mokafor' },
  };
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify(problem), {
      status: 409,
      headers: { 'content-type': 'application/problem+json' },
    }),
  );
  await userEvent.click(screen.getByRole('button', { name: 'New user' }));

  // The EXISTING login is named. "They already have an account" without
  // saying which one leaves the reader unable to answer the question.
  expect(await screen.findByText(/already signs in as mokafor/)).toBeInTheDocument();

  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ id: 'u10' }), { status: 201 }),
  );
  await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

  await waitFor(() => {
    const last = fetchMock.mock.calls.at(-1)!;
    expect(JSON.parse(last[1].body)).toMatchObject({
      login: 'mokafor2',
      personId: 'p1',
      allowSecondAccount: true,
    });
  });
});
```

`mockBoth` currently serves the users and sources reads. Extend it to serve
`/api/admin/persons` and `/api/admin/targets` from its third argument, and to
expose the underlying `vi.fn()` as `fetchMock` so a test can queue a response
for the POST. Read its current implementation first and widen it in place —
a second helper beside it is how the two drift.

And the mirror in `PeopleTab.test.tsx`:

```tsx
it('warns about a possible duplicate, listing who it means', async () => {
  mockPersons([]);
  render(<MemoryRouter><PeopleTab /></MemoryRouter>);
  await userEvent.click(await screen.findByRole('button', { name: 'New person' }));
  await userEvent.type(screen.getByLabelText('Given name'), 'Maya');
  await userEvent.type(screen.getByLabelText('Family name'), 'Okafor');

  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        type: 'about:blank/possible-duplicate',
        title: 'Somebody here already looks like this',
        status: 409,
        detail: 'Check whether this is the same person before creating a second record — there is no way to merge two afterwards.',
        candidates: [
          { id: 'p1', givenName: 'Maya', familyName: 'Okafor', businessEmail: 'maya@acme.test' },
        ],
      }),
      { status: 409, headers: { 'content-type': 'application/problem+json' } },
    ),
  );
  await userEvent.click(screen.getByRole('button', { name: 'New person' }));

  // A LINK, not just a name: the reader has to be able to go and look.
  const link = await screen.findByRole('link', { name: /Maya Okafor/ });
  expect(link).toHaveAttribute('href', '/admin/people/p1');

  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ id: 'p2' }), { status: 201 }),
  );
  await userEvent.click(screen.getByRole('button', { name: 'Continue' }));

  await waitFor(() => {
    const last = fetchMock.mock.calls.at(-1)!;
    expect(JSON.parse(last[1].body)).toMatchObject({
      givenName: 'Maya',
      allowDuplicate: true,
    });
  });
});
```

`mockPersons` stands for whatever `PeopleTab.test.tsx` already uses to serve
`/api/admin/persons`; reuse it and expose its `fetchMock` the same way.
The button labels — 'New person', 'Given name', 'Family name' — must match
what `PeopleTab.tsx` actually renders. Read it before writing the test.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run apps/web/src/pages/admin/AccountsTab.test.tsx apps/web/src/pages/admin/PeopleTab.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement the picker in `AccountsTab`**

Read the people list alongside the units and sources already read:

```tsx
  // For the person picker. Its error state is tolerated like the sources
  // read above: a caller who may create accounts but not read people gets a
  // picker holding only "service account", and a form that still works.
  const { data: personsData } = useApiResource<{
    persons: { id: string; givenName: string; familyName: string; status: string }[];
  }>('/api/admin/persons');
```

Add the field, and extend `build`:

```tsx
            <Select
              label="Person"
              value={v.personId ?? ''}
              onChange={(x) => set('personId', x)}
              error={errs.personId}
              options={[
                // The blank is "work it out", not "nothing". An account whose
                // email matches exactly one person's business address gets
                // linked; anything less certain is left alone and suggested on
                // the account's own screen afterwards.
                { value: '', label: 'Match by email' },
                { value: 'none', label: 'No person — service account' },
                ...(personsData?.persons ?? [])
                  .filter((p) => p.status === 'active')
                  .map((p) => ({
                    value: p.id,
                    label: `${p.givenName} ${p.familyName}`,
                  })),
              ]}
            />
```

```tsx
        build={(v) => ({
          login: v.login ?? '',
          email: v.email ?? '',
          displayName: v.displayName?.trim() ? v.displayName : (v.login ?? ''),
          ...(v.orgUnitId ? { orgUnitId: v.orgUnitId } : {}),
          // Three states, sent as three different bodies. `'none'` becomes a
          // literal null because that is what says "service account" to the
          // API; the empty string is OMITTED, which is what asks it to match.
          ...(v.personId === 'none'
            ? { personId: null }
            : v.personId
              ? { personId: v.personId }
              : {}),
        })}
        confirmable={(problem) =>
          problem.type.endsWith('second-account')
            ? {
                message: problem.detail ?? problem.title,
                retryWith: { allowSecondAccount: true },
              }
            : null
        }
```

The `NO PASSWORD FIELD` comment block below the panel stays exactly as it is; nothing in this task changes what it says.

- [ ] **Step 4: Implement the warning in `PeopleTab`**

On its create `RecordPanel`:

```tsx
        confirmable={(problem) => {
          if (!problem.type.endsWith('possible-duplicate')) return null;
          const candidates = (problem.candidates ?? []) as {
            id: string;
            givenName: string;
            familyName: string;
            businessEmail: string | null;
          }[];
          return {
            retryWith: { allowDuplicate: true },
            // The candidates are LINKS. A warning that says somebody similar
            // exists and does not let you go and look at them leaves the
            // reader to search for a name they have already typed once.
            message: (
              <>
                <p>{problem.detail ?? problem.title}</p>
                <ul className="mt-2 space-y-1">
                  {candidates.map((c) => (
                    <li key={c.id}>
                      <Link
                        to={`/admin/people/${c.id}`}
                        className="text-ink underline-offset-2 hover:text-primary hover:underline"
                      >
                        {c.givenName} {c.familyName}
                      </Link>
                      {c.businessEmail && (
                        <span className="text-muted"> — {c.businessEmail}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            ),
          };
        }}
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm vitest run apps/web/src/pages/admin`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

```bash
pnpm typecheck
git add apps/web/src/pages/admin/AccountsTab.tsx apps/web/src/pages/admin/PeopleTab.tsx apps/web/src/pages/admin/AccountsTab.test.tsx apps/web/src/pages/admin/PeopleTab.test.tsx
git commit -m "feat(console): pick a person when creating an account, and confirm both duplicate warnings"
```

---

### Task 15: Suggestions on an unlinked account

**Files:**
- Modify: `apps/api/src/routes/admin/users.ts`
- Modify: `apps/web/src/pages/admin/AccountDetailPage.tsx`
- Test: `apps/api/src/routes/admin/users.test.ts`, `apps/web/src/pages/admin/AccountDetailPage.test.tsx`

**Interfaces:**
- Consumes: `matchPersonForAccount` (Task 10).
- Produces: `GET /api/admin/users/:id/person-candidates` under `identity.read`, returning `{ candidates: PersonCandidate[] }`. Task 16 reuses the same shape.

- [ ] **Step 1: Write the failing tests**

```ts
// users.test.ts
it('suggests people for an unlinked account', async () => {
  const cookie = await signInAs([
    PERMISSIONS.DIRECTORY_WRITE, PERMISSIONS.IDENTITY_WRITE, PERMISSIONS.IDENTITY_READ,
  ]);
  await ctx.app.inject({
    method: 'POST', url: '/api/admin/persons', headers: { cookie },
    payload: { givenName: 'Maya', familyName: 'Okafor', personalEmail: 'maya@gmail.test' },
  });
  const user = await ctx.app.inject({
    method: 'POST', url: '/api/admin/users', headers: { cookie },
    payload: { login: 'm', email: 'maya@gmail.test', displayName: 'M', personId: null },
  });

  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/admin/users/${user.json().id}/person-candidates`,
    headers: { cookie },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().candidates[0].rule).toBe('personalEmail');
});

it('suggests nothing for an account that already has a person', async () => {
  const cookie = await signInAs([
    PERMISSIONS.DIRECTORY_WRITE, PERMISSIONS.IDENTITY_WRITE, PERMISSIONS.IDENTITY_READ,
  ]);
  const person = await ctx.app.inject({
    method: 'POST', url: '/api/admin/persons', headers: { cookie },
    payload: { givenName: 'Maya', familyName: 'Okafor', personalEmail: 'maya@gmail.test' },
  });
  const user = await ctx.app.inject({
    method: 'POST', url: '/api/admin/users', headers: { cookie },
    payload: {
      login: 'm', email: 'maya@gmail.test', displayName: 'M',
      personId: person.json().id,
    },
  });

  const res = await ctx.app.inject({
    method: 'GET',
    url: `/api/admin/users/${user.json().id}/person-candidates`,
    headers: { cookie },
  });

  // An empty list rather than a 409. The caller is a screen deciding whether
  // to render a control, and a refusal it has to catch is a worse contract
  // than nothing to show.
  expect(res.statusCode).toBe(200);
  expect(res.json().candidates).toEqual([]);
});
```

```tsx
// AccountDetailPage.test.tsx
it('offers a suggested person on an unlinked account', async () => {
  mockAccount({ person: null });
  mockCandidates([
    { personId: 'p1', givenName: 'Maya', familyName: 'Okafor', rule: 'personalEmail', hasActiveAccount: false },
  ]);
  render(<MemoryRouter initialEntries={['/admin/users/u1']}><AccountDetailPage /></MemoryRouter>);
  expect(await screen.findByRole('button', { name: /link Maya Okafor/i })).toBeInTheDocument();
});

it('says only "Not linked" when nothing matches', async () => {
  mockAccount({ person: null });
  mockCandidates([]);
  render(<MemoryRouter initialEntries={['/admin/users/u1']}><AccountDetailPage /></MemoryRouter>);
  expect(await screen.findByText('Not linked')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /link /i })).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run apps/api/src/routes/admin/users.test.ts apps/web/src/pages/admin/AccountDetailPage.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement the route**

```ts
  /**
   * Who this account might belong to.
   *
   * `identity.read` rather than `directory.read`: the answer is a list of
   * people, and reading people is what that permission is for. An account
   * that already has a person answers with an empty list rather than a 409 —
   * the caller is a screen deciding whether to render a control, and a
   * refusal it has to catch is a worse contract than nothing to show.
   */
  app.get(
    '/users/:id/person-candidates',
    { preHandler: requirePermission(PERMISSIONS.IDENTITY_READ) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      return request.db(async (tx) => {
        const user = await tx.user.findUnique({ where: { id } });
        if (!user) throw new ProblemError(404, 'not-found', 'User not found');
        if (user.personId) return { candidates: [] };

        const match = await matchPersonForAccount(tx, {
          email: user.email,
          displayName: user.displayName,
        });
        // Flattened: the screen ranks by `rule` and does not need to know
        // that one of them was strong enough to have auto-linked, because by
        // definition it did not.
        return {
          candidates: match.confident ? [match.confident, ...match.candidates] : match.candidates,
        };
      });
    },
  );
```

Register it **before** any wildcard, and confirm it does not collide with `GET /users/:id`. Fastify's radix router prefers the more specific path, so `/users/:id/person-candidates` is safe wherever it sits in the file; put it next to `GET /users/:id` for readability.

- [ ] **Step 4: Implement the screen**

In `AccountDetailPage`, read the candidates only when there is no person:

```tsx
  // Fetched unconditionally and answered with an empty list for a linked
  // account, rather than conditionally called: a hook that runs on some
  // renders and not others is the shape that breaks the moment somebody adds
  // a branch above it.
  const { data: candidatesData } = useApiResource<{ candidates: Candidate[] }>(
    `/api/admin/users/${id}/person-candidates`,
  );
```

Replace the `Person` fact's null branch:

```tsx
            value: data.person ? (
              <Link to={`/admin/people/${data.person.id}`} /* ...unchanged... */>
                {data.person.givenName} {data.person.familyName}
              </Link>
            ) : (candidatesData?.candidates ?? []).length === 0 ? (
              // A service account is the ordinary case here, not a fault. It
              // is stated flatly and given no call to action for that reason,
              // and that is still true whenever nothing matched.
              <span className="font-normal text-muted">Not linked</span>
            ) : (
              <span className="flex flex-col gap-1">
                <span className="font-normal text-muted">Not linked</span>
                {(candidatesData?.candidates ?? []).map((c) => (
                  <span key={c.personId} className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={busy}
                      onClick={() =>
                        void run(async () => {
                          try {
                            await api(`/api/admin/persons/${c.personId}/link-user`, {
                              method: 'POST',
                              body: JSON.stringify({ userId: data.id }),
                            });
                            reload();
                          } catch (cause) {
                            failed(cause, 'That account could not be linked.');
                          }
                        })
                      }
                    >
                      Link {c.givenName} {c.familyName}
                    </Button>
                    {/* WHY it is being suggested. A suggestion with no reason
                        is one an administrator has to verify from scratch,
                        which is the work the suggestion was meant to save. */}
                    <span className="text-sm font-normal text-muted">
                      {c.rule === 'businessEmail'
                        ? 'same work email'
                        : c.rule === 'personalEmail'
                          ? 'same personal email'
                          : 'same name'}
                      {c.hasActiveAccount && ' — already has an account'}
                    </span>
                  </span>
                ))}
              </span>
            ),
```

Declare `Candidate` beside the file's other interfaces, matching the route's shape exactly.

- [ ] **Step 5: Run, typecheck, commit**

```bash
pnpm vitest run apps/api/src/routes/admin/users.test.ts apps/web/src/pages/admin/AccountDetailPage.test.tsx
pnpm typecheck
git add apps/api/src/routes/admin/users.ts apps/web/src/pages/admin/AccountDetailPage.tsx apps/api/src/routes/admin/users.test.ts apps/web/src/pages/admin/AccountDetailPage.test.tsx
git commit -m "feat(console): suggest a person for an unlinked account, with the reason"
```

---

### Task 16: Clearing the orphan backlog

**Files:**
- Modify: `apps/api/src/routes/admin/users.ts`
- Create: `apps/web/src/pages/admin/UnlinkedAccountsPage.tsx`
- Create: `apps/web/src/pages/admin/UnlinkedAccountsPage.test.tsx`
- Modify: `apps/web/src/pages/admin/AdminApp.tsx` (route), `apps/web/src/pages/admin/UsersPage.tsx` (stat card)
- Test: `apps/api/src/routes/admin/users.test.ts`

**Interfaces:**
- Consumes: `matchPersonForAccount` (Task 10), the `PersonCandidate` shape (Task 15).
- Produces: `GET /api/admin/users/unlinked` under `identity.read`, returning `{ accounts: { id, login, displayName, email, topCandidate: PersonCandidate | null }[] }`.

- [ ] **Step 1: Write the failing tests**

```ts
// users.test.ts
it('lists unlinked accounts with their best candidate', async () => {
  const cookie = await signInAs([
    PERMISSIONS.DIRECTORY_WRITE, PERMISSIONS.IDENTITY_WRITE, PERMISSIONS.IDENTITY_READ,
  ]);
  await ctx.app.inject({
    method: 'POST', url: '/api/admin/persons', headers: { cookie },
    payload: { givenName: 'Maya', familyName: 'Okafor', businessEmail: 'maya@acme.test' },
  });
  // personId: null keeps it an orphan despite the matching address.
  await ctx.app.inject({
    method: 'POST', url: '/api/admin/users', headers: { cookie },
    payload: { login: 'm', email: 'maya@acme.test', displayName: 'M', personId: null },
  });
  await ctx.app.inject({
    method: 'POST', url: '/api/admin/users', headers: { cookie },
    payload: { login: 'svc-backup', email: 'svc@acme.test', displayName: 'Backup', personId: null },
  });

  const res = await ctx.app.inject({
    method: 'GET', url: '/api/admin/users/unlinked', headers: { cookie },
  });

  const accounts = res.json().accounts as { login: string; topCandidate: unknown }[];
  expect(accounts).toHaveLength(2);
  expect(accounts.find((a) => a.login === 'm')!.topCandidate).toMatchObject({
    rule: 'businessEmail',
  });
  // A service account with nothing matching is listed with no suggestion,
  // rather than hidden: the point of the screen is the whole backlog.
  expect(accounts.find((a) => a.login === 'svc-backup')!.topCandidate).toBeNull();
});
```

```tsx
// UnlinkedAccountsPage.test.tsx
it('links one account from the list', async () => {
  mockUnlinked([
    {
      id: 'u1', login: 'm', displayName: 'M', email: 'maya@acme.test',
      topCandidate: { personId: 'p1', givenName: 'Maya', familyName: 'Okafor', rule: 'businessEmail', hasActiveAccount: false },
    },
  ]);
  render(<MemoryRouter><UnlinkedAccountsPage /></MemoryRouter>);
  await userEvent.click(await screen.findByRole('button', { name: /link m to Maya Okafor/i }));
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/persons/p1/link-user',
      expect.objectContaining({ method: 'POST' }),
    ),
  );
});

it('says so when there is no backlog', async () => {
  mockUnlinked([]);
  render(<MemoryRouter><UnlinkedAccountsPage /></MemoryRouter>);
  expect(await screen.findByText(/every account has a person/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run apps/api/src/routes/admin/users.test.ts`
Expected: FAIL with 400 or 404 — `/users/unlinked` parses `unlinked` as an id, or does not exist.

- [ ] **Step 3: Implement the route**

Register it **before** `GET /users/:id` in the file. Fastify's radix router prefers a static segment over a parametric one so ordering is not load-bearing, but a reader scanning the file should meet the static route first.

```ts
  /**
   * Every account with nobody behind it, and who it might be.
   *
   * The backlog this exists to clear was created by the console itself: the
   * Accounts create form had no person field at all, so every account made
   * there orphaned itself, and the only fix was one person's screen at a time.
   *
   * Service accounts are LISTED, with no candidate. Hiding them would make the
   * count a number nobody can reconcile against the accounts table, and a
   * genuine service account is a row somebody reads once and never thinks
   * about again.
   */
  app.get(
    '/users/unlinked',
    { preHandler: requirePermission(PERMISSIONS.IDENTITY_READ) },
    async (request) => {
      return request.db(async (tx) => {
        const users = await tx.user.findMany({
          where: { personId: null, status: 'active' },
          orderBy: { login: 'asc' },
          select: { id: true, login: true, displayName: true, email: true },
        });

        const accounts = [];
        for (const user of users) {
          const match = await matchPersonForAccount(tx, {
            email: user.email,
            displayName: user.displayName,
          });
          accounts.push({
            ...user,
            topCandidate: match.confident ?? match.candidates[0] ?? null,
          });
        }
        return { accounts };
      });
    },
  );
```

The loop reads the whole person table once per account. That is the honest cost of the matcher's shape and is acceptable here: this endpoint serves one screen, run rarely, on a backlog somebody is actively clearing. If it becomes slow, the fix is to hoist the person read out of the matcher — not to cache it here.

- [ ] **Step 4: Implement the page**

Create `apps/web/src/pages/admin/UnlinkedAccountsPage.tsx`:

```tsx
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, Empty, Panel, SkeletonRows, Table } from '@syntra/ui';
import { ApiError, api } from '../../session/api.js';
import { useApiResource } from './hooks.js';
import { PageHeader } from './PageHeader.js';

interface Candidate {
  personId: string;
  givenName: string;
  familyName: string;
  rule: 'businessEmail' | 'personalEmail' | 'displayName';
  hasActiveAccount: boolean;
}

interface Row {
  id: string;
  login: string;
  displayName: string;
  email: string;
  topCandidate: Candidate | null;
}

const REASON: Record<Candidate['rule'], string> = {
  businessEmail: 'same work email',
  personalEmail: 'same personal email',
  displayName: 'same name',
};

/** Strong enough to link without reading the row. See `matchPersonForAccount`. */
const confident = (row: Row) =>
  row.topCandidate?.rule === 'businessEmail' && !row.topCandidate.hasActiveAccount;

/**
 * The accounts with nobody behind them.
 *
 * A backlog the console created itself: the Accounts create form had no person
 * field, so every account made there orphaned itself, and the only way to fix
 * one was to open the person it should have been linked to and search for it.
 *
 * Its own screen rather than a fourth tab of Users, reached from a stat card
 * that hides itself at zero. The backlog is transient — a tab would be a
 * permanently visible destination that is usually empty, which is how a
 * console accumulates places nobody goes.
 */
export function UnlinkedAccountsPage() {
  const { data, error, loading, reload } = useApiResource<{ accounts: Row[] }>(
    '/api/admin/users/unlinked',
  );
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const rows = data?.accounts ?? [];
  const confidentRows = rows.filter(confident);

  async function link(userId: string, personId: string) {
    await api(`/api/admin/persons/${personId}/link-user`, {
      method: 'POST',
      body: JSON.stringify({ userId }),
    });
  }

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setProblem(null);
    try {
      await work();
      reload();
    } catch (cause) {
      setProblem(
        cause instanceof ApiError
          ? (cause.problem.detail ?? cause.problem.title)
          : 'That could not be linked.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title="Accounts with no person" />

      {error && <Alert tone="danger">{error}</Alert>}
      {problem && <Alert tone="danger">{problem}</Alert>}

      {!error && confidentRows.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <Button
            loading={busy}
            onClick={() =>
              void run(async () => {
                // Sequentially, not Promise.all. These are writes against one
                // table, the list is short, and a partial failure halfway
                // through a parallel batch leaves the screen unable to say
                // which ones landed.
                for (const row of confidentRows) {
                  await link(row.id, row.topCandidate!.personId);
                }
              })
            }
          >
            Link all {confidentRows.length} confident
          </Button>
          <span className="text-sm text-muted">
            {/* WHAT "confident" means, next to the button that acts on it. */}
            Accounts whose email matches exactly one person's work address, and
            whose person has no account yet.
          </span>
        </div>
      )}

      {!error && (
        <Panel>
          {loading && <SkeletonRows rows={5} cols={4} />}

          {!loading && rows.length === 0 && (
            <div className="p-6">
              <Empty title="Every account has a person">
                Accounts appear here when they are created without one. A
                service account belongs in this state and can be left alone.
              </Empty>
            </div>
          )}

          {!loading && rows.length > 0 && (
            <Table>
              <thead>
                <tr>
                  <th scope="col">Account</th>
                  <th scope="col" className="max-sm:hidden">Email</th>
                  <th scope="col">Might be</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link
                        to={`/admin/users/${row.id}`}
                        className="font-medium text-ink underline-offset-2 hover:text-primary hover:underline"
                      >
                        {row.login}
                      </Link>
                    </td>
                    <td className="max-sm:hidden">{row.email}</td>
                    <td>
                      {row.topCandidate ? (
                        <span className="flex flex-wrap items-center gap-2">
                          <Link
                            to={`/admin/people/${row.topCandidate.personId}`}
                            className="text-ink underline-offset-2 hover:text-primary hover:underline"
                          >
                            {row.topCandidate.givenName} {row.topCandidate.familyName}
                          </Link>
                          <span className="text-sm text-muted">
                            {REASON[row.topCandidate.rule]}
                            {row.topCandidate.hasActiveAccount &&
                              ' — already has an account'}
                          </span>
                        </span>
                      ) : (
                        // Listed with no suggestion rather than hidden. Hiding
                        // them would make the count irreconcilable with the
                        // accounts table, and a genuine service account is a
                        // row somebody reads once and never thinks about again.
                        <span className="text-muted">Nobody obvious</span>
                      )}
                    </td>
                    <td>
                      {row.topCandidate && (
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={busy}
                          onClick={() =>
                            void run(() => link(row.id, row.topCandidate!.personId))
                          }
                        >
                          {/* Names BOTH, for the reason Task 4 gives: a table
                              of identical "Link" buttons is announced one
                              after another with no way to tell the rows
                              apart. */}
                          Link {row.login} to {row.topCandidate.givenName}{' '}
                          {row.topCandidate.familyName}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>
      )}

      <Link
        to="/admin/users?tab=accounts"
        className="mt-4 inline-block text-muted underline-offset-2 hover:text-ink hover:underline"
      >
        Back to accounts
      </Link>
    </>
  );
}
```

Confirm `Empty`, `Table`, `Panel` and `SkeletonRows` are exported from
`@syntra/ui` with these props by reading `AccountsTab.tsx`'s imports — it uses
all four the same way.

Register the route in `AdminApp.tsx` beside the other user routes:

```tsx
            {/* The orphan backlog, on its own screen rather than a fourth tab
                of Users. It is a transient state — a tab for it would be a
                permanently visible destination that is usually empty. */}
            <Route path="users/unlinked" element={<UnlinkedAccountsPage />} />
```

**This route must be declared before `users/:id`**, or React Router matches `unlinked` as an account id. Unlike Fastify, React Router v6 ranks static segments above dynamic ones automatically — but declare it first regardless, so the file does not depend on that being remembered.

Add the stat card in `UsersPage.tsx`, reading from the same endpoint:

```tsx
  const unlinked = useApiResource<{ accounts: unknown[] }>('/api/admin/users/unlinked');
```

```tsx
        <StatCard
          label="Accounts with no person"
          value={unlinked.data?.accounts.length ?? 0}
          tone="warning"
          quietWhenZero
          to="/admin/users/unlinked"
        />
```

`quietWhenZero` is the whole reason this is a card and not a tab: the backlog is transient, and the control disappears when the work is done. Its error is folded into the page's existing `error` only if the other two are also failing — read how `persons.error ?? users.error` is combined and leave that expression alone; a caller without `identity.read` gets a card reading zero rather than a broken page, matching how the sources read is already tolerated in `AccountsTab`.

- [ ] **Step 5: Run to verify pass**

Run: `pnpm vitest run apps/api/src/routes/admin/users.test.ts && pnpm vitest run apps/web/src/pages/admin`
Expected: PASS.

- [ ] **Step 6: Typecheck and full suite**

Run: `pnpm typecheck`
Run: `pnpm test`
Expected: no errors, everything green. Run this one alone — concurrent runs against the shared database produce phantom failures.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/admin/users.ts apps/web/src/pages/admin/UnlinkedAccountsPage.tsx apps/web/src/pages/admin/UnlinkedAccountsPage.test.tsx apps/web/src/pages/admin/AdminApp.tsx apps/web/src/pages/admin/UsersPage.tsx apps/api/src/routes/admin/users.test.ts
git commit -m "feat(console): clear the orphan-account backlog from one screen"
```

---

## Spec coverage

| Spec section | Task |
|---|---|
| §3.1 Login, case-insensitive | 1, 2 |
| §3.2 Email, local-only | 1, 2 |
| §3.3 Second account, confirmable | 11, 14 |
| §3.4 Duplicate person, confirmable | 12, 14 |
| §4 Contract editing | 3, 4 |
| §5.1 The matcher | 10 |
| §5.2 Create form, three person states | 11, 14 |
| §5.3 Suggestions on an unlinked account | 15 |
| §5.4 Backfill | 16 |
| §6 Org unit at creation | 9 |
| §7.1 `mustChange` and the renewal gate | 5 |
| §7.2 `setPasswordAsAdmin` | 6 |
| §7.3 The endpoint | 7 |
| §7.4 The control | 8 |
| §8 Migrations | 1, 5 |

**One spec requirement is deliberately deferred within Task 9**: §6 says the picked org unit reaches the person when the person's own unit is null. That needs a person on the create form, which arrives in Task 11. Add it there — in the `if (personId)` branch of `POST /users`, after the link:

```ts
          // Only when theirs is null. A person who already has a unit either
          // had it set deliberately or has an AccountPlacement row protecting
          // a manual move, and overwriting it from a form whose subject is the
          // ACCOUNT would undo a decision made about the PERSON.
          if (body.orgUnitId) {
            const person = await tx.person.findUnique({
              where: { id: personId },
              select: { orgUnitId: true },
            });
            if (person && person.orgUnitId === null) {
              await tx.person.update({
                where: { id: personId },
                data: { orgUnitId: body.orgUnitId },
              });
            }
          }
```

with a test in Task 11 asserting both halves: set when null, left when not.
