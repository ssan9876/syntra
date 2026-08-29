# Adopting a Conflicted Account — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give an administrator a deliberate, audited way out of `TargetAccount.status = 'conflict'`, by binding the row to the directory object that caused the collision.

**Architecture:** A new core service, `adoption-service.ts`, modelled closely on `placement-service.ts`'s `moveAccount` — a human path, not the planner's. It performs one directory READ to find the candidate and **no directory write**; it records the anchor, sets the row active, and audits who decided and why. Attributes converge on the next run through the guard. Two routes in the existing `targets.ts` expose it, and a control on `PersonAccessPage` appears only for a conflicted account.

**Tech Stack:** TypeScript, Fastify, Prisma, Zod (`@syntra/contracts`), Vitest, React + Tailwind (`apps/web`).

**Spec:** `docs/superpowers/specs/2026-08-28-conflicted-account-adoption-design.md`

## Global Constraints

- **No directory write, ever.** Adoption reads the target and writes only the database. A test asserts the connector's `write` is never called.
- **`reason` is required** on every mutating call — `z.string().trim().min(1).max(512)`, matching `movePlacementRequest`.
- **Syntra never infers when no candidate is visible.** An object outside the base DN and a deleted object are indistinguishable; the caller answers via `ifNoCandidate`, defaulting to `'refuse'`.
- **Permission:** both routes require `PERMISSIONS.PROVISION_MANAGE`.
- **Correlation key comparison is case-insensitive**, as everywhere else in this subsystem (`sAMAccountName` is case-insensitive in AD).
- Tests are DB-backed and slow (~10–20s each). Run one file at a time; never two vitest runs at once in this checkout — concurrent runs produce phantom failures.
- Static check is `pnpm typecheck`. There is no linter.

---

### Task 1: The service binds a visible candidate

**Files:**
- Create: `packages/core/src/provision/adoption-service.ts`
- Create: `packages/core/src/provision/adoption-service.test.ts`
- Modify: `packages/core/src/index.ts` (add the export line)

**Interfaces:**
- Consumes: `targetWithCredential(tx, provider, targetSystemId)` from `./target-service.js`; `targetConnectorFor(type)` from `@syntra/connectors`; `valuesOf(record, attribute)` exported from `./apply.js`; `withTenant` from `@syntra/db`; `recordEvent` from `../audit/audit-service.js`.
- Produces:
  ```ts
  export interface AdoptAccountInput {
    personId: string;
    targetSystemId: string;
    reason: string;
    actorUserId: string | null;
    sourceIp: string | null;
    ifNoCandidate?: 'refuse' | 'reset';
  }
  export interface AdoptAccountResult {
    adopted: boolean;
    anchor: string | null;
    dn: string | null;
  }
  export function adoptAccount(
    tenantId: string,
    provider: MasterKeyProvider,
    input: AdoptAccountInput,
  ): Promise<AdoptAccountResult>;
  export function adoptionCandidate(
    tenantId: string,
    provider: MasterKeyProvider,
    personId: string,
    targetSystemId: string,
  ): Promise<{ anchor: string; dn: string; attributes: Record<string, string[]> }>;
  export class NoAccountToAdoptError extends Error {}
  export class NotInConflictError extends Error {}
  export class AnchorAlreadyBoundError extends Error {}
  export class CandidateNotVisibleError extends Error {}
  ```

- [ ] **Step 1: Write the failing test**

Copy the fixture style from `packages/core/src/provision/apply.test.ts` — `FakeTarget` from `@syntra/connectors/testing`, `resetDatabase()` from `@syntra/db/src/test-support.js`, `localMasterKeyProvider(Buffer.alloc(32, 7))`, `createTarget` / `upsertAccountProfile` from `./target-service.js`. Seed a person, a target, and a `TargetAccount` in conflict; put a matching object in the fake target.

In `packages/core/src/provision/adoption-service.test.ts`:

```ts
it('binds the conflicted row to the object that caused the collision', async () => {
  target.objects.set('anchor-x', {
    anchor: 'anchor-x',
    objectType: 'account',
    dn: 'CN=Anna Novak,OU=Users,DC=acme,DC=test',
    attributes: { sAMAccountName: ['anna.novak'] },
  });
  const before = await withTenant(tenantId, (tx) =>
    tx.targetAccount.findFirstOrThrow({ where: { personId } }),
  );
  expect(before.status).toBe('conflict');

  const result = await adoptAccount(tenantId, provider, {
    personId,
    targetSystemId: targetId,
    reason: 'this is her existing account',
    actorUserId: adminUserId,
    sourceIp: null,
  });

  expect(result).toEqual({
    adopted: true,
    anchor: 'anchor-x',
    dn: 'CN=Anna Novak,OU=Users,DC=acme,DC=test',
  });
  const after = await withTenant(tenantId, (tx) =>
    tx.targetAccount.findFirstOrThrow({ where: { personId } }),
  );
  expect(after.anchor).toBe('anchor-x');
  expect(after.status).toBe('active');
  expect(after.statusReason).toBeNull();
});

it('matches the correlation key case-insensitively', async () => {
  // sAMAccountName is case-insensitive in Active Directory. A case-sensitive
  // compare refuses to adopt an account that is plainly there, and the
  // administrator is told to move an object that has not moved.
  target.objects.set('anchor-x', {
    anchor: 'anchor-x',
    objectType: 'account',
    dn: 'CN=Anna Novak,OU=Users,DC=acme,DC=test',
    attributes: { sAMAccountName: ['Anna.Novak'] },
  });
  const result = await adoptAccount(tenantId, provider, {
    personId,
    targetSystemId: targetId,
    reason: 'same account, different casing',
    actorUserId: adminUserId,
    sourceIp: null,
  });
  expect(result.adopted).toBe(true);
});

it('writes nothing to the directory', async () => {
  // The property the whole design rests on. Adoption records a decision; the
  // next run converges the object through the guard. A future change that
  // "helpfully" stamps provenance or writes attributes here would overwrite
  // an `info` field Syntra does not own, in a request that can half-fail.
  target.objects.set('anchor-x', {
    anchor: 'anchor-x',
    objectType: 'account',
    dn: 'CN=Anna Novak,OU=Users,DC=acme,DC=test',
    attributes: { sAMAccountName: ['anna.novak'] },
  });
  let wrote = 0;
  const original = target.write.bind(target);
  target.write = async (cfg, op) => {
    wrote += 1;
    return original(cfg, op);
  };
  await adoptAccount(tenantId, provider, {
    personId,
    targetSystemId: targetId,
    reason: 'hers',
    actorUserId: adminUserId,
    sourceIp: null,
  });
  expect(wrote).toBe(0);
});

it('records who adopted it and why', async () => {
  target.objects.set('anchor-x', {
    anchor: 'anchor-x',
    objectType: 'account',
    dn: 'CN=Anna Novak,OU=Users,DC=acme,DC=test',
    attributes: { sAMAccountName: ['anna.novak'] },
  });
  await adoptAccount(tenantId, provider, {
    personId,
    targetSystemId: targetId,
    reason: 'confirmed with her manager',
    actorUserId: adminUserId,
    sourceIp: '203.0.113.7',
  });
  const events = await withTenant(tenantId, (tx) =>
    tx.auditEvent.findMany({ where: { action: 'provision.account.adopted' } }),
  );
  expect(events).toHaveLength(1);
  expect(events[0]!.actorUserId).toBe(adminUserId);
  expect(events[0]!.payload).toMatchObject({
    adopted: true,
    anchor: 'anchor-x',
    correlationKey: 'anna.novak',
    reason: 'confirmed with her manager',
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run packages/core/src/provision/adoption-service.test.ts`
Expected: FAIL — `Failed to resolve import "./adoption-service.js"`.

- [ ] **Step 3: Write the service**

Create `packages/core/src/provision/adoption-service.ts`:

```ts
import { withTenant } from '@syntra/db';
import { targetConnectorFor } from '@syntra/connectors';
import { recordEvent } from '../audit/audit-service.js';
import type { MasterKeyProvider } from '../vault/master-key.js';
import { targetWithCredential } from './target-service.js';
import { valuesOf } from './apply.js';

/**
 * Binding a conflicted account to the object that caused the collision.
 *
 * This is the human path out of a state the subsystem has no other exit from.
 * `apply.ts` sets `conflict` when the target refuses a create because the name
 * is taken, and nothing writes it back: `reconcile` makes the person
 * unprocessable and returns, and the reservation step excludes them. Every
 * later run stops in the same place, whatever the administrator does in the
 * directory.
 *
 * The refusal it overrides is correct and stays. Syntra will not bind to an
 * object it did not create, because anybody able to create an object in a
 * target could otherwise choose a name that hands them somebody's account.
 * What replaces that safeguard here is a named human confirming a specific
 * object, and an audit event saying who and why.
 *
 * It performs ONE directory read and no write. See the spec's "Why no
 * directory write": provenance is consulted only on creates, and stamping it
 * would overwrite an `info` field Syntra does not own.
 */

export class NoAccountToAdoptError extends Error {
  constructor() {
    super('this person has no account on this target, so there is nothing to adopt');
    this.name = 'NoAccountToAdoptError';
  }
}

export class NotInConflictError extends Error {
  constructor(readonly status: string) {
    super(
      `this account is ${status}, not in conflict. Adoption is the exit from a conflict and is not a way to re-point an account that already works.`,
    );
    this.name = 'NotInConflictError';
  }
}

export class AnchorAlreadyBoundError extends Error {
  constructor(readonly anchor: string) {
    super(
      `the object ${anchor} is already held by another account in this target, so adopting it here would give two people one account`,
    );
    this.name = 'AnchorAlreadyBoundError';
  }
}

export class CandidateNotVisibleError extends Error {
  constructor(
    readonly correlationKey: string,
    readonly baseDn: string,
  ) {
    super(
      `the account ${correlationKey} was refused as already existing, and no object with that name is inside ${baseDn}. ` +
        `Either it is elsewhere in the domain where this target cannot see it — move it into the managed subtree, or widen the target's base DN — ` +
        `or it has since been deleted, in which case the account can be created again.`,
    );
    this.name = 'CandidateNotVisibleError';
  }
}

export interface AdoptAccountInput {
  personId: string;
  targetSystemId: string;
  reason: string;
  actorUserId: string | null;
  sourceIp: string | null;
  /**
   * What to do when no object with this name is visible under the base DN.
   *
   * The two causes are indistinguishable from a base-scoped read — the object
   * is outside the base, or it has been deleted — and they need opposite
   * treatments. The status cannot separate them either: `finish` sets
   * `conflict` only on an already-exists refusal, so every row in this state
   * carries identical evidence. So the caller answers, and the default is the
   * one that changes nothing.
   */
  ifNoCandidate?: 'refuse' | 'reset';
}

export interface AdoptAccountResult {
  adopted: boolean;
  anchor: string | null;
  dn: string | null;
}

interface Candidate {
  anchor: string;
  dn: string;
  attributes: Record<string, string[]>;
}

/**
 * The row to adopt, plus the target details the read needs.
 *
 * Task 2 adds the guards here. This task establishes the shape.
 */
async function conflictedAccount(tenantId: string, personId: string, targetSystemId: string) {
  return withTenant(tenantId, async (tx) => {
    const account = await tx.targetAccount.findFirstOrThrow({
      where: { personId, targetSystemId },
      select: { id: true, status: true, correlationKey: true },
    });
    const target = await tx.targetSystem.findUniqueOrThrow({
      where: { id: targetSystemId },
      select: { type: true, config: true },
    });
    return { account, target };
  });
}

/** Reads the target and returns the object carrying this correlation key. */
async function findCandidate(
  tenantId: string,
  provider: MasterKeyProvider,
  targetSystemId: string,
  type: string,
  correlationKey: string,
): Promise<Candidate | null> {
  const config = await withTenant(tenantId, (tx) =>
    targetWithCredential(tx, provider, targetSystemId),
  );
  if (!config) throw new Error('target configuration or credential missing');
  const wanted = correlationKey.trim().toLowerCase();
  for await (const record of targetConnectorFor(type).read(config as never)) {
    const key = (valuesOf(record, 'sAMAccountName')[0] ?? '').trim().toLowerCase();
    if (key !== wanted) continue;
    return { anchor: record.anchor, dn: record.dn, attributes: record.attributes };
  }
  return null;
}

export async function adoptionCandidate(
  tenantId: string,
  provider: MasterKeyProvider,
  personId: string,
  targetSystemId: string,
): Promise<Candidate> {
  const { account, target } = await conflictedAccount(tenantId, personId, targetSystemId);
  const candidate = await findCandidate(
    tenantId,
    provider,
    targetSystemId,
    target.type,
    account.correlationKey,
  );
  if (candidate === null) {
    throw new CandidateNotVisibleError(
      account.correlationKey,
      (target.config as { baseDn?: string } | null)?.baseDn ?? '(no base DN configured)',
    );
  }
  return candidate;
}

export async function adoptAccount(
  tenantId: string,
  provider: MasterKeyProvider,
  input: AdoptAccountInput,
): Promise<AdoptAccountResult> {
  const { account, target } = await conflictedAccount(
    tenantId,
    input.personId,
    input.targetSystemId,
  );
  const candidate = await findCandidate(
    tenantId,
    provider,
    input.targetSystemId,
    target.type,
    account.correlationKey,
  );

  // Task 3 replaces this with the refuse/reset decision.
  if (candidate === null) return { adopted: false, anchor: null, dn: null };

  await withTenant(tenantId, async (tx) => {
    await tx.targetAccount.update({
      where: { id: account.id },
      data: { anchor: candidate.anchor, status: 'active', statusReason: null },
    });
    await recordEvent(tx, {
      actorUserId: input.actorUserId,
      action: 'provision.account.adopted',
      targetType: 'TargetAccount',
      targetId: account.id,
      outcome: 'success',
      sourceIp: input.sourceIp,
      payload: {
        adopted: true,
        anchor: candidate.anchor,
        dn: candidate.dn,
        correlationKey: account.correlationKey,
        reason: input.reason,
      },
    });
  });

  return { adopted: true, anchor: candidate.anchor, dn: candidate.dn };
}
```

Add to `packages/core/src/index.ts`, next to the placement export:

```ts
export * from './provision/adoption-service.js';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run packages/core/src/provision/adoption-service.test.ts`
Expected: PASS (4 tests). Then `pnpm typecheck` — expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/provision/adoption-service.ts \
        packages/core/src/provision/adoption-service.test.ts \
        packages/core/src/index.ts
git commit -m "feat(provision): bind a conflicted account to the object that caused it"
```

---

### Task 2: The refusals

**Files:**
- Modify: `packages/core/src/provision/adoption-service.test.ts`

**Interfaces:**
- Consumes: `adoptAccount`, `NoAccountToAdoptError`, `NotInConflictError`, `AnchorAlreadyBoundError` from Task 1.
- Produces: nothing new — this task proves Task 1's guards.

- [ ] **Step 1: Write the failing tests**

```ts
it('refuses a person with no account on this target', async () => {
  await withTenant(tenantId, (tx) => tx.targetAccount.deleteMany({ where: { personId } }));
  await expect(
    adoptAccount(tenantId, provider, {
      personId,
      targetSystemId: targetId,
      reason: 'nothing there',
      actorUserId: adminUserId,
      sourceIp: null,
    }),
  ).rejects.toBeInstanceOf(NoAccountToAdoptError);
});

it('refuses an account that is not in conflict', async () => {
  // Adoption is the exit from ONE state. A general re-point would let an
  // administrator attach a person to an account that already belongs to
  // somebody else, which is the power the provenance rule exists to withhold.
  await withTenant(tenantId, (tx) =>
    tx.targetAccount.updateMany({ where: { personId }, data: { status: 'active' } }),
  );
  await expect(
    adoptAccount(tenantId, provider, {
      personId,
      targetSystemId: targetId,
      reason: 'already fine',
      actorUserId: adminUserId,
      sourceIp: null,
    }),
  ).rejects.toBeInstanceOf(NotInConflictError);
});

it('refuses an object another account already holds', async () => {
  target.objects.set('anchor-x', {
    anchor: 'anchor-x',
    objectType: 'account',
    dn: 'CN=Anna Novak,OU=Users,DC=acme,DC=test',
    attributes: { sAMAccountName: ['anna.novak'] },
  });
  const other = await seedPerson('Bea', 'Vos');
  await withTenant(tenantId, (tx) =>
    tx.targetAccount.create({
      data: {
        tenantId,
        targetSystemId: targetId,
        personId: other,
        correlationKey: 'bea.vos',
        status: 'active',
        anchor: 'anchor-x',
      },
    }),
  );
  await expect(
    adoptAccount(tenantId, provider, {
      personId,
      targetSystemId: targetId,
      reason: 'contested',
      actorUserId: adminUserId,
      sourceIp: null,
    }),
  ).rejects.toBeInstanceOf(AnchorAlreadyBoundError);
});

it('leaves the row untouched when it refuses', async () => {
  // A refused adoption must not be a partial one. The row stays in conflict
  // so the administrator can act on the message rather than on a half-state.
  await expect(
    adoptAccount(tenantId, provider, {
      personId,
      targetSystemId: targetId,
      reason: 'no candidate anywhere',
      actorUserId: adminUserId,
      sourceIp: null,
    }),
  ).rejects.toBeTruthy();
  const after = await withTenant(tenantId, (tx) =>
    tx.targetAccount.findFirstOrThrow({ where: { personId } }),
  );
  expect(after.status).toBe('conflict');
  expect(after.anchor).toBeNull();
});
```

Add a `seedPerson(givenName, familyName)` helper beside the existing fixtures returning the new person's id.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run packages/core/src/provision/adoption-service.test.ts -t "refuses"`
Expected: FAIL. Task 1 has no guards — the first two throw Prisma's `NotFoundError` or adopt an account that is not in conflict; the third binds an anchor another row holds and dies on the unique index.

- [ ] **Step 3: Add the guards**

In `conflictedAccount`, replace `findFirstOrThrow` with the checked form:

```ts
const account = await tx.targetAccount.findFirst({
  where: { personId, targetSystemId },
  select: { id: true, status: true, correlationKey: true },
});
if (account === null) throw new NoAccountToAdoptError();
if (account.status !== 'conflict') throw new NotInConflictError(account.status);
```

And inside `adoptAccount`'s binding transaction, before the update:

```ts
const held = await tx.targetAccount.findFirst({
  where: { targetSystemId: input.targetSystemId, anchor: candidate.anchor },
  select: { id: true },
});
// The partial unique index on `(tenantId, targetSystemId, anchor)` refuses
// this anyway. Checked first so the administrator gets a sentence rather than
// a constraint violation — and inside the transaction, so a concurrent
// adoption cannot slip between the check and the write.
if (held !== null && held.id !== account.id) {
  throw new AnchorAlreadyBoundError(candidate.anchor);
}
```

- [ ] **Step 4: Run the whole file**

Run: `pnpm exec vitest run packages/core/src/provision/adoption-service.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/provision/adoption-service.test.ts packages/core/src/provision/adoption-service.ts
git commit -m "test(provision): the refusals adoption makes, and that it leaves the row alone"
```

---

### Task 3: No candidate — refuse by default, reset only when asked

**Files:**
- Modify: `packages/core/src/provision/adoption-service.test.ts`

**Interfaces:**
- Consumes: `adoptAccount`, `CandidateNotVisibleError` from Task 1.

- [ ] **Step 1: Write the failing tests**

```ts
it('refuses by default when no object with that name is visible', async () => {
  // The case that motivated the feature: the colliding object was OUTSIDE the
  // target's base DN, so the create was refused by something the read cannot
  // see. Resetting here would retry the create and be refused identically,
  // for ever.
  await expect(
    adoptAccount(tenantId, provider, {
      personId,
      targetSystemId: targetId,
      reason: 'try it',
      actorUserId: adminUserId,
      sourceIp: null,
    }),
  ).rejects.toBeInstanceOf(CandidateNotVisibleError);
});

it('names the base DN in the refusal', async () => {
  // Without the base DN the message is "not found", and the administrator has
  // no way to tell an invisible object from a deleted one — which is the whole
  // decision this refusal is asking them to make.
  await adoptAccount(tenantId, provider, {
    personId,
    targetSystemId: targetId,
    reason: 'try it',
    actorUserId: adminUserId,
    sourceIp: null,
  }).catch((cause: unknown) => {
    expect((cause as Error).message).toContain('OU=Users,DC=acme,DC=test');
  });
  expect.assertions(1);
});

it('resets to pending only when the caller says the object is gone', async () => {
  const result = await adoptAccount(tenantId, provider, {
    personId,
    targetSystemId: targetId,
    reason: 'she left and IT deleted it',
    actorUserId: adminUserId,
    sourceIp: null,
    ifNoCandidate: 'reset',
  });
  expect(result).toEqual({ adopted: false, anchor: null, dn: null });
  const after = await withTenant(tenantId, (tx) =>
    tx.targetAccount.findFirstOrThrow({ where: { personId } }),
  );
  expect(after.status).toBe('pending');
  expect(after.statusReason).toBeNull();
  expect(after.anchor).toBeNull();
});

it('audits a reset as an adoption that did not happen', async () => {
  await adoptAccount(tenantId, provider, {
    personId,
    targetSystemId: targetId,
    reason: 'deleted last week',
    actorUserId: adminUserId,
    sourceIp: null,
    ifNoCandidate: 'reset',
  });
  const events = await withTenant(tenantId, (tx) =>
    tx.auditEvent.findMany({ where: { action: 'provision.account.adopted' } }),
  );
  expect(events[0]!.payload).toMatchObject({ adopted: false, reason: 'deleted last week' });
});

it('ignores ifNoCandidate when a candidate IS visible', async () => {
  // `reset` answers a question that was not asked here. Honouring it would
  // throw away a working binding because of a flag about a different case.
  target.objects.set('anchor-x', {
    anchor: 'anchor-x',
    objectType: 'account',
    dn: 'CN=Anna Novak,OU=Users,DC=acme,DC=test',
    attributes: { sAMAccountName: ['anna.novak'] },
  });
  const result = await adoptAccount(tenantId, provider, {
    personId,
    targetSystemId: targetId,
    reason: 'hers',
    actorUserId: adminUserId,
    sourceIp: null,
    ifNoCandidate: 'reset',
  });
  expect(result.adopted).toBe(true);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run packages/core/src/provision/adoption-service.test.ts -t "candidate"`
Expected: FAIL. Task 1 returns `{ adopted: false }` for a missing candidate and changes nothing — so the refusal tests get a resolved promise instead of a throw, and the reset tests find the row still `conflict`.

- [ ] **Step 3: Add the refuse/reset decision**

Replace Task 1's placeholder `if (candidate === null) return …` in `adoptAccount` with:

```ts
if (candidate === null) {
  const baseDn =
    (target.config as { baseDn?: string } | null)?.baseDn ?? '(no base DN configured)';
  if ((input.ifNoCandidate ?? 'refuse') === 'refuse') {
    throw new CandidateNotVisibleError(account.correlationKey, baseDn);
  }
  // The administrator has answered the question this service cannot: the
  // object is gone, not merely out of sight. Back to `pending`, and the next
  // run creates the account — which is what a reservation is for.
  await withTenant(tenantId, async (tx) => {
    await tx.targetAccount.update({
      where: { id: account.id },
      data: { status: 'pending', statusReason: null },
    });
    await recordEvent(tx, {
      actorUserId: input.actorUserId,
      action: 'provision.account.adopted',
      targetType: 'TargetAccount',
      targetId: account.id,
      outcome: 'success',
      sourceIp: input.sourceIp,
      payload: {
        adopted: false,
        correlationKey: account.correlationKey,
        reason: input.reason,
      },
    });
  });
  return { adopted: false, anchor: null, dn: null };
}
```

- [ ] **Step 4: Run the whole file and typecheck**

Run: `pnpm exec vitest run packages/core/src/provision/adoption-service.test.ts` then `pnpm typecheck`
Expected: PASS (13 tests), typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/provision/adoption-service.test.ts
git commit -m "test(provision): no candidate refuses by default and resets only when asked"
```

---

### Task 4: The API

**Files:**
- Modify: `packages/contracts/src/provision.ts`
- Modify: `apps/api/src/routes/admin/targets.ts`
- Test: `apps/api/src/routes/admin/targets.test.ts` (create if absent, following `placements.test.ts`)

**Interfaces:**
- Consumes: `adoptAccount`, `adoptionCandidate` and the four error classes from Task 1; `placementParams` (already in `targets.ts:114`), `requirePermission`, `PERMISSIONS.PROVISION_MANAGE`, `ProblemError`.
- Produces: `adoptAccountRequest`, `adoptionCandidateResponse` from `@syntra/contracts`.

- [ ] **Step 1: Add the contracts**

In `packages/contracts/src/provision.ts`, beside `movePlacementRequest`:

```ts
/**
 * Adopting a conflicted account.
 *
 * `reason` is required for the same argument as a manual move: the record is
 * the only thing standing where a technical safeguard used to. `ifNoCandidate`
 * defaults to refusing, because an object outside the base DN and a deleted
 * one look identical from here and only the administrator can tell them apart.
 */
export const adoptAccountRequest = z
  .object({
    reason: z.string().trim().min(1).max(512),
    ifNoCandidate: z.enum(['refuse', 'reset']).default('refuse'),
  })
  .strict();

export const adoptionCandidateResponse = z.object({
  anchor: z.string(),
  dn: z.string(),
  attributes: z.record(z.array(z.string())),
});

export type AdoptAccountRequest = z.input<typeof adoptAccountRequest>;
export type AdoptionCandidateResponse = z.infer<typeof adoptionCandidateResponse>;
```

- [ ] **Step 2: Write the failing route tests**

```ts
it('adopts the candidate and answers 200', async () => {
  const response = await app.inject({
    method: 'POST',
    url: `/api/admin/targets/${targetId}/accounts/${personId}/adopt`,
    headers: { cookie },
    payload: { reason: 'confirmed it is hers' },
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ adopted: true, anchor: 'anchor-x' });
});

it('answers 409 for an account that is not in conflict', async () => {
  const response = await app.inject({
    method: 'POST',
    url: `/api/admin/targets/${targetId}/accounts/${activePersonId}/adopt`,
    headers: { cookie },
    payload: { reason: 'why not' },
  });
  expect(response.statusCode).toBe(409);
  expect(response.json().type).toContain('not-in-conflict');
});

it('answers 404 naming the base DN when nothing is visible', async () => {
  const response = await app.inject({
    method: 'POST',
    url: `/api/admin/targets/${targetId}/accounts/${invisiblePersonId}/adopt`,
    headers: { cookie },
    payload: { reason: 'try' },
  });
  expect(response.statusCode).toBe(404);
  expect(response.json().detail).toContain('OU=Users,DC=acme,DC=test');
});

it('refuses a reason that is only whitespace', async () => {
  const response = await app.inject({
    method: 'POST',
    url: `/api/admin/targets/${targetId}/accounts/${personId}/adopt`,
    headers: { cookie },
    payload: { reason: '   ' },
  });
  expect(response.statusCode).toBe(400);
});

it('requires PROVISION_MANAGE', async () => {
  const response = await app.inject({
    method: 'POST',
    url: `/api/admin/targets/${targetId}/accounts/${personId}/adopt`,
    headers: { cookie: readOnlyCookie },
    payload: { reason: 'nope' },
  });
  expect(response.statusCode).toBe(403);
});

it('answers 409 when the person has no account here', async () => {
  const response = await app.inject({
    method: 'POST',
    url: `/api/admin/targets/${targetId}/accounts/${accountlessPersonId}/adopt`,
    headers: { cookie },
    payload: { reason: 'nothing there' },
  });
  expect(response.statusCode).toBe(409);
  expect(response.json().type).toContain('nothing-to-adopt');
});

it('answers 409 when another account already holds that object', async () => {
  const response = await app.inject({
    method: 'POST',
    url: `/api/admin/targets/${targetId}/accounts/${contestedPersonId}/adopt`,
    headers: { cookie },
    payload: { reason: 'contested' },
  });
  expect(response.statusCode).toBe(409);
  expect(response.json().type).toContain('anchor-already-bound');
});

it('requires PROVISION_MANAGE to read the candidate too', async () => {
  // The GET performs a live directory read and names an object by DN. It is
  // not a read-shaped permission just because it is a GET.
  const response = await app.inject({
    method: 'GET',
    url: `/api/admin/targets/${targetId}/accounts/${personId}/adoption-candidate`,
    headers: { cookie: readOnlyCookie },
  });
  expect(response.statusCode).toBe(403);
});

it('returns the candidate for the dialog to show', async () => {
  const response = await app.inject({
    method: 'GET',
    url: `/api/admin/targets/${targetId}/accounts/${personId}/adoption-candidate`,
    headers: { cookie },
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    anchor: 'anchor-x',
    dn: 'CN=Anna Novak,OU=Users,DC=acme,DC=test',
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `pnpm exec vitest run apps/api/src/routes/admin/targets.test.ts -t "adopt"`
Expected: FAIL with 404 — the routes do not exist.

- [ ] **Step 4: Add the routes**

In `apps/api/src/routes/admin/targets.ts`, after the placements `app.put`:

```ts
/**
 * The candidate an adoption would bind, read from the target on demand.
 *
 * Separate from the POST because the safeguard adoption replaces is a
 * technical one: provenance answers "did Syntra make this?", and the only
 * thing that stands in for it is a named human having looked at a specific
 * object. Confirming a NAME is not that. Called when the dialog opens, never
 * on page load — it is a live directory read.
 */
app.get(
  '/targets/:id/accounts/:personId/adoption-candidate',
  { preHandler: requirePermission(PERMISSIONS.PROVISION_MANAGE) },
  async (request) => {
    const { id, personId } = placementParams.parse(request.params);
    return adoptionCandidate(request.tenantId, provider, personId, id).catch(
      (cause: unknown) => {
        throw adoptionProblem(cause);
      },
    );
  },
);

app.post(
  '/targets/:id/accounts/:personId/adopt',
  { preHandler: requirePermission(PERMISSIONS.PROVISION_MANAGE) },
  async (request) => {
    const { id, personId } = placementParams.parse(request.params);
    const body = adoptAccountRequest.parse(request.body);
    return adoptAccount(request.tenantId, provider, {
      personId,
      targetSystemId: id,
      reason: body.reason,
      ifNoCandidate: body.ifNoCandidate,
      actorUserId: request.session.userId,
      sourceIp: request.ip,
    }).catch((cause: unknown) => {
      throw adoptionProblem(cause);
    });
  },
);
```

And a module-level helper in the same file, above `registerAdminTargetRoutes`:

```ts
/** The service's refusals, as problem responses. Shared by both routes. */
function adoptionProblem(cause: unknown): unknown {
  if (cause instanceof NoAccountToAdoptError) {
    return new ProblemError(409, 'nothing-to-adopt', 'There is no account to adopt', cause.message);
  }
  if (cause instanceof NotInConflictError) {
    return new ProblemError(409, 'not-in-conflict', 'This account is not in conflict', cause.message);
  }
  if (cause instanceof AnchorAlreadyBoundError) {
    return new ProblemError(409, 'anchor-already-bound', 'That object is already taken', cause.message);
  }
  if (cause instanceof CandidateNotVisibleError) {
    return new ProblemError(404, 'candidate-not-visible', 'That account is not visible here', cause.message);
  }
  return cause;
}
```

Add to the existing `@syntra/core` import block in `targets.ts`: `adoptAccount`, `adoptionCandidate`, `NoAccountToAdoptError`, `NotInConflictError`, `AnchorAlreadyBoundError`, `CandidateNotVisibleError`. Add `adoptAccountRequest` to the `@syntra/contracts` import block.

- [ ] **Step 5: Run tests and typecheck**

Run: `pnpm exec vitest run apps/api/src/routes/admin/targets.test.ts` then `pnpm typecheck`
Expected: PASS, clean.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/provision.ts apps/api/src/routes/admin/targets.ts apps/api/src/routes/admin/targets.test.ts
git commit -m "feat(api): adopt a conflicted account, and read the candidate first"
```

---

### Task 5: The console control

**Files:**
- Modify: `apps/web/src/pages/admin/PersonAccessPage.tsx`
- Test: `apps/web/src/pages/admin/PersonAccessPage.test.tsx`

**Interfaces:**
- Consumes: `POST /api/admin/targets/:id/accounts/:personId/adopt` and `GET …/adoption-candidate` from Task 4. The account's `status` is already in scope at `PersonAccessPage.tsx:454` as `account.status`.

- [ ] **Step 1: Write the failing tests**

`apps/web` has its own vitest config and no database, so this file runs in about a minute.

```tsx
it('offers adoption only for an account in conflict', async () => {
  renderPage({ accounts: [{ correlationKey: 'anna.novak', status: 'active' }] });
  expect(screen.queryByRole('button', { name: /adopt/i })).not.toBeInTheDocument();
});

it('shows the object it would bind before binding it', async () => {
  // The safeguard is a human looking at a specific object. A dialog that
  // showed only the name would be confirming a string.
  renderPage({ accounts: [{ correlationKey: 'anna.novak', status: 'conflict' }] });
  await userEvent.click(screen.getByRole('button', { name: /adopt/i }));
  expect(await screen.findByText('CN=Anna Novak,OU=Users,DC=acme,DC=test')).toBeInTheDocument();
});

it('will not submit without a reason', async () => {
  renderPage({ accounts: [{ correlationKey: 'anna.novak', status: 'conflict' }] });
  await userEvent.click(screen.getByRole('button', { name: /adopt/i }));
  await screen.findByText('CN=Anna Novak,OU=Users,DC=acme,DC=test');
  expect(screen.getByRole('button', { name: /^adopt this account$/i })).toBeDisabled();
});

it('offers creating it again only when the candidate is not visible', async () => {
  // Secondary, never the default: the administrator is answering a question,
  // and the wrong answer recreates the same conflict for ever.
  mockCandidate404('no object with that name is inside OU=Users,DC=acme,DC=test');
  renderPage({ accounts: [{ correlationKey: 'anna.novak', status: 'conflict' }] });
  await userEvent.click(screen.getByRole('button', { name: /adopt/i }));
  expect(await screen.findByText(/OU=Users,DC=acme,DC=test/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /create it again/i })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest run apps/web/src/pages/admin/PersonAccessPage.test.tsx -t "adopt"`
Expected: FAIL — no adopt button.

- [ ] **Step 3: Add the control**

Add this beside `Placement` in `PersonAccessPage.tsx`:

```tsx
/**
 * The way out of a conflicted account.
 *
 * `conflict` means the target refused to create this account because the name
 * was already taken, and no run clears it. Adoption binds the row to the
 * object that caused the refusal — a decision only a person can make, which is
 * why the DN is shown before the button does anything.
 */
function Adoption({
  personId,
  targetSystemId,
  correlationKey,
  onAdopted,
}: {
  personId: string;
  targetSystemId: string;
  correlationKey: string;
  onAdopted: () => void;
}) {
  const base = `/api/admin/targets/${targetSystemId}/accounts/${personId}`;
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [candidate, setCandidate] = useState<{ anchor: string; dn: string } | null>(null);
  const [missing, setMissing] = useState(false);

  // Read on open, never on mount: this is a live directory call for a control
  // most visits never touch.
  useEffect(() => {
    if (!open) return;
    setProblem(null);
    setMissing(false);
    fetch(`${base}/adoption-candidate`)
      .then(async (r) => {
        const body = await r.json();
        if (r.ok) return setCandidate(body);
        setMissing(body.type?.includes('candidate-not-visible') ?? false);
        setProblem(body.detail ?? 'The candidate could not be read.');
      })
      .catch(() => setProblem('The candidate could not be read.'));
  }, [open, base]);

  async function submit(ifNoCandidate?: 'reset') {
    setBusy(true);
    setProblem(null);
    try {
      const response = await fetch(`${base}/adopt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason, ...(ifNoCandidate ? { ifNoCandidate } : {}) }),
      });
      if (!response.ok) {
        const body = await response.json();
        setProblem(body.detail ?? 'That did not work.');
        return;
      }
      setOpen(false);
      onAdopted();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-t border-border-subtle p-4">
      <div className="flex flex-wrap items-center gap-3">
        <Status tone="danger">In conflict</Status>
        <span className="text-sm text-muted">
          The target already has an account called{' '}
          <code className="font-mono">{correlationKey}</code>.
        </span>
        <Button variant="ghost" size="sm" onClick={() => setOpen((v) => !v)}>
          Adopt
        </Button>
      </div>

      {open && (
        <div className="mt-3 space-y-3">
          {candidate && (
            <>
              <div className="font-mono text-sm text-ink">{candidate.dn}</div>
              <Alert tone="warning">
                From now on Syntra manages this account: it writes this profile&rsquo;s
                attributes onto it, moves it when its org unit changes, and disables
                and archives it when the person leaves.
              </Alert>
            </>
          )}
          {problem && <Alert tone="danger">{problem}</Alert>}
          <Field label="Why" value={reason} onChange={setReason} required />
          <div className="flex gap-2">
            {candidate && (
              <Button
                variant="primary"
                size="sm"
                loading={busy}
                disabled={reason.trim() === ''}
                onClick={() => submit()}
              >
                Adopt this account
              </Button>
            )}
            {missing && (
              <Button
                variant="secondary"
                size="sm"
                loading={busy}
                disabled={reason.trim() === ''}
                onClick={() => submit('reset')}
              >
                Create it again
              </Button>
            )}
            <Button variant="secondary" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
```

Render it from the account block, beside `<Placement …>`:

```tsx
{account.status === 'conflict' && (
  <Adoption
    personId={personId}
    targetSystemId={target.id}
    correlationKey={account.correlationKey}
    onAdopted={reload}
  />
)}
```

Note *Create it again* appears **only** when the candidate lookup returned `candidate-not-visible`, is `variant="secondary"`, and still requires a reason. It is the administrator answering a question, and the wrong answer recreates the same conflict for ever.

- [ ] **Step 4: Run tests**

Run: `pnpm exec vitest run apps/web/src/pages/admin/PersonAccessPage.test.tsx` then `pnpm typecheck`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/admin/PersonAccessPage.tsx apps/web/src/pages/admin/PersonAccessPage.test.tsx
git commit -m "feat(console): adopt a conflicted account from the person's access screen"
```

---

## Final verification

- [ ] `pnpm exec vitest run packages/core/src/provision/adoption-service.test.ts` — 13 pass
- [ ] `pnpm exec vitest run apps/api/src/routes/admin/targets.test.ts` — pass
- [ ] `pnpm exec vitest run apps/web/src/pages/admin/PersonAccessPage.test.tsx` — pass
- [ ] `pnpm exec vitest run packages/core/src/provision/reconcile.test.ts` — unchanged, still passes; adoption writes no new state reconcile reads
- [ ] `pnpm typecheck` — clean

Run these one at a time. Two vitest runs at once in this checkout corrupt each other and produce failures scattered across files the change never touched.
