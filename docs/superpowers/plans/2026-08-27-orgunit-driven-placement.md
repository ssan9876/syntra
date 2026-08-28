# Org-Unit-Driven Account Placement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Syntra the master of the organizational-unit tree — materialising an `OrgUnit` against a target creates the container in the directory, and assigning a `Person` to an `OrgUnit` places their account in it.

**Architecture:** A new `OrgUnitContainer` join row binds a tenant-wide `OrgUnit` to a target-specific DN and records whether the target has confirmed it. `desiredState` gains a placement rung between the manual override and the rendered template. `reconcile.ts` learns one narrow exception to Ruling P9: a container backed by an `OrgUnitContainer` row in state `desired` produces a `create_container` action instead of making the person unprocessable. A new absolute-count guard axis caps container creates per run.

**Tech Stack:** TypeScript (ESM, `exactOptionalPropertyTypes` on), Prisma + PostgreSQL 16 with `FORCE ROW LEVEL SECURITY`, Fastify, React 19, Vitest, `ldapts`. pnpm workspace.

**Spec:** `docs/superpowers/specs/2026-08-27-orgunit-driven-placement-design.md`

## Global Constraints

- **Ruling P9 (revised).** Provision never creates a container *implicitly*. A container is created only from an `OrgUnitContainer` row in state `desired`. A container named by a rendered template and absent from the target remains `container_missing` at scope `all`, unchanged.
- **Ruling P22.** `renderTemplate` is never called directly on a `containerTemplate` or `fallbackContainer`. Use `renderContainer`. The new placement rung stores a literal DN and is not rendered at all.
- **Tenant isolation is enforced by PostgreSQL.** Every new table gets `FORCE ROW LEVEL SECURITY` and a `tenantId`. All access goes through `withTenant`.
- **No deletes.** Nothing in this plan adds a delete of any kind at a target. `deleteDirectoryOrgUnit` is not modified.
- **Out of scope, do not implement:** renaming an OrgUnit does not rename the container; reparenting is unsupported; `deleteDirectoryOrgUnit` is untouched.
- **`exactOptionalPropertyTypes` is on repo-wide.** Optional interface fields that a caller may pass as `undefined` must be typed `| undefined` explicitly.
- **Commit after every task.** Use the message given in the task's final step.

---

### Task 1: Schema — `OrgUnitContainer`, `Person.orgUnitId`, `maxContainerCreatesPerRun`

**Files:**
- Modify: `packages/db/prisma/schema.prisma`
- Create: `packages/db/prisma/migrations/20260921000000_org_unit_container/migration.sql`
- Test: `packages/db/src/rls.test.ts` (append)

**Interfaces:**
- Consumes: nothing.
- Produces: Prisma models `OrgUnitContainer` (fields `id`, `tenantId`, `orgUnitId`, `targetSystemId`, `dn`, `anchor`, `state`, `createdAt`, `updatedAt`), `Person.orgUnitId: string | null`, `TargetSystem.maxContainerCreatesPerRun: number`.

- [ ] **Step 1: Add the models to `schema.prisma`**

Add to `model OrgUnit` (after the existing `users User[]` line):

```prisma
  persons    Person[]           @relation("PersonOrgUnit")
  containers OrgUnitContainer[]
```

Add to `model Person` (after `placements AccountPlacement[]`):

```prisma
  /// The unit this person belongs to, which places their account in the
  /// container that unit is materialised at on each target. Separate from
  /// `User.orgUnitId`, which stays as-is and keeps feeding access resolution:
  /// placement is a property of a person, and in a Syntra-front-door
  /// deployment a provisioned person routinely has no User at all.
  orgUnitId String?  @db.Uuid
  orgUnit   OrgUnit? @relation("PersonOrgUnit", fields: [orgUnitId], references: [id])
```

Add to `model TargetSystem` (beside the other threshold columns):

```prisma
  /// An ABSOLUTE count, not a share, and deliberately so.
  ///
  /// Every other guard axis is a percentage of an affected population.
  /// Containers have no population to be a percentage of: ten new containers
  /// against four people is not 250% of anything, because the denominator
  /// does not exist. Do not "fix" this into a percentage — the number it
  /// would produce has no meaning. The accident it prevents is a bulk OrgUnit
  /// import materialising a whole tree into the domain in one tick.
  maxContainerCreatesPerRun Int @default(5)
```

Add the new model:

```prisma
/// The container one OrgUnit corresponds to on one target.
///
/// An OrgUnit is tenant-wide and target-agnostic; a container is a
/// distinguished name under a particular target's base. This row is the join,
/// and it is what lets a run compare what Syntra intends against what the
/// target holds. Without it the intent lives only in the shape of the tree,
/// and a container renamed or removed behind Syntra's back is undetectable.
model OrgUnitContainer {
  id             String       @id @default(uuid()) @db.Uuid
  tenantId       String       @db.Uuid
  tenant         Tenant       @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  orgUnitId      String       @db.Uuid
  orgUnit        OrgUnit      @relation(fields: [orgUnitId], references: [id], onDelete: Cascade)
  targetSystemId String       @db.Uuid
  target         TargetSystem @relation(fields: [targetSystemId], references: [id], onDelete: Cascade)
  /// The DN Syntra intends. Validated once, on write, by
  /// `validateContainerDn` — never re-rendered per run, and never passed
  /// through `renderContainer`, because it is a literal an operator chose
  /// rather than a template with HR data in it.
  dn             String
  /// The target's identifier, once the target has confirmed the object.
  /// Null while `state` is 'desired'.
  anchor         String?
  /// 'desired' | 'live' | 'adopted'
  ///
  /// 'desired' — Syntra intends this container; the target has not confirmed
  ///   it. THE ONLY STATE FROM WHICH `create_container` MAY BE EMITTED.
  /// 'live'    — Provision created it and holds its anchor.
  /// 'adopted' — it already existed at the target and Syntra bound to it.
  ///
  /// 'live' and 'adopted' behave identically at run time. They are
  /// distinguished because "we made this" and "this was already here" are
  /// different answers to the question somebody asks when a container turns
  /// up in a domain nobody expected it in.
  state          String       @default("desired")
  createdAt      DateTime     @default(now())
  updatedAt      DateTime     @updatedAt

  @@unique([tenantId, orgUnitId, targetSystemId])
  @@unique([tenantId, targetSystemId, dn])
  @@index([tenantId])
}
```

Add `orgUnitContainers OrgUnitContainer[]` to `model TargetSystem` and to `model Tenant`.

- [ ] **Step 2: Write the migration SQL**

Create `packages/db/prisma/migrations/20260921000000_org_unit_container/migration.sql`. Copy the RLS stanza from an existing migration (`20260912000000_account_placement/migration.sql`) so the policy names and role match exactly.

```sql
CREATE TABLE "OrgUnitContainer" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "orgUnitId" UUID NOT NULL,
    "targetSystemId" UUID NOT NULL,
    "dn" TEXT NOT NULL,
    "anchor" TEXT,
    "state" TEXT NOT NULL DEFAULT 'desired',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OrgUnitContainer_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OrgUnitContainer_tenantId_orgUnitId_targetSystemId_key"
    ON "OrgUnitContainer"("tenantId", "orgUnitId", "targetSystemId");
CREATE UNIQUE INDEX "OrgUnitContainer_tenantId_targetSystemId_dn_key"
    ON "OrgUnitContainer"("tenantId", "targetSystemId", "dn");
CREATE INDEX "OrgUnitContainer_tenantId_idx" ON "OrgUnitContainer"("tenantId");

ALTER TABLE "OrgUnitContainer" ADD CONSTRAINT "OrgUnitContainer_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrgUnitContainer" ADD CONSTRAINT "OrgUnitContainer_orgUnitId_fkey"
    FOREIGN KEY ("orgUnitId") REFERENCES "OrgUnit"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrgUnitContainer" ADD CONSTRAINT "OrgUnitContainer_targetSystemId_fkey"
    FOREIGN KEY ("targetSystemId") REFERENCES "TargetSystem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OrgUnitContainer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OrgUnitContainer" FORCE ROW LEVEL SECURITY;
CREATE POLICY "OrgUnitContainer_tenant_isolation" ON "OrgUnitContainer"
    USING ("tenantId" = current_setting('app.tenant_id', true)::uuid)
    WITH CHECK ("tenantId" = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "Person" ADD COLUMN "orgUnitId" UUID;
ALTER TABLE "Person" ADD CONSTRAINT "Person_orgUnitId_fkey"
    FOREIGN KEY ("orgUnitId") REFERENCES "OrgUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "TargetSystem" ADD COLUMN "maxContainerCreatesPerRun" INTEGER NOT NULL DEFAULT 5;
```

Verify the `current_setting` expression and policy naming against `20260912000000_account_placement/migration.sql` before running; if that file uses a different form, match it rather than this sketch.

- [ ] **Step 3: Write the failing RLS test**

Append to `packages/db/src/rls.test.ts`, following the shape of the existing `AccountPlacement` case in that file:

```ts
it('refuses to return another tenant\'s OrgUnitContainer rows', async () => {
  const dn = 'OU=Sales,OU=Users,DC=acme,DC=test';
  const created = await withTenant(tenantA, (tx) =>
    tx.orgUnitContainer.create({
      data: {
        tenantId: tenantA,
        orgUnitId: orgUnitA,
        targetSystemId: targetA,
        dn,
      },
    }),
  );
  expect(created.state).toBe('desired');
  expect(created.anchor).toBeNull();

  // The query is written WITHOUT a tenant filter on purpose: the point is
  // that the database refuses it, not that the application remembered to ask.
  const leaked = await withTenant(tenantB, (tx) =>
    tx.orgUnitContainer.findMany({}),
  );
  expect(leaked).toEqual([]);
});
```

- [ ] **Step 4: Run the migration and generate the client**

```bash
pnpm db:up
pnpm --filter @syntra/db exec prisma migrate dev --name org_unit_container
pnpm --filter @syntra/db exec prisma generate
```

Note: `prisma migrate dev` will want to author its own migration directory. If it does, delete the hand-written one and keep Prisma's, then re-add the RLS stanza and the `FORCE ROW LEVEL SECURITY` lines to Prisma's file — Prisma does not emit those.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @syntra/db test -- rls`
Expected: PASS, including the new case.

- [ ] **Step 6: Commit**

```bash
git add packages/db/prisma/schema.prisma packages/db/prisma/migrations packages/db/src/rls.test.ts
git commit -m "feat(db): OrgUnitContainer, Person.orgUnitId and a container-create cap"
```

---

### Task 2: `validateContainerDn` and the materialisation service

**Files:**
- Create: `packages/core/src/provision/org-unit-container-service.ts`
- Create: `packages/core/src/provision/org-unit-container-service.test.ts`

**Interfaces:**
- Consumes: `withTenant`, `TenantClient` from `@syntra/db`; `targetContainers`, `MasterKeyProvider` from `./placement-service.js`; `recordEvent` from `../audit/audit-service.js`.
- Produces:
  - `validateContainerDn(dn: string, baseDn: string): { ok: true; dn: string } | { ok: false; reason: 'malformed' | 'outside_base'; message: string }`
  - `materialiseOrgUnit(tenantId, provider, input: MaterialiseInput): Promise<MaterialiseOutcome>`
  - `unmaterialiseOrgUnit(tenantId, input: { orgUnitId: string; targetSystemId: string; actorUserId: string | null }): Promise<boolean>`
  - `containersForTarget(tx: TenantClient, targetSystemId: string): Promise<Map<string, { id: string; dn: string; state: string }>>` — keyed by `orgUnitId`
  - `interface MaterialiseInput { orgUnitId: string; targetSystemId: string; dn: string; actorUserId: string | null; sourceIp: string | null }`
  - `type MaterialiseOutcome = { ok: true; state: 'desired' | 'adopted'; dn: string } | { ok: false; reason: 'malformed' | 'outside_base' | 'no_such_unit' | 'no_such_target' | 'dn_taken'; message: string }`

- [ ] **Step 1: Write the failing tests**

Create `packages/core/src/provision/org-unit-container-service.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { validateContainerDn } from './org-unit-container-service.js';

const base = 'OU=Users,OU=Syntra,DC=ssander,DC=local';

describe('validateContainerDn', () => {
  it('accepts a DN one level below the base', () => {
    const result = validateContainerDn(`OU=Sales,${base}`, base);
    expect(result).toEqual({ ok: true, dn: `OU=Sales,${base}` });
  });

  it('accepts the base itself, which is where an adopted root unit sits', () => {
    expect(validateContainerDn(base, base)).toEqual({ ok: true, dn: base });
  });

  it('refuses a DN outside the base', () => {
    // The failure this closes: a materialisation pointing at CN=Users, or at
    // another domain's subtree, would have Provision writing where the target
    // configuration never said it could.
    const result = validateContainerDn('CN=Users,DC=ssander,DC=local', base);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('outside_base');
  });

  it('refuses a DN that is not a DN', () => {
    const result = validateContainerDn('Sales', base);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('malformed');
  });

  it('refuses an empty DN rather than treating it as the base', () => {
    const result = validateContainerDn('   ', base);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('malformed');
  });

  it('compares case-insensitively, because DNs are', () => {
    const result = validateContainerDn(`ou=sales,${base.toUpperCase()}`, base);
    expect(result.ok).toBe(true);
  });

  it('refuses a suffix that merely looks like the base', () => {
    // `OU=Evil,OU=NotUsers,OU=Syntra,...` ends with a STRING that contains the
    // base's tail but is not below it. A naive endsWith() accepts this.
    const result = validateContainerDn(
      'OU=Evil,OU=XUsers,OU=Syntra,DC=ssander,DC=local',
      base,
    );
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/core/src/provision/org-unit-container-service.test.ts`
Expected: FAIL — `Failed to resolve import "./org-unit-container-service.js"`.

- [ ] **Step 3: Implement `validateContainerDn`**

Create `packages/core/src/provision/org-unit-container-service.ts`. Use the existing DN parser rather than writing a second one — check `packages/connectors/src/ldap/dn.ts` first and export from there if it already parses RDN sequences; otherwise implement locally as below.

```ts
/**
 * Validates a container DN against the target's base, once, on write.
 *
 * Steps 3 and 4 of the placement ladder go through `renderContainer`, which
 * escapes every substituted value (Ruling P22). This rung does not, and must
 * not: the DN is a stored literal an operator chose, and there is nothing in
 * it to interpolate. The obligation therefore moves HERE — validated once
 * when the row is written rather than re-checked on every run, because the
 * value is operator-supplied once and read thousands of times.
 *
 * The base check is on RDN boundaries, not on string suffix. `OU=Evil,
 * OU=XUsers,OU=Syntra,DC=…` ends with a string containing the base's tail
 * while sitting nowhere below it, and `endsWith` accepts exactly that.
 */
export function validateContainerDn(
  dn: string,
  baseDn: string,
):
  | { ok: true; dn: string }
  | { ok: false; reason: 'malformed' | 'outside_base'; message: string } {
  const trimmed = dn.trim();
  if (trimmed === '') {
    return { ok: false, reason: 'malformed', message: 'a container DN is required' };
  }

  const rdns = splitRdns(trimmed);
  if (rdns === null) {
    return {
      ok: false,
      reason: 'malformed',
      message: `${trimmed} is not a distinguished name`,
    };
  }

  const baseRdns = splitRdns(baseDn.trim());
  if (baseRdns === null || baseRdns.length === 0) {
    return {
      ok: false,
      reason: 'malformed',
      message: 'the target has no usable base DN to validate against',
    };
  }

  if (rdns.length < baseRdns.length) {
    return {
      ok: false,
      reason: 'outside_base',
      message: `${trimmed} is not below the target's base ${baseDn}`,
    };
  }

  const tail = rdns.slice(rdns.length - baseRdns.length);
  const matches = tail.every(
    (rdn, index) => rdn.toLowerCase() === baseRdns[index]!.toLowerCase(),
  );
  if (!matches) {
    return {
      ok: false,
      reason: 'outside_base',
      message: `${trimmed} is not below the target's base ${baseDn}`,
    };
  }

  return { ok: true, dn: trimmed };
}

/**
 * Splits a DN into RDNs on unescaped commas. `null` for anything that is not
 * a sequence of `attr=value` pairs.
 */
function splitRdns(dn: string): string[] | null {
  const parts: string[] = [];
  let current = '';
  let escaped = false;
  for (const character of dn) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === '\\') {
      current += character;
      escaped = true;
      continue;
    }
    if (character === ',') {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += character;
  }
  if (escaped) return null;
  parts.push(current.trim());

  if (parts.some((part) => !/^[A-Za-z][\w-]*=.+$/.test(part))) return null;
  return parts;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/core/src/provision/org-unit-container-service.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Implement the service functions**

Append to `org-unit-container-service.ts`:

```ts
export interface MaterialiseInput {
  orgUnitId: string;
  targetSystemId: string;
  dn: string;
  actorUserId: string | null;
  sourceIp: string | null;
}

export type MaterialiseOutcome =
  | { ok: true; state: 'desired' | 'adopted'; dn: string }
  | {
      ok: false;
      reason: 'malformed' | 'outside_base' | 'no_such_unit' | 'no_such_target' | 'dn_taken';
      message: string;
    };

/**
 * Binds one OrgUnit to one container on one target.
 *
 * Reads the target's live inventory first and ADOPTS rather than intends when
 * the container is already there. Adoption is not an optimisation: two
 * operators materialising the same unit, and a re-materialise after somebody
 * made the OU by hand, both land here, and both should heal rather than
 * propose a create that will come back `conflict`.
 *
 * Writes the row and nothing else. The directory write, when one is needed,
 * happens in a provisioning run under the guard — which is the whole reason
 * creation lives in Provision rather than on the source-writeback path.
 */
export async function materialiseOrgUnit(
  tenantId: string,
  provider: MasterKeyProvider,
  input: MaterialiseInput,
): Promise<MaterialiseOutcome> {
  const context = await withTenant(tenantId, async (tx) => {
    const unit = await tx.orgUnit.findUnique({
      where: { id: input.orgUnitId },
      select: { id: true, name: true },
    });
    const target = await tx.targetSystem.findUnique({
      where: { id: input.targetSystemId },
      select: { id: true, config: true },
    });
    return { unit, target };
  });

  if (context.unit === null) {
    return { ok: false, reason: 'no_such_unit', message: 'no such org unit' };
  }
  if (context.target === null) {
    return { ok: false, reason: 'no_such_target', message: 'no such target' };
  }

  const config = context.target.config as Record<string, unknown>;
  const baseDn = typeof config.baseDn === 'string' ? config.baseDn : '';
  const validated = validateContainerDn(input.dn, baseDn);
  if (!validated.ok) return validated;

  // Network I/O, so no transaction is held across it.
  const existing = await targetContainers(tenantId, provider, input.targetSystemId);
  const present = new Set(existing.map((dn) => dn.trim().toLowerCase()));
  const state = present.has(validated.dn.toLowerCase()) ? 'adopted' : 'desired';

  try {
    await withTenant(tenantId, async (tx) => {
      await tx.orgUnitContainer.upsert({
        where: {
          tenantId_orgUnitId_targetSystemId: {
            tenantId,
            orgUnitId: input.orgUnitId,
            targetSystemId: input.targetSystemId,
          },
        },
        create: {
          tenantId,
          orgUnitId: input.orgUnitId,
          targetSystemId: input.targetSystemId,
          dn: validated.dn,
          state,
        },
        // A re-materialise re-reads the target, so it is also how a row that
        // drifted back into existence heals from 'desired' to 'adopted'.
        update: { dn: validated.dn, state },
      });
      await recordEvent(tx, {
        actorUserId: input.actorUserId,
        action: 'orgUnit.materialise',
        targetType: 'OrgUnit',
        targetId: input.orgUnitId,
        outcome: 'success',
        sourceIp: input.sourceIp,
        payload: { dn: validated.dn, state, targetSystemId: input.targetSystemId },
      });
    });
  } catch (cause) {
    // The [tenantId, targetSystemId, dn] unique index. Two OrgUnits claiming
    // one DN would converge two departments' accounts into one container with
    // no error anywhere, so the database refuses it and so does this.
    if (isUniqueViolation(cause)) {
      return {
        ok: false,
        reason: 'dn_taken',
        message: `${validated.dn} is already materialised by another org unit on this target`,
      };
    }
    throw cause;
  }

  return { ok: true, state, dn: validated.dn };
}

export async function unmaterialiseOrgUnit(
  tenantId: string,
  input: { orgUnitId: string; targetSystemId: string; actorUserId: string | null },
): Promise<boolean> {
  return withTenant(tenantId, async (tx) => {
    const { count } = await tx.orgUnitContainer.deleteMany({
      where: { orgUnitId: input.orgUnitId, targetSystemId: input.targetSystemId },
    });
    if (count > 0) {
      await recordEvent(tx, {
        actorUserId: input.actorUserId,
        action: 'orgUnit.unmaterialise',
        targetType: 'OrgUnit',
        targetId: input.orgUnitId,
        outcome: 'success',
        sourceIp: null,
        payload: { targetSystemId: input.targetSystemId },
      });
    }
    return count > 0;
  });
}

/** Every materialisation on one target, keyed by `orgUnitId`. */
export async function containersForTarget(
  tx: TenantClient,
  targetSystemId: string,
): Promise<Map<string, { id: string; dn: string; state: string }>> {
  const rows = await tx.orgUnitContainer.findMany({
    where: { targetSystemId },
    select: { id: true, orgUnitId: true, dn: true, state: true },
  });
  return new Map(rows.map((r) => [r.orgUnitId, { id: r.id, dn: r.dn, state: r.state }]));
}

function isUniqueViolation(cause: unknown): boolean {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    (cause as { code?: unknown }).code === 'P2002'
  );
}
```

Add the imports at the top of the file:

```ts
import { withTenant, type TenantClient } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import { targetContainers } from './placement-service.js';
import type { MasterKeyProvider } from '../vault/master-key.js';
```

- [ ] **Step 6: Run the full core provision suite**

Run: `pnpm vitest run packages/core/src/provision`
Expected: PASS. Nothing else consumes this module yet.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/provision/org-unit-container-service.ts packages/core/src/provision/org-unit-container-service.test.ts
git commit -m "feat(provision): materialise an org unit against a target"
```

---

### Task 3: The placement ladder in `desiredState`

**Files:**
- Modify: `packages/core/src/provision/desired.ts:35-70` (the `DesiredStateInput` interface), `packages/core/src/provision/desired.ts:593-602` (container resolution)
- Test: `packages/core/src/provision/desired.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `DesiredStateInput.orgUnitContainer: string | null` — a **required** field. Every existing construction of `DesiredStateInput` must be updated, including every one in `desired.test.ts`, `plan.test.ts`, `run-service.ts:868` and `explain.ts`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/src/provision/desired.test.ts`. Reuse whatever `baseInput()` helper the file already defines; if it does not define one, add these tests using the same literal-input style the neighbouring tests use.

```ts
describe('the placement ladder', () => {
  it('uses the org unit container when there is no override', () => {
    const state = desiredState({
      ...baseInput(),
      orgUnitContainer: 'OU=Sales,OU=Users,DC=acme,DC=test',
      containerOverride: null,
    });
    expect(state.account?.container).toBe('OU=Sales,OU=Users,DC=acme,DC=test');
  });

  it('lets a manual override beat the org unit container', () => {
    // The rung order IS the feature: an override is a decision somebody
    // recorded a reason for, and an OU assignment is a rule. If the rule won,
    // the five-minute tick would drag a moved account back to its department
    // and the Move button would be a lie.
    const state = desiredState({
      ...baseInput(),
      orgUnitContainer: 'OU=Sales,OU=Users,DC=acme,DC=test',
      containerOverride: 'OU=Contractors,OU=Users,DC=acme,DC=test',
    });
    expect(state.account?.container).toBe('OU=Contractors,OU=Users,DC=acme,DC=test');
  });

  it('falls to the template when the person has no org unit container', () => {
    const state = desiredState({
      ...baseInput(),
      orgUnitContainer: null,
      containerOverride: null,
    });
    // baseInput()'s profile renders `OU=Users,DC=acme,DC=test`.
    expect(state.account?.container).toBe('OU=Users,DC=acme,DC=test');
  });

  it('does not consult the fallback when an org unit container is set', () => {
    // A profile whose template cannot render. Without the ladder this person
    // lands in the fallback; with it, the OU assignment answers first and the
    // unrenderable template is never reached.
    const input = baseInput();
    const state = desiredState({
      ...input,
      profile: {
        ...input.profile,
        containerTemplate: 'OU=%contract.department%,DC=acme,DC=test',
        fallbackContainer: 'OU=Unsorted,DC=acme,DC=test',
      },
      contracts: [{ ...input.contracts[0]!, department: null }],
      orgUnitContainer: 'OU=Sales,OU=Users,DC=acme,DC=test',
      containerOverride: null,
    });
    expect(state.account?.container).toBe('OU=Sales,OU=Users,DC=acme,DC=test');
  });

  it('ignores an org unit container that is only whitespace', () => {
    const state = desiredState({
      ...baseInput(),
      orgUnitContainer: '   ',
      containerOverride: null,
    });
    expect(state.account?.container).toBe('OU=Users,DC=acme,DC=test');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/core/src/provision/desired.test.ts`
Expected: FAIL — TypeScript rejects the unknown property `orgUnitContainer`, and the ladder assertions fail.

- [ ] **Step 3: Add the field to `DesiredStateInput`**

In `desired.ts`, immediately after the `containerOverride` field and its docstring:

```ts
  /**
   * The DN of the container this person's OrgUnit is materialised at on THIS
   * target, or null when they have no OrgUnit, their OrgUnit is not
   * materialised here, or the row is not yet usable.
   *
   * Required rather than optional for the reason `containerOverride` is: an
   * optional field is one a run can forget to load, and a placement that
   * silently reverts to the template is indistinguishable from a person who
   * was never assigned.
   *
   * Ranks BELOW `containerOverride` and ABOVE the template. Not rendered and
   * not escaped — it is a stored literal validated once on write by
   * `validateContainerDn`, not a template with HR data in it (Ruling P22).
   */
  orgUnitContainer: string | null;
```

- [ ] **Step 4: Implement the ladder**

Replace the `const container = ...` expression at `desired.ts:597-602` with:

```ts
  // The placement ladder, most specific first. See Ruling P9 (revised): only
  // the `orgUnitContainer` rung is backed by an OrgUnitContainer row, and it
  // is therefore the only rung a `create_container` action can ever come
  // from. The template rungs render strings and hold no row.
  const orgUnitContainer =
    input.orgUnitContainer !== null && input.orgUnitContainer.trim() !== ''
      ? input.orgUnitContainer
      : null;
  const container =
    input.containerOverride !== null && input.containerOverride.trim() !== ''
      ? input.containerOverride
      : orgUnitContainer !== null
        ? orgUnitContainer
        : containerRendered.ok
          ? containerRendered.value
          : profile.fallbackContainer;
```

- [ ] **Step 5: Fix every other construction site**

TypeScript will now list them. Add `orgUnitContainer: null` to each existing `desiredState({...})` call and test fixture in:
- `packages/core/src/provision/desired.test.ts` (existing cases)
- `packages/core/src/provision/plan.test.ts`
- `packages/core/src/provision/explain.ts`
- `packages/core/src/provision/run-service.ts:868`

`run-service.ts` gets its real value in Task 9; `null` is correct until then.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm vitest run packages/core/src/provision && pnpm --filter @syntra/core exec tsc --noEmit`
Expected: PASS, and no type errors.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/provision
git commit -m "feat(provision): org unit container as a placement rung below the override"
```

---

### Task 4: The same ladder in `explain` and the onboarding preview

**Files:**
- Modify: `packages/core/src/provision/explain.ts:856`
- Modify: `packages/core/src/provision/preview-container.ts:50-110`
- Test: `packages/core/src/provision/explain.test.ts`, `packages/core/src/provision/preview-container.test.ts`

**Interfaces:**
- Consumes: `DesiredStateInput.orgUnitContainer` from Task 3.
- Produces: `previewContainerForFacts(tenantId, targetSystemId, facts, orgUnitContainer: string | null)` — a fourth positional parameter, required.

- [ ] **Step 1: Write the failing tests**

Add to `preview-container.test.ts`:

```ts
it('shows the org unit container rather than the rendered template', async () => {
  // This preview is the one screen where placement is checked while it is
  // still free to correct. A preview that disagrees with the run is worse
  // than no preview, because it is believed.
  const preview = await previewContainerForFacts(
    tenantId,
    targetSystemId,
    { givenName: 'Ada', familyName: 'Lovelace', department: 'Research' },
    'OU=Sales,OU=Users,DC=acme,DC=test',
  );
  expect(preview).toEqual({
    container: 'OU=Sales,OU=Users,DC=acme,DC=test',
    fallbackUsed: false,
    missing: [],
  });
});

it('renders the template when no org unit container is given', async () => {
  const preview = await previewContainerForFacts(
    tenantId,
    targetSystemId,
    { givenName: 'Ada', familyName: 'Lovelace', department: 'Research' },
    null,
  );
  expect(preview?.container).toBe('OU=Research,OU=Users,DC=acme,DC=test');
});
```

Add to `explain.test.ts`:

```ts
it('explains the container the ladder actually chose', async () => {
  const explanation = await explainPerson(/* existing fixture args */, {
    orgUnitContainer: 'OU=Sales,OU=Users,DC=acme,DC=test',
  });
  expect(explanation.container.value).toBe('OU=Sales,OU=Users,DC=acme,DC=test');
  expect(explanation.container.source).toBe('orgUnit');
});
```

Match `explainPerson`'s real signature and the real shape of its container field when writing this — read `explain.ts:840-880` first and adapt. If the explanation has no `source` discriminator today, add one with the values `'override' | 'orgUnit' | 'template' | 'fallback'`, because an explanation that names the value without naming which rung produced it does not explain anything.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/core/src/provision/preview-container.test.ts packages/core/src/provision/explain.test.ts`
Expected: FAIL — wrong arity on `previewContainerForFacts`, missing `source`.

- [ ] **Step 3: Implement**

In `preview-container.ts`, add the parameter and short-circuit before rendering:

```ts
export async function previewContainerForFacts(
  tenantId: string,
  targetSystemId: string,
  facts: ContainerPreviewFacts,
  orgUnitContainer: string | null,
): Promise<ContainerPreview | null> {
  // Step 2 of the ladder, and it short-circuits: there is no template to
  // render and nothing that could be missing.
  if (orgUnitContainer !== null && orgUnitContainer.trim() !== '') {
    return { container: orgUnitContainer, fallbackUsed: false, missing: [] };
  }
  // ... existing body unchanged
}
```

In `explain.ts:856`, apply the identical ladder to the one now in `desired.ts`, and set the `source` discriminator on each branch.

- [ ] **Step 4: Fix the callers**

`apps/api/src/routes/admin/persons.ts` (or wherever the onboarding preview endpoint lives — `grep -rn "previewContainerForFacts" apps/`) must pass the fourth argument. At this stage it passes `null`; Task 11 gives it the real value.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run packages/core/src/provision && pnpm exec tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/provision apps/api/src/routes/admin
git commit -m "feat(provision): explain and preview the container the ladder chose"
```

---

### Task 5: `create_container` action type and the absolute-count guard axis

**Files:**
- Modify: `packages/connectors/src/types.ts:56-78` (`ProvisionActionType`, `CONNECTOR_ACTION_TYPES`)
- Modify: `packages/core/src/provision/guard.ts:1-15` (`GuardThresholds`), `:133-205` (`POPULATIONS`, `THRESHOLD_KEYS`)
- Modify: `packages/core/src/provision/target-service.ts` (the target write schema)
- Modify: `packages/contracts/src/provision.ts`
- Test: `packages/core/src/provision/guard.test.ts`

**Interfaces:**
- Consumes: `TargetSystem.maxContainerCreatesPerRun` from Task 1.
- Produces: `ProvisionActionType` includes `'create_container'`; `CONNECTOR_ACTION_TYPES` starts with it; `GuardInput` unchanged; `GuardThresholds.maxContainerCreatesPerRun: number`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/src/provision/guard.test.ts`:

```ts
describe('the container-create cap', () => {
  it('allows a run at the cap', () => {
    const result = guard({
      ...baseGuardInput(),
      actions: containerCreates(5),
      thresholds: { ...baseThresholds(), maxContainerCreatesPerRun: 5 },
    });
    expect(result.blocked).toBe(false);
  });

  it('blocks a run one over the cap', () => {
    const result = guard({
      ...baseGuardInput(),
      actions: containerCreates(6),
      thresholds: { ...baseThresholds(), maxContainerCreatesPerRun: 5 },
    });
    expect(result.blocked).toBe(true);
    expect(result.reasons.join(' ')).toContain('6');
  });

  it('is an absolute count and not a share', () => {
    // The distinguishing test. Every other axis is a percentage of a
    // population; containers have no denominator, so ten containers against
    // four people is not 250% of anything. A future reader "fixing" this into
    // a percentage breaks this test, which is the point of it.
    const result = guard({
      ...baseGuardInput(),
      accountsAtTarget: 10_000,
      actions: containerCreates(6),
      thresholds: { ...baseThresholds(), maxContainerCreatesPerRun: 5 },
    });
    // A share-based axis would wave 6 containers through against 10,000
    // accounts. An absolute cap does not.
    expect(result.blocked).toBe(true);
  });

  it('blocks the whole run rather than applying a partial tree', () => {
    const result = guard({
      ...baseGuardInput(),
      actions: [...containerCreates(6), accountCreate()],
      thresholds: { ...baseThresholds(), maxContainerCreatesPerRun: 5 },
    });
    expect(result.blocked).toBe(true);
  });
});

function containerCreates(count: number): PlannedAction[] {
  return Array.from({ length: count }, (_unused, index) => ({
    actionType: 'create_container' as const,
    personId: null,
    accountId: null,
    entitlementId: null,
    before: null,
    after: { dn: `OU=Unit${index},OU=Users,DC=acme,DC=test` },
    attributedRuleIds: [],
    attributedGrantIds: [],
    requiresConfirmation: false,
    message: null,
    revocationOrderId: null,
  }));
}
```

The existing exhaustiveness test in this file — the one asserting `GUARDED_ACTION_TYPES` plus the deliberately-unguarded set covers `ProvisionActionType` — will now fail until `create_container` is accounted for. That failure is the safety net working; do not weaken the test.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/core/src/provision/guard.test.ts`
Expected: FAIL, including the pre-existing exhaustiveness test.

- [ ] **Step 3: Add the action type**

In `packages/connectors/src/types.ts`:

```ts
export type ProvisionActionType =
  | 'create_container'
  | 'create_account'
  // ... the rest unchanged

/** The nine that reach a connector, in the order enforcement applies them. */
export const CONNECTOR_ACTION_TYPES = [
  // First, and not alphabetically: a container must exist before an account
  // can be created in it or moved into it.
  'create_container',
  'create_account',
  // ... the rest unchanged
] as const satisfies readonly ProvisionActionType[];
```

Update the "eight that reach a connector" wording in that docstring to nine, and extend the `ProvisionActionType` docstring: `create_container` carries no `personId`, and is the one action that names an object rather than a person.

- [ ] **Step 4: Add the guard axis**

In `guard.ts`, add to `GuardThresholds`:

```ts
  /** An ABSOLUTE count. See the schema comment on the column. */
  maxContainerCreatesPerRun: number;
```

Add `'maxContainerCreatesPerRun'` to `THRESHOLD_KEYS`.

`POPULATIONS` is share-shaped and this axis is not, so it does not go in that array. Add a separate check beside the population loop:

```ts
/**
 * The container-create cap: an absolute count, deliberately not a share.
 *
 * `POPULATIONS` measures each action type against a denominator. Containers
 * have none — ten new containers against four people is not 250% of
 * anything, because there is no population of containers the run is a
 * fraction of. Do not move this into `POPULATIONS` by inventing one.
 *
 * The accident it prevents is real and is not a share either: a bulk OrgUnit
 * import, or a script materialising a whole tree, putting a hundred
 * containers into a domain in one tick.
 *
 * Blocks the whole run rather than trimming to the cap. Half a tree is a
 * worse state than none of it: accounts would be placed under the containers
 * that made the cut and unprocessable under the ones that did not, and the
 * next run would propose the remainder against a population that had already
 * shifted.
 */
function checkContainerCap(input: GuardInput): string | null {
  const proposed = input.actions.filter(
    (a) => a.actionType === 'create_container',
  ).length;
  if (proposed <= input.thresholds.maxContainerCreatesPerRun) return null;
  return (
    `this run would create ${proposed} containers, and the limit is ` +
    `${input.thresholds.maxContainerCreatesPerRun} per run ` +
    `(maxContainerCreatesPerRun — an absolute count, not a percentage)`
  );
}
```

Call it where the population reasons are collected, appending its non-null result to the same `reasons` array so it blocks by the same path.

Add `create_container` to the guarded set for the exhaustiveness test — export it from a new `const ABSOLUTE_CAP_ACTION_TYPES: readonly ProvisionActionType[] = ['create_container']` and have the test treat guarded = `GUARDED_ACTION_TYPES ∪ ABSOLUTE_CAP_ACTION_TYPES`.

- [ ] **Step 5: Thread the threshold through**

- `target-service.ts:887` region — add `maxContainerCreatesPerRun: z.number().int().min(0).max(1000).default(5)` to the target write schema.
- `packages/contracts/src/provision.ts` — add the same field so the console can read and write it.
- Wherever `GuardThresholds` is constructed from a `TargetSystem` row (grep `archiveAccountThresholdPercent:` in `run-service.ts`), add `maxContainerCreatesPerRun: target.maxContainerCreatesPerRun`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm vitest run packages/core packages/connectors packages/contracts && pnpm exec tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add packages/connectors/src/types.ts packages/core/src/provision packages/contracts/src/provision.ts
git commit -m "feat(provision): create_container action and an absolute per-run cap"
```

---

### Task 6: `createContainer` on the target connector

**Files:**
- Modify: `packages/connectors/src/types.ts:337-379` (`TargetConnector`)
- Modify: `packages/connectors/src/ad/connector.ts`
- Modify: `packages/connectors/src/testing/` (the fake target connector)
- Test: `packages/connectors/src/ad/connector.integration.test.ts`

**Interfaces:**
- Consumes: `WriteResult`, `WriteFailure` from `types.ts`.
- Produces: `TargetConnector.createContainer(config: C, input: { dn: string }): Promise<WriteResult>`.

- [ ] **Step 1: Write the failing integration tests**

Add to `packages/connectors/src/ad/connector.integration.test.ts`, using the Samba domain controller already configured in `infra/docker-compose.yml` (`SYNTRA.TEST`, LDAPS on 636) and following the connection setup the neighbouring tests in that file use.

```ts
describe('createContainer', () => {
  it('creates a container and returns its anchor', async () => {
    const dn = `OU=PlanTest${Date.now()},${baseDn}`;
    const result = await adConnector.createContainer(config, { dn });
    expect(result.ok).toBe(true);
    expect(result.anchor).toMatch(/./);

    const seen: string[] = [];
    for await (const container of adConnector.listContainers(config)) {
      seen.push(container.dn.toLowerCase());
    }
    expect(seen).toContain(dn.toLowerCase());
  });

  it('reports conflict for a container that already exists', async () => {
    // Adoption, not an error. Two operators materialising the same unit, and
    // a re-materialise after somebody made the OU by hand, both land here.
    const dn = `OU=PlanDup${Date.now()},${baseDn}`;
    await adConnector.createContainer(config, { dn });
    const second = await adConnector.createContainer(config, { dn });
    expect(second.ok).toBe(false);
    expect(second.failure).toBe('conflict');
  });

  it('reports not_found for a missing parent and does not invent it', async () => {
    // Creating intermediate parents is exactly the implicit creation Ruling
    // P9 forbids. One level, or nothing.
    const dn = `OU=Child,OU=NoSuchParent${Date.now()},${baseDn}`;
    const result = await adConnector.createContainer(config, { dn });
    expect(result.ok).toBe(false);
    expect(result.failure).toBe('not_found');

    const seen: string[] = [];
    for await (const container of adConnector.listContainers(config)) {
      seen.push(container.dn.toLowerCase());
    }
    expect(seen.some((d) => d.includes('nosuchparent'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm db:up
pnpm vitest run packages/connectors/src/ad/connector.integration.test.ts
```

Expected: FAIL — `adConnector.createContainer is not a function`.

Note: the Samba container requires `privileged: true`. If it will not start on this host, run these tests where it can; do not stub the integration test out.

- [ ] **Step 3: Add the interface method**

In `types.ts`, inside `TargetConnector`, after `listContainers`:

```ts
  /**
   * Creates one container at the target.
   *
   * Reached only from an `OrgUnitContainer` row in state 'desired' — Ruling
   * P9 (revised). Provision still never creates a container implicitly; this
   * exists so that a container an administrator explicitly asked for can be
   * made, and for no other reason.
   *
   * An implementation MUST NOT create intermediate parents. Inventing the
   * tree above a container is precisely the implicit creation the ruling
   * forbids, and it is how one typo in a DN becomes three containers nobody
   * asked for. A missing parent is `not_found`.
   *
   * `conflict` — the DN already exists. The caller treats this as success by
   * adoption, so an implementation must return it rather than throwing.
   */
  createContainer(config: C, input: { dn: string }): Promise<WriteResult>;
```

- [ ] **Step 4: Implement it on the AD connector**

In `packages/connectors/src/ad/connector.ts`, following the file's existing bind/error-classification helpers:

```ts
  async createContainer(rawConfig, input: { dn: string }): Promise<WriteResult> {
    const config = normalise(rawConfig);
    const client = await connect(config);
    try {
      const rdn = input.dn.split(',')[0] ?? '';
      const name = rdn.slice(rdn.indexOf('=') + 1);
      await client.add(input.dn, {
        objectClass: ['top', 'organizationalUnit'],
        ou: name,
      });
      // Read the anchor back rather than assuming one. The add response does
      // not carry the objectGUID, and a container recorded without its anchor
      // is one drift detection cannot follow across a rename.
      const { searchEntries } = await client.search(input.dn, {
        scope: 'base',
        filter: '(objectClass=organizationalUnit)',
        attributes: [config.anchorAttribute],
      });
      const entry = searchEntries[0] as unknown as Record<string, unknown>;
      const rawAnchor = entry?.[config.anchorAttribute];
      const anchor = anchorToString(Array.isArray(rawAnchor) ? rawAnchor[0] : rawAnchor);
      return { ok: true, message: `created ${input.dn}`, ...(anchor ? { anchor } : {}) };
    } catch (cause) {
      const failure = classifyWriteError(cause);
      return { ok: false, failure, message: describeWriteError(cause) };
    } finally {
      await client.unbind();
    }
  },
```

`classifyWriteError` must map LDAP result code 68 (`entryAlreadyExists`) to `conflict` and 32 (`noSuchObject`) to `not_found`. Check whether `classifyWritebackError` in `ldap/writeback.ts:62` already does this and reuse it if so rather than writing a second classifier.

- [ ] **Step 5: Implement it on the fake connector**

The fake in `packages/connectors/src/testing/` backs the unit tests for `apply.ts` and `run-service.ts`. Give it an in-memory container set, and make it return `conflict` for a DN already present and `not_found` when the parent DN is absent — the fake must be able to exercise every branch the real one has, or those branches are untested.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm vitest run packages/connectors`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/connectors
git commit -m "feat(connectors): createContainer, one level, never a parent"
```

---

### Task 7: The Ruling P9 fork in `reconcile.ts`

**Files:**
- Modify: `packages/core/src/provision/reconcile.ts:20-40` (`ReconcileInput`), `:270-290` (the container check)
- Test: `packages/core/src/provision/reconcile.test.ts`

**Interfaces:**
- Consumes: `containersForTarget` shape from Task 2, `create_container` from Task 5.
- Produces: `ReconcileInput.desiredContainerRows: ReadonlyMap<string, { id: string; state: string }>` — keyed by **lowercased DN**.

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/src/provision/reconcile.test.ts`:

```ts
describe('Ruling P9, narrowed', () => {
  const dn = 'OU=Sales,OU=Users,DC=acme,DC=test';

  it('emits create_container for a missing container backed by a desired row', () => {
    const result = reconcile({
      ...baseReconcileInput(),
      existingContainers: new Set<string>(),
      desiredContainers: new Map([['person-1', dn]]),
      desiredContainerRows: new Map([
        [dn.toLowerCase(), { id: 'ouc-1', state: 'desired' }],
      ]),
    });
    expect(result.actions.map((a) => a.actionType)).toContain('create_container');
    expect(result.unprocessable.get('person-1')).toBeUndefined();
  });

  it('leaves an unbacked missing container unprocessable at scope all', () => {
    // The other half of the ruling, and the more important half. These two
    // tests differ in ONE row. Without this one, `create_container` reads as a
    // licence to auto-vivify from %contract.department%, which is the mass
    // action the subsystem exists to prevent.
    const result = reconcile({
      ...baseReconcileInput(),
      existingContainers: new Set<string>(),
      desiredContainers: new Map([['person-1', dn]]),
      desiredContainerRows: new Map(),
    });
    expect(result.actions.map((a) => a.actionType)).not.toContain('create_container');
    expect(result.unprocessable.get('person-1')?.kind).toBe('container_missing');
  });

  it('does not re-create a container whose row is already live', () => {
    // Somebody deleted it in the directory. Re-creating it on the next tick
    // is Syntra silently fighting a domain administrator, indefinitely and
    // invisibly. It is a finding, not an action.
    const result = reconcile({
      ...baseReconcileInput(),
      existingContainers: new Set<string>(),
      desiredContainers: new Map([['person-1', dn]]),
      desiredContainerRows: new Map([
        [dn.toLowerCase(), { id: 'ouc-1', state: 'live' }],
      ]),
    });
    expect(result.actions.map((a) => a.actionType)).not.toContain('create_container');
    expect(result.unprocessable.get('person-1')?.kind).toBe('container_missing');
  });

  it('emits one create_container for two people sharing a container', () => {
    const result = reconcile({
      ...baseReconcileInput({ personIds: ['person-1', 'person-2'] }),
      existingContainers: new Set<string>(),
      desiredContainers: new Map([
        ['person-1', dn],
        ['person-2', dn],
      ]),
      desiredContainerRows: new Map([
        [dn.toLowerCase(), { id: 'ouc-1', state: 'desired' }],
      ]),
    });
    const creates = result.actions.filter((a) => a.actionType === 'create_container');
    expect(creates).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/core/src/provision/reconcile.test.ts`
Expected: FAIL — unknown property `desiredContainerRows`.

- [ ] **Step 3: Add the input**

In `ReconcileInput`, beside `desiredContainers`:

```ts
  /**
   * Every `OrgUnitContainer` row for this target, keyed by LOWERCASED dn.
   *
   * This map is the whole of Ruling P9 (revised). A container absent from the
   * target and present here in state 'desired' is one an administrator asked
   * for, and gets created. A container absent from both is one a template
   * invented, and does not.
   */
  desiredContainerRows: ReadonlyMap<string, { id: string; state: string }>;
```

- [ ] **Step 4: Implement the fork**

Replace the body of the `if (state.account?.required)` block at `reconcile.ts:273-288`:

```ts
      const container =
        input.desiredContainers.get(state.personId) ?? state.account.container;
      if (
        container.trim() !== '' &&
        !existingContainers.has(container.trim().toLowerCase())
      ) {
        const row = input.desiredContainerRows.get(container.trim().toLowerCase());
        if (row !== undefined && row.state === 'desired') {
          // Ruling P9 (revised): an administrator explicitly materialised this
          // unit, so the container is created rather than the person dropped.
          // Deduplicated by DN — a department of forty people is one create.
          if (!containerCreates.has(row.id)) {
            containerCreates.set(row.id, container);
          }
        } else {
          // Every other case, verbatim as before. A row in 'live' or
          // 'adopted' whose container has vanished is drift, not a licence to
          // re-create: see the drift finding raised in Task 10.
          extraUnprocessable.set(state.personId, {
            kind: 'container_missing',
            message: `the container ${container} does not exist in the target; Provision does not create it`,
          });
          continue;
        }
      }
```

Declare `const containerCreates = new Map<string, string>();` beside the other accumulators, and after the person loop emit one action per entry:

```ts
  for (const [orgUnitContainerId, dn] of containerCreates) {
    actions.push({
      actionType: 'create_container',
      // The one action that names an object rather than a person. Code that
      // assumes a personId must tolerate null here — see apply.ts's grouping.
      personId: null,
      accountId: null,
      entitlementId: null,
      before: null,
      after: { dn, orgUnitContainerId },
      attributedRuleIds: [],
      attributedGrantIds: [],
      requiresConfirmation: false,
      message: `create the container ${dn}`,
      revocationOrderId: null,
    });
  }
```

- [ ] **Step 5: Fix the other construction sites**

Add `desiredContainerRows: new Map()` to every existing `reconcile({...})` call in `reconcile.test.ts`, `run-service.ts` and `loop.integration.test.ts`. `run-service.ts` gets its real value in Task 9.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm vitest run packages/core/src/provision && pnpm exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/provision
git commit -m "feat(provision): create a container only where an operator asked for one"
```

---

### Task 8: Applying `create_container`

**Files:**
- Modify: `packages/core/src/provision/apply.ts:280-360` (the operation switch), `:1130-1200` (the per-action dispatch), `:740-800` (post-write bookkeeping)
- Test: `packages/core/src/provision/apply.test.ts`

**Interfaces:**
- Consumes: `createContainer` from Task 6; `create_container` actions from Task 7.
- Produces: on success the `OrgUnitContainer` row moves to `state: 'live'` with its `anchor`; on `conflict` it moves to `state: 'adopted'`; on any other failure it stays `desired`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/src/provision/apply.test.ts`:

```ts
describe('create_container', () => {
  it('marks the row live and records the anchor on success', async () => {
    const result = await applyActions(/* fixture */ {
      actions: [containerCreateAction('ouc-1', 'OU=Sales,OU=Users,DC=acme,DC=test')],
    });
    expect(result.applied).toBe(1);
    const row = await readOrgUnitContainer('ouc-1');
    expect(row.state).toBe('live');
    expect(row.anchor).not.toBeNull();
  });

  it('adopts on conflict rather than failing the run', async () => {
    // The container is already there. Two operators materialising the same
    // unit, or a re-materialise after somebody made the OU by hand, both
    // arrive here and both should heal.
    fakeTarget.containers.add('OU=Sales,OU=Users,DC=acme,DC=test');
    const result = await applyActions({
      actions: [containerCreateAction('ouc-1', 'OU=Sales,OU=Users,DC=acme,DC=test')],
    });
    expect(result.failed).toBe(0);
    const row = await readOrgUnitContainer('ouc-1');
    expect(row.state).toBe('adopted');
  });

  it('leaves the row desired when the parent is missing', async () => {
    // not_found is not retryable, and the intent must survive so an operator
    // can see what was asked for and fix the parent.
    const result = await applyActions({
      actions: [containerCreateAction('ouc-1', 'OU=Child,OU=Nope,DC=acme,DC=test')],
    });
    expect(result.failed).toBe(1);
    const row = await readOrgUnitContainer('ouc-1');
    expect(row.state).toBe('desired');
    expect(row.anchor).toBeNull();
  });

  it('applies the container before any account that lands in it', async () => {
    // CONNECTOR_ACTION_TYPES order is not cosmetic: an account created before
    // its container fails, and would fail every run.
    const order: string[] = [];
    fakeTarget.onWrite = (op) => order.push(op);
    await applyActions({
      actions: [
        accountCreateAction('person-1', 'OU=Sales,OU=Users,DC=acme,DC=test'),
        containerCreateAction('ouc-1', 'OU=Sales,OU=Users,DC=acme,DC=test'),
      ],
    });
    expect(order.indexOf('create_container')).toBeLessThan(order.indexOf('create_account'));
  });
});
```

Adapt the fixture helpers to whatever `apply.test.ts` already provides — read its existing setup before writing these.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/core/src/provision/apply.test.ts`
Expected: FAIL — no handler for `create_container`.

- [ ] **Step 3: Implement the operation**

In `apply.ts`'s action-to-operation switch (near `case 'create_account':` at `:288`):

```ts
    case 'create_container': {
      const dn = String((action.after as Record<string, unknown>)?.dn ?? '');
      return { op: 'create_container', dn };
    }
```

In the execution switch (near `:1137`):

```ts
        case 'create_container': {
          const result = await connector.createContainer(config, { dn: operation.dn });
          const orgUnitContainerId = String(
            (action.after as Record<string, unknown>)?.orgUnitContainerId ?? '',
          );
          if (result.ok) {
            await withTenant(tenantId, (tx) =>
              tx.orgUnitContainer.update({
                where: { id: orgUnitContainerId },
                data: {
                  state: 'live',
                  ...(result.anchor === undefined ? {} : { anchor: result.anchor }),
                },
              }),
            );
            return result;
          }
          if (result.failure === 'conflict') {
            // Success by adoption. The container is there; Syntra did not put
            // it there. Recorded as 'adopted' rather than 'live' because "we
            // made this" and "this was already here" are different answers to
            // the question somebody asks when a container turns up in a domain
            // nobody expected it in.
            await withTenant(tenantId, (tx) =>
              tx.orgUnitContainer.update({
                where: { id: orgUnitContainerId },
                data: { state: 'adopted' },
              }),
            );
            return { ok: true, message: `${operation.dn} already existed; adopted` };
          }
          // Every other failure leaves the row 'desired' untouched, so the
          // intent survives and the next run proposes it again through the
          // guard.
          return result;
        }
```

Audit the per-person grouping around `:1500` and the concurrency batching: `create_container` has `personId: null`, and any `groupBy(personId)` will collapse every container create into one bucket or drop them. Give container creates their own leading batch, applied before the person batches, which is also what `CONNECTOR_ACTION_TYPES` order requires.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/core/src/provision && pnpm exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/provision
git commit -m "feat(provision): apply create_container, adopting on conflict"
```

---

### Task 9: Wiring the run

**Files:**
- Modify: `packages/core/src/provision/run-service.ts:490-510` (container inventory), `:855-895` (`desiredState` inputs), and the `reconcile(...)` call
- Test: `packages/core/src/provision/run-service.test.ts`

**Interfaces:**
- Consumes: `containersForTarget` (Task 2), `orgUnitContainer` (Task 3), `desiredContainerRows` (Task 7).
- Produces: no new exports; the run now loads real values for both fields.

- [ ] **Step 1: Write the failing test**

Add to `run-service.test.ts`:

```ts
it('places a person in the container their org unit is materialised at', async () => {
  await seedOrgUnitContainer({
    orgUnitId: 'ou-sales',
    targetSystemId: target.id,
    dn: 'OU=Sales,OU=Users,DC=acme,DC=test',
    state: 'adopted',
  });
  await setPersonOrgUnit('person-1', 'ou-sales');
  fakeTarget.containers.add('OU=Sales,OU=Users,DC=acme,DC=test');

  const run = await executeRun(/* existing fixture args */);
  const create = run.actions.find((a) => a.actionType === 'create_account');
  expect((create?.after as { distinguishedName?: string })?.distinguishedName).toBe(
    'OU=Sales,OU=Users,DC=acme,DC=test',
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/core/src/provision/run-service.test.ts`
Expected: FAIL — the account is placed at the template's DN.

- [ ] **Step 3: Load the rows**

Beside the `existingContainers` block at `:497`:

```ts
    /**
     * Every OrgUnitContainer for this target, in two shapes: by orgUnitId for
     * the placement ladder, and by lowercased DN for Ruling P9 (revised).
     */
    const containersByOrgUnit = await withTenant(tenantId, (tx) =>
      containersForTarget(tx, prepared.target.id),
    );
    const desiredContainerRows = new Map(
      [...containersByOrgUnit.values()].map((row) => [
        row.dn.trim().toLowerCase(),
        { id: row.id, state: row.state },
      ]),
    );
```

Load each person's `orgUnitId` in the same query that already loads persons (add `orgUnitId: true` to its `select`), then in the `desiredState({...})` call at `:868`:

```ts
        orgUnitContainer:
          person.orgUnitId === null
            ? null
            : (containersByOrgUnit.get(person.orgUnitId)?.dn ?? null),
```

Pass `desiredContainerRows` to `reconcile({...})`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run packages/core && pnpm exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/provision
git commit -m "feat(provision): the run reads org unit containers"
```

---

### Task 10: Drift for a container that vanished

**Files:**
- Modify: `packages/core/src/provision/reconcile.ts` (finding emission)
- Test: `packages/core/src/provision/reconcile.test.ts`

**Interfaces:**
- Consumes: `desiredContainerRows` from Task 7.
- Produces: a `DriftFinding` of kind `container_vanished`.

- [ ] **Step 1: Write the failing test**

```ts
it('raises a finding for a live container the target no longer returns', () => {
  const result = reconcile({
    ...baseReconcileInput(),
    existingContainers: new Set<string>(),
    desiredContainers: new Map([['person-1', 'OU=Sales,OU=Users,DC=acme,DC=test']]),
    desiredContainerRows: new Map([
      ['ou=sales,ou=users,dc=acme,dc=test', { id: 'ouc-1', state: 'live' }],
    ]),
  });
  const finding = result.findings.find((f) => f.kind === 'container_vanished');
  expect(finding).toBeDefined();
  expect(finding?.detail).toContain('OU=Sales');
  // Emphatically NOT an action. Re-creating it every five-minute tick is
  // Syntra silently fighting a domain administrator.
  expect(result.actions.map((a) => a.actionType)).not.toContain('create_container');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/core/src/provision/reconcile.test.ts`
Expected: FAIL — no such finding.

- [ ] **Step 3: Implement**

In the `else` branch added in Task 7, before setting `container_missing`, when `row !== undefined && row.state !== 'desired'`, emit the finding through whatever `record(...)` helper the file already uses for `account_missing_at_target`, with kind `container_vanished` and a detail naming the DN and the row id. Keep the `container_missing` unprocessable as well: the person genuinely cannot be placed.

Add `'container_vanished'` to the finding-kind union in `types.ts` and to any exhaustive switch over it.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run packages/core && pnpm exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/provision packages/core/src/provision/types.ts
git commit -m "feat(provision): a vanished container is a finding, never a re-create"
```

---

### Task 11: API routes

**Files:**
- Modify: `apps/api/src/routes/admin/org-units.ts`
- Modify: `apps/api/src/routes/admin/persons.ts`
- Modify: `packages/contracts/src/` (request/response schemas)
- Test: `apps/api/src/routes/admin/org-units.test.ts`, `apps/api/src/routes/admin/persons.test.ts`

**Interfaces:**
- Consumes: `materialiseOrgUnit`, `unmaterialiseOrgUnit` (Task 2).
- Produces:
  - `GET /api/admin/org-units/:id/containers` → `{ containers: { targetSystemId: string; targetName: string; dn: string; state: string }[] }`
  - `POST /api/admin/org-units/:id/containers` body `{ targetSystemId: string; dn: string }` → 201, or 400 with `{ reason }` for `malformed` / `outside_base` / `dn_taken`, 404 for `no_such_unit` / `no_such_target`
  - `DELETE /api/admin/org-units/:id/containers/:targetSystemId` → 204, 404 when absent
  - `PATCH /api/admin/persons/:id` accepts `orgUnitId: string | null`
  - `GET /api/admin/targets/:id/containers` already exists (`targets.ts:175`) — unchanged

- [ ] **Step 1: Write the failing route tests**

```ts
it('materialises an org unit against a target', async () => {
  const response = await app.inject({
    method: 'POST',
    url: `/api/admin/org-units/${orgUnitId}/containers`,
    headers: authHeaders,
    payload: { targetSystemId, dn: 'OU=Sales,OU=Users,DC=acme,DC=test' },
  });
  expect(response.statusCode).toBe(201);
  expect(response.json().state).toBe('desired');
});

it('refuses a DN outside the target base with 400, not 500', async () => {
  const response = await app.inject({
    method: 'POST',
    url: `/api/admin/org-units/${orgUnitId}/containers`,
    headers: authHeaders,
    payload: { targetSystemId, dn: 'CN=Users,DC=acme,DC=test' },
  });
  expect(response.statusCode).toBe(400);
  expect(response.json().reason).toBe('outside_base');
});

it('refuses to materialise an unknown org unit with 404', async () => {
  const response = await app.inject({
    method: 'POST',
    url: `/api/admin/org-units/00000000-0000-0000-0000-000000000000/containers`,
    headers: authHeaders,
    payload: { targetSystemId, dn: 'OU=Sales,OU=Users,DC=acme,DC=test' },
  });
  expect(response.statusCode).toBe(404);
});

it('assigns a person to an org unit', async () => {
  const response = await app.inject({
    method: 'PATCH',
    url: `/api/admin/persons/${personId}`,
    headers: authHeaders,
    payload: { orgUnitId },
  });
  expect(response.statusCode).toBe(200);
  expect(response.json().orgUnitId).toBe(orgUnitId);
});

it('clears a person\'s org unit with an explicit null', async () => {
  const response = await app.inject({
    method: 'PATCH',
    url: `/api/admin/persons/${personId}`,
    headers: authHeaders,
    payload: { orgUnitId: null },
  });
  expect(response.statusCode).toBe(200);
  expect(response.json().orgUnitId).toBeNull();
});
```

Match the existing permission-check pattern in `org-units.ts` — the new routes need the same permission the existing write routes require, and there should be a test asserting a caller without it gets 403.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run apps/api/src/routes/admin/org-units.test.ts apps/api/src/routes/admin/persons.test.ts`
Expected: FAIL — 404 on the new routes.

- [ ] **Step 3: Implement the routes**

Map `MaterialiseOutcome.reason` to status codes explicitly — `malformed`, `outside_base` and `dn_taken` are 400; `no_such_unit` and `no_such_target` are 404. Do not collapse them into a single 400: the DN cases are the operator's typo and the others are a stale page, and they need different messages.

- [ ] **Step 4: Pass the real value to the onboarding preview**

The preview endpoint changed arity in Task 4 and currently passes `null`. Give it the chosen OrgUnit's materialised DN for the selected target, resolved through `containersForTarget`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run apps/api && pnpm exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api packages/contracts
git commit -m "feat(api): materialise org units and assign people to them"
```

---

### Task 12: Console

**Files:**
- Modify: `apps/web/src/pages/admin/OrgUnitsPage.tsx`
- Modify: `apps/web/src/pages/admin/PersonDetailPage.tsx`
- Modify: `apps/web/src/pages/admin/OnboardPersonPage.tsx`
- Test: `apps/web/src/pages/admin/OrgUnitsPage.test.tsx` (create), `PersonDetailPage.test.tsx`, `OnboardPersonPage.test.tsx`

**Interfaces:**
- Consumes: the Task 11 routes.
- Produces: no exports other than the components themselves.

- [ ] **Step 1: Write the failing tests**

```tsx
it('materialises a unit against a chosen target', async () => {
  renderWithProviders(<OrgUnitsPage />);
  await screen.findByText('Sales');
  await userEvent.click(screen.getByRole('button', { name: /materialise/i }));
  await userEvent.selectOptions(
    screen.getByLabelText(/target/i),
    'target-1',
  );
  // The DN is shown before it is written. This is a directory write, and it
  // must read as one.
  expect(await screen.findByText('OU=Sales,OU=Users,DC=acme,DC=test')).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: /create container/i }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
    expect.stringContaining('/containers'),
    expect.objectContaining({ method: 'POST' }),
  ));
});

it('surfaces an outside_base refusal to the operator', async () => {
  fetchMock.mockResolvedValueOnce(jsonResponse(400, { reason: 'outside_base',
    message: "CN=Users,DC=acme,DC=test is not below the target's base" }));
  // ... trigger, then:
  expect(await screen.findByRole('alert')).toHaveTextContent(/not below the target/i);
});

it('assigns a person to an org unit', async () => {
  renderWithProviders(<PersonDetailPage />);
  await userEvent.selectOptions(await screen.findByLabelText(/org unit/i), 'ou-sales');
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
    expect.stringContaining('/persons/person-1'),
    expect.objectContaining({ method: 'PATCH' }),
  ));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run apps/web/src/pages/admin`
Expected: FAIL — no such controls.

- [ ] **Step 3: Implement**

Follow `apps/web/DESIGN.md` and the existing `RecordPanel` / `StatusToggle` patterns. Three rules specific to this work:

- The materialise control shows the DN **before** the write, not after. Per the memory rule that a control needing prose to be usable should be redesigned, the DN preview is the explanation — do not add a paragraph explaining what materialising means.
- The Move control on `PersonAccessPage` is untouched and still wins. The OrgUnit selector on `PersonDetailPage` should say so where a person has both, in a few words, not a paragraph.
- Nothing in this UI may create an OrgUnit and materialise it in one action. Two decisions, two clicks — that separation is what Ruling P9 (revised) rests on.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run apps/web && pnpm exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat(console): materialise org units and assign people to them"
```

---

### Task 13: Full suite, docs, and the lab rollout note

**Files:**
- Modify: `README.md` (the Provision row of the module table)
- Modify: `docs/lab/README.md`
- Test: the whole suite

**Interfaces:**
- Consumes: everything.
- Produces: nothing.

- [ ] **Step 1: Run the entire suite**

```bash
pnpm db:up
pnpm test
pnpm exec tsc --noEmit
pnpm lint
```

Expected: PASS. Fix anything red before continuing; do not proceed with a failing suite.

- [ ] **Step 2: Run the e2e suite**

```bash
pnpm exec playwright test
```

Expected: PASS. The console navigation changed in `f455821`, so if an e2e spec walks to Org units, update the path rather than the assertion.

- [ ] **Step 3: Update the README**

In the module table, extend the **Provision** row to mention org-unit-driven placement and container creation. One clause, in the existing voice.

- [ ] **Step 4: Write the lab rollout note**

Append to `docs/lab/README.md`:

```markdown
## Org-unit-driven placement, first run

The `ssander.local (AD)` target runs `autoApply: true` with
`archiveAccountThresholdPercent: 2`. Container MOVES share the archive axis
(`guard.ts:168`), and the tenant holds four people, so ONE account move is 25%
and the first run will skip rather than apply.

That is the guard working, not a fault. The order is:

1. Materialise `Users` against the target — it already exists in AD, so it
   adopts, and no container is created.
2. Assign one person to it and PREVIEW the run. Confirm the move is proposed.
3. Raise `archiveAccountThresholdPercent` deliberately for this lab tenant,
   with the reason recorded, and apply.

Do not lower a safety threshold mid-incident because a run skipped
unexpectedly. Raise it in advance, knowing why.
```

- [ ] **Step 5: Commit**

```bash
git add README.md docs/lab/README.md
git commit -m "docs: org-unit-driven placement, and the lab's first-run guard trip"
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: data model → 1; escaping/validation → 2; placement ladder → 3; explain and preview → 4; Ruling P9 narrowing → 5 (action type) and 7 (the fork); `create_container` connector method → 6; guard → 5; drift → 10; write ordering → 2 (row first) and 8 (target second); console → 12; testing → distributed, with the integration tests in 6; lab rollout → 13. The three out-of-scope items (rename, reparent, `deleteDirectoryOrgUnit`) appear in Global Constraints as explicit non-goals.

**Type consistency.** `orgUnitContainer` is the `DesiredStateInput` field name in Tasks 3, 4 and 9. `desiredContainerRows` is the `ReconcileInput` field name in Tasks 7, 9 and 10, keyed by lowercased DN in all three. `containersForTarget` returns a map keyed by `orgUnitId` in Task 2 and is consumed that way in Tasks 9 and 11. `MaterialiseOutcome.reason` values in Task 2 match the status-code mapping in Task 11 exactly. `createContainer(config, { dn })` has the same signature in Tasks 6 and 8.

**Known soft spots the executor must resolve by reading, not guessing.** Task 4's `explain.ts` test is written against a signature that must be confirmed first. Task 8's grouping change depends on how `apply.ts` batches — the plan names the hazard (`personId: null`) without prescribing the fix, because the correct fix depends on code not quoted here. Task 6's error classification may already exist in `ldap/writeback.ts:62`; reuse beats a second classifier.
