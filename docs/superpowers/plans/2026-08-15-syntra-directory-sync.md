# Syntra Directory Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect an LDAP or Active Directory server as a source, and reconcile Syntra's directory against it on a schedule through a reviewable diff.

**Architecture:** A six-stage pipeline — read, map, correlate, diff, guard, apply. Only `read` talks to LDAP and only `apply` writes to the database; the four stages between are pure functions over data, so mapping, correlation, diffing and the safety threshold are tested without a server or a schema. A run computes the whole diff, writes one `SyncChange` row per proposed action, and stops.

**Tech Stack:** TypeScript 5.9, Node 24, ldapts 9, Prisma 6, PostgreSQL 16, pg-boss 12, Vitest 3, React 19, Docker (OpenLDAP for integration tests).

**Spec:** `docs/superpowers/specs/2026-08-15-syntra-directory-sync-design.md`

## Global Constraints

Everything in the Core plan's Global Constraints still applies. Repeated here because they bite in this slice specifically:

- **Every tenant-scoped table gets `ENABLE` + `FORCE ROW LEVEL SECURITY`** and a `tenant_isolation` policy using `NULLIF(current_setting('app.current_tenant', true), '')::uuid`. Copy the `DO $$` block from an existing migration; the `NULLIF` is not optional.
- **Every database access runs inside `withTenant`**, including test fixtures. A bare `prisma.*.create` on a tenant-scoped table is rejected by the policy.
- **Migrations are generated with `prisma migrate diff`**, not `migrate dev` — the latter is interactive and fails in a non-interactive shell. The exact command is in Task 1.
- **Identity anchors on `objectGUID` / `entryUUID`, never the DN.** A DN changes when a person moves organizational unit; treating it as identity deactivates them and issues a second account.
- **Nothing deletes.** Users and groups deactivate; organizational units are left alone and reported.
- **A background job has no ambient tenant.** Every job payload carries `tenantId` and the handler opens its own `withTenant`.
- **`apply` is the only stage that writes**, and each change commits in one transaction with its audit event.
- **Tests:** TDD. Integration tests run against real PostgreSQL and real OpenLDAP in Docker, never mocks — the properties worth testing here (paged reads, DN resolution, RLS) only exist in the real thing.
- **Commits:** conventional commits, one per task.

---

## File Structure

```
packages/connectors/                    NEW package
  package.json
  tsconfig.json
  src/
    types.ts                            Connector, SourceRecord, ConnectionResult
    ldap/config.ts                      LdapConfig zod schema
    ldap/anchor.ts                      objectGUID / entryUUID normalisation
    ldap/connector.ts                   the LDAP Connector implementation
    index.ts

packages/core/src/sync/
  mapping.ts                            map stage  (pure)
  correlate.ts                          correlate stage (pure)
  diff.ts                               diff stage (pure)
  guard.ts                              guard stage (pure)
  apply.ts                              apply stage (writes)
  run-service.ts                        orchestrates the pipeline, owns SyncRun
  source-service.ts                     DirectorySource + AttributeMapping CRUD
  defaults.ts                           default mappings for AD and OpenLDAP

packages/db/prisma/
  schema.prisma                         + DirectorySource, AttributeMapping,
                                          SyncRun, SyncChange; sourceId and
                                          sourceAnchor on User/Group/OrgUnit

apps/api/src/routes/admin/
  sources.ts                            source CRUD, test connection, run now
  sync-runs.ts                          run list, run detail, apply, skip

apps/web/src/pages/admin/
  SourcesPage.tsx                       list of sources
  SourceDetailPage.tsx                  config + mappings + test connection
  SyncRunsPage.tsx                      run history
  SyncRunDetailPage.tsx                 the diff review screen

infra/
  docker-compose.yml                    + openldap service for tests
  ldap/seed.ldif                        fixture directory
```

`packages/connectors` depends only on `packages/core`'s types, never on `db` —
a connector reads a remote system and knows nothing about how Syntra stores
what it returns.

---

## Task 1: Data model

**Files:**
- Modify: `packages/db/prisma/schema.prisma`
- Create: `packages/db/prisma/migrations/<timestamp>_directory_sync/migration.sql`
- Test: `packages/db/src/sync-schema.test.ts`

**Interfaces:**
- Consumes: `withTenant`, `resetDatabase` from `@syntra/db`.
- Produces: the Prisma models every later task reads and writes — `DirectorySource`, `AttributeMapping`, `SyncRun`, `SyncChange`, and `sourceId` / `sourceAnchor` on `User`, `Group`, `OrgUnit`.

- [ ] **Step 1: Extend the schema**

Append to `packages/db/prisma/schema.prisma`:

```prisma
model DirectorySource {
  id                           String    @id @default(uuid()) @db.Uuid
  tenantId                     String    @db.Uuid
  name                         String
  type                         String    @default("ldap")
  config                       Json
  secretName                   String
  schedule                     String?
  autoApply                    Boolean   @default(false)
  deactivationThresholdPercent Int       @default(10)
  enabled                      Boolean   @default(true)
  lastRunAt                    DateTime?
  createdAt                    DateTime  @default(now())
  updatedAt                    DateTime  @updatedAt

  mappings AttributeMapping[]
  runs     SyncRun[]

  @@unique([tenantId, name])
  @@index([tenantId])
}

model AttributeMapping {
  id              String  @id @default(uuid()) @db.Uuid
  tenantId        String  @db.Uuid
  sourceId        String  @db.Uuid
  source          DirectorySource @relation(fields: [sourceId], references: [id], onDelete: Cascade)
  objectType      String
  sourceAttribute String
  targetField     String
  transform       String  @default("none")
  isCorrelation   Boolean @default(false)

  @@unique([sourceId, objectType, targetField])
  @@index([tenantId])
}

model SyncRun {
  id                   String    @id @default(uuid()) @db.Uuid
  tenantId             String    @db.Uuid
  sourceId             String    @db.Uuid
  source               DirectorySource @relation(fields: [sourceId], references: [id], onDelete: Cascade)
  status               String    @default("running")
  startedAt            DateTime  @default(now())
  finishedAt           DateTime?
  recordsRead          Int       @default(0)
  requiresConfirmation Boolean   @default(false)
  blockedReason        String?
  error                String?
  unresolvedMembers    Int       @default(0)

  changes SyncChange[]

  @@index([tenantId, startedAt])
  @@index([sourceId])
}

model SyncChange {
  id           String  @id @default(uuid()) @db.Uuid
  tenantId     String  @db.Uuid
  runId        String  @db.Uuid
  run          SyncRun @relation(fields: [runId], references: [id], onDelete: Cascade)
  changeType   String
  targetType   String
  targetId     String? @db.Uuid
  sourceAnchor String?
  before       Json?
  after        Json?
  status       String  @default("proposed")
  message      String?

  @@index([tenantId])
  @@index([runId, changeType])
}
```

Add to `User`, `Group` and `OrgUnit`, each:

```prisma
  sourceId     String? @db.Uuid
  sourceAnchor String?
```

And to `Group` only, so a group absent from the source can be deactivated the
way a user can rather than having its reason written into a description field:

```prisma
  status       String  @default("active")
  statusReason String?
```

and to each of their `@@` blocks:

```prisma
  @@unique([tenantId, sourceId, sourceAnchor])
```

- [ ] **Step 2: Generate the migration**

`migrate dev` is interactive and fails here. Use `migrate diff`:

```bash
cd packages/db
D="prisma/migrations/$(date +%Y%m%d%H%M%S)_directory_sync"
mkdir -p "$D"
pnpm prisma migrate diff \
  --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url "postgresql://syntra_app:syntra_app@localhost:5432/syntra_shadow" \
  --script > "$D/migration.sql"
```

- [ ] **Step 3: Append row-level security**

Append to that `migration.sql`:

```sql
-- Row-level security. FORCE subjects the owning role to its own policies;
-- NULLIF is required because a GUC set with set_config(..., true) reverts to
-- an empty string, not NULL, when the transaction ends.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['DirectorySource','AttributeMapping','SyncRun','SyncChange'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid) WITH CHECK ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid)',
      t);
  END LOOP;
END $$;
```

- [ ] **Step 4: Apply and regenerate**

```bash
cd packages/db && pnpm prisma migrate deploy && pnpm prisma generate
```

- [ ] **Step 5: Write the failing test**

`packages/db/src/sync-schema.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from './client.js';
import { withTenant } from './with-tenant.js';
import { resetDatabase } from './test-support.js';

let tenantId: string;

const source = (name = 'Head office AD') => ({
  name,
  type: 'ldap',
  config: { host: 'ldap.acme.test', port: 636 },
  secretName: 'ldap.bindPassword',
});

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
});

describe('directory sync schema', () => {
  it('stores a source without its password', async () => {
    const created = await withTenant(tenantId, (tx) =>
      tx.directorySource.create({ data: { tenantId, ...source() } }),
    );
    expect(created.deactivationThresholdPercent).toBe(10);
    expect(created.autoApply).toBe(false);
    // The credential lives in the vault; only its name is on the row.
    expect(JSON.stringify(created)).not.toContain('password":');
  });

  it('isolates sources between tenants', async () => {
    const other = await prisma.tenant.create({
      data: { name: 'Other', slug: 'other' },
    });
    await withTenant(tenantId, (tx) =>
      tx.directorySource.create({ data: { tenantId, ...source() } }),
    );

    const seen = await withTenant(other.id, (tx) =>
      tx.directorySource.findMany(),
    );
    expect(seen).toEqual([]);
  });

  it('refuses two users with the same anchor from one source', async () => {
    const srcId = await withTenant(tenantId, async (tx) => {
      const s = await tx.directorySource.create({
        data: { tenantId, ...source() },
      });
      await tx.user.create({
        data: {
          tenantId,
          login: 'a',
          email: 'a@acme.test',
          displayName: 'A',
          sourceId: s.id,
          sourceAnchor: 'anchor-1',
        },
      });
      return s.id;
    });

    await expect(
      withTenant(tenantId, (tx) =>
        tx.user.create({
          data: {
            tenantId,
            login: 'b',
            email: 'b@acme.test',
            displayName: 'B',
            sourceId: srcId,
            sourceAnchor: 'anchor-1',
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('allows many locally managed users, which all have a null source', async () => {
    await withTenant(tenantId, async (tx) => {
      await tx.user.create({
        data: { tenantId, login: 'a', email: 'a@acme.test', displayName: 'A' },
      });
      await tx.user.create({
        data: { tenantId, login: 'b', email: 'b@acme.test', displayName: 'B' },
      });
    });

    const users = await withTenant(tenantId, (tx) => tx.user.findMany());
    expect(users).toHaveLength(2);
    expect(users.every((u) => u.sourceId === null)).toBe(true);
  });

  it('gives a group a status, so it can be deactivated like a user', async () => {
    const group = await withTenant(tenantId, (tx) =>
      tx.group.create({ data: { tenantId, name: 'Nurses' } }),
    );
    expect(group.status).toBe('active');

    const off = await withTenant(tenantId, (tx) =>
      tx.group.update({
        where: { id: group.id },
        data: { status: 'inactive', statusReason: 'Absent from source' },
      }),
    );
    expect(off.statusReason).toBe('Absent from source');
  });

  it('cascades runs and changes when a source is removed', async () => {
    await withTenant(tenantId, async (tx) => {
      const s = await tx.directorySource.create({
        data: { tenantId, ...source() },
      });
      const run = await tx.syncRun.create({
        data: { tenantId, sourceId: s.id },
      });
      await tx.syncChange.create({
        data: {
          tenantId,
          runId: run.id,
          changeType: 'create_user',
          targetType: 'User',
        },
      });
      await tx.directorySource.delete({ where: { id: s.id } });
    });

    expect(await withTenant(tenantId, (tx) => tx.syncRun.count())).toBe(0);
    expect(await withTenant(tenantId, (tx) => tx.syncChange.count())).toBe(0);
  });
});
```

- [ ] **Step 6: Run the test**

Run: `pnpm vitest run packages/db/src/sync-schema.test.ts`
Expected: PASS, 6 tests.

If the "same anchor" test does not reject, the `@@unique([tenantId, sourceId, sourceAnchor])` was not added to `User`. Do not proceed — every later stage assumes the anchor is unique per source.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add directory sync data model"
```

---

## Task 2: Connector interface and source records

**Files:**
- Create: `packages/connectors/package.json`, `packages/connectors/tsconfig.json`
- Create: `packages/connectors/src/types.ts`, `packages/connectors/src/index.ts`
- Test: `packages/connectors/src/types.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type ObjectType = 'user' | 'group' | 'orgUnit'`
  - `interface SourceRecord { anchor: string; objectType: ObjectType; dn: string; attributes: Record<string, string[]>; memberDns?: string[] }`
  - `interface ConnectionResult { ok: boolean; message: string; sampleCounts?: Record<ObjectType, number> }`
  - `interface SchemaDescriptor { objectClasses: string[]; attributes: string[] }`
  - `interface Connector<C> { test(config: C): Promise<ConnectionResult>; discoverSchema(config: C): Promise<SchemaDescriptor>; read(config: C): AsyncIterable<SourceRecord>; write(config: C, op: WriteOperation): Promise<WriteResult> }`
  - `first(record: SourceRecord, attribute: string): string | undefined`

- [ ] **Step 1: Create the package**

`packages/connectors/package.json`:

```json
{
  "name": "@syntra/connectors",
  "version": "0.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "license": "Apache-2.0",
  "dependencies": {
    "ldapts": "^9.0.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "typescript": "^5.7.2"
  }
}
```

`packages/connectors/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src", "types": ["node"] },
  "include": ["src"]
}
```

Add `{ "path": "packages/connectors" }` to the root `tsconfig.json` references,
then `pnpm install`.

- [ ] **Step 2: Write the failing test**

`packages/connectors/src/types.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { first, type SourceRecord } from './types.js';

const record: SourceRecord = {
  anchor: 'a1',
  objectType: 'user',
  dn: 'cn=Jo,ou=Care,dc=acme,dc=test',
  attributes: {
    cn: ['Jo Doe'],
    mail: ['jo@acme.test'],
    memberOf: ['cn=Nurses,dc=acme,dc=test', 'cn=Staff,dc=acme,dc=test'],
    empty: [],
  },
};

describe('first', () => {
  it('returns the first value of a multi-valued attribute', () => {
    // LDAP attributes are always multi-valued on the wire, even when the
    // schema says otherwise, so callers must not index blindly.
    expect(first(record, 'memberOf')).toBe('cn=Nurses,dc=acme,dc=test');
  });

  it('returns a single value', () => {
    expect(first(record, 'mail')).toBe('jo@acme.test');
  });

  it('returns undefined for an attribute that is present but empty', () => {
    expect(first(record, 'empty')).toBeUndefined();
  });

  it('returns undefined for an absent attribute', () => {
    expect(first(record, 'telephoneNumber')).toBeUndefined();
  });

  it('is case-insensitive, because LDAP attribute names are', () => {
    expect(first(record, 'MAIL')).toBe('jo@acme.test');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run packages/connectors/src/types.test.ts`
Expected: FAIL — cannot resolve `./types.js`.

- [ ] **Step 4: Implement the types**

`packages/connectors/src/types.ts`:

```ts
export type ObjectType = 'user' | 'group' | 'orgUnit';

/**
 * One object as the source presented it. Attributes are always arrays because
 * that is what LDAP returns, regardless of what the schema claims about
 * single-valued attributes.
 */
export interface SourceRecord {
  /** Immutable identifier. Never the DN — a DN changes when an object moves. */
  anchor: string;
  objectType: ObjectType;
  dn: string;
  attributes: Record<string, string[]>;
  /** Present on groups: the DNs of members, resolved to anchors by the reader. */
  memberDns?: string[];
}

export interface ConnectionResult {
  ok: boolean;
  message: string;
  sampleCounts?: Record<ObjectType, number>;
}

export interface SchemaDescriptor {
  objectClasses: string[];
  attributes: string[];
}

export interface WriteOperation {
  objectType: ObjectType;
  anchor: string;
  attributes: Record<string, string[]>;
}

export interface WriteResult {
  ok: boolean;
  message: string;
}

export interface Connector<C> {
  test(config: C): Promise<ConnectionResult>;
  discoverSchema(config: C): Promise<SchemaDescriptor>;
  read(config: C): AsyncIterable<SourceRecord>;
  /** Declared for Provision. Unimplemented by LDAP in this slice. */
  write(config: C, op: WriteOperation): Promise<WriteResult>;
}

/**
 * First value of an attribute, matched case-insensitively because LDAP
 * attribute names are case-insensitive and servers differ on what they return.
 */
export function first(
  record: SourceRecord,
  attribute: string,
): string | undefined {
  const wanted = attribute.toLowerCase();
  for (const [key, values] of Object.entries(record.attributes)) {
    if (key.toLowerCase() === wanted) return values[0];
  }
  return undefined;
}
```

`packages/connectors/src/index.ts`:

```ts
export * from './types.js';
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run packages/connectors/src/types.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add connector interface and source record types"
```

---

## Task 3: Anchor normalisation

**Files:**
- Create: `packages/connectors/src/ldap/anchor.ts`
- Test: `packages/connectors/src/ldap/anchor.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `normaliseAnchor(attribute: string, raw: Buffer | string): string`

- [ ] **Step 1: Write the failing test**

`packages/connectors/src/ldap/anchor.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { normaliseAnchor } from './anchor.js';

describe('normaliseAnchor', () => {
  it('renders an Active Directory objectGUID in canonical form', () => {
    // objectGUID is a raw 16-byte little-endian GUID. Microsoft tooling shows
    // it with the first three groups byte-reversed; matching that means an
    // administrator can paste an anchor from Syntra into AD and find the row.
    const raw = Buffer.from([
      0x78, 0x56, 0x34, 0x12, 0xbc, 0x9a, 0xf0, 0xde, 0x11, 0x22, 0x33, 0x44,
      0x55, 0x66, 0x77, 0x88,
    ]);
    expect(normaliseAnchor('objectGUID', raw)).toBe(
      '12345678-9abc-def0-1122-334455667788',
    );
  });

  it('is stable across calls', () => {
    const raw = Buffer.from([
      0x78, 0x56, 0x34, 0x12, 0xbc, 0x9a, 0xf0, 0xde, 0x11, 0x22, 0x33, 0x44,
      0x55, 0x66, 0x77, 0x88,
    ]);
    expect(normaliseAnchor('objectGUID', raw)).toBe(
      normaliseAnchor('objectGUID', raw),
    );
  });

  it('passes an OpenLDAP entryUUID through, lowercased', () => {
    expect(normaliseAnchor('entryUUID', '8A7B6C5D-1111-2222-3333-444455556666')).toBe(
      '8a7b6c5d-1111-2222-3333-444455556666',
    );
  });

  it('trims a text anchor', () => {
    expect(normaliseAnchor('entryUUID', '  abc-123  ')).toBe('abc-123');
  });

  it('rejects an objectGUID that is not 16 bytes', () => {
    expect(() => normaliseAnchor('objectGUID', Buffer.alloc(8))).toThrow(
      /16 bytes/,
    );
  });

  it('rejects an empty anchor rather than returning one', () => {
    // An empty anchor would collide with every other empty anchor and silently
    // merge unrelated people.
    expect(() => normaliseAnchor('entryUUID', '   ')).toThrow(/empty/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/connectors/src/ldap/anchor.test.ts`
Expected: FAIL — cannot resolve `./anchor.js`.

- [ ] **Step 3: Implement it**

`packages/connectors/src/ldap/anchor.ts`:

```ts
/**
 * Turns whatever the server returned for the anchor attribute into a stable
 * string.
 *
 * Active Directory returns objectGUID as 16 raw bytes with the first three
 * groups little-endian. Rendering it the way Microsoft tooling does means an
 * anchor shown in Syntra can be pasted into AD and find the same object.
 * OpenLDAP returns entryUUID as text already.
 */
export function normaliseAnchor(
  attribute: string,
  raw: Buffer | string,
): string {
  if (Buffer.isBuffer(raw)) {
    if (raw.length !== 16) {
      throw new Error(
        `${attribute} must be 16 bytes, received ${raw.length}`,
      );
    }
    const hex = (start: number, end: number, reverse: boolean) => {
      const slice = raw.subarray(start, end);
      const bytes = reverse ? [...slice].reverse() : [...slice];
      return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
    };
    return [
      hex(0, 4, true),
      hex(4, 6, true),
      hex(6, 8, true),
      hex(8, 10, false),
      hex(10, 16, false),
    ].join('-');
  }

  const trimmed = raw.trim().toLowerCase();
  if (trimmed === '') {
    throw new Error(`${attribute} is empty; an anchor must identify an object`);
  }
  return trimmed;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/connectors/src/ldap/anchor.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: normalise objectGUID and entryUUID anchors"
```

---

## Task 4: Mapping stage

**Files:**
- Create: `packages/core/src/sync/mapping.ts`
- Test: `packages/core/src/sync/mapping.test.ts`
- Modify: `packages/core/package.json` — add `"@syntra/connectors": "workspace:*"`

**Interfaces:**
- Consumes: `SourceRecord`, `first` from `@syntra/connectors`.
- Produces:
  - `interface MappingRule { objectType: ObjectType; sourceAttribute: string; targetField: string; transform: 'none' | 'trim' | 'lowercase'; isCorrelation: boolean }`
  - `interface DirectoryObject { anchor: string; objectType: ObjectType; dn: string; fields: Record<string, string>; correlationValue?: string; memberDns: string[] }`
  - `mapRecord(record: SourceRecord, rules: MappingRule[]): DirectoryObject | MappingFailure`
  - `type MappingFailure = { failed: true; anchor: string; reason: string }`
  - `isMappingFailure(value: DirectoryObject | MappingFailure): value is MappingFailure`

- [ ] **Step 1: Write the failing test**

`packages/core/src/sync/mapping.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { SourceRecord } from '@syntra/connectors';
import {
  isMappingFailure,
  mapRecord,
  type MappingRule,
} from './mapping.js';

const rules: MappingRule[] = [
  {
    objectType: 'user',
    sourceAttribute: 'sAMAccountName',
    targetField: 'login',
    transform: 'lowercase',
    isCorrelation: true,
  },
  {
    objectType: 'user',
    sourceAttribute: 'mail',
    targetField: 'email',
    transform: 'lowercase',
    isCorrelation: false,
  },
  {
    objectType: 'user',
    sourceAttribute: 'displayName',
    targetField: 'displayName',
    transform: 'trim',
    isCorrelation: false,
  },
];

const record = (attributes: Record<string, string[]>): SourceRecord => ({
  anchor: 'a1',
  objectType: 'user',
  dn: 'cn=Jo,dc=acme,dc=test',
  attributes,
});

describe('mapRecord', () => {
  it('applies each rule and its transform', () => {
    const result = mapRecord(
      record({
        sAMAccountName: ['JDoe'],
        mail: ['Jo.Doe@ACME.test'],
        displayName: ['  Jo Doe  '],
      }),
      rules,
    );

    expect(isMappingFailure(result)).toBe(false);
    if (isMappingFailure(result)) return;
    expect(result.fields).toEqual({
      login: 'jdoe',
      email: 'jo.doe@acme.test',
      displayName: 'Jo Doe',
    });
  });

  it('records the correlation value from the rule marked as the key', () => {
    const result = mapRecord(
      record({ sAMAccountName: ['JDoe'], mail: ['j@acme.test'], displayName: ['Jo'] }),
      rules,
    );
    if (isMappingFailure(result)) throw new Error('expected success');
    expect(result.correlationValue).toBe('jdoe');
  });

  it('omits a field whose source attribute is absent', () => {
    const result = mapRecord(
      record({ sAMAccountName: ['jdoe'], displayName: ['Jo'] }),
      rules,
    );
    if (isMappingFailure(result)) throw new Error('expected success');
    expect(result.fields).not.toHaveProperty('email');
  });

  it('fails the record when the correlation attribute is missing', () => {
    // Without a correlation value the object cannot be matched to anything,
    // and guessing would risk attaching it to the wrong account.
    const result = mapRecord(record({ mail: ['j@acme.test'] }), rules);
    expect(isMappingFailure(result)).toBe(true);
    if (!isMappingFailure(result)) return;
    expect(result.reason).toMatch(/correlation/i);
  });

  it('ignores rules for a different object type', () => {
    const mixed: MappingRule[] = [
      ...rules,
      {
        objectType: 'group',
        sourceAttribute: 'cn',
        targetField: 'name',
        transform: 'none',
        isCorrelation: true,
      },
    ];
    const result = mapRecord(
      record({ sAMAccountName: ['jdoe'], cn: ['Nurses'], displayName: ['Jo'] }),
      mixed,
    );
    if (isMappingFailure(result)) throw new Error('expected success');
    expect(result.fields).not.toHaveProperty('name');
  });

  it('carries member DNs through untouched', () => {
    const group: SourceRecord = {
      anchor: 'g1',
      objectType: 'group',
      dn: 'cn=Nurses,dc=acme,dc=test',
      attributes: { cn: ['Nurses'] },
      memberDns: ['cn=Jo,dc=acme,dc=test'],
    };
    const result = mapRecord(group, [
      {
        objectType: 'group',
        sourceAttribute: 'cn',
        targetField: 'name',
        transform: 'none',
        isCorrelation: true,
      },
    ]);
    if (isMappingFailure(result)) throw new Error('expected success');
    expect(result.memberDns).toEqual(['cn=Jo,dc=acme,dc=test']);
  });

  it('returns an empty member list when there are none', () => {
    const result = mapRecord(
      record({ sAMAccountName: ['jdoe'], displayName: ['Jo'] }),
      rules,
    );
    if (isMappingFailure(result)) throw new Error('expected success');
    expect(result.memberDns).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/core/src/sync/mapping.test.ts`
Expected: FAIL — cannot resolve `./mapping.js`.

- [ ] **Step 3: Implement it**

`packages/core/src/sync/mapping.ts`:

```ts
import { first, type ObjectType, type SourceRecord } from '@syntra/connectors';

export interface MappingRule {
  objectType: ObjectType;
  sourceAttribute: string;
  targetField: string;
  transform: 'none' | 'trim' | 'lowercase';
  isCorrelation: boolean;
}

export interface DirectoryObject {
  anchor: string;
  objectType: ObjectType;
  dn: string;
  fields: Record<string, string>;
  correlationValue?: string;
  memberDns: string[];
}

export type MappingFailure = {
  failed: true;
  anchor: string;
  reason: string;
};

export function isMappingFailure(
  value: DirectoryObject | MappingFailure,
): value is MappingFailure {
  return (value as MappingFailure).failed === true;
}

function applyTransform(value: string, transform: MappingRule['transform']) {
  switch (transform) {
    case 'trim':
      return value.trim();
    case 'lowercase':
      return value.trim().toLowerCase();
    default:
      return value;
  }
}

/**
 * Turns a raw source record into the shape Syntra stores, using the mappings
 * configured for its object type.
 *
 * A record with no correlation value is failed rather than mapped: it cannot
 * be matched to anything, and guessing risks attaching it to the wrong
 * account.
 */
export function mapRecord(
  record: SourceRecord,
  rules: MappingRule[],
): DirectoryObject | MappingFailure {
  const applicable = rules.filter((r) => r.objectType === record.objectType);

  const fields: Record<string, string> = {};
  let correlationValue: string | undefined;

  for (const rule of applicable) {
    const raw = first(record, rule.sourceAttribute);
    if (raw === undefined) continue;

    const value = applyTransform(raw, rule.transform);
    fields[rule.targetField] = value;
    if (rule.isCorrelation) correlationValue = value;
  }

  if (correlationValue === undefined) {
    return {
      failed: true,
      anchor: record.anchor,
      reason: 'the correlation attribute is missing from this record',
    };
  }

  return {
    anchor: record.anchor,
    objectType: record.objectType,
    dn: record.dn,
    fields,
    correlationValue,
    memberDns: record.memberDns ?? [],
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/core/src/sync/mapping.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add sync mapping stage"
```

---

## Task 5: Correlation stage

**Files:**
- Create: `packages/core/src/sync/correlate.ts`
- Test: `packages/core/src/sync/correlate.test.ts`

**Interfaces:**
- Consumes: `DirectoryObject` from `./mapping.js`.
- Produces:
  - `interface ExistingObject { id: string; objectType: ObjectType; sourceId: string | null; sourceAnchor: string | null; correlationValue: string; status: string }`
  - `type Correlation = { kind: 'matched'; object: DirectoryObject; existing: ExistingObject } | { kind: 'new'; object: DirectoryObject } | { kind: 'conflict'; object: DirectoryObject; existing: ExistingObject; reason: string }`
  - `correlate(objects: DirectoryObject[], existing: ExistingObject[], sourceId: string): Correlation[]`
  - `absentAnchors(objects: DirectoryObject[], existing: ExistingObject[], sourceId: string): ExistingObject[]`

- [ ] **Step 1: Write the failing test**

`packages/core/src/sync/correlate.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { absentAnchors, correlate, type ExistingObject } from './correlate.js';
import type { DirectoryObject } from './mapping.js';

const SOURCE = 'src-1';
const OTHER_SOURCE = 'src-2';

const obj = (
  anchor: string,
  correlationValue: string,
  dn = `cn=${correlationValue},dc=acme,dc=test`,
): DirectoryObject => ({
  anchor,
  objectType: 'user',
  dn,
  fields: { login: correlationValue },
  correlationValue,
  memberDns: [],
});

const existing = (
  id: string,
  correlationValue: string,
  sourceId: string | null,
  sourceAnchor: string | null,
  status = 'active',
): ExistingObject => ({
  id,
  objectType: 'user',
  sourceId,
  sourceAnchor,
  correlationValue,
  status,
});

describe('correlate', () => {
  it('matches on the anchor even when every other field changed', () => {
    // This is the organizational-unit move: same person, new DN, new login.
    const result = correlate(
      [obj('a1', 'jo.doe', 'cn=Jo,ou=Learning,dc=acme,dc=test')],
      [existing('u1', 'jdoe', SOURCE, 'a1')],
      SOURCE,
    );
    expect(result[0]!.kind).toBe('matched');
    if (result[0]!.kind !== 'matched') return;
    expect(result[0]!.existing.id).toBe('u1');
  });

  it('treats an unseen anchor with no correlation match as new', () => {
    const result = correlate([obj('a9', 'newbie')], [], SOURCE);
    expect(result[0]!.kind).toBe('new');
  });

  it('reports a match against a locally managed account as a conflict', () => {
    // Adopting silently would let anyone able to write to the directory
    // capture an existing Syntra account.
    const result = correlate(
      [obj('a1', 'admin')],
      [existing('u1', 'admin', null, null)],
      SOURCE,
    );
    expect(result[0]!.kind).toBe('conflict');
    if (result[0]!.kind !== 'conflict') return;
    expect(result[0]!.reason).toMatch(/locally managed/i);
  });

  it('reports a match against another source as a conflict, never a transfer', () => {
    const result = correlate(
      [obj('a1', 'jdoe')],
      [existing('u1', 'jdoe', OTHER_SOURCE, 'b7')],
      SOURCE,
    );
    expect(result[0]!.kind).toBe('conflict');
    if (result[0]!.kind !== 'conflict') return;
    expect(result[0]!.reason).toMatch(/another source/i);
  });

  it('prefers the anchor over the correlation value', () => {
    // Two rows could both look plausible; the anchor is authoritative.
    const result = correlate(
      [obj('a1', 'shared')],
      [
        existing('u-anchor', 'different', SOURCE, 'a1'),
        existing('u-value', 'shared', null, null),
      ],
      SOURCE,
    );
    expect(result[0]!.kind).toBe('matched');
    if (result[0]!.kind !== 'matched') return;
    expect(result[0]!.existing.id).toBe('u-anchor');
  });

  it('correlates case-insensitively', () => {
    const result = correlate(
      [obj('a1', 'jdoe')],
      [existing('u1', 'JDoe', null, null)],
      SOURCE,
    );
    expect(result[0]!.kind).toBe('conflict');
  });
});

describe('absentAnchors', () => {
  it('returns rows from this source whose anchor was not read', () => {
    const gone = absentAnchors(
      [obj('a1', 'jdoe')],
      [existing('u1', 'jdoe', SOURCE, 'a1'), existing('u2', 'sroe', SOURCE, 'a2')],
      SOURCE,
    );
    expect(gone.map((e) => e.id)).toEqual(['u2']);
  });

  it('never returns a locally managed row', () => {
    const gone = absentAnchors(
      [],
      [existing('u1', 'admin', null, null)],
      SOURCE,
    );
    expect(gone).toEqual([]);
  });

  it('never returns a row belonging to another source', () => {
    const gone = absentAnchors(
      [],
      [existing('u1', 'jdoe', OTHER_SOURCE, 'b7')],
      SOURCE,
    );
    expect(gone).toEqual([]);
  });

  it('does not report an already inactive row again', () => {
    const gone = absentAnchors(
      [],
      [existing('u1', 'jdoe', SOURCE, 'a1', 'inactive')],
      SOURCE,
    );
    expect(gone).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/core/src/sync/correlate.test.ts`
Expected: FAIL — cannot resolve `./correlate.js`.

- [ ] **Step 3: Implement it**

`packages/core/src/sync/correlate.ts`:

```ts
import type { ObjectType } from '@syntra/connectors';
import type { DirectoryObject } from './mapping.js';

export interface ExistingObject {
  id: string;
  objectType: ObjectType;
  sourceId: string | null;
  sourceAnchor: string | null;
  correlationValue: string;
  status: string;
}

export type Correlation =
  | { kind: 'matched'; object: DirectoryObject; existing: ExistingObject }
  | { kind: 'new'; object: DirectoryObject }
  | {
      kind: 'conflict';
      object: DirectoryObject;
      existing: ExistingObject;
      reason: string;
    };

const key = (value: string) => value.trim().toLowerCase();

/**
 * Resolves each mapped object to an existing row, a conflict, or new.
 *
 * The anchor is authoritative and is tried first, so an object that moved and
 * was renamed still matches itself. A correlation-value match against a row
 * this source does not own is a conflict rather than an adoption.
 */
export function correlate(
  objects: DirectoryObject[],
  existing: ExistingObject[],
  sourceId: string,
): Correlation[] {
  const byAnchor = new Map<string, ExistingObject>();
  const byValue = new Map<string, ExistingObject>();

  for (const row of existing) {
    if (row.sourceId === sourceId && row.sourceAnchor) {
      byAnchor.set(row.sourceAnchor, row);
    }
    byValue.set(`${row.objectType}:${key(row.correlationValue)}`, row);
  }

  return objects.map((object): Correlation => {
    const anchored = byAnchor.get(object.anchor);
    if (anchored) return { kind: 'matched', object, existing: anchored };

    const value = object.correlationValue;
    const candidate =
      value === undefined
        ? undefined
        : byValue.get(`${object.objectType}:${key(value)}`);

    if (!candidate) return { kind: 'new', object };

    if (candidate.sourceId === null) {
      return {
        kind: 'conflict',
        object,
        existing: candidate,
        reason:
          'matches a locally managed object; adopt it explicitly if they are the same',
      };
    }

    return {
      kind: 'conflict',
      object,
      existing: candidate,
      reason: 'matches an object owned by another source',
    };
  });
}

/**
 * Rows this source owns that were not seen in this read, and are still active.
 * Locally managed rows and rows owned by another source are never touched.
 */
export function absentAnchors(
  objects: DirectoryObject[],
  existing: ExistingObject[],
  sourceId: string,
): ExistingObject[] {
  const seen = new Set(objects.map((o) => o.anchor));
  return existing.filter(
    (row) =>
      row.sourceId === sourceId &&
      row.sourceAnchor !== null &&
      !seen.has(row.sourceAnchor) &&
      row.status === 'active',
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/core/src/sync/correlate.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add sync correlation stage"
```

---

## Task 6: Diff stage

**Files:**
- Create: `packages/core/src/sync/diff.ts`
- Test: `packages/core/src/sync/diff.test.ts`

**Interfaces:**
- Consumes: `Correlation`, `ExistingObject` from `./correlate.js`; `DirectoryObject` from `./mapping.js`.
- Produces:
  - `type ChangeType = 'create_user' | 'update_user' | 'deactivate_user' | 'reactivate_user' | 'create_group' | 'update_group' | 'deactivate_group' | 'add_member' | 'remove_member' | 'create_org_unit' | 'update_org_unit'`
  - `interface ProposedChange { changeType: ChangeType; targetType: 'User' | 'Group' | 'OrgUnit' | 'GroupMembership'; targetId: string | null; sourceAnchor: string | null; before: Record<string, unknown> | null; after: Record<string, unknown> | null; status: 'proposed' | 'conflict'; message?: string }`
  - `interface MembershipState { groupAnchor: string; memberAnchors: string[] }`
  - `diffObjects(correlations: Correlation[], absent: ExistingObject[], currentFields: Map<string, Record<string, string>>): ProposedChange[]`
  - `diffMemberships(desired: MembershipState[], current: MembershipState[]): ProposedChange[]`

- [ ] **Step 1: Write the failing test**

`packages/core/src/sync/diff.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { diffMemberships, diffObjects } from './diff.js';
import type { Correlation, ExistingObject } from './correlate.js';
import type { DirectoryObject } from './mapping.js';

const object = (
  anchor: string,
  fields: Record<string, string>,
  objectType: DirectoryObject['objectType'] = 'user',
): DirectoryObject => ({
  anchor,
  objectType,
  dn: `cn=${anchor},dc=acme,dc=test`,
  fields,
  correlationValue: fields.login ?? fields.name ?? anchor,
  memberDns: [],
});

const existing = (
  id: string,
  status = 'active',
): ExistingObject => ({
  id,
  objectType: 'user',
  sourceId: 'src-1',
  sourceAnchor: 'a1',
  correlationValue: 'jdoe',
  status,
});

describe('diffObjects', () => {
  it('proposes a create for a new object', () => {
    const changes = diffObjects(
      [{ kind: 'new', object: object('a1', { login: 'jdoe' }) }],
      [],
      new Map(),
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      changeType: 'create_user',
      targetId: null,
      sourceAnchor: 'a1',
      status: 'proposed',
    });
    expect(changes[0]!.after).toEqual({ login: 'jdoe' });
  });

  it('proposes nothing when every mapped field already matches', () => {
    // The common case by far. A run over an unchanged directory must be empty,
    // or every run would look like it did something.
    const changes = diffObjects(
      [
        {
          kind: 'matched',
          object: object('a1', { login: 'jdoe', email: 'j@acme.test' }),
          existing: existing('u1'),
        },
      ],
      [],
      new Map([['u1', { login: 'jdoe', email: 'j@acme.test' }]]),
    );
    expect(changes).toEqual([]);
  });

  it('proposes an update carrying only the changed fields', () => {
    const changes = diffObjects(
      [
        {
          kind: 'matched',
          object: object('a1', { login: 'jdoe', email: 'new@acme.test' }),
          existing: existing('u1'),
        },
      ],
      [],
      new Map([['u1', { login: 'jdoe', email: 'old@acme.test' }]]),
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]!.changeType).toBe('update_user');
    expect(changes[0]!.before).toEqual({ email: 'old@acme.test' });
    expect(changes[0]!.after).toEqual({ email: 'new@acme.test' });
  });

  it('proposes a reactivation for a matched object that is inactive', () => {
    const changes = diffObjects(
      [
        {
          kind: 'matched',
          object: object('a1', { login: 'jdoe' }),
          existing: existing('u1', 'inactive'),
        },
      ],
      [],
      new Map([['u1', { login: 'jdoe' }]]),
    );
    expect(changes.map((c) => c.changeType)).toEqual(['reactivate_user']);
  });

  it('proposes a deactivation for an absent object', () => {
    const changes = diffObjects([], [existing('u2')], new Map());
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      changeType: 'deactivate_user',
      targetId: 'u2',
    });
  });

  it('records a conflict as a change with conflict status and no action', () => {
    const changes = diffObjects(
      [
        {
          kind: 'conflict',
          object: object('a1', { login: 'admin' }),
          existing: existing('u1'),
          reason: 'matches a locally managed object',
        },
      ],
      [],
      new Map(),
    );
    expect(changes[0]!.status).toBe('conflict');
    expect(changes[0]!.message).toMatch(/locally managed/);
  });

  it('uses the group change types for a group', () => {
    const changes = diffObjects(
      [{ kind: 'new', object: object('g1', { name: 'Nurses' }, 'group') }],
      [],
      new Map(),
    );
    expect(changes[0]!.changeType).toBe('create_group');
    expect(changes[0]!.targetType).toBe('Group');
  });
});

describe('diffMemberships', () => {
  it('proposes adding a member that is present in the source only', () => {
    const changes = diffMemberships(
      [{ groupAnchor: 'g1', memberAnchors: ['a1', 'a2'] }],
      [{ groupAnchor: 'g1', memberAnchors: ['a1'] }],
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ changeType: 'add_member' });
    expect(changes[0]!.after).toEqual({ groupAnchor: 'g1', memberAnchor: 'a2' });
  });

  it('proposes removing a member that is present locally only', () => {
    const changes = diffMemberships(
      [{ groupAnchor: 'g1', memberAnchors: ['a1'] }],
      [{ groupAnchor: 'g1', memberAnchors: ['a1', 'a2'] }],
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ changeType: 'remove_member' });
  });

  it('proposes nothing when membership matches regardless of order', () => {
    const changes = diffMemberships(
      [{ groupAnchor: 'g1', memberAnchors: ['a2', 'a1'] }],
      [{ groupAnchor: 'g1', memberAnchors: ['a1', 'a2'] }],
    );
    expect(changes).toEqual([]);
  });

  it('ignores a group the source did not report at all', () => {
    // Absence of a group from the read is handled by diffObjects as a
    // deactivation; it must not also empty the group's membership.
    const changes = diffMemberships(
      [],
      [{ groupAnchor: 'g9', memberAnchors: ['a1'] }],
    );
    expect(changes).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/core/src/sync/diff.test.ts`
Expected: FAIL — cannot resolve `./diff.js`.

- [ ] **Step 3: Implement it**

`packages/core/src/sync/diff.ts`:

```ts
import type { ObjectType } from '@syntra/connectors';
import type { Correlation, ExistingObject } from './correlate.js';

export type ChangeType =
  | 'create_user'
  | 'update_user'
  | 'deactivate_user'
  | 'reactivate_user'
  | 'create_group'
  | 'update_group'
  | 'deactivate_group'
  | 'add_member'
  | 'remove_member'
  | 'create_org_unit'
  | 'update_org_unit';

export type TargetType = 'User' | 'Group' | 'OrgUnit' | 'GroupMembership';

export interface ProposedChange {
  changeType: ChangeType;
  targetType: TargetType;
  targetId: string | null;
  sourceAnchor: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  status: 'proposed' | 'conflict';
  message?: string;
}

export interface MembershipState {
  groupAnchor: string;
  memberAnchors: string[];
}

const TARGET: Record<ObjectType, TargetType> = {
  user: 'User',
  group: 'Group',
  orgUnit: 'OrgUnit',
};

const VERB: Record<ObjectType, Record<'create' | 'update', ChangeType>> = {
  user: { create: 'create_user', update: 'update_user' },
  group: { create: 'create_group', update: 'update_group' },
  orgUnit: { create: 'create_org_unit', update: 'update_org_unit' },
};

/**
 * Compares mapped objects against what is stored and emits one change per
 * difference. An unchanged object produces nothing, so a run over an unchanged
 * directory is empty rather than a wall of no-ops.
 */
export function diffObjects(
  correlations: Correlation[],
  absent: ExistingObject[],
  currentFields: Map<string, Record<string, string>>,
): ProposedChange[] {
  const changes: ProposedChange[] = [];

  for (const correlation of correlations) {
    const { object } = correlation;
    const targetType = TARGET[object.objectType];

    if (correlation.kind === 'conflict') {
      changes.push({
        changeType: VERB[object.objectType].create,
        targetType,
        targetId: correlation.existing.id,
        sourceAnchor: object.anchor,
        before: null,
        after: object.fields,
        status: 'conflict',
        message: correlation.reason,
      });
      continue;
    }

    if (correlation.kind === 'new') {
      changes.push({
        changeType: VERB[object.objectType].create,
        targetType,
        targetId: null,
        sourceAnchor: object.anchor,
        before: null,
        after: object.fields,
        status: 'proposed',
      });
      continue;
    }

    const existing = correlation.existing;

    // A matched object that is inactive has reappeared in the source. Propose
    // restoring it; nothing is applied without an explicit apply step.
    if (existing.status !== 'active') {
      changes.push({
        changeType:
          object.objectType === 'user' ? 'reactivate_user' : VERB[object.objectType].update,
        targetType,
        targetId: existing.id,
        sourceAnchor: object.anchor,
        before: { status: existing.status },
        after: { status: 'active' },
        status: 'proposed',
      });
      continue;
    }

    const current = currentFields.get(existing.id) ?? {};
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};

    for (const [field, value] of Object.entries(object.fields)) {
      if (current[field] !== value) {
        before[field] = current[field] ?? null;
        after[field] = value;
      }
    }

    if (Object.keys(after).length > 0) {
      changes.push({
        changeType: VERB[object.objectType].update,
        targetType,
        targetId: existing.id,
        sourceAnchor: object.anchor,
        before,
        after,
        status: 'proposed',
      });
    }
  }

  for (const row of absent) {
    changes.push({
      changeType:
        row.objectType === 'group' ? 'deactivate_group' : 'deactivate_user',
      targetType: TARGET[row.objectType],
      targetId: row.id,
      sourceAnchor: row.sourceAnchor,
      before: { status: row.status },
      after: { status: 'inactive' },
      status: 'proposed',
    });
  }

  return changes;
}

/**
 * Membership is compared as a set, since neither the source nor the database
 * promises an order.
 *
 * A group missing from `desired` is skipped entirely: its absence from the
 * read is already handled as a deactivation, and emptying its membership as
 * well would revoke access twice over.
 */
export function diffMemberships(
  desired: MembershipState[],
  current: MembershipState[],
): ProposedChange[] {
  const changes: ProposedChange[] = [];
  const currentByGroup = new Map(
    current.map((m) => [m.groupAnchor, new Set(m.memberAnchors)]),
  );

  for (const group of desired) {
    const now = currentByGroup.get(group.groupAnchor) ?? new Set<string>();
    const wanted = new Set(group.memberAnchors);

    for (const anchor of wanted) {
      if (!now.has(anchor)) {
        changes.push({
          changeType: 'add_member',
          targetType: 'GroupMembership',
          targetId: null,
          sourceAnchor: group.groupAnchor,
          before: null,
          after: { groupAnchor: group.groupAnchor, memberAnchor: anchor },
          status: 'proposed',
        });
      }
    }

    for (const anchor of now) {
      if (!wanted.has(anchor)) {
        changes.push({
          changeType: 'remove_member',
          targetType: 'GroupMembership',
          targetId: null,
          sourceAnchor: group.groupAnchor,
          before: { groupAnchor: group.groupAnchor, memberAnchor: anchor },
          after: null,
          status: 'proposed',
        });
      }
    }
  }

  return changes;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/core/src/sync/diff.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add sync diff stage"
```

---

## Task 7: The guard

**Files:**
- Create: `packages/core/src/sync/guard.ts`
- Test: `packages/core/src/sync/guard.test.ts`

**Interfaces:**
- Consumes: `ProposedChange` from `./diff.js`.
- Produces:
  - `interface GuardInput { changes: ProposedChange[]; recordsRead: number; activeUsersFromSource: number; thresholdPercent: number }`
  - `type GuardVerdict = { blocked: false } | { blocked: true; reason: string }`
  - `evaluateGuard(input: GuardInput): GuardVerdict`

- [ ] **Step 1: Write the failing test**

`packages/core/src/sync/guard.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { evaluateGuard } from './guard.js';
import type { ProposedChange } from './diff.js';

const deactivations = (n: number): ProposedChange[] =>
  Array.from({ length: n }, (_, i) => ({
    changeType: 'deactivate_user' as const,
    targetType: 'User' as const,
    targetId: `u${i}`,
    sourceAnchor: `a${i}`,
    before: { status: 'active' },
    after: { status: 'inactive' },
    status: 'proposed' as const,
  }));

describe('evaluateGuard', () => {
  it('blocks a run that read nothing, whatever the diff says', () => {
    // An empty directory and an unreachable one are indistinguishable, and
    // the safe reading is the second.
    const verdict = evaluateGuard({
      changes: deactivations(100),
      recordsRead: 0,
      activeUsersFromSource: 100,
      thresholdPercent: 10,
    });
    expect(verdict).toEqual({
      blocked: true,
      reason: 'the source returned no records',
    });
  });

  it('allows a deactivation count under the threshold', () => {
    const verdict = evaluateGuard({
      changes: deactivations(9),
      recordsRead: 100,
      activeUsersFromSource: 100,
      thresholdPercent: 10,
    });
    expect(verdict).toEqual({ blocked: false });
  });

  it('allows a count exactly at the threshold', () => {
    // "More than" means strictly more; 10 of 100 at a 10% threshold passes.
    const verdict = evaluateGuard({
      changes: deactivations(10),
      recordsRead: 100,
      activeUsersFromSource: 100,
      thresholdPercent: 10,
    });
    expect(verdict).toEqual({ blocked: false });
  });

  it('blocks a count just over the threshold', () => {
    const verdict = evaluateGuard({
      changes: deactivations(11),
      recordsRead: 100,
      activeUsersFromSource: 100,
      thresholdPercent: 10,
    });
    expect(verdict.blocked).toBe(true);
    if (!verdict.blocked) return;
    expect(verdict.reason).toContain('11');
    expect(verdict.reason).toContain('100');
  });

  it('allows a run with no deactivations at all', () => {
    const verdict = evaluateGuard({
      changes: [],
      recordsRead: 100,
      activeUsersFromSource: 100,
      thresholdPercent: 10,
    });
    expect(verdict).toEqual({ blocked: false });
  });

  it('allows any deactivation when the source owned nothing yet', () => {
    // First run against a fresh source: no denominator, nothing to protect.
    const verdict = evaluateGuard({
      changes: [],
      recordsRead: 50,
      activeUsersFromSource: 0,
      thresholdPercent: 10,
    });
    expect(verdict).toEqual({ blocked: false });
  });

  it('counts only deactivations, not creates and updates', () => {
    const verdict = evaluateGuard({
      changes: [
        ...deactivations(5),
        ...Array.from({ length: 50 }, (_, i) => ({
          changeType: 'create_user' as const,
          targetType: 'User' as const,
          targetId: null,
          sourceAnchor: `n${i}`,
          before: null,
          after: {},
          status: 'proposed' as const,
        })),
      ],
      recordsRead: 100,
      activeUsersFromSource: 100,
      thresholdPercent: 10,
    });
    expect(verdict).toEqual({ blocked: false });
  });

  it('blocks on a threshold of zero unless nothing is deactivated', () => {
    expect(
      evaluateGuard({
        changes: deactivations(1),
        recordsRead: 10,
        activeUsersFromSource: 10,
        thresholdPercent: 0,
      }).blocked,
    ).toBe(true);
    expect(
      evaluateGuard({
        changes: [],
        recordsRead: 10,
        activeUsersFromSource: 10,
        thresholdPercent: 0,
      }).blocked,
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/core/src/sync/guard.test.ts`
Expected: FAIL — cannot resolve `./guard.js`.

- [ ] **Step 3: Implement it**

`packages/core/src/sync/guard.ts`:

```ts
import type { ProposedChange } from './diff.js';

export interface GuardInput {
  changes: ProposedChange[];
  recordsRead: number;
  /** Active users this source currently owns — the denominator. */
  activeUsersFromSource: number;
  thresholdPercent: number;
}

export type GuardVerdict = { blocked: false } | { blocked: true; reason: string };

/**
 * Decides whether a diff is safe to apply.
 *
 * This is the protection against a source outage emptying the directory. It
 * is not advisory: a blocked run will not apply even with autoApply on,
 * because an unattended schedule is exactly when nobody is watching.
 */
export function evaluateGuard(input: GuardInput): GuardVerdict {
  if (input.recordsRead === 0) {
    return { blocked: true, reason: 'the source returned no records' };
  }

  const deactivations = input.changes.filter(
    (c) => c.changeType === 'deactivate_user' || c.changeType === 'deactivate_group',
  ).length;

  if (deactivations === 0) return { blocked: false };
  if (input.activeUsersFromSource === 0) return { blocked: false };

  const share = (deactivations / input.activeUsersFromSource) * 100;
  if (share > input.thresholdPercent) {
    return {
      blocked: true,
      reason:
        `would deactivate ${deactivations} of ${input.activeUsersFromSource} ` +
        `objects from this source (${share.toFixed(1)}%), above the ` +
        `${input.thresholdPercent}% threshold`,
    };
  }

  return { blocked: false };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/core/src/sync/guard.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add sync guard against mass deactivation"
```

---

## Task 8: The LDAP connector against a real server

**Files:**
- Create: `packages/connectors/src/ldap/config.ts`, `packages/connectors/src/ldap/connector.ts`
- Modify: `packages/connectors/src/index.ts`
- Modify: `infra/docker-compose.yml`
- Create: `infra/ldap/seed.ldif`
- Test: `packages/connectors/src/ldap/connector.test.ts`

**Interfaces:**
- Consumes: `Connector`, `SourceRecord`, `normaliseAnchor`.
- Produces:
  - `LdapConfig` (zod schema and inferred type): `{ url, bindDn, userSearchBase, groupSearchBase, orgUnitSearchBase?, userFilter, groupFilter, anchorAttribute, pageSize, rejectUnauthorized }`
  - `ldapConnector: Connector<LdapConfig & { bindPassword: string }>`

- [ ] **Step 1: Add OpenLDAP to the development stack**

Append to `infra/docker-compose.yml`:

```yaml
  openldap:
    image: bitnami/openldap:2.6
    environment:
      LDAP_ROOT: dc=acme,dc=test
      LDAP_ADMIN_USERNAME: admin
      LDAP_ADMIN_PASSWORD: adminpassword
      LDAP_CUSTOM_LDIF_DIR: /ldifs
      LDAP_SKIP_DEFAULT_TREE: 'yes'
    volumes:
      - ./ldap:/ldifs:ro
    ports: ['1389:1389']
```

`infra/ldap/seed.ldif`:

```ldif
dn: dc=acme,dc=test
objectClass: dcObject
objectClass: organization
dc: acme
o: Acme Care

dn: ou=Care,dc=acme,dc=test
objectClass: organizationalUnit
ou: Care

dn: ou=Learning,dc=acme,dc=test
objectClass: organizationalUnit
ou: Learning

dn: uid=jdoe,ou=Care,dc=acme,dc=test
objectClass: inetOrgPerson
uid: jdoe
cn: Jo Doe
sn: Doe
mail: jo.doe@acme.test

dn: uid=sroe,ou=Care,dc=acme,dc=test
objectClass: inetOrgPerson
uid: sroe
cn: Sam Roe
sn: Roe
mail: sam.roe@acme.test

dn: cn=Nurses,dc=acme,dc=test
objectClass: groupOfNames
cn: Nurses
member: uid=jdoe,ou=Care,dc=acme,dc=test
```

Bring it up:

```bash
docker compose -f infra/docker-compose.yml up -d openldap
docker exec infra-openldap-1 ldapsearch -x -H ldap://localhost:1389 \
  -D "cn=admin,dc=acme,dc=test" -w adminpassword \
  -b "dc=acme,dc=test" "(objectClass=inetOrgPerson)" dn
```

Expected: two entries, `uid=jdoe` and `uid=sroe`.

- [ ] **Step 2: Write the failing test**

`packages/connectors/src/ldap/connector.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ldapConnector } from './connector.js';
import type { LdapConfig } from './config.js';

const config: LdapConfig & { bindPassword: string } = {
  url: process.env.LDAP_URL ?? 'ldap://localhost:1389',
  bindDn: 'cn=admin,dc=acme,dc=test',
  bindPassword: 'adminpassword',
  userSearchBase: 'dc=acme,dc=test',
  groupSearchBase: 'dc=acme,dc=test',
  orgUnitSearchBase: 'dc=acme,dc=test',
  userFilter: '(objectClass=inetOrgPerson)',
  groupFilter: '(objectClass=groupOfNames)',
  anchorAttribute: 'entryUUID',
  pageSize: 2,
  rejectUnauthorized: true,
};

const readAll = async () => {
  const records = [];
  for await (const record of ldapConnector.read(config)) records.push(record);
  return records;
};

describe('ldapConnector.test', () => {
  it('reports success and what it found', async () => {
    const result = await ldapConnector.test(config);
    expect(result.ok).toBe(true);
    expect(result.sampleCounts?.user).toBe(2);
    expect(result.sampleCounts?.group).toBe(1);
  });

  it('reports a bad password as a failure rather than throwing', async () => {
    const result = await ldapConnector.test({
      ...config,
      bindPassword: 'wrong',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/credential|invalid|bind/i);
  });

  it('reports an unreachable host as a failure', async () => {
    const result = await ldapConnector.test({
      ...config,
      url: 'ldap://127.0.0.1:1',
    });
    expect(result.ok).toBe(false);
  });
});

describe('ldapConnector.read', () => {
  it('reads users, groups and organizational units', async () => {
    const records = await readAll();
    const byType = (t: string) => records.filter((r) => r.objectType === t);

    expect(byType('user').map((r) => r.dn).sort()).toEqual([
      'uid=jdoe,ou=Care,dc=acme,dc=test',
      'uid=sroe,ou=Care,dc=acme,dc=test',
    ]);
    expect(byType('group')).toHaveLength(1);
    expect(byType('orgUnit').length).toBeGreaterThanOrEqual(2);
  });

  it('gives every record a non-empty anchor', async () => {
    const records = await readAll();
    expect(records.every((r) => r.anchor.length > 0)).toBe(true);
    expect(new Set(records.map((r) => r.anchor)).size).toBe(records.length);
  });

  it('crosses the page boundary, since pageSize is 2', async () => {
    // Paging is where a naive implementation silently truncates. There are
    // more than two objects in total, so a single page cannot cover them.
    const records = await readAll();
    expect(records.length).toBeGreaterThan(2);
  });

  it('carries group members as DNs', async () => {
    const records = await readAll();
    const nurses = records.find((r) => r.dn.startsWith('cn=Nurses'));
    expect(nurses?.memberDns).toEqual(['uid=jdoe,ou=Care,dc=acme,dc=test']);
  });

  it('returns attributes as arrays', async () => {
    const records = await readAll();
    const jo = records.find((r) => r.dn.startsWith('uid=jdoe'));
    expect(Array.isArray(jo?.attributes.mail)).toBe(true);
  });
});

describe('ldapConnector.discoverSchema', () => {
  it('reports the attributes actually seen on sampled entries', async () => {
    const schema = await ldapConnector.discoverSchema(config);
    expect(schema.attributes).toContain('mail');
    expect(schema.objectClasses).toContain('inetOrgPerson');
  });
});

describe('ldapConnector.write', () => {
  it('refuses, since writing back is not in this slice', async () => {
    const result = await ldapConnector.write(config, {
      objectType: 'user',
      anchor: 'a1',
      attributes: {},
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not implemented/i);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run packages/connectors/src/ldap/connector.test.ts`
Expected: FAIL — cannot resolve `./connector.js`.

- [ ] **Step 4: Implement the config schema**

`packages/connectors/src/ldap/config.ts`:

```ts
import { z } from 'zod';

export const ldapConfigSchema = z.object({
  url: z.string().min(1),
  bindDn: z.string().min(1),
  userSearchBase: z.string().min(1),
  groupSearchBase: z.string().min(1),
  orgUnitSearchBase: z.string().optional(),
  userFilter: z.string().default('(objectClass=person)'),
  groupFilter: z.string().default('(objectClass=group)'),
  orgUnitFilter: z.string().default('(objectClass=organizationalUnit)'),
  /** objectGUID on Active Directory, entryUUID on OpenLDAP. */
  anchorAttribute: z.string().default('objectGUID'),
  pageSize: z.number().int().positive().max(5000).default(1000),
  /** Off is a deliberate, per-source decision the interface labels plainly. */
  rejectUnauthorized: z.boolean().default(true),
});

export type LdapConfig = z.infer<typeof ldapConfigSchema>;
```

- [ ] **Step 5: Implement the connector**

`packages/connectors/src/ldap/connector.ts`:

```ts
import { Client } from 'ldapts';
import type {
  Connector,
  ConnectionResult,
  ObjectType,
  SchemaDescriptor,
  SourceRecord,
  WriteResult,
} from '../types.js';
import { normaliseAnchor } from './anchor.js';
import type { LdapConfig } from './config.js';

type Config = LdapConfig & { bindPassword: string };

interface Search {
  base: string;
  filter: string;
  objectType: ObjectType;
}

function searches(config: Config): Search[] {
  const list: Search[] = [
    { base: config.userSearchBase, filter: config.userFilter, objectType: 'user' },
    { base: config.groupSearchBase, filter: config.groupFilter, objectType: 'group' },
  ];
  if (config.orgUnitSearchBase) {
    list.push({
      base: config.orgUnitSearchBase,
      filter: config.orgUnitFilter,
      objectType: 'orgUnit',
    });
  }
  return list;
}

async function connect(config: Config): Promise<Client> {
  const client = new Client({
    url: config.url,
    tlsOptions: { rejectUnauthorized: config.rejectUnauthorized },
  });
  await client.bind(config.bindDn, config.bindPassword);
  return client;
}

/** Every LDAP value arrives as a string or a Buffer; normalise to string[]. */
function toArray(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.map((v) => (Buffer.isBuffer(v) ? v.toString('utf8') : String(v)));
}

function toRecord(
  entry: Record<string, unknown>,
  objectType: ObjectType,
  anchorAttribute: string,
): SourceRecord {
  const raw = entry[anchorAttribute];
  const anchorSource = Array.isArray(raw) ? raw[0] : raw;

  const attributes: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (key === 'dn' || key === anchorAttribute) continue;
    attributes[key] = toArray(value);
  }

  const record: SourceRecord = {
    anchor: normaliseAnchor(
      anchorAttribute,
      Buffer.isBuffer(anchorSource) ? anchorSource : String(anchorSource ?? ''),
    ),
    objectType,
    dn: String(entry.dn ?? ''),
    attributes,
  };

  if (objectType === 'group') {
    record.memberDns = toArray(entry.member ?? entry.uniqueMember);
  }
  return record;
}

export const ldapConnector: Connector<Config> = {
  async test(config): Promise<ConnectionResult> {
    let client: Client | undefined;
    try {
      client = await connect(config);
      const counts = { user: 0, group: 0, orgUnit: 0 } as Record<ObjectType, number>;

      for (const search of searches(config)) {
        const { searchEntries } = await client.search(search.base, {
          filter: search.filter,
          scope: 'sub',
          attributes: ['dn'],
        });
        counts[search.objectType] = searchEntries.length;
      }

      return {
        ok: true,
        message: `Connected to ${config.url}`,
        sampleCounts: counts,
      };
    } catch (cause) {
      return {
        ok: false,
        message: cause instanceof Error ? cause.message : 'Connection failed',
      };
    } finally {
      await client?.unbind().catch(() => undefined);
    }
  },

  async discoverSchema(config): Promise<SchemaDescriptor> {
    const client = await connect(config);
    try {
      const objectClasses = new Set<string>();
      const attributes = new Set<string>();

      for (const search of searches(config)) {
        const { searchEntries } = await client.search(search.base, {
          filter: search.filter,
          scope: 'sub',
          sizeLimit: 20,
        });
        for (const entry of searchEntries) {
          for (const cls of toArray(entry.objectClass)) objectClasses.add(cls);
          for (const key of Object.keys(entry)) {
            if (key !== 'dn') attributes.add(key);
          }
        }
      }

      return {
        objectClasses: [...objectClasses].sort(),
        attributes: [...attributes].sort(),
      };
    } finally {
      await client.unbind().catch(() => undefined);
    }
  },

  async *read(config): AsyncIterable<SourceRecord> {
    const client = await connect(config);
    try {
      for (const search of searches(config)) {
        // Paged, and yielded as they arrive: a large directory must not
        // become a large heap.
        const { searchEntries } = await client.search(search.base, {
          filter: search.filter,
          scope: 'sub',
          paged: { pageSize: config.pageSize, pagePause: false },
          attributes: ['*', config.anchorAttribute],
        });

        for (const entry of searchEntries) {
          yield toRecord(
            entry as unknown as Record<string, unknown>,
            search.objectType,
            config.anchorAttribute,
          );
        }
      }
    } finally {
      await client.unbind().catch(() => undefined);
    }
  },

  async write(): Promise<WriteResult> {
    return {
      ok: false,
      message:
        'Writing back to LDAP is not implemented in this slice; the method exists for Provision',
    };
  },
};
```

Export it: add `export * from './ldap/config.js';` and
`export * from './ldap/connector.js';` and `export * from './ldap/anchor.js';`
to `packages/connectors/src/index.ts`.

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm vitest run packages/connectors/src/ldap/connector.test.ts`
Expected: PASS, 10 tests.

If the "crosses the page boundary" test returns exactly 2 records, paging is
truncating rather than continuing. Do not proceed — a truncated read looks
exactly like a mass deletion to the diff stage.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add LDAP connector with paged reads"
```

---

## Task 9: Source and mapping administration

**Files:**
- Create: `packages/core/src/sync/source-service.ts`, `packages/core/src/sync/defaults.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/rbac/permissions.ts` — add `SYNC_READ` and `SYNC_MANAGE`
- Test: `packages/core/src/sync/source-service.test.ts`

**Interfaces:**
- Consumes: `TenantClient`, `currentTenant`, `putSecret`, `getSecret`, `MappingRule`.
- Produces:
  - `createSource(tx, input: CreateSourceInput): Promise<DirectorySource>` where `CreateSourceInput = { name: string; config: unknown; bindPassword: string; schedule?: string | undefined; autoApply?: boolean | undefined; deactivationThresholdPercent?: number | undefined }`
  - `listSources(tx): Promise<DirectorySource[]>`
  - `sourceWithPassword(tx, provider, id): Promise<(LdapConfig & { bindPassword: string }) | null>`
  - `setMappings(tx, sourceId, rules: MappingRule[]): Promise<void>`
  - `mappingsFor(tx, sourceId): Promise<MappingRule[]>`
  - `DEFAULT_MAPPINGS: Record<'activeDirectory' | 'openLdap', MappingRule[]>`
  - `PERMISSIONS.SYNC_READ = 'sync.read'`, `PERMISSIONS.SYNC_MANAGE = 'sync.manage'`

- [ ] **Step 1: Add the permissions**

In `packages/core/src/rbac/permissions.ts`, add to the `PERMISSIONS` object:

```ts
  SYNC_READ: 'sync.read',
  SYNC_MANAGE: 'sync.manage',
```

- [ ] **Step 2: Write the failing test**

`packages/core/src/sync/source-service.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { localMasterKeyProvider } from '../vault/master-key.js';
import { DEFAULT_MAPPINGS } from './defaults.js';
import {
  createSource,
  listSources,
  mappingsFor,
  setMappings,
  sourceWithPassword,
} from './source-service.js';

const provider = localMasterKeyProvider(Buffer.alloc(32, 3));
let tenantId: string;

const input = {
  name: 'Head office AD',
  config: {
    url: 'ldap://localhost:1389',
    bindDn: 'cn=admin,dc=acme,dc=test',
    userSearchBase: 'dc=acme,dc=test',
    groupSearchBase: 'dc=acme,dc=test',
    anchorAttribute: 'entryUUID',
  },
  bindPassword: 'adminpassword',
};

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
});

describe('createSource', () => {
  it('stores the password in the vault, not on the row', async () => {
    const source = await withTenant(tenantId, (tx) =>
      createSource(tx, provider, input),
    );

    const row = await withTenant(tenantId, (tx) =>
      tx.directorySource.findUnique({ where: { id: source.id } }),
    );
    expect(JSON.stringify(row)).not.toContain('adminpassword');
    expect(row!.secretName).toMatch(/^source\./);
  });

  it('reads the password back only through the vault', async () => {
    const source = await withTenant(tenantId, (tx) =>
      createSource(tx, provider, input),
    );
    const resolved = await withTenant(tenantId, (tx) =>
      sourceWithPassword(tx, provider, source.id),
    );
    expect(resolved?.bindPassword).toBe('adminpassword');
    expect(resolved?.url).toBe('ldap://localhost:1389');
  });

  it('rejects a config that is not a valid LDAP configuration', async () => {
    await expect(
      withTenant(tenantId, (tx) =>
        createSource(tx, provider, { ...input, config: { url: '' } }),
      ),
    ).rejects.toThrow();
  });

  it('defaults to no schedule, no auto-apply, and a 10% threshold', async () => {
    const source = await withTenant(tenantId, (tx) =>
      createSource(tx, provider, input),
    );
    expect(source.schedule).toBeNull();
    expect(source.autoApply).toBe(false);
    expect(source.deactivationThresholdPercent).toBe(10);
  });

  it('returns null for a source in another tenant', async () => {
    const other = await prisma.tenant.create({
      data: { name: 'Other', slug: 'other' },
    });
    const source = await withTenant(tenantId, (tx) =>
      createSource(tx, provider, input),
    );
    const resolved = await withTenant(other.id, (tx) =>
      sourceWithPassword(tx, provider, source.id),
    );
    expect(resolved).toBeNull();
  });
});

describe('mappings', () => {
  it('round-trips a mapping set', async () => {
    const source = await withTenant(tenantId, (tx) =>
      createSource(tx, provider, input),
    );
    await withTenant(tenantId, (tx) =>
      setMappings(tx, source.id, DEFAULT_MAPPINGS.openLdap),
    );

    const rules = await withTenant(tenantId, (tx) =>
      mappingsFor(tx, source.id),
    );
    expect(rules.length).toBe(DEFAULT_MAPPINGS.openLdap.length);
    expect(rules.filter((r) => r.isCorrelation && r.objectType === 'user')).toHaveLength(1);
  });

  it('replaces the previous set rather than appending to it', async () => {
    const source = await withTenant(tenantId, (tx) =>
      createSource(tx, provider, input),
    );
    await withTenant(tenantId, (tx) =>
      setMappings(tx, source.id, DEFAULT_MAPPINGS.openLdap),
    );
    await withTenant(tenantId, (tx) =>
      setMappings(tx, source.id, [
        {
          objectType: 'user',
          sourceAttribute: 'uid',
          targetField: 'login',
          transform: 'lowercase',
          isCorrelation: true,
        },
      ]),
    );

    const rules = await withTenant(tenantId, (tx) => mappingsFor(tx, source.id));
    expect(rules).toHaveLength(1);
  });

  it('refuses a set with no correlation rule for users', async () => {
    // Without one, no user record can ever be matched.
    const source = await withTenant(tenantId, (tx) =>
      createSource(tx, provider, input),
    );
    await expect(
      withTenant(tenantId, (tx) =>
        setMappings(tx, source.id, [
          {
            objectType: 'user',
            sourceAttribute: 'mail',
            targetField: 'email',
            transform: 'lowercase',
            isCorrelation: false,
          },
        ]),
      ),
    ).rejects.toThrow(/correlation/i);
  });
});

describe('DEFAULT_MAPPINGS', () => {
  it('maps Active Directory to sAMAccountName as the correlation key', () => {
    const rule = DEFAULT_MAPPINGS.activeDirectory.find(
      (r) => r.objectType === 'user' && r.isCorrelation,
    );
    expect(rule?.sourceAttribute).toBe('sAMAccountName');
  });

  it('maps OpenLDAP to uid as the correlation key', () => {
    const rule = DEFAULT_MAPPINGS.openLdap.find(
      (r) => r.objectType === 'user' && r.isCorrelation,
    );
    expect(rule?.sourceAttribute).toBe('uid');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run packages/core/src/sync/source-service.test.ts`
Expected: FAIL — cannot resolve `./defaults.js`.

- [ ] **Step 4: Implement the defaults**

`packages/core/src/sync/defaults.ts`:

```ts
import type { MappingRule } from './mapping.js';

/**
 * Sensible starting points so the common case needs no typing. An
 * administrator can change any of it; these only seed the editor.
 */
export const DEFAULT_MAPPINGS: Record<
  'activeDirectory' | 'openLdap',
  MappingRule[]
> = {
  activeDirectory: [
    { objectType: 'user', sourceAttribute: 'sAMAccountName', targetField: 'login', transform: 'lowercase', isCorrelation: true },
    { objectType: 'user', sourceAttribute: 'mail', targetField: 'email', transform: 'lowercase', isCorrelation: false },
    { objectType: 'user', sourceAttribute: 'displayName', targetField: 'displayName', transform: 'trim', isCorrelation: false },
    { objectType: 'group', sourceAttribute: 'cn', targetField: 'name', transform: 'trim', isCorrelation: true },
    { objectType: 'group', sourceAttribute: 'description', targetField: 'description', transform: 'trim', isCorrelation: false },
    { objectType: 'orgUnit', sourceAttribute: 'ou', targetField: 'name', transform: 'trim', isCorrelation: true },
  ],
  openLdap: [
    { objectType: 'user', sourceAttribute: 'uid', targetField: 'login', transform: 'lowercase', isCorrelation: true },
    { objectType: 'user', sourceAttribute: 'mail', targetField: 'email', transform: 'lowercase', isCorrelation: false },
    { objectType: 'user', sourceAttribute: 'cn', targetField: 'displayName', transform: 'trim', isCorrelation: false },
    { objectType: 'group', sourceAttribute: 'cn', targetField: 'name', transform: 'trim', isCorrelation: true },
    { objectType: 'orgUnit', sourceAttribute: 'ou', targetField: 'name', transform: 'trim', isCorrelation: true },
  ],
};
```

- [ ] **Step 5: Implement the source service**

`packages/core/src/sync/source-service.ts`:

```ts
import type { TenantClient } from '@syntra/db';
import { ldapConfigSchema, type LdapConfig } from '@syntra/connectors';
import { currentTenant } from '../tenant-context.js';
import { getSecret, putSecret } from '../vault/vault-service.js';
import type { MasterKeyProvider } from '../vault/master-key.js';
import type { MappingRule } from './mapping.js';

export interface CreateSourceInput {
  name: string;
  config: unknown;
  bindPassword: string;
  schedule?: string | undefined;
  autoApply?: boolean | undefined;
  deactivationThresholdPercent?: number | undefined;
}

export async function createSource(
  tx: TenantClient,
  provider: MasterKeyProvider,
  input: CreateSourceInput,
) {
  const tenantId = await currentTenant(tx);
  const config = ldapConfigSchema.parse(input.config);

  const source = await tx.directorySource.create({
    data: {
      tenantId,
      name: input.name,
      type: 'ldap',
      config: config as never,
      // Filled in below, once the row has an id to name the secret after.
      secretName: 'pending',
      schedule: input.schedule ?? null,
      autoApply: input.autoApply ?? false,
      deactivationThresholdPercent: input.deactivationThresholdPercent ?? 10,
    },
  });

  const secretName = `source.${source.id}.bindPassword`;
  await putSecret(tx, provider, secretName, input.bindPassword);

  return tx.directorySource.update({
    where: { id: source.id },
    data: { secretName },
  });
}

export async function listSources(tx: TenantClient) {
  return tx.directorySource.findMany({ orderBy: { name: 'asc' } });
}

export async function findSource(tx: TenantClient, id: string) {
  return tx.directorySource.findUnique({ where: { id } });
}

/**
 * The connection configuration with its credential attached, for a run. The
 * password is never on the row and never leaves this function's caller.
 */
export async function sourceWithPassword(
  tx: TenantClient,
  provider: MasterKeyProvider,
  id: string,
): Promise<(LdapConfig & { bindPassword: string }) | null> {
  const source = await tx.directorySource.findUnique({ where: { id } });
  if (!source) return null;

  const bindPassword = await getSecret(tx, provider, source.secretName);
  if (bindPassword === null) return null;

  return { ...ldapConfigSchema.parse(source.config), bindPassword };
}

export async function setMappings(
  tx: TenantClient,
  sourceId: string,
  rules: MappingRule[],
): Promise<void> {
  const userCorrelation = rules.filter(
    (r) => r.objectType === 'user' && r.isCorrelation,
  );
  if (userCorrelation.length !== 1) {
    throw new Error(
      'exactly one user mapping must be marked as the correlation key',
    );
  }

  const tenantId = await currentTenant(tx);
  await tx.attributeMapping.deleteMany({ where: { sourceId } });
  await tx.attributeMapping.createMany({
    data: rules.map((r) => ({ tenantId, sourceId, ...r })),
  });
}

export async function mappingsFor(
  tx: TenantClient,
  sourceId: string,
): Promise<MappingRule[]> {
  const rows = await tx.attributeMapping.findMany({ where: { sourceId } });
  return rows.map((r) => ({
    objectType: r.objectType as MappingRule['objectType'],
    sourceAttribute: r.sourceAttribute,
    targetField: r.targetField,
    transform: r.transform as MappingRule['transform'],
    isCorrelation: r.isCorrelation,
  }));
}
```

Add to `packages/core/src/index.ts`:

```ts
export * from './sync/mapping.js';
export * from './sync/correlate.js';
export * from './sync/diff.js';
export * from './sync/guard.js';
export * from './sync/defaults.js';
export * from './sync/source-service.js';
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm vitest run packages/core/src/sync/source-service.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add directory source and mapping administration"
```

---

## Task 10: Run orchestration and apply

**Files:**
- Create: `packages/core/src/sync/apply.ts`, `packages/core/src/sync/run-service.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/sync/run-service.test.ts`

**Interfaces:**
- Consumes: every stage from Tasks 4–7, `ldapConnector`, `sourceWithPassword`, `mappingsFor`, `recordEvent`, `deactivateUser`.
- Produces:
  - `previewRun(tx, provider, sourceId): Promise<SyncRun>` — reads, maps, correlates, diffs, guards, and writes the run plus its changes. Applies nothing.
  - `applyRun(tx, runId, opts?: { only?: string[] }): Promise<SyncRun>` — applies proposed changes, skipping conflicts.
  - `skipChange(tx, changeId): Promise<void>`
  - `applyChange(tx, change): Promise<void>` from `apply.ts`

- [ ] **Step 1: Write the failing test**

`packages/core/src/sync/run-service.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { localMasterKeyProvider } from '../vault/master-key.js';
import { createUser } from '../directory/user-service.js';
import { DEFAULT_MAPPINGS } from './defaults.js';
import { createSource, setMappings } from './source-service.js';
import { applyRun, previewRun } from './run-service.js';

const provider = localMasterKeyProvider(Buffer.alloc(32, 5));
let tenantId: string;
let sourceId: string;

const config = {
  url: process.env.LDAP_URL ?? 'ldap://localhost:1389',
  bindDn: 'cn=admin,dc=acme,dc=test',
  userSearchBase: 'dc=acme,dc=test',
  groupSearchBase: 'dc=acme,dc=test',
  orgUnitSearchBase: 'dc=acme,dc=test',
  userFilter: '(objectClass=inetOrgPerson)',
  groupFilter: '(objectClass=groupOfNames)',
  anchorAttribute: 'entryUUID',
  pageSize: 2,
  rejectUnauthorized: true,
};

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;

  await withTenant(tenantId, async (tx) => {
    const source = await createSource(tx, provider, {
      name: 'Test LDAP',
      config,
      bindPassword: 'adminpassword',
    });
    sourceId = source.id;
    await setMappings(tx, source.id, DEFAULT_MAPPINGS.openLdap);
  });
});

describe('previewRun', () => {
  it('proposes creates on a first run and applies none of them', async () => {
    const run = await withTenant(tenantId, (tx) =>
      previewRun(tx, provider, sourceId),
    );

    expect(run.status).toBe('previewed');
    expect(run.recordsRead).toBeGreaterThan(0);

    const changes = await withTenant(tenantId, (tx) =>
      tx.syncChange.findMany({ where: { runId: run.id } }),
    );
    expect(changes.filter((c) => c.changeType === 'create_user')).toHaveLength(2);
    expect(changes.every((c) => c.status === 'proposed')).toBe(true);

    // Nothing has been written to the directory yet.
    const users = await withTenant(tenantId, (tx) => tx.user.findMany());
    expect(users).toEqual([]);
  });

  it('proposes nothing on a second run over an unchanged directory', async () => {
    const first = await withTenant(tenantId, (tx) =>
      previewRun(tx, provider, sourceId),
    );
    await withTenant(tenantId, (tx) => applyRun(tx, first.id));

    const second = await withTenant(tenantId, (tx) =>
      previewRun(tx, provider, sourceId),
    );
    const changes = await withTenant(tenantId, (tx) =>
      tx.syncChange.findMany({ where: { runId: second.id } }),
    );
    expect(changes).toEqual([]);
  });

  it('reports a collision with a locally created account as a conflict', async () => {
    await withTenant(tenantId, (tx) =>
      createUser(tx, {
        login: 'jdoe',
        email: 'local@acme.test',
        displayName: 'Local Jo',
      }),
    );

    const run = await withTenant(tenantId, (tx) =>
      previewRun(tx, provider, sourceId),
    );
    const conflicts = await withTenant(tenantId, (tx) =>
      tx.syncChange.findMany({ where: { runId: run.id, status: 'conflict' } }),
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.message).toMatch(/locally managed/i);
  });
});

describe('applyRun', () => {
  it('creates the users the preview proposed', async () => {
    const run = await withTenant(tenantId, (tx) =>
      previewRun(tx, provider, sourceId),
    );
    const applied = await withTenant(tenantId, (tx) => applyRun(tx, run.id));

    expect(applied.status).toBe('applied');
    const users = await withTenant(tenantId, (tx) => tx.user.findMany());
    expect(users.map((u) => u.login).sort()).toEqual(['jdoe', 'sroe']);
    expect(users.every((u) => u.sourceId === sourceId)).toBe(true);
    expect(users.every((u) => u.sourceAnchor !== null)).toBe(true);
  });

  it('brings group memberships across', async () => {
    const run = await withTenant(tenantId, (tx) =>
      previewRun(tx, provider, sourceId),
    );
    await withTenant(tenantId, (tx) => applyRun(tx, run.id));

    const memberships = await withTenant(tenantId, (tx) =>
      tx.groupMembership.findMany({ include: { user: true, group: true } }),
    );
    expect(memberships).toHaveLength(1);
    expect(memberships[0]!.user.login).toBe('jdoe');
    expect(memberships[0]!.group.name).toBe('Nurses');
  });

  it('never applies a conflict', async () => {
    await withTenant(tenantId, (tx) =>
      createUser(tx, {
        login: 'jdoe',
        email: 'local@acme.test',
        displayName: 'Local Jo',
      }),
    );
    const run = await withTenant(tenantId, (tx) =>
      previewRun(tx, provider, sourceId),
    );
    await withTenant(tenantId, (tx) => applyRun(tx, run.id));

    const local = await withTenant(tenantId, (tx) =>
      tx.user.findFirst({ where: { login: 'jdoe' } }),
    );
    // The hand-made account is untouched: still local, still its own email.
    expect(local!.sourceId).toBeNull();
    expect(local!.email).toBe('local@acme.test');
  });

  it('writes an audit event for every applied change', async () => {
    const run = await withTenant(tenantId, (tx) =>
      previewRun(tx, provider, sourceId),
    );
    await withTenant(tenantId, (tx) => applyRun(tx, run.id));

    const events = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: { startsWith: 'sync.' } } }),
    );
    expect(events.length).toBeGreaterThan(0);
  });

  it('applies only the changes it was asked to', async () => {
    const run = await withTenant(tenantId, (tx) =>
      previewRun(tx, provider, sourceId),
    );
    const changes = await withTenant(tenantId, (tx) =>
      tx.syncChange.findMany({
        where: { runId: run.id, changeType: 'create_user' },
      }),
    );

    const applied = await withTenant(tenantId, (tx) =>
      applyRun(tx, run.id, { only: [changes[0]!.id] }),
    );
    expect(applied.status).toBe('partially_applied');

    const users = await withTenant(tenantId, (tx) => tx.user.findMany());
    expect(users).toHaveLength(1);
  });

  it('refuses to apply a blocked run', async () => {
    const run = await withTenant(tenantId, (tx) =>
      previewRun(tx, provider, sourceId),
    );
    await withTenant(tenantId, (tx) =>
      tx.syncRun.update({
        where: { id: run.id },
        data: { status: 'blocked', blockedReason: 'test' },
      }),
    );

    await expect(
      withTenant(tenantId, (tx) => applyRun(tx, run.id)),
    ).rejects.toThrow(/blocked/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/core/src/sync/run-service.test.ts`
Expected: FAIL — cannot resolve `./run-service.js`.

- [ ] **Step 3: Implement apply**

`packages/core/src/sync/apply.ts`:

```ts
import type { TenantClient } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';
import { recordEvent } from '../audit/audit-service.js';

interface ChangeRow {
  id: string;
  changeType: string;
  targetType: string;
  targetId: string | null;
  sourceAnchor: string | null;
  before: unknown;
  after: unknown;
  status: string;
}

const fields = (value: unknown) => (value ?? {}) as Record<string, string>;

/**
 * Applies one proposed change and records it. The caller runs this inside a
 * transaction, so the change and its audit entry commit together or not at
 * all: a directory change without a record of it is worse than no change.
 */
export async function applyChange(
  tx: TenantClient,
  change: ChangeRow,
  sourceId: string,
  runId: string,
): Promise<void> {
  const tenantId = await currentTenant(tx);
  const after = fields(change.after);

  switch (change.changeType) {
    case 'create_user': {
      const created = await tx.user.create({
        data: {
          tenantId,
          login: after.login ?? '',
          email: after.email ?? '',
          displayName: after.displayName ?? after.login ?? '',
          sourceId,
          sourceAnchor: change.sourceAnchor,
        },
      });
      await tx.syncChange.update({
        where: { id: change.id },
        data: { status: 'applied', targetId: created.id },
      });
      break;
    }

    case 'update_user': {
      await tx.user.update({
        where: { id: change.targetId! },
        data: after,
      });
      await tx.syncChange.update({
        where: { id: change.id },
        data: { status: 'applied' },
      });
      break;
    }

    case 'deactivate_user': {
      await tx.user.update({
        where: { id: change.targetId! },
        data: {
          status: 'inactive',
          statusReason: `Absent from directory source, run ${runId}`,
        },
      });
      await tx.syncChange.update({
        where: { id: change.id },
        data: { status: 'applied' },
      });
      break;
    }

    case 'reactivate_user': {
      await tx.user.update({
        where: { id: change.targetId! },
        data: { status: 'active', statusReason: null },
      });
      await tx.syncChange.update({
        where: { id: change.id },
        data: { status: 'applied' },
      });
      break;
    }

    case 'create_group': {
      const created = await tx.group.create({
        data: {
          tenantId,
          name: after.name ?? '',
          description: after.description ?? null,
          sourceId,
          sourceAnchor: change.sourceAnchor,
        },
      });
      await tx.syncChange.update({
        where: { id: change.id },
        data: { status: 'applied', targetId: created.id },
      });
      break;
    }

    case 'update_group': {
      await tx.group.update({ where: { id: change.targetId! }, data: after });
      await tx.syncChange.update({
        where: { id: change.id },
        data: { status: 'applied' },
      });
      break;
    }

    case 'deactivate_group': {
      // Deactivated, never deleted, and memberships are left in place:
      // deleting a group silently revokes access from everyone in it.
      await tx.group.update({
        where: { id: change.targetId! },
        data: {
          status: 'inactive',
          statusReason: `Absent from directory source, run ${runId}`,
        },
      });
      await tx.syncChange.update({
        where: { id: change.id },
        data: { status: 'applied' },
      });
      break;
    }

    case 'create_org_unit': {
      const created = await tx.orgUnit.create({
        data: {
          tenantId,
          name: after.name ?? '',
          sourceId,
          sourceAnchor: change.sourceAnchor,
        },
      });
      await tx.syncChange.update({
        where: { id: change.id },
        data: { status: 'applied', targetId: created.id },
      });
      break;
    }

    case 'update_org_unit': {
      await tx.orgUnit.update({ where: { id: change.targetId! }, data: after });
      await tx.syncChange.update({
        where: { id: change.id },
        data: { status: 'applied' },
      });
      break;
    }

    case 'add_member': {
      const group = await tx.group.findFirst({
        where: { sourceId, sourceAnchor: after.groupAnchor },
      });
      const user = await tx.user.findFirst({
        where: { sourceId, sourceAnchor: after.memberAnchor },
      });
      if (!group || !user) {
        await tx.syncChange.update({
          where: { id: change.id },
          data: {
            status: 'failed',
            message: 'group or member not found after applying earlier changes',
          },
        });
        break;
      }
      await tx.groupMembership.upsert({
        where: { groupId_userId: { groupId: group.id, userId: user.id } },
        create: { tenantId, groupId: group.id, userId: user.id },
        update: {},
      });
      await tx.syncChange.update({
        where: { id: change.id },
        data: { status: 'applied' },
      });
      break;
    }

    case 'remove_member': {
      const before = fields(change.before);
      const group = await tx.group.findFirst({
        where: { sourceId, sourceAnchor: before.groupAnchor },
      });
      const user = await tx.user.findFirst({
        where: { sourceId, sourceAnchor: before.memberAnchor },
      });
      if (group && user) {
        await tx.groupMembership.deleteMany({
          where: { groupId: group.id, userId: user.id },
        });
      }
      await tx.syncChange.update({
        where: { id: change.id },
        data: { status: 'applied' },
      });
      break;
    }

    default:
      await tx.syncChange.update({
        where: { id: change.id },
        data: {
          status: 'failed',
          message: `unknown change type: ${change.changeType}`,
        },
      });
      return;
  }

  await recordEvent(tx, {
    actorUserId: null,
    action: `sync.${change.changeType}`,
    targetType: change.targetType,
    targetId: change.targetId,
    outcome: 'success',
    sourceIp: null,
    payload: { runId, anchor: change.sourceAnchor },
  });
}
```

- [ ] **Step 4: Implement the run service**

`packages/core/src/sync/run-service.ts`:

```ts
import type { TenantClient } from '@syntra/db';
import { ldapConnector, type SourceRecord } from '@syntra/connectors';
import { currentTenant } from '../tenant-context.js';
import type { MasterKeyProvider } from '../vault/master-key.js';
import { mappingsFor, sourceWithPassword } from './source-service.js';
import { isMappingFailure, mapRecord, type DirectoryObject } from './mapping.js';
import { absentAnchors, correlate, type ExistingObject } from './correlate.js';
import { diffMemberships, diffObjects, type MembershipState } from './diff.js';
import { evaluateGuard } from './guard.js';
import { applyChange } from './apply.js';

/**
 * Reads the source, computes the whole diff, and stops.
 *
 * Nothing here writes to the directory. The run and its proposed changes are
 * the entire output, which is what makes "what you reviewed is what you
 * applied" true rather than approximately true.
 */
export async function previewRun(
  tx: TenantClient,
  provider: MasterKeyProvider,
  sourceId: string,
) {
  const tenantId = await currentTenant(tx);
  const source = await tx.directorySource.findUnique({ where: { id: sourceId } });
  if (!source) throw new Error(`no such source: ${sourceId}`);

  const run = await tx.syncRun.create({ data: { tenantId, sourceId } });

  try {
    const config = await sourceWithPassword(tx, provider, sourceId);
    if (!config) throw new Error('source configuration or credential missing');
    const rules = await mappingsFor(tx, sourceId);

    const records: SourceRecord[] = [];
    for await (const record of ldapConnector.read(config)) records.push(record);

    const objects: DirectoryObject[] = [];
    for (const record of records) {
      const mapped = mapRecord(record, rules);
      if (!isMappingFailure(mapped)) objects.push(mapped);
    }

    const dnToAnchor = new Map(objects.map((o) => [o.dn, o.anchor]));
    let unresolved = 0;

    const existing = await loadExisting(tx);
    const changes = [];

    for (const type of ['user', 'group', 'orgUnit'] as const) {
      const ofType = objects.filter((o) => o.objectType === type);
      const rows = existing.filter((e) => e.objectType === type);
      const correlations = correlate(ofType, rows, sourceId);
      const absent = absentAnchors(ofType, rows, sourceId);
      changes.push(...diffObjects(correlations, absent, await currentFieldsFor(tx, type)));
    }

    const desired: MembershipState[] = objects
      .filter((o) => o.objectType === 'group')
      .map((group) => {
        const memberAnchors: string[] = [];
        for (const dn of group.memberDns) {
          const anchor = dnToAnchor.get(dn);
          if (anchor) memberAnchors.push(anchor);
          else unresolved++;
        }
        return { groupAnchor: group.anchor, memberAnchors };
      });

    changes.push(...diffMemberships(desired, await currentMemberships(tx, sourceId)));

    await tx.syncChange.createMany({
      data: changes.map((c) => ({
        tenantId,
        runId: run.id,
        changeType: c.changeType,
        targetType: c.targetType,
        targetId: c.targetId,
        sourceAnchor: c.sourceAnchor,
        before: (c.before ?? undefined) as never,
        after: (c.after ?? undefined) as never,
        status: c.status,
        message: c.message ?? null,
      })),
    });

    const activeUsersFromSource = await tx.user.count({
      where: { sourceId, status: 'active' },
    });
    const verdict = evaluateGuard({
      changes,
      recordsRead: records.length,
      activeUsersFromSource,
      thresholdPercent: source.deactivationThresholdPercent,
    });

    return tx.syncRun.update({
      where: { id: run.id },
      data: {
        status: verdict.blocked ? 'blocked' : 'previewed',
        blockedReason: verdict.blocked ? verdict.reason : null,
        requiresConfirmation: verdict.blocked,
        recordsRead: records.length,
        unresolvedMembers: unresolved,
        finishedAt: new Date(),
      },
    });
  } catch (cause) {
    return tx.syncRun.update({
      where: { id: run.id },
      data: {
        status: 'failed',
        error: cause instanceof Error ? cause.message : 'run failed',
        finishedAt: new Date(),
      },
    });
  }
}

async function loadExisting(tx: TenantClient): Promise<ExistingObject[]> {
  const users = await tx.user.findMany();
  const groups = await tx.group.findMany();
  const units = await tx.orgUnit.findMany();

  return [
    ...users.map((u) => ({
      id: u.id,
      objectType: 'user' as const,
      sourceId: u.sourceId,
      sourceAnchor: u.sourceAnchor,
      correlationValue: u.login,
      status: u.status,
    })),
    ...groups.map((g) => ({
      id: g.id,
      objectType: 'group' as const,
      sourceId: g.sourceId,
      sourceAnchor: g.sourceAnchor,
      correlationValue: g.name,
      status: g.status,
    })),
    ...units.map((o) => ({
      id: o.id,
      objectType: 'orgUnit' as const,
      sourceId: o.sourceId,
      sourceAnchor: o.sourceAnchor,
      correlationValue: o.name,
      status: 'active',
    })),
  ];
}

async function currentFieldsFor(
  tx: TenantClient,
  type: 'user' | 'group' | 'orgUnit',
): Promise<Map<string, Record<string, string>>> {
  const map = new Map<string, Record<string, string>>();

  if (type === 'user') {
    for (const u of await tx.user.findMany()) {
      map.set(u.id, {
        login: u.login,
        email: u.email,
        displayName: u.displayName,
      });
    }
  } else if (type === 'group') {
    for (const g of await tx.group.findMany()) {
      map.set(g.id, { name: g.name, description: g.description ?? '' });
    }
  } else {
    for (const o of await tx.orgUnit.findMany()) {
      map.set(o.id, { name: o.name });
    }
  }

  return map;
}

async function currentMemberships(
  tx: TenantClient,
  sourceId: string,
): Promise<MembershipState[]> {
  const groups = await tx.group.findMany({
    where: { sourceId },
    include: { memberships: { include: { user: true } } },
  });

  return groups
    .filter((g) => g.sourceAnchor !== null)
    .map((g) => ({
      groupAnchor: g.sourceAnchor!,
      memberAnchors: g.memberships
        .map((m) => m.user.sourceAnchor)
        .filter((a): a is string => a !== null),
    }));
}

/**
 * Applies the proposed changes of a run, in the order they were computed so
 * that objects exist before memberships reference them. Conflicts are never
 * applied; a failure marks its own change and the run continues.
 */
export async function applyRun(
  tx: TenantClient,
  runId: string,
  opts: { only?: string[] } = {},
) {
  const run = await tx.syncRun.findUnique({ where: { id: runId } });
  if (!run) throw new Error(`no such run: ${runId}`);
  if (run.status === 'blocked') {
    throw new Error(
      `run is blocked and cannot be applied: ${run.blockedReason ?? 'unknown reason'}`,
    );
  }

  const changes = await tx.syncChange.findMany({
    where: {
      runId,
      status: 'proposed',
      ...(opts.only ? { id: { in: opts.only } } : {}),
    },
    orderBy: { id: 'asc' },
  });

  // Objects before memberships: a membership references rows that the same
  // run may only just have created.
  const ordered = [
    ...changes.filter((c) => !c.changeType.endsWith('_member')),
    ...changes.filter((c) => c.changeType.endsWith('_member')),
  ];

  for (const change of ordered) {
    try {
      await applyChange(tx, change, run.sourceId, runId);
    } catch (cause) {
      await tx.syncChange.update({
        where: { id: change.id },
        data: {
          status: 'failed',
          message: cause instanceof Error ? cause.message : 'failed to apply',
        },
      });
    }
  }

  const remaining = await tx.syncChange.count({
    where: { runId, status: 'proposed' },
  });
  const failed = await tx.syncChange.count({
    where: { runId, status: 'failed' },
  });

  return tx.syncRun.update({
    where: { id: runId },
    data: {
      status: remaining > 0 || failed > 0 ? 'partially_applied' : 'applied',
      finishedAt: new Date(),
    },
  });
}

export async function skipChange(
  tx: TenantClient,
  changeId: string,
): Promise<void> {
  await tx.syncChange.update({
    where: { id: changeId },
    data: { status: 'skipped' },
  });
}

export async function listRuns(tx: TenantClient, sourceId?: string) {
  return tx.syncRun.findMany({
    where: sourceId ? { sourceId } : {},
    orderBy: { startedAt: 'desc' },
    take: 50,
  });
}
```

Add `export * from './sync/run-service.js';` and
`export * from './sync/apply.js';` to `packages/core/src/index.ts`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run packages/core/src/sync/run-service.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add sync run orchestration and apply"
```

---

## Task 11: The organizational-unit move, and the other cases that only a real server shows

**Files:**
- Test: `packages/core/src/sync/scenarios.test.ts`
- Create: `packages/core/src/sync/test-support.ts`

**Interfaces:**
- Consumes: everything from Tasks 8–10.
- Produces: `withLdapEntry(dn, attrs, fn)` — a helper that adds an entry, runs the callback, and removes it, so scenario tests can mutate the fixture directory without leaking state.

This task adds no production code. It exists because the properties that
matter most here — that a person moving does not get deactivated, that a
deletion does, that a rehire is proposed rather than applied — cannot be
observed without a real directory that can be changed between runs.

- [ ] **Step 1: Write the test-support helper**

`packages/core/src/sync/test-support.ts`:

```ts
import { Client } from 'ldapts';

const URL = process.env.LDAP_URL ?? 'ldap://localhost:1389';
const BIND_DN = 'cn=admin,dc=acme,dc=test';
const BIND_PASSWORD = 'adminpassword';

async function client(): Promise<Client> {
  const c = new Client({ url: URL });
  await c.bind(BIND_DN, BIND_PASSWORD);
  return c;
}

/** Adds an entry for the duration of `fn`, then removes it. */
export async function withLdapEntry<T>(
  dn: string,
  attributes: Record<string, string | string[]>,
  fn: () => Promise<T>,
): Promise<T> {
  const c = await client();
  await c.add(dn, attributes);
  try {
    return await fn();
  } finally {
    await c.del(dn).catch(() => undefined);
    await c.unbind().catch(() => undefined);
  }
}

/** Moves an entry to a new parent, the way a reorganisation would. */
export async function moveLdapEntry(
  dn: string,
  newRdn: string,
  newParent: string,
): Promise<void> {
  const c = await client();
  try {
    await c.modifyDN(dn, `${newRdn},${newParent}`);
  } finally {
    await c.unbind().catch(() => undefined);
  }
}
```

- [ ] **Step 2: Write the scenario tests**

`packages/core/src/sync/scenarios.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { localMasterKeyProvider } from '../vault/master-key.js';
import { DEFAULT_MAPPINGS } from './defaults.js';
import { createSource, setMappings } from './source-service.js';
import { applyRun, previewRun } from './run-service.js';
import { moveLdapEntry, withLdapEntry } from './test-support.js';

const provider = localMasterKeyProvider(Buffer.alloc(32, 7));
let tenantId: string;
let sourceId: string;

const config = {
  url: process.env.LDAP_URL ?? 'ldap://localhost:1389',
  bindDn: 'cn=admin,dc=acme,dc=test',
  userSearchBase: 'dc=acme,dc=test',
  groupSearchBase: 'dc=acme,dc=test',
  orgUnitSearchBase: 'dc=acme,dc=test',
  userFilter: '(objectClass=inetOrgPerson)',
  groupFilter: '(objectClass=groupOfNames)',
  anchorAttribute: 'entryUUID',
  pageSize: 2,
  rejectUnauthorized: true,
};

const sync = async () => {
  const run = await withTenant(tenantId, (tx) =>
    previewRun(tx, provider, sourceId),
  );
  return withTenant(tenantId, (tx) => applyRun(tx, run.id));
};

const preview = () =>
  withTenant(tenantId, (tx) => previewRun(tx, provider, sourceId));

const changesOf = (runId: string) =>
  withTenant(tenantId, (tx) => tx.syncChange.findMany({ where: { runId } }));

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  await withTenant(tenantId, async (tx) => {
    const source = await createSource(tx, provider, {
      name: 'Test LDAP',
      config,
      bindPassword: 'adminpassword',
    });
    sourceId = source.id;
    await setMappings(tx, source.id, DEFAULT_MAPPINGS.openLdap);
  });
});

describe('an organizational unit move', () => {
  it('is an update, not a deactivation and a second account', async () => {
    await sync();
    const before = await withTenant(tenantId, (tx) =>
      tx.user.findFirst({ where: { login: 'jdoe' } }),
    );

    await moveLdapEntry(
      'uid=jdoe,ou=Care,dc=acme,dc=test',
      'uid=jdoe',
      'ou=Learning,dc=acme,dc=test',
    );

    try {
      const run = await preview();
      const changes = await changesOf(run.id);

      // The whole point of anchoring on entryUUID rather than the DN.
      expect(changes.filter((c) => c.changeType === 'deactivate_user')).toEqual([]);
      expect(changes.filter((c) => c.changeType === 'create_user')).toEqual([]);

      await withTenant(tenantId, (tx) => applyRun(tx, run.id));
      const users = await withTenant(tenantId, (tx) =>
        tx.user.findMany({ where: { login: 'jdoe' } }),
      );
      expect(users).toHaveLength(1);
      expect(users[0]!.id).toBe(before!.id);
    } finally {
      await moveLdapEntry(
        'uid=jdoe,ou=Learning,dc=acme,dc=test',
        'uid=jdoe',
        'ou=Care,dc=acme,dc=test',
      );
    }
  });
});

describe('a joiner', () => {
  it('is created on the next run', async () => {
    await sync();

    await withLdapEntry(
      'uid=nhaddad,ou=Care,dc=acme,dc=test',
      {
        objectClass: ['inetOrgPerson'],
        uid: 'nhaddad',
        cn: 'Nadia Haddad',
        sn: 'Haddad',
        mail: 'nadia@acme.test',
      },
      async () => {
        await sync();
        const user = await withTenant(tenantId, (tx) =>
          tx.user.findFirst({ where: { login: 'nhaddad' } }),
        );
        expect(user?.email).toBe('nadia@acme.test');
      },
    );
  });
});

describe('a leaver', () => {
  it('is deactivated rather than deleted, and can be proposed for return', async () => {
    await withLdapEntry(
      'uid=tberg,ou=Care,dc=acme,dc=test',
      {
        objectClass: ['inetOrgPerson'],
        uid: 'tberg',
        cn: 'Tomas Berg',
        sn: 'Berg',
        mail: 'tomas@acme.test',
      },
      async () => {
        await sync();
      },
    );

    // The entry is gone now; the next run should propose deactivation.
    await sync();
    const gone = await withTenant(tenantId, (tx) =>
      tx.user.findFirst({ where: { login: 'tberg' } }),
    );
    expect(gone).not.toBeNull();
    expect(gone!.status).toBe('inactive');
    expect(gone!.statusReason).toMatch(/absent from directory source/i);

    // And a rehire is proposed, never applied silently.
    await withLdapEntry(
      'uid=tberg,ou=Care,dc=acme,dc=test',
      {
        objectClass: ['inetOrgPerson'],
        uid: 'tberg',
        cn: 'Tomas Berg',
        sn: 'Berg',
        mail: 'tomas@acme.test',
      },
      async () => {
        const run = await preview();
        const changes = await changesOf(run.id);
        expect(
          changes.some((c) => c.changeType === 'reactivate_user'),
        ).toBe(true);

        const stillInactive = await withTenant(tenantId, (tx) =>
          tx.user.findFirst({ where: { login: 'tberg' } }),
        );
        expect(stillInactive!.status).toBe('inactive');
      },
    );
  });
});

describe('a membership change', () => {
  it('adds and removes members to match the source', async () => {
    await sync();

    await withLdapEntry(
      'cn=Trainers,dc=acme,dc=test',
      {
        objectClass: ['groupOfNames'],
        cn: 'Trainers',
        member: ['uid=sroe,ou=Care,dc=acme,dc=test'],
      },
      async () => {
        await sync();
        const memberships = await withTenant(tenantId, (tx) =>
          tx.groupMembership.findMany({
            include: { group: true, user: true },
          }),
        );
        const trainers = memberships.filter(
          (m) => m.group.name === 'Trainers',
        );
        expect(trainers).toHaveLength(1);
        expect(trainers[0]!.user.login).toBe('sroe');
      },
    );
  });
});

describe('the guard', () => {
  it('blocks a run that would deactivate everyone', async () => {
    await sync();

    // Point the source at a base that matches nothing: the read succeeds and
    // returns zero records, which is exactly what an outage looks like.
    await withTenant(tenantId, (tx) =>
      tx.directorySource.update({
        where: { id: sourceId },
        data: {
          config: { ...config, userFilter: '(objectClass=nothingAtAll)' } as never,
        },
      }),
    );

    const run = await preview();
    expect(run.status).toBe('blocked');
    expect(run.blockedReason).toMatch(/no records/i);

    await expect(
      withTenant(tenantId, (tx) => applyRun(tx, run.id)),
    ).rejects.toThrow(/blocked/i);

    const users = await withTenant(tenantId, (tx) =>
      tx.user.findMany({ where: { status: 'active' } }),
    );
    expect(users.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Run the tests**

Run: `pnpm vitest run packages/core/src/sync/scenarios.test.ts`
Expected: PASS, 6 tests.

The organizational-unit move test is the one that matters. If it reports a
deactivation, identity is anchored on the DN somewhere rather than on
`entryUUID`, and every reorganisation would deactivate everyone who moved.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test: cover moves, joiners, leavers, rehires and the guard against a real directory"
```

---

## Task 12: Scheduling

**Files:**
- Create: `packages/core/src/sync/jobs.ts`
- Modify: `apps/api/src/server.ts` — start the scheduler
- Test: `packages/core/src/sync/jobs.test.ts`

**Interfaces:**
- Consumes: `createScheduler`, `previewRun`, `applyRun`.
- Produces:
  - `SYNC_JOB = 'sync.run'`
  - `registerSyncJobs(scheduler, provider): void`
  - `syncJobPayload(tenantId, sourceId): { tenantId: string; sourceId: string }`

- [ ] **Step 1: Write the failing test**

`packages/core/src/sync/jobs.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { localMasterKeyProvider } from '../vault/master-key.js';
import { DEFAULT_MAPPINGS } from './defaults.js';
import { createSource, setMappings } from './source-service.js';
import { runSyncJob, SYNC_JOB, syncJobPayload } from './jobs.js';

const provider = localMasterKeyProvider(Buffer.alloc(32, 11));
let tenantId: string;
let sourceId: string;

const config = {
  url: process.env.LDAP_URL ?? 'ldap://localhost:1389',
  bindDn: 'cn=admin,dc=acme,dc=test',
  userSearchBase: 'dc=acme,dc=test',
  groupSearchBase: 'dc=acme,dc=test',
  userFilter: '(objectClass=inetOrgPerson)',
  groupFilter: '(objectClass=groupOfNames)',
  anchorAttribute: 'entryUUID',
  pageSize: 100,
  rejectUnauthorized: true,
};

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  await withTenant(tenantId, async (tx) => {
    const source = await createSource(tx, provider, {
      name: 'Scheduled LDAP',
      config,
      bindPassword: 'adminpassword',
    });
    sourceId = source.id;
    await setMappings(tx, source.id, DEFAULT_MAPPINGS.openLdap);
  });
});

describe('syncJobPayload', () => {
  it('carries the tenant, because a job has no ambient one', () => {
    expect(syncJobPayload(tenantId, sourceId)).toEqual({ tenantId, sourceId });
    expect(SYNC_JOB).toBe('sync.run');
  });
});

describe('runSyncJob', () => {
  it('previews without applying when autoApply is off', async () => {
    await runSyncJob(provider, syncJobPayload(tenantId, sourceId));

    const run = await withTenant(tenantId, (tx) => tx.syncRun.findFirst());
    expect(run?.status).toBe('previewed');

    const users = await withTenant(tenantId, (tx) => tx.user.findMany());
    expect(users).toEqual([]);
  });

  it('applies when autoApply is on', async () => {
    await withTenant(tenantId, (tx) =>
      tx.directorySource.update({
        where: { id: sourceId },
        data: { autoApply: true },
      }),
    );

    await runSyncJob(provider, syncJobPayload(tenantId, sourceId));

    const users = await withTenant(tenantId, (tx) => tx.user.findMany());
    expect(users.length).toBeGreaterThan(0);
  });

  it('does not apply a blocked run even with autoApply on', async () => {
    await withTenant(tenantId, (tx) =>
      tx.directorySource.update({
        where: { id: sourceId },
        data: {
          autoApply: true,
          config: { ...config, userFilter: '(objectClass=nothing)' } as never,
        },
      }),
    );

    await runSyncJob(provider, syncJobPayload(tenantId, sourceId));

    const run = await withTenant(tenantId, (tx) => tx.syncRun.findFirst());
    expect(run?.status).toBe('blocked');
    const users = await withTenant(tenantId, (tx) => tx.user.findMany());
    expect(users).toEqual([]);
  });

  it('records lastRunAt on the source', async () => {
    await runSyncJob(provider, syncJobPayload(tenantId, sourceId));
    const source = await withTenant(tenantId, (tx) =>
      tx.directorySource.findUnique({ where: { id: sourceId } }),
    );
    expect(source?.lastRunAt).not.toBeNull();
  });

  it('skips a disabled source without creating a run', async () => {
    await withTenant(tenantId, (tx) =>
      tx.directorySource.update({
        where: { id: sourceId },
        data: { enabled: false },
      }),
    );

    await runSyncJob(provider, syncJobPayload(tenantId, sourceId));
    expect(await withTenant(tenantId, (tx) => tx.syncRun.count())).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/core/src/sync/jobs.test.ts`
Expected: FAIL — cannot resolve `./jobs.js`.

- [ ] **Step 3: Implement it**

`packages/core/src/sync/jobs.ts`:

```ts
import { withTenant } from '@syntra/db';
import type { MasterKeyProvider } from '../vault/master-key.js';
import type { Scheduler } from '../jobs/scheduler.js';
import { applyRun, previewRun } from './run-service.js';

export const SYNC_JOB = 'sync.run';

export interface SyncJobPayload {
  tenantId: string;
  sourceId: string;
}

/** A background job has no request and therefore no bound tenant. */
export function syncJobPayload(
  tenantId: string,
  sourceId: string,
): SyncJobPayload {
  return { tenantId, sourceId };
}

export async function runSyncJob(
  provider: MasterKeyProvider,
  payload: SyncJobPayload,
): Promise<void> {
  await withTenant(payload.tenantId, async (tx) => {
    const source = await tx.directorySource.findUnique({
      where: { id: payload.sourceId },
    });
    if (!source || !source.enabled) return;

    const run = await previewRun(tx, provider, payload.sourceId);

    await tx.directorySource.update({
      where: { id: payload.sourceId },
      data: { lastRunAt: new Date() },
    });

    // The guard is not advisory. A blocked run does not apply, and autoApply
    // does not override it — an unattended schedule is exactly the case it
    // exists for.
    if (source.autoApply && run.status === 'previewed') {
      await applyRun(tx, run.id);
    }
  });
}

export function registerSyncJobs(
  scheduler: Scheduler,
  provider: MasterKeyProvider,
): void {
  scheduler.register<SyncJobPayload>(SYNC_JOB, (payload) =>
    runSyncJob(provider, payload),
  );
}
```

Add `export * from './sync/jobs.js';` to `packages/core/src/index.ts`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/core/src/sync/jobs.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: run directory sync on a schedule"
```

---

## Task 13: Administration API

**Files:**
- Create: `apps/api/src/routes/admin/sources.ts`, `apps/api/src/routes/admin/sync-runs.ts`
- Create: `packages/contracts/src/sync.ts`
- Modify: `packages/contracts/src/index.ts`, `apps/api/src/app.ts`
- Test: `apps/api/src/routes/admin/sources.test.ts`

**Interfaces:**
- Consumes: `requireSession`, `requirePermission`, source and run services.
- Produces: `GET/POST /api/admin/sources`, `POST /api/admin/sources/:id/test`, `POST /api/admin/sources/:id/run`, `PUT /api/admin/sources/:id/mappings`, `GET /api/admin/sync-runs`, `GET /api/admin/sync-runs/:id`, `POST /api/admin/sync-runs/:id/apply`, `POST /api/admin/sync-changes/:id/skip`.

- [ ] **Step 1: Write the contracts**

`packages/contracts/src/sync.ts`:

```ts
import { z } from 'zod';

export const createSourceRequest = z.object({
  name: z.string().min(1).max(256),
  config: z.record(z.unknown()),
  bindPassword: z.string().min(1).max(1024),
  schedule: z.string().max(128).optional(),
  autoApply: z.boolean().optional(),
  deactivationThresholdPercent: z.number().int().min(0).max(100).optional(),
});

export const mappingRule = z.object({
  objectType: z.enum(['user', 'group', 'orgUnit']),
  sourceAttribute: z.string().min(1).max(128),
  targetField: z.string().min(1).max(128),
  transform: z.enum(['none', 'trim', 'lowercase']),
  isCorrelation: z.boolean(),
});

export const setMappingsRequest = z.object({
  rules: z.array(mappingRule).min(1),
});

export const applyRunRequest = z.object({
  only: z.array(z.string().uuid()).optional(),
});
```

Add `export * from './sync.js';` to `packages/contracts/src/index.ts`.

- [ ] **Step 2: Write the failing test**

`apps/api/src/routes/admin/sources.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@syntra/db';
import {
  PERMISSIONS,
  assignRole,
  createRole,
  createUser,
  setPassword,
  type Permission,
} from '@syntra/core';
import { buildTestApp } from '../../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
const PASSWORD = 'a-long-enough-password';

const config = {
  url: process.env.LDAP_URL ?? 'ldap://localhost:1389',
  bindDn: 'cn=admin,dc=acme,dc=test',
  userSearchBase: 'dc=acme,dc=test',
  groupSearchBase: 'dc=acme,dc=test',
  userFilter: '(objectClass=inetOrgPerson)',
  groupFilter: '(objectClass=groupOfNames)',
  anchorAttribute: 'entryUUID',
};

async function adminCookie(permissions: Permission[]) {
  await withTenant(ctx.tenantId, async (tx) => {
    const user = await createUser(tx, {
      login: 'admin',
      email: 'a@acme.test',
      displayName: 'Admin',
    });
    await setPassword(tx, user.id, PASSWORD);
    const role = await createRole(tx, 'R', permissions);
    await assignRole(tx, user.id, role.id);
  });

  const login = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { host: ctx.host },
    payload: { login: 'admin', password: PASSWORD },
  });
  const token = login.cookies.find((c) => c.name === 'syntra_session')!.value;
  const up = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/elevate',
    headers: { host: ctx.host, cookie: `syntra_session=${token}` },
    payload: { password: PASSWORD },
  });
  return `syntra_session=${up.cookies.find((c) => c.name === 'syntra_session')!.value}`;
}

const post = (url: string, cookie: string, payload: unknown = {}) =>
  ctx.app.inject({
    method: 'POST',
    url,
    headers: { host: ctx.host, cookie },
    payload: payload as object,
  });

const get = (url: string, cookie: string) =>
  ctx.app.inject({ method: 'GET', url, headers: { host: ctx.host, cookie } });

beforeEach(async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();
});

describe('source administration', () => {
  it('creates a source without echoing the password', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE, PERMISSIONS.SYNC_READ]);

    const res = await post('/api/admin/sources', cookie, {
      name: 'Head office',
      config,
      bindPassword: 'adminpassword',
    });

    expect(res.statusCode).toBe(201);
    expect(res.body).not.toContain('adminpassword');
  });

  it('refuses to create a source with only sync.read', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_READ]);
    const res = await post('/api/admin/sources', cookie, {
      name: 'Head office',
      config,
      bindPassword: 'adminpassword',
    });
    expect(res.statusCode).toBe(403);
  });

  it('tests a connection and reports what it found', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE, PERMISSIONS.SYNC_READ]);
    const created = await post('/api/admin/sources', cookie, {
      name: 'Head office',
      config,
      bindPassword: 'adminpassword',
    });

    const res = await post(`/api/admin/sources/${created.json().id}/test`, cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(res.json().sampleCounts.user).toBeGreaterThan(0);
  });

  it('reports a bad credential as ok:false rather than a 500', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE, PERMISSIONS.SYNC_READ]);
    const created = await post('/api/admin/sources', cookie, {
      name: 'Bad',
      config,
      bindPassword: 'wrong-password',
    });

    const res = await post(`/api/admin/sources/${created.json().id}/test`, cookie);
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(false);
  });
});

describe('runs', () => {
  async function seeded(cookie: string) {
    const created = await post('/api/admin/sources', cookie, {
      name: 'Head office',
      config,
      bindPassword: 'adminpassword',
    });
    const id = created.json().id;
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/admin/sources/${id}/mappings`,
      headers: { host: ctx.host, cookie },
      payload: {
        rules: [
          { objectType: 'user', sourceAttribute: 'uid', targetField: 'login', transform: 'lowercase', isCorrelation: true },
          { objectType: 'user', sourceAttribute: 'mail', targetField: 'email', transform: 'lowercase', isCorrelation: false },
          { objectType: 'user', sourceAttribute: 'cn', targetField: 'displayName', transform: 'trim', isCorrelation: false },
          { objectType: 'group', sourceAttribute: 'cn', targetField: 'name', transform: 'trim', isCorrelation: true },
        ],
      },
    });
    return id;
  }

  it('runs a preview and returns the proposed changes', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE, PERMISSIONS.SYNC_READ]);
    const id = await seeded(cookie);

    const run = await post(`/api/admin/sources/${id}/run`, cookie);
    expect(run.statusCode).toBe(200);
    expect(run.json().status).toBe('previewed');

    const detail = await get(`/api/admin/sync-runs/${run.json().id}`, cookie);
    expect(detail.json().changes.length).toBeGreaterThan(0);
  });

  it('applies a run', async () => {
    const cookie = await adminCookie([PERMISSIONS.SYNC_MANAGE, PERMISSIONS.SYNC_READ, PERMISSIONS.DIRECTORY_READ]);
    const id = await seeded(cookie);
    const run = await post(`/api/admin/sources/${id}/run`, cookie);

    const applied = await post(`/api/admin/sync-runs/${run.json().id}/apply`, cookie);
    expect(applied.statusCode).toBe(200);

    const users = await get('/api/admin/users', cookie);
    expect(users.json().users.length).toBeGreaterThan(0);
  });

  it('refuses to apply with only sync.read', async () => {
    const manage = await adminCookie([PERMISSIONS.SYNC_MANAGE, PERMISSIONS.SYNC_READ]);
    const id = await seeded(manage);
    const run = await post(`/api/admin/sources/${id}/run`, manage);

    // A second administrator holding only read.
    await withTenant(ctx.tenantId, async (tx) => {
      const user = await createUser(tx, {
        login: 'reader',
        email: 'r@acme.test',
        displayName: 'Reader',
      });
      await setPassword(tx, user.id, PASSWORD);
      const role = await createRole(tx, 'ReadOnly', [PERMISSIONS.SYNC_READ]);
      await assignRole(tx, user.id, role.id);
    });
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { host: ctx.host },
      payload: { login: 'reader', password: PASSWORD },
    });
    const token = login.cookies.find((c) => c.name === 'syntra_session')!.value;
    const up = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/elevate',
      headers: { host: ctx.host, cookie: `syntra_session=${token}` },
      payload: { password: PASSWORD },
    });
    const readerCookie = `syntra_session=${up.cookies.find((c) => c.name === 'syntra_session')!.value}`;

    const res = await post(
      `/api/admin/sync-runs/${run.json().id}/apply`,
      readerCookie,
    );
    expect(res.statusCode).toBe(403);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run apps/api/src/routes/admin/sources.test.ts`
Expected: FAIL — 404, routes not registered.

- [ ] **Step 4: Implement the routes**

`apps/api/src/routes/admin/sources.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { createSourceRequest, idParam, setMappingsRequest } from '@syntra/contracts';
import { ldapConnector } from '@syntra/connectors';
import {
  PERMISSIONS,
  createSource,
  listSources,
  localMasterKeyProvider,
  mappingsFor,
  previewRun,
  recordEvent,
  setMappings,
  sourceWithPassword,
  type MappingRule,
} from '@syntra/core';
import { ProblemError } from '../../plugins/problem-json.js';
import { requireSession } from '../../plugins/require-session.js';
import { requirePermission } from '../../plugins/require-permission.js';

export interface SourceRouteOptions {
  masterKey: Buffer;
}

export async function registerAdminSourceRoutes(
  app: FastifyInstance,
  options: SourceRouteOptions,
): Promise<void> {
  const provider = localMasterKeyProvider(options.masterKey);

  app.addHook('preHandler', requireSession('admin'));

  app.get(
    '/sources',
    { preHandler: requirePermission(PERMISSIONS.SYNC_READ) },
    async (request) => ({ sources: await request.db((tx) => listSources(tx)) }),
  );

  app.post(
    '/sources',
    { preHandler: requirePermission(PERMISSIONS.SYNC_MANAGE) },
    async (request, reply) => {
      const body = createSourceRequest.parse(request.body);

      const source = await request.db(async (tx) => {
        const created = await createSource(tx, provider, body);
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'source.create',
          targetType: 'DirectorySource',
          targetId: created.id,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { name: created.name },
        });
        return created;
      });

      // The row carries only the secret's name; the password itself is in the
      // vault and is never echoed.
      return reply.status(201).send(source);
    },
  );

  app.put(
    '/sources/:id/mappings',
    { preHandler: requirePermission(PERMISSIONS.SYNC_MANAGE) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const { rules } = setMappingsRequest.parse(request.body);

      await request.db(async (tx) => {
        try {
          await setMappings(tx, id, rules as MappingRule[]);
        } catch (cause) {
          throw new ProblemError(
            400,
            'invalid-mappings',
            'Invalid mappings',
            cause instanceof Error ? cause.message : undefined,
          );
        }
      });

      return { rules: await request.db((tx) => mappingsFor(tx, id)) };
    },
  );

  app.post(
    '/sources/:id/test',
    { preHandler: requirePermission(PERMISSIONS.SYNC_READ) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const config = await request.db((tx) =>
        sourceWithPassword(tx, provider, id),
      );
      if (!config) throw new ProblemError(404, 'not-found', 'Source not found');

      // A failed connection is a result, not a server error: the operator
      // needs the message, not a 500.
      return ldapConnector.test(config);
    },
  );

  app.post(
    '/sources/:id/run',
    { preHandler: requirePermission(PERMISSIONS.SYNC_MANAGE) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      return request.db((tx) => previewRun(tx, provider, id));
    },
  );
}
```

`apps/api/src/routes/admin/sync-runs.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { applyRunRequest, idParam } from '@syntra/contracts';
import {
  PERMISSIONS,
  applyRun,
  listRuns,
  recordEvent,
  skipChange,
} from '@syntra/core';
import { ProblemError } from '../../plugins/problem-json.js';
import { requireSession } from '../../plugins/require-session.js';
import { requirePermission } from '../../plugins/require-permission.js';

const listQuery = z.object({ sourceId: z.string().uuid().optional() });

export async function registerAdminSyncRunRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.addHook('preHandler', requireSession('admin'));

  app.get(
    '/sync-runs',
    { preHandler: requirePermission(PERMISSIONS.SYNC_READ) },
    async (request) => {
      const { sourceId } = listQuery.parse(request.query);
      return { runs: await request.db((tx) => listRuns(tx, sourceId)) };
    },
  );

  app.get(
    '/sync-runs/:id',
    { preHandler: requirePermission(PERMISSIONS.SYNC_READ) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      return request.db(async (tx) => {
        const run = await tx.syncRun.findUnique({ where: { id } });
        if (!run) throw new ProblemError(404, 'not-found', 'Run not found');
        const changes = await tx.syncChange.findMany({
          where: { runId: id },
          orderBy: [{ changeType: 'asc' }, { id: 'asc' }],
        });
        return { ...run, changes };
      });
    },
  );

  app.post(
    '/sync-runs/:id/apply',
    { preHandler: requirePermission(PERMISSIONS.SYNC_MANAGE) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const body = applyRunRequest.parse(request.body ?? {});

      return request.db(async (tx) => {
        let run;
        try {
          run = await applyRun(tx, id, body.only ? { only: body.only } : {});
        } catch (cause) {
          if (cause instanceof Error && /blocked/i.test(cause.message)) {
            throw new ProblemError(
              409,
              'run-blocked',
              'Run blocked',
              cause.message,
            );
          }
          throw cause;
        }

        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'sync.apply',
          targetType: 'SyncRun',
          targetId: id,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { status: run.status },
        });
        return run;
      });
    },
  );

  app.post(
    '/sync-changes/:id/skip',
    { preHandler: requirePermission(PERMISSIONS.SYNC_MANAGE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      await request.db((tx) => skipChange(tx, id));
      return reply.status(204).send();
    },
  );
}
```

Register both in `apps/api/src/app.ts`, passing the master key:

```ts
await app.register(registerAdminSourceRoutes, {
  prefix: '/api/admin',
  masterKey: config.masterKey,
});
await app.register(registerAdminSyncRunRoutes, { prefix: '/api/admin' });
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run apps/api/src/routes/admin/sources.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add directory source and sync run administration API"
```

---

## Task 14: The review screen

**Files:**
- Create: `apps/web/src/pages/admin/SourcesPage.tsx`, `apps/web/src/pages/admin/SyncRunsPage.tsx`, `apps/web/src/pages/admin/SyncRunDetailPage.tsx`
- Modify: `apps/web/src/pages/admin/AdminApp.tsx` — add the routes and navigation
- Test: `apps/web/src/pages/admin/SyncRunDetailPage.test.tsx`

**Interfaces:**
- Consumes: `useApiResource`, `api`, `Panel`, `Alert`, `Status`, `Empty`, `Button`.
- Produces: no new shared interfaces.

- [ ] **Step 1: Write the failing test**

`apps/web/src/pages/admin/SyncRunDetailPage.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SyncRunDetailPage } from './SyncRunDetailPage.js';

const run = (overrides: Record<string, unknown> = {}) => ({
  id: 'r1',
  status: 'previewed',
  startedAt: '2026-08-15T09:00:00.000Z',
  finishedAt: '2026-08-15T09:00:04.000Z',
  recordsRead: 412,
  requiresConfirmation: false,
  blockedReason: null,
  error: null,
  unresolvedMembers: 0,
  changes: [
    {
      id: 'c1',
      changeType: 'create_user',
      targetType: 'User',
      targetId: null,
      sourceAnchor: 'a1',
      before: null,
      after: { login: 'nhaddad', email: 'nadia@acme.test' },
      status: 'proposed',
      message: null,
    },
    {
      id: 'c2',
      changeType: 'deactivate_user',
      targetType: 'User',
      targetId: 'u9',
      sourceAnchor: 'a9',
      before: { status: 'active' },
      after: { status: 'inactive' },
      status: 'proposed',
      message: null,
    },
    {
      id: 'c3',
      changeType: 'create_user',
      targetType: 'User',
      targetId: 'u1',
      sourceAnchor: 'a2',
      before: null,
      after: { login: 'admin' },
      status: 'conflict',
      message: 'matches a locally managed object',
    },
  ],
  ...overrides,
});

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }) as never;

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/admin/sync-runs/r1']}>
      <Routes>
        <Route path="/admin/sync-runs/:id" element={<SyncRunDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => vi.restoreAllMocks());

describe('SyncRunDetailPage', () => {
  it('groups changes by type with counts', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(run()));
    renderPage();

    expect(await screen.findByText(/create user/i)).toBeInTheDocument();
    expect(screen.getByText(/deactivate user/i)).toBeInTheDocument();
  });

  it('shows what a change would set', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(run()));
    renderPage();

    expect(await screen.findByText(/nhaddad/)).toBeInTheDocument();
  });

  it('marks a conflict and explains it', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(run()));
    renderPage();

    expect(
      await screen.findByText(/matches a locally managed object/i),
    ).toBeInTheDocument();
  });

  it('leads with why a run was blocked, and disables apply', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json(
        run({
          status: 'blocked',
          blockedReason:
            'would deactivate 380 of 400 objects from this source (95.0%), above the 10% threshold',
          requiresConfirmation: true,
        }),
      ),
    );
    renderPage();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/95.0%/);
    expect(alert).toHaveTextContent(/threshold/);
    expect(screen.getByRole('button', { name: /apply/i })).toBeDisabled();
  });

  it('reports unresolved members rather than hiding them', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json(run({ unresolvedMembers: 3 })),
    );
    renderPage();

    expect(await screen.findByText(/3 group members/i)).toBeInTheDocument();
  });

  it('says plainly when a run proposed nothing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(run({ changes: [] })));
    renderPage();

    expect(await screen.findByText(/already matches/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && pnpm exec vitest run src/pages/admin/SyncRunDetailPage.test.tsx`
Expected: FAIL — cannot resolve `./SyncRunDetailPage.js`.

- [ ] **Step 3: Implement the review screen**

`apps/web/src/pages/admin/SyncRunDetailPage.tsx`:

```tsx
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { Alert, Button, Empty, Panel, SkeletonRows, Status } from '@syntra/ui';
import { api } from '../../session/api.js';
import { useApiResource } from './hooks.js';
import { PageHeader } from './PageHeader.js';

interface Change {
  id: string;
  changeType: string;
  targetType: string;
  targetId: string | null;
  sourceAnchor: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  status: string;
  message: string | null;
}

interface RunDetail {
  id: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  recordsRead: number;
  requiresConfirmation: boolean;
  blockedReason: string | null;
  error: string | null;
  unresolvedMembers: number;
  changes: Change[];
}

const LABELS: Record<string, string> = {
  create_user: 'Create user',
  update_user: 'Update user',
  deactivate_user: 'Deactivate user',
  reactivate_user: 'Reactivate user',
  create_group: 'Create group',
  update_group: 'Update group',
  deactivate_group: 'Deactivate group',
  add_member: 'Add group member',
  remove_member: 'Remove group member',
  create_org_unit: 'Create org unit',
  update_org_unit: 'Update org unit',
};

const summarise = (value: Record<string, unknown> | null) =>
  value === null
    ? '—'
    : Object.entries(value)
        .map(([k, v]) => `${k}: ${String(v)}`)
        .join(', ');

export function SyncRunDetailPage() {
  const { id } = useParams();
  const { data, error, loading, reload } = useApiResource<RunDetail>(
    `/api/admin/sync-runs/${id}`,
  );
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  async function onApply() {
    setApplying(true);
    setApplyError(null);
    try {
      await api(`/api/admin/sync-runs/${id}/apply`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      reload();
    } catch {
      setApplyError('The run could not be applied.');
    } finally {
      setApplying(false);
    }
  }

  if (error) return <Alert tone="danger">{error}</Alert>;
  if (loading || !data) {
    return (
      <Panel>
        <SkeletonRows rows={6} cols={4} />
      </Panel>
    );
  }

  const blocked = data.status === 'blocked';
  const applied = data.status === 'applied' || data.status === 'partially_applied';
  const grouped = new Map<string, Change[]>();
  for (const change of data.changes) {
    grouped.set(change.changeType, [
      ...(grouped.get(change.changeType) ?? []),
      change,
    ]);
  }

  return (
    <>
      <PageHeader
        title="Sync run"
        description={`${data.recordsRead} records read, ${data.changes.length} proposed changes`}
        actions={
          <Button
            variant="primary"
            onClick={onApply}
            loading={applying}
            disabled={blocked || applied || data.changes.length === 0}
          >
            Apply
          </Button>
        }
      />

      <div className="space-y-6">
        {blocked && (
          // A blocked run leads with why. The numbers are the point: an
          // administrator needs to see the scale before deciding anything.
          <Alert tone="danger" title="This run was blocked and will not apply">
            {data.blockedReason}
          </Alert>
        )}

        {data.error && (
          <Alert tone="danger" title="This run failed">
            {data.error}
          </Alert>
        )}

        {applyError && <Alert tone="danger">{applyError}</Alert>}

        {data.unresolvedMembers > 0 && (
          <Alert tone="warning" title="Some memberships could not be resolved">
            {data.unresolvedMembers} group members are outside the configured
            search base and were not synced. Widen the base to include them.
          </Alert>
        )}

        {data.changes.length === 0 ? (
          <Empty title="Nothing to change">
            Syntra already matches the source. A run with no proposed changes is
            the normal result once the directory is in step.
          </Empty>
        ) : (
          [...grouped.entries()].map(([type, changes]) => (
            <Panel
              key={type}
              title={`${LABELS[type] ?? type} (${changes.length})`}
            >
              <table className="w-full text-left">
                <thead className="border-b border-border-subtle bg-surface-2">
                  <tr className="text-sm text-muted">
                    <th scope="col" className="px-4 py-2.5 font-medium">
                      From
                    </th>
                    <th scope="col" className="px-4 py-2.5 font-medium">
                      To
                    </th>
                    <th scope="col" className="px-4 py-2.5 font-medium">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {changes.map((change) => (
                    <tr
                      key={change.id}
                      className="border-b border-border-subtle last:border-0"
                    >
                      <td className="px-4 py-2.5 text-muted">
                        {summarise(change.before)}
                      </td>
                      <td className="px-4 py-2.5 text-ink">
                        {summarise(change.after)}
                      </td>
                      <td className="px-4 py-2.5">
                        {change.status === 'conflict' ? (
                          <span className="flex flex-wrap items-center gap-2">
                            <Status tone="warning">Conflict</Status>
                            <span className="text-sm text-muted">
                              {change.message}
                            </span>
                          </span>
                        ) : change.status === 'applied' ? (
                          <Status tone="active">Applied</Status>
                        ) : change.status === 'failed' ? (
                          <span className="flex flex-wrap items-center gap-2">
                            <Status tone="danger">Failed</Status>
                            <span className="text-sm text-muted">
                              {change.message}
                            </span>
                          </span>
                        ) : (
                          <Status tone="neutral">{change.status}</Status>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          ))
        )}
      </div>
    </>
  );
}
```

- [ ] **Step 4: Implement the list pages**

`apps/web/src/pages/admin/SourcesPage.tsx` lists sources with their last run
time, schedule, and whether auto-apply is on, using `useApiResource` over
`/api/admin/sources`, with an `Empty` state reading "No directory sources yet —
connect one to bring users and groups in automatically."

`apps/web/src/pages/admin/SyncRunsPage.tsx` lists runs from
`/api/admin/sync-runs`, newest first, each linking to
`/admin/sync-runs/:id`, with the run status as a `Status` badge — `blocked`
in the `danger` tone so it is unmissable in a list.

Add to `AdminApp.tsx`'s `NAV` array:

```ts
  { to: '/admin/sources', label: 'Directory sources', permission: 'sync.read' },
  { to: '/admin/sync-runs', label: 'Sync runs', permission: 'sync.read' },
```

and to its `Routes`:

```tsx
<Route path="sources" element={<SourcesPage />} />
<Route path="sync-runs" element={<SyncRunsPage />} />
<Route path="sync-runs/:id" element={<SyncRunDetailPage />} />
```

- [ ] **Step 5: Run the tests**

Run: `cd apps/web && pnpm exec vitest run`
Expected: PASS — the six new tests plus the existing suite.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add directory source and sync run review screens"
```

---

## Task 15: Verify the whole slice

**Files:**
- Modify: `README.md` — document directory sync
- Modify: `e2e/access.spec.ts` or create `e2e/sync.spec.ts`
- Modify: `packages/db/src/seed.ts` — no change required, but confirm it still runs

- [ ] **Step 1: Typecheck the workspace**

Run: `pnpm exec tsc -b`
Expected: 0 errors.

Vitest transpiles without type-checking, so this is the only thing that
catches a signature drift between the stages.

- [ ] **Step 2: Run every suite in order**

```bash
docker compose -f infra/docker-compose.yml up -d
pnpm test
pnpm --filter @syntra/web test
pnpm db:reset
SEED_ADMIN_PASSWORD='...' SEED_USER_PASSWORD='...' pnpm seed
AUTH_RATE_LIMIT_MAX=200 pnpm dev &
pnpm e2e
```

Expected: every suite green. The ordering matters — the integration tests
truncate the database, so the seed runs after them, and the browser suite
needs a raised rate limit.

- [ ] **Step 3: Write the end-to-end test**

`e2e/sync.spec.ts`, following the helpers already in `e2e/access.spec.ts`:
sign in, elevate, open **Directory sources**, create a source pointing at
`ldap://localhost:1389`, test the connection and see the counts, run a
preview, see the proposed creates grouped by type, apply, and then find the
LDAP users listed under **Users** with their source shown.

- [ ] **Step 4: Update the README**

Add Directory Sync to the module table as built, and a short section on
connecting a source: the LDAP container is already in
`infra/docker-compose.yml` for development, the bind password goes into the
vault rather than the config, and a run previews before it applies.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs: document directory sync and cover it end to end"
```

---

## Plan self-review

**Spec coverage.** Every section of the spec maps to a task:

| Spec section | Task |
|---|---|
| §1 success criteria 1–2 (connect, read, page) | 8 |
| §1 criterion 3 (reviewable diff) | 6, 10 |
| §1 criterion 4 (apply, partially apply) | 10, 13 |
| §1 criterion 5 (guard) | 7, 11 |
| §1 criterion 6 (OU move) | 3, 5, 11 |
| §1 criterion 7 (conflicts) | 5, 10 |
| §1 criterion 8 (schedule, audit) | 10, 12 |
| §4 materialized diff rows | 1, 6, 10 |
| §5 data model | 1 |
| §6 identity across runs | 3, 5 |
| §7 pipeline | 4, 5, 6, 7, 10 |
| §8 LDAP connector | 2, 3, 8 |
| §9 the guard | 7 |
| §10 applying | 10 |
| §11 administration surface | 13, 14 |
| §12 testing | 11, 15 |
| §13 out of scope | not built, `write` stubbed in 8 |

**Placeholder scan.** No "TBD", no "add error handling", no "similar to Task N".
Two places describe files in prose rather than full code — the `SourcesPage` and
`SyncRunsPage` in Task 14 — and in both cases the prose names the exact hook,
endpoint, empty-state copy and tone to use, and the novel screen (the review
page) is given in full.

**Type consistency.** Checked across tasks: `SourceRecord` (2) is what
`mapRecord` (4) consumes; `DirectoryObject` (4) is what `correlate` (5)
consumes; `Correlation` and `ExistingObject` (5) are what `diffObjects` (6)
consumes; `ProposedChange` (6) is what `evaluateGuard` (7) counts and what
`applyChange` (10) reads back from the database; `MappingRule` (4) is what
`setMappings` (9) persists and `mappingsFor` (9) returns; `LdapConfig` (8) is
what `sourceWithPassword` (9) returns and `ldapConnector.read` (8) accepts;
`PERMISSIONS.SYNC_READ` / `SYNC_MANAGE` (9) are what the routes (13) and the
navigation (14) require.

**One issue found and fixed during review.** The first draft had
`deactivate_group` write its reason into the group's `description`, because
`Group` had no `status` column the way `User` does. That is a field meaning one
thing being used for another, and it would have made a deactivated group
indistinguishable from one an administrator had described oddly. Task 1 now adds
`status` and `statusReason` to `Group`, Task 10 uses them, and correlation reads
the real status rather than assuming every group is active.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-15-syntra-directory-sync.md`.
