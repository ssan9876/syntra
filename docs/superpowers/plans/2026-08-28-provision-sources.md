# Provision — Sources (the HR feed) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Syntra a source family for HR systems — read on a schedule over SFTP, mapped onto `Person` and `Contract`, diffed, guarded, previewed and applied — so the HR feed four subsystems already reason about actually exists.

**Architecture:** A parallel pipeline to Directory Sync that meets Provision at the person register and nowhere else. New `SourceConnector` interface in `@syntra/connectors` (read-only, no write path), four new tables, and a `person-source` module in `@syntra/core` mirroring the phase structure of `sync/run-service.ts`. Nothing in `DirectorySource`, `SyncRun` or `SyncChange` is modified.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Prisma 6 + PostgreSQL with row-level security, Zod 3, Fastify, React + React Router, Vitest, Playwright, `ssh2` for SFTP.

**Spec:** `docs/superpowers/specs/2026-08-28-provision-sources-design.md`

## Global Constraints

- **Never delete a `Person` or a `Contract`.** No change type in this pipeline deletes either, and none may become one.
- **`SourceConnector` has no write path.** No `write`, no `discoverSchema`, no `SourceWriteback`. Do not add one "for symmetry".
- **`read` yields every record or throws.** No partial-success return value. Ceilings throw; they never stop the iteration quietly.
- **`readFailure` and mapping failures are counted as read and excluded from the diff.** They are never treated as absent.
- **`feedMode` has no default**, in the schema, in the Zod contract, or in the console form.
- **In `delta` mode the diff cannot produce `depart_person`.** Never produced — not produced-then-filtered.
- **An absence-derived departure writes `status` and `statusReason`, never `departureOverride`.**
- **Network I/O never happens inside a transaction** (Global Constraint 1, as `sync/run-service.ts` phases it).
- **Every new table gets row-level security** in its migration: `ENABLE`, `FORCE`, and a `tenant_isolation` policy, per `20260921000000_org_unit_container/migration.sql`.
- **Zod request schemas are strict** (`.strict()`), per `packages/contracts/src/strictness.test.ts` — a misspelled key must fail, not be stripped.
- **Import specifiers end in `.js`** even for TypeScript sources.
- Run tests with `pnpm test`. There is no linter in this repo; do not add lint steps.

---

## File Structure

**`packages/connectors/src/person/`** — the new source family, all of it read-only.

| File | Responsibility |
|---|---|
| `types.ts` | `PersonSnapshotRecord`, `ContractSnapshot`, `SourceConnectionResult`, `SourceConnector<C>` |
| `delimited.ts` | `readDelimited` — a pure function of a string. No I/O. |
| `registry.ts` | `PERSON_SOURCE_TYPES`, `personSourceConnectorFor`, `personSourceConfigSchemaFor` |
| `sftp/config.ts` | `sftpDelimitedConfigSchema`, `SftpDelimitedConfig` |
| `sftp/transport.ts` | Host-key pinning, address classification, address-pinned connect, byte/row ceilings |
| `sftp/connector.ts` | `sftpDelimitedConnector` — `test` and `read`, composed of the two above |

**`packages/connectors/src/testing/fake-person-source.ts`** — `FakePersonSource`, exported only from `@syntra/connectors/testing`.

**`packages/core/src/person-source/`** — the pipeline.

| File | Responsibility |
|---|---|
| `mapping.ts` | `ASSIGNABLE_PERSON_FIELDS`, `ASSIGNABLE_CONTRACT_FIELDS`, `mapPersonRecord` |
| `source-service.ts` | CRUD, vault credential, mappings |
| `diff.ts` | `diffPersons` — pure, no database |
| `guard.ts` | `evaluatePersonGuard` — pure |
| `run-service.ts` | `previewImportRun`, `applyImportRun`, `skipImportChange`, `listImportRuns` |
| `jobs.ts` | `PERSON_IMPORT_JOB`, `queueImportRun`, schedule registration |

**`apps/api/src/routes/admin/person-sources.ts`** — the HTTP surface.
**`packages/contracts/src/person-source.ts`** — Zod request schemas.
**`apps/web/src/pages/admin/`** — `PersonSourcesTab.tsx`, `PersonSourceDetailPage.tsx`, `PersonImportRunDetailPage.tsx`; `SourcesPage.tsx` gains a tab.

---

## Task 1: Schema and migration

**Files:**
- Modify: `packages/db/prisma/schema.prisma`
- Create: `packages/db/prisma/migrations/20260925000000_person_sources/migration.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: Prisma models `PersonSource`, `PersonFieldMapping`, `PersonImportRun`, `PersonImportChange`; columns `Person.sourceId`, `Person.statusReason`, `Contract.externalId`.

- [ ] **Step 1: Add the four models to `schema.prisma`**

Append after the `SyncChange` model:

```prisma
/// A system Syntra reads persons and contracts from. Distinct from
/// DirectorySource, which reads users, groups and org units: a person is
/// none of those three, and the write-back flags a directory source carries
/// are meaningless here because SourceConnector has no write path.
model PersonSource {
  id                           String    @id @default(uuid()) @db.Uuid
  tenantId                     String    @db.Uuid
  name                         String
  type                         String
  config                       Json
  secretName                   String
  /// 'snapshot' or 'delta'. NO DEFAULT, deliberately: a delta file read as a
  /// snapshot departs everyone absent from it, which is everyone who did not
  /// change yesterday. The choice is made once, explicitly, by a human who
  /// was shown both consequences.
  feedMode                     String
  schedule                     String?
  autoApply                    Boolean   @default(false)
  deactivationThresholdPercent Int       @default(10)
  enabled                      Boolean   @default(true)
  lastRunAt                    DateTime?
  createdAt                    DateTime  @default(now())
  updatedAt                    DateTime  @updatedAt

  mappings PersonFieldMapping[]
  runs     PersonImportRun[]
  /// Restrict, for the reason DirectorySource.users records: without the key,
  /// deleting a source strands its persons permanently unfed, and SetNull
  /// turns them into hand-managed rows nothing keeps current.
  persons  Person[]

  @@unique([tenantId, name])
  @@index([tenantId])
}

model PersonFieldMapping {
  id            String       @id @default(uuid()) @db.Uuid
  tenantId      String       @db.Uuid
  sourceId      String       @db.Uuid
  source        PersonSource @relation(fields: [sourceId], references: [id], onDelete: Cascade)
  /// 'person' or 'contract'.
  recordType    String
  sourceColumn  String
  targetField   String
  transform     String       @default("none")
  isCorrelation Boolean      @default(false)

  @@unique([sourceId, recordType, targetField])
  @@index([tenantId])
}

model PersonImportRun {
  id                    String       @id @default(uuid()) @db.Uuid
  tenantId              String       @db.Uuid
  sourceId              String       @db.Uuid
  source                PersonSource @relation(fields: [sourceId], references: [id], onDelete: Cascade)
  status                String       @default("running")
  startedAt             DateTime     @default(now())
  finishedAt            DateTime?
  recordsRead           Int          @default(0)
  requiresConfirmation  Boolean      @default(false)
  blockedReason         String?
  error                 String?
  /// Records read but excluded from the diff: a readFailure from the
  /// connector, or a record no mapping could turn into a person. Never
  /// counted as absent.
  mappingFailures       Int          @default(0)
  mappingFailureReasons String[]     @default([])
  /// Persons this source owns that a complete snapshot did not return.
  personsAbsent         Int          @default(0)
  /// Who confirmed a guarded run. An override nobody can find later is not a
  /// control.
  confirmedBy           String?      @db.Uuid

  changes PersonImportChange[]

  @@index([tenantId, startedAt])
  @@index([sourceId])
}

model PersonImportChange {
  id         String          @id @default(uuid()) @db.Uuid
  tenantId   String          @db.Uuid
  runId      String          @db.Uuid
  run        PersonImportRun @relation(fields: [runId], references: [id], onDelete: Cascade)
  changeType String
  /// 'person' or 'contract'.
  recordType String
  targetId   String?         @db.Uuid
  externalId String?
  before     Json?
  after      Json?
  status     String          @default("proposed")
  message    String?

  @@index([tenantId])
  @@index([runId, changeType])
  @@index([runId, status])
}
```

- [ ] **Step 2: Add the three columns**

In `model Person`, add:

```prisma
  /// The person source that owns this row, if any. Null for people created by
  /// hand or by CSV import, who stay fully editable.
  sourceId String?       @db.Uuid
  source   PersonSource? @relation(fields: [sourceId], references: [id])
  /// Why this person is inactive. Mirrors User.statusReason.
  ///
  /// An absence-derived departure writes THIS and never departureOverride:
  /// that field means a human knew something the contract table did not, and
  /// departureDate() prefers it over contract dates for that reason. An
  /// import knows only that a row was missing.
  statusReason String?
```

In `model Contract`, add:

```prisma
  /// The HR system's own employment id. The stable key a diff matches on;
  /// `sequence` is a Syntra-side display ordinal and two contracts arriving
  /// in a different order would otherwise be rewritten into each other.
  externalId String?

  @@unique([personId, externalId])
```

- [ ] **Step 3: Write the migration SQL**

Create `packages/db/prisma/migrations/20260925000000_person_sources/migration.sql`:

```sql
-- The HR feed: a source family that reads persons and contracts.
--
-- Separate from DirectorySource because a person is not a user, a group or an
-- org unit, and because SourceConnector has no write path -- the four
-- write-back flags a directory source carries would be permanently false here.

CREATE TABLE "PersonSource" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "secretName" TEXT NOT NULL,
    "feedMode" TEXT NOT NULL,
    "schedule" TEXT,
    "autoApply" BOOLEAN NOT NULL DEFAULT false,
    "deactivationThresholdPercent" INTEGER NOT NULL DEFAULT 10,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PersonSource_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PersonSource_tenantId_name_key" ON "PersonSource"("tenantId", "name");
CREATE INDEX "PersonSource_tenantId_idx" ON "PersonSource"("tenantId");

-- No default in the column either. A NOT NULL with no default forces every
-- writer to state it, which is the point: reading a delta file as a snapshot
-- departs everyone who did not change yesterday.
ALTER TABLE "PersonSource" ADD CONSTRAINT person_source_feed_mode_known
  CHECK ("feedMode" IN ('snapshot', 'delta'));

CREATE TABLE "PersonFieldMapping" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "recordType" TEXT NOT NULL,
    "sourceColumn" TEXT NOT NULL,
    "targetField" TEXT NOT NULL,
    "transform" TEXT NOT NULL DEFAULT 'none',
    "isCorrelation" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "PersonFieldMapping_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PersonFieldMapping_sourceId_recordType_targetField_key"
  ON "PersonFieldMapping"("sourceId", "recordType", "targetField");
CREATE INDEX "PersonFieldMapping_tenantId_idx" ON "PersonFieldMapping"("tenantId");

ALTER TABLE "PersonFieldMapping" ADD CONSTRAINT person_field_mapping_record_type_known
  CHECK ("recordType" IN ('person', 'contract'));

CREATE TABLE "PersonImportRun" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "recordsRead" INTEGER NOT NULL DEFAULT 0,
    "requiresConfirmation" BOOLEAN NOT NULL DEFAULT false,
    "blockedReason" TEXT,
    "error" TEXT,
    "mappingFailures" INTEGER NOT NULL DEFAULT 0,
    "mappingFailureReasons" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "personsAbsent" INTEGER NOT NULL DEFAULT 0,
    "confirmedBy" UUID,

    CONSTRAINT "PersonImportRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PersonImportRun_tenantId_startedAt_idx" ON "PersonImportRun"("tenantId", "startedAt");
CREATE INDEX "PersonImportRun_sourceId_idx" ON "PersonImportRun"("sourceId");

CREATE TABLE "PersonImportChange" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "changeType" TEXT NOT NULL,
    "recordType" TEXT NOT NULL,
    "targetId" UUID,
    "externalId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "message" TEXT,

    CONSTRAINT "PersonImportChange_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PersonImportChange_tenantId_idx" ON "PersonImportChange"("tenantId");
-- Both. The console reads a run's changes by type; apply reads and counts
-- them by status. SyncChange records that the second was missing and every
-- apply sequential-scanned.
CREATE INDEX "PersonImportChange_runId_changeType_idx" ON "PersonImportChange"("runId", "changeType");
CREATE INDEX "PersonImportChange_runId_status_idx" ON "PersonImportChange"("runId", "status");

-- The seven the diff can emit. There is no delete of either kind, and an
-- eighth arriving by typo would be applied by nothing and reported as
-- proposed forever.
ALTER TABLE "PersonImportChange" ADD CONSTRAINT person_import_change_type_known
  CHECK ("changeType" IN (
    'create_person', 'update_person', 'depart_person', 'reactivate_person',
    'create_contract', 'update_contract', 'end_contract'));

ALTER TABLE "PersonFieldMapping"
  ADD CONSTRAINT "PersonFieldMapping_sourceId_fkey"
  FOREIGN KEY ("sourceId") REFERENCES "PersonSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PersonImportRun"
  ADD CONSTRAINT "PersonImportRun_sourceId_fkey"
  FOREIGN KEY ("sourceId") REFERENCES "PersonSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PersonImportChange"
  ADD CONSTRAINT "PersonImportChange_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "PersonImportRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Ownership of a person row.
--
-- RESTRICT, not SET NULL: a person whose source has gone is not a
-- hand-managed person, they are a person nothing feeds. deletePersonSource
-- deactivates and detaches them explicitly, in the same transaction as the
-- delete, so releasing them is an act of the code and not only of the schema.
ALTER TABLE "Person" ADD COLUMN "sourceId" UUID;
ALTER TABLE "Person" ADD COLUMN "statusReason" TEXT;
ALTER TABLE "Person"
  ADD CONSTRAINT "Person_sourceId_fkey"
  FOREIGN KEY ("sourceId") REFERENCES "PersonSource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "Person_sourceId_idx" ON "Person"("sourceId");

-- The HR system's own employment id. Nullable: a file that carries none falls
-- back to matching on sequence, which the mapping screen warns about.
ALTER TABLE "Contract" ADD COLUMN "externalId" TEXT;
CREATE UNIQUE INDEX "Contract_personId_externalId_key" ON "Contract"("personId", "externalId");

-- Row-level security.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['PersonSource', 'PersonFieldMapping', 'PersonImportRun', 'PersonImportChange'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid) WITH CHECK ("tenantId" = NULLIF(current_setting(''app.current_tenant'', true), '''')::uuid)',
      t);
  END LOOP;
END $$;
```

- [ ] **Step 4: Generate the client and apply the migration**

Run: `pnpm db:up && pnpm db:migrate && pnpm db:generate`
Expected: migration applies cleanly; `PrismaClient` gains `personSource`, `personFieldMapping`, `personImportRun`, `personImportChange`.

- [ ] **Step 5: Verify the schema matches the migration**

Run: `pnpm --filter @syntra/db exec prisma migrate diff --from-schema-datamodel prisma/schema.prisma --to-schema-datasource prisma/schema.prisma --exit-code`
Expected: exit code 0 — no drift between `schema.prisma` and the applied database.

- [ ] **Step 6: Commit**

```bash
git add packages/db/prisma/schema.prisma packages/db/prisma/migrations/20260925000000_person_sources
git commit -m "feat(db): tables for a person source, its mappings and its runs"
```

---

## Task 2: The delimited parser

A pure function of a string. No transport, no I/O, no database. This is where every CSV edge case is settled, and it must never smooth an empty file into "no changes".

**Files:**
- Create: `packages/connectors/src/person/delimited.ts`
- Test: `packages/connectors/src/person/delimited.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface DelimitedOptions { delimiter: string; quoteChar: string; hasHeaderRow: boolean; maxRows: number }`
  - `interface DelimitedTable { columns: string[]; rows: Record<string, string>[] }`
  - `function readDelimited(text: string, options: DelimitedOptions): DelimitedTable`
  - `class RowCeilingExceededError extends Error` with `readonly maxRows: number`

- [ ] **Step 1: Write the failing tests**

Create `packages/connectors/src/person/delimited.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { RowCeilingExceededError, readDelimited } from './delimited.js';

const options = { delimiter: ',', quoteChar: '"', hasHeaderRow: true, maxRows: 1000 };

describe('readDelimited', () => {
  it('reads a header and one row', () => {
    const table = readDelimited('id,name\n1,Ada', options);
    expect(table.columns).toEqual(['id', 'name']);
    expect(table.rows).toEqual([{ id: '1', name: 'Ada' }]);
  });

  it('keeps a delimiter that sits inside quotes', () => {
    const table = readDelimited('id,name\n1,"Lovelace, Ada"', options);
    expect(table.rows[0]?.name).toBe('Lovelace, Ada');
  });

  it('keeps a newline that sits inside quotes', () => {
    const table = readDelimited('id,note\n1,"two\nlines"', options);
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]?.note).toBe('two\nlines');
  });

  it('reads a doubled quote as one literal quote', () => {
    const table = readDelimited('id,name\n1,"a ""b"" c"', options);
    expect(table.rows[0]?.name).toBe('a "b" c');
  });

  it('strips a UTF-8 BOM from the first column name', () => {
    const table = readDelimited('﻿id,name\n1,Ada', options);
    expect(table.columns).toEqual(['id', 'name']);
  });

  it('reads CRLF line endings', () => {
    const table = readDelimited('id,name\r\n1,Ada\r\n', options);
    expect(table.rows).toEqual([{ id: '1', name: 'Ada' }]);
  });

  it('ignores a trailing blank line', () => {
    const table = readDelimited('id,name\n1,Ada\n\n', options);
    expect(table.rows).toHaveLength(1);
  });

  /**
   * A short row is padded rather than rejected. An HR export that omits
   * trailing empty cells is ordinary, and rejecting it would fail the whole
   * run over formatting rather than content.
   */
  it('pads a row with fewer cells than the header', () => {
    const table = readDelimited('id,name,dept\n1,Ada', options);
    expect(table.rows[0]).toEqual({ id: '1', name: 'Ada', dept: '' });
  });

  /**
   * A long row is NOT padded away -- the extra cells have no column name, so
   * silently dropping them loses data the file carried and nobody is told.
   */
  it('refuses a row with more cells than the header', () => {
    expect(() => readDelimited('id,name\n1,Ada,extra', options)).toThrow(
      /row 2 has 3 cells but the header has 2/,
    );
  });

  it('refuses a duplicate column name', () => {
    expect(() => readDelimited('id,id\n1,2', options)).toThrow(/duplicate column "id"/);
  });

  /**
   * The empty file reaches the run as zero rows, and the run blocks on
   * recordsRead === 0. This is the one case the parser must not smooth over.
   */
  it('returns no rows for an empty file rather than throwing', () => {
    expect(readDelimited('', options)).toEqual({ columns: [], rows: [] });
  });

  it('returns no rows for a header with no data rows', () => {
    const table = readDelimited('id,name\n', options);
    expect(table.columns).toEqual(['id', 'name']);
    expect(table.rows).toEqual([]);
  });

  it('names columns positionally when there is no header row', () => {
    const table = readDelimited('1,Ada', { ...options, hasHeaderRow: false });
    expect(table.columns).toEqual(['column1', 'column2']);
    expect(table.rows[0]).toEqual({ column1: '1', column2: 'Ada' });
  });

  it('throws rather than truncating when the row ceiling is reached', () => {
    const text = ['id', '1', '2', '3'].join('\n');
    expect(() => readDelimited(text, { ...options, maxRows: 2 })).toThrow(
      RowCeilingExceededError,
    );
  });

  it('honours a tab delimiter', () => {
    const table = readDelimited('id\tname\n1\tAda', { ...options, delimiter: '\t' });
    expect(table.rows[0]).toEqual({ id: '1', name: 'Ada' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/connectors/src/person/delimited.test.ts`
Expected: FAIL — "Cannot find module './delimited.js'".

- [ ] **Step 3: Write the parser**

Create `packages/connectors/src/person/delimited.ts`:

```ts
/**
 * A delimited file, parsed.
 *
 * A character-by-character scanner rather than `split`, because a delimiter
 * inside quotes and a newline inside quotes are both ordinary in an HR export
 * and `split` gets each of them wrong in a way that shifts every subsequent
 * column by one. A shifted column maps a department into a job title, and the
 * diff proposes it as a real change on every row in the file.
 *
 * Pure, and separate from transport, so every case below is testable with a
 * string and no server -- and so a later `localFile` or `httpJson` person
 * source reuses it unchanged.
 */

export interface DelimitedOptions {
  delimiter: string;
  quoteChar: string;
  hasHeaderRow: boolean;
  /** A ceiling that throws. See `RowCeilingExceededError`. */
  maxRows: number;
}

export interface DelimitedTable {
  columns: string[];
  rows: Record<string, string>[];
}

/**
 * Thrown, never returned, and never a truncated table.
 *
 * A file that exceeded the ceiling has been read in part, and a part read that
 * a caller could mistake for a whole one is the input that departs a
 * workforce: every unread person is absent, and absence departs people.
 */
export class RowCeilingExceededError extends Error {
  constructor(readonly maxRows: number) {
    super(`the file has more than ${maxRows} rows, which is this source's limit`);
    this.name = 'RowCeilingExceededError';
  }
}

/** Splits into records, honouring quotes around delimiters and newlines. */
function scan(text: string, delimiter: string, quote: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let cell = '';
  let quoted = false;
  let i = 0;

  const endCell = () => {
    record.push(cell);
    cell = '';
  };
  const endRecord = () => {
    endCell();
    records.push(record);
    record = [];
  };

  while (i < text.length) {
    const char = text[i] as string;

    if (quoted) {
      if (char === quote) {
        // A doubled quote inside a quoted cell is one literal quote.
        if (text[i + 1] === quote) {
          cell += quote;
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      cell += char;
      i += 1;
      continue;
    }

    if (char === quote && cell === '') {
      quoted = true;
      i += 1;
      continue;
    }
    if (char === delimiter) {
      endCell();
      i += 1;
      continue;
    }
    if (char === '\r' && text[i + 1] === '\n') {
      endRecord();
      i += 2;
      continue;
    }
    if (char === '\n' || char === '\r') {
      endRecord();
      i += 1;
      continue;
    }
    cell += char;
    i += 1;
  }

  // A file not ending in a newline still has a final record; one that does
  // ends with an empty cell that is not a record.
  if (cell !== '' || record.length > 0) endRecord();

  // A blank line is not a row. This drops the trailing one and any interior
  // ones, which an HR export routinely carries.
  return records.filter((r) => !(r.length === 1 && r[0] === ''));
}

export function readDelimited(
  text: string,
  options: DelimitedOptions,
): DelimitedTable {
  // The BOM belongs to the file, not to the first column's name. Left in
  // place it makes `externalId` fail to match a mapping that names it, and
  // the failure is invisible because the two strings print identically.
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const records = scan(body, options.delimiter, options.quoteChar);
  if (records.length === 0) return { columns: [], rows: [] };

  const first = records[0] as string[];
  const columns = options.hasHeaderRow
    ? first.map((c) => c.trim())
    : first.map((_, index) => `column${index + 1}`);

  const seen = new Set<string>();
  for (const column of columns) {
    if (seen.has(column)) {
      throw new Error(
        `duplicate column "${column}": a mapping naming it could read either`,
      );
    }
    seen.add(column);
  }

  const dataRecords = options.hasHeaderRow ? records.slice(1) : records;
  if (dataRecords.length > options.maxRows) {
    throw new RowCeilingExceededError(options.maxRows);
  }

  const rows = dataRecords.map((record, index) => {
    if (record.length > columns.length) {
      // The line number an operator sees, counting the header.
      const line = options.hasHeaderRow ? index + 2 : index + 1;
      throw new Error(
        `row ${line} has ${record.length} cells but the header has ` +
          `${columns.length}; the extra cells name no column`,
      );
    }
    const row: Record<string, string> = {};
    columns.forEach((column, position) => {
      row[column] = record[position] ?? '';
    });
    return row;
  });

  return { columns, rows };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/connectors/src/person/delimited.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/connectors/src/person/delimited.ts packages/connectors/src/person/delimited.test.ts
git commit -m "feat(connectors): parse a delimited file, refusing what it cannot represent"
```

---

## Task 3: The `SourceConnector` interface and its registry

**Files:**
- Create: `packages/connectors/src/person/types.ts`
- Create: `packages/connectors/src/person/registry.ts`
- Test: `packages/connectors/src/person/registry.test.ts`
- Modify: `packages/connectors/src/index.ts`

**Interfaces:**
- Consumes: `sftpDelimitedConnector` and `sftpDelimitedConfigSchema` from Task 5 — registered there, so this task registers an empty record and Task 5 fills it. To keep the tasks independently testable, this task's registry is written against a `PERSON_SOURCE_TYPES` of `['sftpDelimited']` and imports from `./sftp/connector.js`; **do Task 5 before running this task's tests**, or stub as the step below describes.
- Produces:
  - `PersonSnapshotRecord`, `ContractSnapshot`, `SourceConnectionResult`, `SourceConnector<C>`
  - `PERSON_SOURCE_TYPES`, `PersonSourceType`, `UnknownPersonSourceTypeError`
  - `personSourceConnectorFor(type: string): SourceConnector<never>`
  - `personSourceConfigSchemaFor(type: string): z.ZodTypeAny`

- [ ] **Step 1: Write the types**

Create `packages/connectors/src/person/types.ts`:

```ts
/**
 * One employment or engagement, as the source presented it.
 *
 * Every field is a string because a delimited file has no types. Parsing
 * `startDate` into a Date happens in `@syntra/core`'s mapping layer, where a
 * bad value becomes a mapping failure against a named person rather than an
 * exception that fails the whole read.
 */
export interface ContractSnapshot {
  /** The HR system's own employment id. See `Contract.externalId`. */
  externalId?: string;
  sequence?: number;
  isPrimary?: boolean;
  startDate: string;
  endDate?: string;
  jobTitle?: string;
  department?: string;
  costCentre?: string;
  employer?: string;
  location?: string;
  managerExternalId?: string;
  fte?: string;
}

/**
 * One person and their contracts, read as one unit.
 *
 * Together or not at all: a person imported without their contracts has no
 * department, no start date and no manager, and the placement ladder and every
 * business rule would read that as true rather than as missing.
 *
 * Values are single strings, unlike `SourceRecord.attributes`. That type uses
 * arrays because LDAP returns arrays regardless of what the schema claims; a
 * delimited file has one value per cell, and pretending otherwise would push
 * the unwrapping into every consumer.
 */
export interface PersonSnapshotRecord {
  /** The anchor. Correlates to `Person.externalId`. */
  externalId: string;
  fields: Record<string, string>;
  contracts: ContractSnapshot[];
  /**
   * Set when the source returned this person but the connector could not read
   * them completely enough to diff against safely.
   *
   * The record is still returned rather than dropped, because the difference
   * between "this person is gone" and "we could not read this person" is the
   * difference between a correct departure and a catastrophic one. A reader
   * seeing this must count the record as read, exclude it from the diff, and
   * never treat it as absent.
   */
  readFailure?: string;
}

/**
 * What a person source's `test` reports back.
 *
 * Deliberately not `ConnectionResult`. That type carries `sampleCounts` keyed
 * by `ObjectType` and `rights` describing what a bind may write, and neither
 * means anything for a read-only person source. What the console needs from a
 * test here is the column names to map against and the host key to confirm.
 */
export interface SourceConnectionResult {
  ok: boolean;
  message: string;
  /** Column names as the file presents them. Drives the mapping editor. */
  columns?: string[];
  recordsSampled?: number;
  /**
   * The key the server presented, and how it compares to what is stored.
   *
   * Three-valued, not a boolean, and on the result rather than thrown: an
   * unknown key on a first test is the ordinary path -- it is how a
   * fingerprint is obtained -- while a mismatch is a failure that sets
   * `ok: false` and offers no accept action. Collapsing the two would make
   * accepting a changed key one click away from accepting a first one.
   */
  hostKey?: {
    fingerprint: string;
    status: 'matched' | 'unknown' | 'mismatch';
  };
}

/**
 * A system Syntra reads persons from.
 *
 * Much smaller than `Connector<C>`, and the omissions are the design. There is
 * no `write`, no `discoverSchema` and no `SourceWriteback`: an HR system is
 * authoritative, Syntra reads it and never writes to it, and an interface with
 * no write path enforces that rather than asking a docstring to.
 *
 * **`read` yields every record the source holds, or throws.** There is no
 * third outcome and no partial-success return value, because a partial read a
 * caller could mistake for a complete one is the input that departs a
 * workforce. Ceilings throw when reached rather than ending the iteration, and
 * a transport error mid-stream propagates. Per-record incompleteness has its
 * own channel -- `readFailure` -- which is a statement about one person and
 * never about the file.
 */
export interface SourceConnector<C> {
  test(config: C): Promise<SourceConnectionResult>;
  read(config: C): AsyncIterable<PersonSnapshotRecord>;
}
```

- [ ] **Step 2: Write the failing registry test**

Create `packages/connectors/src/person/registry.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  PERSON_SOURCE_TYPES,
  UnknownPersonSourceTypeError,
  personSourceConfigSchemaFor,
  personSourceConnectorFor,
} from './registry.js';

describe('the person source registry', () => {
  it('resolves every type it claims to know', () => {
    for (const type of PERSON_SOURCE_TYPES) {
      expect(personSourceConnectorFor(type)).toBeDefined();
      expect(personSourceConfigSchemaFor(type)).toBeDefined();
    }
  });

  it('refuses an unknown type by name, listing what it knows', () => {
    expect(() => personSourceConnectorFor('workday')).toThrow(
      UnknownPersonSourceTypeError,
    );
    expect(() => personSourceConnectorFor('workday')).toThrow(/sftpDelimited/);
  });

  /**
   * The registry is a lookup, not a plugin loader. A type that resolves to a
   * connector but not to a schema would accept any configuration at all.
   */
  it('refuses an unknown type on the schema lookup too', () => {
    expect(() => personSourceConfigSchemaFor('workday')).toThrow(
      UnknownPersonSourceTypeError,
    );
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm vitest run packages/connectors/src/person/registry.test.ts`
Expected: FAIL — "Cannot find module './registry.js'".

- [ ] **Step 4: Write the registry**

Create `packages/connectors/src/person/registry.ts`:

```ts
import type { z } from 'zod';
import type { SourceConnector } from './types.js';
import { sftpDelimitedConnector } from './sftp/connector.js';
import { sftpDelimitedConfigSchema } from './sftp/config.js';

/**
 * Every `PersonSource.type` this package can read.
 *
 * A plain lookup, for the reason `registry.ts` gives for target connectors: a
 * second family needs no migration of the database column, and adding one is
 * one more entry in each of the two records below rather than a new mechanism.
 */
export const PERSON_SOURCE_TYPES = ['sftpDelimited'] as const;
export type PersonSourceType = (typeof PERSON_SOURCE_TYPES)[number];

export class UnknownPersonSourceTypeError extends Error {
  constructor(readonly type: string) {
    super(
      `no person source connector implements type "${type}"; known types are ` +
        PERSON_SOURCE_TYPES.join(', '),
    );
    this.name = 'UnknownPersonSourceTypeError';
  }
}

/**
 * Type-erased to `never` for the reason the target registry records: each
 * connector's real `Config` differs, and this map exists precisely so a caller
 * can select one by `PersonSource.type` at runtime, when no static type can
 * name which one it will get.
 */
const CONNECTORS: Record<PersonSourceType, SourceConnector<never>> = {
  sftpDelimited: sftpDelimitedConnector as unknown as SourceConnector<never>,
};

const CONFIG_SCHEMAS: Record<PersonSourceType, z.ZodTypeAny> = {
  sftpDelimited: sftpDelimitedConfigSchema,
};

function isKnownType(type: string): type is PersonSourceType {
  return (PERSON_SOURCE_TYPES as readonly string[]).includes(type);
}

export function personSourceConnectorFor(type: string): SourceConnector<never> {
  if (!isKnownType(type)) throw new UnknownPersonSourceTypeError(type);
  return CONNECTORS[type];
}

export function personSourceConfigSchemaFor(type: string): z.ZodTypeAny {
  if (!isKnownType(type)) throw new UnknownPersonSourceTypeError(type);
  return CONFIG_SCHEMAS[type];
}
```

- [ ] **Step 5: Export from the package root**

Add to `packages/connectors/src/index.ts`, after the existing `registry.js` line:

```ts
export * from './person/types.js';
export * from './person/delimited.js';
export * from './person/registry.js';
export * from './person/sftp/config.js';
export * from './person/sftp/connector.js';
```

- [ ] **Step 6: Run the tests (after Task 5 exists)**

Run: `pnpm vitest run packages/connectors/src/person/registry.test.ts`
Expected: PASS, 3 tests.

If executing tasks strictly in order, this step fails on the missing `./sftp/connector.js` until Task 5 lands. That is expected and is the only forward reference in the plan; complete Task 5, then return and run this step.

- [ ] **Step 7: Commit**

```bash
git add packages/connectors/src/person/types.ts packages/connectors/src/person/registry.ts packages/connectors/src/person/registry.test.ts packages/connectors/src/index.ts
git commit -m "feat(connectors): a read-only source connector interface and its registry"
```

---

## Task 4: `FakePersonSource`

**Files:**
- Create: `packages/connectors/src/testing/fake-person-source.ts`
- Test: `packages/connectors/src/testing/fake-person-source.test.ts`
- Modify: `packages/connectors/src/testing/index.ts`

**Interfaces:**
- Consumes: `SourceConnector`, `PersonSnapshotRecord`, `SourceConnectionResult` (Task 3).
- Produces:
  - `class FakePersonSource implements SourceConnector<FakePersonSourceConfig>`
  - `interface FakePersonSourceConfig { sourceId: string }`
  - constructor `(records: PersonSnapshotRecord[], opts?: { failWith?: Error; columns?: string[] })`
  - `readonly reads: number`

- [ ] **Step 1: Write the failing test**

Create `packages/connectors/src/testing/fake-person-source.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { FakePersonSource } from './fake-person-source.js';

const config = { sourceId: 'src-1' };

function record(externalId: string) {
  return { externalId, fields: { givenName: 'Ada' }, contracts: [] };
}

describe('FakePersonSource', () => {
  it('yields the records it was given, in order', async () => {
    const fake = new FakePersonSource([record('1'), record('2')]);
    const seen: string[] = [];
    for await (const r of fake.read(config)) seen.push(r.externalId);
    expect(seen).toEqual(['1', '2']);
  });

  it('counts reads, so a test can assert a run read once', async () => {
    const fake = new FakePersonSource([record('1')]);
    for await (const _ of fake.read(config)) void _;
    for await (const _ of fake.read(config)) void _;
    expect(fake.reads).toBe(2);
  });

  /**
   * The incomplete read has to be expressible, because it is the case the
   * whole absence rule turns on: a throw mid-stream must fail the run, never
   * produce a short snapshot the diff treats as complete.
   */
  it('throws mid-stream when told to, after yielding what came before', async () => {
    const fake = new FakePersonSource([record('1')], {
      failWith: new Error('connection reset'),
    });
    const seen: string[] = [];
    await expect(async () => {
      for await (const r of fake.read(config)) seen.push(r.externalId);
    }).rejects.toThrow('connection reset');
    expect(seen).toEqual(['1']);
  });

  it('reports ok from test, with the columns it was given', async () => {
    const fake = new FakePersonSource([], { columns: ['id', 'name'] });
    const result = await fake.test(config);
    expect(result.ok).toBe(true);
    expect(result.columns).toEqual(['id', 'name']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run packages/connectors/src/testing/fake-person-source.test.ts`
Expected: FAIL — "Cannot find module './fake-person-source.js'".

- [ ] **Step 3: Write the fake**

Create `packages/connectors/src/testing/fake-person-source.ts`:

```ts
import type {
  PersonSnapshotRecord,
  SourceConnectionResult,
  SourceConnector,
} from '../person/types.js';

export interface FakePersonSourceConfig {
  sourceId: string;
}

/**
 * A person source that reads from an array.
 *
 * Reachable only through `@syntra/connectors/testing`, for the reason that
 * entry point's header gives: a fake reachable from production code is a fake
 * that will eventually be reached.
 *
 * `failWith` exists to express the one case the absence rule turns on -- a
 * read that gives out partway. The records before the failure are yielded and
 * then the error propagates, which is exactly what a dropped SFTP connection
 * does, and what the run must treat as a failure rather than as a snapshot in
 * which everyone unread is absent.
 */
export class FakePersonSource implements SourceConnector<FakePersonSourceConfig> {
  reads = 0;

  constructor(
    private readonly records: PersonSnapshotRecord[],
    private readonly opts: { failWith?: Error; columns?: string[] } = {},
  ) {}

  async test(): Promise<SourceConnectionResult> {
    return {
      ok: true,
      message: `read ${this.records.length} records`,
      columns: this.opts.columns ?? [],
      recordsSampled: this.records.length,
    };
  }

  async *read(): AsyncIterable<PersonSnapshotRecord> {
    this.reads += 1;
    for (const record of this.records) yield record;
    if (this.opts.failWith) throw this.opts.failWith;
  }
}
```

- [ ] **Step 4: Export it from the testing entry point**

Add to `packages/connectors/src/testing/index.ts`, beside `export * from './fake-target.js';`:

```ts
export * from './fake-person-source.js';
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run packages/connectors/src/testing/fake-person-source.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/connectors/src/testing/fake-person-source.ts packages/connectors/src/testing/fake-person-source.test.ts packages/connectors/src/testing/index.ts
git commit -m "test(connectors): a person source that reads from an array and can give out partway"
```

---

## Task 5: The SFTP transport and the `sftpDelimited` connector

The security-carrying task. Host-key pinning is mandatory and the connection is pinned to the address that was checked.

**Files:**
- Create: `packages/connectors/src/person/sftp/config.ts`
- Create: `packages/connectors/src/person/sftp/transport.ts`
- Create: `packages/connectors/src/person/sftp/connector.ts`
- Test: `packages/connectors/src/person/sftp/transport.test.ts`
- Test: `packages/connectors/src/person/sftp/connector.test.ts`
- Modify: `packages/connectors/package.json` (add `ssh2`, `@types/ssh2`)

**Interfaces:**
- Consumes: `readDelimited`, `RowCeilingExceededError` (Task 2); `PersonSnapshotRecord`, `SourceConnectionResult`, `SourceConnector` (Task 3); `classifyAddress` from `../../net/outbound.js`.
- Produces:
  - `sftpDelimitedConfigSchema`, `type SftpDelimitedConfig`
  - `type SftpDelimitedCredential = { privateKey: string } | { password: string }`
  - `fingerprintOf(key: Buffer): string` — `SHA256:` + base64, no padding, as OpenSSH prints it
  - `compareHostKey(presented: string, stored: string | undefined): 'matched' | 'unknown' | 'mismatch'`
  - `assertAddressAllowed(host: string, allowPrivate: boolean): Promise<string>` — returns the literal address to connect to
  - `sftpDelimitedConnector: SourceConnector<SftpDelimitedConfig & SftpDelimitedCredential>`

- [ ] **Step 1: Add the dependency**

In `packages/connectors/package.json`, add to `dependencies`: `"ssh2": "^1.16.0"`, and to `devDependencies`: `"@types/ssh2": "^1.15.1"`.

Run: `pnpm install`
Expected: `ssh2` resolves; no peer warnings that fail the install.

We take `ssh2` directly rather than `ssh2-sftp-client`: we need the `hostVerifier` callback and connection-level control the wrapper obscures, and we use a small fraction of its surface.

- [ ] **Step 2: Write the config schema**

Create `packages/connectors/src/person/sftp/config.ts`:

```ts
import { z } from 'zod';

/**
 * A delimited export fetched over SFTP.
 *
 * `hostKeyFingerprint` is optional in the schema and mandatory at run time:
 * a source is saved before it has one -- `test` is how a fingerprint is
 * obtained -- but `read` refuses without it. Making it required here would
 * mean the only way to create a source is to already know the answer to the
 * question `test` exists to ask.
 */
export const sftpDelimitedConfigSchema = z
  .object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535).default(22),
    username: z.string().min(1),
    /** A path, or a glob that must resolve to exactly one file. */
    remotePath: z.string().min(1),
    delimiter: z.string().min(1).max(1).default(','),
    quoteChar: z.string().min(1).max(1).default('"'),
    encoding: z.enum(['utf8', 'latin1']).default('utf8'),
    hasHeaderRow: z.boolean().default(true),
    hostKeyFingerprint: z.string().optional(),
    maxBytes: z.number().int().positive().default(52_428_800),
    maxRows: z.number().int().positive().default(200_000),
  })
  .strict();

export type SftpDelimitedConfig = z.infer<typeof sftpDelimitedConfigSchema>;

/** Read from the vault, never stored in `config`. */
export type SftpDelimitedCredential =
  | { privateKey: string; passphrase?: string }
  | { password: string };
```

- [ ] **Step 3: Write the failing transport tests**

Create `packages/connectors/src/person/sftp/transport.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { compareHostKey, fingerprintOf, assertAddressAllowed } from './transport.js';

describe('fingerprintOf', () => {
  it('prints a SHA256 fingerprint the way OpenSSH does', () => {
    // Empty key: SHA-256 of no bytes, base64, padding stripped.
    expect(fingerprintOf(Buffer.from(''))).toBe(
      'SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU',
    );
  });
});

describe('compareHostKey', () => {
  it('reports unknown when nothing is stored', () => {
    expect(compareHostKey('SHA256:aaa', undefined)).toBe('unknown');
  });

  it('reports matched when the stored key is the presented one', () => {
    expect(compareHostKey('SHA256:aaa', 'SHA256:aaa')).toBe('matched');
  });

  /**
   * The state that must never be one click from `unknown`. A key that changed
   * is a rebuilt server or an interception, and only one of those is safe.
   */
  it('reports mismatch when a different key is stored', () => {
    expect(compareHostKey('SHA256:bbb', 'SHA256:aaa')).toBe('mismatch');
  });
});

describe('assertAddressAllowed', () => {
  it('refuses a name that resolves into a blocked range', async () => {
    await expect(assertAddressAllowed('localhost', false)).rejects.toThrow(
      /resolves to an address this deployment refuses to connect to/,
    );
  });

  it('returns the literal address when private addresses are allowed', async () => {
    await expect(assertAddressAllowed('localhost', true)).resolves.toMatch(
      /^(127\.0\.0\.1|::1)$/,
    );
  });
});
```

- [ ] **Step 4: Run them to verify they fail**

Run: `pnpm vitest run packages/connectors/src/person/sftp/transport.test.ts`
Expected: FAIL — "Cannot find module './transport.js'".

- [ ] **Step 5: Write the transport**

Create `packages/connectors/src/person/sftp/transport.ts`:

```ts
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { Client, type ConnectConfig } from 'ssh2';
import { classifyAddress } from '../../net/outbound.js';
import type { SftpDelimitedConfig, SftpDelimitedCredential } from './config.js';

/** As OpenSSH prints it: `SHA256:` then base64 with the padding stripped. */
export function fingerprintOf(key: Buffer): string {
  const digest = createHash('sha256').update(key).digest('base64');
  return `SHA256:${digest.replace(/=+$/, '')}`;
}

/**
 * Three-valued, never a boolean.
 *
 * `unknown` is the ordinary first-test path and the only one the console
 * offers an accept action for. `mismatch` is a failure. A boolean would make
 * accepting a changed key the same gesture as accepting a first one.
 */
export function compareHostKey(
  presented: string,
  stored: string | undefined,
): 'matched' | 'unknown' | 'mismatch' {
  if (stored === undefined || stored === '') return 'unknown';
  return presented === stored ? 'matched' : 'mismatch';
}

/**
 * Resolves a hostname, refuses an address in a blocked range, and returns the
 * literal address to connect to.
 *
 * Returning the address rather than approving the name is the whole point.
 * `ssh2` takes a `host`, so resolving, checking, and then handing it the
 * hostname leaves the DNS-rebinding window `fetchExternalDocument` documents:
 * a name that answered publicly for the check can answer `169.254.169.254`
 * for the connection microseconds later. Connecting to the address that was
 * checked closes it.
 */
export async function assertAddressAllowed(
  host: string,
  allowPrivate: boolean,
): Promise<string> {
  const resolved = await lookup(host, { all: true });
  if (resolved.length === 0) {
    throw new Error(`"${host}" resolves to no address`);
  }
  for (const entry of resolved) {
    if (!allowPrivate && classifyAddress(entry.address) === 'blocked') {
      throw new Error(
        `"${host}" resolves to an address this deployment refuses to connect ` +
          `to (${entry.address}); set OUTBOUND_ALLOW_PRIVATE to permit it`,
      );
    }
  }
  return (resolved[0] as { address: string }).address;
}

export class HostKeyMismatchError extends Error {
  constructor(readonly presented: string, readonly stored: string) {
    super(
      `the server presented host key ${presented}, but this source is pinned ` +
        `to ${stored}; a changed key is a rebuilt server or an interception`,
    );
    this.name = 'HostKeyMismatchError';
  }
}

export class HostKeyUnknownError extends Error {
  constructor(readonly presented: string) {
    super(
      `this source has no host key pinned; test the connection and accept ` +
        `${presented} before it can run`,
    );
    this.name = 'HostKeyUnknownError';
  }
}

export class ByteCeilingExceededError extends Error {
  constructor(readonly maxBytes: number) {
    super(`the file is larger than ${maxBytes} bytes, which is this source's limit`);
    this.name = 'ByteCeilingExceededError';
  }
}

export interface FetchResult {
  text: string;
  hostKey: { fingerprint: string; status: 'matched' | 'unknown' | 'mismatch' };
}

/**
 * Connects, verifies the host key, and reads one file in full.
 *
 * `requirePinned` is the difference between `test` and `read`. `test` connects
 * with an unknown key on purpose -- that is how a fingerprint is obtained --
 * and reports it. `read` refuses, because an unpinned key at run time means
 * the schedule would accept any server that answered.
 */
export async function fetchFile(
  config: SftpDelimitedConfig & SftpDelimitedCredential,
  opts: { allowPrivate: boolean; requirePinned: boolean; maxBytes?: number },
): Promise<FetchResult> {
  const address = await assertAddressAllowed(config.host, opts.allowPrivate);
  const maxBytes = opts.maxBytes ?? config.maxBytes;

  return new Promise<FetchResult>((resolve, reject) => {
    const client = new Client();
    let hostKey: FetchResult['hostKey'] | undefined;

    const connectConfig: ConnectConfig = {
      // The literal address that was checked, never the name.
      host: address,
      port: config.port,
      username: config.username,
      ...('privateKey' in config
        ? { privateKey: config.privateKey, passphrase: config.passphrase }
        : { password: config.password }),
      // Never `() => true`. There is no trust-on-first-use here: an unknown
      // key is reported and, on `read`, refused.
      hostVerifier: (key: Buffer) => {
        const fingerprint = fingerprintOf(key);
        const status = compareHostKey(fingerprint, config.hostKeyFingerprint);
        hostKey = { fingerprint, status };
        if (status === 'mismatch') return false;
        if (status === 'unknown' && opts.requirePinned) return false;
        return true;
      },
    };

    const fail = (error: Error) => {
      client.end();
      // A rejected key surfaces from ssh2 as a generic handshake error, so the
      // specific reason is restored here from what the verifier recorded.
      if (hostKey?.status === 'mismatch') {
        reject(new HostKeyMismatchError(hostKey.fingerprint, config.hostKeyFingerprint ?? ''));
        return;
      }
      if (hostKey?.status === 'unknown' && opts.requirePinned) {
        reject(new HostKeyUnknownError(hostKey.fingerprint));
        return;
      }
      reject(error);
    };

    client.on('error', fail);

    client.on('ready', () => {
      client.sftp((sftpError, sftp) => {
        if (sftpError) return fail(sftpError);

        const stream = sftp.createReadStream(config.remotePath);
        const chunks: Buffer[] = [];
        let bytes = 0;

        stream.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            // Destroy and reject. Never resolve with what arrived: a short
            // read that looked successful is the input that departs a
            // workforce.
            stream.destroy();
            client.end();
            reject(new ByteCeilingExceededError(maxBytes));
            return;
          }
          chunks.push(chunk);
        });
        stream.on('error', fail);
        stream.on('close', () => {
          client.end();
          if (bytes > maxBytes) return;
          resolve({
            text: Buffer.concat(chunks).toString(config.encoding),
            hostKey: hostKey ?? { fingerprint: '', status: 'unknown' },
          });
        });
      });
    });

    client.connect(connectConfig);
  });
}
```

- [ ] **Step 6: Run the transport tests to verify they pass**

Run: `pnpm vitest run packages/connectors/src/person/sftp/transport.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 7: Write the connector test**

Create `packages/connectors/src/person/sftp/connector.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

const fetchFile = vi.hoisted(() => vi.fn());
vi.mock('./transport.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./transport.js')>()),
  fetchFile,
}));

const { sftpDelimitedConnector } = await import('./connector.js');
const { sftpDelimitedConfigSchema } = await import('./config.js');

const config = {
  ...sftpDelimitedConfigSchema.parse({
    host: 'hr.example.test',
    username: 'syntra',
    remotePath: '/export/people.csv',
    hostKeyFingerprint: 'SHA256:aaa',
  }),
  password: 'x',
};

const matched = { fingerprint: 'SHA256:aaa', status: 'matched' as const };

describe('sftpDelimitedConnector.test', () => {
  it('reports the columns the file carries', async () => {
    fetchFile.mockResolvedValue({
      text: 'employeeId,firstName\n1,Ada',
      hostKey: matched,
    });
    const result = await sftpDelimitedConnector.test(config);
    expect(result.ok).toBe(true);
    expect(result.columns).toEqual(['employeeId', 'firstName']);
    expect(result.hostKey).toEqual(matched);
  });

  /**
   * An unknown key is not a failure of `test` -- it is what `test` is for.
   * The console's accept action acts on exactly this result.
   */
  it('reports an unknown host key as ok:false but with a fingerprint to accept', async () => {
    fetchFile.mockRejectedValue(
      new (await import('./transport.js')).HostKeyUnknownError('SHA256:new'),
    );
    const result = await sftpDelimitedConnector.test({
      ...config,
      hostKeyFingerprint: undefined,
    });
    expect(result.ok).toBe(false);
    expect(result.hostKey).toEqual({ fingerprint: 'SHA256:new', status: 'unknown' });
  });
});

describe('sftpDelimitedConnector.read', () => {
  it('yields one record per row, with contracts attached', async () => {
    fetchFile.mockResolvedValue({
      text: 'employeeId,firstName\n1,Ada\n2,Grace',
      hostKey: matched,
    });
    const seen: string[] = [];
    for await (const record of sftpDelimitedConnector.read(config)) {
      seen.push(record.externalId);
      expect(record.contracts).toHaveLength(1);
    }
    expect(seen).toEqual(['1', '2']);
  });

  /**
   * The connector does not decide which column is the anchor -- the mapping
   * does, in core. What it yields is the row, keyed by column name, with the
   * first column standing in as the anchor only so the run has something to
   * report a mapping failure against.
   */
  it('propagates a ceiling error rather than yielding a short file', async () => {
    const { ByteCeilingExceededError } = await import('./transport.js');
    fetchFile.mockRejectedValue(new ByteCeilingExceededError(10));
    await expect(async () => {
      for await (const _ of sftpDelimitedConnector.read(config)) void _;
    }).rejects.toThrow(ByteCeilingExceededError);
  });
});
```

- [ ] **Step 8: Run it to verify it fails**

Run: `pnpm vitest run packages/connectors/src/person/sftp/connector.test.ts`
Expected: FAIL — "Cannot find module './connector.js'".

- [ ] **Step 9: Write the connector**

Create `packages/connectors/src/person/sftp/connector.ts`:

```ts
import { readDelimited } from '../delimited.js';
import type {
  PersonSnapshotRecord,
  SourceConnectionResult,
  SourceConnector,
} from '../types.js';
import type { SftpDelimitedConfig, SftpDelimitedCredential } from './config.js';
import {
  HostKeyMismatchError,
  HostKeyUnknownError,
  fetchFile,
} from './transport.js';

type Config = SftpDelimitedConfig & SftpDelimitedCredential;

const allowPrivate = (): boolean => process.env.OUTBOUND_ALLOW_PRIVATE === 'true';

/**
 * How many rows `test` reads. Enough to report the columns and prove the file
 * parses; never the whole file, which on a real export is minutes of transfer
 * for a question the operator asked about the connection.
 */
const SAMPLE_BYTES = 64 * 1024;

/**
 * The row, keyed by column name, with every cell available to a mapping.
 *
 * The connector does not decide which column is the anchor and does not build
 * contracts from several rows: one row is one person with one contract, and a
 * source whose file holds several rows per person is a second connector, not a
 * flag on this one. `externalId` here is a placeholder the run reports mapping
 * failures against -- `mapPersonRecord` in core replaces it with the mapped
 * correlation value.
 */
function toRecord(row: Record<string, string>, index: number): PersonSnapshotRecord {
  return {
    externalId: `row-${index + 1}`,
    fields: row,
    contracts: [{ startDate: '', ...({} as Record<string, never>) }],
  };
}

export const sftpDelimitedConnector: SourceConnector<Config> = {
  async test(config): Promise<SourceConnectionResult> {
    try {
      const { text, hostKey } = await fetchFile(config, {
        allowPrivate: allowPrivate(),
        requirePinned: false,
        maxBytes: SAMPLE_BYTES,
      });
      const table = readDelimited(text, {
        delimiter: config.delimiter,
        quoteChar: config.quoteChar,
        hasHeaderRow: config.hasHeaderRow,
        maxRows: config.maxRows,
      });
      return {
        ok: hostKey.status === 'matched' || hostKey.status === 'unknown',
        message:
          hostKey.status === 'unknown'
            ? 'connected, but this server’s host key is not yet pinned'
            : `read ${table.rows.length} rows and ${table.columns.length} columns`,
        columns: table.columns,
        recordsSampled: table.rows.length,
        hostKey,
      };
    } catch (cause) {
      if (cause instanceof HostKeyUnknownError) {
        return {
          ok: false,
          message: cause.message,
          hostKey: { fingerprint: cause.presented, status: 'unknown' },
        };
      }
      if (cause instanceof HostKeyMismatchError) {
        return {
          ok: false,
          message: cause.message,
          hostKey: { fingerprint: cause.presented, status: 'mismatch' },
        };
      }
      return {
        ok: false,
        message: cause instanceof Error ? cause.message : String(cause),
      };
    }
  },

  /**
   * Every record or a throw. `requirePinned: true`, so an unpinned key refuses
   * here even though `test` reports it: a schedule that accepted any server
   * that answered is not a pinned connection.
   */
  async *read(config): AsyncIterable<PersonSnapshotRecord> {
    const { text } = await fetchFile(config, {
      allowPrivate: allowPrivate(),
      requirePinned: true,
    });
    const table = readDelimited(text, {
      delimiter: config.delimiter,
      quoteChar: config.quoteChar,
      hasHeaderRow: config.hasHeaderRow,
      maxRows: config.maxRows,
    });
    for (const [index, row] of table.rows.entries()) {
      yield toRecord(row, index);
    }
  },
};
```

- [ ] **Step 10: Run the connector tests, then the package's whole suite**

Run: `pnpm vitest run packages/connectors/src/person`
Expected: PASS — `delimited`, `registry`, `transport`, `connector`.

- [ ] **Step 11: Commit**

```bash
git add packages/connectors/src/person/sftp packages/connectors/package.json pnpm-lock.yaml
git commit -m "feat(connectors): fetch an HR export over SFTP, with the host key pinned"
```

---

## Task 6: Mapping onto `Person` and `Contract`

**Files:**
- Create: `packages/core/src/person-source/mapping.ts`
- Test: `packages/core/src/person-source/mapping.test.ts`

**Interfaces:**
- Consumes: `PersonSnapshotRecord`, `ContractSnapshot` (Task 3).
- Produces:
  - `type PersonRecordType = 'person' | 'contract'`
  - `interface PersonMappingRule { recordType: PersonRecordType; sourceColumn: string; targetField: string; transform: 'none' | 'trim' | 'lowercase'; isCorrelation: boolean }`
  - `ASSIGNABLE_PERSON_FIELDS: readonly string[]`, `ASSIGNABLE_CONTRACT_FIELDS: readonly string[]`
  - `unassignablePersonFields(recordType, fields): string[]`
  - `interface MappedPerson { externalId: string; fields: Record<string, string>; contracts: MappedContract[] }`
  - `interface MappedContract { externalId: string | null; sequence: number | null; isPrimary: boolean | null; startDate: Date; endDate: Date | null; jobTitle: string | null; department: string | null; costCentre: string | null; employer: string | null; location: string | null; managerExternalId: string | null; fte: string | null }`
  - `type PersonMappingFailure = { failed: true; anchor: string; reason: string }`
  - `isPersonMappingFailure(value): value is PersonMappingFailure`
  - `mapPersonRecord(record, rules): MappedPerson | PersonMappingFailure`

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/person-source/mapping.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  ASSIGNABLE_PERSON_FIELDS,
  isPersonMappingFailure,
  mapPersonRecord,
  unassignablePersonFields,
} from './mapping.js';

const rules = [
  { recordType: 'person' as const, sourceColumn: 'employeeId', targetField: 'externalId', transform: 'trim' as const, isCorrelation: true },
  { recordType: 'person' as const, sourceColumn: 'firstName', targetField: 'givenName', transform: 'trim' as const, isCorrelation: false },
  { recordType: 'contract' as const, sourceColumn: 'hireDate', targetField: 'startDate', transform: 'none' as const, isCorrelation: false },
  { recordType: 'contract' as const, sourceColumn: 'dept', targetField: 'department', transform: 'none' as const, isCorrelation: false },
];

function record(fields: Record<string, string>) {
  return { externalId: 'row-1', fields, contracts: [] };
}

describe('the assignable field lists', () => {
  /**
   * The single most important assertion in this file. A source column an
   * administrator can point anywhere must never reach `status`: mapping it
   * would be a way to deactivate a workforce by typo, and departure has
   * exactly two legitimate sources, neither of them a mapping.
   */
  it('does not let a mapping write a person status', () => {
    expect(ASSIGNABLE_PERSON_FIELDS).not.toContain('status');
    expect(ASSIGNABLE_PERSON_FIELDS).not.toContain('statusReason');
    expect(ASSIGNABLE_PERSON_FIELDS).not.toContain('departureOverride');
    expect(unassignablePersonFields('person', ['status'])).toEqual(['status']);
  });

  it('does not let a mapping write identity or ownership', () => {
    expect(unassignablePersonFields('person', ['id', 'tenantId', 'sourceId'])).toEqual([
      'id',
      'tenantId',
      'sourceId',
    ]);
  });
});

describe('mapPersonRecord', () => {
  it('maps person fields and builds one contract', () => {
    const mapped = mapPersonRecord(
      record({ employeeId: ' 42 ', firstName: 'Ada', hireDate: '2026-01-05', dept: 'Research' }),
      rules,
    );
    if (isPersonMappingFailure(mapped)) throw new Error(mapped.reason);
    expect(mapped.externalId).toBe('42');
    expect(mapped.fields.givenName).toBe('Ada');
    expect(mapped.contracts[0]?.startDate).toEqual(new Date('2026-01-05T00:00:00Z'));
    expect(mapped.contracts[0]?.department).toBe('Research');
  });

  it('fails a record whose correlation column is empty', () => {
    const mapped = mapPersonRecord(record({ employeeId: '  ', firstName: 'Ada' }), rules);
    expect(isPersonMappingFailure(mapped)).toBe(true);
  });

  it('fails a record whose correlation column is absent entirely', () => {
    const mapped = mapPersonRecord(record({ firstName: 'Ada' }), rules);
    expect(isPersonMappingFailure(mapped)).toBe(true);
  });

  /**
   * Date.parse accepts 2026-02-30 and rolls it into March. A contract whose
   * start date silently moved a month is worse than one that failed.
   */
  it('fails a record whose start date is not a real day', () => {
    const mapped = mapPersonRecord(
      record({ employeeId: '42', hireDate: '2026-02-30' }),
      rules,
    );
    expect(isPersonMappingFailure(mapped)).toBe(true);
    if (isPersonMappingFailure(mapped)) expect(mapped.reason).toMatch(/2026-02-30/);
  });

  it('fails a record with no start date, since a contract needs one', () => {
    const mapped = mapPersonRecord(record({ employeeId: '42', firstName: 'Ada' }), rules);
    expect(isPersonMappingFailure(mapped)).toBe(true);
  });

  /**
   * A readFailure record is passed through as a failure rather than mapped.
   * The run counts it as read and excludes it -- it is never absent.
   */
  it('fails a record the connector could not read completely', () => {
    const mapped = mapPersonRecord(
      { externalId: 'row-1', fields: { employeeId: '42' }, contracts: [], readFailure: 'truncated' },
      rules,
    );
    expect(isPersonMappingFailure(mapped)).toBe(true);
    if (isPersonMappingFailure(mapped)) expect(mapped.reason).toMatch(/truncated/);
  });

  it('lowercases where the rule says to', () => {
    const mapped = mapPersonRecord(
      record({ employeeId: '42', firstName: 'ADA', hireDate: '2026-01-05' }),
      [...rules, { recordType: 'person' as const, sourceColumn: 'firstName', targetField: 'businessEmail', transform: 'lowercase' as const, isCorrelation: false }],
    );
    if (isPersonMappingFailure(mapped)) throw new Error(mapped.reason);
    expect(mapped.fields.businessEmail).toBe('ada');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run packages/core/src/person-source/mapping.test.ts`
Expected: FAIL — "Cannot find module './mapping.js'".

- [ ] **Step 3: Write the mapping**

Create `packages/core/src/person-source/mapping.ts`:

```ts
import type { PersonSnapshotRecord } from '@syntra/connectors';

export type PersonRecordType = 'person' | 'contract';

export interface PersonMappingRule {
  recordType: PersonRecordType;
  sourceColumn: string;
  targetField: string;
  transform: 'none' | 'trim' | 'lowercase';
  isCorrelation: boolean;
}

/**
 * The fields a mapping may write on a Person.
 *
 * `status` and `statusReason` are absent, and that absence is the control.
 * `sync/mapping.ts` makes the argument for `User.status` and it holds harder
 * here: a source column an administrator can point at anything is a way to
 * deactivate a workforce by typo, the guard counts only `depart_person`, and
 * an `update_person` writing `status` would be a straight bypass of it.
 * Departure has exactly two legitimate sources -- a contract `endDate` and
 * `departureOverride` -- and neither is a mapping.
 *
 * `departureOverride` is absent for its own reason: it means a human knew
 * something the contract table did not, and `departureDate()` prefers it over
 * contract dates because of that. A file cannot know it.
 *
 * `id`, `tenantId` and `sourceId` are identity and ownership; a source that
 * could write them could adopt rows belonging to another source. `externalId`
 * is the anchor, set once at source creation and not a field that moves.
 */
export const ASSIGNABLE_PERSON_FIELDS: readonly string[] = [
  'givenName',
  'familyName',
  'nameConvention',
  'businessEmail',
  'personalEmail',
];

export const ASSIGNABLE_CONTRACT_FIELDS: readonly string[] = [
  'externalId',
  'sequence',
  'isPrimary',
  'startDate',
  'endDate',
  'jobTitle',
  'department',
  'costCentre',
  'employer',
  'location',
  'managerExternalId',
  'fte',
];

export function unassignablePersonFields(
  recordType: PersonRecordType,
  fields: Iterable<string>,
): string[] {
  const allowed =
    recordType === 'person' ? ASSIGNABLE_PERSON_FIELDS : ASSIGNABLE_CONTRACT_FIELDS;
  return [...fields].filter((field) => !allowed.includes(field));
}

export interface MappedContract {
  externalId: string | null;
  sequence: number | null;
  isPrimary: boolean | null;
  startDate: Date;
  endDate: Date | null;
  jobTitle: string | null;
  department: string | null;
  costCentre: string | null;
  employer: string | null;
  location: string | null;
  managerExternalId: string | null;
  fte: string | null;
}

export interface MappedPerson {
  externalId: string;
  fields: Record<string, string>;
  contracts: MappedContract[];
}

export type PersonMappingFailure = {
  failed: true;
  anchor: string;
  reason: string;
};

export function isPersonMappingFailure(
  value: MappedPerson | PersonMappingFailure,
): value is PersonMappingFailure {
  return (value as PersonMappingFailure).failed === true;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Rejects malformed strings and impossible days alike. `Date.parse` accepts
 * 2026-02-30 and rolls it forward into March, which would put a contract's
 * start date in the wrong month with no error anywhere -- the same trap
 * `identity/csv-import.ts` documents.
 */
function parseIsoDate(value: string): Date | null {
  if (!ISO_DATE.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  if (date.toISOString().slice(0, 10) !== value) return null;
  return date;
}

function applyTransform(value: string, transform: PersonMappingRule['transform']) {
  switch (transform) {
    case 'trim':
      return value.trim();
    case 'lowercase':
      return value.trim().toLowerCase();
    default:
      return value;
  }
}

function collect(
  record: PersonSnapshotRecord,
  rules: PersonMappingRule[],
  recordType: PersonRecordType,
): { values: Record<string, string>; correlation?: string } {
  const values: Record<string, string> = {};
  let correlation: string | undefined;

  for (const rule of rules.filter((r) => r.recordType === recordType)) {
    const raw = record.fields[rule.sourceColumn];
    if (raw === undefined) continue;
    const value = applyTransform(raw, rule.transform);
    if (value === '') continue;
    values[rule.targetField] = value;
    if (rule.isCorrelation) correlation = value;
  }

  return correlation === undefined ? { values } : { values, correlation };
}

/**
 * Turns one row into a person and their contract, or fails it by name.
 *
 * Failing is not dropping. Every failure here is counted by the run and
 * excluded from the diff, and the person it names is NOT treated as absent --
 * which is what stops a column rename at the HR vendor reading as a
 * redundancy.
 */
export function mapPersonRecord(
  record: PersonSnapshotRecord,
  rules: PersonMappingRule[],
): MappedPerson | PersonMappingFailure {
  if (record.readFailure !== undefined) {
    return {
      failed: true,
      anchor: record.externalId,
      reason: `the source could not be read completely for this person: ${record.readFailure}`,
    };
  }

  const person = collect(record, rules, 'person');
  if (person.correlation === undefined) {
    return {
      failed: true,
      anchor: record.externalId,
      reason: 'the correlation column is missing or empty in this row',
    };
  }

  const contract = collect(record, rules, 'contract');
  const rawStart = contract.values.startDate;
  if (rawStart === undefined) {
    return {
      failed: true,
      anchor: person.correlation,
      reason: 'no start date is mapped, and a contract cannot exist without one',
    };
  }
  const startDate = parseIsoDate(rawStart);
  if (startDate === null) {
    return {
      failed: true,
      anchor: person.correlation,
      reason: `"${rawStart}" is not a real date in YYYY-MM-DD form`,
    };
  }

  let endDate: Date | null = null;
  const rawEnd = contract.values.endDate;
  if (rawEnd !== undefined) {
    endDate = parseIsoDate(rawEnd);
    if (endDate === null) {
      return {
        failed: true,
        anchor: person.correlation,
        reason: `"${rawEnd}" is not a real date in YYYY-MM-DD form`,
      };
    }
  }

  const rawSequence = contract.values.sequence;
  const sequence = rawSequence === undefined ? null : Number(rawSequence);
  if (sequence !== null && !Number.isInteger(sequence)) {
    return {
      failed: true,
      anchor: person.correlation,
      reason: `"${rawSequence}" is not a whole number, so it cannot be a contract sequence`,
    };
  }

  const isPrimaryRaw = contract.values.isPrimary;
  const isPrimary =
    isPrimaryRaw === undefined
      ? null
      : ['true', 'yes', '1', 'y'].includes(isPrimaryRaw.toLowerCase());

  return {
    externalId: person.correlation,
    fields: person.values,
    contracts: [
      {
        externalId: contract.values.externalId ?? null,
        sequence,
        isPrimary,
        startDate,
        endDate,
        jobTitle: contract.values.jobTitle ?? null,
        department: contract.values.department ?? null,
        costCentre: contract.values.costCentre ?? null,
        employer: contract.values.employer ?? null,
        location: contract.values.location ?? null,
        managerExternalId: contract.values.managerExternalId ?? null,
        fte: contract.values.fte ?? null,
      },
    ],
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/core/src/person-source/mapping.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/person-source/mapping.ts packages/core/src/person-source/mapping.test.ts
git commit -m "feat(core): map an HR row onto a person and a contract, refusing what it must not write"
```

---

## Task 7: The person source service

**Files:**
- Create: `packages/core/src/person-source/source-service.ts`
- Test: `packages/core/src/person-source/source-service.test.ts`

**Interfaces:**
- Consumes: `personSourceConfigSchemaFor` (Task 3); `unassignablePersonFields`, `PersonMappingRule` (Task 6); `putSecret`/`getSecret`/`deleteSecret` from `../vault/vault-service.js`; `currentTenant` from `../tenant-context.js`.
- Produces:
  - `createPersonSource(tx, provider, input): Promise<PersonSource>`
  - `updatePersonSource(tx, provider, id, input)`
  - `deletePersonSource(tx, id, opts): Promise<{ persons: number } | null>`
  - `findPersonSource(tx, id)`, `listPersonSources(tx)`
  - `personSourceWithCredential(tx, provider, id)`
  - `personMappingsFor(tx, sourceId): Promise<PersonMappingRule[]>`
  - `setPersonMappings(tx, sourceId, rules)`
  - `class PersonSourceOwnsPersonsError`, `class PersonSourceDisabledError`, `class UnassignableFieldError`

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/person-source/source-service.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@syntra/db';
import { localMasterKeyProvider } from '../vault/master-key.js';
import { getSecret } from '../vault/vault-service.js';
import { newTenant } from '../sync/test-support.js';
import {
  PersonSourceOwnsPersonsError,
  UnassignableFieldError,
  createPersonSource,
  deletePersonSource,
  personMappingsFor,
  personSourceWithCredential,
  setPersonMappings,
} from './source-service.js';

const provider = localMasterKeyProvider(Buffer.alloc(32, 7));

let tenantId: string;
beforeEach(async () => {
  tenantId = await newTenant();
});

const config = {
  host: 'hr.example.test',
  username: 'syntra',
  remotePath: '/export/people.csv',
};

describe('createPersonSource', () => {
  it('seals the credential in the vault and names the secret after the row', async () => {
    const source = await withTenant(tenantId, (tx) =>
      createPersonSource(tx, provider, {
        name: 'Workday nightly',
        type: 'sftpDelimited',
        feedMode: 'snapshot',
        config,
        credential: 'hunter2',
      }),
    );

    expect(source.secretName).toBe(`personSource.${source.id}.credential`);
    const secret = await withTenant(tenantId, (tx) =>
      getSecret(tx, provider, source.secretName),
    );
    expect(secret).toBe('hunter2');
    // Never in the config JSON.
    expect(JSON.stringify(source.config)).not.toContain('hunter2');
  });

  it('refuses an unknown source type', async () => {
    await expect(
      withTenant(tenantId, (tx) =>
        createPersonSource(tx, provider, {
          name: 'x',
          type: 'workday',
          feedMode: 'snapshot',
          config,
          credential: 'x',
        }),
      ),
    ).rejects.toThrow(/no person source connector implements type "workday"/);
  });

  /**
   * feedMode has no default anywhere, and the service is the last place it
   * could acquire one by accident.
   */
  it('refuses a feed mode it does not know', async () => {
    await expect(
      withTenant(tenantId, (tx) =>
        createPersonSource(tx, provider, {
          name: 'x',
          type: 'sftpDelimited',
          feedMode: 'incremental' as never,
          config,
          credential: 'x',
        }),
      ),
    ).rejects.toThrow(/feed mode/i);
  });
});

describe('setPersonMappings', () => {
  it('refuses a mapping onto a field a source may not write', async () => {
    const source = await withTenant(tenantId, (tx) =>
      createPersonSource(tx, provider, {
        name: 'HR', type: 'sftpDelimited', feedMode: 'snapshot', config, credential: 'x',
      }),
    );

    await expect(
      withTenant(tenantId, (tx) =>
        setPersonMappings(tx, source.id, [
          { recordType: 'person', sourceColumn: 'active', targetField: 'status', transform: 'none', isCorrelation: false },
        ]),
      ),
    ).rejects.toThrow(UnassignableFieldError);
  });

  it('requires exactly one correlation rule', async () => {
    const source = await withTenant(tenantId, (tx) =>
      createPersonSource(tx, provider, {
        name: 'HR', type: 'sftpDelimited', feedMode: 'snapshot', config, credential: 'x',
      }),
    );

    await expect(
      withTenant(tenantId, (tx) =>
        setPersonMappings(tx, source.id, [
          { recordType: 'person', sourceColumn: 'a', targetField: 'givenName', transform: 'none', isCorrelation: false },
        ]),
      ),
    ).rejects.toThrow(/exactly one correlation/);
  });

  it('round-trips the rules it stored', async () => {
    const source = await withTenant(tenantId, (tx) =>
      createPersonSource(tx, provider, {
        name: 'HR', type: 'sftpDelimited', feedMode: 'snapshot', config, credential: 'x',
      }),
    );
    const rules = [
      { recordType: 'person' as const, sourceColumn: 'employeeId', targetField: 'externalId', transform: 'trim' as const, isCorrelation: true },
      { recordType: 'contract' as const, sourceColumn: 'hireDate', targetField: 'startDate', transform: 'none' as const, isCorrelation: false },
    ];
    await withTenant(tenantId, (tx) => setPersonMappings(tx, source.id, rules));
    const read = await withTenant(tenantId, (tx) => personMappingsFor(tx, source.id));
    expect(read).toHaveLength(2);
    expect(read.find((r) => r.isCorrelation)?.targetField).toBe('externalId');
  });
});

describe('deletePersonSource', () => {
  it('refuses without confirmation while it owns persons, then releases them', async () => {
    const source = await withTenant(tenantId, (tx) =>
      createPersonSource(tx, provider, {
        name: 'HR', type: 'sftpDelimited', feedMode: 'snapshot', config, credential: 'x',
      }),
    );
    await withTenant(tenantId, (tx) =>
      tx.person.create({
        data: { tenantId, givenName: 'Ada', familyName: 'L', externalId: '1', sourceId: source.id },
      }),
    );

    await expect(
      withTenant(tenantId, (tx) => deletePersonSource(tx, source.id)),
    ).rejects.toThrow(PersonSourceOwnsPersonsError);

    await withTenant(tenantId, (tx) =>
      deletePersonSource(tx, source.id, { confirm: true }),
    );

    const person = await withTenant(tenantId, (tx) =>
      tx.person.findFirst({ where: { externalId: '1' } }),
    );
    // Deactivated and detached, never deleted.
    expect(person?.sourceId).toBeNull();
    expect(person?.status).toBe('inactive');
    expect(person?.statusReason).toMatch(/was removed/);
  });

  it('removes the vault secret with the source', async () => {
    const source = await withTenant(tenantId, (tx) =>
      createPersonSource(tx, provider, {
        name: 'HR', type: 'sftpDelimited', feedMode: 'snapshot', config, credential: 'x',
      }),
    );
    await withTenant(tenantId, (tx) => deletePersonSource(tx, source.id));
    const secret = await withTenant(tenantId, (tx) =>
      getSecret(tx, provider, source.secretName),
    );
    expect(secret).toBeNull();
  });
});

describe('personSourceWithCredential', () => {
  it('merges the stored config with the sealed credential', async () => {
    const source = await withTenant(tenantId, (tx) =>
      createPersonSource(tx, provider, {
        name: 'HR', type: 'sftpDelimited', feedMode: 'snapshot', config, credential: 'hunter2',
      }),
    );
    const merged = await withTenant(tenantId, (tx) =>
      personSourceWithCredential(tx, provider, source.id),
    );
    expect(merged?.host).toBe('hr.example.test');
    expect((merged as { password?: string })?.password).toBe('hunter2');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run packages/core/src/person-source/source-service.test.ts`
Expected: FAIL — "Cannot find module './source-service.js'".

- [ ] **Step 3: Write the service**

Create `packages/core/src/person-source/source-service.ts`:

```ts
import type { TenantClient } from '@syntra/db';
import { personSourceConfigSchemaFor } from '@syntra/connectors';
import { currentTenant } from '../tenant-context.js';
import { deleteSecret, getSecret, putSecret } from '../vault/vault-service.js';
import type { MasterKeyProvider } from '../vault/master-key.js';
import { unassignablePersonFields, type PersonMappingRule } from './mapping.js';

export const FEED_MODES = ['snapshot', 'delta'] as const;
export type FeedMode = (typeof FEED_MODES)[number];

export class UnassignableFieldError extends Error {
  constructor(readonly fields: string[]) {
    super(
      `a mapping may not write ${fields.join(', ')}: those fields are ` +
        `Syntra's, not the source's`,
    );
    this.name = 'UnassignableFieldError';
  }
}

export class PersonSourceOwnsPersonsError extends Error {
  constructor(readonly persons: number) {
    super(
      `this source owns ${persons} people; deleting it deactivates and ` +
        `detaches them, which has to be confirmed`,
    );
    this.name = 'PersonSourceOwnsPersonsError';
  }
}

export class PersonSourceDisabledError extends Error {
  constructor(readonly sourceId: string) {
    super('this source is disabled, so a run would never be picked up');
    this.name = 'PersonSourceDisabledError';
  }
}

export interface CreatePersonSourceInput {
  name: string;
  type: string;
  /** No default. See the schema comment on the column. */
  feedMode: FeedMode;
  config: unknown;
  credential: string;
  schedule?: string | undefined;
  autoApply?: boolean | undefined;
  deactivationThresholdPercent?: number | undefined;
  enabled?: boolean | undefined;
}

function assertFeedMode(value: string): asserts value is FeedMode {
  if (!(FEED_MODES as readonly string[]).includes(value)) {
    throw new Error(
      `"${value}" is not a feed mode; it is "snapshot" or "delta", and there ` +
        `is no default because reading a delta as a snapshot departs everyone ` +
        `absent from it`,
    );
  }
}

export async function createPersonSource(
  tx: TenantClient,
  provider: MasterKeyProvider,
  input: CreatePersonSourceInput,
) {
  const tenantId = await currentTenant(tx);
  assertFeedMode(input.feedMode);
  // Throws UnknownPersonSourceTypeError for a type no connector implements,
  // before a row exists to be orphaned by it.
  const config = personSourceConfigSchemaFor(input.type).parse(input.config);

  const source = await tx.personSource.create({
    data: {
      tenantId,
      name: input.name,
      type: input.type,
      feedMode: input.feedMode,
      config: config as never,
      // Filled in below, once the row has an id to name the secret after.
      secretName: 'pending',
      schedule: input.schedule ?? null,
      autoApply: input.autoApply ?? false,
      deactivationThresholdPercent: input.deactivationThresholdPercent ?? 10,
      enabled: input.enabled ?? true,
    },
  });

  const secretName = `personSource.${source.id}.credential`;
  await putSecret(tx, provider, secretName, input.credential);

  return tx.personSource.update({
    where: { id: source.id },
    data: { secretName },
  });
}

export interface UpdatePersonSourceInput {
  name?: string | undefined;
  config?: unknown;
  credential?: string | undefined;
  feedMode?: FeedMode | undefined;
  /** `null` clears the cron expression, leaving the source manual-only. */
  schedule?: string | null | undefined;
  autoApply?: boolean | undefined;
  deactivationThresholdPercent?: number | undefined;
  enabled?: boolean | undefined;
}

export async function updatePersonSource(
  tx: TenantClient,
  provider: MasterKeyProvider,
  id: string,
  input: UpdatePersonSourceInput,
) {
  const existing = await tx.personSource.findUnique({ where: { id } });
  if (!existing) return null;

  if (input.feedMode !== undefined) assertFeedMode(input.feedMode);
  const config =
    input.config === undefined
      ? undefined
      : personSourceConfigSchemaFor(existing.type).parse(input.config);

  if (input.credential !== undefined) {
    await putSecret(tx, provider, existing.secretName, input.credential);
  }

  return tx.personSource.update({
    where: { id },
    data: {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(config === undefined ? {} : { config: config as never }),
      ...(input.feedMode === undefined ? {} : { feedMode: input.feedMode }),
      ...(input.schedule === undefined ? {} : { schedule: input.schedule }),
      ...(input.autoApply === undefined ? {} : { autoApply: input.autoApply }),
      ...(input.deactivationThresholdPercent === undefined
        ? {}
        : { deactivationThresholdPercent: input.deactivationThresholdPercent }),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    },
  });
}

export function findPersonSource(tx: TenantClient, id: string) {
  return tx.personSource.findUnique({ where: { id } });
}

export function listPersonSources(tx: TenantClient) {
  return tx.personSource.findMany({ orderBy: { name: 'asc' } });
}

/**
 * The stored configuration merged with the credential from the vault.
 *
 * Plain data, deliberately not a `tx` handle: nothing downstream may hold a
 * transaction open across the SFTP read.
 */
export async function personSourceWithCredential(
  tx: TenantClient,
  provider: MasterKeyProvider,
  id: string,
): Promise<Record<string, unknown> | null> {
  const source = await tx.personSource.findUnique({ where: { id } });
  if (!source) return null;
  const credential = await getSecret(tx, provider, source.secretName);
  if (credential === null) return null;

  const config = source.config as Record<string, unknown>;
  // A key is multi-line and begins with a PEM banner; anything else is a
  // password. The two live in one vault entry because a source has one
  // credential, not one of each.
  const isKey = credential.includes('BEGIN') && credential.includes('PRIVATE KEY');
  return { ...config, ...(isKey ? { privateKey: credential } : { password: credential }) };
}

export async function personMappingsFor(
  tx: TenantClient,
  sourceId: string,
): Promise<PersonMappingRule[]> {
  const rows = await tx.personFieldMapping.findMany({ where: { sourceId } });
  return rows.map((row) => ({
    recordType: row.recordType as PersonMappingRule['recordType'],
    sourceColumn: row.sourceColumn,
    targetField: row.targetField,
    transform: row.transform as PersonMappingRule['transform'],
    isCorrelation: row.isCorrelation,
  }));
}

/**
 * Replaces a source's mappings wholesale.
 *
 * Checked before anything is written: a partial set that refused halfway
 * would leave a source mapping some fields and not others, which is a
 * configuration nobody chose and the next run would act on.
 */
export async function setPersonMappings(
  tx: TenantClient,
  sourceId: string,
  rules: PersonMappingRule[],
) {
  const tenantId = await currentTenant(tx);

  for (const recordType of ['person', 'contract'] as const) {
    const offending = unassignablePersonFields(
      recordType,
      rules.filter((r) => r.recordType === recordType).map((r) => r.targetField),
    );
    if (offending.length > 0) throw new UnassignableFieldError(offending);
  }

  const correlations = rules.filter((r) => r.isCorrelation);
  if (correlations.length !== 1) {
    throw new Error(
      `a source needs exactly one correlation rule, which is what anchors a ` +
        `row to a person; this set has ${correlations.length}`,
    );
  }
  if (correlations[0]?.recordType !== 'person') {
    throw new Error('the correlation rule must map a person field, not a contract field');
  }

  await tx.personFieldMapping.deleteMany({ where: { sourceId } });
  await tx.personFieldMapping.createMany({
    data: rules.map((rule) => ({ ...rule, tenantId, sourceId })),
  });
  return personMappingsFor(tx, sourceId);
}

export async function personSourceOwnedCount(tx: TenantClient, sourceId: string) {
  return tx.person.count({ where: { sourceId, status: 'active' } });
}

/**
 * Deleting a source, and releasing what it owned.
 *
 * `ON DELETE RESTRICT` forces the detach, and detaching is also what makes
 * those rows honest: a person owned by a source that no longer exists is fed
 * by nothing. They are deactivated and detached in the same transaction as
 * the delete, so releasing them is an act of the code and not only of the
 * schema -- and it is a decision an administrator confirms rather than a side
 * effect of removing a configuration row.
 */
export async function deletePersonSource(
  tx: TenantClient,
  id: string,
  opts: { confirm?: boolean } = {},
): Promise<{ persons: number } | null> {
  const existing = await tx.personSource.findUnique({ where: { id } });
  if (!existing) return null;

  // Counted inside the deleting transaction, so what is checked is what is
  // about to be deactivated rather than what was true a moment ago.
  const persons = await personSourceOwnedCount(tx, id);
  if (persons > 0 && !opts.confirm) throw new PersonSourceOwnsPersonsError(persons);

  const reason = `Person source "${existing.name}" was removed`;
  await tx.person.updateMany({
    where: { sourceId: id, status: 'active' },
    data: { status: 'inactive', statusReason: reason },
  });
  await tx.person.updateMany({ where: { sourceId: id }, data: { sourceId: null } });

  await deleteSecret(tx, existing.secretName);
  await tx.personSource.delete({ where: { id } });
  return { persons };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/core/src/person-source/source-service.test.ts`
Expected: PASS, 8 tests.

If `newTenant` is not exported from `packages/core/src/sync/test-support.ts`, use whichever helper that file exposes for creating a tenant and adjust the import — do not add a second helper.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/person-source/source-service.ts packages/core/src/person-source/source-service.test.ts
git commit -m "feat(core): configure a person source, seal its credential, release what it owns"
```

---

## Task 8: The diff

Pure, no database. This is where `feedMode` decides whether `depart_person` can exist at all.

**Files:**
- Create: `packages/core/src/person-source/diff.ts`
- Test: `packages/core/src/person-source/diff.test.ts`

**Interfaces:**
- Consumes: `MappedPerson`, `MappedContract` (Task 6); `FeedMode` (Task 7).
- Produces:
  - `type PersonChangeType = 'create_person' | 'update_person' | 'depart_person' | 'reactivate_person' | 'create_contract' | 'update_contract' | 'end_contract'`
  - `interface PersonProposedChange { changeType: PersonChangeType; recordType: 'person' | 'contract'; targetId: string | null; externalId: string | null; before: Record<string, unknown> | null; after: Record<string, unknown> | null; status: 'proposed'; message?: string }`
  - `interface ExistingContract { id: string; externalId: string | null; sequence: number; isPrimary: boolean; startDate: Date; endDate: Date | null; jobTitle: string | null; department: string | null; costCentre: string | null; employer: string | null; location: string | null; managerPersonId: string | null; fte: string | null }`
  - `interface ExistingPerson { id: string; externalId: string; status: string; fields: Record<string, string>; contracts: ExistingContract[] }`
  - `interface PersonDiffInput { mapped: MappedPerson[]; existing: ExistingPerson[]; feedMode: FeedMode; managerIdByExternalId: Map<string, string> }`
  - `function diffPersons(input: PersonDiffInput): PersonProposedChange[]`

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/person-source/diff.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { diffPersons, type ExistingPerson, type PersonDiffInput } from './diff.js';
import type { MappedPerson } from './mapping.js';

const start = new Date('2026-01-05T00:00:00Z');

function mapped(externalId: string, over: Partial<MappedPerson> = {}): MappedPerson {
  return {
    externalId,
    fields: { givenName: 'Ada', familyName: 'Lovelace' },
    contracts: [
      {
        externalId: `c-${externalId}`,
        sequence: null,
        isPrimary: null,
        startDate: start,
        endDate: null,
        jobTitle: 'Analyst',
        department: 'Research',
        costCentre: null,
        employer: null,
        location: null,
        managerExternalId: null,
        fte: null,
      },
    ],
    ...over,
  };
}

function existing(externalId: string, over: Partial<ExistingPerson> = {}): ExistingPerson {
  return {
    id: `p-${externalId}`,
    externalId,
    status: 'active',
    fields: { givenName: 'Ada', familyName: 'Lovelace' },
    contracts: [
      {
        id: `k-${externalId}`,
        externalId: `c-${externalId}`,
        sequence: 1,
        isPrimary: true,
        startDate: start,
        endDate: null,
        jobTitle: 'Analyst',
        department: 'Research',
        costCentre: null,
        employer: null,
        location: null,
        managerPersonId: null,
        fte: null,
      },
    ],
    ...over,
  };
}

function input(over: Partial<PersonDiffInput> = {}): PersonDiffInput {
  return {
    mapped: [],
    existing: [],
    feedMode: 'snapshot',
    managerIdByExternalId: new Map(),
    ...over,
  };
}

describe('diffPersons', () => {
  it('proposes nothing when the file matches what is stored', () => {
    const changes = diffPersons(input({ mapped: [mapped('1')], existing: [existing('1')] }));
    expect(changes).toEqual([]);
  });

  it('creates a person and their contract when both are new', () => {
    const changes = diffPersons(input({ mapped: [mapped('1')] }));
    expect(changes.map((c) => c.changeType)).toEqual(['create_person', 'create_contract']);
    expect(changes[0]?.externalId).toBe('1');
  });

  it('updates only the person fields that differ', () => {
    const changes = diffPersons(
      input({
        mapped: [mapped('1', { fields: { givenName: 'Augusta', familyName: 'Lovelace' } })],
        existing: [existing('1')],
      }),
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]?.changeType).toBe('update_person');
    expect(changes[0]?.after).toEqual({ givenName: 'Augusta' });
  });

  it('updates a contract that changed department', () => {
    const record = mapped('1');
    record.contracts[0]!.department = 'Engineering';
    const changes = diffPersons(input({ mapped: [record], existing: [existing('1')] }));
    expect(changes).toHaveLength(1);
    expect(changes[0]?.changeType).toBe('update_contract');
    expect(changes[0]?.after).toEqual({ department: 'Engineering' });
  });

  it('ends a contract the file now gives an end date', () => {
    const record = mapped('1');
    record.contracts[0]!.endDate = new Date('2026-06-30T00:00:00Z');
    const changes = diffPersons(input({ mapped: [record], existing: [existing('1')] }));
    expect(changes.map((c) => c.changeType)).toEqual(['end_contract']);
  });

  /**
   * The rule the whole feature turns on.
   */
  it('departs a person absent from a snapshot', () => {
    const changes = diffPersons(input({ mapped: [], existing: [existing('1')] }));
    expect(changes.map((c) => c.changeType)).toEqual(['depart_person']);
    expect(changes[0]?.targetId).toBe('p-1');
  });

  /**
   * And the rule that stops it being catastrophic. Not "produced then
   * filtered" -- never produced.
   */
  it('departs nobody in delta mode, however absent they are', () => {
    const changes = diffPersons(
      input({ mapped: [], existing: [existing('1'), existing('2')], feedMode: 'delta' }),
    );
    expect(changes).toEqual([]);
  });

  it('never departs a person who is already inactive', () => {
    const changes = diffPersons(
      input({ mapped: [], existing: [existing('1', { status: 'inactive' })] }),
    );
    expect(changes).toEqual([]);
  });

  it('reactivates a person who reappears after departing', () => {
    const changes = diffPersons(
      input({ mapped: [mapped('1')], existing: [existing('1', { status: 'inactive' })] }),
    );
    expect(changes.map((c) => c.changeType)).toEqual(['reactivate_person']);
  });

  /**
   * Contract identity is the HR system's employment id, not a positional
   * ordinal. Two contracts arriving in the other order must not be rewritten
   * into each other.
   */
  it('matches contracts by external id regardless of order', () => {
    const record = mapped('1');
    record.contracts = [
      { ...record.contracts[0]!, externalId: 'c-b', jobTitle: 'B' },
      { ...record.contracts[0]!, externalId: 'c-a', jobTitle: 'A' },
    ];
    const stored = existing('1');
    stored.contracts = [
      { ...stored.contracts[0]!, id: 'k-a', externalId: 'c-a', jobTitle: 'A' },
      { ...stored.contracts[0]!, id: 'k-b', externalId: 'c-b', jobTitle: 'B' },
    ];
    expect(diffPersons(input({ mapped: [record], existing: [stored] }))).toEqual([]);
  });

  it('falls back to sequence when the file carries no contract id', () => {
    const record = mapped('1');
    record.contracts[0] = { ...record.contracts[0]!, externalId: null, sequence: 1, jobTitle: 'Lead' };
    const stored = existing('1');
    stored.contracts[0] = { ...stored.contracts[0]!, externalId: null, sequence: 1 };
    const changes = diffPersons(input({ mapped: [record], existing: [stored] }));
    expect(changes.map((c) => c.changeType)).toEqual(['update_contract']);
  });

  it('resolves a manager external id to a person id', () => {
    const record = mapped('1');
    record.contracts[0]!.managerExternalId = '9';
    const changes = diffPersons(
      input({
        mapped: [record],
        existing: [existing('1')],
        managerIdByExternalId: new Map([['9', 'p-9']]),
      }),
    );
    expect(changes[0]?.after).toEqual({ managerPersonId: 'p-9' });
  });

  /**
   * A manager not yet imported is ordinary on a first run and fixed by the
   * next one. It is a note on the change, not a failure and not a null write
   * that would clear a manager somebody set.
   */
  it('notes an unresolvable manager rather than proposing a change', () => {
    const record = mapped('1');
    record.contracts[0]!.managerExternalId = '9';
    const changes = diffPersons(input({ mapped: [record], existing: [existing('1')] }));
    expect(changes).toHaveLength(1);
    expect(changes[0]?.changeType).toBe('update_contract');
    expect(changes[0]?.message).toMatch(/manager "9" is not in the register yet/);
    expect(changes[0]?.after).not.toHaveProperty('managerPersonId');
  });

  it('derives isPrimary as the earliest active contract when the file is silent', () => {
    const record = mapped('1');
    record.contracts = [
      { ...record.contracts[0]!, externalId: 'c-late', startDate: new Date('2026-03-01T00:00:00Z') },
      { ...record.contracts[0]!, externalId: 'c-early', startDate: new Date('2026-01-01T00:00:00Z') },
    ];
    const changes = diffPersons(input({ mapped: [record] }));
    const primary = changes.filter(
      (c) => c.changeType === 'create_contract' && (c.after as { isPrimary?: boolean }).isPrimary,
    );
    expect(primary).toHaveLength(1);
    expect((primary[0]?.after as { externalId: string }).externalId).toBe('c-early');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run packages/core/src/person-source/diff.test.ts`
Expected: FAIL — "Cannot find module './diff.js'".

- [ ] **Step 3: Write the diff**

Create `packages/core/src/person-source/diff.ts`:

```ts
import type { MappedContract, MappedPerson } from './mapping.js';
import type { FeedMode } from './source-service.js';

export type PersonChangeType =
  | 'create_person'
  | 'update_person'
  | 'depart_person'
  | 'reactivate_person'
  | 'create_contract'
  | 'update_contract'
  | 'end_contract';

export interface PersonProposedChange {
  changeType: PersonChangeType;
  recordType: 'person' | 'contract';
  targetId: string | null;
  externalId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  status: 'proposed';
  message?: string;
}

export interface ExistingContract {
  id: string;
  externalId: string | null;
  sequence: number;
  isPrimary: boolean;
  startDate: Date;
  endDate: Date | null;
  jobTitle: string | null;
  department: string | null;
  costCentre: string | null;
  employer: string | null;
  location: string | null;
  managerPersonId: string | null;
  fte: string | null;
}

export interface ExistingPerson {
  id: string;
  externalId: string;
  status: string;
  fields: Record<string, string>;
  contracts: ExistingContract[];
}

export interface PersonDiffInput {
  mapped: MappedPerson[];
  /** Only persons this source owns. A person it does not own is not its business. */
  existing: ExistingPerson[];
  feedMode: FeedMode;
  managerIdByExternalId: Map<string, string>;
}

const CONTRACT_SCALARS = [
  'jobTitle',
  'department',
  'costCentre',
  'employer',
  'location',
  'fte',
] as const;

function sameDay(a: Date | null, b: Date | null): boolean {
  if (a === null || b === null) return a === b;
  return a.getTime() === b.getTime();
}

/**
 * The key a contract is matched on.
 *
 * The HR system's employment id where the file carries one. Where it does not,
 * `sequence` -- which is a positional ordinal and therefore only safe while
 * the file's order is stable. The mapping screen warns about exactly this;
 * the fallback exists because a real file sometimes has nothing else.
 */
function contractKey(contract: { externalId: string | null; sequence: number | null }): string {
  return contract.externalId ?? `seq:${contract.sequence ?? 1}`;
}

/**
 * Which contract is the primary one, when the file does not say.
 *
 * The earliest-starting contract that has not ended, ties broken by key so two
 * runs over the same file cannot disagree. Never insertion order: that is not
 * a property of the file, it is a property of how it happened to be written.
 */
function derivePrimary(contracts: MappedContract[]): string | null {
  const active = contracts.filter((c) => c.endDate === null);
  const pool = active.length > 0 ? active : contracts;
  const sorted = [...pool].sort((a, b) => {
    const byDate = a.startDate.getTime() - b.startDate.getTime();
    return byDate !== 0 ? byDate : contractKey(a).localeCompare(contractKey(b));
  });
  return sorted.length === 0 ? null : contractKey(sorted[0] as MappedContract);
}

export function diffPersons(input: PersonDiffInput): PersonProposedChange[] {
  const changes: PersonProposedChange[] = [];
  const existingByExternalId = new Map(input.existing.map((p) => [p.externalId, p]));
  const seen = new Set<string>();

  for (const person of input.mapped) {
    seen.add(person.externalId);
    const stored = existingByExternalId.get(person.externalId);
    const primaryKey = derivePrimary(person.contracts);

    if (stored === undefined) {
      changes.push({
        changeType: 'create_person',
        recordType: 'person',
        targetId: null,
        externalId: person.externalId,
        before: null,
        after: { ...person.fields, externalId: person.externalId },
        status: 'proposed',
      });
      for (const contract of person.contracts) {
        changes.push(contractCreate(person.externalId, null, contract, primaryKey, input));
      }
      continue;
    }

    // A person the file returned who is currently departed is coming back.
    // Reactivation is an ordinary reviewable change, not a silent side effect
    // of an update.
    if (stored.status !== 'active') {
      changes.push({
        changeType: 'reactivate_person',
        recordType: 'person',
        targetId: stored.id,
        externalId: person.externalId,
        before: { status: stored.status },
        after: { status: 'active' },
        status: 'proposed',
      });
    }

    const fieldDelta: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(person.fields)) {
      if (stored.fields[field] !== value) fieldDelta[field] = value;
    }
    if (Object.keys(fieldDelta).length > 0) {
      changes.push({
        changeType: 'update_person',
        recordType: 'person',
        targetId: stored.id,
        externalId: person.externalId,
        before: stored.fields,
        after: fieldDelta,
        status: 'proposed',
      });
    }

    const storedByKey = new Map(stored.contracts.map((c) => [contractKey(c), c]));
    for (const contract of person.contracts) {
      const key = contractKey(contract);
      const storedContract = storedByKey.get(key);
      if (storedContract === undefined) {
        changes.push(contractCreate(person.externalId, stored.id, contract, primaryKey, input));
        continue;
      }
      const change = contractUpdate(
        person.externalId,
        storedContract,
        contract,
        primaryKey,
        input,
      );
      if (change !== null) changes.push(change);
    }
  }

  // Absence. In delta mode this loop does not run at all: a delta file says
  // nothing about who it omits, and a `depart_person` that is produced and
  // then filtered is a safety property one refactor away from vanishing.
  if (input.feedMode === 'snapshot') {
    for (const stored of input.existing) {
      if (seen.has(stored.externalId)) continue;
      if (stored.status !== 'active') continue;
      changes.push({
        changeType: 'depart_person',
        recordType: 'person',
        targetId: stored.id,
        externalId: stored.externalId,
        before: { status: stored.status },
        after: { status: 'inactive' },
        status: 'proposed',
        message: 'this person is not in the file',
      });
    }
  }

  return changes;
}

function resolveManager(
  contract: MappedContract,
  input: PersonDiffInput,
): { managerPersonId?: string; note?: string } {
  if (contract.managerExternalId === null) return {};
  const id = input.managerIdByExternalId.get(contract.managerExternalId);
  if (id === undefined) {
    return {
      note:
        `manager "${contract.managerExternalId}" is not in the register yet; ` +
        `the field is left as it is and the next run will resolve it`,
    };
  }
  return { managerPersonId: id };
}

function contractCreate(
  externalId: string,
  personId: string | null,
  contract: MappedContract,
  primaryKey: string | null,
  input: PersonDiffInput,
): PersonProposedChange {
  const manager = resolveManager(contract, input);
  const after: Record<string, unknown> = {
    externalId: contract.externalId,
    sequence: contract.sequence,
    isPrimary: contract.isPrimary ?? contractKey(contract) === primaryKey,
    startDate: contract.startDate,
    endDate: contract.endDate,
    personExternalId: externalId,
  };
  for (const field of CONTRACT_SCALARS) after[field] = contract[field];
  if (manager.managerPersonId !== undefined) after.managerPersonId = manager.managerPersonId;

  return {
    changeType: 'create_contract',
    recordType: 'contract',
    targetId: personId,
    externalId,
    before: null,
    after,
    status: 'proposed',
    ...(manager.note === undefined ? {} : { message: manager.note }),
  };
}

function contractUpdate(
  externalId: string,
  stored: ExistingContract,
  contract: MappedContract,
  primaryKey: string | null,
  input: PersonDiffInput,
): PersonProposedChange | null {
  const manager = resolveManager(contract, input);
  const after: Record<string, unknown> = {};

  for (const field of CONTRACT_SCALARS) {
    if (contract[field] !== stored[field]) after[field] = contract[field];
  }
  const isPrimary = contract.isPrimary ?? contractKey(contract) === primaryKey;
  if (isPrimary !== stored.isPrimary) after.isPrimary = isPrimary;
  if (!sameDay(contract.startDate, stored.startDate)) after.startDate = contract.startDate;
  if (
    manager.managerPersonId !== undefined &&
    manager.managerPersonId !== stored.managerPersonId
  ) {
    after.managerPersonId = manager.managerPersonId;
  }

  // An end date arriving is its own change type, so the guard can count it
  // against contracts rather than lumping it in with ordinary edits.
  const ending = !sameDay(contract.endDate, stored.endDate) && contract.endDate !== null;
  if (ending) {
    return {
      changeType: 'end_contract',
      recordType: 'contract',
      targetId: stored.id,
      externalId,
      before: { endDate: stored.endDate },
      after: { ...after, endDate: contract.endDate },
      status: 'proposed',
      ...(manager.note === undefined ? {} : { message: manager.note }),
    };
  }

  if (!sameDay(contract.endDate, stored.endDate)) after.endDate = contract.endDate;

  if (Object.keys(after).length === 0 && manager.note === undefined) return null;
  if (Object.keys(after).length === 0) return null;

  return {
    changeType: 'update_contract',
    recordType: 'contract',
    targetId: stored.id,
    externalId,
    before: {
      jobTitle: stored.jobTitle,
      department: stored.department,
      isPrimary: stored.isPrimary,
    },
    after,
    status: 'proposed',
    ...(manager.note === undefined ? {} : { message: manager.note }),
  };
}
```

Note on the unresolvable-manager test: the change it expects carries `message` and an `after` without `managerPersonId`. For that test to see an `update_contract` at all, the record it builds also differs in nothing else — so adjust `contractUpdate`'s final guard if the test fails: a note alone with no field delta should still surface as an `update_contract` carrying the note. Make the first of the two `if (Object.keys(after).length === 0` guards return the note-only change rather than `null`, and delete the second.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/core/src/person-source/diff.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/person-source/diff.ts packages/core/src/person-source/diff.test.ts
git commit -m "feat(core): diff an HR snapshot against the person register"
```

---

## Task 9: The guard

**Files:**
- Create: `packages/core/src/person-source/guard.ts`
- Test: `packages/core/src/person-source/guard.test.ts`

**Interfaces:**
- Consumes: `PersonProposedChange`, `PersonChangeType` (Task 8); `populationDropRefusal` from `../identity/population-drop.js`.
- Produces:
  - `interface PersonGuardInput { changes: PersonProposedChange[]; recordsRead: number; activePersonsFromSource: number; activeContractsFromSource: number; thresholdPercent: number; personsWithActiveContract: number; previousPersonsWithActiveContract: number | null }`
  - `type PersonGuardVerdict = { blocked: false } | { blocked: true; requiresConfirmation: boolean; reason: string }`
  - `function evaluatePersonGuard(input: PersonGuardInput): PersonGuardVerdict`

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/person-source/guard.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { evaluatePersonGuard, type PersonGuardInput } from './guard.js';
import type { PersonChangeType, PersonProposedChange } from './diff.js';

function change(changeType: PersonChangeType): PersonProposedChange {
  return {
    changeType,
    recordType: changeType.endsWith('_contract') ? 'contract' : 'person',
    targetId: 'x',
    externalId: '1',
    before: null,
    after: null,
    status: 'proposed',
  };
}

function input(over: Partial<PersonGuardInput> = {}): PersonGuardInput {
  return {
    changes: [],
    recordsRead: 100,
    activePersonsFromSource: 100,
    activeContractsFromSource: 100,
    thresholdPercent: 10,
    personsWithActiveContract: 100,
    previousPersonsWithActiveContract: 100,
    ...over,
  };
}

describe('evaluatePersonGuard', () => {
  it('passes a run that proposes nothing alarming', () => {
    expect(evaluatePersonGuard(input({ changes: [change('update_person')] }))).toEqual({
      blocked: false,
    });
  });

  /**
   * First and unconditional. An empty file and an unreachable server are
   * indistinguishable, and the safe reading is the second -- so there is
   * nothing a human could usefully confirm, and confirmation is not offered.
   */
  it('blocks a run that read nothing, with no confirmation available', () => {
    const verdict = evaluatePersonGuard(input({ recordsRead: 0 }));
    expect(verdict).toMatchObject({ blocked: true, requiresConfirmation: false });
    if (verdict.blocked) expect(verdict.reason).toMatch(/returned no records/);
  });

  it('passes departures inside the threshold', () => {
    const changes = Array.from({ length: 10 }, () => change('depart_person'));
    expect(evaluatePersonGuard(input({ changes }))).toEqual({ blocked: false });
  });

  it('blocks departures over the threshold, pending confirmation', () => {
    const changes = Array.from({ length: 11 }, () => change('depart_person'));
    const verdict = evaluatePersonGuard(input({ changes }));
    expect(verdict).toMatchObject({ blocked: true, requiresConfirmation: true });
    if (verdict.blocked) expect(verdict.reason).toMatch(/11 of 100 people/);
  });

  /**
   * Contracts get their own denominator. A wrong mapping that ends every
   * contract would otherwise sail under a threshold measured against people.
   */
  it('counts ended contracts against contracts, not against people', () => {
    const changes = Array.from({ length: 20 }, () => change('end_contract'));
    const verdict = evaluatePersonGuard(
      input({ changes, activeContractsFromSource: 100, activePersonsFromSource: 1000 }),
    );
    expect(verdict).toMatchObject({ blocked: true, requiresConfirmation: true });
    if (verdict.blocked) expect(verdict.reason).toMatch(/contracts/);
  });

  it('has nothing to protect on a first run against an empty register', () => {
    const changes = Array.from({ length: 50 }, () => change('depart_person'));
    expect(
      evaluatePersonGuard(input({ changes, activePersonsFromSource: 0 })),
    ).toEqual({ blocked: false });
  });

  /**
   * The two-source case. This run departs nobody from its own source and
   * still collapses the tenant's person register, because another source
   * feeds most of it and this run's applies would tip the total.
   */
  it('blocks when the tenant-wide population collapses even if the share is fine', () => {
    const verdict = evaluatePersonGuard(
      input({
        changes: [change('update_person')],
        personsWithActiveContract: 40,
        previousPersonsWithActiveContract: 100,
      }),
    );
    expect(verdict).toMatchObject({ blocked: true, requiresConfirmation: true });
    if (verdict.blocked) expect(verdict.reason).toMatch(/broken HR feed/);
  });

  it('blocks outright when nobody holds an active contract at all', () => {
    const verdict = evaluatePersonGuard(
      input({ personsWithActiveContract: 0, previousPersonsWithActiveContract: 100 }),
    );
    expect(verdict).toMatchObject({ blocked: true });
  });

  it('does not treat a first run as a collapse', () => {
    expect(
      evaluatePersonGuard(input({ previousPersonsWithActiveContract: null })),
    ).toEqual({ blocked: false });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run packages/core/src/person-source/guard.test.ts`
Expected: FAIL — "Cannot find module './guard.js'".

- [ ] **Step 3: Write the guard**

Create `packages/core/src/person-source/guard.ts`:

```ts
import { populationDropRefusal } from '../identity/population-drop.js';
import type { PersonChangeType, PersonProposedChange } from './diff.js';

export interface PersonGuardInput {
  changes: PersonProposedChange[];
  recordsRead: number;
  /** Active persons this source currently owns. */
  activePersonsFromSource: number;
  /** Active contracts held by persons this source owns. */
  activeContractsFromSource: number;
  thresholdPercent: number;
  /** Tenant-wide, after this run would apply. */
  personsWithActiveContract: number;
  /** The same count when this source last applied. Null on a first run. */
  previousPersonsWithActiveContract: number | null;
}

export type PersonGuardVerdict =
  | { blocked: false }
  /**
   * `requiresConfirmation` separates the two refusals, as `sync/guard.ts`
   * does. A run that read nothing is refused outright -- there is nothing an
   * administrator could usefully confirm about a file that may simply be a
   * failed export. A run over the threshold is refused pending an explicit
   * confirmation, because a real cohort departure -- a closed site, a
   * contractor batch -- has to be processable through the import rather than
   * by hand.
   */
  | { blocked: true; requiresConfirmation: boolean; reason: string };

/**
 * One population the threshold is measured against.
 *
 * Two of them, with two denominators, for the reason `sync/guard.ts` records
 * about groups: ending every contract a source owns is as destructive as
 * departing every person it owns, and a wrong mapping that did the first
 * would sail under a threshold measured against the second.
 */
interface Population {
  changeType: PersonChangeType;
  verb: string;
  noun: string;
  total(input: PersonGuardInput): number;
}

const POPULATIONS: Population[] = [
  {
    changeType: 'depart_person',
    verb: 'depart',
    noun: 'people this source owns',
    total: (i) => i.activePersonsFromSource,
  },
  {
    changeType: 'end_contract',
    verb: 'end',
    noun: 'contracts this source owns',
    total: (i) => i.activeContractsFromSource,
  },
];

/**
 * Decides whether an import is safe to apply.
 *
 * Not advisory: a blocked run will not apply on a schedule whatever
 * `autoApply` says, because an unattended schedule is exactly when nobody is
 * watching.
 *
 * Two guards, and both must pass. The share guard asks whether this run is
 * doing something disproportionate to what this source owns. The drop guard
 * asks whether the person register itself is about to collapse -- a different
 * question with a different denominator, and the one that catches a tenant
 * whose second HR source is feeding most of the population.
 */
export function evaluatePersonGuard(input: PersonGuardInput): PersonGuardVerdict {
  // First and unconditional. An empty file and an unreachable server are
  // indistinguishable, and the safe reading is the second.
  if (input.recordsRead === 0) {
    return {
      blocked: true,
      requiresConfirmation: false,
      reason: 'the source returned no records',
    };
  }

  const tripped: string[] = [];

  for (const population of POPULATIONS) {
    const count = input.changes.filter((c) => c.changeType === population.changeType).length;
    if (count === 0) continue;

    // No denominator means nothing to protect yet -- a first run against a
    // register this source owns nothing in.
    const total = population.total(input);
    if (total === 0) continue;

    const share = (count / total) * 100;
    if (share > input.thresholdPercent) {
      tripped.push(
        `would ${population.verb} ${count} of ${total} ${population.noun} ` +
          `(${share.toFixed(1)}%), above the ${input.thresholdPercent}% threshold`,
      );
    }
  }

  // The tenant-wide count, which Provision's leaver path and Automate's expiry
  // sweep are both downstream of. Its sentence is used verbatim: a refusal
  // that carries its own sentence is one the caller cannot paraphrase into
  // something less specific.
  const drop = populationDropRefusal({
    current: input.personsWithActiveContract,
    previous: input.previousPersonsWithActiveContract,
    thresholdPercent: input.thresholdPercent,
    subject: 'import',
  });
  if (drop !== null) tripped.push(drop);

  if (tripped.length === 0) return { blocked: false };

  return { blocked: true, requiresConfirmation: true, reason: tripped.join('; ') };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/core/src/person-source/guard.test.ts`
Expected: PASS, 9 tests.

The "nobody holds an active contract" case reaches `requiresConfirmation: true` through the drop guard rather than the `recordsRead` branch. If you would rather it be unconfirmable — and there is a good argument that it should be, since it matches `populationDropRefusal`'s own "nothing a human could usefully confirm" reasoning — that is a change to make deliberately with a test that names it, not a silent one.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/person-source/guard.ts packages/core/src/person-source/guard.test.ts
git commit -m "feat(core): guard an import by share and by the register's own population"
```

---

## Task 10: The run — preview, apply, skip

**Files:**
- Create: `packages/core/src/person-source/run-service.ts`
- Test: `packages/core/src/person-source/run-service.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 6–9; `personSourceConnectorFor` (Task 3); `FakePersonSource` (Task 4) in tests only; `withTenant` from `@syntra/db`.
- Produces:
  - `previewImportRun(tenantId, provider, sourceId, existingRunId?): Promise<PersonImportRun>`
  - `applyImportRun(tenantId, runId, opts: { only?: string[]; confirm?: boolean; confirmedBy?: string }): Promise<{ applied: number; failed: number }>`
  - `skipImportChange(tx, changeId)`
  - `listImportRuns(tx, sourceId?)`
  - `APPLY_ORDER: readonly PersonChangeType[]`

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/person-source/run-service.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withTenant } from '@syntra/db';
import { FakePersonSource } from '@syntra/connectors/testing';
import { localMasterKeyProvider } from '../vault/master-key.js';
import { newTenant } from '../sync/test-support.js';
import { createPersonSource, setPersonMappings } from './source-service.js';
import { APPLY_ORDER, applyImportRun, previewImportRun } from './run-service.js';

const provider = localMasterKeyProvider(Buffer.alloc(32, 7));

const connectorFor = vi.hoisted(() => vi.fn());
vi.mock('@syntra/connectors', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@syntra/connectors')>()),
  personSourceConnectorFor: connectorFor,
}));

let tenantId: string;
let sourceId: string;

const rules = [
  { recordType: 'person' as const, sourceColumn: 'employeeId', targetField: 'externalId', transform: 'trim' as const, isCorrelation: true },
  { recordType: 'person' as const, sourceColumn: 'firstName', targetField: 'givenName', transform: 'trim' as const, isCorrelation: false },
  { recordType: 'person' as const, sourceColumn: 'lastName', targetField: 'familyName', transform: 'trim' as const, isCorrelation: false },
  { recordType: 'contract' as const, sourceColumn: 'hireDate', targetField: 'startDate', transform: 'none' as const, isCorrelation: false },
];

function row(employeeId: string, over: Record<string, string> = {}) {
  return {
    externalId: `row-${employeeId}`,
    fields: { employeeId, firstName: 'Ada', lastName: 'Lovelace', hireDate: '2026-01-05', ...over },
    contracts: [],
  };
}

beforeEach(async () => {
  tenantId = await newTenant();
  const source = await withTenant(tenantId, async (tx) => {
    const created = await createPersonSource(tx, provider, {
      name: 'HR',
      type: 'sftpDelimited',
      feedMode: 'snapshot',
      config: { host: 'hr.test', username: 'u', remotePath: '/f.csv' },
      credential: 'x',
    });
    await setPersonMappings(tx, created.id, rules);
    return created;
  });
  sourceId = source.id;
});

describe('previewImportRun', () => {
  it('creates persons and contracts on a first run, and applies them', async () => {
    connectorFor.mockReturnValue(new FakePersonSource([row('1'), row('2')]));

    const run = await previewImportRun(tenantId, provider, sourceId);
    expect(run.status).toBe('previewed');
    expect(run.recordsRead).toBe(2);

    await applyImportRun(tenantId, run.id);

    const persons = await withTenant(tenantId, (tx) =>
      tx.person.findMany({ include: { contracts: true } }),
    );
    expect(persons).toHaveLength(2);
    expect(persons[0]?.sourceId).toBe(sourceId);
    expect(persons[0]?.contracts).toHaveLength(1);
  });

  it('proposes nothing on a second run over the same file', async () => {
    connectorFor.mockReturnValue(new FakePersonSource([row('1')]));
    const first = await previewImportRun(tenantId, provider, sourceId);
    await applyImportRun(tenantId, first.id);

    const second = await previewImportRun(tenantId, provider, sourceId);
    const changes = await withTenant(tenantId, (tx) =>
      tx.personImportChange.findMany({ where: { runId: second.id } }),
    );
    expect(changes).toEqual([]);
  });

  /**
   * The record was returned, so it is read. It could not be mapped, so it is
   * excluded. It is NOT absent, so nobody is departed for it.
   */
  it('counts a mapping failure as read and departs nobody for it', async () => {
    connectorFor.mockReturnValue(new FakePersonSource([row('1')]));
    const first = await previewImportRun(tenantId, provider, sourceId);
    await applyImportRun(tenantId, first.id);

    // The same person, now with an unreadable row.
    connectorFor.mockReturnValue(
      new FakePersonSource([{ ...row('1'), readFailure: 'the row was truncated' }]),
    );
    const second = await previewImportRun(tenantId, provider, sourceId);

    expect(second.recordsRead).toBe(1);
    expect(second.mappingFailures).toBe(1);
    expect(second.personsAbsent).toBe(0);
    const changes = await withTenant(tenantId, (tx) =>
      tx.personImportChange.findMany({ where: { runId: second.id } }),
    );
    expect(changes).toEqual([]);
  });

  it('blocks a run that read nothing, and refuses to apply it', async () => {
    connectorFor.mockReturnValue(new FakePersonSource([]));
    const run = await previewImportRun(tenantId, provider, sourceId);
    expect(run.status).toBe('blocked');
    expect(run.requiresConfirmation).toBe(false);

    await expect(applyImportRun(tenantId, run.id, { confirm: true })).rejects.toThrow(
      /blocked/,
    );
  });

  /**
   * A read that gives out partway fails the run. It must never become a
   * snapshot in which everyone unread is absent.
   */
  it('fails the run when the read throws, and proposes nothing', async () => {
    connectorFor.mockReturnValue(
      new FakePersonSource([row('1')], { failWith: new Error('connection reset') }),
    );
    const run = await previewImportRun(tenantId, provider, sourceId);
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/connection reset/);
    const changes = await withTenant(tenantId, (tx) =>
      tx.personImportChange.findMany({ where: { runId: run.id } }),
    );
    expect(changes).toEqual([]);
  });

  it('departs a person absent from a later snapshot', async () => {
    connectorFor.mockReturnValue(new FakePersonSource([row('1'), row('2')]));
    const first = await previewImportRun(tenantId, provider, sourceId);
    await applyImportRun(tenantId, first.id);

    connectorFor.mockReturnValue(new FakePersonSource([row('1')]));
    const second = await previewImportRun(tenantId, provider, sourceId);
    await applyImportRun(tenantId, second.id, { confirm: true });

    const gone = await withTenant(tenantId, (tx) =>
      tx.person.findFirst({ where: { externalId: '2' } }),
    );
    expect(gone?.status).toBe('inactive');
    expect(gone?.statusReason).toMatch(/not in the file/);
    // Never departureOverride: that means a human knew something the contract
    // table did not, and an import knows only that a row was missing.
    expect(gone?.departureOverride).toBeNull();
  });

  it('never departs a person the source does not own', async () => {
    await withTenant(tenantId, (tx) =>
      tx.person.create({
        data: { tenantId, givenName: 'Hand', familyName: 'Made', externalId: '99' },
      }),
    );
    connectorFor.mockReturnValue(new FakePersonSource([row('1')]));
    const run = await previewImportRun(tenantId, provider, sourceId);
    await applyImportRun(tenantId, run.id);

    const untouched = await withTenant(tenantId, (tx) =>
      tx.person.findFirst({ where: { externalId: '99' } }),
    );
    expect(untouched?.status).toBe('active');
  });

  it('proposes no departure at all when the source is a delta feed', async () => {
    await withTenant(tenantId, (tx) =>
      tx.personSource.update({ where: { id: sourceId }, data: { feedMode: 'delta' } }),
    );
    connectorFor.mockReturnValue(new FakePersonSource([row('1'), row('2')]));
    const first = await previewImportRun(tenantId, provider, sourceId);
    await applyImportRun(tenantId, first.id);

    connectorFor.mockReturnValue(new FakePersonSource([row('1')]));
    const second = await previewImportRun(tenantId, provider, sourceId);
    const departures = await withTenant(tenantId, (tx) =>
      tx.personImportChange.findMany({
        where: { runId: second.id, changeType: 'depart_person' },
      }),
    );
    expect(departures).toEqual([]);
    expect(second.personsAbsent).toBe(0);
  });
});

describe('applyImportRun', () => {
  it('refuses a blocked run without confirmation and accepts it with one', async () => {
    connectorFor.mockReturnValue(new FakePersonSource([row('1'), row('2')]));
    const first = await previewImportRun(tenantId, provider, sourceId);
    await applyImportRun(tenantId, first.id);

    // Both gone at once: 2 of 2 is 100%, over the 10% threshold.
    connectorFor.mockReturnValue(new FakePersonSource([row('3')]));
    const second = await previewImportRun(tenantId, provider, sourceId);
    expect(second.status).toBe('blocked');
    expect(second.requiresConfirmation).toBe(true);

    await expect(applyImportRun(tenantId, second.id)).rejects.toThrow(/blocked/);
    await applyImportRun(tenantId, second.id, { confirm: true, confirmedBy: 'user-1' });

    const run = await withTenant(tenantId, (tx) =>
      tx.personImportRun.findUnique({ where: { id: second.id } }),
    );
    expect(run?.confirmedBy).toBe('user-1');
  });

  it('applies only the changes it was given', async () => {
    connectorFor.mockReturnValue(new FakePersonSource([row('1'), row('2')]));
    const run = await previewImportRun(tenantId, provider, sourceId);
    const changes = await withTenant(tenantId, (tx) =>
      tx.personImportChange.findMany({
        where: { runId: run.id, changeType: 'create_person' },
      }),
    );
    await applyImportRun(tenantId, run.id, { only: [changes[0]!.id] });

    const persons = await withTenant(tenantId, (tx) => tx.person.findMany());
    expect(persons).toHaveLength(1);
  });

  /**
   * Departure is last. A person whose contract ends in the same run must not
   * be departed before the contract that would have kept them active is
   * written.
   */
  it('orders departure after every other change type', () => {
    expect(APPLY_ORDER[APPLY_ORDER.length - 1]).toBe('depart_person');
    expect(APPLY_ORDER.indexOf('create_person')).toBeLessThan(
      APPLY_ORDER.indexOf('create_contract'),
    );
    expect(APPLY_ORDER.indexOf('end_contract')).toBeLessThan(
      APPLY_ORDER.indexOf('depart_person'),
    );
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run packages/core/src/person-source/run-service.test.ts`
Expected: FAIL — "Cannot find module './run-service.js'".

- [ ] **Step 3: Write the run service**

Create `packages/core/src/person-source/run-service.ts`. The phase structure is `sync/run-service.ts`'s, and the comment there about phase 6 applies here identically: the proposed changes and the run's terminal status commit together or not at all.

```ts
import { withTenant, type TenantClient } from '@syntra/db';
import { personSourceConnectorFor, type PersonSnapshotRecord } from '@syntra/connectors';
import { currentTenant } from '../tenant-context.js';
import type { MasterKeyProvider } from '../vault/master-key.js';
import { recordEvent } from '../audit/audit-service.js';
import { isPersonMappingFailure, mapPersonRecord, type MappedPerson } from './mapping.js';
import { diffPersons, type ExistingPerson, type PersonChangeType } from './diff.js';
import { evaluatePersonGuard } from './guard.js';
import { personMappingsFor, personSourceWithCredential } from './source-service.js';

/**
 * The order changes are applied in.
 *
 * Departure last, so a person is never briefly departed while a contract that
 * would have kept them active is still pending. Persons before contracts,
 * because a contract names a person this run may only just have created.
 */
export const APPLY_ORDER: readonly PersonChangeType[] = [
  'create_person',
  'create_contract',
  'update_contract',
  'update_person',
  'reactivate_person',
  'end_contract',
  'depart_person',
];

async function loadExisting(tx: TenantClient, sourceId: string): Promise<ExistingPerson[]> {
  const rows = await tx.person.findMany({
    where: { sourceId },
    include: { contracts: true },
  });
  return rows.map((row) => ({
    id: row.id,
    externalId: row.externalId ?? '',
    status: row.status,
    fields: {
      givenName: row.givenName,
      familyName: row.familyName,
      nameConvention: row.nameConvention,
      ...(row.businessEmail === null ? {} : { businessEmail: row.businessEmail }),
      ...(row.personalEmail === null ? {} : { personalEmail: row.personalEmail }),
    },
    contracts: row.contracts.map((c) => ({
      id: c.id,
      externalId: c.externalId,
      sequence: c.sequence,
      isPrimary: c.isPrimary,
      startDate: c.startDate,
      endDate: c.endDate,
      jobTitle: c.jobTitle,
      department: c.department,
      costCentre: c.costCentre,
      employer: c.employer,
      location: c.location,
      managerPersonId: c.managerPersonId,
      fte: c.fte === null ? null : String(c.fte),
    })),
  }));
}

function personsWithActiveContract(tx: TenantClient) {
  return tx.person.count({
    where: {
      status: 'active',
      contracts: { some: { OR: [{ endDate: null }, { endDate: { gte: new Date() } }] } },
    },
  });
}

export async function previewImportRun(
  tenantId: string,
  provider: MasterKeyProvider,
  sourceId: string,
  existingRunId?: string,
) {
  // Phase 1: the run row, so there is something to mark `failed` no matter
  // where the rest of this gives out.
  const run = await withTenant(tenantId, async (tx) => {
    const source = await tx.personSource.findUnique({ where: { id: sourceId } });
    if (!source) throw new Error(`no such person source: ${sourceId}`);
    const boundTenant = await currentTenant(tx);
    if (existingRunId !== undefined) {
      return tx.personImportRun.update({
        where: { id: existingRunId },
        data: { status: 'running', startedAt: new Date() },
      });
    }
    return tx.personImportRun.create({ data: { tenantId: boundTenant, sourceId } });
  });

  try {
    // Phase 2: read the configuration out, then close the transaction. Plain
    // data -- nothing downstream may hold a handle across the SFTP read.
    const prepared = await withTenant(tenantId, async (tx) => {
      const source = await tx.personSource.findUnique({ where: { id: sourceId } });
      if (!source) throw new Error(`no such person source: ${sourceId}`);
      const config = await personSourceWithCredential(tx, provider, sourceId);
      if (!config) throw new Error('source configuration or credential missing');
      return {
        config,
        type: source.type,
        feedMode: source.feedMode as 'snapshot' | 'delta',
        rules: await personMappingsFor(tx, sourceId),
        thresholdPercent: source.deactivationThresholdPercent,
      };
    });

    // Phase 3: the read, outside any transaction, holding no connection.
    //
    // Buffered in full before anything is diffed. A diff computed against a
    // partial read is a diff in which every unread person is absent, and
    // absence departs people -- so a throw here reaches the catch below and
    // the run proposes nothing at all.
    const records: PersonSnapshotRecord[] = [];
    const connector = personSourceConnectorFor(prepared.type);
    for await (const record of connector.read(prepared.config as never)) {
      records.push(record);
    }

    // Phase 4: map. Failures are counted and excluded -- never absent.
    const mapped: MappedPerson[] = [];
    const failureReasons = new Set<string>();
    let mappingFailures = 0;
    for (const record of records) {
      const result = mapPersonRecord(record, prepared.rules);
      if (isPersonMappingFailure(result)) {
        mappingFailures += 1;
        failureReasons.add(result.reason);
        continue;
      }
      mapped.push(result);
    }

    // Phase 5: one short transaction for the database-side snapshot.
    const snapshot = await withTenant(tenantId, async (tx) => {
      const existing = await loadExisting(tx, sourceId);
      const managers = await tx.person.findMany({
        where: { externalId: { not: null } },
        select: { id: true, externalId: true },
      });
      return {
        existing,
        managerIdByExternalId: new Map(
          managers.flatMap((m) => (m.externalId === null ? [] : [[m.externalId, m.id]] as const)),
        ),
        activeContractsFromSource: await tx.contract.count({
          where: { person: { sourceId }, OR: [{ endDate: null }, { endDate: { gte: new Date() } }] },
        }),
        personsNow: await personsWithActiveContract(tx),
        lastApplied: await tx.personImportRun.findFirst({
          where: { sourceId, status: 'applied' },
          orderBy: { finishedAt: 'desc' },
          select: { recordsRead: true },
        }),
      };
    });

    const changes = diffPersons({
      mapped,
      existing: snapshot.existing,
      feedMode: prepared.feedMode,
      managerIdByExternalId: snapshot.managerIdByExternalId,
    });

    const departures = changes.filter((c) => c.changeType === 'depart_person').length;
    const verdict = evaluatePersonGuard({
      changes,
      recordsRead: records.length,
      activePersonsFromSource: snapshot.existing.filter((p) => p.status === 'active').length,
      activeContractsFromSource: snapshot.activeContractsFromSource,
      thresholdPercent: prepared.thresholdPercent,
      personsWithActiveContract: snapshot.personsNow - departures,
      previousPersonsWithActiveContract:
        snapshot.lastApplied === null ? null : snapshot.personsNow,
    });

    // Phase 6: one transaction. The changes and the run's terminal status
    // commit together or not at all, so a run that fails partway writes no
    // changes.
    return await withTenant(tenantId, async (tx) => {
      const boundTenant = await currentTenant(tx);
      if (changes.length > 0) {
        await tx.personImportChange.createMany({
          data: changes.map((change) => ({
            tenantId: boundTenant,
            runId: run.id,
            changeType: change.changeType,
            recordType: change.recordType,
            targetId: change.targetId,
            externalId: change.externalId,
            before: (change.before ?? undefined) as never,
            after: (change.after ?? undefined) as never,
            status: 'proposed',
            message: change.message ?? null,
          })),
        });
      }
      return tx.personImportRun.update({
        where: { id: run.id },
        data: {
          status: verdict.blocked ? 'blocked' : 'previewed',
          finishedAt: new Date(),
          recordsRead: records.length,
          mappingFailures,
          mappingFailureReasons: [...failureReasons],
          personsAbsent: departures,
          requiresConfirmation: verdict.blocked ? verdict.requiresConfirmation : false,
          blockedReason: verdict.blocked ? verdict.reason : null,
        },
      });
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return withTenant(tenantId, (tx) =>
      tx.personImportRun.update({
        where: { id: run.id },
        data: { status: 'failed', finishedAt: new Date(), error: message },
      }),
    );
  }
}

export async function applyImportRun(
  tenantId: string,
  runId: string,
  opts: { only?: string[]; confirm?: boolean; confirmedBy?: string } = {},
) {
  const run = await withTenant(tenantId, (tx) =>
    tx.personImportRun.findUnique({ where: { id: runId } }),
  );
  if (!run) throw new Error(`no such import run: ${runId}`);

  // A run blocked only for exceeding a threshold can be applied by someone who
  // has read the numbers and said so. A run that read no records has
  // `requiresConfirmation` false and is refused whatever the caller sends, and
  // the scheduler never passes `confirm` at all -- so `autoApply` can never
  // satisfy this.
  if (run.status === 'blocked' && !(run.requiresConfirmation && opts.confirm)) {
    throw new Error(
      `run is blocked and cannot be applied: ${run.blockedReason ?? 'unknown reason'}`,
    );
  }

  const changes = await withTenant(tenantId, (tx) =>
    tx.personImportChange.findMany({
      where: {
        runId,
        status: 'proposed',
        ...(opts.only ? { id: { in: opts.only } } : {}),
      },
    }),
  );

  const ordered = [...changes].sort(
    (a, b) =>
      APPLY_ORDER.indexOf(a.changeType as PersonChangeType) -
      APPLY_ORDER.indexOf(b.changeType as PersonChangeType),
  );

  let applied = 0;
  let failed = 0;

  for (const change of ordered) {
    try {
      await withTenant(tenantId, async (tx) => {
        await applyOne(tx, run.sourceId, change);
        await tx.personImportChange.update({
          where: { id: change.id },
          data: { status: 'applied' },
        });
        await recordEvent(tx, {
          action: `person_import.${change.changeType}`,
          targetType: change.recordType,
          targetId: change.targetId ?? change.externalId ?? runId,
        });
      });
      applied += 1;
    } catch (cause) {
      failed += 1;
      const message = cause instanceof Error ? cause.message : String(cause);
      await withTenant(tenantId, (tx) =>
        tx.personImportChange.update({
          where: { id: change.id },
          data: { status: 'failed', message },
        }),
      );
    }
  }

  await withTenant(tenantId, (tx) =>
    tx.personImportRun.update({
      where: { id: runId },
      data: {
        status: 'applied',
        ...(opts.confirmedBy === undefined ? {} : { confirmedBy: opts.confirmedBy }),
      },
    }),
  );
  await withTenant(tenantId, (tx) =>
    tx.personSource.update({
      where: { id: run.sourceId },
      data: { lastRunAt: new Date() },
    }),
  );

  return { applied, failed };
}

type ChangeRow = {
  id: string;
  changeType: string;
  recordType: string;
  targetId: string | null;
  externalId: string | null;
  after: unknown;
};

async function applyOne(tx: TenantClient, sourceId: string, change: ChangeRow) {
  const after = (change.after ?? {}) as Record<string, unknown>;
  const tenantId = await currentTenant(tx);

  switch (change.changeType) {
    case 'create_person':
      await tx.person.create({
        data: {
          tenantId,
          sourceId,
          externalId: change.externalId,
          givenName: String(after.givenName ?? ''),
          familyName: String(after.familyName ?? ''),
          ...(after.nameConvention === undefined
            ? {}
            : { nameConvention: String(after.nameConvention) }),
          ...(after.businessEmail === undefined
            ? {}
            : { businessEmail: String(after.businessEmail) }),
          ...(after.personalEmail === undefined
            ? {}
            : { personalEmail: String(after.personalEmail) }),
        },
      });
      return;

    case 'update_person':
      if (change.targetId === null) throw new Error('update_person with no person');
      await tx.person.update({ where: { id: change.targetId }, data: after as never });
      return;

    case 'reactivate_person':
      if (change.targetId === null) throw new Error('reactivate_person with no person');
      await tx.person.update({
        where: { id: change.targetId },
        data: { status: 'active', statusReason: null },
      });
      return;

    /**
     * Status and statusReason, never departureOverride. That field means a
     * human knew something the contract table did not; an import knows only
     * that a row was missing, and writing it would let a truncated export
     * outrank the contract table permanently.
     */
    case 'depart_person':
      if (change.targetId === null) throw new Error('depart_person with no person');
      await tx.person.update({
        where: { id: change.targetId },
        data: { status: 'inactive', statusReason: 'this person is not in the file' },
      });
      return;

    case 'create_contract': {
      const person = await tx.person.findFirst({
        where: { sourceId, externalId: change.externalId },
      });
      if (!person) throw new Error(`no person ${change.externalId} to hold this contract`);
      const highest = await tx.contract.findFirst({
        where: { personId: person.id },
        orderBy: { sequence: 'desc' },
        select: { sequence: true },
      });
      await tx.contract.create({
        data: {
          tenantId,
          personId: person.id,
          sequence: (after.sequence as number | null) ?? (highest?.sequence ?? 0) + 1,
          isPrimary: Boolean(after.isPrimary),
          startDate: after.startDate as Date,
          endDate: (after.endDate as Date | null) ?? null,
          externalId: (after.externalId as string | null) ?? null,
          jobTitle: (after.jobTitle as string | null) ?? null,
          department: (after.department as string | null) ?? null,
          costCentre: (after.costCentre as string | null) ?? null,
          employer: (after.employer as string | null) ?? null,
          location: (after.location as string | null) ?? null,
          managerPersonId: (after.managerPersonId as string | null) ?? null,
          ...(after.fte === undefined || after.fte === null ? {} : { fte: after.fte as string }),
        },
      });
      return;
    }

    case 'update_contract':
    case 'end_contract':
      if (change.targetId === null) throw new Error(`${change.changeType} with no contract`);
      await tx.contract.update({
        where: { id: change.targetId },
        data: { ...(after as never), personExternalId: undefined } as never,
      });
      return;

    default:
      throw new Error(`no apply path for change type "${change.changeType}"`);
  }
}

/** A skip is "not now", not "never": the next run proposes it again. */
export async function skipImportChange(tx: TenantClient, changeId: string) {
  return tx.personImportChange.update({
    where: { id: changeId },
    data: { status: 'skipped' },
  });
}

export function listImportRuns(tx: TenantClient, sourceId?: string) {
  return tx.personImportRun.findMany({
    where: sourceId === undefined ? {} : { sourceId },
    orderBy: { startedAt: 'desc' },
    take: 100,
  });
}
```

`personExternalId` is carried on a `create_contract`'s `after` so apply can find the person; strip it before any `contract.update`, as the `update_contract` branch does. If `recordEvent`'s signature in `../audit/audit-service.js` differs from the call above, match the existing one rather than changing it.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/core/src/person-source/run-service.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Run the whole core suite, to be sure nothing else moved**

Run: `pnpm vitest run packages/core`
Expected: PASS. Run it alone — concurrent suites in this repo produce phantom failures.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/person-source/run-service.ts packages/core/src/person-source/run-service.test.ts
git commit -m "feat(core): preview and apply an HR import, departure last"
```

---

## Task 11: Jobs and scheduling

**Files:**
- Create: `packages/core/src/person-source/jobs.ts`
- Test: `packages/core/src/person-source/jobs.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `previewImportRun`, `applyImportRun` (Task 10); `PersonSourceDisabledError` (Task 7); `Scheduler` from `../jobs/scheduler.js`.
- Produces:
  - `PERSON_IMPORT_JOB = 'personSource.run'`
  - `interface PersonImportJobPayload { tenantId: string; sourceId: string; runId?: string }`
  - `queueImportRun(scheduler, tenantId, sourceId): Promise<PersonImportRun>`
  - `applyPersonSourceSchedule(scheduler, tenantId, source: SchedulablePersonSource)`
  - `removePersonSourceSchedule(scheduler, tenantId, sourceId)`
  - `runPersonImportJob(provider, payload): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/person-source/jobs.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withTenant } from '@syntra/db';
import { localMasterKeyProvider } from '../vault/master-key.js';
import { newTenant } from '../sync/test-support.js';
import { createPersonSource } from './source-service.js';
import { PersonSourceDisabledError } from './source-service.js';
import {
  PERSON_IMPORT_JOB,
  applyPersonSourceSchedule,
  queueImportRun,
} from './jobs.js';

const provider = localMasterKeyProvider(Buffer.alloc(32, 7));
const scheduler = { schedule: vi.fn(), unschedule: vi.fn(), send: vi.fn() };

let tenantId: string;
beforeEach(async () => {
  tenantId = await newTenant();
  scheduler.schedule.mockReset();
  scheduler.unschedule.mockReset();
  scheduler.send.mockReset();
});

async function makeSource(over: Record<string, unknown> = {}) {
  return withTenant(tenantId, (tx) =>
    createPersonSource(tx, provider, {
      name: 'HR',
      type: 'sftpDelimited',
      feedMode: 'snapshot',
      config: { host: 'hr.test', username: 'u', remotePath: '/f.csv' },
      credential: 'x',
      ...over,
    }),
  );
}

describe('queueImportRun', () => {
  it('creates the run row so the response can name it, then enqueues', async () => {
    const source = await makeSource();
    const run = await queueImportRun(scheduler as never, tenantId, source.id);

    expect(run.status).toBe('queued');
    expect(scheduler.send).toHaveBeenCalledWith(
      PERSON_IMPORT_JOB,
      expect.objectContaining({ tenantId, sourceId: source.id, runId: run.id }),
    );
  });

  /**
   * Refused here rather than in the route: a check in the route leaves the
   * hole open for the next caller, and a run that reaches the database is a
   * run somebody has to reap.
   */
  it('refuses a run on a disabled source, writing no row', async () => {
    const source = await makeSource({ enabled: false });
    await expect(
      queueImportRun(scheduler as never, tenantId, source.id),
    ).rejects.toThrow(PersonSourceDisabledError);

    const runs = await withTenant(tenantId, (tx) => tx.personImportRun.findMany());
    expect(runs).toEqual([]);
  });
});

describe('applyPersonSourceSchedule', () => {
  it('schedules a source that has a cron expression', async () => {
    await applyPersonSourceSchedule(scheduler as never, tenantId, {
      id: 's-1',
      schedule: '0 2 * * *',
      enabled: true,
    });
    expect(scheduler.schedule).toHaveBeenCalled();
  });

  /**
   * Unscheduled, not skipped. Skipping would leave the old schedule firing
   * against a source the administrator believes is stopped.
   */
  it('unschedules a source that is disabled', async () => {
    await applyPersonSourceSchedule(scheduler as never, tenantId, {
      id: 's-1',
      schedule: '0 2 * * *',
      enabled: false,
    });
    expect(scheduler.unschedule).toHaveBeenCalled();
    expect(scheduler.schedule).not.toHaveBeenCalled();
  });

  it('unschedules a source whose cron expression was cleared', async () => {
    await applyPersonSourceSchedule(scheduler as never, tenantId, {
      id: 's-1',
      schedule: null,
      enabled: true,
    });
    expect(scheduler.unschedule).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run packages/core/src/person-source/jobs.test.ts`
Expected: FAIL — "Cannot find module './jobs.js'".

- [ ] **Step 3: Write the jobs module**

Create `packages/core/src/person-source/jobs.ts`:

```ts
import { withTenant } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';
import type { MasterKeyProvider } from '../vault/master-key.js';
import type { Scheduler } from '../jobs/scheduler.js';
import { PersonSourceDisabledError } from './source-service.js';
import { applyImportRun, previewImportRun } from './run-service.js';

export const PERSON_IMPORT_JOB = 'personSource.run';

export interface PersonImportJobPayload {
  tenantId: string;
  sourceId: string;
  /**
   * A run row created before the job was enqueued, so a caller can be told
   * which run its request produced without waiting for the SFTP read. Absent
   * on the scheduled path, which has nobody to tell.
   */
  runId?: string;
}

export interface SchedulablePersonSource {
  id: string;
  schedule: string | null;
  enabled: boolean;
}

function scheduleKey(tenantId: string, sourceId: string): string {
  return `${PERSON_IMPORT_JOB}:${tenantId}:${sourceId}`;
}

/**
 * Queues a manual run and hands back the row it will fill in.
 *
 * The row is created here rather than in the worker so the response can name
 * it. `queued` is a real state, distinct from `running`: between the two the
 * job sits in the queue for as long as the queue is busy, and a screen showing
 * `running` for that window would be lying about the source.
 */
export async function queueImportRun(
  scheduler: Scheduler,
  tenantId: string,
  sourceId: string,
) {
  const run = await withTenant(tenantId, async (tx) => {
    const source = await tx.personSource.findUnique({ where: { id: sourceId } });
    if (!source) throw new Error(`no such person source: ${sourceId}`);
    if (!source.enabled) throw new PersonSourceDisabledError(sourceId);
    const boundTenant = await currentTenant(tx);
    return tx.personImportRun.create({
      data: { tenantId: boundTenant, sourceId, status: 'queued' },
    });
  });

  await scheduler.send(PERSON_IMPORT_JOB, {
    tenantId,
    sourceId,
    runId: run.id,
  } satisfies PersonImportJobPayload);

  return run;
}

export async function applyPersonSourceSchedule(
  scheduler: Scheduler,
  tenantId: string,
  source: SchedulablePersonSource,
): Promise<void> {
  const key = scheduleKey(tenantId, source.id);

  // Unscheduled rather than skipped, for the reason applySourceSchedule
  // records: skipping is right only for a source that was never scheduled.
  if (!source.enabled || !source.schedule) {
    await scheduler.unschedule(PERSON_IMPORT_JOB, key);
    return;
  }

  await scheduler.schedule(
    PERSON_IMPORT_JOB,
    source.schedule,
    { tenantId, sourceId: source.id } satisfies PersonImportJobPayload,
    key,
  );
}

export async function removePersonSourceSchedule(
  scheduler: Scheduler,
  tenantId: string,
  sourceId: string,
): Promise<void> {
  await scheduler.unschedule(PERSON_IMPORT_JOB, scheduleKey(tenantId, sourceId));
}

/**
 * The unattended path.
 *
 * `confirm` is never passed, so a blocked run cannot be applied here whatever
 * `autoApply` says. That is the whole protection: an unattended schedule is
 * exactly when nobody is watching.
 */
export async function runPersonImportJob(
  provider: MasterKeyProvider,
  payload: PersonImportJobPayload,
): Promise<void> {
  const source = await withTenant(payload.tenantId, (tx) =>
    tx.personSource.findUnique({ where: { id: payload.sourceId } }),
  );
  if (!source || !source.enabled) return;

  const run = await previewImportRun(
    payload.tenantId,
    provider,
    payload.sourceId,
    payload.runId,
  );

  if (source.autoApply && run.status === 'previewed') {
    await applyImportRun(payload.tenantId, run.id);
  }
}
```

- [ ] **Step 4: Export the module from core**

Add to `packages/core/src/index.ts`, beside the existing sync exports:

```ts
export * from './person-source/mapping.js';
export * from './person-source/source-service.js';
export * from './person-source/diff.js';
export * from './person-source/guard.js';
export * from './person-source/run-service.js';
export * from './person-source/jobs.js';
```

If a name collides with an existing sync export (`ASSIGNABLE_FIELDS` does not, but check `FEED_MODES` and `APPLY_ORDER`), rename the new one rather than aliasing at the barrel — a name that means two things in one package is worse than a longer name.

- [ ] **Step 5: Register the worker**

Wherever `SYNC_JOB` is registered with the scheduler at boot (search: `grep -rn "SYNC_JOB" apps/api/src`), register `PERSON_IMPORT_JOB` alongside it, calling `runPersonImportJob(provider, payload)`. Register the schedule for every enabled person source at boot the same way sources are, using `applyPersonSourceSchedule`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm vitest run packages/core/src/person-source/jobs.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/person-source/jobs.ts packages/core/src/person-source/jobs.test.ts packages/core/src/index.ts apps/api/src
git commit -m "feat(core): schedule an HR import, and never auto-apply a blocked one"
```

---

## Task 12: Contracts and the HTTP surface

**Files:**
- Create: `packages/contracts/src/person-source.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `apps/api/src/routes/admin/person-sources.ts`
- Test: `apps/api/src/routes/admin/person-sources.test.ts`
- Modify: wherever `registerAdminSourceRoutes` is registered (search: `grep -rn "registerAdminSourceRoutes" apps/api/src`)

**Interfaces:**
- Consumes: everything exported from `@syntra/core`'s `person-source` module.
- Produces: routes under `/api/admin/person-sources`, and the Zod schemas below.

| Method | Path | Permission |
|---|---|---|
| GET | `/person-sources` | `sync.read` |
| POST | `/person-sources` | `sync.manage` |
| GET | `/person-sources/:id` | `sync.read` |
| PATCH | `/person-sources/:id` | `sync.manage` |
| DELETE | `/person-sources/:id` | `sync.manage` |
| POST | `/person-sources/:id/test` | `sync.manage` |
| POST | `/person-sources/:id/host-key` | `sync.manage` |
| GET | `/person-sources/:id/mappings` | `sync.read` |
| PUT | `/person-sources/:id/mappings` | `sync.manage` |
| POST | `/person-sources/:id/run` | `sync.manage` |
| GET | `/person-import-runs` | `sync.read` |
| GET | `/person-import-runs/:id` | `sync.read` |
| POST | `/person-import-runs/:id/apply` | `sync.manage` |
| POST | `/person-import-runs/:id/changes/:changeId/skip` | `sync.manage` |

- [ ] **Step 1: Write the contracts**

Create `packages/contracts/src/person-source.ts`:

```ts
import { z } from 'zod';

const feedMode = z.enum(['snapshot', 'delta']);

/**
 * Strict, like every schema carrying a security-relevant flag.
 *
 * `strictness.test.ts` records why: zod strips an unknown key, so a request
 * carrying `feedMod: 'delta'` alongside valid fields would commit the valid
 * ones, answer success, and leave the feed mode as it was. An administrator
 * who believes they switched a source to delta and did not is one quiet night
 * away from departing everyone absent from a delta file.
 */
export const createPersonSourceRequest = z
  .object({
    name: z.string().min(1),
    type: z.string().min(1),
    /** No default. The caller states it or the request fails. */
    feedMode,
    config: z.record(z.unknown()),
    credential: z.string().min(1),
    schedule: z.string().min(1).optional(),
    autoApply: z.boolean().optional(),
    deactivationThresholdPercent: z.number().int().min(1).max(100).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export const updatePersonSourceRequest = z
  .object({
    name: z.string().min(1),
    config: z.record(z.unknown()),
    credential: z.string().min(1),
    feedMode,
    schedule: z.string().min(1).nullable(),
    autoApply: z.boolean(),
    deactivationThresholdPercent: z.number().int().min(1).max(100),
    enabled: z.boolean(),
  })
  .partial()
  .strict();

export const personMappingRule = z
  .object({
    recordType: z.enum(['person', 'contract']),
    sourceColumn: z.string().min(1),
    targetField: z.string().min(1),
    transform: z.enum(['none', 'trim', 'lowercase']).default('none'),
    isCorrelation: z.boolean().default(false),
  })
  .strict();

export const setPersonMappingsRequest = z
  .object({ mappings: z.array(personMappingRule) })
  .strict();

/**
 * Accepting a host key.
 *
 * The fingerprint is echoed back rather than taken on trust from the row: the
 * administrator is confirming the key they were SHOWN, and a request that
 * named no key would accept whatever the server happens to present at the
 * moment the request lands.
 */
export const acceptHostKeyRequest = z
  .object({ fingerprint: z.string().min(1) })
  .strict();

export const applyImportRunRequest = z
  .object({
    only: z.array(z.string().uuid()).optional(),
    confirm: z.boolean().optional(),
  })
  .strict();

export const deletePersonSourceQuery = z
  .object({ confirm: z.coerce.boolean().optional() })
  .strict();
```

Add `export * from './person-source.js';` to `packages/contracts/src/index.ts`.

- [ ] **Step 2: Add a strictness test**

Append to `packages/contracts/src/strictness.test.ts`:

```ts
import { createPersonSourceRequest, updatePersonSourceRequest } from './person-source.js';

describe('a person source request refuses what it does not know', () => {
  it('refuses a misspelled feed mode key', () => {
    const result = updatePersonSourceRequest.safeParse({ feedMod: 'delta' });
    expect(result.success).toBe(false);
  });

  /**
   * There is no default anywhere in the stack, and this is the outermost
   * place it could acquire one.
   */
  it('refuses a create with no feed mode at all', () => {
    const result = createPersonSourceRequest.safeParse({
      name: 'HR',
      type: 'sftpDelimited',
      config: {},
      credential: 'x',
    });
    expect(result.success).toBe(false);
  });

  it('refuses a feed mode that is neither snapshot nor delta', () => {
    const result = createPersonSourceRequest.safeParse({
      name: 'HR',
      type: 'sftpDelimited',
      feedMode: 'incremental',
      config: {},
      credential: 'x',
    });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 3: Run the contract tests**

Run: `pnpm vitest run packages/contracts`
Expected: PASS, including the three new cases.

- [ ] **Step 4: Write the failing route test**

Create `apps/api/src/routes/admin/person-sources.test.ts`, following the shape of `apps/api/src/routes/admin/sources.test.ts` (read it first for the app-building and session helpers this repo uses). Cover:

```ts
// The cases, written against whatever helpers sources.test.ts establishes:
//
//  1. POST /person-sources with no feedMode        -> 400
//  2. POST /person-sources valid                   -> 201, no credential in the body
//  3. GET  /person-sources/:id                     -> the row, config without credential
//  4. PUT  /person-sources/:id/mappings onto
//       targetField 'status'                       -> 400, problem type unassignable-field
//  5. POST /person-sources/:id/test on a source
//       with no pinned key                         -> 200, hostKey.status 'unknown'
//  6. POST /person-sources/:id/host-key with a
//       fingerprint that is not the one just shown -> 409
//  7. POST /person-sources/:id/run on a disabled
//       source                                     -> 409, problem type source-disabled
//  8. POST /person-import-runs/:id/apply on a
//       blocked run without confirm                -> 409
//  9. DELETE /person-sources/:id while it owns
//       people, no confirm                         -> 409 carrying the count
// 10. every route above without sync.manage        -> 403
```

Write each as a real test with real assertions — the comment block above is the checklist, not the deliverable.

- [ ] **Step 5: Run it to verify it fails**

Run: `pnpm vitest run apps/api/src/routes/admin/person-sources.test.ts`
Expected: FAIL — the route file does not exist.

- [ ] **Step 6: Write the routes**

Create `apps/api/src/routes/admin/person-sources.ts`, modelled on `sources.ts`. The pieces that are specific to this family:

```ts
/**
 * Testing a connection, and accepting the key it presented.
 *
 * Two endpoints, not one, and deliberately so. `test` reports what the server
 * presented; `host-key` accepts it. Folding them together would mean a test
 * that pins a key as a side effect, which is trust-on-first-use wearing a
 * diagnostic's clothing.
 *
 * The accept echoes the fingerprint back and is refused if it is not the one
 * the source last saw, so an administrator confirms the key they were shown
 * rather than whatever answers when the request lands.
 */
app.post(
  '/person-sources/:id/test',
  { preHandler: requirePermission(PERMISSIONS.SYNC_MANAGE) },
  async (request) => {
    const { id } = idParam.parse(request.params);
    const prepared = await request.db(async (tx) => {
      const source = await findPersonSource(tx, id);
      if (!source) throw new ProblemError(404, 'not-found', 'Person source not found');
      const config = await personSourceWithCredential(tx, provider, id);
      if (!config) throw new ProblemError(409, 'conflict', 'Credential missing');
      return { type: source.type, config };
    });

    // Outside the transaction: this is network I/O.
    const result = await personSourceConnectorFor(prepared.type).test(
      prepared.config as never,
    );

    if (result.hostKey !== undefined) {
      await request.db((tx) =>
        recordEvent(tx, {
          action: 'person_source.host_key_seen',
          targetType: 'PersonSource',
          targetId: id,
          metadata: {
            fingerprint: result.hostKey.fingerprint,
            status: result.hostKey.status,
          },
        }),
      );
    }
    return result;
  },
);

app.post(
  '/person-sources/:id/host-key',
  { preHandler: requirePermission(PERMISSIONS.SYNC_MANAGE) },
  async (request) => {
    const { id } = idParam.parse(request.params);
    const { fingerprint } = acceptHostKeyRequest.parse(request.body);

    return request.db(async (tx) => {
      const source = await findPersonSource(tx, id);
      if (!source) throw new ProblemError(404, 'not-found', 'Person source not found');

      const config = source.config as Record<string, unknown>;
      const pinned = config.hostKeyFingerprint;
      // Re-pinning a DIFFERENT key is not this endpoint's job. A key that
      // changed is a rebuilt server or an interception, and clearing the pin
      // is a deliberate edit of the source, not a confirmation dialog.
      if (typeof pinned === 'string' && pinned !== '' && pinned !== fingerprint) {
        throw new ProblemError(
          409,
          'host-key-mismatch',
          'This source is already pinned to a different host key',
        );
      }

      const updated = await updatePersonSource(tx, provider, id, {
        config: { ...config, hostKeyFingerprint: fingerprint },
      });
      await recordEvent(tx, {
        action: 'person_source.host_key_accepted',
        targetType: 'PersonSource',
        targetId: id,
        metadata: { fingerprint },
      });
      return updated;
    });
  },
);
```

The remaining routes are mechanical translations of `sources.ts`: map `PersonSourceOwnsPersonsError` to a 409 carrying `{ persons }`, `UnassignableFieldError` to a 400 with problem type `unassignable-field`, `PersonSourceDisabledError` to a 409 with `source-disabled`, and `UnknownPersonSourceTypeError` to a 400. Call `applyPersonSourceSchedule` after every create and update and `removePersonSourceSchedule` after a delete, exactly as `sources.ts` calls its equivalents — without which a source created with a cron expression is not scheduled until the process restarts.

If `recordEvent`'s `AuditInput` has no `metadata` field, put the fingerprint in whichever field that type provides for detail rather than widening the type.

- [ ] **Step 7: Register the routes**

Alongside `registerAdminSourceRoutes(app, options)`, add `registerAdminPersonSourceRoutes(app, options)` with the same `SourceRouteOptions` shape.

- [ ] **Step 8: Run the route tests**

Run: `pnpm vitest run apps/api/src/routes/admin/person-sources.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 9: Commit**

```bash
git add packages/contracts/src/person-source.ts packages/contracts/src/index.ts packages/contracts/src/strictness.test.ts apps/api/src/routes/admin/person-sources.ts apps/api/src/routes/admin/person-sources.test.ts apps/api/src
git commit -m "feat(api): configure a person source, pin its host key, run and apply an import"
```

---

## Task 13: Source ownership in the person routes

Two refusals. Both exist because a nightly feed is not an upload somebody watches.

**Files:**
- Modify: `apps/api/src/routes/admin/persons.ts` (the `PATCH /persons/:id` handler at ~line 366, and the import handler at ~line 331)
- Test: `apps/api/src/routes/admin/persons.test.ts`

**Interfaces:**
- Consumes: `Person.sourceId` (Task 1).
- Produces: no new exports; two behavioural changes.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/routes/admin/persons.test.ts`:

```ts
describe('a person owned by a person source', () => {
  /**
   * The reasoning at persons.ts:368 held while the CSV import was the only
   * writer: it runs when somebody uploads a file, so an overwrite happens
   * while they watch. A scheduled import breaks that clause -- a nightly run
   * reverting a hand edit at 02:00 is a different thing -- so a source-owned
   * person gets the refusal users, groups and org units already have.
   */
  it('refuses an edit to a field its source owns', async () => {
    const { sourceId, personId } = await sourceOwnedPerson();
    const response = await patchPerson(personId, { givenName: 'Augusta' });
    expect(response.statusCode).toBe(409);
    expect(response.json().type).toMatch(/source-owned/);
    expect(response.json().detail).toContain(sourceId);
  });

  it('still allows an edit to a field no source owns', async () => {
    const { personId } = await sourceOwnedPerson();
    const response = await patchPerson(personId, { departureOverrideNote: 'walked out' });
    expect(response.statusCode).toBe(200);
  });

  it('leaves a hand-made person fully editable', async () => {
    const personId = await handMadePerson();
    const response = await patchPerson(personId, { givenName: 'Augusta' });
    expect(response.statusCode).toBe(200);
  });

  /**
   * Letting an upload overwrite fields a nightly feed reverts tomorrow is
   * worse than refusing, and the refusal names the source so the person knows
   * where to make the change instead.
   */
  it('refuses a CSV row whose externalId belongs to a source-owned person', async () => {
    const { externalId } = await sourceOwnedPerson();
    const response = await importCsv(
      `externalId,givenName,familyName,sequence,startDate\n${externalId},Ada,L,1,2026-01-05`,
    );
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.created).toBe(0);
    expect(body.updated).toBe(0);
    expect(body.errors[0].message).toMatch(/owned by the person source "HR"/);
  });

  it('still imports rows that clash with nobody', async () => {
    const response = await importCsv(
      'externalId,givenName,familyName,sequence,startDate\nnew-1,Grace,H,1,2026-01-05',
    );
    expect(response.json().created).toBe(1);
  });
});
```

Write `sourceOwnedPerson`, `handMadePerson`, `patchPerson` and `importCsv` as local helpers in the file, following whatever request helpers `persons.test.ts` already uses.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run apps/api/src/routes/admin/persons.test.ts`
Expected: FAIL — the edits and the import both succeed today.

- [ ] **Step 3: Add the refusal to `PATCH /persons/:id`**

Replace the docstring at `apps/api/src/routes/admin/persons.ts:366-372` and add the check after `existing` is loaded:

```ts
  /**
   * Correcting a person's record.
   *
   * A source-owned person is source-owned in the same sense a synced user is:
   * the fields the source maps are the source's, and an edit to one is
   * reverted by the next run. This used to be safe to allow because the CSV
   * import was the only writer and it ran when somebody pressed a button --
   * an overwrite happened while they watched. A scheduled import breaks that:
   * a nightly run reverting an edit at 02:00 tells nobody.
   *
   * Fields no source maps stay editable, including the departure override --
   * which is precisely the field that exists for a human who knows something
   * the feed does not.
   */
```

```ts
        if (existing.sourceId !== null) {
          const owned = await tx.personFieldMapping.findMany({
            where: { sourceId: existing.sourceId, recordType: 'person' },
            select: { targetField: true },
          });
          const ownedFields = new Set(owned.map((m) => m.targetField));
          const clashing = Object.keys(body).filter((field) => ownedFields.has(field));
          if (clashing.length > 0) {
            const source = await tx.personSource.findUnique({
              where: { id: existing.sourceId },
              select: { id: true, name: true },
            });
            throw new ProblemError(
              409,
              'source-owned',
              'This person is maintained by a person source',
              `${clashing.join(', ')} ${clashing.length === 1 ? 'is' : 'are'} ` +
                `maintained by the person source "${source?.name ?? existing.sourceId}" ` +
                `(${existing.sourceId}); an edit here is reverted by its next run`,
            );
          }
        }
```

Adjust the `ProblemError` argument order to match this codebase's constructor.

- [ ] **Step 4: Add the refusal to the CSV import**

In the import handler at `apps/api/src/routes/admin/persons.ts:331`, after `parsePersonCsv` and before `importPersons`, partition the rows:

```ts
      // A row naming a person a source owns is refused rather than applied.
      // Letting an upload overwrite fields a nightly feed reverts tomorrow is
      // worse than refusing, and the refusal names the source so the operator
      // knows where the change belongs.
      const claimed = await request.db((tx) =>
        tx.person.findMany({
          where: {
            externalId: { in: rows.map((r) => r.externalId) },
            sourceId: { not: null },
          },
          select: { externalId: true, source: { select: { name: true } } },
        }),
      );
      const claimedBy = new Map(
        claimed.flatMap((p) =>
          p.externalId === null ? [] : [[p.externalId, p.source?.name ?? 'a person source']] as const,
        ),
      );

      const importable = rows.filter((row) => !claimedBy.has(row.externalId));
      for (const [index, row] of rows.entries()) {
        const owner = claimedBy.get(row.externalId);
        if (owner === undefined) continue;
        errors.push({
          line: index + 2,
          message:
            `${row.externalId} is owned by the person source "${owner}"; ` +
            `change it there, or the next run will revert it`,
        });
      }
```

Then pass `importable` to `importPersons` in place of `rows`. The existing "partial success is reported, never hidden" contract holds unchanged — these are more entries in the same `errors` array.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run apps/api/src/routes/admin/persons.test.ts`
Expected: PASS, including the five new cases.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/admin/persons.ts apps/api/src/routes/admin/persons.test.ts
git commit -m "feat(api): a person a source owns is not edited by hand or by upload"
```

---

## Task 14: The console

**Files:**
- Modify: `apps/web/src/pages/admin/SourcesPage.tsx`
- Modify: `apps/web/src/pages/admin/AdminNav.tsx`
- Modify: `apps/web/src/pages/admin/AdminApp.tsx`
- Create: `apps/web/src/pages/admin/PersonSourcesTab.tsx`
- Create: `apps/web/src/pages/admin/PersonSourceDetailPage.tsx`
- Create: `apps/web/src/pages/admin/PersonImportRunDetailPage.tsx`
- Test: `apps/web/src/pages/admin/PersonSourceDetailPage.test.tsx`
- Test: `apps/web/src/pages/admin/PersonImportRunDetailPage.test.tsx`

**Interfaces:**
- Consumes: the routes from Task 12.
- Produces: routes `/admin/person-sources/new`, `/admin/person-sources/:id`, `/admin/person-import-runs/:id`; a `people` tab on `/admin/sources`.

- [ ] **Step 1: Relabel the nav link**

In `AdminNav.tsx`, change the `Connected systems` entry:

```ts
      // Two families of source, one destination. "Directory sources" beside
      // "People sources" would be two labels existing only to distinguish
      // themselves from each other, which is the failure this file's header
      // records sixteen links being removed for.
      { to: '/admin/sources', label: 'Sources', permission: 'sync.read' },
```

Leave `Target systems` as it is — Targets is not a view of Sources.

- [ ] **Step 2: Add the tabs**

In `SourcesPage.tsx`, change the header to `Sources`, fetch `/api/admin/person-sources` and `/api/admin/person-import-runs` alongside the existing two, and make the tabs `Directory` · `People` · `Runs`.

The Runs tab merges both families into one list with a `Family` column:

```tsx
/**
 * One Runs tab, not two.
 *
 * "What ran last night and what did it do" is one question an administrator
 * asks each morning, and two tabs means checking both every time. A run is
 * still a source's history rather than its peer -- it is reachable from the
 * source, and it is not a destination in the nav.
 */
```

Stat cards: `Sources` counts both families; add a `Blocked runs` card beside `Failed runs`, `tone="danger"`, `quietWhenZero`, linking to `?tab=runs`. A blocked run is the one state that needs somebody to act, and it is invisible if it is only ever a row.

- [ ] **Step 3: Write the failing source-editor test**

Create `apps/web/src/pages/admin/PersonSourceDetailPage.test.tsx`. The cases:

```tsx
/**
 * The feed-mode control is the most dangerous field in the product, and these
 * are the assertions that keep it honest.
 */
it('preselects neither feed mode', () => {
  renderNew();
  expect(screen.getByRole('radio', { name: /everyone currently employed/i })).not.toBeChecked();
  expect(screen.getByRole('radio', { name: /only what changed/i })).not.toBeChecked();
});

it('will not save until a feed mode is chosen', async () => {
  renderNew();
  await fillRequiredFieldsExceptFeedMode();
  expect(screen.getByRole('button', { name: /create source/i })).toBeDisabled();
});

it('states the consequence of the mode that is chosen', async () => {
  renderNew();
  await userEvent.click(screen.getByRole('radio', { name: /everyone currently employed/i }));
  expect(screen.getByText(/people missing from the file are treated as leavers/i)).toBeVisible();

  await userEvent.click(screen.getByRole('radio', { name: /only what changed/i }));
  expect(screen.getByText(/people missing from the file are left alone/i)).toBeVisible();
});

/**
 * There is no field to type a fingerprint into. Testing is how you get one.
 */
it('offers no host key field, and accepts the key the test showed', async () => {
  expect(screen.queryByLabelText(/fingerprint/i)).toBeNull();

  server.post('/api/admin/person-sources/:id/test', {
    ok: false,
    message: 'connected, but this server’s host key is not yet pinned',
    hostKey: { fingerprint: 'SHA256:abc', status: 'unknown' },
  });
  await userEvent.click(screen.getByRole('button', { name: /test connection/i }));

  expect(await screen.findByText('SHA256:abc')).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: /accept this key/i }));
  expect(server.lastBody('/api/admin/person-sources/:id/host-key')).toEqual({
    fingerprint: 'SHA256:abc',
  });
});

/**
 * A changed key gets no accept action at all. It is a rebuilt server or an
 * interception, and only one of those is safe to click through.
 */
it('offers no accept action when the key mismatches', async () => {
  server.post('/api/admin/person-sources/:id/test', {
    ok: false,
    message: 'the server presented a different host key',
    hostKey: { fingerprint: 'SHA256:zzz', status: 'mismatch' },
  });
  await userEvent.click(screen.getByRole('button', { name: /test connection/i }));

  expect(await screen.findByText(/different host key/i)).toBeVisible();
  expect(screen.queryByRole('button', { name: /accept/i })).toBeNull();
});

/**
 * Mapping is choosing from columns that exist, not typing names that might.
 */
it('offers the columns the test read, and nothing else', async () => {
  server.post('/api/admin/person-sources/:id/test', {
    ok: true, message: 'read 3 rows', columns: ['employeeId', 'firstName'],
    hostKey: { fingerprint: 'SHA256:abc', status: 'matched' },
  });
  await userEvent.click(screen.getByRole('button', { name: /test connection/i }));

  const select = await screen.findByLabelText(/column for given name/i);
  expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual([
    '', 'employeeId', 'firstName',
  ]);
});

it('warns when no contract id column is mapped', async () => {
  await mapOnlyPersonFields();
  expect(
    screen.getByText(/without a contract id, contracts are matched by position/i),
  ).toBeVisible();
});
```

- [ ] **Step 4: Write the source editor**

Create `apps/web/src/pages/admin/PersonSourceDetailPage.tsx`, following `SourceDetailPage.tsx`'s structure. The two controls that are specific:

```tsx
{/*
  * Snapshot or delta, with no preselection and no explanatory paragraph.
  *
  * The labels say what the FILE is, because that is the thing the
  * administrator knows; the line beneath says what Syntra will do about it,
  * which is the thing they need to decide. A control that needs prose above it
  * to be usable is a control that needs redesigning.
  */}
<fieldset>
  <legend>What this file contains</legend>
  <Radio
    name="feedMode"
    value="snapshot"
    checked={feedMode === 'snapshot'}
    onChange={() => setFeedMode('snapshot')}
    label="Everyone currently employed"
  />
  <Radio
    name="feedMode"
    value="delta"
    checked={feedMode === 'delta'}
    onChange={() => setFeedMode('delta')}
    label="Only what changed since the last file"
  />
  {feedMode === 'snapshot' && (
    <p>People missing from the file are treated as leavers.</p>
  )}
  {feedMode === 'delta' && (
    <p>People missing from the file are left alone.</p>
  )}
</fieldset>
```

```tsx
{/*
  * The host key, shown only once a test has seen one. There is no input:
  * nobody has a fingerprint to hand, and a field that can be typed into is a
  * field the wrong thing can be pasted into.
  */}
{hostKey?.status === 'unknown' && (
  <Alert tone="warning">
    <p>This server presented a host key Syntra has not seen before.</p>
    <code>{hostKey.fingerprint}</code>
    <Button onClick={acceptHostKey}>Accept this key</Button>
  </Alert>
)}
{hostKey?.status === 'mismatch' && (
  <Alert tone="danger">
    <p>
      This server presented a different host key from the one this source is
      pinned to. Either the server was rebuilt, or the connection is being
      intercepted.
    </p>
    <code>{hostKey.fingerprint}</code>
  </Alert>
)}
```

The submit button is disabled while `feedMode === null`, and `feedMode` initialises to `null` — not to `'snapshot'`.

- [ ] **Step 5: Write the failing run-review test**

Create `apps/web/src/pages/admin/PersonImportRunDetailPage.test.tsx`:

```tsx
it('shows departures first, with the count against its denominator', async () => {
  server.get('/api/admin/person-import-runs/r-1', {
    run: { id: 'r-1', status: 'previewed', recordsRead: 812, personsAbsent: 37 },
    denominators: { activePersonsFromSource: 812 },
    changes: [
      { id: 'c-1', changeType: 'update_person', externalId: '5' },
      { id: 'c-2', changeType: 'depart_person', externalId: '9' },
    ],
  });
  render();

  const sections = await screen.findAllByRole('heading', { level: 2 });
  expect(sections[0]).toHaveTextContent(/leavers/i);
  expect(screen.getByText('37 of 812 people this source owns')).toBeVisible();
});

/**
 * populationDropRefusal returns a complete sentence for the reason its own
 * comment gives: a refusal that carries its own sentence is one the caller
 * cannot paraphrase into something less specific. So it is printed, not
 * summarised.
 */
it('prints a blocked run’s reason verbatim', async () => {
  const reason =
    'the number of people holding an active contract has fallen from 800 to 40 ' +
    '(95.0%), above the 10% limit; this is the signature of a broken HR feed, ' +
    'and every action in this import is downstream of that count';
  server.get('/api/admin/person-import-runs/r-1', {
    run: { id: 'r-1', status: 'blocked', requiresConfirmation: true, blockedReason: reason },
    changes: [],
  });
  render();
  expect(await screen.findByText(reason)).toBeVisible();
});

it('offers no apply action on a run that read nothing', async () => {
  server.get('/api/admin/person-import-runs/r-1', {
    run: {
      id: 'r-1', status: 'blocked', requiresConfirmation: false,
      recordsRead: 0, blockedReason: 'the source returned no records',
    },
    changes: [],
  });
  render();
  expect(await screen.findByText(/returned no records/)).toBeVisible();
  expect(screen.queryByRole('button', { name: /apply/i })).toBeNull();
});

it('shows mapping failures as read-but-excluded, not as leavers', async () => {
  server.get('/api/admin/person-import-runs/r-1', {
    run: {
      id: 'r-1', status: 'previewed', recordsRead: 100,
      mappingFailures: 3, personsAbsent: 0,
      mappingFailureReasons: ['the correlation column is missing or empty in this row'],
    },
    changes: [],
  });
  render();
  expect(await screen.findByText(/3 rows were read but could not be mapped/i)).toBeVisible();
  expect(screen.getByText(/they are not treated as leavers/i)).toBeVisible();
});
```

- [ ] **Step 6: Write the run review page**

Create `apps/web/src/pages/admin/PersonImportRunDetailPage.tsx`, reusing `SyncRunDetailPage.tsx`'s polling, grouping, per-change skip and partial apply. Departures render in their own section above the others; the apply action appears only when `status === 'previewed'`, or `status === 'blocked' && requiresConfirmation`, in which case it carries the confirmation.

- [ ] **Step 7: Add the routes**

In `AdminApp.tsx`, beside the existing source routes:

```tsx
<Route path="person-sources/new" element={<PersonSourceDetailPage />} />
<Route path="person-sources/:id" element={<PersonSourceDetailPage />} />
<Route path="person-import-runs/:id" element={<PersonImportRunDetailPage />} />
```

- [ ] **Step 8: Run the web tests**

Run: `pnpm vitest run apps/web/src/pages/admin`
Expected: PASS, including the new files and the unchanged `SourcesPage.test.tsx` (update its assertions for the relabelled header and the third tab).

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/pages/admin
git commit -m "feat(console): person sources beside directory sources, under one Sources destination"
```

---

## Task 15: The SFTP integration test

Gated as the Samba tests are. It exists for the one thing a fake cannot prove.

**Files:**
- Modify: `infra/docker-compose.yml`
- Modify: `package.json` (scripts)
- Create: `packages/connectors/src/person/sftp/connector.integration.test.ts`

**Interfaces:**
- Consumes: `sftpDelimitedConnector`, `fetchFile`, `HostKeyMismatchError`, `HostKeyUnknownError` (Task 5).
- Produces: `sftp:up` and `sftp:wait` scripts; a skipped-by-default integration suite.

- [ ] **Step 1: Add the container**

In `infra/docker-compose.yml`, beside the `samba` service:

```yaml
  sftp:
    image: atmoz/sftp:alpine
    command: syntra:Syntra!Passw0rd:::export
    ports:
      - '2222:22'
    volumes:
      - ./sftp/people.csv:/home/syntra/export/people.csv:ro
```

Create `infra/sftp/people.csv`:

```csv
employeeId,firstName,lastName,hireDate,dept
1,Ada,Lovelace,2026-01-05,Research
2,Grace,Hopper,2026-02-01,Engineering
```

- [ ] **Step 2: Add the scripts**

In the root `package.json`:

```json
    "sftp:up": "docker compose -f infra/docker-compose.yml up -d sftp",
    "sftp:wait": "node --input-type=module -e \"import net from 'node:net';const port=Number(process.env.SFTP_PORT??2222);const deadline=Date.now()+60000;for(;;){const ok=await new Promise(r=>{const s=net.connect(port,'127.0.0.1');s.on('connect',()=>{s.end();r(true)});s.on('error',()=>r(false))});if(ok){console.log('sftp listening');process.exit(0)}if(Date.now()>deadline){console.error('sftp never listened');process.exit(1)}await new Promise(r=>setTimeout(r,1000))}\""
```

- [ ] **Step 3: Write the integration test**

Create `packages/connectors/src/person/sftp/connector.integration.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { sftpDelimitedConfigSchema } from './config.js';
import { sftpDelimitedConnector } from './connector.js';
import { HostKeyMismatchError, fetchFile } from './transport.js';

/**
 * Skipped unless a real server is up. `pnpm test` stays hermetic; run
 * `pnpm sftp:up && pnpm sftp:wait` first, and set SFTP_INTEGRATION=1.
 *
 * This suite exists for what a fake cannot prove. Every other property of this
 * connector is covered by unit tests against a string; host-key verification
 * can only be demonstrated by a server that presents a key, and the refusal
 * can only be demonstrated by pinning a different one.
 */
const enabled = process.env.SFTP_INTEGRATION === '1';

const base = {
  host: '127.0.0.1',
  port: Number(process.env.SFTP_PORT ?? 2222),
  username: 'syntra',
  remotePath: '/export/people.csv',
};

// The container is on loopback, which classifyAddress blocks by default.
process.env.OUTBOUND_ALLOW_PRIVATE = 'true';

function config(over: Record<string, unknown> = {}) {
  return {
    ...sftpDelimitedConfigSchema.parse({ ...base, ...over }),
    password: 'Syntra!Passw0rd',
  };
}

describe.skipIf(!enabled)('sftpDelimited against a real server', () => {
  it('reports the presented key as unknown, and the columns it read', async () => {
    const result = await sftpDelimitedConnector.test(config());
    expect(result.hostKey?.status).toBe('unknown');
    expect(result.hostKey?.fingerprint).toMatch(/^SHA256:/);
    expect(result.columns).toEqual(['employeeId', 'firstName', 'lastName', 'hireDate', 'dept']);
  });

  it('reads every row once the key it presented is pinned', async () => {
    const seen = await sftpDelimitedConnector.test(config());
    const pinned = config({ hostKeyFingerprint: seen.hostKey?.fingerprint });

    const rows: string[] = [];
    for await (const record of sftpDelimitedConnector.read(pinned)) {
      rows.push(record.fields.employeeId as string);
    }
    expect(rows).toEqual(['1', '2']);
  });

  /**
   * THE test. A pinned key that does not match must refuse the connection --
   * not warn, not proceed.
   */
  it('refuses to connect when the pinned key is not the one presented', async () => {
    await expect(
      fetchFile(config({ hostKeyFingerprint: 'SHA256:notthekeyyouarelookingfor' }), {
        allowPrivate: true,
        requirePinned: true,
      }),
    ).rejects.toThrow(HostKeyMismatchError);
  });

  it('refuses to read at all when no key is pinned', async () => {
    await expect(async () => {
      for await (const _ of sftpDelimitedConnector.read(config())) void _;
    }).rejects.toThrow(/no host key pinned/);
  });

  /**
   * The address check runs against a real connect, so a regression that
   * resolved the name instead of connecting to the checked address shows up
   * here rather than nowhere.
   */
  it('refuses a loopback address when private addresses are not allowed', async () => {
    const previous = process.env.OUTBOUND_ALLOW_PRIVATE;
    process.env.OUTBOUND_ALLOW_PRIVATE = 'false';
    try {
      await expect(sftpDelimitedConnector.test(config())).resolves.toMatchObject({
        ok: false,
        message: expect.stringMatching(/refuses to connect to/),
      });
    } finally {
      process.env.OUTBOUND_ALLOW_PRIVATE = previous;
    }
  });
});
```

- [ ] **Step 4: Run it against a real server**

Run: `pnpm sftp:up && pnpm sftp:wait && SFTP_INTEGRATION=1 pnpm vitest run packages/connectors/src/person/sftp/connector.integration.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Confirm the default run still skips it**

Run: `pnpm vitest run packages/connectors`
Expected: PASS, with the integration suite reported as skipped.

- [ ] **Step 6: Commit**

```bash
git add infra/docker-compose.yml infra/sftp package.json packages/connectors/src/person/sftp/connector.integration.test.ts
git commit -m "test(connectors): prove the host key refusal against a real SFTP server"
```

---

## Task 16: The end-to-end spec

**Files:**
- Create: `e2e/person-sources.spec.ts`

**Interfaces:**
- Consumes: the console from Task 14 and the routes from Task 12.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Write the spec**

Create `e2e/person-sources.spec.ts`, modelled on `e2e/sync.spec.ts`. One path, the one a human takes:

```ts
/**
 * The path a human takes, once. The branching lives in the unit tests -- an
 * e2e that enumerated the guard's cases would be slow, flaky, and a worse
 * description of them than `guard.test.ts` already is.
 */
test('configure an HR source, accept its key, map it, run it, apply it', async ({ page }) => {
  await signInAsAdmin(page);
  await page.goto('/admin/sources');
  await page.getByRole('tab', { name: 'People' }).click();
  await page.getByRole('link', { name: 'Add person source' }).click();

  await page.getByLabel('Name').fill('HR nightly');
  await page.getByLabel('Host').fill('127.0.0.1');
  await page.getByLabel('Port').fill('2222');
  await page.getByLabel('Username').fill('syntra');
  await page.getByLabel('Password').fill('Syntra!Passw0rd');
  await page.getByLabel('Remote path').fill('/export/people.csv');

  // Nothing is preselected, and nothing can be saved until it is.
  await expect(page.getByRole('button', { name: 'Create source' })).toBeDisabled();
  await page.getByRole('radio', { name: /everyone currently employed/i }).check();
  await expect(page.getByText(/treated as leavers/i)).toBeVisible();
  await page.getByRole('button', { name: 'Create source' }).click();

  // The key is accepted from what the test showed, never typed.
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByText(/host key Syntra has not seen before/i)).toBeVisible();
  await page.getByRole('button', { name: 'Accept this key' }).click();

  // Mapping from the columns the test read.
  await page.getByRole('button', { name: 'Test connection' }).click();
  await page.getByLabel('Column for external id').selectOption('employeeId');
  await page.getByLabel('Column for given name').selectOption('firstName');
  await page.getByLabel('Column for family name').selectOption('lastName');
  await page.getByLabel('Column for start date').selectOption('hireDate');
  await page.getByLabel('Column for department').selectOption('dept');
  await page.getByRole('button', { name: 'Save mappings' }).click();

  // Run, review, apply.
  await page.getByRole('button', { name: 'Run now' }).click();
  await expect(page.getByText('Previewed')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('2 people to create')).toBeVisible();
  await page.getByRole('button', { name: 'Apply' }).click();

  await page.goto('/admin/users?tab=people');
  await expect(page.getByText('Ada Lovelace')).toBeVisible();
  await expect(page.getByText('Grace Hopper')).toBeVisible();
});

/**
 * The second run, with a file that lost somebody. This is what the whole
 * feature is for, and it is the one branch worth spending an e2e on: it
 * crosses the connector, the diff, the guard, the confirmation and the apply.
 */
test('a person absent from the next file is proposed as a leaver and confirmed', async ({ page }) => {
  // Rewrite infra/sftp/people.csv to drop Grace, then run again.
  await replaceExportWith('employeeId,firstName,lastName,hireDate,dept\n1,Ada,Lovelace,2026-01-05,Research\n');

  await signInAsAdmin(page);
  await page.goto('/admin/sources');
  await page.getByRole('tab', { name: 'People' }).click();
  await page.getByRole('link', { name: 'HR nightly' }).click();
  await page.getByRole('button', { name: 'Run now' }).click();

  // 1 of 2 is 50%, over the 10% threshold: blocked, and confirmable.
  await expect(page.getByText(/would depart 1 of 2 people this source owns/i)).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole('heading', { name: /leavers/i })).toBeVisible();
  await page.getByRole('button', { name: /apply.*confirm/i }).click();

  await page.goto('/admin/users?tab=people');
  await expect(page.getByText('Grace Hopper')).toHaveText(/inactive/i);
});
```

Write `signInAsAdmin` and `replaceExportWith` against whatever helpers `e2e/sync.spec.ts` and `e2e/README.md` already establish; do not add a second sign-in helper.

- [ ] **Step 2: Run it**

Run: `pnpm sftp:up && pnpm sftp:wait && pnpm e2e person-sources`
Expected: PASS, 2 tests. Run e2e alone — concurrent suites in this repo produce phantom failures.

- [ ] **Step 3: Commit**

```bash
git add e2e/person-sources.spec.ts
git commit -m "test(e2e): configure an HR source and confirm a leaver through the console"
```

---

## Final verification

- [ ] **Step 1: The whole suite, serially**

Run: `pnpm test`
Expected: PASS. Do not run other suites concurrently.

- [ ] **Step 2: Types**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: The migration against a clean database**

Run: `pnpm db:reset && pnpm db:migrate`
Expected: every migration applies in order onto an empty database.

- [ ] **Step 4: Check the spec's promises against what was built**

Re-read `docs/superpowers/specs/2026-08-28-provision-sources-design.md` and confirm each of these is true of the code, not just of the plan:

- `SourceConnector` has no `write`, `discoverSchema` or `SourceWriteback`.
- `PersonSource` has no write-back columns.
- `feedMode` has no default in the schema, the migration, the service, the contract or the form.
- `diffPersons` cannot emit `depart_person` in `delta` mode.
- No code path writes `departureOverride` from an import.
- No code path deletes a `Person` or a `Contract`.
- `applyImportRun` refuses a blocked run unless `requiresConfirmation && confirm`, and `runPersonImportJob` never passes `confirm`.
- `readDelimited`'s ceilings throw; nothing truncates.

---

## Notes for whoever executes this

**Task 3 forward-references Task 5.** The registry imports the SFTP connector, so Task 3's tests do not pass until Task 5 lands. Do Task 3's steps 1, 4 and 5, then Task 5 in full, then return to Task 3 step 6. It is the only ordering exception in the plan.

**`remotePath` globbing is not implemented by the code in Task 5.** The spec says a glob must resolve to exactly one file and that more than one match is an error; `fetchFile` as written opens the path directly. Close the gap in Task 5 before its commit: when `remotePath` contains `*` or `?`, `readdir` the parent directory over the same connection, match the basename, and throw naming every match when there is more than one — a source that silently picked the alphabetically-first of two exports would import last week's file on the week somebody left a copy behind. Add a unit test for the multiple-match refusal against a mocked directory listing, and an integration case in Task 15 with two files in `/export`.

**Phase 2 (duplicate detection and merging) is not in this plan.** It is specified in the design document's "Phase 2" section and is deliberately a later cycle. Do not start it here.

**On the tests you will be tempted to skip.** The scenario list in Task 10 is not padding. Each case in it is a distinct route by which this feature departs people who have not left, and every one of them is cheap to assert and expensive to discover in production. If a case seems redundant, read the spec section it comes from before deleting it.
