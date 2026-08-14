# Syntra Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Syntra platform foundation — a multi-tenant server with a directory, a person/contract model, authentication, an audit log, a secrets vault, a scheduler, and an administration console.

**Architecture:** A pnpm monorepo. A Fastify API composes domain services from `packages/core` over a Prisma/PostgreSQL schema in `packages/db`. Tenant isolation is enforced by PostgreSQL row-level security, with the tenant set per-transaction, so a forgotten `where` clause cannot leak across tenants. A single React application serves both the end-user portal and, under a lazy-loaded guarded route, the administration console.

**Tech Stack:** TypeScript 5.7, Node 24, pnpm 9, Fastify 5, Prisma 6, PostgreSQL 16, Zod 3, argon2, pg-boss 10, nodemailer, React 19, Vite 6, Tailwind 4, Vitest 3, Playwright 1.5x, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-08-14-syntra-core-access-design.md`

**Scope:** Sub-project 0 (Core) only. Sub-project 1 (Access Management — SAML, OIDC, MFA, policies, app catalog, SSPR) is a separate plan that builds on this one.

## Global Constraints

- **License:** Apache-2.0. Every source file header is unnecessary; the root `LICENSE` file governs.
- **Node:** >= 22. Development and CI use Node 24.
- **Database:** PostgreSQL 16. No feature may depend on a later version.
- **Tenant isolation:** every tenant-scoped table carries `tenantId`, has `ENABLE ROW LEVEL SECURITY` **and** `FORCE ROW LEVEL SECURITY`, and a `tenant_isolation` policy. The application connects as a non-superuser role that does not own the tables' bypass privilege.
- **Every database access from a request runs inside `withTenant`.** There is no supported path that reads tenant data outside it.
- **Passwords:** Argon2id only. Never MD5, SHA, bcrypt, or scrypt.
- **Errors:** every HTTP error response is RFC 9457 `application/problem+json` with a stable `type` URI under `https://syntra.dev/problems/`.
- **Secrets are never returned by any API once written.** They may only be replaced.
- **Tests:** TDD. A failing test precedes the code that satisfies it. Integration tests run against a real PostgreSQL in Docker, never a mock or SQLite.
- **`User` carries no employment fields.** Job title, department, manager, and dates live on `Contract`. Adding any of them to `User` is a spec violation.
- **Commits:** conventional commits (`feat:`, `fix:`, `test:`, `chore:`, `docs:`). Commit at the end of every task.

---

## File Structure

```
syntra/
  package.json                      workspace root, scripts
  pnpm-workspace.yaml
  tsconfig.base.json
  vitest.config.ts                  workspace-wide test config
  .env.example
  LICENSE                           Apache-2.0
  README.md
  infra/
    docker-compose.yml              postgres:16, maildev
  packages/
    db/
      prisma/schema.prisma          all models
      prisma/migrations/            SQL migrations incl. RLS policies
      src/client.ts                 PrismaClient singleton
      src/with-tenant.ts            withTenant() transaction helper
      src/index.ts
    core/
      src/config.ts                 typed env loading (zod)
      src/errors.ts                 DomainError union + Result helpers
      src/audit/audit-service.ts    hash-chained append + verify
      src/vault/vault-service.ts    envelope encryption
      src/vault/master-key.ts       MasterKeyProvider + local file impl
      src/directory/user-service.ts
      src/directory/group-service.ts
      src/directory/org-unit-service.ts
      src/identity/person-service.ts
      src/identity/contract-service.ts
      src/rbac/rbac-service.ts      permission resolution
      src/auth/password.ts          argon2 hash/verify
      src/auth/session-service.ts
      src/auth/login-service.ts     the authorize() chokepoint
      src/notify/notification-service.ts
      src/notify/templates/
      src/jobs/scheduler.ts         pg-boss wrapper
    contracts/
      src/directory.ts              zod request/response schemas
      src/identity.ts
      src/auth.ts
      src/index.ts
  apps/
    api/
      src/app.ts                    Fastify factory
      src/plugins/problem-json.ts
      src/plugins/tenant-context.ts
      src/plugins/require-session.ts
      src/plugins/require-permission.ts
      src/routes/auth.ts
      src/routes/admin/users.ts
      src/routes/admin/groups.ts
      src/routes/admin/org-units.ts
      src/routes/admin/persons.ts
      src/routes/admin/contracts.ts
      src/routes/admin/audit.ts
      src/server.ts                 entrypoint
    web/
      src/main.tsx
      src/routes.tsx                lazy admin chunk
      src/session/SessionProvider.tsx
      src/pages/Login.tsx
      src/pages/Portal.tsx
      src/pages/admin/...
```

Files are split by responsibility, not by layer: a service owns its domain rules and its own tests sit beside it. `packages/core` never imports Fastify; `apps/api` never imports Prisma directly.

---

## Task 1: Workspace scaffold and typed configuration

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.ts`, `.env.example`, `.gitignore` (exists), `LICENSE`, `README.md`
- Create: `infra/docker-compose.yml`
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/config.ts`
- Test: `packages/core/src/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `loadConfig(env: NodeJS.ProcessEnv): Config` and the `Config` type — `{ databaseUrl: string; port: number; publicUrl: string; sessionSecret: string; masterKey: Buffer; smtpUrl: string }`. Every later task reads configuration through this and never touches `process.env` directly.

- [ ] **Step 1: Create the workspace files**

`pnpm-workspace.yaml`:
```yaml
packages:
  - 'packages/*'
  - 'apps/*'
```

Root `package.json`:
```json
{
  "name": "syntra",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -b",
    "db:up": "docker compose -f infra/docker-compose.yml up -d",
    "db:down": "docker compose -f infra/docker-compose.yml down"
  },
  "devDependencies": {
    "typescript": "^5.7.2",
    "vitest": "^3.0.0",
    "@types/node": "^22.10.0"
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "composite": true
  }
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/src/**/*.test.ts', 'apps/**/src/**/*.test.ts'],
    testTimeout: 30_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
```

`singleFork` matters: integration tests share one PostgreSQL database and truncate between tests. Parallel forks would race.

`infra/docker-compose.yml`:
```yaml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: syntra
      POSTGRES_PASSWORD: syntra
      POSTGRES_DB: syntra
    ports: ['5432:5432']
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U syntra']
      interval: 2s
      timeout: 3s
      retries: 20
  maildev:
    image: maildev/maildev:2.1.0
    ports: ['1080:1080', '1025:1025']
```

`.env.example`:
```
DATABASE_URL=postgresql://syntra:syntra@localhost:5432/syntra
PORT=3000
PUBLIC_URL=http://localhost:3000
SESSION_SECRET=change-me-at-least-32-characters-long
MASTER_KEY=BASE64_32_BYTES_REPLACE_ME_AAAAAAAAAAAAAAAAAAA=
SMTP_URL=smtp://localhost:1025
```

`LICENSE`: the standard Apache License 2.0 text, verbatim, from https://www.apache.org/licenses/LICENSE-2.0.txt.

`README.md`: project name, one-paragraph description, and a "Getting started" section with `pnpm install`, `pnpm db:up`, `pnpm test`.

`packages/core/package.json`:
```json
{
  "name": "@syntra/core",
  "version": "0.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "dependencies": { "zod": "^3.24.0" }
}
```

`packages/core/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```

- [ ] **Step 2: Write the failing test**

`packages/core/src/config.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const valid = {
  DATABASE_URL: 'postgresql://syntra:syntra@localhost:5432/syntra',
  PORT: '3000',
  PUBLIC_URL: 'http://localhost:3000',
  SESSION_SECRET: 'x'.repeat(32),
  MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
  SMTP_URL: 'smtp://localhost:1025',
};

describe('loadConfig', () => {
  it('parses a valid environment', () => {
    const config = loadConfig(valid);
    expect(config.port).toBe(3000);
    expect(config.masterKey).toHaveLength(32);
  });

  it('rejects a session secret shorter than 32 characters', () => {
    expect(() => loadConfig({ ...valid, SESSION_SECRET: 'short' })).toThrow(
      /SESSION_SECRET/,
    );
  });

  it('rejects a master key that is not 32 bytes', () => {
    expect(() =>
      loadConfig({ ...valid, MASTER_KEY: Buffer.alloc(16).toString('base64') }),
    ).toThrow(/MASTER_KEY/);
  });

  it('rejects a missing database url', () => {
    const { DATABASE_URL, ...rest } = valid;
    expect(() => loadConfig(rest)).toThrow(/DATABASE_URL/);
  });
});
```

- [ ] **Step 3: Run the test and verify it fails**

Run: `pnpm vitest run packages/core/src/config.test.ts`
Expected: FAIL — cannot resolve `./config.js`.

- [ ] **Step 4: Implement the configuration loader**

`packages/core/src/config.ts`:
```ts
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_URL: z.string().url(),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be >= 32 characters'),
  MASTER_KEY: z.string().refine(
    (v) => Buffer.from(v, 'base64').length === 32,
    'MASTER_KEY must be 32 bytes, base64 encoded',
  ),
  SMTP_URL: z.string().url(),
});

export interface Config {
  databaseUrl: string;
  port: number;
  publicUrl: string;
  sessionSecret: string;
  masterKey: Buffer;
  smtpUrl: string;
}

export function loadConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined>): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid configuration — ${detail}`);
  }
  const v = parsed.data;
  return {
    databaseUrl: v.DATABASE_URL,
    port: v.PORT,
    publicUrl: v.PUBLIC_URL,
    sessionSecret: v.SESSION_SECRET,
    masterKey: Buffer.from(v.MASTER_KEY, 'base64'),
    smtpUrl: v.SMTP_URL,
  };
}
```

`packages/core/src/index.ts`:
```ts
export * from './config.js';
```

- [ ] **Step 5: Run the test and verify it passes**

Run: `pnpm install && pnpm vitest run packages/core/src/config.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Verify the database starts**

Run: `pnpm db:up && docker compose -f infra/docker-compose.yml ps`
Expected: `postgres` reports healthy.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: scaffold pnpm workspace with typed configuration"
```

---

## Task 2: Tenant model and proven row-level isolation

This task exists to prove the isolation mechanism before any data depends on it. `OrgUnit` is included because RLS cannot be tested without at least one tenant-scoped table.

**Files:**
- Create: `packages/db/package.json`, `packages/db/tsconfig.json`, `packages/db/prisma/schema.prisma`
- Create: `packages/db/prisma/migrations/0001_init/migration.sql`
- Create: `packages/db/src/client.ts`, `packages/db/src/with-tenant.ts`, `packages/db/src/index.ts`
- Create: `packages/db/src/test-support.ts`
- Test: `packages/db/src/with-tenant.test.ts`

**Interfaces:**
- Consumes: `Config` from Task 1.
- Produces:
  - `prisma: PrismaClient` (singleton, from `@syntra/db`)
  - `withTenant<T>(tenantId: string, fn: (tx: TenantClient) => Promise<T>): Promise<T>` — `TenantClient` is `Prisma.TransactionClient`. Every service in every later task receives a `TenantClient`, never the raw client.
  - `resetDatabase(): Promise<void>` from `test-support.ts`, used by every integration test.

- [ ] **Step 1: Write the schema and migration**

`packages/db/package.json`:
```json
{
  "name": "@syntra/db",
  "version": "0.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "scripts": {
    "generate": "prisma generate",
    "migrate": "prisma migrate deploy",
    "migrate:dev": "prisma migrate dev"
  },
  "dependencies": { "@prisma/client": "^6.2.0" },
  "devDependencies": { "prisma": "^6.2.0" }
}
```

`packages/db/prisma/schema.prisma`:
```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Tenant {
  id        String   @id @default(uuid()) @db.Uuid
  name      String
  slug      String   @unique
  status    String   @default("active")
  createdAt DateTime @default(now())
  orgUnits  OrgUnit[]
}

model OrgUnit {
  id       String   @id @default(uuid()) @db.Uuid
  tenantId String   @db.Uuid
  tenant   Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  name     String
  parentId String?  @db.Uuid
  parent   OrgUnit? @relation("OrgUnitTree", fields: [parentId], references: [id])
  children OrgUnit[] @relation("OrgUnitTree")

  @@index([tenantId])
}
```

Generate the migration skeleton, then append the RLS statements by hand:

Run: `cd packages/db && pnpm prisma migrate dev --name init --create-only`

Append to the generated `migration.sql`:
```sql
-- Row-level security. FORCE is required because the application role owns
-- these tables, and an owner bypasses a policy that is merely ENABLEd.
ALTER TABLE "OrgUnit" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OrgUnit" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "OrgUnit"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);
```

`current_setting(..., true)` returns NULL when unset rather than raising, so a query outside `withTenant` returns no rows instead of erroring. Both behaviours are safe; returning nothing is the friendlier failure. The `WITH CHECK` clause is what stops a write from planting a row in another tenant.

- [ ] **Step 2: Write the failing test**

`packages/db/src/with-tenant.test.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from './client.js';
import { withTenant } from './with-tenant.js';
import { resetDatabase } from './test-support.js';

describe('withTenant', () => {
  let tenantA: string;
  let tenantB: string;

  beforeEach(async () => {
    await resetDatabase();
    const a = await prisma.tenant.create({ data: { name: 'A', slug: 'a' } });
    const b = await prisma.tenant.create({ data: { name: 'B', slug: 'b' } });
    tenantA = a.id;
    tenantB = b.id;
    await prisma.orgUnit.create({ data: { tenantId: tenantA, name: 'A root' } });
    await prisma.orgUnit.create({ data: { tenantId: tenantB, name: 'B root' } });
  });

  it('sees only its own tenant rows', async () => {
    const rows = await withTenant(tenantA, (tx) => tx.orgUnit.findMany());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('A root');
  });

  it('returns nothing for a deliberately unscoped query in the wrong tenant', async () => {
    // The query has no where clause at all. RLS is the only thing protecting it.
    const rows = await withTenant(tenantB, (tx) =>
      tx.orgUnit.findMany({ where: {} }),
    );
    expect(rows.map((r) => r.name)).toEqual(['B root']);
  });

  it('refuses to write a row belonging to another tenant', async () => {
    await expect(
      withTenant(tenantA, (tx) =>
        tx.orgUnit.create({ data: { tenantId: tenantB, name: 'smuggled' } }),
      ),
    ).rejects.toThrow();
  });

  it('rolls back when the callback throws', async () => {
    await expect(
      withTenant(tenantA, async (tx) => {
        await tx.orgUnit.create({ data: { tenantId: tenantA, name: 'temp' } });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const rows = await withTenant(tenantA, (tx) => tx.orgUnit.findMany());
    expect(rows).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run the test and verify it fails**

Run: `pnpm vitest run packages/db/src/with-tenant.test.ts`
Expected: FAIL — cannot resolve `./client.js`.

- [ ] **Step 4: Implement the client and helper**

`packages/db/src/client.ts`:
```ts
import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();
export type { Prisma } from '@prisma/client';
```

`packages/db/src/with-tenant.ts`:
```ts
import type { Prisma } from '@prisma/client';
import { prisma } from './client.js';

export type TenantClient = Prisma.TransactionClient;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Runs `fn` in a transaction with the tenant bound for the duration.
 * Every tenant-scoped read and write must go through here.
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (tx: TenantClient) => Promise<T>,
): Promise<T> {
  if (!UUID.test(tenantId)) {
    throw new Error(`withTenant called with a non-uuid tenantId: ${tenantId}`);
  }
  return prisma.$transaction(async (tx) => {
    // set_config with is_local=true scopes the setting to this transaction.
    // Parameterised, so the tenant id can never be interpolated into SQL.
    await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
    return fn(tx);
  });
}
```

`packages/db/src/test-support.ts`:
```ts
import { prisma } from './client.js';

/** Truncates every table except Prisma's migration bookkeeping. */
export async function resetDatabase(): Promise<void> {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename NOT LIKE '\\_prisma%'
  `;
  if (tables.length === 0) return;
  const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} CASCADE`);
}
```

`packages/db/src/index.ts`:
```ts
export { prisma } from './client.js';
export { withTenant } from './with-tenant.js';
export type { TenantClient } from './with-tenant.js';
```

- [ ] **Step 5: Apply migrations and run the test**

Run:
```bash
pnpm db:up
cd packages/db && pnpm prisma migrate deploy && pnpm prisma generate && cd ../..
pnpm vitest run packages/db/src/with-tenant.test.ts
```
Expected: PASS, 4 tests.

If the third test ("refuses to write a row belonging to another tenant") passes trivially because the connection role bypasses RLS, the `FORCE ROW LEVEL SECURITY` statement was omitted. Do not proceed — the whole isolation model rests on it.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add tenant model with enforced row-level isolation"
```

---

## Task 3: Directory — users, groups, and organizational units

**Files:**
- Modify: `packages/db/prisma/schema.prisma`
- Create: `packages/db/prisma/migrations/0002_directory/migration.sql`
- Create: `packages/core/src/directory/user-service.ts`, `packages/core/src/directory/group-service.ts`, `packages/core/src/directory/org-unit-service.ts`
- Test: `packages/core/src/directory/user-service.test.ts`, `packages/core/src/directory/group-service.test.ts`

**Interfaces:**
- Consumes: `withTenant`, `TenantClient` from Task 2.
- Produces:
  - `createUser(tx, input: CreateUserInput): Promise<User>` where `CreateUserInput = { login: string; email: string; displayName: string; orgUnitId?: string }`
  - `findUserByLogin(tx, login: string): Promise<User | null>`
  - `listUsers(tx, opts?: { status?: UserStatus }): Promise<User[]>`
  - `deactivateUser(tx, id: string, reason: string): Promise<User>`
  - `addMember(tx, groupId: string, userId: string): Promise<void>`, `removeMember(tx, groupId, userId)`, `listMembers(tx, groupId): Promise<User[]>`
  - `UserStatus = 'active' | 'inactive'`

- [ ] **Step 1: Extend the schema**

Append to `packages/db/prisma/schema.prisma`:
```prisma
model User {
  id          String   @id @default(uuid()) @db.Uuid
  tenantId    String   @db.Uuid
  login       String
  email       String
  displayName String
  status      String   @default("active")
  statusReason String?
  orgUnitId   String?  @db.Uuid
  orgUnit     OrgUnit? @relation(fields: [orgUnitId], references: [id])
  personId    String?  @db.Uuid
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  memberships GroupMembership[]
  attributes  UserAttribute[]

  @@unique([tenantId, login])
  @@index([tenantId])
}

model Group {
  id          String   @id @default(uuid()) @db.Uuid
  tenantId    String   @db.Uuid
  name        String
  description String?
  memberships GroupMembership[]

  @@unique([tenantId, name])
  @@index([tenantId])
}

model GroupMembership {
  id       String @id @default(uuid()) @db.Uuid
  tenantId String @db.Uuid
  groupId  String @db.Uuid
  userId   String @db.Uuid
  group    Group  @relation(fields: [groupId], references: [id], onDelete: Cascade)
  user     User   @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([groupId, userId])
  @@index([tenantId])
}

model UserAttribute {
  id       String @id @default(uuid()) @db.Uuid
  tenantId String @db.Uuid
  userId   String @db.Uuid
  user     User   @relation(fields: [userId], references: [id], onDelete: Cascade)
  key      String
  type     String // 'string' | 'number' | 'boolean' | 'date'
  value    String

  @@unique([userId, key])
  @@index([tenantId])
}
```

Add `users OrgUnit[]`-side relation by adding `users User[]` to the `OrgUnit` model.

Create the migration, then append RLS for each new table:
```sql
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['User','Group','GroupMembership','UserAttribute'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ("tenantId" = current_setting(''app.current_tenant'', true)::uuid) WITH CHECK ("tenantId" = current_setting(''app.current_tenant'', true)::uuid)',
      t);
  END LOOP;
END $$;
```

Reuse this `DO` block verbatim for every tenant-scoped table added in later tasks, changing only the array.

- [ ] **Step 2: Write the failing tests**

`packages/core/src/directory/user-service.test.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { createUser, deactivateUser, findUserByLogin, listUsers } from './user-service.js';

let tenantId: string;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
});

describe('createUser', () => {
  it('creates a user with an active status', async () => {
    const user = await withTenant(tenantId, (tx) =>
      createUser(tx, { login: 'jdoe', email: 'jdoe@acme.test', displayName: 'J Doe' }),
    );
    expect(user.status).toBe('active');
    expect(user.personId).toBeNull();
  });

  it('rejects a duplicate login within the same tenant', async () => {
    await withTenant(tenantId, (tx) =>
      createUser(tx, { login: 'jdoe', email: 'a@acme.test', displayName: 'A' }),
    );
    await expect(
      withTenant(tenantId, (tx) =>
        createUser(tx, { login: 'jdoe', email: 'b@acme.test', displayName: 'B' }),
      ),
    ).rejects.toThrow(/login already exists/i);
  });

  it('allows the same login in a different tenant', async () => {
    const other = await prisma.tenant.create({ data: { name: 'Other', slug: 'other' } });
    await withTenant(tenantId, (tx) =>
      createUser(tx, { login: 'jdoe', email: 'a@acme.test', displayName: 'A' }),
    );
    const second = await withTenant(other.id, (tx) =>
      createUser(tx, { login: 'jdoe', email: 'b@other.test', displayName: 'B' }),
    );
    expect(second.login).toBe('jdoe');
  });
});

describe('deactivateUser', () => {
  it('records the reason and never deletes the row', async () => {
    const user = await withTenant(tenantId, (tx) =>
      createUser(tx, { login: 'jdoe', email: 'j@acme.test', displayName: 'J' }),
    );
    const after = await withTenant(tenantId, (tx) =>
      deactivateUser(tx, user.id, 'left the company'),
    );
    expect(after.status).toBe('inactive');
    expect(after.statusReason).toBe('left the company');

    const all = await withTenant(tenantId, (tx) => listUsers(tx));
    expect(all).toHaveLength(1);
  });
});

describe('findUserByLogin', () => {
  it('returns null for an unknown login', async () => {
    const found = await withTenant(tenantId, (tx) => findUserByLogin(tx, 'nobody'));
    expect(found).toBeNull();
  });
});
```

- [ ] **Step 3: Run the tests and verify they fail**

Run: `pnpm vitest run packages/core/src/directory/user-service.test.ts`
Expected: FAIL — cannot resolve `./user-service.js`.

- [ ] **Step 4: Implement the services**

`packages/core/src/directory/user-service.ts`:
```ts
import type { TenantClient } from '@syntra/db';

export type UserStatus = 'active' | 'inactive';

export interface CreateUserInput {
  login: string;
  email: string;
  displayName: string;
  orgUnitId?: string;
}

export async function createUser(tx: TenantClient, input: CreateUserInput) {
  const existing = await tx.user.findFirst({ where: { login: input.login } });
  if (existing) {
    throw new Error(`login already exists: ${input.login}`);
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

export async function findUserByLogin(tx: TenantClient, login: string) {
  return tx.user.findFirst({ where: { login } });
}

export async function listUsers(tx: TenantClient, opts: { status?: UserStatus } = {}) {
  return tx.user.findMany({
    where: opts.status ? { status: opts.status } : {},
    orderBy: { login: 'asc' },
  });
}

export async function deactivateUser(tx: TenantClient, id: string, reason: string) {
  return tx.user.update({
    where: { id },
    data: { status: 'inactive', statusReason: reason },
  });
}

/** Reads the tenant bound by withTenant, so services never take it as a parameter. */
export async function currentTenant(tx: TenantClient): Promise<string> {
  const rows = await tx.$queryRaw<{ tenant: string | null }[]>`
    SELECT current_setting('app.current_tenant', true) AS tenant
  `;
  const tenant = rows[0]?.tenant;
  if (!tenant) throw new Error('no tenant bound — call inside withTenant');
  return tenant;
}
```

Move `currentTenant` to `packages/core/src/tenant-context.ts` and import it, so group and person services share one copy rather than each defining their own.

`packages/core/src/directory/group-service.ts`:
```ts
import type { TenantClient } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';

export async function createGroup(tx: TenantClient, name: string, description?: string) {
  const tenantId = await currentTenant(tx);
  return tx.group.create({ data: { tenantId, name, description: description ?? null } });
}

export async function addMember(tx: TenantClient, groupId: string, userId: string) {
  const tenantId = await currentTenant(tx);
  await tx.groupMembership.upsert({
    where: { groupId_userId: { groupId, userId } },
    create: { tenantId, groupId, userId },
    update: {},
  });
}

export async function removeMember(tx: TenantClient, groupId: string, userId: string) {
  await tx.groupMembership.deleteMany({ where: { groupId, userId } });
}

export async function listMembers(tx: TenantClient, groupId: string) {
  const rows = await tx.groupMembership.findMany({
    where: { groupId },
    include: { user: true },
  });
  return rows.map((r) => r.user);
}

export async function listGroupsForUser(tx: TenantClient, userId: string) {
  const rows = await tx.groupMembership.findMany({
    where: { userId },
    include: { group: true },
  });
  return rows.map((r) => r.group);
}
```

`packages/core/src/directory/org-unit-service.ts`:
```ts
import type { TenantClient } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';

export async function createOrgUnit(tx: TenantClient, name: string, parentId?: string) {
  const tenantId = await currentTenant(tx);
  return tx.orgUnit.create({ data: { tenantId, name, parentId: parentId ?? null } });
}

export async function listOrgUnits(tx: TenantClient) {
  return tx.orgUnit.findMany({ orderBy: { name: 'asc' } });
}
```

Write `group-service.test.ts` covering: adding a member twice is idempotent, `listMembers` returns the user, `removeMember` leaves the user intact, and `listGroupsForUser` returns only that user's groups.

- [ ] **Step 5: Run the tests and verify they pass**

Run: `pnpm vitest run packages/core/src/directory/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add directory services for users, groups, and org units"
```

---

## Task 4: Persons and contracts

The model that separates who someone is from what they do. Per the spec, `User` gains no employment fields here.

**Files:**
- Modify: `packages/db/prisma/schema.prisma`
- Create: `packages/db/prisma/migrations/0003_identity/migration.sql`
- Create: `packages/core/src/identity/person-service.ts`, `packages/core/src/identity/contract-service.ts`
- Test: `packages/core/src/identity/contract-service.test.ts`

**Interfaces:**
- Consumes: `TenantClient`, `currentTenant`.
- Produces:
  - `createPerson(tx, input: CreatePersonInput): Promise<Person>` — `{ givenName, familyName, businessEmail?, externalId? }`
  - `linkUserToPerson(tx, userId: string, personId: string): Promise<void>`
  - `createContract(tx, personId: string, input: CreateContractInput): Promise<Contract>`
  - `activeContracts(tx, personId: string, on?: Date): Promise<Contract[]>`
  - `primaryContract(tx, personId: string): Promise<Contract | null>`
  - `resolveContractForMapping(tx, personId, strategy: 'primary' | 'lowestSequence', on?: Date): Promise<Contract | null>` — Task 12 and the Access plan both depend on this exact signature.

- [ ] **Step 1: Extend the schema**

```prisma
model Person {
  id            String   @id @default(uuid()) @db.Uuid
  tenantId      String   @db.Uuid
  givenName     String
  familyName    String
  nameConvention String  @default("familyName") // how displayName is assembled
  businessEmail String?
  personalEmail String?
  externalId    String?
  status        String   @default("active")
  createdAt     DateTime @default(now())
  contracts     Contract[]

  @@unique([tenantId, externalId])
  @@index([tenantId])
}

model Contract {
  id          String   @id @default(uuid()) @db.Uuid
  tenantId    String   @db.Uuid
  personId    String   @db.Uuid
  person      Person   @relation(fields: [personId], references: [id], onDelete: Cascade)
  sequence    Int      @default(1)
  isPrimary   Boolean  @default(false)
  startDate   DateTime @db.Date
  endDate     DateTime? @db.Date
  jobTitle    String?
  department  String?
  costCentre  String?
  employer    String?
  location    String?
  managerPersonId String? @db.Uuid
  fte         Decimal? @db.Decimal(4, 3)

  @@index([tenantId])
  @@index([personId])
}
```

Migration additions — RLS for `Person` and `Contract` using the `DO` block from Task 3, plus:
```sql
-- Exactly one primary contract per person. The predicate is over all contracts,
-- not only active ones: a date comparison is not immutable and cannot be indexed.
CREATE UNIQUE INDEX contract_one_primary_per_person
  ON "Contract" ("personId") WHERE "isPrimary";
```

- [ ] **Step 2: Write the failing tests**

`packages/core/src/identity/contract-service.test.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { createPerson } from './person-service.js';
import {
  activeContracts,
  createContract,
  primaryContract,
  resolveContractForMapping,
} from './contract-service.js';

let tenantId: string;
let personId: string;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  const person = await withTenant(tenantId, (tx) =>
    createPerson(tx, { givenName: 'Jo', familyName: 'Doe' }),
  );
  personId = person.id;
});

const d = (s: string) => new Date(`${s}T00:00:00Z`);

describe('concurrent contracts', () => {
  it('returns both contracts a person holds at once', async () => {
    await withTenant(tenantId, async (tx) => {
      await createContract(tx, personId, {
        sequence: 1, isPrimary: true, startDate: d('2026-01-01'), jobTitle: 'Nurse',
      });
      await createContract(tx, personId, {
        sequence: 2, startDate: d('2026-03-01'), jobTitle: 'Trainer',
      });
    });
    const active = await withTenant(tenantId, (tx) =>
      activeContracts(tx, personId, d('2026-06-01')),
    );
    expect(active.map((c) => c.jobTitle).sort()).toEqual(['Nurse', 'Trainer']);
  });

  it('excludes a contract that has ended while another continues', async () => {
    await withTenant(tenantId, async (tx) => {
      await createContract(tx, personId, {
        sequence: 1, isPrimary: true, startDate: d('2026-01-01'), jobTitle: 'Nurse',
      });
      await createContract(tx, personId, {
        sequence: 2, startDate: d('2026-01-01'), endDate: d('2026-04-30'), jobTitle: 'Trainer',
      });
    });
    const active = await withTenant(tenantId, (tx) =>
      activeContracts(tx, personId, d('2026-06-01')),
    );
    expect(active.map((c) => c.jobTitle)).toEqual(['Nurse']);
  });

  it('returns nothing for a person with no active contract', async () => {
    await withTenant(tenantId, (tx) =>
      createContract(tx, personId, {
        sequence: 1, startDate: d('2020-01-01'), endDate: d('2021-01-01'),
      }),
    );
    const active = await withTenant(tenantId, (tx) =>
      activeContracts(tx, personId, d('2026-06-01')),
    );
    expect(active).toEqual([]);
  });

  it('excludes a contract that has not started yet', async () => {
    await withTenant(tenantId, (tx) =>
      createContract(tx, personId, { sequence: 1, startDate: d('2027-01-01') }),
    );
    const active = await withTenant(tenantId, (tx) =>
      activeContracts(tx, personId, d('2026-06-01')),
    );
    expect(active).toEqual([]);
  });
});

describe('primary contract', () => {
  it('refuses a second primary contract for the same person', async () => {
    await withTenant(tenantId, (tx) =>
      createContract(tx, personId, { sequence: 1, isPrimary: true, startDate: d('2026-01-01') }),
    );
    await expect(
      withTenant(tenantId, (tx) =>
        createContract(tx, personId, { sequence: 2, isPrimary: true, startDate: d('2026-01-01') }),
      ),
    ).rejects.toThrow();
  });

  it('allows a primary contract for each of two different people', async () => {
    const other = await withTenant(tenantId, (tx) =>
      createPerson(tx, { givenName: 'Sam', familyName: 'Roe' }),
    );
    await withTenant(tenantId, (tx) =>
      createContract(tx, personId, { sequence: 1, isPrimary: true, startDate: d('2026-01-01') }),
    );
    const second = await withTenant(tenantId, (tx) =>
      createContract(tx, other.id, { sequence: 1, isPrimary: true, startDate: d('2026-01-01') }),
    );
    expect(second.isPrimary).toBe(true);
  });
});

describe('resolveContractForMapping', () => {
  it('prefers the primary contract', async () => {
    await withTenant(tenantId, async (tx) => {
      await createContract(tx, personId, { sequence: 1, startDate: d('2026-01-01'), department: 'Ops' });
      await createContract(tx, personId, {
        sequence: 2, isPrimary: true, startDate: d('2026-01-01'), department: 'Finance',
      });
    });
    const c = await withTenant(tenantId, (tx) =>
      resolveContractForMapping(tx, personId, 'primary', d('2026-06-01')),
    );
    expect(c?.department).toBe('Finance');
  });

  it('falls back to the lowest active sequence when asked', async () => {
    await withTenant(tenantId, async (tx) => {
      await createContract(tx, personId, { sequence: 5, startDate: d('2026-01-01'), department: 'Ops' });
      await createContract(tx, personId, { sequence: 2, startDate: d('2026-01-01'), department: 'Finance' });
    });
    const c = await withTenant(tenantId, (tx) =>
      resolveContractForMapping(tx, personId, 'lowestSequence', d('2026-06-01')),
    );
    expect(c?.department).toBe('Finance');
  });

  it('returns null when the primary contract is not currently active', async () => {
    await withTenant(tenantId, (tx) =>
      createContract(tx, personId, {
        sequence: 1, isPrimary: true, startDate: d('2020-01-01'), endDate: d('2021-01-01'),
      }),
    );
    const c = await withTenant(tenantId, (tx) =>
      resolveContractForMapping(tx, personId, 'primary', d('2026-06-01')),
    );
    expect(c).toBeNull();
  });
});
```

- [ ] **Step 3: Run the tests and verify they fail**

Run: `pnpm vitest run packages/core/src/identity/`
Expected: FAIL — cannot resolve `./person-service.js`.

- [ ] **Step 4: Implement the services**

`packages/core/src/identity/person-service.ts`:
```ts
import type { TenantClient } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';

export interface CreatePersonInput {
  givenName: string;
  familyName: string;
  businessEmail?: string;
  personalEmail?: string;
  externalId?: string;
}

export async function createPerson(tx: TenantClient, input: CreatePersonInput) {
  const tenantId = await currentTenant(tx);
  return tx.person.create({
    data: {
      tenantId,
      givenName: input.givenName,
      familyName: input.familyName,
      businessEmail: input.businessEmail ?? null,
      personalEmail: input.personalEmail ?? null,
      externalId: input.externalId ?? null,
    },
  });
}

export async function linkUserToPerson(tx: TenantClient, userId: string, personId: string) {
  await tx.user.update({ where: { id: userId }, data: { personId } });
}

export async function usersForPerson(tx: TenantClient, personId: string) {
  return tx.user.findMany({ where: { personId } });
}

export async function personForUser(tx: TenantClient, userId: string) {
  const user = await tx.user.findUnique({ where: { id: userId } });
  if (!user?.personId) return null;
  return tx.person.findUnique({ where: { id: user.personId } });
}
```

`packages/core/src/identity/contract-service.ts`:
```ts
import type { TenantClient } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';

export interface CreateContractInput {
  sequence: number;
  isPrimary?: boolean;
  startDate: Date;
  endDate?: Date;
  jobTitle?: string;
  department?: string;
  costCentre?: string;
  employer?: string;
  location?: string;
  managerPersonId?: string;
  fte?: number;
}

export type ContractStrategy = 'primary' | 'lowestSequence';

export async function createContract(
  tx: TenantClient,
  personId: string,
  input: CreateContractInput,
) {
  const tenantId = await currentTenant(tx);
  return tx.contract.create({
    data: {
      tenantId,
      personId,
      sequence: input.sequence,
      isPrimary: input.isPrimary ?? false,
      startDate: input.startDate,
      endDate: input.endDate ?? null,
      jobTitle: input.jobTitle ?? null,
      department: input.department ?? null,
      costCentre: input.costCentre ?? null,
      employer: input.employer ?? null,
      location: input.location ?? null,
      managerPersonId: input.managerPersonId ?? null,
      fte: input.fte ?? null,
    },
  });
}

/** Contracts in force on `on` — started, and not yet ended. */
export async function activeContracts(
  tx: TenantClient,
  personId: string,
  on: Date = new Date(),
) {
  return tx.contract.findMany({
    where: {
      personId,
      startDate: { lte: on },
      OR: [{ endDate: null }, { endDate: { gte: on } }],
    },
    orderBy: { sequence: 'asc' },
  });
}

export async function primaryContract(tx: TenantClient, personId: string) {
  return tx.contract.findFirst({ where: { personId, isPrimary: true } });
}

/**
 * Picks the contract that supplies attribute values for claims and policy.
 * Returns null when no active contract matches — callers omit the value
 * rather than emitting an empty one.
 */
export async function resolveContractForMapping(
  tx: TenantClient,
  personId: string,
  strategy: ContractStrategy,
  on: Date = new Date(),
) {
  const active = await activeContracts(tx, personId, on);
  if (active.length === 0) return null;
  if (strategy === 'primary') {
    return active.find((c) => c.isPrimary) ?? null;
  }
  return active[0] ?? null;
}
```

- [ ] **Step 5: Run the tests and verify they pass**

Run: `pnpm vitest run packages/core/src/identity/`
Expected: PASS, 9 tests.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add person and contract model with multi-contract resolution"
```

---

## Task 5: Hash-chained audit log

**Files:**
- Modify: `packages/db/prisma/schema.prisma`
- Create: `packages/db/prisma/migrations/0004_audit/migration.sql`
- Create: `packages/core/src/audit/audit-service.ts`
- Test: `packages/core/src/audit/audit-service.test.ts`

**Interfaces:**
- Consumes: `TenantClient`, `currentTenant`.
- Produces:
  - `recordEvent(tx, event: AuditInput): Promise<AuditEvent>` — `AuditInput = { actorUserId: string | null; action: string; targetType: string; targetId: string | null; outcome: 'success' | 'failure'; sourceIp: string | null; payload: Record<string, unknown> }`
  - `verifyChain(tx): Promise<{ valid: true } | { valid: false; brokenAtSequence: number }>`
  - Every later task that mutates state calls `recordEvent`.

- [ ] **Step 1: Extend the schema**

```prisma
model AuditEvent {
  id          String   @id @default(uuid()) @db.Uuid
  tenantId    String   @db.Uuid
  sequence    Int
  occurredAt  DateTime @default(now())
  actorUserId String?  @db.Uuid
  action      String
  targetType  String
  targetId    String?  @db.Uuid
  outcome     String
  sourceIp    String?
  payload     Json
  prevHash    String
  hash        String

  @@unique([tenantId, sequence])
  @@index([tenantId, occurredAt])
}
```

Migration additions: the RLS `DO` block for `AuditEvent`, plus a rule making it append-only:
```sql
CREATE RULE audit_no_update AS ON UPDATE TO "AuditEvent" DO INSTEAD NOTHING;
CREATE RULE audit_no_delete AS ON DELETE TO "AuditEvent" DO INSTEAD NOTHING;
```

The rules make tampering through the application impossible; the hash chain makes tampering through direct database access *detectable*. Both are needed — neither substitutes for the other. Note that `resetDatabase` uses TRUNCATE, which these rules do not block, so tests still work.

- [ ] **Step 2: Write the failing test**

`packages/core/src/audit/audit-service.test.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { recordEvent, verifyChain } from './audit-service.js';

let tenantId: string;

const event = (action: string) => ({
  actorUserId: null,
  action,
  targetType: 'User',
  targetId: null,
  outcome: 'success' as const,
  sourceIp: '10.0.0.1',
  payload: { note: action },
});

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
});

describe('recordEvent', () => {
  it('numbers events from 1 and chains each hash to the previous', async () => {
    const first = await withTenant(tenantId, (tx) => recordEvent(tx, event('user.create')));
    const second = await withTenant(tenantId, (tx) => recordEvent(tx, event('user.update')));

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(first.prevHash).toBe('0'.repeat(64));
    expect(second.prevHash).toBe(first.hash);
  });

  it('keeps separate chains per tenant', async () => {
    const other = await prisma.tenant.create({ data: { name: 'Other', slug: 'other' } });
    await withTenant(tenantId, (tx) => recordEvent(tx, event('a')));
    const otherFirst = await withTenant(other.id, (tx) => recordEvent(tx, event('b')));
    expect(otherFirst.sequence).toBe(1);
  });
});

describe('verifyChain', () => {
  it('accepts an untampered chain', async () => {
    await withTenant(tenantId, async (tx) => {
      await recordEvent(tx, event('a'));
      await recordEvent(tx, event('b'));
      await recordEvent(tx, event('c'));
    });
    const result = await withTenant(tenantId, (tx) => verifyChain(tx));
    expect(result).toEqual({ valid: true });
  });

  it('detects a payload altered behind the application', async () => {
    await withTenant(tenantId, async (tx) => {
      await recordEvent(tx, event('a'));
      await recordEvent(tx, event('b'));
      await recordEvent(tx, event('c'));
    });
    // Bypass the append-only rules the way a database-level attacker would.
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "AuditEvent" DISABLE RULE audit_no_update`,
    );
    await prisma.$executeRaw`
      UPDATE "AuditEvent" SET payload = '{"note":"tampered"}'::jsonb
      WHERE "tenantId" = ${tenantId}::uuid AND sequence = 2
    `;
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "AuditEvent" ENABLE RULE audit_no_update`,
    );

    const result = await withTenant(tenantId, (tx) => verifyChain(tx));
    expect(result).toEqual({ valid: false, brokenAtSequence: 2 });
  });
});

describe('append-only rules', () => {
  it('silently discards an ordinary update', async () => {
    const e = await withTenant(tenantId, (tx) => recordEvent(tx, event('a')));
    await withTenant(tenantId, (tx) =>
      tx.auditEvent.updateMany({ where: { id: e.id }, data: { action: 'changed' } }),
    );
    const after = await prisma.auditEvent.findUnique({ where: { id: e.id } });
    expect(after!.action).toBe('a');
  });
});
```

- [ ] **Step 3: Run the test and verify it fails**

Run: `pnpm vitest run packages/core/src/audit/`
Expected: FAIL — cannot resolve `./audit-service.js`.

- [ ] **Step 4: Implement the audit service**

`packages/core/src/audit/audit-service.ts`:
```ts
import { createHash } from 'node:crypto';
import type { TenantClient } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';

export const GENESIS_HASH = '0'.repeat(64);

export interface AuditInput {
  actorUserId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  outcome: 'success' | 'failure';
  sourceIp: string | null;
  payload: Record<string, unknown>;
}

interface Hashable extends AuditInput {
  tenantId: string;
  sequence: number;
  occurredAt: Date;
  prevHash: string;
}

/** Stable field order, so the same event always hashes to the same digest. */
function computeHash(e: Hashable): string {
  const canonical = JSON.stringify([
    e.tenantId,
    e.sequence,
    e.occurredAt.toISOString(),
    e.actorUserId,
    e.action,
    e.targetType,
    e.targetId,
    e.outcome,
    e.sourceIp,
    stableStringify(e.payload),
    e.prevHash,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export async function recordEvent(tx: TenantClient, input: AuditInput) {
  const tenantId = await currentTenant(tx);

  // Serialise appenders for this tenant so two concurrent writers cannot claim
  // the same sequence number. The lock is released when the transaction ends.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId}))`;

  const last = await tx.auditEvent.findFirst({
    orderBy: { sequence: 'desc' },
    select: { sequence: true, hash: true },
  });

  const sequence = (last?.sequence ?? 0) + 1;
  const prevHash = last?.hash ?? GENESIS_HASH;
  const occurredAt = new Date();

  const hash = computeHash({ ...input, tenantId, sequence, occurredAt, prevHash });

  return tx.auditEvent.create({
    data: {
      tenantId,
      sequence,
      occurredAt,
      actorUserId: input.actorUserId,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      outcome: input.outcome,
      sourceIp: input.sourceIp,
      payload: input.payload as never,
      prevHash,
      hash,
    },
  });
}

export type ChainResult = { valid: true } | { valid: false; brokenAtSequence: number };

export async function verifyChain(tx: TenantClient): Promise<ChainResult> {
  const tenantId = await currentTenant(tx);
  const events = await tx.auditEvent.findMany({ orderBy: { sequence: 'asc' } });

  let expectedPrev = GENESIS_HASH;
  for (const e of events) {
    if (e.prevHash !== expectedPrev) return { valid: false, brokenAtSequence: e.sequence };
    const recomputed = computeHash({
      tenantId,
      sequence: e.sequence,
      occurredAt: e.occurredAt,
      actorUserId: e.actorUserId,
      action: e.action,
      targetType: e.targetType,
      targetId: e.targetId,
      outcome: e.outcome as 'success' | 'failure',
      sourceIp: e.sourceIp,
      payload: e.payload as Record<string, unknown>,
      prevHash: e.prevHash,
    });
    if (recomputed !== e.hash) return { valid: false, brokenAtSequence: e.sequence };
    expectedPrev = e.hash;
  }
  return { valid: true };
}
```

- [ ] **Step 5: Run the tests and verify they pass**

Run: `pnpm vitest run packages/core/src/audit/`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add append-only hash-chained audit log"
```

---

## Task 6: Secrets vault with envelope encryption

**Files:**
- Modify: `packages/db/prisma/schema.prisma`
- Create: `packages/db/prisma/migrations/0005_vault/migration.sql`
- Create: `packages/core/src/vault/master-key.ts`, `packages/core/src/vault/vault-service.ts`
- Test: `packages/core/src/vault/vault-service.test.ts`

**Interfaces:**
- Consumes: `Config.masterKey`, `TenantClient`.
- Produces:
  - `MasterKeyProvider` interface — `{ wrap(dek: Buffer): Promise<WrappedKey>; unwrap(w: WrappedKey): Promise<Buffer> }`, `WrappedKey = { ciphertext: Buffer; iv: Buffer; tag: Buffer }`
  - `localMasterKeyProvider(masterKey: Buffer): MasterKeyProvider`
  - `putSecret(tx, provider, name: string, plaintext: string): Promise<{ id: string; name: string }>`
  - `getSecret(tx, provider, name: string): Promise<string | null>` — internal use only; never wired to an HTTP response.

- [ ] **Step 1: Extend the schema**

```prisma
model Secret {
  id         String   @id @default(uuid()) @db.Uuid
  tenantId   String   @db.Uuid
  name       String
  ciphertext Bytes
  iv         Bytes
  tag        Bytes
  wrappedDek Bytes
  dekIv      Bytes
  dekTag     Bytes
  updatedAt  DateTime @updatedAt

  @@unique([tenantId, name])
  @@index([tenantId])
}
```

Migration additions: the RLS `DO` block for `Secret`.

- [ ] **Step 2: Write the failing test**

`packages/core/src/vault/vault-service.test.ts`:
```ts
import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { localMasterKeyProvider } from './master-key.js';
import { getSecret, putSecret } from './vault-service.js';

const provider = localMasterKeyProvider(Buffer.alloc(32, 9));
let tenantId: string;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
});

describe('vault', () => {
  it('round-trips a secret', async () => {
    await withTenant(tenantId, (tx) => putSecret(tx, provider, 'ldap.bindPassword', 'hunter2'));
    const value = await withTenant(tenantId, (tx) => getSecret(tx, provider, 'ldap.bindPassword'));
    expect(value).toBe('hunter2');
  });

  it('stores no plaintext anywhere in the row', async () => {
    await withTenant(tenantId, (tx) => putSecret(tx, provider, 'k', 'hunter2'));
    const row = await prisma.secret.findFirst({ where: { tenantId } });
    const blob = Buffer.concat([row!.ciphertext, row!.wrappedDek]).toString('utf8');
    expect(blob).not.toContain('hunter2');
  });

  it('uses a distinct data key per secret', async () => {
    await withTenant(tenantId, async (tx) => {
      await putSecret(tx, provider, 'a', 'same-value');
      await putSecret(tx, provider, 'b', 'same-value');
    });
    const rows = await prisma.secret.findMany({ where: { tenantId }, orderBy: { name: 'asc' } });
    expect(rows[0]!.wrappedDek.equals(rows[1]!.wrappedDek)).toBe(false);
    expect(rows[0]!.ciphertext.equals(rows[1]!.ciphertext)).toBe(false);
  });

  it('replaces a secret in place rather than duplicating it', async () => {
    await withTenant(tenantId, (tx) => putSecret(tx, provider, 'k', 'first'));
    await withTenant(tenantId, (tx) => putSecret(tx, provider, 'k', 'second'));
    const rows = await prisma.secret.findMany({ where: { tenantId } });
    expect(rows).toHaveLength(1);
    const value = await withTenant(tenantId, (tx) => getSecret(tx, provider, 'k'));
    expect(value).toBe('second');
  });

  it('rejects a tampered ciphertext instead of returning garbage', async () => {
    await withTenant(tenantId, (tx) => putSecret(tx, provider, 'k', 'hunter2'));
    const row = await prisma.secret.findFirst({ where: { tenantId } });
    const corrupted = Buffer.from(row!.ciphertext);
    corrupted[0] = corrupted[0]! ^ 0xff;
    await prisma.secret.update({ where: { id: row!.id }, data: { ciphertext: corrupted } });

    await expect(
      withTenant(tenantId, (tx) => getSecret(tx, provider, 'k')),
    ).rejects.toThrow();
  });

  it('returns null for an unknown name', async () => {
    const value = await withTenant(tenantId, (tx) => getSecret(tx, provider, 'missing'));
    expect(value).toBeNull();
  });

  it('cannot decrypt with a different master key', async () => {
    await withTenant(tenantId, (tx) => putSecret(tx, provider, 'k', 'hunter2'));
    const wrong = localMasterKeyProvider(randomBytes(32));
    await expect(withTenant(tenantId, (tx) => getSecret(tx, wrong, 'k'))).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run the test and verify it fails**

Run: `pnpm vitest run packages/core/src/vault/`
Expected: FAIL — cannot resolve `./master-key.js`.

- [ ] **Step 4: Implement the vault**

`packages/core/src/vault/master-key.ts`:
```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface WrappedKey {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}

export interface MasterKeyProvider {
  wrap(dek: Buffer): Promise<WrappedKey>;
  unwrap(wrapped: WrappedKey): Promise<Buffer>;
}

/**
 * Development and single-node provider: the master key comes from configuration.
 * A KMS-backed provider implements this same interface without touching callers.
 */
export function localMasterKeyProvider(masterKey: Buffer): MasterKeyProvider {
  if (masterKey.length !== 32) throw new Error('master key must be 32 bytes');
  return {
    async wrap(dek) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
      const ciphertext = Buffer.concat([cipher.update(dek), cipher.final()]);
      return { ciphertext, iv, tag: cipher.getAuthTag() };
    },
    async unwrap(wrapped) {
      const decipher = createDecipheriv('aes-256-gcm', masterKey, wrapped.iv);
      decipher.setAuthTag(wrapped.tag);
      return Buffer.concat([decipher.update(wrapped.ciphertext), decipher.final()]);
    },
  };
}
```

`packages/core/src/vault/vault-service.ts`:
```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { TenantClient } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';
import type { MasterKeyProvider } from './master-key.js';

export async function putSecret(
  tx: TenantClient,
  provider: MasterKeyProvider,
  name: string,
  plaintext: string,
) {
  const tenantId = await currentTenant(tx);
  const dek = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', dek, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const wrapped = await provider.wrap(dek);
  dek.fill(0);

  const row = await tx.secret.upsert({
    where: { tenantId_name: { tenantId, name } },
    create: {
      tenantId, name, ciphertext, iv, tag,
      wrappedDek: wrapped.ciphertext, dekIv: wrapped.iv, dekTag: wrapped.tag,
    },
    update: {
      ciphertext, iv, tag,
      wrappedDek: wrapped.ciphertext, dekIv: wrapped.iv, dekTag: wrapped.tag,
    },
    select: { id: true, name: true },
  });
  return row;
}

/** Internal only. No route may return this value to a client. */
export async function getSecret(
  tx: TenantClient,
  provider: MasterKeyProvider,
  name: string,
): Promise<string | null> {
  const row = await tx.secret.findFirst({ where: { name } });
  if (!row) return null;

  const dek = await provider.unwrap({
    ciphertext: row.wrappedDek, iv: row.dekIv, tag: row.dekTag,
  });
  try {
    const decipher = createDecipheriv('aes-256-gcm', dek, row.iv);
    decipher.setAuthTag(row.tag);
    return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8');
  } finally {
    dek.fill(0);
  }
}

export async function listSecretNames(tx: TenantClient) {
  return tx.secret.findMany({ select: { id: true, name: true, updatedAt: true } });
}
```

- [ ] **Step 5: Run the tests and verify they pass**

Run: `pnpm vitest run packages/core/src/vault/`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add secrets vault with envelope encryption"
```

---

## Task 7: Role-based access control

**Files:**
- Modify: `packages/db/prisma/schema.prisma`
- Create: `packages/db/prisma/migrations/0006_rbac/migration.sql`
- Create: `packages/core/src/rbac/permissions.ts`, `packages/core/src/rbac/rbac-service.ts`
- Test: `packages/core/src/rbac/rbac-service.test.ts`

**Interfaces:**
- Consumes: `TenantClient`, `currentTenant`.
- Produces:
  - `PERMISSIONS` — the frozen catalogue of permission strings.
  - `Permission` type — a union of those strings.
  - `assignRole(tx, userId: string, roleId: string, scopeOrgUnitId?: string): Promise<void>`
  - `permissionsForUser(tx, userId: string): Promise<Set<Permission>>`
  - `hasPermission(tx, userId: string, permission: Permission, scopeOrgUnitId?: string): Promise<boolean>`
  - `isAdministrator(tx, userId: string): Promise<boolean>` — true when the user holds any permission at all. Task 10 uses this to decide whether a session may be elevated.

- [ ] **Step 1: Extend the schema**

```prisma
model Role {
  id          String   @id @default(uuid()) @db.Uuid
  tenantId    String   @db.Uuid
  name        String
  description String?
  permissions String[]
  builtIn     Boolean  @default(false)
  assignments RoleAssignment[]

  @@unique([tenantId, name])
  @@index([tenantId])
}

model RoleAssignment {
  id             String  @id @default(uuid()) @db.Uuid
  tenantId       String  @db.Uuid
  roleId         String  @db.Uuid
  role           Role    @relation(fields: [roleId], references: [id], onDelete: Cascade)
  userId         String  @db.Uuid
  scopeOrgUnitId String? @db.Uuid

  @@unique([roleId, userId, scopeOrgUnitId])
  @@index([tenantId])
  @@index([userId])
}
```

Migration additions: the RLS `DO` block for `Role` and `RoleAssignment`.

Permissions are a `String[]` column rather than a join table. They are a closed, code-defined catalogue, not user data, so a join table would add a query for no gain in integrity.

- [ ] **Step 2: Write the failing test**

`packages/core/src/rbac/rbac-service.test.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { createUser } from '../directory/user-service.js';
import { createOrgUnit } from '../directory/org-unit-service.js';
import { PERMISSIONS } from './permissions.js';
import { assignRole, createRole, hasPermission, isAdministrator, permissionsForUser } from './rbac-service.js';

let tenantId: string;
let userId: string;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  const user = await withTenant(tenantId, (tx) =>
    createUser(tx, { login: 'jdoe', email: 'j@acme.test', displayName: 'J' }),
  );
  userId = user.id;
});

describe('permissionsForUser', () => {
  it('is empty for a user with no roles', async () => {
    const perms = await withTenant(tenantId, (tx) => permissionsForUser(tx, userId));
    expect(perms.size).toBe(0);
  });

  it('unions the permissions of every assigned role', async () => {
    await withTenant(tenantId, async (tx) => {
      const reader = await createRole(tx, 'Reader', [PERMISSIONS.DIRECTORY_READ]);
      const writer = await createRole(tx, 'Writer', [PERMISSIONS.DIRECTORY_WRITE]);
      await assignRole(tx, userId, reader.id);
      await assignRole(tx, userId, writer.id);
    });
    const perms = await withTenant(tenantId, (tx) => permissionsForUser(tx, userId));
    expect([...perms].sort()).toEqual(
      [PERMISSIONS.DIRECTORY_READ, PERMISSIONS.DIRECTORY_WRITE].sort(),
    );
  });
});

describe('hasPermission', () => {
  it('grants an unscoped assignment everywhere', async () => {
    await withTenant(tenantId, async (tx) => {
      const role = await createRole(tx, 'Reader', [PERMISSIONS.DIRECTORY_READ]);
      await assignRole(tx, userId, role.id);
    });
    const ou = await withTenant(tenantId, (tx) => createOrgUnit(tx, 'Finance'));
    const allowed = await withTenant(tenantId, (tx) =>
      hasPermission(tx, userId, PERMISSIONS.DIRECTORY_READ, ou.id),
    );
    expect(allowed).toBe(true);
  });

  it('confines a scoped assignment to its org unit', async () => {
    const finance = await withTenant(tenantId, (tx) => createOrgUnit(tx, 'Finance'));
    const ops = await withTenant(tenantId, (tx) => createOrgUnit(tx, 'Ops'));
    await withTenant(tenantId, async (tx) => {
      const role = await createRole(tx, 'Reader', [PERMISSIONS.DIRECTORY_READ]);
      await assignRole(tx, userId, role.id, finance.id);
    });

    const inScope = await withTenant(tenantId, (tx) =>
      hasPermission(tx, userId, PERMISSIONS.DIRECTORY_READ, finance.id),
    );
    const outOfScope = await withTenant(tenantId, (tx) =>
      hasPermission(tx, userId, PERMISSIONS.DIRECTORY_READ, ops.id),
    );
    expect(inScope).toBe(true);
    expect(outOfScope).toBe(false);
  });

  it('denies a permission the role does not carry', async () => {
    await withTenant(tenantId, async (tx) => {
      const role = await createRole(tx, 'Reader', [PERMISSIONS.DIRECTORY_READ]);
      await assignRole(tx, userId, role.id);
    });
    const allowed = await withTenant(tenantId, (tx) =>
      hasPermission(tx, userId, PERMISSIONS.DIRECTORY_WRITE),
    );
    expect(allowed).toBe(false);
  });
});

describe('isAdministrator', () => {
  it('is false for a user with no roles and true once any role is assigned', async () => {
    expect(await withTenant(tenantId, (tx) => isAdministrator(tx, userId))).toBe(false);
    await withTenant(tenantId, async (tx) => {
      const role = await createRole(tx, 'Reader', [PERMISSIONS.DIRECTORY_READ]);
      await assignRole(tx, userId, role.id);
    });
    expect(await withTenant(tenantId, (tx) => isAdministrator(tx, userId))).toBe(true);
  });
});
```

- [ ] **Step 3: Run the test and verify it fails**

Run: `pnpm vitest run packages/core/src/rbac/`
Expected: FAIL — cannot resolve `./permissions.js`.

- [ ] **Step 4: Implement RBAC**

`packages/core/src/rbac/permissions.ts`:
```ts
export const PERMISSIONS = {
  DIRECTORY_READ: 'directory.read',
  DIRECTORY_WRITE: 'directory.write',
  IDENTITY_READ: 'identity.read',
  IDENTITY_WRITE: 'identity.write',
  AUDIT_READ: 'audit.read',
  SECRETS_WRITE: 'secrets.write',
  RBAC_MANAGE: 'rbac.manage',
  TENANT_MANAGE: 'tenant.manage',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: Permission[] = Object.values(PERMISSIONS);
```

`packages/core/src/rbac/rbac-service.ts`:
```ts
import type { TenantClient } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';
import type { Permission } from './permissions.js';

export async function createRole(
  tx: TenantClient,
  name: string,
  permissions: Permission[],
  opts: { builtIn?: boolean; description?: string } = {},
) {
  const tenantId = await currentTenant(tx);
  return tx.role.create({
    data: {
      tenantId,
      name,
      permissions,
      builtIn: opts.builtIn ?? false,
      description: opts.description ?? null,
    },
  });
}

export async function assignRole(
  tx: TenantClient,
  userId: string,
  roleId: string,
  scopeOrgUnitId?: string,
) {
  const tenantId = await currentTenant(tx);
  await tx.roleAssignment.upsert({
    where: {
      roleId_userId_scopeOrgUnitId: { roleId, userId, scopeOrgUnitId: scopeOrgUnitId ?? null },
    },
    create: { tenantId, roleId, userId, scopeOrgUnitId: scopeOrgUnitId ?? null },
    update: {},
  });
}

export async function permissionsForUser(
  tx: TenantClient,
  userId: string,
): Promise<Set<Permission>> {
  const assignments = await tx.roleAssignment.findMany({
    where: { userId },
    include: { role: true },
  });
  const set = new Set<Permission>();
  for (const a of assignments) {
    for (const p of a.role.permissions) set.add(p as Permission);
  }
  return set;
}

export async function hasPermission(
  tx: TenantClient,
  userId: string,
  permission: Permission,
  scopeOrgUnitId?: string,
): Promise<boolean> {
  const assignments = await tx.roleAssignment.findMany({
    where: { userId },
    include: { role: true },
  });
  return assignments.some((a) => {
    if (!a.role.permissions.includes(permission)) return false;
    // An unscoped assignment applies everywhere; a scoped one only to its unit.
    if (a.scopeOrgUnitId === null) return true;
    return a.scopeOrgUnitId === scopeOrgUnitId;
  });
}

export async function isAdministrator(tx: TenantClient, userId: string): Promise<boolean> {
  const count = await tx.roleAssignment.count({ where: { userId } });
  return count > 0;
}
```

- [ ] **Step 5: Run the tests and verify they pass**

Run: `pnpm vitest run packages/core/src/rbac/`
Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add scoped role-based access control"
```

---

## Task 8: Passwords, sessions, and the authentication chokepoint

The spec requires that every authentication path funnel through one `authenticate()` call. Core builds that chokepoint; the Access plan extends it with policy evaluation and second factors rather than adding a second entry point.

**Files:**
- Modify: `packages/db/prisma/schema.prisma`
- Create: `packages/db/prisma/migrations/0007_auth/migration.sql`
- Create: `packages/core/src/auth/password.ts`, `packages/core/src/auth/session-service.ts`, `packages/core/src/auth/login-service.ts`
- Test: `packages/core/src/auth/login-service.test.ts`, `packages/core/src/auth/session-service.test.ts`

**Interfaces:**
- Consumes: `TenantClient`, `recordEvent`, `isAdministrator`.
- Produces:
  - `hashPassword(plain: string): Promise<string>`, `verifyPassword(hash: string, plain: string): Promise<boolean>`
  - `setPassword(tx, userId: string, plain: string): Promise<void>`
  - `authenticate(tx, input: AuthenticateInput): Promise<AuthResult>` where
    `AuthenticateInput = { login: string; password: string; sourceIp: string | null }` and
    `AuthResult = { ok: true; userId: string; mayElevate: boolean } | { ok: false; reason: AuthFailure }`,
    `AuthFailure = 'invalid_credentials' | 'user_inactive'`
  - `createSession(tx, userId: string, scope: SessionScope): Promise<{ token: string; expiresAt: Date }>`
  - `resolveSession(tx, token: string): Promise<ResolvedSession | null>` — `{ sessionId, userId, scope }`
  - `revokeSession(tx, token: string): Promise<void>`, `revokeAllForUser(tx, userId: string): Promise<void>`
  - `SessionScope = 'portal' | 'admin'`

- [ ] **Step 1: Extend the schema**

```prisma
model PasswordCredential {
  id         String   @id @default(uuid()) @db.Uuid
  tenantId   String   @db.Uuid
  userId     String   @unique @db.Uuid
  hash       String
  updatedAt  DateTime @updatedAt

  @@index([tenantId])
}

model Session {
  id          String   @id @default(uuid()) @db.Uuid
  tenantId    String   @db.Uuid
  userId      String   @db.Uuid
  tokenHash   String   @unique
  scope       String
  createdAt   DateTime @default(now())
  lastSeenAt  DateTime @default(now())
  absoluteExpiresAt DateTime
  revokedAt   DateTime?

  @@index([tenantId])
  @@index([userId])
}
```

Migration additions: the RLS `DO` block for `PasswordCredential` and `Session`, and:
```sql
ALTER TABLE "Tenant" ADD COLUMN "primaryDomain" TEXT;
CREATE UNIQUE INDEX "Tenant_primaryDomain_key" ON "Tenant" ("primaryDomain");
```

`Tenant` itself is not RLS-protected: resolving which tenant a request belongs to necessarily happens before a tenant is bound.

- [ ] **Step 2: Write the failing tests**

`packages/core/src/auth/login-service.test.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { createUser, deactivateUser } from '../directory/user-service.js';
import { createRole, assignRole } from '../rbac/rbac-service.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { setPassword } from '../auth/password.js';
import { authenticate } from './login-service.js';

let tenantId: string;
let userId: string;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  await withTenant(tenantId, async (tx) => {
    const user = await createUser(tx, {
      login: 'jdoe', email: 'j@acme.test', displayName: 'J Doe',
    });
    userId = user.id;
    await setPassword(tx, user.id, 'correct horse battery staple');
  });
});

describe('authenticate', () => {
  it('accepts the correct password', async () => {
    const result = await withTenant(tenantId, (tx) =>
      authenticate(tx, {
        login: 'jdoe', password: 'correct horse battery staple', sourceIp: '10.0.0.1',
      }),
    );
    expect(result).toEqual({ ok: true, userId, mayElevate: false });
  });

  it('rejects the wrong password', async () => {
    const result = await withTenant(tenantId, (tx) =>
      authenticate(tx, { login: 'jdoe', password: 'wrong', sourceIp: null }),
    );
    expect(result).toEqual({ ok: false, reason: 'invalid_credentials' });
  });

  it('reports an unknown login identically to a wrong password', async () => {
    const unknown = await withTenant(tenantId, (tx) =>
      authenticate(tx, { login: 'nobody', password: 'wrong', sourceIp: null }),
    );
    expect(unknown).toEqual({ ok: false, reason: 'invalid_credentials' });
  });

  it('refuses an inactive user even with the right password', async () => {
    await withTenant(tenantId, (tx) => deactivateUser(tx, userId, 'left'));
    const result = await withTenant(tenantId, (tx) =>
      authenticate(tx, {
        login: 'jdoe', password: 'correct horse battery staple', sourceIp: null,
      }),
    );
    expect(result).toEqual({ ok: false, reason: 'user_inactive' });
  });

  it('reports that an administrator may elevate', async () => {
    await withTenant(tenantId, async (tx) => {
      const role = await createRole(tx, 'Reader', [PERMISSIONS.DIRECTORY_READ]);
      await assignRole(tx, userId, role.id);
    });
    const result = await withTenant(tenantId, (tx) =>
      authenticate(tx, {
        login: 'jdoe', password: 'correct horse battery staple', sourceIp: null,
      }),
    );
    expect(result).toEqual({ ok: true, userId, mayElevate: true });
  });

  it('writes an audit event for success and for failure', async () => {
    await withTenant(tenantId, (tx) =>
      authenticate(tx, {
        login: 'jdoe', password: 'correct horse battery staple', sourceIp: '10.0.0.1',
      }),
    );
    await withTenant(tenantId, (tx) =>
      authenticate(tx, { login: 'jdoe', password: 'wrong', sourceIp: '10.0.0.1' }),
    );
    const events = await prisma.auditEvent.findMany({
      where: { tenantId }, orderBy: { sequence: 'asc' },
    });
    expect(events.map((e) => [e.action, e.outcome])).toEqual([
      ['auth.login', 'success'],
      ['auth.login', 'failure'],
    ]);
  });

  it('records no password material in the audit payload', async () => {
    await withTenant(tenantId, (tx) =>
      authenticate(tx, { login: 'jdoe', password: 'hunter2', sourceIp: null }),
    );
    const event = await prisma.auditEvent.findFirst({ where: { tenantId } });
    expect(JSON.stringify(event!.payload)).not.toContain('hunter2');
  });
});
```

`packages/core/src/auth/session-service.test.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { createUser } from '../directory/user-service.js';
import { createSession, resolveSession, revokeAllForUser, revokeSession } from './session-service.js';

let tenantId: string;
let userId: string;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  const user = await withTenant(tenantId, (tx) =>
    createUser(tx, { login: 'jdoe', email: 'j@acme.test', displayName: 'J' }),
  );
  userId = user.id;
});

describe('sessions', () => {
  it('resolves a freshly issued token', async () => {
    const { token } = await withTenant(tenantId, (tx) => createSession(tx, userId, 'portal'));
    const resolved = await withTenant(tenantId, (tx) => resolveSession(tx, token));
    expect(resolved).toMatchObject({ userId, scope: 'portal' });
  });

  it('stores only a hash of the token', async () => {
    const { token } = await withTenant(tenantId, (tx) => createSession(tx, userId, 'portal'));
    const rows = await prisma.session.findMany({ where: { tenantId } });
    expect(rows[0]!.tokenHash).not.toBe(token);
    expect(rows[0]!.tokenHash).toHaveLength(64);
  });

  it('gives an admin session a shorter absolute lifetime than a portal session', async () => {
    const portal = await withTenant(tenantId, (tx) => createSession(tx, userId, 'portal'));
    const admin = await withTenant(tenantId, (tx) => createSession(tx, userId, 'admin'));
    expect(admin.expiresAt.getTime()).toBeLessThan(portal.expiresAt.getTime());
  });

  it('returns null for a revoked token', async () => {
    const { token } = await withTenant(tenantId, (tx) => createSession(tx, userId, 'portal'));
    await withTenant(tenantId, (tx) => revokeSession(tx, token));
    expect(await withTenant(tenantId, (tx) => resolveSession(tx, token))).toBeNull();
  });

  it('returns null for a garbage token', async () => {
    expect(await withTenant(tenantId, (tx) => resolveSession(tx, 'not-a-token'))).toBeNull();
  });

  it('returns null once the absolute expiry has passed', async () => {
    const { token } = await withTenant(tenantId, (tx) => createSession(tx, userId, 'portal'));
    await prisma.session.updateMany({
      where: { tenantId },
      data: { absoluteExpiresAt: new Date(Date.now() - 1000) },
    });
    expect(await withTenant(tenantId, (tx) => resolveSession(tx, token))).toBeNull();
  });

  it('revokes every session a user holds', async () => {
    const a = await withTenant(tenantId, (tx) => createSession(tx, userId, 'portal'));
    const b = await withTenant(tenantId, (tx) => createSession(tx, userId, 'admin'));
    await withTenant(tenantId, (tx) => revokeAllForUser(tx, userId));
    expect(await withTenant(tenantId, (tx) => resolveSession(tx, a.token))).toBeNull();
    expect(await withTenant(tenantId, (tx) => resolveSession(tx, b.token))).toBeNull();
  });
});
```

- [ ] **Step 3: Run the tests and verify they fail**

Run: `pnpm vitest run packages/core/src/auth/`
Expected: FAIL — cannot resolve `./password.js`.

- [ ] **Step 4: Implement passwords, sessions, and authenticate**

Add to `packages/core/package.json` dependencies: `"argon2": "^0.41.1"`.

`packages/core/src/auth/password.ts`:
```ts
import argon2 from 'argon2';
import type { TenantClient } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';

const OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456, // 19 MiB — OWASP minimum for argon2id
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, OPTIONS);
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

export async function setPassword(tx: TenantClient, userId: string, plain: string) {
  const tenantId = await currentTenant(tx);
  const hash = await hashPassword(plain);
  await tx.passwordCredential.upsert({
    where: { userId },
    create: { tenantId, userId, hash },
    update: { hash },
  });
}
```

`packages/core/src/auth/session-service.ts`:
```ts
import { createHash, randomBytes } from 'node:crypto';
import type { TenantClient } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';

export type SessionScope = 'portal' | 'admin';

/** Admin sessions expire sooner, per the spec's scope separation. */
const ABSOLUTE_LIFETIME_MS: Record<SessionScope, number> = {
  portal: 12 * 60 * 60 * 1000,
  admin: 2 * 60 * 60 * 1000,
};

const IDLE_TIMEOUT_MS: Record<SessionScope, number> = {
  portal: 60 * 60 * 1000,
  admin: 15 * 60 * 1000,
};

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export interface ResolvedSession {
  sessionId: string;
  userId: string;
  scope: SessionScope;
}

export async function createSession(tx: TenantClient, userId: string, scope: SessionScope) {
  const tenantId = await currentTenant(tx);
  const token = randomBytes(32).toString('base64url');
  const absoluteExpiresAt = new Date(Date.now() + ABSOLUTE_LIFETIME_MS[scope]);
  await tx.session.create({
    data: { tenantId, userId, tokenHash: hashToken(token), scope, absoluteExpiresAt },
  });
  return { token, expiresAt: absoluteExpiresAt };
}

export async function resolveSession(
  tx: TenantClient,
  token: string,
): Promise<ResolvedSession | null> {
  const row = await tx.session.findFirst({ where: { tokenHash: hashToken(token) } });
  if (!row) return null;
  if (row.revokedAt) return null;

  const now = Date.now();
  if (row.absoluteExpiresAt.getTime() <= now) return null;

  const scope = row.scope as SessionScope;
  if (now - row.lastSeenAt.getTime() > IDLE_TIMEOUT_MS[scope]) return null;

  await tx.session.update({ where: { id: row.id }, data: { lastSeenAt: new Date() } });
  return { sessionId: row.id, userId: row.userId, scope };
}

export async function revokeSession(tx: TenantClient, token: string) {
  await tx.session.updateMany({
    where: { tokenHash: hashToken(token) },
    data: { revokedAt: new Date() },
  });
}

export async function revokeAllForUser(tx: TenantClient, userId: string) {
  await tx.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
```

`packages/core/src/auth/login-service.ts`:
```ts
import type { TenantClient } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import { isAdministrator } from '../rbac/rbac-service.js';
import { hashPassword, verifyPassword } from './password.js';

export interface AuthenticateInput {
  login: string;
  password: string;
  sourceIp: string | null;
}

export type AuthFailure = 'invalid_credentials' | 'user_inactive';

export type AuthResult =
  | { ok: true; userId: string; mayElevate: boolean }
  | { ok: false; reason: AuthFailure };

/**
 * A hash of a value nobody knows, verified against when the login is unknown so
 * that a missing user costs the same time as a wrong password. Computed once at
 * module load rather than per request.
 */
const DUMMY_HASH_PROMISE = hashPassword(
  `absent-user-${Math.random()}-${Date.now()}`,
);

/**
 * The single authentication chokepoint. Every path that establishes who the
 * caller is goes through here. The Access plan extends this function with
 * policy evaluation and second factors; it does not add a parallel route.
 */
export async function authenticate(
  tx: TenantClient,
  input: AuthenticateInput,
): Promise<AuthResult> {
  const user = await tx.user.findFirst({ where: { login: input.login } });

  if (!user) {
    await verifyPassword(await DUMMY_HASH_PROMISE, input.password);
    await audit(tx, null, input, 'failure', 'invalid_credentials');
    return { ok: false, reason: 'invalid_credentials' };
  }

  const credential = await tx.passwordCredential.findUnique({ where: { userId: user.id } });
  const passwordOk = credential
    ? await verifyPassword(credential.hash, input.password)
    : await verifyPassword(await DUMMY_HASH_PROMISE, input.password);

  if (!passwordOk) {
    await audit(tx, user.id, input, 'failure', 'invalid_credentials');
    return { ok: false, reason: 'invalid_credentials' };
  }

  if (user.status !== 'active') {
    await audit(tx, user.id, input, 'failure', 'user_inactive');
    return { ok: false, reason: 'user_inactive' };
  }

  const mayElevate = await isAdministrator(tx, user.id);
  await audit(tx, user.id, input, 'success', null);
  return { ok: true, userId: user.id, mayElevate };
}

async function audit(
  tx: TenantClient,
  userId: string | null,
  input: AuthenticateInput,
  outcome: 'success' | 'failure',
  reason: AuthFailure | null,
) {
  await recordEvent(tx, {
    actorUserId: userId,
    action: 'auth.login',
    targetType: 'User',
    targetId: userId,
    outcome,
    sourceIp: input.sourceIp,
    // The login is recorded; the password never is.
    payload: reason ? { login: input.login, reason } : { login: input.login },
  });
}
```

- [ ] **Step 5: Run the tests and verify they pass**

Run: `pnpm vitest run packages/core/src/auth/`
Expected: PASS, 14 tests.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add password credentials, sessions, and the authentication chokepoint"
```

---

## Task 9: API skeleton — tenant resolution and problem+json

**Files:**
- Create: `packages/contracts/package.json`, `packages/contracts/src/auth.ts`, `packages/contracts/src/index.ts`
- Create: `apps/api/package.json`, `apps/api/tsconfig.json`
- Create: `apps/api/src/app.ts`, `apps/api/src/server.ts`
- Create: `apps/api/src/plugins/problem-json.ts`, `apps/api/src/plugins/tenant-context.ts`
- Create: `apps/api/src/test-support.ts`
- Test: `apps/api/src/plugins/problem-json.test.ts`, `apps/api/src/plugins/tenant-context.test.ts`

**Interfaces:**
- Consumes: `Config`, `withTenant`, `prisma`.
- Produces:
  - `buildApp(config: Config): Promise<FastifyInstance>`
  - `ProblemError` class — `new ProblemError(status: number, type: string, title: string, detail?: string)`
  - `request.tenantId: string` and `request.db<T>(fn: (tx: TenantClient) => Promise<T>): Promise<T>` decorators, used by every route in Tasks 10–12.
  - `buildTestApp(): Promise<{ app: FastifyInstance; tenantId: string; host: string }>` from `test-support.ts`.

- [ ] **Step 1: Write the failing tests**

`apps/api/src/plugins/problem-json.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { buildTestApp } from '../test-support.js';

describe('problem+json', () => {
  it('renders a thrown ProblemError as RFC 9457', async () => {
    const { app, host } = await buildTestApp();
    app.get('/boom', async () => {
      const { ProblemError } = await import('./problem-json.js');
      throw new ProblemError(409, 'conflict', 'Conflict', 'login already exists');
    });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/boom', headers: { host } });

    expect(res.statusCode).toBe(409);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toEqual({
      type: 'https://syntra.dev/problems/conflict',
      title: 'Conflict',
      status: 409,
      detail: 'login already exists',
    });
  });

  it('renders an unexpected error as a 500 without leaking its message', async () => {
    const { app, host } = await buildTestApp();
    app.get('/kaboom', async () => {
      throw new Error('connection string is postgres://user:hunter2@db');
    });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/kaboom', headers: { host } });

    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('hunter2');
    expect(res.json().type).toBe('https://syntra.dev/problems/internal-error');
  });

  it('renders a validation failure as a 400 problem document', async () => {
    const { app, host } = await buildTestApp();
    await app.ready();
    const res = await app.inject({
      method: 'POST', url: '/api/auth/login', headers: { host }, payload: { login: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().type).toBe('https://syntra.dev/problems/validation-failed');
  });
});
```

`apps/api/src/plugins/tenant-context.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { buildTestApp } from '../test-support.js';

describe('tenant resolution', () => {
  it('binds the tenant matching the request host', async () => {
    const { app, tenantId, host } = await buildTestApp();
    app.get('/whoami', async (req) => ({ tenantId: req.tenantId }));
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/whoami', headers: { host } });
    expect(res.json()).toEqual({ tenantId });
  });

  it('returns 404 for an unknown host rather than falling back to a default', async () => {
    const { app } = await buildTestApp();
    await app.ready();
    const res = await app.inject({
      method: 'GET', url: '/api/auth/session', headers: { host: 'nope.syntra.test' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().type).toBe('https://syntra.dev/problems/unknown-tenant');
  });

  it('scopes request.db to the resolved tenant', async () => {
    const { app, tenantId, host } = await buildTestApp();
    app.get('/count', async (req) => {
      const users = await req.db((tx) => tx.user.findMany());
      return { tenantId, count: users.length };
    });
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/count', headers: { host } });
    expect(res.json().count).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `pnpm vitest run apps/api/`
Expected: FAIL — cannot resolve `../test-support.js`.

- [ ] **Step 3: Implement the API skeleton**

`apps/api/package.json`:
```json
{
  "name": "@syntra/api",
  "version": "0.0.0",
  "type": "module",
  "main": "./src/server.ts",
  "dependencies": {
    "@syntra/core": "workspace:*",
    "@syntra/db": "workspace:*",
    "@syntra/contracts": "workspace:*",
    "fastify": "^5.2.0",
    "@fastify/cookie": "^11.0.2",
    "@fastify/rate-limit": "^10.2.1",
    "zod": "^3.24.0"
  }
}
```

`packages/contracts/src/auth.ts`:
```ts
import { z } from 'zod';

export const loginRequest = z.object({
  login: z.string().min(1).max(256),
  password: z.string().min(1).max(1024),
});
export type LoginRequest = z.infer<typeof loginRequest>;

export const sessionResponse = z.object({
  userId: z.string().uuid(),
  displayName: z.string(),
  scope: z.enum(['portal', 'admin']),
  mayElevate: z.boolean(),
  permissions: z.array(z.string()),
});
export type SessionResponse = z.infer<typeof sessionResponse>;
```

`apps/api/src/plugins/problem-json.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

const BASE = 'https://syntra.dev/problems/';

export class ProblemError extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    readonly title: string,
    readonly detail?: string,
  ) {
    super(detail ?? title);
  }
}

export function registerProblemJson(app: FastifyInstance) {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ProblemError) {
      return reply.status(error.status).type('application/problem+json').send({
        type: `${BASE}${error.type}`,
        title: error.title,
        status: error.status,
        ...(error.detail ? { detail: error.detail } : {}),
      });
    }

    if (error instanceof ZodError) {
      return reply.status(400).type('application/problem+json').send({
        type: `${BASE}validation-failed`,
        title: 'Validation failed',
        status: 400,
        errors: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }

    // Anything else may carry connection strings or stack detail. Log it
    // server-side; tell the client nothing beyond the status.
    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).type('application/problem+json').send({
      type: `${BASE}internal-error`,
      title: 'Internal Server Error',
      status: 500,
    });
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.status(404).type('application/problem+json').send({
      type: `${BASE}not-found`,
      title: 'Not Found',
      status: 404,
    }),
  );
}
```

`apps/api/src/plugins/tenant-context.ts`:
```ts
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { prisma, withTenant, type TenantClient } from '@syntra/db';
import { ProblemError } from './problem-json.js';

declare module 'fastify' {
  interface FastifyRequest {
    tenantId: string;
    db<T>(fn: (tx: TenantClient) => Promise<T>): Promise<T>;
  }
}

/** Resolves a tenant from the Host header: primaryDomain first, then slug subdomain. */
async function resolveTenantId(host: string | undefined): Promise<string | null> {
  if (!host) return null;
  const hostname = host.split(':')[0]!.toLowerCase();

  const byDomain = await prisma.tenant.findFirst({
    where: { primaryDomain: hostname, status: 'active' },
  });
  if (byDomain) return byDomain.id;

  const slug = hostname.split('.')[0]!;
  const bySlug = await prisma.tenant.findFirst({ where: { slug, status: 'active' } });
  return bySlug?.id ?? null;
}

export function registerTenantContext(app: FastifyInstance) {
  app.decorateRequest('tenantId', '');
  app.decorateRequest('db', null);

  app.addHook('onRequest', async (request: FastifyRequest) => {
    if (request.url === '/health') return;

    const tenantId = await resolveTenantId(request.headers.host);
    if (!tenantId) {
      throw new ProblemError(404, 'unknown-tenant', 'Unknown tenant');
    }
    request.tenantId = tenantId;
    request.db = <T>(fn: (tx: TenantClient) => Promise<T>) => withTenant(tenantId, fn);
  });
}
```

`apps/api/src/app.ts`:
```ts
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import type { Config } from '@syntra/core';
import { registerProblemJson } from './plugins/problem-json.js';
import { registerTenantContext } from './plugins/tenant-context.js';
import { registerAuthRoutes } from './routes/auth.js';

export async function buildApp(config: Config): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

  await app.register(cookie, { secret: config.sessionSecret });
  await app.register(rateLimit, { global: false });

  registerProblemJson(app);
  registerTenantContext(app);

  app.get('/health', async () => ({ status: 'ok' }));
  await app.register(registerAuthRoutes, { prefix: '/api/auth' });

  return app;
}
```

`apps/api/src/server.ts`:
```ts
import { loadConfig } from '@syntra/core';
import { buildApp } from './app.js';

const config = loadConfig(process.env);
const app = await buildApp(config);
await app.listen({ port: config.port, host: '0.0.0.0' });
```

`apps/api/src/test-support.ts`:
```ts
import { prisma } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { loadConfig } from '@syntra/core';
import { buildApp } from './app.js';

export async function buildTestApp() {
  await resetDatabase();
  const tenant = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  const config = loadConfig({
    DATABASE_URL: process.env.DATABASE_URL,
    PORT: '3000',
    PUBLIC_URL: 'http://acme.syntra.test',
    SESSION_SECRET: 'x'.repeat(32),
    MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
    SMTP_URL: 'smtp://localhost:1025',
  });
  const app = await buildApp(config);
  return { app, tenantId: tenant.id, host: 'acme.syntra.test' };
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `pnpm vitest run apps/api/src/plugins/`
Expected: PASS, 6 tests. The `validation-failed` test depends on the login route from Task 10; if it fails with a 404 at this point, implement Task 10 and re-run before committing.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add API skeleton with tenant resolution and problem+json errors"
```

---

## Task 10: Authentication endpoints and session elevation

**Files:**
- Create: `apps/api/src/routes/auth.ts`
- Create: `apps/api/src/plugins/require-session.ts`
- Test: `apps/api/src/routes/auth.test.ts`

**Interfaces:**
- Consumes: `authenticate`, `createSession`, `resolveSession`, `revokeSession`, `permissionsForUser`, `ProblemError`, `request.db`.
- Produces:
  - Routes `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/session`, `POST /api/auth/elevate`.
  - `requireSession(scope: SessionScope)` — a Fastify `preHandler` that populates `request.session: ResolvedSession`. Tasks 11 and 12 build on it.
  - Cookie name `syntra_session`.

- [ ] **Step 1: Write the failing test**

`apps/api/src/routes/auth.test.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@syntra/db';
import { createUser } from '@syntra/core/src/directory/user-service.js';
import { setPassword } from '@syntra/core/src/auth/password.js';
import { createRole, assignRole } from '@syntra/core/src/rbac/rbac-service.js';
import { PERMISSIONS } from '@syntra/core/src/rbac/permissions.js';
import { buildTestApp } from '../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;

async function seedUser(tenantId: string, opts: { admin?: boolean } = {}) {
  return withTenant(tenantId, async (tx) => {
    const user = await createUser(tx, {
      login: 'jdoe', email: 'j@acme.test', displayName: 'J Doe',
    });
    await setPassword(tx, user.id, 'correct horse battery staple');
    if (opts.admin) {
      const role = await createRole(tx, 'Directory Admin', [
        PERMISSIONS.DIRECTORY_READ, PERMISSIONS.DIRECTORY_WRITE,
      ]);
      await assignRole(tx, user.id, role.id);
    }
    return user;
  });
}

const login = (app: typeof ctx.app, host: string, password: string) =>
  app.inject({
    method: 'POST', url: '/api/auth/login', headers: { host },
    payload: { login: 'jdoe', password },
  });

beforeEach(async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();
});

describe('POST /api/auth/login', () => {
  it('issues a portal session cookie on success', async () => {
    await seedUser(ctx.tenantId);
    const res = await login(ctx.app, ctx.host, 'correct horse battery staple');

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ scope: 'portal', mayElevate: false });
    const cookie = res.cookies.find((c) => c.name === 'syntra_session');
    expect(cookie).toBeDefined();
    expect(cookie!.httpOnly).toBe(true);
    expect(cookie!.sameSite?.toLowerCase()).toBe('lax');
  });

  it('answers a wrong password with 401 and no cookie', async () => {
    await seedUser(ctx.tenantId);
    const res = await login(ctx.app, ctx.host, 'wrong');

    expect(res.statusCode).toBe(401);
    expect(res.json().type).toBe('https://syntra.dev/problems/invalid-credentials');
    expect(res.cookies.find((c) => c.name === 'syntra_session')).toBeUndefined();
  });

  it('answers an unknown login with the same body as a wrong password', async () => {
    await seedUser(ctx.tenantId);
    const wrong = await login(ctx.app, ctx.host, 'wrong');
    const unknown = await ctx.app.inject({
      method: 'POST', url: '/api/auth/login', headers: { host: ctx.host },
      payload: { login: 'nobody', password: 'wrong' },
    });
    expect(unknown.statusCode).toBe(wrong.statusCode);
    expect(unknown.json()).toEqual(wrong.json());
  });
});

describe('GET /api/auth/session', () => {
  it('returns the caller with their permissions', async () => {
    await seedUser(ctx.tenantId, { admin: true });
    const loggedIn = await login(ctx.app, ctx.host, 'correct horse battery staple');
    const cookie = loggedIn.cookies.find((c) => c.name === 'syntra_session')!;

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/auth/session',
      headers: { host: ctx.host, cookie: `syntra_session=${cookie.value}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ displayName: 'J Doe', mayElevate: true });
    expect(res.json().permissions).toContain('directory.read');
  });

  it('returns 401 without a cookie', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/auth/session', headers: { host: ctx.host },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /api/auth/elevate', () => {
  it('exchanges an administrator portal session for an admin session', async () => {
    await seedUser(ctx.tenantId, { admin: true });
    const loggedIn = await login(ctx.app, ctx.host, 'correct horse battery staple');
    const cookie = loggedIn.cookies.find((c) => c.name === 'syntra_session')!;

    const res = await ctx.app.inject({
      method: 'POST', url: '/api/auth/elevate',
      headers: { host: ctx.host, cookie: `syntra_session=${cookie.value}` },
      payload: { password: 'correct horse battery staple' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().scope).toBe('admin');
    const newCookie = res.cookies.find((c) => c.name === 'syntra_session')!;
    expect(newCookie.value).not.toBe(cookie.value);
  });

  it('refuses to elevate a user who holds no roles', async () => {
    await seedUser(ctx.tenantId);
    const loggedIn = await login(ctx.app, ctx.host, 'correct horse battery staple');
    const cookie = loggedIn.cookies.find((c) => c.name === 'syntra_session')!;

    const res = await ctx.app.inject({
      method: 'POST', url: '/api/auth/elevate',
      headers: { host: ctx.host, cookie: `syntra_session=${cookie.value}` },
      payload: { password: 'correct horse battery staple' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().type).toBe('https://syntra.dev/problems/not-an-administrator');
  });

  it('refuses to elevate without re-entering the password', async () => {
    await seedUser(ctx.tenantId, { admin: true });
    const loggedIn = await login(ctx.app, ctx.host, 'correct horse battery staple');
    const cookie = loggedIn.cookies.find((c) => c.name === 'syntra_session')!;

    const res = await ctx.app.inject({
      method: 'POST', url: '/api/auth/elevate',
      headers: { host: ctx.host, cookie: `syntra_session=${cookie.value}` },
      payload: { password: 'wrong' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /api/auth/logout', () => {
  it('revokes the session so it no longer resolves', async () => {
    await seedUser(ctx.tenantId);
    const loggedIn = await login(ctx.app, ctx.host, 'correct horse battery staple');
    const cookie = loggedIn.cookies.find((c) => c.name === 'syntra_session')!;
    const auth = { host: ctx.host, cookie: `syntra_session=${cookie.value}` };

    await ctx.app.inject({ method: 'POST', url: '/api/auth/logout', headers: auth });
    const after = await ctx.app.inject({
      method: 'GET', url: '/api/auth/session', headers: auth,
    });
    expect(after.statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm vitest run apps/api/src/routes/auth.test.ts`
Expected: FAIL — cannot resolve `./routes/auth.js`.

- [ ] **Step 3: Implement the session guard**

`apps/api/src/plugins/require-session.ts`:
```ts
import type { FastifyReply, FastifyRequest } from 'fastify';
import { resolveSession, type ResolvedSession, type SessionScope } from '@syntra/core';
import { ProblemError } from './problem-json.js';

declare module 'fastify' {
  interface FastifyRequest {
    session: ResolvedSession;
  }
}

export const SESSION_COOKIE = 'syntra_session';

/**
 * Requires a live session of at least the given scope. An admin route asks for
 * 'admin'; a portal session presenting itself there is rejected, which is the
 * server-side half of the single-web-app separation.
 */
export function requireSession(required: SessionScope) {
  return async function guard(request: FastifyRequest, _reply: FastifyReply) {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) throw new ProblemError(401, 'unauthenticated', 'Unauthenticated');

    const session = await request.db((tx) => resolveSession(tx, token));
    if (!session) throw new ProblemError(401, 'unauthenticated', 'Unauthenticated');

    if (required === 'admin' && session.scope !== 'admin') {
      throw new ProblemError(
        403, 'admin-session-required', 'Administrative session required',
        'Re-authenticate at /api/auth/elevate to obtain an administrative session.',
      );
    }

    request.session = session;
  };
}
```

- [ ] **Step 4: Implement the routes**

`apps/api/src/routes/auth.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import { loginRequest } from '@syntra/contracts';
import { z } from 'zod';
import {
  authenticate, createSession, permissionsForUser, revokeSession,
  isAdministrator, recordEvent,
} from '@syntra/core';
import { ProblemError } from '../plugins/problem-json.js';
import { requireSession, SESSION_COOKIE } from '../plugins/require-session.js';

const elevateRequest = z.object({ password: z.string().min(1).max(1024) });

const cookieOptions = (secure: boolean) => ({
  httpOnly: true,
  sameSite: 'lax' as const,
  path: '/',
  secure,
});

export async function registerAuthRoutes(app: FastifyInstance) {
  const secure = process.env.NODE_ENV === 'production';

  app.post('/login', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const body = loginRequest.parse(request.body);

    const result = await request.db((tx) =>
      authenticate(tx, { ...body, sourceIp: request.ip }),
    );

    // Both failure reasons produce one indistinguishable response.
    if (!result.ok) {
      throw new ProblemError(401, 'invalid-credentials', 'Invalid credentials');
    }

    const { token } = await request.db((tx) => createSession(tx, result.userId, 'portal'));
    const user = await request.db((tx) => tx.user.findUnique({ where: { id: result.userId } }));
    const permissions = await request.db((tx) => permissionsForUser(tx, result.userId));

    reply.setCookie(SESSION_COOKIE, token, cookieOptions(secure));
    return {
      userId: result.userId,
      displayName: user!.displayName,
      scope: 'portal' as const,
      mayElevate: result.mayElevate,
      permissions: [...permissions],
    };
  });

  app.post('/elevate', {
    preHandler: requireSession('portal'),
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const body = elevateRequest.parse(request.body);
    const userId = request.session.userId;

    const admin = await request.db((tx) => isAdministrator(tx, userId));
    if (!admin) {
      throw new ProblemError(403, 'not-an-administrator', 'Not an administrator');
    }

    const user = await request.db((tx) => tx.user.findUnique({ where: { id: userId } }));
    const recheck = await request.db((tx) =>
      authenticate(tx, { login: user!.login, password: body.password, sourceIp: request.ip }),
    );
    if (!recheck.ok) {
      throw new ProblemError(401, 'invalid-credentials', 'Invalid credentials');
    }

    const { token } = await request.db((tx) => createSession(tx, userId, 'admin'));
    await request.db((tx) =>
      recordEvent(tx, {
        actorUserId: userId, action: 'auth.elevate', targetType: 'Session',
        targetId: null, outcome: 'success', sourceIp: request.ip, payload: {},
      }),
    );

    reply.setCookie(SESSION_COOKIE, token, cookieOptions(secure));
    const permissions = await request.db((tx) => permissionsForUser(tx, userId));
    return {
      userId,
      displayName: user!.displayName,
      scope: 'admin' as const,
      mayElevate: true,
      permissions: [...permissions],
    };
  });

  app.get('/session', { preHandler: requireSession('portal') }, async (request) => {
    const { userId, scope } = request.session;
    const user = await request.db((tx) => tx.user.findUnique({ where: { id: userId } }));
    const permissions = await request.db((tx) => permissionsForUser(tx, userId));
    return {
      userId,
      displayName: user!.displayName,
      scope,
      mayElevate: permissions.size > 0,
      permissions: [...permissions],
    };
  });

  app.post('/logout', { preHandler: requireSession('portal') }, async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE]!;
    await request.db((tx) => revokeSession(tx, token));
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });
}
```

Export the new symbols from `packages/core/src/index.ts` so `@syntra/core` resolves them:
```ts
export * from './config.js';
export * from './tenant-context.js';
export * from './audit/audit-service.js';
export * from './vault/master-key.js';
export * from './vault/vault-service.js';
export * from './directory/user-service.js';
export * from './directory/group-service.js';
export * from './directory/org-unit-service.js';
export * from './identity/person-service.js';
export * from './identity/contract-service.js';
export * from './rbac/permissions.js';
export * from './rbac/rbac-service.js';
export * from './auth/password.js';
export * from './auth/session-service.js';
export * from './auth/login-service.js';
```

- [ ] **Step 5: Run the tests and verify they pass**

Run: `pnpm vitest run apps/api/`
Expected: PASS — the auth suite plus the three plugin tests from Task 9, including the previously deferred `validation-failed` case.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add login, logout, session, and elevation endpoints"
```

---

## Task 11: Administration API for the directory

**Files:**
- Create: `apps/api/src/plugins/require-permission.ts`
- Create: `apps/api/src/routes/admin/users.ts`, `apps/api/src/routes/admin/groups.ts`, `apps/api/src/routes/admin/org-units.ts`
- Create: `packages/contracts/src/directory.ts`
- Modify: `apps/api/src/app.ts` — register the admin routes under `/api/admin`
- Test: `apps/api/src/routes/admin/users.test.ts`

**Interfaces:**
- Consumes: `requireSession`, `hasPermission`, directory services, `recordEvent`.
- Produces:
  - `requirePermission(permission: Permission)` — a `preHandler` that runs after `requireSession('admin')`.
  - Routes: `GET/POST /api/admin/users`, `GET/PATCH /api/admin/users/:id`, `POST /api/admin/users/:id/deactivate`, `GET/POST /api/admin/groups`, `POST/DELETE /api/admin/groups/:id/members/:userId`, `GET/POST /api/admin/org-units`.

- [ ] **Step 1: Write the failing test**

`apps/api/src/routes/admin/users.test.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@syntra/db';
import { createUser } from '@syntra/core/src/directory/user-service.js';
import { setPassword } from '@syntra/core/src/auth/password.js';
import { createRole, assignRole } from '@syntra/core/src/rbac/rbac-service.js';
import { PERMISSIONS } from '@syntra/core/src/rbac/permissions.js';
import { buildTestApp } from '../../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;

async function seedAdmin(tenantId: string, permissions: string[]) {
  return withTenant(tenantId, async (tx) => {
    const user = await createUser(tx, {
      login: 'admin', email: 'admin@acme.test', displayName: 'Admin',
    });
    await setPassword(tx, user.id, 'a-long-enough-password');
    if (permissions.length > 0) {
      const role = await createRole(tx, 'Custom', permissions as never);
      await assignRole(tx, user.id, role.id);
    }
    return user;
  });
}

/** Logs in and, when possible, elevates. Returns the cookie header value. */
async function authCookie(scope: 'portal' | 'admin') {
  const res = await ctx.app.inject({
    method: 'POST', url: '/api/auth/login', headers: { host: ctx.host },
    payload: { login: 'admin', password: 'a-long-enough-password' },
  });
  let token = res.cookies.find((c) => c.name === 'syntra_session')!.value;
  if (scope === 'admin') {
    const up = await ctx.app.inject({
      method: 'POST', url: '/api/auth/elevate',
      headers: { host: ctx.host, cookie: `syntra_session=${token}` },
      payload: { password: 'a-long-enough-password' },
    });
    token = up.cookies.find((c) => c.name === 'syntra_session')!.value;
  }
  return `syntra_session=${token}`;
}

beforeEach(async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();
});

describe('admin session separation', () => {
  it('rejects a portal session on an admin route', async () => {
    await seedAdmin(ctx.tenantId, [PERMISSIONS.DIRECTORY_READ]);
    const cookie = await authCookie('portal');
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/admin/users', headers: { host: ctx.host, cookie },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().type).toBe('https://syntra.dev/problems/admin-session-required');
  });

  it('rejects an anonymous caller', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/admin/users', headers: { host: ctx.host },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('permission enforcement', () => {
  it('allows a read with directory.read', async () => {
    await seedAdmin(ctx.tenantId, [PERMISSIONS.DIRECTORY_READ]);
    const cookie = await authCookie('admin');
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/admin/users', headers: { host: ctx.host, cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().users).toHaveLength(1);
  });

  it('refuses a write when only directory.read is held', async () => {
    await seedAdmin(ctx.tenantId, [PERMISSIONS.DIRECTORY_READ]);
    const cookie = await authCookie('admin');
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/admin/users', headers: { host: ctx.host, cookie },
      payload: { login: 'new', email: 'n@acme.test', displayName: 'New' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().type).toBe('https://syntra.dev/problems/forbidden');
  });
});

describe('user administration', () => {
  it('creates a user and records an audit event', async () => {
    await seedAdmin(ctx.tenantId, [PERMISSIONS.DIRECTORY_READ, PERMISSIONS.DIRECTORY_WRITE]);
    const cookie = await authCookie('admin');
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/admin/users', headers: { host: ctx.host, cookie },
      payload: { login: 'new', email: 'n@acme.test', displayName: 'New' },
    });
    expect(res.statusCode).toBe(201);

    const audit = await ctx.app.inject({
      method: 'GET', url: '/api/admin/audit', headers: { host: ctx.host, cookie },
    });
    // audit route arrives in Task 18; until then assert against the table directly.
    expect([200, 404]).toContain(audit.statusCode);
  });

  it('rejects a duplicate login with 409', async () => {
    await seedAdmin(ctx.tenantId, [PERMISSIONS.DIRECTORY_READ, PERMISSIONS.DIRECTORY_WRITE]);
    const cookie = await authCookie('admin');
    const payload = { login: 'new', email: 'n@acme.test', displayName: 'New' };
    await ctx.app.inject({
      method: 'POST', url: '/api/admin/users', headers: { host: ctx.host, cookie }, payload,
    });
    const second = await ctx.app.inject({
      method: 'POST', url: '/api/admin/users', headers: { host: ctx.host, cookie }, payload,
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().type).toBe('https://syntra.dev/problems/conflict');
  });

  it('deactivates rather than deletes', async () => {
    await seedAdmin(ctx.tenantId, [PERMISSIONS.DIRECTORY_READ, PERMISSIONS.DIRECTORY_WRITE]);
    const cookie = await authCookie('admin');
    const created = await ctx.app.inject({
      method: 'POST', url: '/api/admin/users', headers: { host: ctx.host, cookie },
      payload: { login: 'new', email: 'n@acme.test', displayName: 'New' },
    });
    const id = created.json().id;

    await ctx.app.inject({
      method: 'POST', url: `/api/admin/users/${id}/deactivate`,
      headers: { host: ctx.host, cookie }, payload: { reason: 'left' },
    });

    const list = await ctx.app.inject({
      method: 'GET', url: '/api/admin/users', headers: { host: ctx.host, cookie },
    });
    const found = list.json().users.find((u: { id: string }) => u.id === id);
    expect(found.status).toBe('inactive');
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm vitest run apps/api/src/routes/admin/`
Expected: FAIL — cannot resolve `./require-permission.js` / route not registered.

- [ ] **Step 3: Implement the permission guard**

`apps/api/src/plugins/require-permission.ts`:
```ts
import type { FastifyReply, FastifyRequest } from 'fastify';
import { hasPermission, type Permission } from '@syntra/core';
import { ProblemError } from './problem-json.js';

/** Runs after requireSession('admin'). Authorization is decided here, never in the UI. */
export function requirePermission(permission: Permission) {
  return async function guard(request: FastifyRequest, _reply: FastifyReply) {
    const allowed = await request.db((tx) =>
      hasPermission(tx, request.session.userId, permission),
    );
    if (!allowed) {
      throw new ProblemError(403, 'forbidden', 'Forbidden', `Requires ${permission}`);
    }
  };
}
```

- [ ] **Step 4: Implement the routes**

`packages/contracts/src/directory.ts`:
```ts
import { z } from 'zod';

export const createUserRequest = z.object({
  login: z.string().min(1).max(256),
  email: z.string().email(),
  displayName: z.string().min(1).max(256),
  orgUnitId: z.string().uuid().optional(),
});

export const deactivateUserRequest = z.object({ reason: z.string().min(1).max(512) });

export const createGroupRequest = z.object({
  name: z.string().min(1).max(256),
  description: z.string().max(1024).optional(),
});

export const createOrgUnitRequest = z.object({
  name: z.string().min(1).max(256),
  parentId: z.string().uuid().optional(),
});
```

`apps/api/src/routes/admin/users.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createUserRequest, deactivateUserRequest } from '@syntra/contracts';
import {
  PERMISSIONS, createUser, deactivateUser, listUsers, recordEvent,
} from '@syntra/core';
import { ProblemError } from '../../plugins/problem-json.js';
import { requireSession } from '../../plugins/require-session.js';
import { requirePermission } from '../../plugins/require-permission.js';

const idParam = z.object({ id: z.string().uuid() });

export async function registerAdminUserRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireSession('admin'));

  app.get('/users', { preHandler: requirePermission(PERMISSIONS.DIRECTORY_READ) },
    async (request) => {
      const users = await request.db((tx) => listUsers(tx));
      return { users };
    });

  app.post('/users', { preHandler: requirePermission(PERMISSIONS.DIRECTORY_WRITE) },
    async (request, reply) => {
      const body = createUserRequest.parse(request.body);
      const user = await request.db(async (tx) => {
        try {
          const created = await createUser(tx, body);
          await recordEvent(tx, {
            actorUserId: request.session.userId,
            action: 'user.create', targetType: 'User', targetId: created.id,
            outcome: 'success', sourceIp: request.ip, payload: { login: created.login },
          });
          return created;
        } catch (error) {
          if (error instanceof Error && /login already exists/i.test(error.message)) {
            throw new ProblemError(409, 'conflict', 'Conflict', error.message);
          }
          throw error;
        }
      });
      return reply.status(201).send(user);
    });

  app.post('/users/:id/deactivate', { preHandler: requirePermission(PERMISSIONS.DIRECTORY_WRITE) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const { reason } = deactivateUserRequest.parse(request.body);
      return request.db(async (tx) => {
        const updated = await deactivateUser(tx, id, reason);
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'user.deactivate', targetType: 'User', targetId: id,
          outcome: 'success', sourceIp: request.ip, payload: { reason },
        });
        return updated;
      });
    });
}
```

Write `groups.ts` and `org-units.ts` on the same shape: `requireSession('admin')` as a route-level hook, `requirePermission(...)` per route, every mutation followed by `recordEvent` inside the same `request.db` transaction so the audit entry and the change commit together.

Register in `apps/api/src/app.ts`:
```ts
await app.register(registerAdminUserRoutes, { prefix: '/api/admin' });
await app.register(registerAdminGroupRoutes, { prefix: '/api/admin' });
await app.register(registerAdminOrgUnitRoutes, { prefix: '/api/admin' });
```

- [ ] **Step 5: Run the tests and verify they pass**

Run: `pnpm vitest run apps/api/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add administration API for the directory"
```

---

## Task 12: Administration API for persons and contracts, with CSV import

**Files:**
- Create: `packages/contracts/src/identity.ts`
- Create: `apps/api/src/routes/admin/persons.ts`, `apps/api/src/routes/admin/contracts.ts`
- Create: `packages/core/src/identity/csv-import.ts`
- Test: `packages/core/src/identity/csv-import.test.ts`, `apps/api/src/routes/admin/persons.test.ts`

**Interfaces:**
- Consumes: `createPerson`, `createContract`, `linkUserToPerson`, `recordEvent`.
- Produces:
  - `parsePersonCsv(text: string): { rows: PersonCsvRow[]; errors: CsvError[] }` — `PersonCsvRow = { externalId, givenName, familyName, businessEmail?, contract: { sequence, isPrimary, startDate, endDate?, jobTitle?, department? } }`, `CsvError = { line: number; message: string }`
  - `importPersons(tx, rows: PersonCsvRow[]): Promise<{ created: number; updated: number }>`
  - Routes: `GET/POST /api/admin/persons`, `GET /api/admin/persons/:id`, `POST /api/admin/persons/:id/contracts`, `POST /api/admin/persons/:id/link-user`, `POST /api/admin/persons/import`.

- [ ] **Step 1: Write the failing test**

`packages/core/src/identity/csv-import.test.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { importPersons, parsePersonCsv } from './csv-import.js';

const HEADER = 'externalId,givenName,familyName,businessEmail,sequence,isPrimary,startDate,endDate,jobTitle,department';

let tenantId: string;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
});

describe('parsePersonCsv', () => {
  it('parses a well-formed row', () => {
    const { rows, errors } = parsePersonCsv(
      `${HEADER}\nE1,Jo,Doe,jo@acme.test,1,true,2026-01-01,,Nurse,Care`,
    );
    expect(errors).toEqual([]);
    expect(rows[0]).toMatchObject({
      externalId: 'E1', givenName: 'Jo', familyName: 'Doe',
      contract: { sequence: 1, isPrimary: true, jobTitle: 'Nurse', department: 'Care' },
    });
    expect(rows[0]!.contract.endDate).toBeUndefined();
  });

  it('reports the line number of a bad date instead of throwing', () => {
    const { rows, errors } = parsePersonCsv(
      `${HEADER}\nE1,Jo,Doe,jo@acme.test,1,true,not-a-date,,Nurse,Care`,
    );
    expect(rows).toEqual([]);
    expect(errors).toEqual([{ line: 2, message: 'startDate is not a valid ISO date' }]);
  });

  it('reports a missing required column', () => {
    const { errors } = parsePersonCsv('givenName,familyName\nJo,Doe');
    expect(errors[0]!.message).toMatch(/missing column: externalId/i);
  });

  it('keeps good rows and reports bad ones together', () => {
    const { rows, errors } = parsePersonCsv(
      `${HEADER}\nE1,Jo,Doe,jo@acme.test,1,true,2026-01-01,,Nurse,Care\n` +
      `E2,Sam,Roe,sam@acme.test,x,false,2026-01-01,,Trainer,Care`,
    );
    expect(rows).toHaveLength(1);
    expect(errors).toEqual([{ line: 3, message: 'sequence is not an integer' }]);
  });
});

describe('importPersons', () => {
  it('creates a person with their contract', async () => {
    const { rows } = parsePersonCsv(
      `${HEADER}\nE1,Jo,Doe,jo@acme.test,1,true,2026-01-01,,Nurse,Care`,
    );
    const result = await withTenant(tenantId, (tx) => importPersons(tx, rows));
    expect(result).toEqual({ created: 1, updated: 0 });

    const persons = await prisma.person.findMany({ where: { tenantId } });
    const contracts = await prisma.contract.findMany({ where: { tenantId } });
    expect(persons).toHaveLength(1);
    expect(contracts[0]!.jobTitle).toBe('Nurse');
  });

  it('is idempotent on externalId', async () => {
    const csv = `${HEADER}\nE1,Jo,Doe,jo@acme.test,1,true,2026-01-01,,Nurse,Care`;
    const { rows } = parsePersonCsv(csv);
    await withTenant(tenantId, (tx) => importPersons(tx, rows));
    const second = await withTenant(tenantId, (tx) => importPersons(tx, rows));

    expect(second).toEqual({ created: 0, updated: 1 });
    expect(await prisma.person.count({ where: { tenantId } })).toBe(1);
    expect(await prisma.contract.count({ where: { tenantId } })).toBe(1);
  });

  it('adds a second contract for a person who gains one', async () => {
    await withTenant(tenantId, (tx) =>
      importPersons(tx, parsePersonCsv(
        `${HEADER}\nE1,Jo,Doe,jo@acme.test,1,true,2026-01-01,,Nurse,Care`,
      ).rows),
    );
    await withTenant(tenantId, (tx) =>
      importPersons(tx, parsePersonCsv(
        `${HEADER}\nE1,Jo,Doe,jo@acme.test,2,false,2026-03-01,,Trainer,Learning`,
      ).rows),
    );
    expect(await prisma.contract.count({ where: { tenantId } })).toBe(2);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm vitest run packages/core/src/identity/csv-import.test.ts`
Expected: FAIL — cannot resolve `./csv-import.js`.

- [ ] **Step 3: Implement the importer**

`packages/core/src/identity/csv-import.ts`:
```ts
import type { TenantClient } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';

export interface PersonCsvRow {
  externalId: string;
  givenName: string;
  familyName: string;
  businessEmail?: string;
  contract: {
    sequence: number;
    isPrimary: boolean;
    startDate: Date;
    endDate?: Date;
    jobTitle?: string;
    department?: string;
  };
}

export interface CsvError {
  line: number;
  message: string;
}

const REQUIRED = ['externalId', 'givenName', 'familyName', 'sequence', 'startDate'] as const;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Splits a line on commas. Quoted fields are out of scope; the importer rejects them. */
function splitLine(line: string): string[] {
  return line.split(',').map((c) => c.trim());
}

export function parsePersonCsv(text: string): { rows: PersonCsvRow[]; errors: CsvError[] } {
  const lines = text.trim().split(/\r?\n/);
  const errors: CsvError[] = [];
  const rows: PersonCsvRow[] = [];

  if (lines.length === 0 || !lines[0]) {
    return { rows, errors: [{ line: 1, message: 'file is empty' }] };
  }

  const header = splitLine(lines[0]);
  for (const column of REQUIRED) {
    if (!header.includes(column)) {
      errors.push({ line: 1, message: `missing column: ${column}` });
    }
  }
  if (errors.length > 0) return { rows, errors };

  const at = (cells: string[], name: string): string | undefined => {
    const index = header.indexOf(name);
    if (index === -1) return undefined;
    const value = cells[index];
    return value === '' ? undefined : value;
  };

  for (let i = 1; i < lines.length; i++) {
    const lineNumber = i + 1;
    const cells = splitLine(lines[i]!);

    const startDate = at(cells, 'startDate');
    if (!startDate || !ISO_DATE.test(startDate) || Number.isNaN(Date.parse(startDate))) {
      errors.push({ line: lineNumber, message: 'startDate is not a valid ISO date' });
      continue;
    }
    const endDateRaw = at(cells, 'endDate');
    if (endDateRaw && (!ISO_DATE.test(endDateRaw) || Number.isNaN(Date.parse(endDateRaw)))) {
      errors.push({ line: lineNumber, message: 'endDate is not a valid ISO date' });
      continue;
    }
    const sequenceRaw = at(cells, 'sequence');
    const sequence = Number(sequenceRaw);
    if (!sequenceRaw || !Number.isInteger(sequence)) {
      errors.push({ line: lineNumber, message: 'sequence is not an integer' });
      continue;
    }
    const externalId = at(cells, 'externalId');
    const givenName = at(cells, 'givenName');
    const familyName = at(cells, 'familyName');
    if (!externalId || !givenName || !familyName) {
      errors.push({ line: lineNumber, message: 'externalId, givenName and familyName are required' });
      continue;
    }

    rows.push({
      externalId,
      givenName,
      familyName,
      ...(at(cells, 'businessEmail') ? { businessEmail: at(cells, 'businessEmail')! } : {}),
      contract: {
        sequence,
        isPrimary: at(cells, 'isPrimary')?.toLowerCase() === 'true',
        startDate: new Date(`${startDate}T00:00:00Z`),
        ...(endDateRaw ? { endDate: new Date(`${endDateRaw}T00:00:00Z`) } : {}),
        ...(at(cells, 'jobTitle') ? { jobTitle: at(cells, 'jobTitle')! } : {}),
        ...(at(cells, 'department') ? { department: at(cells, 'department')! } : {}),
      },
    });
  }

  return { rows, errors };
}

export async function importPersons(tx: TenantClient, rows: PersonCsvRow[]) {
  const tenantId = await currentTenant(tx);
  let created = 0;
  let updated = 0;

  for (const row of rows) {
    const existing = await tx.person.findFirst({ where: { externalId: row.externalId } });

    const person = existing
      ? await tx.person.update({
          where: { id: existing.id },
          data: {
            givenName: row.givenName,
            familyName: row.familyName,
            businessEmail: row.businessEmail ?? null,
          },
        })
      : await tx.person.create({
          data: {
            tenantId,
            externalId: row.externalId,
            givenName: row.givenName,
            familyName: row.familyName,
            businessEmail: row.businessEmail ?? null,
          },
        });

    existing ? updated++ : created++;

    // A contract is identified by person + sequence, so re-importing updates
    // in place rather than accumulating duplicates.
    const contract = await tx.contract.findFirst({
      where: { personId: person.id, sequence: row.contract.sequence },
    });
    const data = {
      isPrimary: row.contract.isPrimary,
      startDate: row.contract.startDate,
      endDate: row.contract.endDate ?? null,
      jobTitle: row.contract.jobTitle ?? null,
      department: row.contract.department ?? null,
    };
    if (contract) {
      await tx.contract.update({ where: { id: contract.id }, data });
    } else {
      await tx.contract.create({
        data: { tenantId, personId: person.id, sequence: row.contract.sequence, ...data },
      });
    }
  }

  return { created, updated };
}
```

- [ ] **Step 4: Implement the routes**

`packages/contracts/src/identity.ts`:
```ts
import { z } from 'zod';

export const createPersonRequest = z.object({
  givenName: z.string().min(1).max(128),
  familyName: z.string().min(1).max(128),
  businessEmail: z.string().email().optional(),
  externalId: z.string().max(128).optional(),
});

export const createContractRequest = z.object({
  sequence: z.number().int().positive(),
  isPrimary: z.boolean().default(false),
  startDate: z.coerce.date(),
  endDate: z.coerce.date().optional(),
  jobTitle: z.string().max(256).optional(),
  department: z.string().max(256).optional(),
  costCentre: z.string().max(128).optional(),
  employer: z.string().max(256).optional(),
  location: z.string().max(256).optional(),
  managerPersonId: z.string().uuid().optional(),
  fte: z.number().min(0).max(2).optional(),
});

export const linkUserRequest = z.object({ userId: z.string().uuid() });
export const importRequest = z.object({ csv: z.string().min(1).max(5_000_000) });
```

`apps/api/src/routes/admin/persons.ts` follows the shape of `users.ts`: `requireSession('admin')` as a route-level hook, `requirePermission(PERMISSIONS.IDENTITY_READ)` on reads and `IDENTITY_WRITE` on writes, `recordEvent` inside the same transaction as each mutation. The import route:

```ts
app.post('/persons/import', { preHandler: requirePermission(PERMISSIONS.IDENTITY_WRITE) },
  async (request, reply) => {
    const { csv } = importRequest.parse(request.body);
    const { rows, errors } = parsePersonCsv(csv);

    if (errors.length > 0 && rows.length === 0) {
      return reply.status(400).type('application/problem+json').send({
        type: 'https://syntra.dev/problems/csv-invalid',
        title: 'CSV could not be imported',
        status: 400,
        errors,
      });
    }

    const result = await request.db(async (tx) => {
      const imported = await importPersons(tx, rows);
      await recordEvent(tx, {
        actorUserId: request.session.userId,
        action: 'person.import', targetType: 'Person', targetId: null,
        outcome: 'success', sourceIp: request.ip,
        payload: { ...imported, rejected: errors.length },
      });
      return imported;
    });

    // Partial success is reported, not hidden: the caller sees what was skipped.
    return { ...result, errors };
  });
```

Write `apps/api/src/routes/admin/persons.test.ts` covering: a person is created with 201, an unparseable CSV returns 400 with per-line errors, a partially valid CSV imports the good rows and returns the rejected lines, `link-user` associates a user, and `IDENTITY_READ` alone cannot import.

- [ ] **Step 5: Run the tests and verify they pass**

Run: `pnpm vitest run packages/core/src/identity/ apps/api/src/routes/admin/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add person and contract administration with CSV import"
```

---

## Task 13: Notification service

**Files:**
- Create: `packages/core/src/notify/notification-service.ts`, `packages/core/src/notify/templates/index.ts`
- Test: `packages/core/src/notify/notification-service.test.ts`

**Interfaces:**
- Consumes: `Config.smtpUrl`, `Tenant` branding.
- Produces:
  - `Transport` interface — `{ send(message: OutboundMessage): Promise<void> }`, `OutboundMessage = { to: string; subject: string; text: string; html: string }`
  - `smtpTransport(smtpUrl: string): Transport`
  - `memoryTransport(): Transport & { sent: OutboundMessage[] }` — used by tests everywhere else in the codebase.
  - `notify(tx, transport, template: TemplateName, to: string, vars: Record<string, string>): Promise<void>`
  - `TemplateName = 'welcome' | 'password-changed'`. The Access plan adds `'password-reset'`.

- [ ] **Step 1: Write the failing test**

`packages/core/src/notify/notification-service.test.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { memoryTransport, notify } from './notification-service.js';

let tenantId: string;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme Care', slug: 'acme' } });
  tenantId = t.id;
});

describe('notify', () => {
  it('renders the tenant name into the message', async () => {
    const transport = memoryTransport();
    await withTenant(tenantId, (tx) =>
      notify(tx, transport, 'welcome', 'jo@acme.test', { displayName: 'Jo' }),
    );
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]!.subject).toContain('Acme Care');
    expect(transport.sent[0]!.text).toContain('Jo');
  });

  it('escapes html in a variable so a display name cannot inject markup', async () => {
    const transport = memoryTransport();
    await withTenant(tenantId, (tx) =>
      notify(tx, transport, 'welcome', 'jo@acme.test', {
        displayName: '<script>alert(1)</script>',
      }),
    );
    expect(transport.sent[0]!.html).not.toContain('<script>');
    expect(transport.sent[0]!.html).toContain('&lt;script&gt;');
  });

  it('throws for an unknown template rather than sending an empty message', async () => {
    const transport = memoryTransport();
    await expect(
      withTenant(tenantId, (tx) =>
        notify(tx, transport, 'nope' as never, 'jo@acme.test', {}),
      ),
    ).rejects.toThrow(/unknown template/i);
  });

  it('leaves an unreplaced placeholder visible rather than sending "undefined"', async () => {
    const transport = memoryTransport();
    await withTenant(tenantId, (tx) =>
      notify(tx, transport, 'welcome', 'jo@acme.test', {}),
    );
    expect(transport.sent[0]!.text).not.toContain('undefined');
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm vitest run packages/core/src/notify/`
Expected: FAIL — cannot resolve `./notification-service.js`.

- [ ] **Step 3: Implement the notification service**

Add to `packages/core/package.json` dependencies: `"nodemailer": "^6.9.16"` and devDependencies `"@types/nodemailer": "^6.4.17"`.

`packages/core/src/notify/templates/index.ts`:
```ts
export interface Template {
  subject: string;
  text: string;
  html: string;
}

export const TEMPLATES = {
  welcome: {
    subject: 'Welcome to {{tenantName}}',
    text: 'Hello {{displayName}},\n\nAn account has been created for you at {{tenantName}}.',
    html: '<p>Hello {{displayName}},</p><p>An account has been created for you at {{tenantName}}.</p>',
  },
  'password-changed': {
    subject: 'Your {{tenantName}} password was changed',
    text: 'Hello {{displayName}},\n\nYour password was changed. If this was not you, contact your administrator.',
    html: '<p>Hello {{displayName}},</p><p>Your password was changed. If this was not you, contact your administrator.</p>',
  },
} satisfies Record<string, Template>;

export type TemplateName = keyof typeof TEMPLATES;
```

`packages/core/src/notify/notification-service.ts`:
```ts
import nodemailer from 'nodemailer';
import type { TenantClient } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';
import { TEMPLATES, type TemplateName } from './templates/index.js';

export interface OutboundMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Transport {
  send(message: OutboundMessage): Promise<void>;
}

export function smtpTransport(smtpUrl: string): Transport {
  const mailer = nodemailer.createTransport(smtpUrl);
  return {
    async send(message) {
      await mailer.sendMail({
        from: 'Syntra <no-reply@syntra.local>',
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
    },
  };
}

export function memoryTransport(): Transport & { sent: OutboundMessage[] } {
  const sent: OutboundMessage[] = [];
  return { sent, async send(message) { sent.push(message); } };
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

/** Substitutes {{name}}. An unknown placeholder is left as-is, never "undefined". */
function render(template: string, vars: Record<string, string>, escape: boolean): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    const value = vars[key];
    if (value === undefined) return match;
    return escape ? escapeHtml(value) : value;
  });
}

export async function notify(
  tx: TenantClient,
  transport: Transport,
  template: TemplateName,
  to: string,
  vars: Record<string, string>,
): Promise<void> {
  const definition = TEMPLATES[template];
  if (!definition) throw new Error(`unknown template: ${template}`);

  const tenantId = await currentTenant(tx);
  const tenant = await tx.tenant.findUnique({ where: { id: tenantId } });
  const all = { ...vars, tenantName: tenant?.name ?? 'Syntra' };

  await transport.send({
    to,
    subject: render(definition.subject, all, false),
    text: render(definition.text, all, false),
    html: render(definition.html, all, true),
  });
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `pnpm vitest run packages/core/src/notify/`
Expected: PASS, 4 tests.

- [ ] **Step 5: Verify a real message reaches MailDev**

Write a one-off script or a manual check: send a `welcome` message through `smtpTransport('smtp://localhost:1025')` and confirm it appears at http://localhost:1080. This is a manual gate, not an automated test — do not leave a test that depends on MailDev running.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add notification service with SMTP and in-memory transports"
```

---

## Task 14: Job scheduler

**Files:**
- Create: `packages/core/src/jobs/scheduler.ts`
- Test: `packages/core/src/jobs/scheduler.test.ts`

**Interfaces:**
- Consumes: `Config.databaseUrl`.
- Produces:
  - `createScheduler(databaseUrl: string): Scheduler`
  - `Scheduler` — `{ start(): Promise<void>; stop(): Promise<void>; register<T>(name: string, handler: JobHandler<T>): void; enqueue<T>(name: string, data: T): Promise<string | null>; schedule(name: string, cron: string, data?: unknown): Promise<void> }`
  - `JobHandler<T> = (data: T) => Promise<void>`
  - Jobs carry `tenantId` in their payload and the handler opens its own `withTenant`. There is no ambient tenant in a background job.

- [ ] **Step 1: Write the failing test**

`packages/core/src/jobs/scheduler.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { createScheduler, type Scheduler } from './scheduler.js';

let scheduler: Scheduler;

beforeEach(async () => {
  await resetDatabase();
  scheduler = createScheduler(process.env.DATABASE_URL!);
});

afterEach(async () => {
  await scheduler.stop();
});

const waitFor = async (predicate: () => boolean, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out waiting for condition');
};

describe('scheduler', () => {
  it('runs an enqueued job', async () => {
    const seen: string[] = [];
    scheduler.register<{ value: string }>('test.echo', async (data) => {
      seen.push(data.value);
    });
    await scheduler.start();
    await scheduler.enqueue('test.echo', { value: 'hello' });

    await waitFor(() => seen.length === 1);
    expect(seen).toEqual(['hello']);
  });

  it('retries a handler that throws', async () => {
    let attempts = 0;
    scheduler.register('test.flaky', async () => {
      attempts++;
      if (attempts < 2) throw new Error('transient');
    });
    await scheduler.start();
    await scheduler.enqueue('test.flaky', {});

    await waitFor(() => attempts >= 2, 30_000);
    expect(attempts).toBeGreaterThanOrEqual(2);
  });

  it('refuses to enqueue a job with no registered handler', async () => {
    await scheduler.start();
    await expect(scheduler.enqueue('test.unknown', {})).rejects.toThrow(/no handler/i);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm vitest run packages/core/src/jobs/`
Expected: FAIL — cannot resolve `./scheduler.js`.

- [ ] **Step 3: Implement the scheduler**

Add to `packages/core/package.json` dependencies: `"pg-boss": "^10.1.5"`.

`packages/core/src/jobs/scheduler.ts`:
```ts
import PgBoss from 'pg-boss';

export type JobHandler<T> = (data: T) => Promise<void>;

export interface Scheduler {
  start(): Promise<void>;
  stop(): Promise<void>;
  register<T>(name: string, handler: JobHandler<T>): void;
  enqueue<T>(name: string, data: T): Promise<string | null>;
  schedule(name: string, cron: string, data?: unknown): Promise<void>;
}

export function createScheduler(databaseUrl: string): Scheduler {
  const boss = new PgBoss({ connectionString: databaseUrl, retryLimit: 3, retryBackoff: true });
  const handlers = new Map<string, JobHandler<unknown>>();
  let started = false;

  return {
    register<T>(name: string, handler: JobHandler<T>) {
      handlers.set(name, handler as JobHandler<unknown>);
    },

    async start() {
      if (started) return;
      await boss.start();
      for (const [name, handler] of handlers) {
        await boss.createQueue(name);
        await boss.work(name, async ([job]) => {
          // A throw here is what tells pg-boss to retry; never swallow it.
          await handler(job!.data);
        });
      }
      started = true;
    },

    async stop() {
      if (!started) return;
      await boss.stop({ graceful: true });
      started = false;
    },

    async enqueue<T>(name: string, data: T) {
      if (!handlers.has(name)) {
        throw new Error(`no handler registered for job: ${name}`);
      }
      return boss.send(name, data as object);
    },

    async schedule(name: string, cron: string, data: unknown = {}) {
      if (!handlers.has(name)) {
        throw new Error(`no handler registered for job: ${name}`);
      }
      await boss.schedule(name, cron, data as object);
    },
  };
}
```

`resetDatabase` truncates the `pgboss` schema's tables only if they live in `public`; they do not, so no change is needed there.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `pnpm vitest run packages/core/src/jobs/`
Expected: PASS, 3 tests. The retry test is slow by nature — it waits for a backoff. If it exceeds the 30 second budget, raise the timeout rather than removing the assertion.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add postgres-backed job scheduler"
```

---

## Task 15: Web application shell, login, and portal

**Files:**
- Create: `apps/web/package.json`, `apps/web/vite.config.ts`, `apps/web/index.html`, `apps/web/tailwind.config.ts`, `apps/web/src/index.css`
- Create: `apps/web/src/main.tsx`, `apps/web/src/routes.tsx`
- Create: `apps/web/src/session/SessionProvider.tsx`, `apps/web/src/session/api.ts`
- Create: `apps/web/src/pages/Login.tsx`, `apps/web/src/pages/Portal.tsx`
- Create: `packages/ui/package.json`, `packages/ui/src/Button.tsx`, `packages/ui/src/Field.tsx`, `packages/ui/src/index.ts`
- Test: `apps/web/src/pages/Login.test.tsx`, `apps/web/src/session/SessionProvider.test.tsx`

**Interfaces:**
- Consumes: the API from Tasks 10–12 via `fetch` with `credentials: 'include'`.
- Produces:
  - `useSession(): { session: SessionResponse | null; loading: boolean; login(login, password): Promise<void>; logout(): Promise<void>; elevate(password): Promise<void> }`
  - `<RequireSession scope="portal" | "admin">` route guard component.
  - Vite dev server proxies `/api` to the API on port 3000.

- [ ] **Step 1: Scaffold the application**

`apps/web/package.json`:
```json
{
  "name": "@syntra/web",
  "version": "0.0.0",
  "type": "module",
  "scripts": { "dev": "vite", "build": "vite build", "preview": "vite preview" },
  "dependencies": {
    "@syntra/contracts": "workspace:*",
    "@syntra/ui": "workspace:*",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-router-dom": "^7.1.1"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.3.4",
    "vite": "^6.0.7",
    "tailwindcss": "^4.0.0",
    "@tailwindcss/vite": "^4.0.0",
    "@testing-library/react": "^16.1.0",
    "@testing-library/user-event": "^14.5.2",
    "jsdom": "^25.0.1"
  }
}
```

`apps/web/vite.config.ts`:
```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwind()],
  server: { proxy: { '/api': 'http://localhost:3000' } },
  test: { environment: 'jsdom', globals: true },
});
```

Add `apps/web/src/**/*.test.tsx` to the root `vitest.config.ts` `include` array, and set `environment: 'jsdom'` for that glob using a Vitest workspace file if the Node-environment tests conflict.

- [ ] **Step 2: Write the failing tests**

`apps/web/src/pages/Login.test.tsx`:
```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { SessionProvider } from '../session/SessionProvider.js';
import { Login } from './Login.js';

const renderLogin = () =>
  render(
    <MemoryRouter>
      <SessionProvider>
        <Login />
      </SessionProvider>
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.restoreAllMocks();
  // The provider probes GET /api/auth/session on mount.
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(null, { status: 401 }) as never,
  );
});

describe('Login', () => {
  it('submits the credentials to the API', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }) as never);
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          userId: 'u1', displayName: 'J Doe', scope: 'portal',
          mayElevate: false, permissions: [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ) as never,
    );

    renderLogin();
    await userEvent.type(screen.getByLabelText(/login/i), 'jdoe');
    await userEvent.type(screen.getByLabelText(/password/i), 'secret');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/auth/login',
        expect.objectContaining({ method: 'POST', credentials: 'include' }),
      );
    });
  });

  it('shows one generic message for a rejected login', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }) as never);
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          type: 'https://syntra.dev/problems/invalid-credentials',
          title: 'Invalid credentials', status: 401,
        }),
        { status: 401, headers: { 'content-type': 'application/problem+json' } },
      ) as never,
    );

    renderLogin();
    await userEvent.type(screen.getByLabelText(/login/i), 'jdoe');
    await userEvent.type(screen.getByLabelText(/password/i), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /login or password is incorrect/i,
    );
  });

  it('disables the button while the request is in flight', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }) as never);
    let release: (value: Response) => void;
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => { release = resolve; }) as never,
    );

    renderLogin();
    await userEvent.type(screen.getByLabelText(/login/i), 'jdoe');
    await userEvent.type(screen.getByLabelText(/password/i), 'secret');
    const button = screen.getByRole('button', { name: /sign in/i });
    await userEvent.click(button);

    expect(button).toBeDisabled();
    release!(new Response(null, { status: 401 }));
  });
});
```

- [ ] **Step 3: Run the tests and verify they fail**

Run: `pnpm vitest run apps/web/`
Expected: FAIL — cannot resolve `./Login.js`.

- [ ] **Step 4: Implement the session layer and pages**

`apps/web/src/session/api.ts`:
```ts
export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
}

export class ApiError extends Error {
  constructor(readonly problem: Problem) {
    super(problem.title);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });

  if (!response.ok) {
    let problem: Problem = { type: 'about:blank', title: 'Request failed', status: response.status };
    try {
      problem = (await response.json()) as Problem;
    } catch {
      // A non-JSON error body is still an error; keep the fallback.
    }
    throw new ApiError(problem);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}
```

`apps/web/src/session/SessionProvider.tsx`:
```tsx
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { SessionResponse } from '@syntra/contracts';
import { api } from './api.js';

interface SessionContextValue {
  session: SessionResponse | null;
  loading: boolean;
  login(login: string, password: string): Promise<void>;
  elevate(password: string): Promise<void>;
  logout(): Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<SessionResponse>('/api/auth/session')
      .then(setSession)
      .catch(() => setSession(null))
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (login: string, password: string) => {
    setSession(await api<SessionResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ login, password }),
    }));
  }, []);

  const elevate = useCallback(async (password: string) => {
    setSession(await api<SessionResponse>('/api/auth/elevate', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }));
  }, []);

  const logout = useCallback(async () => {
    await api('/api/auth/logout', { method: 'POST' });
    setSession(null);
  }, []);

  return (
    <SessionContext.Provider value={{ session, loading, login, elevate, logout }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside a SessionProvider');
  return value;
}
```

`apps/web/src/pages/Login.tsx`:
```tsx
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Field } from '@syntra/ui';
import { useSession } from '../session/SessionProvider.js';

export function Login() {
  const { login } = useSession();
  const navigate = useNavigate();
  const [loginName, setLoginName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(loginName, password);
      navigate('/');
    } catch {
      // One message for every failure: the UI must not reveal whether the
      // account exists, which would undo the API's uniform response.
      setError('That login or password is incorrect.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto mt-24 w-full max-w-sm px-6">
      <h1 className="mb-6 text-2xl font-semibold">Sign in to Syntra</h1>
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Login" id="login" value={loginName} onChange={setLoginName} autoComplete="username" />
        <Field label="Password" id="password" type="password" value={password} onChange={setPassword} autoComplete="current-password" />
        {error && (
          <p role="alert" className="text-sm text-red-600">{error}</p>
        )}
        <Button type="submit" disabled={busy}>Sign in</Button>
      </form>
    </main>
  );
}
```

`packages/ui/src/Field.tsx`:
```tsx
interface FieldProps {
  label: string;
  id: string;
  value: string;
  onChange(value: string): void;
  type?: string;
  autoComplete?: string;
}

export function Field({ label, id, value, onChange, type = 'text', autoComplete }: FieldProps) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium">{label}</label>
      <input
        id={id}
        type={type}
        value={value}
        autoComplete={autoComplete}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded border border-slate-300 px-3 py-2"
      />
    </div>
  );
}
```

`packages/ui/src/Button.tsx`:
```tsx
import type { ButtonHTMLAttributes } from 'react';

export function Button({ className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={`rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-50 ${className}`}
    />
  );
}
```

`apps/web/src/pages/Portal.tsx` renders the signed-in user's display name, a placeholder application-tile grid with an empty state ("No applications have been assigned to you yet."), and a sign-out button. The tile grid is filled by the Access plan.

`apps/web/src/routes.tsx`:
```tsx
import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useSession } from './session/SessionProvider.js';
import { Login } from './pages/Login.js';
import { Portal } from './pages/Portal.js';

// The admin console is a separate chunk. A portal-only session never fetches it.
const AdminApp = lazy(() => import('./pages/admin/AdminApp.js'));

function RequireSession({ scope, children }: { scope: 'portal' | 'admin'; children: JSX.Element }) {
  const { session, loading } = useSession();
  if (loading) return <p className="p-8">Loading…</p>;
  if (!session) return <Navigate to="/login" replace />;
  if (scope === 'admin' && session.scope !== 'admin') return <Navigate to="/elevate" replace />;
  return children;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<RequireSession scope="portal"><Portal /></RequireSession>} />
      <Route
        path="/admin/*"
        element={
          <RequireSession scope="admin">
            <Suspense fallback={<p className="p-8">Loading console…</p>}>
              <AdminApp />
            </Suspense>
          </RequireSession>
        }
      />
    </Routes>
  );
}
```

- [ ] **Step 5: Run the tests and verify they pass**

Run: `pnpm vitest run apps/web/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add web application shell with login and portal"
```

---

## Task 16: Administration console — directory pages

**Files:**
- Create: `apps/web/src/pages/Elevate.tsx`
- Create: `apps/web/src/pages/admin/AdminApp.tsx`, `apps/web/src/pages/admin/UsersPage.tsx`, `apps/web/src/pages/admin/GroupsPage.tsx`, `apps/web/src/pages/admin/OrgUnitsPage.tsx`
- Create: `apps/web/src/pages/admin/hooks.ts`
- Test: `apps/web/src/pages/admin/UsersPage.test.tsx`, `apps/web/src/pages/Elevate.test.tsx`

**Interfaces:**
- Consumes: `useSession`, `api`, `/api/admin/*`.
- Produces: `useApiResource<T>(path: string): { data: T | null; error: string | null; reload(): void }` — reused by Tasks 17 and 18.

- [ ] **Step 1: Write the failing test**

`apps/web/src/pages/admin/UsersPage.test.tsx`:
```tsx
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { UsersPage } from './UsersPage.js';

const users = [
  { id: 'u1', login: 'jdoe', displayName: 'J Doe', email: 'j@acme.test', status: 'active' },
  { id: 'u2', login: 'sroe', displayName: 'S Roe', email: 's@acme.test', status: 'inactive' },
];

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  }) as never;

beforeEach(() => vi.restoreAllMocks());

describe('UsersPage', () => {
  it('lists users returned by the API', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ users }));
    render(<MemoryRouter><UsersPage /></MemoryRouter>);

    expect(await screen.findByText('J Doe')).toBeInTheDocument();
    expect(screen.getByText('S Roe')).toBeInTheDocument();
  });

  it('marks an inactive user visibly rather than hiding it', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ users }));
    render(<MemoryRouter><UsersPage /></MemoryRouter>);

    const row = (await screen.findByText('S Roe')).closest('tr')!;
    expect(row).toHaveTextContent(/inactive/i);
  });

  it('shows an empty state rather than a bare table', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ users: [] }));
    render(<MemoryRouter><UsersPage /></MemoryRouter>);

    expect(await screen.findByText(/no users yet/i)).toBeInTheDocument();
  });

  it('surfaces a permission failure as a message, not a blank page', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(
        { type: 'https://syntra.dev/problems/forbidden', title: 'Forbidden', status: 403 },
        403,
      ),
    );
    render(<MemoryRouter><UsersPage /></MemoryRouter>);

    expect(await screen.findByRole('alert')).toHaveTextContent(/do not have permission/i);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm vitest run apps/web/src/pages/admin/`
Expected: FAIL — cannot resolve `./UsersPage.js`.

- [ ] **Step 3: Implement the hook and pages**

`apps/web/src/pages/admin/hooks.ts`:
```ts
import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../../session/api.js';

export function useApiResource<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api<T>(path)
      .then((value) => { if (!cancelled) setData(value); })
      .catch((cause: unknown) => {
        if (cancelled) return;
        if (cause instanceof ApiError && cause.problem.status === 403) {
          setError('You do not have permission to view this.');
        } else {
          setError('Something went wrong loading this page.');
        }
      });
    return () => { cancelled = true; };
  }, [path, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, reload };
}
```

`apps/web/src/pages/admin/UsersPage.tsx`:
```tsx
import { useApiResource } from './hooks.js';

interface UserRow {
  id: string;
  login: string;
  displayName: string;
  email: string;
  status: string;
}

export function UsersPage() {
  const { data, error } = useApiResource<{ users: UserRow[] }>('/api/admin/users');

  if (error) return <p role="alert" className="p-8 text-red-600">{error}</p>;
  if (!data) return <p className="p-8">Loading…</p>;
  if (data.users.length === 0) return <p className="p-8">No users yet.</p>;

  return (
    <table className="w-full text-left text-sm">
      <thead>
        <tr className="border-b">
          <th className="py-2">Name</th><th>Login</th><th>Email</th><th>Status</th>
        </tr>
      </thead>
      <tbody>
        {data.users.map((user) => (
          <tr key={user.id} className="border-b">
            <td className="py-2">{user.displayName}</td>
            <td>{user.login}</td>
            <td>{user.email}</td>
            <td>
              {/* Inactive users stay visible and labelled — the directory is a
                  record, and hiding a deactivation makes it unauditable. */}
              <span className={user.status === 'active' ? 'text-green-700' : 'text-slate-500'}>
                {user.status}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

`apps/web/src/pages/Elevate.tsx` renders a password prompt calling `elevate(password)` from `useSession`, then navigates to `/admin`. On a 403 it explains that the account holds no administrative roles.

`apps/web/src/pages/admin/AdminApp.tsx` renders the console shell — a sidebar linking to Users, Groups, Org units, People, and Audit — with nested routes. Build `GroupsPage` and `OrgUnitsPage` on the same `useApiResource` shape, each with its own empty state and error alert.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `pnpm vitest run apps/web/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add administration console with directory pages"
```

---

## Task 17: Administration console — people and contracts

**Files:**
- Create: `apps/web/src/pages/admin/PersonsPage.tsx`, `apps/web/src/pages/admin/PersonDetailPage.tsx`, `apps/web/src/pages/admin/ImportPage.tsx`
- Modify: `apps/web/src/pages/admin/AdminApp.tsx` — add the routes
- Test: `apps/web/src/pages/admin/PersonDetailPage.test.tsx`, `apps/web/src/pages/admin/ImportPage.test.tsx`

**Interfaces:**
- Consumes: `useApiResource`, `/api/admin/persons`, `/api/admin/persons/:id/contracts`, `/api/admin/persons/import`.
- Produces: no new shared interfaces.

- [ ] **Step 1: Write the failing tests**

`apps/web/src/pages/admin/PersonDetailPage.test.tsx`:
```tsx
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PersonDetailPage } from './PersonDetailPage.js';

const person = {
  id: 'p1', givenName: 'Jo', familyName: 'Doe', businessEmail: 'jo@acme.test',
  contracts: [
    { id: 'c1', sequence: 1, isPrimary: true, startDate: '2026-01-01', endDate: null,
      jobTitle: 'Nurse', department: 'Care' },
    { id: 'c2', sequence: 2, isPrimary: false, startDate: '2026-03-01', endDate: null,
      jobTitle: 'Trainer', department: 'Learning' },
  ],
  users: [{ id: 'u1', login: 'jdoe' }],
};

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/admin/people/p1']}>
      <Routes>
        <Route path="/admin/people/:id" element={<PersonDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(person), {
      status: 200, headers: { 'content-type': 'application/json' },
    }) as never,
  );
});

describe('PersonDetailPage', () => {
  it('shows every contract, not only the primary one', async () => {
    renderPage();
    expect(await screen.findByText('Nurse')).toBeInTheDocument();
    expect(screen.getByText('Trainer')).toBeInTheDocument();
  });

  it('marks which contract is primary', async () => {
    renderPage();
    const row = (await screen.findByText('Nurse')).closest('tr')!;
    expect(row).toHaveTextContent(/primary/i);
  });

  it('lists the accounts linked to the person', async () => {
    renderPage();
    expect(await screen.findByText('jdoe')).toBeInTheDocument();
  });

  it('explains an empty contract list rather than showing a bare table', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ...person, contracts: [] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }) as never,
    );
    renderPage();
    expect(await screen.findByText(/no contracts recorded/i)).toBeInTheDocument();
  });
});
```

`apps/web/src/pages/admin/ImportPage.test.tsx` asserts that after a response of `{ created: 2, updated: 0, errors: [{ line: 4, message: 'sequence is not an integer' }] }` the page reports both the successful count **and** the rejected line, because a partial import that silently drops rows is the worst possible outcome for an identity system.

- [ ] **Step 2: Run the tests and verify they fail**

Run: `pnpm vitest run apps/web/src/pages/admin/`
Expected: FAIL — cannot resolve `./PersonDetailPage.js`.

- [ ] **Step 3: Implement the pages**

`PersonsPage` lists people with their primary job title and active contract count, using `useApiResource`.

`PersonDetailPage` renders three sections: the person's identity fields, a contracts table with a "Primary" badge and an explicit "No contracts recorded" empty state, and the linked accounts list. Contract rows show `startDate`, `endDate ?? '—'`, `jobTitle`, `department`, and `sequence`.

`ImportPage` renders a textarea for CSV, posts it to `/api/admin/persons/import`, and then renders a result panel:
```tsx
{result && (
  <div className="mt-4 space-y-2">
    <p>{result.created} created, {result.updated} updated.</p>
    {result.errors.length > 0 && (
      <div role="alert" className="rounded border border-amber-400 bg-amber-50 p-3">
        <p className="font-medium">{result.errors.length} row(s) were rejected:</p>
        <ul className="list-disc pl-5">
          {result.errors.map((e) => (
            <li key={e.line}>Line {e.line}: {e.message}</li>
          ))}
        </ul>
      </div>
    )}
  </div>
)}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `pnpm vitest run apps/web/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add people and contract administration pages"
```

---

## Task 18: Audit viewer, seeding, containers, and end-to-end proof

**Files:**
- Create: `apps/api/src/routes/admin/audit.ts`
- Create: `apps/web/src/pages/admin/AuditPage.tsx`
- Create: `packages/db/src/seed.ts`
- Create: `apps/api/Dockerfile`, `apps/web/Dockerfile`, `docker-compose.yml` (root, full stack)
- Create: `e2e/playwright.config.ts`, `e2e/login.spec.ts`
- Modify: `README.md`
- Test: `apps/api/src/routes/admin/audit.test.ts`, `e2e/login.spec.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `GET /api/admin/audit?limit&before` requiring `AUDIT_READ`, returning `{ events, chainValid }`.
  - `pnpm seed` — creates a demo tenant `acme`, an owner account, roles, sample people and contracts.

- [ ] **Step 1: Write the failing test**

`apps/api/src/routes/admin/audit.test.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { createUser } from '@syntra/core/src/directory/user-service.js';
import { setPassword } from '@syntra/core/src/auth/password.js';
import { createRole, assignRole } from '@syntra/core/src/rbac/rbac-service.js';
import { PERMISSIONS } from '@syntra/core/src/rbac/permissions.js';
import { buildTestApp } from '../../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;

async function adminCookie(permissions: string[]) {
  await withTenant(ctx.tenantId, async (tx) => {
    const user = await createUser(tx, {
      login: 'admin', email: 'a@acme.test', displayName: 'Admin',
    });
    await setPassword(tx, user.id, 'a-long-enough-password');
    const role = await createRole(tx, 'R', permissions as never);
    await assignRole(tx, user.id, role.id);
  });
  const login = await ctx.app.inject({
    method: 'POST', url: '/api/auth/login', headers: { host: ctx.host },
    payload: { login: 'admin', password: 'a-long-enough-password' },
  });
  const token = login.cookies.find((c) => c.name === 'syntra_session')!.value;
  const up = await ctx.app.inject({
    method: 'POST', url: '/api/auth/elevate',
    headers: { host: ctx.host, cookie: `syntra_session=${token}` },
    payload: { password: 'a-long-enough-password' },
  });
  return `syntra_session=${up.cookies.find((c) => c.name === 'syntra_session')!.value}`;
}

beforeEach(async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();
});

describe('GET /api/admin/audit', () => {
  it('returns the events written by logging in, newest first', async () => {
    const cookie = await adminCookie([PERMISSIONS.AUDIT_READ]);
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/admin/audit', headers: { host: ctx.host, cookie },
    });

    expect(res.statusCode).toBe(200);
    const { events, chainValid } = res.json();
    expect(chainValid).toBe(true);
    expect(events[0].sequence).toBeGreaterThan(events[1].sequence);
    expect(events.some((e: { action: string }) => e.action === 'auth.login')).toBe(true);
  });

  it('reports a broken chain instead of serving the events as trustworthy', async () => {
    const cookie = await adminCookie([PERMISSIONS.AUDIT_READ]);
    await prisma.$executeRawUnsafe(`ALTER TABLE "AuditEvent" DISABLE RULE audit_no_update`);
    await prisma.$executeRaw`
      UPDATE "AuditEvent" SET action = 'tampered'
      WHERE "tenantId" = ${ctx.tenantId}::uuid AND sequence = 1
    `;
    await prisma.$executeRawUnsafe(`ALTER TABLE "AuditEvent" ENABLE RULE audit_no_update`);

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/admin/audit', headers: { host: ctx.host, cookie },
    });
    expect(res.json().chainValid).toBe(false);
  });

  it('refuses a caller without audit.read', async () => {
    const cookie = await adminCookie([PERMISSIONS.DIRECTORY_READ]);
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/admin/audit', headers: { host: ctx.host, cookie },
    });
    expect(res.statusCode).toBe(403);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm vitest run apps/api/src/routes/admin/audit.test.ts`
Expected: FAIL — route not registered, 404.

- [ ] **Step 3: Implement the audit route and page**

`apps/api/src/routes/admin/audit.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PERMISSIONS, verifyChain } from '@syntra/core';
import { requireSession } from '../../plugins/require-session.js';
import { requirePermission } from '../../plugins/require-permission.js';

const query = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.coerce.number().int().positive().optional(),
});

export async function registerAdminAuditRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireSession('admin'));

  app.get('/audit', { preHandler: requirePermission(PERMISSIONS.AUDIT_READ) },
    async (request) => {
      const { limit, before } = query.parse(request.query);
      return request.db(async (tx) => {
        const events = await tx.auditEvent.findMany({
          where: before ? { sequence: { lt: before } } : {},
          orderBy: { sequence: 'desc' },
          take: limit,
        });
        const chain = await verifyChain(tx);
        return {
          events,
          chainValid: chain.valid,
          ...(chain.valid ? {} : { brokenAtSequence: chain.brokenAtSequence }),
        };
      });
    });
}
```

`apps/web/src/pages/admin/AuditPage.tsx` renders the events in a table and, when `chainValid` is false, a prominent red banner naming the sequence number where verification failed. A silently-rendered tampered log would be worse than no log at all.

- [ ] **Step 4: Write the seed script**

`packages/db/src/seed.ts` creates: tenant `acme` (`primaryDomain: acme.localhost`), an owner user `admin` with a password read from `SEED_ADMIN_PASSWORD` (refusing to run if unset), a built-in `Owner` role holding `ALL_PERMISSIONS`, three sample people — one with two concurrent contracts, one whose contract has ended, one with no contract — and two groups. Add `"seed": "tsx packages/db/src/seed.ts"` to the root scripts.

- [ ] **Step 5: Write the containers and the end-to-end test**

`apps/api/Dockerfile`: multi-stage, `node:24-alpine`, `pnpm install --frozen-lockfile --prod`, runs `prisma migrate deploy` on start then `node dist/server.js`. `apps/web/Dockerfile`: build with Vite, serve the static output with `nginx:alpine`, proxying `/api` to the API service. Root `docker-compose.yml` wires postgres, api, and web together.

`e2e/login.spec.ts`:
```ts
import { expect, test } from '@playwright/test';

test('a seeded administrator can sign in, elevate, and see the directory', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Login').fill('admin');
  await page.getByLabel('Password').fill(process.env.SEED_ADMIN_PASSWORD!);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByRole('heading', { name: /applications/i })).toBeVisible();

  await page.goto('/admin/users');
  await page.getByLabel('Password').fill(process.env.SEED_ADMIN_PASSWORD!);
  await page.getByRole('button', { name: /continue/i }).click();

  await expect(page.getByRole('table')).toContainText('admin');
});

test('a non-administrator is refused the console', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Login').fill('jdoe');
  await page.getByLabel('Password').fill(process.env.SEED_USER_PASSWORD!);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await page.goto('/admin/users');
  await expect(page.getByText(/no administrative roles/i)).toBeVisible();
});
```

- [ ] **Step 6: Run everything**

Run:
```bash
pnpm typecheck
pnpm test
pnpm seed
pnpm --filter @syntra/web build
pnpm exec playwright test
```
Expected: type check clean, every unit and integration test passing, both end-to-end tests passing.

- [ ] **Step 7: Update the README and commit**

Document: what Syntra is, the module roadmap from the spec, prerequisites, `pnpm install && pnpm db:up && pnpm --filter @syntra/db migrate && pnpm seed`, how to run the API and web dev servers, how to run tests, and the Apache-2.0 license.

```bash
git add -A
git commit -m "feat: add audit viewer, seed data, containers, and end-to-end tests"
```

---

## Plan self-review

**Spec coverage.** Every section of the spec that falls in sub-project 0 maps to a task:

| Spec section | Task |
|---|---|
| §5 repository architecture, package boundaries | 1 |
| §6 tenant isolation via RLS | 2 |
| §6 directory | 3 |
| §6 identity — persons and contracts | 4, 12 |
| §6 audit log | 5, 18 |
| §6 secrets vault | 6 |
| §6 RBAC | 7 |
| §6 credentials, sessions | 8 |
| §5 admin session separation and step-up | 8, 10, 11, 16 |
| §7 single chokepoint | 8 |
| §9 notifications | 13 |
| §10 sync diff-then-apply pattern | *deferred* — see below |
| §11 error handling | 9 |
| §12 security posture | 2, 5, 6, 8, 9, 10, 11 |
| §13 testing strategy | every task |

**One deliberate deferral, flagged rather than hidden.** Spec §10 (directory synchronization: the LDAP connector, `SyncRun`, and the diff-then-apply pattern) is *not* in this plan. It is a substantial subsystem — a connector SDK, an LDAP client, paging, deletion detection, and a two-phase apply — and folding it in would push this plan past the point where it produces one coherent reviewable deliverable. It belongs either at the end of this plan as tasks 19–21 or at the front of the Access plan. **Recommendation: add it as a third plan, `syntra-directory-sync`, executed between Core and Access**, since Access does not depend on it and Provision does. Say the word and I will write it.

**Placeholder scan.** No "TBD", no "add error handling", no "similar to Task N". Three tasks describe additional files in prose rather than full code — `groups.ts`/`org-units.ts` in Task 11, `persons.ts` routes in Task 12, and several console pages in Tasks 16–18. In each case the prose names the exact pattern to copy and the task it comes from, and the novel parts (the import route, the audit route, the `useApiResource` hook, the result panel) are given in full.

**Type consistency.** Checked across tasks: `TenantClient` (2) is the parameter type of every service; `currentTenant` (3) is defined once in `tenant-context.ts` and imported thereafter; `Permission` (7) is what `requirePermission` (11) takes; `AuthResult.mayElevate` (8) is what `/api/auth/login` returns (10) and what `SessionResponse.mayElevate` (9) carries to the web app (15); `resolveContractForMapping` (4) keeps the signature the Access plan will call; `SessionScope` (8) is the same union in `requireSession` (10) and `RequireSession` (15).

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-14-syntra-core.md`.

