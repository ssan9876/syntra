# Identity List Search and Paging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give People, Accounts and Groups a search box, a status filter and offset paging, so the console stays usable past a few hundred rows.

**Architecture:** Three explicit core list services each take the same `ListOptions` bag and return `ListPage<T>` (rows plus a filtered total, read in one transaction). Three routes parse one shared zod schema and return the existing collection key plus a `total`/`page`/`pageSize` envelope. The console drives all of it from the URL query string with two new `@syntra/ui` components.

**Tech Stack:** TypeScript, Prisma (PostgreSQL, row-level security via `TenantClient`), Fastify, zod, React + react-router, vitest, Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-30-admin-list-search-and-paging-design.md`

## Global Constraints

- `page` is 1-based, default `1`. `pageSize` default `50`, maximum `200`.
- A `pageSize` above 200 is **rejected (400), not clamped**.
- Search is case-insensitive substring (`contains` + `mode: 'insensitive'`), OR-ed across a per-list named field set. Whitespace-only search is treated as absent.
- People search fields: `givenName`, `familyName`, `externalId`, `businessEmail`. **`personalEmail` is deliberately excluded** — it is a home address, and matching it turns the admin search box into a way to search staff by private contact details.
- Accounts search fields: `login`, `displayName`, `email`. Groups: `name`, `description`.
- `total` is the count matching the filters, not the size of the table.
- Responses keep their existing collection key (`persons`, `users`, `groups`) and gain `total`, `page`, `pageSize`. Additive only.
- Status values are `'active' | 'inactive'` for both Person and User. Groups have no status filter, and `status` on that route is rejected.
- `exactOptionalPropertyTypes` is on repo-wide: every optional interface property is written `foo?: T | undefined`.
- Comments explain **why**, not what. Match the surrounding density.
- Run core/API tests with `npx vitest run <path>`; console tests with `pnpm --filter @syntra/web exec vitest run <path>`; typecheck with `npx tsc -b`.

---

### Task 1: Shared list types and `listPersons`

**Files:**
- Create: `packages/core/src/list.ts`
- Modify: `packages/core/src/identity/person-service.ts:40-42`
- Modify: `packages/core/src/index.ts` (add `export * from './list.js';`)
- Test: `packages/core/src/identity/person-list.test.ts`

**Interfaces:**
- Produces: `ListOptions`, `ListPage<T>`, `DEFAULT_PAGE_SIZE`, `MAX_PAGE_SIZE` from `@syntra/core`; `listPersons(tx, opts?: ListOptions)` returning `{ rows, total, page, pageSize }`.
- Consumes: nothing.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/identity/person-list.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { createPerson, deactivatePerson, listPersons } from './person-service.js';

let tenantId: string;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
});

async function seed(count: number) {
  return withTenant(tenantId, async (tx) => {
    const made = [];
    for (let i = 0; i < count; i += 1) {
      made.push(
        await createPerson(tx, {
          givenName: `Given${i}`,
          familyName: `Family${String(i).padStart(3, '0')}`,
          businessEmail: `p${i}@acme.test`,
          externalId: `E${i}`,
        }),
      );
    }
    return made;
  });
}

describe('listPersons', () => {
  it('returns one page and the total that page is drawn from', async () => {
    await seed(12);
    const page = await withTenant(tenantId, (tx) =>
      listPersons(tx, { page: 2, pageSize: 5 }),
    );
    expect(page.rows).toHaveLength(5);
    expect(page.total).toBe(12);
    expect(page.page).toBe(2);
    expect(page.pageSize).toBe(5);
    expect(page.rows[0]?.familyName).toBe('Family005');
  });

  it('matches a substring of the family name, case-insensitively', async () => {
    await withTenant(tenantId, (tx) =>
      createPerson(tx, { givenName: 'Brady', familyName: 'Marchetti' }),
    );
    const page = await withTenant(tenantId, (tx) => listPersons(tx, { search: 'ARCH' }));
    expect(page.rows.map((r) => r.familyName)).toEqual(['Marchetti']);
    expect(page.total).toBe(1);
  });

  it('matches the external id and the business email', async () => {
    await withTenant(tenantId, (tx) =>
      createPerson(tx, {
        givenName: 'Jo',
        familyName: 'Doe',
        externalId: 'EMP-4471',
        businessEmail: 'jo.doe@acme.test',
      }),
    );
    const byId = await withTenant(tenantId, (tx) => listPersons(tx, { search: '4471' }));
    const byMail = await withTenant(tenantId, (tx) => listPersons(tx, { search: 'jo.doe' }));
    expect(byId.total).toBe(1);
    expect(byMail.total).toBe(1);
  });

  // A home address is not an admin search key. See the spec.
  it('does NOT match a personal email address', async () => {
    await withTenant(tenantId, (tx) =>
      createPerson(tx, {
        givenName: 'Jo',
        familyName: 'Doe',
        personalEmail: 'jo@hotmail.test',
      }),
    );
    const page = await withTenant(tenantId, (tx) => listPersons(tx, { search: 'hotmail' }));
    expect(page.total).toBe(0);
  });

  it('treats a whitespace-only search as no search at all', async () => {
    await seed(3);
    const page = await withTenant(tenantId, (tx) => listPersons(tx, { search: '   ' }));
    expect(page.total).toBe(3);
  });

  it('counts what matches the filter, not what is in the table', async () => {
    const made = await seed(4);
    await withTenant(tenantId, (tx) => deactivatePerson(tx, made[0]!.id));
    const page = await withTenant(tenantId, (tx) => listPersons(tx, { status: 'active' }));
    expect(page.total).toBe(3);
    expect(page.rows).toHaveLength(3);
  });

  it('answers a page past the end with no rows and a truthful total', async () => {
    await seed(3);
    const page = await withTenant(tenantId, (tx) =>
      listPersons(tx, { page: 9, pageSize: 10 }),
    );
    expect(page.rows).toEqual([]);
    expect(page.total).toBe(3);
  });

  it('defaults to the first page of fifty', async () => {
    await seed(2);
    const page = await withTenant(tenantId, (tx) => listPersons(tx, {}));
    expect(page.page).toBe(1);
    expect(page.pageSize).toBe(50);
  });
});
```

Check the deactivation helper's real name before running: `grep -n "export async function deactivatePerson" packages/core/src/identity/person-service.ts`. If it differs, use the actual name.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/identity/person-list.test.ts`
Expected: FAIL — `listPersons` takes one argument, and `page.rows` is undefined because it returns an array.

- [ ] **Step 3: Create the shared types**

Create `packages/core/src/list.ts`:

```ts
/**
 * The shape every paged list in the admin API takes and returns.
 *
 * Deliberately shared as TYPES only, with each list keeping its own function.
 * A generic `listQuery(model, fields)` would have to be understood before any
 * single list could be read, and Prisma's types resist generic model access
 * hard enough that it ends in casts. What is worth sharing is the vocabulary,
 * so three routes and three services cannot drift on what `page` means.
 */
export interface ListOptions {
  search?: string | undefined;
  status?: string | undefined;
  /** 1-based. */
  page?: number | undefined;
  pageSize?: number | undefined;
}

export interface ListPage<T> {
  rows: T[];
  /**
   * How many rows match the FILTERS -- not how many are in the table. With a
   * search active, "1-50 of 12" is the useful number and the table's size is
   * not.
   */
  total: number;
  page: number;
  pageSize: number;
}

export const DEFAULT_PAGE_SIZE = 50;

/**
 * The ceiling on one query's cost. Without it `?pageSize=1000000` reinstates
 * from outside exactly the unbounded read this exists to remove.
 */
export const MAX_PAGE_SIZE = 200;
```

- [ ] **Step 4: Export it from the package index**

In `packages/core/src/index.ts`, add beside the other `export *` lines:

```ts
export * from './list.js';
```

- [ ] **Step 5: Implement `listPersons`**

In `packages/core/src/identity/person-service.ts`, add the import at the top:

```ts
import { DEFAULT_PAGE_SIZE, type ListOptions } from '../list.js';
```

Replace lines 40-42 with:

```ts
/**
 * One page of people, and how many there are to page through.
 *
 * The search fields are named here rather than derived from the model, so the
 * set is legible at the point somebody changes it. `personalEmail` is absent
 * on purpose: it is a home address held for contacting a leaver, and matching
 * it would turn this box into a way to search staff by private contact
 * details.
 */
export async function listPersons(tx: TenantClient, opts: ListOptions = {}) {
  const page = opts.page ?? 1;
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const search = opts.search?.trim();

  const where = {
    ...(opts.status ? { status: opts.status } : {}),
    ...(search
      ? {
          OR: [
            { givenName: { contains: search, mode: 'insensitive' as const } },
            { familyName: { contains: search, mode: 'insensitive' as const } },
            { externalId: { contains: search, mode: 'insensitive' as const } },
            { businessEmail: { contains: search, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };

  // Both reads on the same client inside the caller's transaction: a total
  // that disagreed with its own page would be worse than no total.
  const [rows, total] = await Promise.all([
    tx.person.findMany({
      where,
      orderBy: [{ familyName: 'asc' }, { givenName: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    tx.person.count({ where }),
  ]);

  return { rows, total, page, pageSize };
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run packages/core/src/identity/person-list.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 7: Fix the existing caller**

`apps/api/src/routes/admin/persons.ts:103` does `const persons = await request.db((tx) => listPersons(tx));` and returns `{ persons }`. It now receives an object. Change it to keep the route compiling until Task 3 rewrites it properly:

```ts
      const { rows } = await request.db((tx) => listPersons(tx));
      return { persons: rows };
```

Then find any other caller: `grep -rn "listPersons(" --include=*.ts apps packages | grep -v "\.test\."` and update each the same way.

- [ ] **Step 8: Typecheck and run the full core suite**

Run: `npx tsc -b`
Expected: exit 0.
Run: `npx vitest run packages/core/src/identity`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/list.ts packages/core/src/index.ts packages/core/src/identity/person-service.ts packages/core/src/identity/person-list.test.ts apps/api/src/routes/admin/persons.ts
git commit -m "feat(core): one page of people, and the total it came from"
```

---

### Task 2: `listUsers` and `listGroups`

**Files:**
- Modify: `packages/core/src/directory/user-service.ts:66-74`
- Modify: `packages/core/src/directory/group-service.ts:15-17`
- Test: `packages/core/src/directory/directory-list.test.ts`

**Interfaces:**
- Consumes: `ListOptions`, `DEFAULT_PAGE_SIZE` from Task 1.
- Produces: `listUsers(tx, opts?: ListOptions)` and `listGroups(tx, opts?: ListOptions)`, both returning `{ rows, total, page, pageSize }`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/directory/directory-list.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { createUser, listUsers } from './user-service.js';
import { createGroup, listGroups } from './group-service.js';

let tenantId: string;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
});

describe('listUsers', () => {
  it('pages, and reports the total it paged through', async () => {
    await withTenant(tenantId, async (tx) => {
      for (let i = 0; i < 7; i += 1) {
        await createUser(tx, {
          login: `user${i}`,
          email: `user${i}@acme.test`,
          displayName: `User ${i}`,
        });
      }
    });
    const page = await withTenant(tenantId, (tx) => listUsers(tx, { page: 2, pageSize: 3 }));
    expect(page.rows.map((r) => r.login)).toEqual(['user3', 'user4', 'user5']);
    expect(page.total).toBe(7);
  });

  it('searches login, display name and email, case-insensitively', async () => {
    await withTenant(tenantId, (tx) =>
      createUser(tx, {
        login: 'barcher',
        email: 'brady.archer@acme.test',
        displayName: 'Brady Archer',
      }),
    );
    for (const term of ['BARCH', 'brady arch', 'archer@acme']) {
      const page = await withTenant(tenantId, (tx) => listUsers(tx, { search: term }));
      expect(page.total, `searching ${term}`).toBe(1);
    }
  });

  it('still honours the status filter it already had', async () => {
    await withTenant(tenantId, async (tx) => {
      await createUser(tx, { login: 'a', email: 'a@acme.test', displayName: 'A' });
    });
    const page = await withTenant(tenantId, (tx) => listUsers(tx, { status: 'inactive' }));
    expect(page.total).toBe(0);
  });
});

describe('listGroups', () => {
  it('pages and searches name and description', async () => {
    await withTenant(tenantId, async (tx) => {
      await createGroup(tx, { name: 'Payroll', description: 'Finance systems' });
      await createGroup(tx, { name: 'Engineering', description: 'Builders' });
    });
    const all = await withTenant(tenantId, (tx) => listGroups(tx, {}));
    expect(all.total).toBe(2);

    const byName = await withTenant(tenantId, (tx) => listGroups(tx, { search: 'payr' }));
    expect(byName.rows.map((r) => r.name)).toEqual(['Payroll']);

    const byDescription = await withTenant(tenantId, (tx) =>
      listGroups(tx, { search: 'finance' }),
    );
    expect(byDescription.rows.map((r) => r.name)).toEqual(['Payroll']);
  });
});
```

Check `createGroup`'s real signature first: `grep -n "export async function createGroup" -A 8 packages/core/src/directory/group-service.ts`. Adjust the seed calls to match.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/core/src/directory/directory-list.test.ts`
Expected: FAIL — `page.rows` is undefined.

- [ ] **Step 3: Implement `listUsers`**

In `packages/core/src/directory/user-service.ts`, add to the imports:

```ts
import { DEFAULT_PAGE_SIZE, type ListOptions } from '../list.js';
```

Replace lines 66-74 with:

```ts
/**
 * One page of accounts, and the total behind it.
 *
 * `status` is the filter this already had; it moves into the shared options
 * bag rather than keeping a signature of its own, so a caller that pages and a
 * caller that filters are writing the same call.
 */
export async function listUsers(tx: TenantClient, opts: ListOptions = {}) {
  const page = opts.page ?? 1;
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const search = opts.search?.trim();

  const where = {
    ...(opts.status ? { status: opts.status } : {}),
    ...(search
      ? {
          OR: [
            { login: { contains: search, mode: 'insensitive' as const } },
            { displayName: { contains: search, mode: 'insensitive' as const } },
            { email: { contains: search, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    tx.user.findMany({
      where,
      orderBy: { login: 'asc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    tx.user.count({ where }),
  ]);

  return { rows, total, page, pageSize };
}
```

- [ ] **Step 4: Implement `listGroups`**

In `packages/core/src/directory/group-service.ts`, add the same import, then replace lines 15-17:

```ts
/** One page of groups. No status filter: a group does not have one. */
export async function listGroups(tx: TenantClient, opts: ListOptions = {}) {
  const page = opts.page ?? 1;
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const search = opts.search?.trim();

  const where = search
    ? {
        OR: [
          { name: { contains: search, mode: 'insensitive' as const } },
          { description: { contains: search, mode: 'insensitive' as const } },
        ],
      }
    : {};

  const [rows, total] = await Promise.all([
    tx.group.findMany({
      where,
      orderBy: { name: 'asc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    tx.group.count({ where }),
  ]);

  return { rows, total, page, pageSize };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run packages/core/src/directory/directory-list.test.ts`
Expected: PASS.

- [ ] **Step 6: Fix every existing caller**

Run: `grep -rn "listUsers(\|listGroups(" --include=*.ts --include=*.tsx apps packages | grep -v "\.test\."`

For each hit, destructure `rows`. In `apps/api/src/routes/admin/users.ts:119` and `apps/api/src/routes/admin/groups.ts:88` this is temporary — Task 3 and Task 4 rewrite both properly — but the tree must compile and the suite must pass at every commit.

- [ ] **Step 7: Typecheck and run the wider suite**

Run: `npx tsc -b && npx vitest run packages/core/src/directory apps/api/src/routes/admin`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/directory apps/api/src/routes/admin
git commit -m "feat(core): accounts and groups page the same way people do"
```

---

### Task 3: The shared query schema, and the persons and groups routes

**Files:**
- Create: `apps/api/src/routes/admin/list-query.ts`
- Modify: `apps/api/src/routes/admin/persons.ts:99-106`
- Modify: `apps/api/src/routes/admin/groups.ts:85-89`
- Test: `apps/api/src/routes/admin/list-paging.test.ts`

**Interfaces:**
- Consumes: `listPersons`, `listGroups` from Tasks 1-2.
- Produces: `pageQuery` and `statusPageQuery` zod schemas; the response envelope `{ <collection>, total, page, pageSize }`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/admin/list-paging.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@syntra/db';
import {
  PERMISSIONS,
  assignRole,
  createPerson,
  createRole,
  createUser,
  hashPassword,
  setPasswordHash,
  type Permission,
} from '@syntra/core';
import { buildTestApp } from '../../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
const PASSWORD = 'a-long-enough-password';
const PASSWORD_HASH = await hashPassword(PASSWORD);

// Copy the seedAdmin/signIn helpers from persons.test.ts verbatim rather than
// importing them: that file does not export them, and a shared test helper is
// its own change.
async function seedAdmin(permissions: Permission[]) {
  return withTenant(ctx.tenantId, async (tx) => {
    const user = await createUser(tx, {
      login: 'admin',
      email: 'admin@acme.test',
      displayName: 'Admin',
    });
    await setPasswordHash(tx, user.id, PASSWORD_HASH);
    const role = await createRole(tx, { name: 'admins', permissions });
    await assignRole(tx, { userId: user.id, roleId: role.id });
    return user;
  });
}

beforeEach(async () => {
  ctx = await buildTestApp();
  await seedAdmin([PERMISSIONS.IDENTITY_READ, PERMISSIONS.DIRECTORY_READ]);
  await withTenant(ctx.tenantId, async (tx) => {
    for (let i = 0; i < 4; i += 1) {
      await createPerson(tx, {
        givenName: `Given${i}`,
        familyName: `Family${i}`,
      });
    }
  });
});

describe('GET /persons', () => {
  it('answers with a page and the envelope describing it', async () => {
    const res = await ctx.get('/api/admin/persons?pageSize=2&page=2');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.persons).toHaveLength(2);
    expect(body.total).toBe(4);
    expect(body.page).toBe(2);
    expect(body.pageSize).toBe(2);
  });

  it('narrows to a search', async () => {
    const res = await ctx.get('/api/admin/persons?q=family2');
    expect(res.json().total).toBe(1);
  });

  it('treats an empty q as no search rather than as matching nothing', async () => {
    const res = await ctx.get('/api/admin/persons?q=');
    expect(res.json().total).toBe(4);
  });

  it('REJECTS a pageSize above the ceiling rather than clamping it', async () => {
    // Silently returning 50 to a caller who asked for 100000 is a client bug
    // nobody ever sees.
    const res = await ctx.get('/api/admin/persons?pageSize=100000');
    expect(res.statusCode).toBe(400);
  });

  it('rejects a page of zero', async () => {
    const res = await ctx.get('/api/admin/persons?page=0');
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /groups', () => {
  it('rejects a status filter, which groups do not have', async () => {
    const res = await ctx.get('/api/admin/groups?status=active');
    expect(res.statusCode).toBe(400);
  });
});
```

`buildTestApp`'s helper for an authenticated GET may be named differently — read `apps/api/src/test-support.ts` and use whatever `persons.test.ts` uses to make a signed-in request, including the sign-in step if that is the pattern there.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/api/src/routes/admin/list-paging.test.ts`
Expected: FAIL — `body.total` is undefined; the 400 cases return 200.

- [ ] **Step 3: Write the shared schema**

Create `apps/api/src/routes/admin/list-query.ts`:

```ts
import { z } from 'zod';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@syntra/core';

/**
 * The query string every paged admin list takes.
 *
 * One schema for all of them so three routes cannot drift on what `page`
 * means. `.max()` REJECTS rather than clamps, which is the intent: a caller
 * who asked for a thousand rows and quietly received fifty has a bug they
 * cannot see.
 */
export const pageQuery = z
  .object({
    q: z
      .string()
      .optional()
      // An empty box submits `?q=`. That is "no search", not "match nothing".
      .transform((value) => {
        const trimmed = value?.trim();
        return trimmed ? trimmed : undefined;
      }),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_PAGE_SIZE)
      .default(DEFAULT_PAGE_SIZE),
  })
  // Strict, so `?status=active` on a list that has no status is a 400 rather
  // than a filter that silently did nothing.
  .strict();

export const statusPageQuery = pageQuery.extend({
  status: z.enum(['active', 'inactive']).optional(),
});
```

- [ ] **Step 4: Rewrite the persons route**

`apps/api/src/routes/admin/persons.ts`, replacing the `app.get('/persons', ...)` handler body:

```ts
  app.get(
    '/persons',
    { preHandler: requirePermission(PERMISSIONS.IDENTITY_READ) },
    async (request) => {
      const { q, status, page, pageSize } = statusPageQuery.parse(request.query);
      const result = await request.db((tx) =>
        listPersons(tx, { search: q, status, page, pageSize }),
      );
      return {
        persons: result.rows,
        total: result.total,
        page: result.page,
        pageSize: result.pageSize,
      };
    },
  );
```

Add the import: `import { statusPageQuery } from './list-query.js';`

- [ ] **Step 5: Rewrite the groups route**

`apps/api/src/routes/admin/groups.ts`:

```ts
  app.get(
    '/groups',
    { preHandler: requirePermission(PERMISSIONS.DIRECTORY_READ) },
    async (request) => {
      const { q, page, pageSize } = pageQuery.parse(request.query);
      const result = await request.db((tx) => listGroups(tx, { search: q, page, pageSize }));
      return {
        groups: result.rows,
        total: result.total,
        page: result.page,
        pageSize: result.pageSize,
      };
    },
  );
```

Add: `import { pageQuery } from './list-query.js';`

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run apps/api/src/routes/admin/list-paging.test.ts`
Expected: PASS.

- [ ] **Step 7: Confirm zod's parse failure really is a 400**

Run: `grep -rn "ZodError" apps/api/src --include=*.ts | grep -v test | head`
The error handler must map a `ZodError` to 400. If it does not, the two rejection tests will show 500 — fix by using the same validation path other routes use (read how `audit.ts` parses its query) rather than adding a new error branch.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/routes/admin/list-query.ts apps/api/src/routes/admin/persons.ts apps/api/src/routes/admin/groups.ts apps/api/src/routes/admin/list-paging.test.ts
git commit -m "feat(api): a page, a total, and a ceiling that refuses rather than clamps"
```

---

### Task 4: The users route

**Files:**
- Modify: `apps/api/src/routes/admin/users.ts:40-42` (the existing `listQuery`), `:115-135` (the handler)
- Test: `apps/api/src/routes/admin/list-paging.test.ts` (add a describe block)

**Interfaces:**
- Consumes: `statusPageQuery` from Task 3, `listUsers` from Task 2.
- Produces: `{ users, total, page, pageSize }`, each user still carrying `locked`.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/routes/admin/list-paging.test.ts`:

```ts
describe('GET /users', () => {
  it('pages, and still says which accounts are locked', async () => {
    const res = await ctx.get('/api/admin/users?pageSize=1');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.users).toHaveLength(1);
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.users[0]).toHaveProperty('locked');
  });

  it('searches by login', async () => {
    const res = await ctx.get('/api/admin/users?q=admin');
    expect(res.json().total).toBe(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run apps/api/src/routes/admin/list-paging.test.ts -t "still says which accounts are locked"`
Expected: FAIL — no `total` in the body.

- [ ] **Step 3: Replace the local `listQuery` with the shared schema**

Delete lines 40-42 of `apps/api/src/routes/admin/users.ts` (the local `const listQuery = z.object({ status: ... })`) and import instead:

```ts
import { statusPageQuery } from './list-query.js';
```

Then check `grep -n "listQuery" apps/api/src/routes/admin/users.ts` for other uses and point them at `statusPageQuery`.

- [ ] **Step 4: Rewrite the handler**

```ts
  app.get(
    '/users',
    { preHandler: requirePermission(PERMISSIONS.DIRECTORY_READ) },
    async (request) => {
      const { q, status, page, pageSize } = statusPageQuery.parse(request.query);
      const { result, locks } = await request.db(async (tx) => {
        const result = await listUsers(tx, { search: q, status, page, pageSize });
        return {
          result,
          // Scoped to the page, which is strictly less work than the whole
          // lockout table and the reason this read moved after the list.
          locks: await tx.loginLockout.findMany({
            where: { userId: { in: result.rows.map((u) => u.id) } },
            select: { userId: true, lockedAt: true, lockedUntil: true },
          }),
        };
      });

      const now = new Date();
      const lockedIds = new Set(
        locks.filter((l) => isLocked(l, now)).map((l) => l.userId),
      );
      return {
        users: result.rows.map((u) => ({ ...u, locked: lockedIds.has(u.id) })),
        total: result.total,
        page: result.page,
        pageSize: result.pageSize,
      };
    },
  );
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run apps/api/src/routes/admin/list-paging.test.ts apps/api/src/routes/admin/users.test.ts`
Expected: PASS. If `users.test.ts` asserts on the old shape, update those assertions — the envelope is the new contract.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/admin/users.ts apps/api/src/routes/admin/list-paging.test.ts
git commit -m "feat(api): accounts page, and the lock read follows the page"
```

---

### Task 5: `GET /directory/summary`

**Files:**
- Modify: `apps/api/src/routes/admin/users.ts` (add the route beside `/users`)
- Test: `apps/api/src/routes/admin/list-paging.test.ts` (add a describe block)

**Interfaces:**
- Produces: `GET /api/admin/directory/summary` returning `{ people: { total, active }, accounts: { total, active, locked } }`.

- [ ] **Step 1: Write the failing test**

```ts
describe('GET /directory/summary', () => {
  it('counts people and accounts on the server, where paging cannot skew them', async () => {
    const res = await ctx.get('/api/admin/directory/summary');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.people.total).toBe(4);
    expect(body.people.active).toBe(4);
    expect(body.accounts.total).toBe(1);
    expect(body.accounts.locked).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run apps/api/src/routes/admin/list-paging.test.ts -t "counts people and accounts"`
Expected: FAIL with 404.

- [ ] **Step 3: Implement the route**

In `apps/api/src/routes/admin/users.ts`:

```ts
  /**
   * The numbers the directory screen puts on its stat cards.
   *
   * Server-side because the page used to compute them by filtering the full
   * collections it had fetched, and paging turns that into page-sized numbers
   * that still look like totals -- worse than showing nothing.
   *
   * Both permissions, because the answer spans both halves of the directory.
   * `locked` cannot come from a list filter: it is derived from lockout state
   * rather than a User column, and answering it with a join in the route
   * would put that logic in the wrong layer.
   */
  app.get(
    '/directory/summary',
    {
      preHandler: [
        requirePermission(PERMISSIONS.IDENTITY_READ),
        requirePermission(PERMISSIONS.DIRECTORY_READ),
      ],
    },
    async (request) => {
      const now = new Date();
      return request.db(async (tx) => {
        const [people, activePeople, accounts, activeAccounts, locks] =
          await Promise.all([
            tx.person.count(),
            tx.person.count({ where: { status: 'active' } }),
            tx.user.count(),
            tx.user.count({ where: { status: 'active' } }),
            tx.loginLockout.findMany({
              select: { userId: true, lockedAt: true, lockedUntil: true },
            }),
          ]);
        return {
          people: { total: people, active: activePeople },
          accounts: {
            total: accounts,
            active: activeAccounts,
            locked: locks.filter((l) => isLocked(l, now)).length,
          },
        };
      });
    },
  );
```

- [ ] **Step 4: Verify the two-permission preHandler actually composes**

Run: `npx vitest run apps/api/src/routes/admin/list-paging.test.ts -t "counts people and accounts"`
Expected: PASS. If Fastify rejects the array or only the first runs, write one `requirePermissions([...])` helper next to `requirePermission` instead — and add a test that an admin holding only `DIRECTORY_READ` gets a 403 from this route.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/admin/users.ts apps/api/src/routes/admin/list-paging.test.ts
git commit -m "feat(api): count the directory where paging cannot skew the answer"
```

---

### Task 6: The `Pager` component

**Files:**
- Create: `packages/ui/src/Pager.tsx`
- Modify: `packages/ui/src/index.ts`
- Test: `packages/ui/src/Pager.test.tsx`

**Interfaces:**
- Produces: `Pager({ page, pageSize, total, onPage })` from `@syntra/ui`.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Pager } from './Pager.js';

describe('Pager', () => {
  it('says which rows are on screen and how many there are', () => {
    render(<Pager page={2} pageSize={50} total={4312} onPage={() => {}} />);
    expect(screen.getByText('51–100 of 4,312')).toBeVisible();
  });

  it('disables previous on the first page and next on the last', () => {
    const { rerender } = render(
      <Pager page={1} pageSize={10} total={30} onPage={() => {}} />,
    );
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();

    rerender(<Pager page={3} pageSize={10} total={30} onPage={() => {}} />);
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('disables both when everything fits on one page, and still shows the count', () => {
    render(<Pager page={1} pageSize={50} total={12} onPage={() => {}} />);
    expect(screen.getByText('1–12 of 12')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('asks for the next page by number', async () => {
    const onPage = vi.fn();
    render(<Pager page={2} pageSize={10} total={100} onPage={onPage} />);
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(onPage).toHaveBeenCalledWith(3);
  });

  it('says so when there is nothing to page through', () => {
    render(<Pager page={1} pageSize={50} total={0} onPage={() => {}} />);
    expect(screen.getByText('No results')).toBeVisible();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @syntra/ui exec vitest run src/Pager.test.tsx`
Expected: FAIL — module not found. (If `@syntra/ui` has no test script, put this test in `apps/web/src/components/` instead and run it with the web project; check `packages/ui/package.json` first.)

- [ ] **Step 3: Implement**

```tsx
import { buttonClasses } from './Button.js';

export interface PagerProps {
  /** 1-based. */
  page: number;
  pageSize: number;
  /** Rows matching the filters, which is what the count describes. */
  total: number;
  onPage(page: number): void;
}

/**
 * Where you are in a list, and how to move.
 *
 * Buttons are disabled rather than hidden at the ends: a control that vanishes
 * moves the one beside it under the cursor somebody was about to click.
 */
export function Pager({ page, pageSize, total, onPage }: PagerProps) {
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  return (
    <div className="mt-4 flex items-center justify-between gap-4 text-sm text-muted">
      <span aria-live="polite">
        {total === 0
          ? 'No results'
          : `${first.toLocaleString()}–${last.toLocaleString()} of ${total.toLocaleString()}`}
      </span>
      <div className="flex gap-2">
        <button
          type="button"
          className={buttonClasses('secondary')}
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
        >
          Previous
        </button>
        <button
          type="button"
          className={buttonClasses('secondary')}
          disabled={page >= lastPage}
          onClick={() => onPage(page + 1)}
        >
          Next
        </button>
      </div>
    </div>
  );
}
```

Check `buttonClasses`' real export and accepted variants first: `grep -n "export function buttonClasses" -A 6 packages/ui/src/Button.tsx`.

- [ ] **Step 4: Export it**

Add `export * from './Pager.js';` to `packages/ui/src/index.ts`.

- [ ] **Step 5: Run the test**

Expected: PASS. Note the en dash in `51–100`; the test and the component must agree on it.

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/Pager.tsx packages/ui/src/Pager.test.tsx packages/ui/src/index.ts
git commit -m "feat(ui): a pager that says where you are"
```

---

### Task 7: The `ListControls` component

**Files:**
- Create: `packages/ui/src/ListControls.tsx`
- Modify: `packages/ui/src/index.ts`
- Test: `packages/ui/src/ListControls.test.tsx`

**Interfaces:**
- Consumes: `Field`, `Select` from `@syntra/ui`.
- Produces: `ListControls({ search, onSearch, status?, searchLabel? })`.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ListControls } from './ListControls.js';

describe('ListControls', () => {
  it('reports the search once typing settles, not once per keystroke', async () => {
    vi.useFakeTimers();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onSearch = vi.fn();
    render(<ListControls search="" onSearch={onSearch} searchLabel="Search people" />);

    await user.type(screen.getByLabelText('Search people'), 'arch');
    expect(onSearch).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(300);
    expect(onSearch).toHaveBeenCalledTimes(1);
    expect(onSearch).toHaveBeenCalledWith('arch');
    vi.useRealTimers();
  });

  it('shows the value it was given, so a URL with ?q= arrives populated', () => {
    render(<ListControls search="arch" onSearch={() => {}} searchLabel="Search people" />);
    expect(screen.getByLabelText('Search people')).toHaveValue('arch');
  });

  it('offers a status filter only when it is given one', () => {
    const { rerender } = render(
      <ListControls search="" onSearch={() => {}} searchLabel="Search" />,
    );
    expect(screen.queryByLabelText('Status')).toBeNull();

    rerender(
      <ListControls
        search=""
        onSearch={() => {}}
        searchLabel="Search"
        status={{
          value: '',
          onChange: () => {},
          options: [
            { value: '', label: 'Any status' },
            { value: 'active', label: 'Active' },
          ],
        }}
      />,
    );
    expect(screen.getByLabelText('Status')).toBeVisible();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```tsx
import { useEffect, useState } from 'react';
import { Field } from './Field.js';
import { Select } from './Select.js';

export interface ListControlsProps {
  /** The search currently in effect, which comes from the URL. */
  search: string;
  onSearch(value: string): void;
  searchLabel: string;
  status?:
    | {
        value: string;
        onChange(value: string): void;
        options: { value: string; label: string }[];
      }
    | undefined;
}

/** How long typing must settle before it becomes a request. */
const DEBOUNCE_MS = 250;

/**
 * The controls above a list.
 *
 * The input holds its own draft and reports it on a delay: the search in the
 * URL is the one in effect, and a keystroke is not yet a decision. Without
 * this, "archer" is six requests and five of them are already stale.
 */
export function ListControls({ search, onSearch, searchLabel, status }: ListControlsProps) {
  const [draft, setDraft] = useState(search);

  // The URL is the source of truth: back, forward, or a shared link changes
  // the search underneath us and the box must follow.
  useEffect(() => setDraft(search), [search]);

  useEffect(() => {
    if (draft === search) return;
    const timer = setTimeout(() => onSearch(draft), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft, search, onSearch]);

  return (
    <div className="mb-4 flex flex-wrap items-end gap-3">
      <Field
        label={searchLabel}
        type="search"
        value={draft}
        onChange={setDraft}
        placeholder="Name, login or id"
      />
      {status && (
        <Select
          label="Status"
          value={status.value}
          onChange={status.onChange}
          options={status.options}
        />
      )}
    </div>
  );
}
```

`onSearch` must be stable at the call site or the effect re-runs every render — wrap it in `useCallback` in each consumer (Tasks 9-10 do).

- [ ] **Step 4: Export, run, commit**

Add `export * from './ListControls.js';` to the index.
Run the test: expected PASS.

```bash
git add packages/ui/src/ListControls.tsx packages/ui/src/ListControls.test.tsx packages/ui/src/index.ts
git commit -m "feat(ui): a search box that waits for you to stop typing"
```

---

### Task 8: Tabs must not carry one list's search into another

**Files:**
- Modify: `apps/web/src/components/Tabs.tsx:44-77`
- Test: `apps/web/src/components/Tabs.test.tsx`

**Why:** People and Accounts are two tabs on `/admin/users`, so they share one query string. `select()` copies every existing param and sets `tab`, which would carry `?q=arch&page=3` from People into Accounts and show page 3 of a different list.

**Interfaces:**
- Produces: an optional `resetParams?: readonly string[] | undefined` prop on `Tabs`, cleared when the active tab changes.

- [ ] **Step 1: Write the failing test**

Add to `apps/web/src/components/Tabs.test.tsx` (create it if absent, following `PersonSourcesTab.test.tsx`'s render-with-MemoryRouter pattern):

```tsx
it('drops a panel’s own params when the tab changes', async () => {
  render(
    <MemoryRouter initialEntries={['/admin/users?tab=people&q=arch&page=3']}>
      <Tabs
        label="Directory"
        resetParams={['q', 'status', 'page']}
        tabs={[
          { id: 'people', label: 'People', content: <p>people</p> },
          { id: 'accounts', label: 'Accounts', content: <p>accounts</p> },
        ]}
      />
      <LocationProbe />
    </MemoryRouter>,
  );

  await userEvent.click(screen.getByRole('tab', { name: 'Accounts' }));

  expect(screen.getByTestId('search')).toHaveTextContent('?tab=accounts');
});
```

with a probe component in the same file:

```tsx
function LocationProbe() {
  const location = useLocation();
  return <span data-testid="search">{location.search}</span>;
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @syntra/web exec vitest run src/components/Tabs.test.tsx`
Expected: FAIL — the search still contains `q=arch&page=3`.

- [ ] **Step 3: Implement**

Add to the props interface:

```ts
  /**
   * Params belonging to a panel rather than to the page, cleared when the tab
   * changes. Two tabs share one query string: without this, a search and a
   * page number from People arrive in Accounts and silently apply to a
   * different list.
   */
  resetParams?: readonly string[] | undefined;
```

and in `select()`, after `const updated = new URLSearchParams(params);`:

```ts
    if (tab.id !== current.id) {
      for (const name of resetParams ?? []) updated.delete(name);
    }
```

- [ ] **Step 4: Run the test, then the whole web suite**

Run: `pnpm --filter @syntra/web exec vitest run src/components/Tabs.test.tsx`
Expected: PASS.
Run: `pnpm --filter @syntra/web test`
Expected: PASS — no existing caller passes `resetParams`, so behaviour is unchanged for them.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/Tabs.tsx apps/web/src/components/Tabs.test.tsx
git commit -m "feat(console): a tab does not inherit its neighbour's search"
```

---

### Task 9: `PeopleTab` — the pattern for the other two

**Files:**
- Modify: `apps/web/src/pages/admin/PeopleTab.tsx:36-45`
- Modify: `apps/web/src/pages/admin/UsersPage.tsx` (pass `resetParams` to `Tabs`)
- Test: `apps/web/src/pages/admin/PeopleTab.test.tsx`

**Interfaces:**
- Consumes: `ListControls`, `Pager` from Tasks 6-7; the envelope from Task 3.
- Produces: the URL contract `?q=&status=&page=` and the two-empty-states pattern the next task copies.

- [ ] **Step 1: Write the failing test**

```tsx
it('sends the search from the URL to the API', async () => {
  const fetchSpy = mockFetch({ persons: [], total: 0, page: 1, pageSize: 50 });
  render(
    <MemoryRouter initialEntries={['/admin/users?tab=people&q=arch']}>
      <PeopleTab />
    </MemoryRouter>,
  );
  await waitFor(() =>
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('q=arch'),
      expect.anything(),
    ),
  );
});

it('distinguishes an empty directory from a search that found nobody', async () => {
  mockFetch({ persons: [], total: 0, page: 1, pageSize: 50 });
  render(
    <MemoryRouter initialEntries={['/admin/users?tab=people&q=zzz']}>
      <PeopleTab />
    </MemoryRouter>,
  );
  expect(await screen.findByText(/Nobody matches/)).toBeVisible();
  expect(screen.getByRole('button', { name: /clear the search/i })).toBeVisible();
});

it('goes back to page one when the search changes', async () => {
  // Regression: leaving page=7 in the URL strands somebody on an empty table
  // that reads as broken.
  vi.useFakeTimers();
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const fetchSpy = mockFetch({ persons: [], total: 0, page: 7, pageSize: 50 });
  render(
    <MemoryRouter initialEntries={['/admin/users?tab=people&page=7']}>
      <PeopleTab />
    </MemoryRouter>,
  );
  await user.type(screen.getByLabelText('Search people'), 'arch');
  await vi.advanceTimersByTimeAsync(300);
  await waitFor(() => {
    const url = String(fetchSpy.mock.calls.at(-1)?.[0]);
    expect(url).toContain('q=arch');
    expect(url).not.toContain('page=7');
  });
  vi.useRealTimers();
});
```

Reuse `PersonSourcesTab.test.tsx`'s `json()` helper and make `mockFetch` return the spy so the assertions above work.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @syntra/web exec vitest run src/pages/admin/PeopleTab.test.tsx`
Expected: FAIL — no search box, no query params.

- [ ] **Step 3: Implement**

Replace the fetch in `PeopleTab.tsx` with:

```tsx
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const status = params.get('status') ?? '';
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1);

  const query = new URLSearchParams();
  if (q) query.set('q', q);
  if (status) query.set('status', status);
  if (page > 1) query.set('page', String(page));
  const qs = query.toString();

  const { data, error, loading } = useApiResource<{
    persons: PersonRow[];
    total: number;
    page: number;
    pageSize: number;
  }>(`/api/admin/persons${qs ? `?${qs}` : ''}`);

  const persons = data?.persons ?? [];
  const total = data?.total ?? 0;
  const pageSize = data?.pageSize ?? 50;
  const filtered = q !== '' || status !== '';

  // Every control writes through the URL: a search worth doing is worth
  // sending to somebody, and the back button should undo a filter rather than
  // leave the screen.
  const update = useCallback(
    (next: Record<string, string>) => {
      const merged = new URLSearchParams(params);
      for (const [key, value] of Object.entries(next)) {
        if (value) merged.set(key, value);
        else merged.delete(key);
      }
      setParams(merged, { replace: true });
    },
    [params, setParams],
  );

  // Page 1 on every narrowing: page 7 of a three-page result is an empty
  // table that reads as broken.
  const onSearch = useCallback((value: string) => update({ q: value, page: '' }), [update]);
  const onStatus = useCallback((value: string) => update({ status: value, page: '' }), [update]);
  const onPage = useCallback((next: number) => update({ page: String(next) }), [update]);
```

Render `<ListControls>` above the panel:

```tsx
      <ListControls
        search={q}
        onSearch={onSearch}
        searchLabel="Search people"
        status={{
          value: status,
          onChange: onStatus,
          options: [
            { value: '', label: 'Any status' },
            { value: 'active', label: 'Active' },
            { value: 'inactive', label: 'Inactive' },
          ],
        }}
      />
```

The empty state becomes two:

```tsx
          {!loading && persons.length === 0 && filtered && (
            <div className="p-6">
              <Empty
                title={`Nobody matches ${q || status}`}
                action={
                  <button
                    type="button"
                    className={buttonClasses('secondary')}
                    onClick={() => update({ q: '', status: '', page: '' })}
                  >
                    Clear the search
                  </button>
                }
              >
                Names, employee ids and work email addresses are searched.
              </Empty>
            </div>
          )}
```

keeping the existing "nothing here yet" empty state for `!filtered`. Render `<Pager page={page} pageSize={pageSize} total={total} onPage={onPage} />` below the table.

Imports to add: `useCallback` from react, `useSearchParams` from react-router-dom, `ListControls`, `Pager`, `buttonClasses` from `@syntra/ui`.

- [ ] **Step 4: Pass `resetParams` from UsersPage**

In `apps/web/src/pages/admin/UsersPage.tsx`, on the `<Tabs>` element: `resetParams={['q', 'status', 'page']}`.

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @syntra/web exec vitest run src/pages/admin/PeopleTab.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/pages/admin/PeopleTab.tsx apps/web/src/pages/admin/PeopleTab.test.tsx apps/web/src/pages/admin/UsersPage.tsx
git commit -m "feat(console): find a person"
```

---

### Task 10: `AccountsTab` and `GroupsPage`

**Files:**
- Modify: `apps/web/src/pages/admin/AccountsTab.tsx:71-75`
- Modify: `apps/web/src/pages/admin/GroupsPage.tsx:18-21`
- Test: `apps/web/src/pages/admin/AccountsTab.test.tsx`, `apps/web/src/pages/admin/GroupsPage.test.tsx`

**Interfaces:**
- Consumes: the pattern established in Task 9 — same param names, same reset-to-page-1 rule, same two empty states.

- [ ] **Step 1: Write the failing tests**

`apps/web/src/pages/admin/AccountsTab.test.tsx`:

```tsx
it('sends the search from the URL to the API', async () => {
  const fetchSpy = mockFetch({ users: [], total: 0, page: 1, pageSize: 50 });
  render(
    <MemoryRouter initialEntries={['/admin/users?tab=accounts&q=barcher']}>
      <AccountsTab />
    </MemoryRouter>,
  );
  await waitFor(() =>
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('q=barcher'),
      expect.anything(),
    ),
  );
});

it('distinguishes no accounts from no matching accounts', async () => {
  mockFetch({ users: [], total: 0, page: 1, pageSize: 50 });
  render(
    <MemoryRouter initialEntries={['/admin/users?tab=accounts&q=zzz']}>
      <AccountsTab />
    </MemoryRouter>,
  );
  expect(await screen.findByText(/No account matches/)).toBeVisible();
  expect(screen.getByRole('button', { name: /clear the search/i })).toBeVisible();
});

it('goes back to page one when the search changes', async () => {
  vi.useFakeTimers();
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const fetchSpy = mockFetch({ users: [], total: 0, page: 4, pageSize: 50 });
  render(
    <MemoryRouter initialEntries={['/admin/users?tab=accounts&page=4']}>
      <AccountsTab />
    </MemoryRouter>,
  );
  await user.type(screen.getByLabelText('Search accounts'), 'barch');
  await vi.advanceTimersByTimeAsync(300);
  await waitFor(() => {
    const url = String(fetchSpy.mock.calls.at(-1)?.[0]);
    expect(url).toContain('q=barch');
    expect(url).not.toContain('page=4');
  });
  vi.useRealTimers();
});
```

`apps/web/src/pages/admin/GroupsPage.test.tsx`:

```tsx
it('sends the search from the URL to the API', async () => {
  const fetchSpy = mockFetch({ groups: [], total: 0, page: 1, pageSize: 50 });
  render(
    <MemoryRouter initialEntries={['/admin/groups?q=payroll']}>
      <GroupsPage />
    </MemoryRouter>,
  );
  await waitFor(() =>
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('q=payroll'),
      expect.anything(),
    ),
  );
});

it('offers no status filter, because a group has no status', async () => {
  mockFetch({ groups: [], total: 0, page: 1, pageSize: 50 });
  render(
    <MemoryRouter initialEntries={['/admin/groups']}>
      <GroupsPage />
    </MemoryRouter>,
  );
  await screen.findByLabelText('Search groups');
  expect(screen.queryByLabelText('Status')).toBeNull();
});

it('says when a search matches no group, and offers to clear it', async () => {
  mockFetch({ groups: [], total: 0, page: 1, pageSize: 50 });
  render(
    <MemoryRouter initialEntries={['/admin/groups?q=zzz']}>
      <GroupsPage />
    </MemoryRouter>,
  );
  expect(await screen.findByText(/No group matches/)).toBeVisible();
  expect(screen.getByRole('button', { name: /clear the search/i })).toBeVisible();
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @syntra/web exec vitest run src/pages/admin/AccountsTab.test.tsx src/pages/admin/GroupsPage.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement AccountsTab**

Replace the fetch at `AccountsTab.tsx:71-75`:

```tsx
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const status = params.get('status') ?? '';
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1);

  const query = new URLSearchParams();
  if (q) query.set('q', q);
  if (status) query.set('status', status);
  if (page > 1) query.set('page', String(page));
  const qs = query.toString();

  const { data, error, loading, reload } = useApiResource<{
    users: UserRow[];
    total: number;
    page: number;
    pageSize: number;
  }>(`/api/admin/users${qs ? `?${qs}` : ''}`);

  const total = data?.total ?? 0;
  const pageSize = data?.pageSize ?? 50;
  const filtered = q !== '' || status !== '';

  const update = useCallback(
    (next: Record<string, string>) => {
      const merged = new URLSearchParams(params);
      for (const [key, value] of Object.entries(next)) {
        if (value) merged.set(key, value);
        else merged.delete(key);
      }
      setParams(merged, { replace: true });
    },
    [params, setParams],
  );

  const onSearch = useCallback((value: string) => update({ q: value, page: '' }), [update]);
  const onStatus = useCallback((value: string) => update({ status: value, page: '' }), [update]);
  const onPage = useCallback((next: number) => update({ page: String(next) }), [update]);
```

Above the table:

```tsx
      <ListControls
        search={q}
        onSearch={onSearch}
        searchLabel="Search accounts"
        status={{
          value: status,
          onChange: onStatus,
          options: [
            { value: '', label: 'Any status' },
            { value: 'active', label: 'Active' },
            { value: 'inactive', label: 'Inactive' },
          ],
        }}
      />
```

The filtered empty state, beside the existing one:

```tsx
          {!loading && (data?.users ?? []).length === 0 && filtered && (
            <div className="p-6">
              <Empty
                title={`No account matches ${q || status}`}
                action={
                  <button
                    type="button"
                    className={buttonClasses('secondary')}
                    onClick={() => update({ q: '', status: '', page: '' })}
                  >
                    Clear the search
                  </button>
                }
              >
                Logins, display names and work email addresses are searched.
              </Empty>
            </div>
          )}
```

and below the table: `<Pager page={page} pageSize={pageSize} total={total} onPage={onPage} />`.

Keep `reload` — the create and edit flows on this tab still call it.

- [ ] **Step 4: Implement GroupsPage**

`GroupsPage.tsx:18-21`, the same shape without a status filter:

```tsx
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1);

  const query = new URLSearchParams();
  if (q) query.set('q', q);
  if (page > 1) query.set('page', String(page));
  const qs = query.toString();

  const { data, error, loading, reload } = useApiResource<{
    groups: GroupRow[];
    total: number;
    page: number;
    pageSize: number;
  }>(`/api/admin/groups${qs ? `?${qs}` : ''}`);

  const total = data?.total ?? 0;
  const pageSize = data?.pageSize ?? 50;

  const update = useCallback(
    (next: Record<string, string>) => {
      const merged = new URLSearchParams(params);
      for (const [key, value] of Object.entries(next)) {
        if (value) merged.set(key, value);
        else merged.delete(key);
      }
      setParams(merged, { replace: true });
    },
    [params, setParams],
  );

  const onSearch = useCallback((value: string) => update({ q: value, page: '' }), [update]);
  const onPage = useCallback((next: number) => update({ page: String(next) }), [update]);
```

Render `<ListControls search={q} onSearch={onSearch} searchLabel="Search groups" />` with **no** `status` prop, because the route rejects one. The filtered empty state is titled `No group matches ${q}` with the same "Clear the search" button and the body text "Group names and descriptions are searched." Below the table, the same `<Pager>`.

Do NOT extract a shared hook across the three tabs. Three copies with three different field sets and three different empty-state sentences is the shape this codebase prefers over an abstraction that has to be understood before any single list can be read. If a fourth list arrives, that is when to reconsider.

- [ ] **Step 5: Run the tests and the whole web suite**

Run: `pnpm --filter @syntra/web test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/pages/admin/AccountsTab.tsx apps/web/src/pages/admin/GroupsPage.tsx apps/web/src/pages/admin/AccountsTab.test.tsx apps/web/src/pages/admin/GroupsPage.test.tsx
git commit -m "feat(console): find an account, find a group"
```

---

### Task 11: The pickers must not silently truncate

**Files:**
- Modify: `apps/web/src/pages/admin/AccountProfilePage.tsx:192`
- Modify: `apps/web/src/pages/admin/AccountsTab.tsx:92`
- Modify: `apps/web/src/pages/admin/ApplicationDetailPage.tsx:43-44`
- Modify: `apps/web/src/pages/admin/DelegatedTasksTab.tsx:317`
- Modify: `apps/web/src/pages/admin/GroupDetailPage.tsx:79`
- Modify: `apps/web/src/pages/admin/PersonDetailPage.tsx:90`
- Test: `apps/web/src/pages/admin/GroupDetailPage.test.tsx`

**Why:** six screens fetch a whole collection to fill a picker. After Task 3 they receive 50 rows and no indication there were more — a picker that is quietly missing the person you need is worse than one that admits it.

**Interfaces:**
- Consumes: the `total` field from the envelope.

- [ ] **Step 1: Write the failing test**

In `GroupDetailPage.test.tsx` (create following the existing console test pattern if absent):

```tsx
it('says so when the member picker is not showing everybody', async () => {
  mockFetch({ users: [{ id: 'u1', login: 'a', displayName: 'A' }], total: 900, page: 1, pageSize: 200 });
  render(
    <MemoryRouter initialEntries={['/admin/groups/g1']}>
      <GroupDetailPage />
    </MemoryRouter>,
  );
  expect(await screen.findByText(/showing the first 200 of 900/i)).toBeVisible();
});
```

- [ ] **Step 2: Run it to verify it fails**

Expected: FAIL — no such text.

- [ ] **Step 3: Ask for the ceiling, and say when it was hit**

At each of the six call sites, append `?pageSize=200` to the path and widen the response type with `total: number`. Where the picker renders, add:

```tsx
{total > rows.length && (
  <p className="text-sm text-muted">
    Showing the first {rows.length} of {total.toLocaleString()}. Use the People
    page to find someone who is not listed.
  </p>
)}
```

200 is the route's ceiling from Task 3, so this asks for the most a caller may
have. Word the second sentence for the screen that lists the record type this
picker chooses from:

| File | Picker chooses | Point at |
|---|---|---|
| `AccountProfilePage.tsx:192` | a person | `/admin/users?tab=people` |
| `AccountsTab.tsx:92` | a person | `/admin/users?tab=people` |
| `ApplicationDetailPage.tsx:43` | an account | `/admin/users?tab=accounts` |
| `ApplicationDetailPage.tsx:44` | a group | `/admin/groups` |
| `DelegatedTasksTab.tsx:317` | a group | `/admin/groups` |
| `GroupDetailPage.tsx:79` | an account | `/admin/users?tab=accounts` |
| `PersonDetailPage.tsx:90` | an account | `/admin/users?tab=accounts` |

- [ ] **Step 4: Run the full web suite**

Run: `pnpm --filter @syntra/web test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/admin
git commit -m "fix(console): a picker that cannot show everybody says so"
```

---

### Task 12: The stat cards

**Files:**
- Modify: `apps/web/src/pages/admin/UsersPage.tsx:36-45,60-75`
- Test: `apps/web/src/pages/admin/UsersPage.test.tsx`

**Interfaces:**
- Consumes: `GET /api/admin/directory/summary` from Task 5.

- [ ] **Step 1: Write the failing test**

```tsx
it('counts the whole directory, not the page it happens to be showing', async () => {
  mockFetchByPath({
    '/api/admin/directory/summary': {
      people: { total: 4312, active: 4000 },
      accounts: { total: 3900, active: 3800, locked: 7 },
    },
  });
  render(
    <MemoryRouter initialEntries={['/admin/users']}>
      <UsersPage />
    </MemoryRouter>,
  );
  expect(await screen.findByText('4,312')).toBeVisible();
  expect(screen.getByText('7')).toBeVisible();
});
```

`mockFetchByPath` routes by URL — write it in this file, returning the matching body for whichever path is requested and `{}` otherwise.

- [ ] **Step 2: Run it to verify it fails**

Expected: FAIL — the page counts array lengths.

- [ ] **Step 3: Implement**

Replace the two full-collection fetches and the four derived counts with one:

```tsx
  const summary = useApiResource<{
    people: { total: number; active: number };
    accounts: { total: number; active: number; locked: number };
  }>('/api/admin/directory/summary');

  const peopleCount = summary.data?.people.total ?? 0;
  const activePeople = summary.data?.people.active ?? 0;
  const accountCount = summary.data?.accounts.total ?? 0;
  const lockedCount = summary.data?.accounts.locked ?? 0;
```

`awaiting` keeps its existing derivation from `activePeople` and `accountCount`. The tab badges, which counted the same arrays, now read `peopleCount` and `accountCount`.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @syntra/web test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/admin/UsersPage.tsx apps/web/src/pages/admin/UsersPage.test.tsx
git commit -m "feat(console): count the directory, not the page"
```

---

### Task 13: End to end

**Files:**
- Create: `e2e/list-paging.spec.ts`

- [ ] **Step 1: Write the spec**

```ts
import { expect, test } from '@playwright/test';
import { ADMIN, elevateTo, signInAndLand } from './support.js';

test('pages and searches the people list', async ({ page }) => {
  await signInAndLand(page, 'admin', ADMIN!);
  // pageSize=2 rather than seeding fifty-one people: the boundary is the
  // subject, and the number that produces it is arbitrary.
  await elevateTo(page, '/admin/users?tab=people&pageSize=2', ADMIN!);

  await expect(page.getByRole('button', { name: 'Previous' })).toBeDisabled();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page).toHaveURL(/page=2/);

  await page.getByLabel('Search people').fill('zzz-nobody');
  await expect(page.getByText(/Nobody matches/)).toBeVisible();
  await expect(page).not.toHaveURL(/page=2/);
});
```

Read `e2e/person-sources.spec.ts` for the real names of the sign-in helpers and import them the same way. Note that `pageSize` must be forwarded from the URL by `PeopleTab` for this to work — if Task 9 did not carry it through, either add it there or seed enough people instead.

- [ ] **Step 2: Run it against a running stack**

Run: `npx playwright test e2e/list-paging.spec.ts`
Expected: PASS. This needs the API and console running (`pnpm dev`); the CI `browser` job runs it otherwise.

- [ ] **Step 3: Commit**

```bash
git add e2e/list-paging.spec.ts
git commit -m "test(e2e): find a person who is not on the first page"
```

---

## Final verification

- [ ] `npx tsc -b` exits 0
- [ ] `npx vitest run` — full core and API suite passes
- [ ] `pnpm --filter @syntra/web test` — console suite passes
- [ ] `bash ops/syntra-update.test.sh` and `bash ops/syntra-backup.test.sh` still pass (untouched, but they are cheap and CI runs them)
- [ ] Manually: load `/admin/users?tab=people`, search, page, copy the URL into a new tab and confirm it arrives in the same state
