import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
// `@syntra/connectors/testing`, not the package root. Commit `00b7631` took
// `FakeTarget` out of the root barrel deliberately -- a fake reachable from
// production code is a fake that will eventually be reached -- and the package
// declares an `exports` map, so the root import the brief specified does not
// resolve at all.
import type { WriteOperation, WriteResult } from '@syntra/connectors';
import { FakeTarget } from '@syntra/connectors/testing';
import { localMasterKeyProvider } from '../vault/master-key.js';
import { getSecret } from '../vault/vault-service.js';
import {
  createTarget,
  updateTarget,
  upsertAccountProfile,
  upsertBusinessRule,
} from './target-service.js';
import { previewProvisionRun } from './run-service.js';
import {
  applyProvisionRun,
  backoffMs,
  generateInitialPassword,
  ProvisionRunNotAppliableError,
  resolveInFlightActions,
} from './apply.js';

const provider = localMasterKeyProvider(Buffer.alloc(32, 7));
const USERS = 'OU=Users,DC=acme,DC=test';
const FINANCE_DN = 'CN=Finance,OU=Groups,DC=acme,DC=test';
const SOCIAL_DN = 'CN=Social,OU=Groups,DC=acme,DC=test';
const NOW = new Date('2026-06-15T00:00:00Z');
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
const noSleep = async () => undefined;

let tenantId: string;
let targetId: string;
let entitlementId: string;
let target: FakeTarget;

const config = {
  url: 'ldaps://dc.acme.test:636',
  tlsMode: 'ldaps',
  rejectUnauthorized: false,
  bindDn: 'CN=svc,DC=acme,DC=test',
  baseDn: 'OU=Users,DC=acme,DC=test',
  entitlementSearchBase: 'OU=Groups,DC=acme,DC=test',
  archiveContainer: 'OU=Archive,DC=acme,DC=test',
};

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  const created = await createTarget(tenantId, provider, null, {
    name: 'Acme AD',
    config,
    bindPassword: 'secret',
  });
  targetId = created.id;
  target = new FakeTarget();
  target.containers.push(USERS);
  target.entitlements.push({
    externalId: 'guid-finance',
    dn: FINANCE_DN,
    type: 'group',
    displayName: 'Finance',
  });

  entitlementId = await withTenant(tenantId, async (tx) => {
    const person = await tx.person.create({
      data: { tenantId, givenName: 'Anna', familyName: 'Novak' },
    });
    await tx.contract.create({
      data: {
        tenantId,
        personId: person.id,
        sequence: 1,
        isPrimary: true,
        startDate: day('2020-01-01'),
        department: 'Finance',
      },
    });
    const entitlement = await tx.entitlement.create({
      data: {
        tenantId,
        targetSystemId: targetId,
        externalId: 'guid-finance',
        dn: FINANCE_DN,
        type: 'group',
        displayName: 'Finance',
      },
    });
    return entitlement.id;
  });

  await upsertAccountProfile(tenantId, null, targetId, {
    correlationKeyTemplate: '%person.givenName.first%.%person.familyName%',
    maxUniquenessAttempts: 20,
    containerTemplate: 'OU=Users,DC=acme,DC=test',
    fallbackContainer: 'OU=Users,DC=acme,DC=test',
    attributeTemplates: { displayName: '%person.givenName% %person.familyName%' },
    initialPasswordPolicy: { length: 24 },
    initialPasswordDelivery: 'vaultOnly',
  });
  await upsertBusinessRule(tenantId, null, targetId, {
    name: 'Finance staff',
    condition: { field: 'contract.department', op: 'equals', value: 'Finance' },
    grantsAccount: true,
    enabled: true,
    entitlementIds: [entitlementId],
  });
});

/** A real user, because confirming a run records who confirmed it. */
const seedConfirmingUser = () =>
  withTenant(tenantId, async (tx) => {
    const user = await tx.user.create({
      data: {
        tenantId,
        login: 'reviewer',
        email: 'reviewer@acme.test',
        displayName: 'Reviewer',
      },
    });
    return user.id;
  });

const previewAndApply = async (only?: string[]) => {
  const run = await previewProvisionRun(tenantId, provider, targetId, {
    now: NOW,
    connector: target as never,
  });
  const confirmedByUserId = await seedConfirmingUser();
  const result = await applyProvisionRun(tenantId, provider, run.id, {
    // BOTH. `confirmedByUserId: null` alone used to satisfy the gate, because
    // it was keyed on the parameter being present rather than on anybody
    // having confirmed anything.
    confirm: true,
    confirmedByUserId,
    connector: target as never,
    now: NOW,
    sleep: noSleep,
    ...(only === undefined ? {} : { only }),
  });
  return { runId: run.id, result, confirmedByUserId };
};

// `sequence`, not `createdAt`: every row phase 7 wrote carries the same
// createdAt, because PostgreSQL's now() is transaction start time.
const actionsOf = (runId: string) =>
  withTenant(tenantId, (tx) =>
    tx.provisionAction.findMany({ where: { runId }, orderBy: { sequence: 'asc' } }),
  );

const eventsOf = (prefix: string) =>
  withTenant(tenantId, (tx) =>
    tx.auditEvent.findMany({
      where: { action: { startsWith: prefix } },
      orderBy: { sequence: 'asc' },
    }),
  );

/** A person who has already left, with an account and an object at the target. */
async function seedLeaver(
  givenName: string,
  familyName: string,
  correlationKey: string,
  options: { endDate: Date; holds?: string[] } = { endDate: day('2026-06-01') },
) {
  const created = await target.write({ domain: 'acme.test' } as never, {
    op: 'create_account',
    actionId: `seed-${correlationKey}`,
    correlationKey,
    attributes: { distinguishedName: [`CN=${correlationKey},${USERS}`] },
    enabled: true,
    initialPassword: 'Aa1!seed-password',
  });
  const anchor = created.anchor!;
  for (const externalId of options.holds ?? []) {
    await target.write({ domain: 'acme.test' } as never, {
      op: 'grant_entitlement',
      actionId: `seed-g-${correlationKey}`,
      anchor,
      entitlementId: externalId,
    });
  }
  return withTenant(tenantId, async (tx) => {
    const person = await tx.person.create({
      data: { tenantId, givenName, familyName },
    });
    await tx.contract.create({
      data: {
        tenantId,
        personId: person.id,
        sequence: 1,
        isPrimary: true,
        startDate: day('2020-01-01'),
        endDate: options.endDate,
        department: 'Finance',
      },
    });
    const account = await tx.targetAccount.create({
      data: {
        tenantId,
        targetSystemId: targetId,
        personId: person.id,
        anchor,
        correlationKey,
        status: 'active',
        lastAppliedAttributes: { displayName: [`${givenName} ${familyName}`] },
      },
    });
    return { personId: person.id, accountId: account.id, anchor };
  });
}

/** The one person the default fixture describes, removed. */
const dropAnna = () =>
  withTenant(tenantId, async (tx) => {
    const anna = await tx.person.findFirstOrThrow({ where: { givenName: 'Anna' } });
    await tx.contract.deleteMany({ where: { personId: anna.id } });
    await tx.person.delete({ where: { id: anna.id } });
  });

/**
 * Anna gone, and one person left who still holds an active contract.
 *
 * The bystander is not decoration. `evaluateProvisionGuard` refuses a run with
 * no person holding an active contract at all -- OUTRIGHT, not pending
 * confirmation, because that is the signature of a broken HR feed and is
 * upstream of every leaver action a plan could contain. A fixture that leaves
 * only leavers therefore tests the population refusal and nothing else. Her
 * department is named by no business rule, so she needs no account and
 * contributes no actions.
 */
const leaversOnly = async () => {
  await withTenant(tenantId, async (tx) => {
    const person = await tx.person.create({
      data: { tenantId, givenName: 'Cor', familyName: 'Jansen' },
    });
    await tx.contract.create({
      data: {
        tenantId,
        personId: person.id,
        sequence: 1,
        isPrimary: true,
        startDate: day('2020-01-01'),
        department: 'Legal',
      },
    });
  });
  await dropAnna();
};

/** A connector that answers one operation itself and delegates the rest. */
const intercepting = (
  op: WriteOperation['op'],
  answer: (operation: WriteOperation) => WriteResult | undefined,
) => ({
  test: (c: never) => target.test(c),
  discoverSchema: (c: never) => target.discoverSchema(c),
  listEntitlements: (c: never) => target.listEntitlements(c),
  listContainers: (c: never) => target.listContainers(c),
  readEntitlementMembers: (c: never, dn: string) => target.readEntitlementMembers(c, dn),
  read: (c: never) => target.read(c),
  write: async (c: never, operation: WriteOperation) => {
    if (operation.op === op) {
      const answered = answer(operation);
      if (answered !== undefined) return answered;
    }
    return target.write(c, operation as never);
  },
});

describe('backoffMs', () => {
  it('grows exponentially and adds jitter', () => {
    expect(backoffMs(1, () => 0)).toBe(1000);
    expect(backoffMs(2, () => 0)).toBe(2000);
    expect(backoffMs(3, () => 0)).toBe(4000);
    expect(backoffMs(1, () => 1)).toBe(1250);
  });

  it('stops growing at a ceiling rather than reaching infinity', () => {
    // `maxAttempts` is bounded at 10 by the profile schema, but nothing in
    // this function is: `2 ** (attempt - 1)` overflows to Infinity, and
    // `sleep(Infinity)` is a run that never finishes -- which is the same
    // outcome as the unbounded throttle loop below, reached by arithmetic.
    expect(backoffMs(40, () => 0)).toBe(60_000);
    expect(backoffMs(1024, () => 0)).toBe(60_000);
    expect(Number.isFinite(backoffMs(1024, () => 1))).toBe(true);
  });
});

describe('generateInitialPassword', () => {
  it('honours the policy rather than a hardcoded shape', () => {
    const password = generateInitialPassword({ length: 32 });
    expect(password).toHaveLength(32);
    expect(password).toMatch(/[A-Z]/);
    expect(password).toMatch(/[a-z]/);
    expect(password).toMatch(/[0-9]/);
    expect(password).toMatch(/[^A-Za-z0-9]/);
  });

  it('omits a class the policy switches off', () => {
    for (let i = 0; i < 20; i += 1) {
      expect(generateInitialPassword({ requireSymbol: false })).not.toMatch(
        /[!@#$%^&*\-_=+]/,
      );
    }
  });

  it('never returns the same password twice', () => {
    const seen = new Set(
      Array.from({ length: 50 }, () => generateInitialPassword({ length: 24 })),
    );
    expect(seen.size).toBe(50);
  });

  it('shuffles, so the class of each position is not fixed', () => {
    // One character from each required class, then fill, then shuffle. Without
    // the shuffle the first four characters are always upper, lower, digit,
    // symbol in that order -- which is 12 of a 24-character password's entropy
    // given away to anybody who has ever seen one of them.
    const firsts = new Set(
      Array.from({ length: 60 }, () => generateInitialPassword({ length: 24 })[0]!),
    );
    expect([...firsts].some((c) => !/[A-Z]/.test(c))).toBe(true);
  });

  it('will not produce a password shorter than sixteen characters', () => {
    expect(generateInitialPassword({ length: 4 })).toHaveLength(16);
    expect(generateInitialPassword({ length: 1024 })).toHaveLength(128);
  });

  it('still produces a password when the policy requires no class at all', () => {
    // Every flag off leaves no alphabet to draw from: `chars` starts empty,
    // `alphabet` is the empty string, and `randomInt(0)` throws a RangeError.
    // A policy naming no character class is not one this function can honour,
    // and the safe reading of it is not "no password".
    const password = generateInitialPassword({
      requireUpper: false,
      requireLower: false,
      requireDigit: false,
      requireSymbol: false,
    });
    expect(password).toHaveLength(24);
    expect(password).toMatch(/^[A-Za-z0-9]+$/);
  });
});

describe('applyProvisionRun', () => {
  it('refuses to apply a blocked run that was never confirmed', async () => {
    const run = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    // The guard is not advisory, and the scheduler never confirms anything.
    await expect(
      applyProvisionRun(tenantId, provider, run.id, {
        connector: target as never,
        sleep: noSleep,
      }),
    ).rejects.toThrow(/blocked/);
  });

  it('refuses a blocked run when a caller passes a null confirming user', async () => {
    // The hole. `confirmedByUserId: null` is what an internal caller writes
    // when it has nobody to name, and keying the gate on the parameter being
    // PRESENT let that through -- so a blocked run applied with no confirming
    // user recorded, which is exactly what spec section 11 says cannot happen.
    const run = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    await expect(
      applyProvisionRun(tenantId, provider, run.id, {
        confirmedByUserId: null,
        connector: target as never,
        sleep: noSleep,
      }),
    ).rejects.toThrow(/blocked/);
  });

  it('refuses a blocked run confirmed with no user, and one naming a user without confirming', async () => {
    // Both halves are required. Either alone is somebody's discipline rather
    // than the guard's contract.
    const run = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    await expect(
      applyProvisionRun(tenantId, provider, run.id, {
        confirm: true,
        confirmedByUserId: null,
        connector: target as never,
        sleep: noSleep,
      }),
    ).rejects.toThrow(/blocked/);

    const userId = await seedConfirmingUser();
    await expect(
      applyProvisionRun(tenantId, provider, run.id, {
        confirmedByUserId: userId,
        connector: target as never,
        sleep: noSleep,
      }),
    ).rejects.toThrow(/blocked/);
  });

  it('refuses a run the guard refused OUTRIGHT, however it is confirmed', async () => {
    // Ruling P25's second half, at the call site. `GuardVerdict` carries
    // `requiresConfirmation: false` for the refusals where there is nothing an
    // administrator could usefully confirm -- an empty or unreachable target,
    // a collapsed person population, an axis whose denominator is missing --
    // and `ProvisionRun.requiresConfirmation` records it. A gate keyed on
    // `status === 'blocked'` alone lets `confirm: true` override every one of
    // them, which is the whole control: a run planned against a directory that
    // may simply be unreachable would be applied on a tick.
    await dropAnna();
    const run = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    expect(run.status).toBe('blocked');
    expect(run.requiresConfirmation).toBe(false);
    await expect(
      applyProvisionRun(tenantId, provider, run.id, {
        confirm: true,
        confirmedByUserId: await seedConfirmingUser(),
        connector: target as never,
        sleep: noSleep,
      }),
    ).rejects.toThrow(/cannot be confirmed/);
  });

  it('refuses a run that is not awaiting an apply', async () => {
    // A run that has already been applied, adopted, superseded or failed is
    // history. Re-applying one flips a terminal row back to `applying`,
    // rewrites its outcome, and -- because a superseded run's actions are the
    // decisions a later run already reversed -- is one of the ways a departed
    // person gets their access back.
    const { runId, confirmedByUserId } = await previewAndApply();
    await expect(
      applyProvisionRun(tenantId, provider, runId, {
        confirm: true,
        confirmedByUserId,
        connector: target as never,
        sleep: noSleep,
      }),
    ).rejects.toThrow(ProvisionRunNotAppliableError);
  });

  it('applies a confirmed run and records the confirming user', async () => {
    const { runId, result, confirmedByUserId } = await previewAndApply();
    expect(result.status).toBe('applied');
    expect(result.applied).toBe(2);
    const run = await withTenant(tenantId, (tx) =>
      tx.provisionRun.findUniqueOrThrow({ where: { id: runId } }),
    );
    expect(run.status).toBe('applied');
    // The confirming user, by id. The previous version asserted this was null
    // -- which certified the hole instead of catching it.
    expect(run.confirmedByUserId).toBe(confirmedByUserId);
    // `hasEverApplied` on the target, which is what takes the guard off its
    // first-run refusal and puts every threshold axis into play.
    const system = await withTenant(tenantId, (tx) =>
      tx.targetSystem.findUniqueOrThrow({ where: { id: targetId } }),
    );
    expect(system.lastAppliedRunAt).not.toBeNull();
  });

  it('writes the anchor back onto the account after a create', async () => {
    await previewAndApply();
    const account = await withTenant(tenantId, (tx) =>
      tx.targetAccount.findFirstOrThrow({}),
    );
    expect(account.anchor).toMatch(/^fake-anchor-/);
    expect(account.status).toBe('active');
    // The action that made it, so a later run can tell an object Provision
    // created from one it merely found.
    expect(account.createdActionId).not.toBeNull();
    expect(account.lastReconciledAt).not.toBeNull();
  });

  it('records the holding with its origin and granting rule', async () => {
    await previewAndApply();
    const holding = await withTenant(tenantId, (tx) =>
      tx.accountEntitlement.findFirstOrThrow({}),
    );
    // origin separates convergence from drift and is not derivable after the
    // fact, so it is recorded at the moment of the grant.
    expect(holding.origin).toBe('rule');
    expect(holding.state).toBe('held');
    expect(holding.grantedByRuleId).not.toBeNull();
  });

  it('seals the initial password into the vault and never writes it anywhere else', async () => {
    // Ruling P12. A generated credential that is never delivered is not a
    // feature: the connector used to invent the password, write it to the
    // directory and drop it, so `initialPasswordPolicy` and
    // `initialPasswordDelivery` were schema, contracts and a <select> with no
    // behaviour behind them -- and no account Provision created was usable by
    // the person it was created for.
    const { runId } = await previewAndApply();

    const account = await withTenant(tenantId, (tx) =>
      tx.targetAccount.findFirstOrThrow({}),
    );
    const secretName = `target/${targetId}/initial/${account.id}`;
    const password = await withTenant(tenantId, (tx) =>
      getSecret(tx, provider, secretName),
    );
    expect(password).not.toBeNull();
    expect(password!.length).toBeGreaterThanOrEqual(16);

    // And the second half, which matters as much as the first: this is the
    // slice where secrets start flowing through action rows and audit events.
    const actions = await actionsOf(runId);
    // The events the APPLY wrote. Not every `provision.` event: the profile
    // upsert's payload legitimately carries `initialPasswordDelivery`, whose
    // name contains `initialPassword` as a substring, so the brief's wider
    // query fails on a configuration value that is not a secret and never was.
    const events = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({
        where: {
          OR: [
            { action: { startsWith: 'provision.action.' } },
            { action: { startsWith: 'provision.credential.' } },
            { action: 'provision.run.apply' },
          ],
        },
      }),
    );
    expect(events.length).toBeGreaterThan(0);
    const serialised = JSON.stringify({ actions, events });
    expect(serialised).not.toContain(password!);
    expect(serialised).not.toContain('unicodePwd');
    expect(serialised).not.toContain('initialPassword');
  });

  it('writes an intent event before the call and a result event after it', async () => {
    const { runId } = await previewAndApply();
    const events = await eventsOf('provision.action.');
    // An audit log that only records completions cannot distinguish "we never
    // tried" from "we tried and never found out".
    expect(events.map((e) => e.action)).toEqual([
      'provision.action.intent',
      'provision.action.result',
      'provision.action.intent',
      'provision.action.result',
    ]);
    void runId;
  });

  it('writes one intent event per attempt, not one per action', async () => {
    target.program('create_account', { failTimes: 2, failure: 'transient' });
    await previewAndApply();
    const intents = (await eventsOf('provision.action.intent')).filter(
      (e) => (e.payload as { actionType?: string }).actionType === 'create_account',
    );
    expect(intents.map((e) => (e.payload as { attempt?: number }).attempt)).toEqual([
      1, 2, 3,
    ]);
  });

  it('applies only the actions named in `only` and leaves the rest proposed', async () => {
    const run = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    const all = await actionsOf(run.id);
    const createId = all.find((a) => a.actionType === 'create_account')!.id;

    const result = await applyProvisionRun(tenantId, provider, run.id, {
      only: [createId],
      confirm: true,
      confirmedByUserId: await seedConfirmingUser(),
      connector: target as never,
      sleep: noSleep,
    });
    // One conflicting person does not force the whole run to be abandoned or
    // applied wholesale.
    expect(result.status).toBe('partially_applied');
    const after = await actionsOf(run.id);
    expect(after.find((a) => a.id === createId)!.status).toBe('applied');
    expect(after.find((a) => a.actionType === 'grant_entitlement')!.status).toBe(
      'proposed',
    );
  });

  it('applies nothing at all when `only` names nothing', async () => {
    // The empty case is the universal case on this slice four times over. An
    // `only: []` that fell back to "every action" would apply a whole run to a
    // caller that asked for none of it.
    const run = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    const result = await applyProvisionRun(tenantId, provider, run.id, {
      only: [],
      confirm: true,
      confirmedByUserId: await seedConfirmingUser(),
      connector: target as never,
      sleep: noSleep,
    });
    expect(result.applied).toBe(0);
    expect(result.skipped).toBe(2);
    expect(target.objects.size).toBe(0);
  });

  it('retries a transient failure within the run and succeeds', async () => {
    target.program('create_account', { failTimes: 2, failure: 'transient' });
    const { runId, result } = await previewAndApply();
    expect(result.status).toBe('applied');
    const actions = await actionsOf(runId);
    expect(actions.find((a) => a.actionType === 'create_account')!.attempts).toBe(3);
  });

  it('leaves an action pending_retry when it exhausts maxAttempts', async () => {
    target.program('create_account', { failTimes: Infinity, failure: 'transient' });
    const { runId, result } = await previewAndApply();
    // pending_retry, not failed: the next run for this target picks it up,
    // provided the plan still wants it.
    expect(result.pendingRetry).toBe(1);
    expect(result.status).toBe('partially_applied');
    const actions = await actionsOf(runId);
    const create = actions.find((a) => a.actionType === 'create_account')!;
    expect(create.status).toBe('pending_retry');
    // Three attempts, because `maxAttempts` is three. A column that says four
    // after three calls is a column nobody can use.
    expect(create.attempts).toBe(3);
  });

  it('honours a maxAttempts the administrator lowered', async () => {
    await updateTarget(tenantId, provider, null, targetId, { maxAttempts: 1 });
    target.program('create_account', { failTimes: Infinity, failure: 'transient' });
    const { runId } = await previewAndApply();
    const create = (await actionsOf(runId)).find(
      (a) => a.actionType === 'create_account',
    )!;
    expect(create.attempts).toBe(1);
    expect(create.status).toBe('pending_retry');
  });

  it('never retries a permanent rejection', async () => {
    target.program('create_account', { failTimes: Infinity, failure: 'rejected' });
    const { runId } = await previewAndApply();
    const action = (await actionsOf(runId)).find(
      (a) => a.actionType === 'create_account',
    )!;
    // A schema violation and a refused password complexity do not become true
    // on the fourth attempt.
    expect(action.status).toBe('failed');
    expect(action.attempts).toBe(1);
  });

  it('marks a conflict as conflict and puts the account in conflict', async () => {
    // Seeded AFTER the preview, which is the only way this case arises. The
    // preview's `taken` set unions Syntra's own keys with the target's
    // inventory, so an object seeded BEFORE it simply makes the generator pick
    // `anna.novak2` and the create succeeds -- the brief's version of this
    // test proved the uniqueness generator works, not the conflict path.
    // Somebody creating the object between the plan and the write is exactly
    // the race the provenance check exists for.
    const run = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    target.seedForeignObject('anna.novak');
    const runId = run.id;
    await applyProvisionRun(tenantId, provider, runId, {
      confirm: true,
      confirmedByUserId: await seedConfirmingUser(),
      connector: target as never,
      sleep: noSleep,
    });
    const action = (await actionsOf(runId)).find(
      (a) => a.actionType === 'create_account',
    )!;
    expect(action.status).toBe('conflict');
    expect(action.attempts).toBe(1);
    const account = await withTenant(tenantId, (tx) =>
      tx.targetAccount.findFirstOrThrow({}),
    );
    expect(account.status).toBe('conflict');
    expect(account.statusReason).toMatch(/already exists/);
  });

  it('honours retryAfterMs on a throttle without counting it against maxAttempts', async () => {
    const waits: number[] = [];
    target.program('create_account', {
      failTimes: 5,
      failure: 'throttled',
      retryAfterMs: 250,
    });
    const run = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    await applyProvisionRun(tenantId, provider, run.id, {
      connector: target as never,
      confirm: true,
      confirmedByUserId: await seedConfirmingUser(),
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    expect(waits.filter((w) => w === 250).length).toBeGreaterThanOrEqual(5);
    const action = (await actionsOf(run.id)).find(
      (a) => a.actionType === 'create_account',
    )!;
    // Throttles are not counted against maxAttempts, so the action still had
    // its full budget of real attempts.
    expect(action.attempts).toBeLessThanOrEqual(3);
  });

  it('gives up on a target that throttles forever instead of hanging', async () => {
    // Without a ceiling this loop is unbounded: no counter, no wall clock. A
    // target that throttles indefinitely hangs the apply, the run stays
    // `applying`, and per the adoption rules in Task 13 that is a run somebody
    // has to have adopted before the target can be used again.
    target.program('create_account', {
      failTimes: Infinity,
      failure: 'throttled',
      retryAfterMs: 10,
    });
    const run = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    const result = await applyProvisionRun(tenantId, provider, run.id, {
      confirm: true,
      confirmedByUserId: await seedConfirmingUser(),
      connector: target as never,
      sleep: noSleep,
    });
    expect(result.pendingRetry).toBe(1);
    const action = (await actionsOf(run.id)).find(
      (a) => a.actionType === 'create_account',
    )!;
    expect(action.status).toBe('pending_retry');
    expect(action.message).toMatch(/throttl/i);
  });

  it('gives up on a throttle whose retryAfterMs is not a usable number', async () => {
    // A wait budget is a bound only if every wait is positive and finite. A
    // target answering `retryAfterMs: 0` -- or NaN, or a negative number --
    // never advances the accumulated total, so the budget alone is not a
    // ceiling at all and the loop spins forever on a value the target chose.
    const waits: number[] = [];
    target.program('create_account', {
      failTimes: Infinity,
      failure: 'throttled',
      retryAfterMs: 0,
    });
    const run = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    const result = await applyProvisionRun(tenantId, provider, run.id, {
      confirm: true,
      confirmedByUserId: await seedConfirmingUser(),
      connector: target as never,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    expect(result.pendingRetry).toBe(1);
    // Bounded by the COUNT. With only the wait budget the fallback backoff is
    // about a second, so this loop would run ninety-odd times -- terminating,
    // but a hundred connector calls and a hundred audit rows for one action.
    expect(waits.length).toBeLessThan(30);
    expect(waits.every((w) => Number.isFinite(w) && w > 0)).toBe(true);
  });

  it('gives up on a throttle whose retryAfterMs is not a number at all', async () => {
    // `NaN` defeats the budget from the other side: `throttledForMs + NaN >
    // budget` is false forever, so the accumulated total never trips and
    // `sleep(NaN)` returns at once.
    const waits: number[] = [];
    target.program('create_account', {
      failTimes: Infinity,
      failure: 'throttled',
      retryAfterMs: Number.NaN,
    });
    const run = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    const result = await applyProvisionRun(tenantId, provider, run.id, {
      confirm: true,
      confirmedByUserId: await seedConfirmingUser(),
      connector: target as never,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    expect(result.pendingRetry).toBe(1);
    expect(waits.length).toBeLessThan(30);
    expect(waits.every((w) => Number.isFinite(w) && w > 0)).toBe(true);
  });

  it('stops waiting when the target asks for more patience than the budget allows', async () => {
    // The other bound, and the one the count cannot supply: a target that asks
    // for a minute each time would get twenty minutes of an apply's life for
    // one action, with every later action -- the disables, the revocations,
    // the archives -- waiting behind it.
    const waits: number[] = [];
    target.program('create_account', {
      failTimes: Infinity,
      failure: 'throttled',
      retryAfterMs: 60_000,
    });
    const run = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    const result = await applyProvisionRun(tenantId, provider, run.id, {
      confirm: true,
      confirmedByUserId: await seedConfirmingUser(),
      connector: target as never,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    expect(result.pendingRetry).toBe(1);
    // Two waits of a minute reach the budget; a third would pass it.
    expect(waits).toEqual([60_000, 60_000]);
  });

  it('never puts a network call inside a transaction', async () => {
    // The connector records how long the database was idle around each call.
    // A write inside a transaction would hold a connection for its duration,
    // and Prisma's default 5000 ms would kill it. This asserts the shape
    // rather than the timing: the action is marked in_flight and COMMITTED
    // before the connector is called.
    const seen: string[] = [];
    const observing = new FakeTarget();
    observing.containers.push(USERS);
    observing.entitlements.push({
      externalId: 'guid-finance',
      dn: FINANCE_DN,
      type: 'group',
      displayName: 'Finance',
    });
    const original = observing.write.bind(observing);
    observing.write = async (cfg, op) => {
      const row = await withTenant(tenantId, (tx) =>
        tx.provisionAction.findFirst({ where: { actionType: op.op } }),
      );
      seen.push(row?.status ?? 'absent');
      return original(cfg, op);
    };
    const run = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: observing as never,
    });
    await applyProvisionRun(tenantId, provider, run.id, {
      connector: observing as never,
      confirm: true,
      confirmedByUserId: await seedConfirmingUser(),
      sleep: noSleep,
    });
    // Readable from another transaction while the connector runs, which is
    // only possible if the marker was committed first.
    expect(seen).toContain('in_flight');
  });

  it('escapes the correlation key it renders into a distinguished name', async () => {
    // Ruling P22, at the one site left that builds a DN outside
    // `renderContainer`. The connector escapes the key when IT builds the DN
    // and uses `attributes.distinguishedName` VERBATIM when the caller supplies
    // one, so an unescaped value here is a valid distinguished name naming a
    // container nobody chose.
    //
    // The value is put on the action rather than on the person, because
    // `names.ts` sanitises a generated key down to `[a-z0-9.-]` and could not
    // produce this. That is exactly the reason to close it structurally: the
    // safety today comes from what happens to be upstream, and this function
    // is reachable from anything that writes a `ProvisionAction`.
    const run = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    const create = (await actionsOf(run.id)).find(
      (a) => a.actionType === 'create_account',
    )!;
    await withTenant(tenantId, (tx) =>
      tx.provisionAction.update({
        where: { id: create.id },
        data: {
          after: {
            correlationKey: 'novak,OU=Domain Controllers,DC=acme,DC=test',
            container: USERS,
            attributes: {},
            enabled: true,
          },
        },
      }),
    );
    await applyProvisionRun(tenantId, provider, run.id, {
      only: [create.id],
      confirm: true,
      confirmedByUserId: await seedConfirmingUser(),
      connector: target as never,
      sleep: noSleep,
    });
    const call = target.calls.find((c) => c.op === 'create_account') as
      | Extract<WriteOperation, { op: 'create_account' }>
      | undefined;
    expect(call).toBeDefined();
    expect(call!.attributes.distinguishedName![0]).toBe(
      `CN=novak\\,OU\\=Domain Controllers\\,DC\\=acme\\,DC\\=test,${USERS}`,
    );
  });
});

describe('applyProvisionRun: one bad action does not discard the rest', () => {
  /**
   * Two Syntra logins for one leaver, the first of which cannot be applied.
   *
   * Ruling P29 made a person's two logins two actions precisely so that both
   * are taken away. If one failing abandons the loop, the fix is undone: the
   * survivor is once again a live login belonging to somebody who has left,
   * and nothing ever re-examines it inside this run.
   */
  const seedTwoLogins = async () => {
    const { personId, anchor } = await seedLeaver('Bea', 'Vos', 'bea.vos');
    return withTenant(tenantId, async (tx) => {
      const source = await tx.directorySource.create({
        data: { tenantId, name: 'AD', type: 'ldap', config: {}, secretName: 's' },
      });
      await tx.targetSystem.update({
        where: { id: targetId },
        data: { pairedDirectorySourceId: source.id },
      });
      const everyday = await tx.user.create({
        data: {
          tenantId,
          login: 'a.bea.vos',
          email: 'bea@acme.test',
          displayName: 'Bea',
          personId,
          sourceId: source.id,
          sourceAnchor: anchor,
          status: 'active',
        },
      });
      // The admin login carries no source anchor: `@@unique([tenantId,
      // sourceId, sourceAnchor])` refuses two rows claiming the same object,
      // and `person-service.ts` links the second login by hand. Both are
      // still linked to the person, which is the only thing the plan reads.
      const admin = await tx.user.create({
        data: {
          tenantId,
          login: 'z.adm-bea',
          email: 'adm-bea@acme.test',
          displayName: 'Bea (admin)',
          personId,
          status: 'active',
        },
      });
      return { personId, everyday: everyday.id, admin: admin.id };
    });
  };

  it('applies a person\'s second login when the first cannot be applied', async () => {
    const { everyday, admin } = await seedTwoLogins();
    await leaversOnly();
    const run = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    const deactivations = (await actionsOf(run.id)).filter(
      (a) => a.actionType === 'deactivate_syntra_user',
    );
    expect(deactivations).toHaveLength(2);
    // The FIRST in sequence order is broken: its payload names a login that is
    // no longer there. `applySyntraUserAction` throws, and an uncaught throw
    // abandons every action after it -- including the other login.
    await withTenant(tenantId, (tx) =>
      tx.provisionAction.update({
        where: { id: deactivations[0]!.id },
        data: { after: { status: 'inactive', userId: '' } },
      }),
    );

    const result = await applyProvisionRun(tenantId, provider, run.id, {
      confirm: true,
      confirmedByUserId: await seedConfirmingUser(),
      connector: target as never,
      sleep: noSleep,
    });
    expect(result.failed).toBeGreaterThanOrEqual(1);

    const after = await actionsOf(run.id);
    expect(after.find((a) => a.id === deactivations[0]!.id)!.status).toBe('failed');
    expect(after.find((a) => a.id === deactivations[1]!.id)!.status).toBe('applied');

    const users = await withTenant(tenantId, (tx) =>
      tx.user.findMany({ where: { id: { in: [everyday, admin] } } }),
    );
    // One of the two is still active, because its action was sabotaged. The
    // other is not, because a failure on one login is not a reason to leave a
    // departed person holding the second.
    expect(users.filter((u) => u.status === 'inactive')).toHaveLength(1);
  });

  it('counts a Syntra action as applied only after it has been', async () => {
    const { everyday } = await seedTwoLogins();
    await leaversOnly();
    const run = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    const deactivations = (await actionsOf(run.id)).filter(
      (a) => a.actionType === 'deactivate_syntra_user',
    );
    for (const action of deactivations) {
      await withTenant(tenantId, (tx) =>
        tx.provisionAction.update({
          where: { id: action.id },
          data: { after: { status: 'inactive', userId: '' } },
        }),
      );
    }
    const result = await applyProvisionRun(tenantId, provider, run.id, {
      confirm: true,
      confirmedByUserId: await seedConfirmingUser(),
      connector: target as never,
      sleep: noSleep,
    });
    // Both deactivations failed, and `applied` counted neither of them: the
    // increment sits after the call, not beside it.
    expect(result.failed).toBe(2);
    expect(result.status).toBe('partially_applied');
    const after = await actionsOf(run.id);
    expect(
      after
        .filter((a) => a.actionType === 'deactivate_syntra_user')
        .map((a) => a.status),
    ).toEqual(['failed', 'failed']);
    const user = await withTenant(tenantId, (tx) =>
      tx.user.findUniqueOrThrow({ where: { id: everyday } }),
    );
    expect(user.status).toBe('active');
  });

  it('applies the rest of a run when one connector action throws', async () => {
    // Not a WriteResult: a connector that throws outright. `applyProvisionRun`
    // called it inside no try at all, so a socket error on the first action
    // discarded every later one -- including a leaver's disable.
    const throwing = intercepting('create_account', () => {
      throw new Error('socket hang up');
    });
    const run = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: throwing as never,
    });
    const result = await applyProvisionRun(tenantId, provider, run.id, {
      confirm: true,
      confirmedByUserId: await seedConfirmingUser(),
      connector: throwing as never,
      sleep: noSleep,
    });
    expect(result.failed).toBe(2);
    // Not `applied`: every action reached a terminal state, and two of them
    // failed. A run that counts only what is left over reports success for a
    // run that did nothing it was asked to.
    expect(result.status).toBe('partially_applied');
    const actions = await actionsOf(run.id);
    // Both reached a terminal state; neither was left in_flight, which is the
    // state that makes a target need adopting.
    expect(actions.map((a) => a.status)).toEqual(['failed', 'failed']);
    expect(actions[0]!.message).toMatch(/socket hang up/);
  });
});

describe('applyProvisionRun: the leaver ladder', () => {
  it('records disabledAt whenever it records the status disabled', async () => {
    // Task 9's carried obligation. `plan.ts` refuses to auto-apply a re-enable
    // it cannot show to be inside the window, and "recorded disabled with no
    // date" is exactly that case -- so an apply that writes the status without
    // the date makes every subsequent re-enable confirmable, forever, for a
    // reason nobody can see.
    await seedLeaver('Bea', 'Vos', 'bea.vos');
    await leaversOnly();
    const run = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    await applyProvisionRun(tenantId, provider, run.id, {
      confirm: true,
      confirmedByUserId: await seedConfirmingUser(),
      connector: target as never,
      sleep: noSleep,
    });
    const account = await withTenant(tenantId, (tx) =>
      tx.targetAccount.findFirstOrThrow({ where: { correlationKey: 'bea.vos' } }),
    );
    expect(account.status).toBe('disabled');
    expect(account.disabledAt).not.toBeNull();
  });

  it('clears disabledAt when it re-enables', async () => {
    const { accountId, anchor } = await seedLeaver('Bea', 'Vos', 'bea.vos', {
      endDate: day('2027-01-01'),
    });
    await withTenant(tenantId, (tx) =>
      tx.targetAccount.update({
        where: { id: accountId },
        data: { status: 'disabled', disabledAt: day('2026-06-13') },
      }),
    );
    await target.write({ domain: 'acme.test' } as never, {
      op: 'disable_account',
      actionId: 'seed-disable',
      anchor,
      reason: 'seeded',
    });
    await leaversOnly();
    const run = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    await applyProvisionRun(tenantId, provider, run.id, {
      confirm: true,
      confirmedByUserId: await seedConfirmingUser(),
      connector: target as never,
      sleep: noSleep,
    });
    const account = await withTenant(tenantId, (tx) =>
      tx.targetAccount.findUniqueOrThrow({ where: { id: accountId } }),
    );
    expect(account.status).toBe('active');
    expect(account.disabledAt).toBeNull();
  });

  it('hands the archive only the entitlements Provision manages', async () => {
    // Spec section 12 and the closest thing to destructive in the ladder. The
    // connector iterates exactly this list; handing it the object's own
    // memberOf would assert that Provision manages every group in the target.
    target.entitlements.push({
      externalId: 'guid-social',
      dn: SOCIAL_DN,
      type: 'group',
      displayName: 'Social',
    });
    await updateTarget(tenantId, provider, null, targetId, {
      ladder: { disableGraceDays: 0, archiveAfterDays: 1 },
    });
    const { accountId } = await seedLeaver('Bea', 'Vos', 'bea.vos', {
      endDate: day('2026-06-01'),
      holds: ['guid-finance', 'guid-social'],
    });
    const social = await withTenant(tenantId, async (tx) => {
      const row = await tx.entitlement.create({
        data: {
          tenantId,
          targetSystemId: targetId,
          externalId: 'guid-social',
          dn: SOCIAL_DN,
          type: 'group',
          displayName: 'Social',
        },
      });
      // Both recorded as held. Only Finance is named by a business rule, so
      // only Finance is in remit.
      await tx.accountEntitlement.createMany({
        data: [
          { tenantId, accountId, entitlementId, origin: 'rule' },
          { tenantId, accountId, entitlementId: row.id, origin: 'discovered' },
        ],
      });
      return row.id;
    });
    await leaversOnly();

    // The revocation is refused, so Finance is still held when the archive
    // runs. Without this the revoke lands first -- `ACTION_ORDER` puts it
    // before the archive -- and the strip list is empty, which makes the
    // assertion below pass for the wrong reason.
    const refusingRevoke = intercepting('revoke_entitlement', () => ({
      ok: false,
      message: 'programmed refusal',
      failure: 'rejected',
    }));
    const run = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: refusingRevoke as never,
    });
    await applyProvisionRun(tenantId, provider, run.id, {
      confirm: true,
      confirmedByUserId: await seedConfirmingUser(),
      connector: refusingRevoke as never,
      sleep: noSleep,
    });

    const archive = target.calls.find((c) => c.op === 'archive_account') as
      | Extract<WriteOperation, { op: 'archive_account' }>
      | undefined;
    expect(archive).toBeDefined();
    // Finance is named by a business rule and is in remit; Social is held at
    // the target, recorded by Syntra, and named by nothing.
    expect(archive!.entitlementDns).toEqual([FINANCE_DN]);

    // And what Syntra RECORDS has to agree with what it stripped. Marking every
    // held row revoked says an entitlement was removed that is still at the
    // target, which takes it out of drift reporting as well -- "I did not
    // look", which Ruling P2 forbids.
    const holdings = await withTenant(tenantId, (tx) =>
      tx.accountEntitlement.findMany({ where: { accountId } }),
    );
    expect(holdings.find((h) => h.entitlementId === social)!.state).toBe('held');
    expect(holdings.find((h) => h.entitlementId === entitlementId)!.state).toBe(
      'revoked',
    );
  });

  it('does not record an archive that the target refused', async () => {
    await updateTarget(tenantId, provider, null, targetId, {
      ladder: { disableGraceDays: 0, archiveAfterDays: 1 },
    });
    const { accountId } = await seedLeaver('Bea', 'Vos', 'bea.vos', {
      endDate: day('2026-06-01'),
      holds: ['guid-finance'],
    });
    await withTenant(tenantId, (tx) =>
      tx.accountEntitlement.create({
        data: { tenantId, accountId, entitlementId, origin: 'rule' },
      }),
    );
    await leaversOnly();
    const refusing = intercepting('archive_account', () => ({
      ok: false,
      message: 'the account was disabled, but its membership could not be removed',
      failure: 'rejected',
    }));
    const run = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: refusing as never,
    });
    await applyProvisionRun(tenantId, provider, run.id, {
      confirm: true,
      confirmedByUserId: await seedConfirmingUser(),
      connector: refusing as never,
      sleep: noSleep,
    });
    const account = await withTenant(tenantId, (tx) =>
      tx.targetAccount.findUniqueOrThrow({ where: { id: accountId } }),
    );
    // Not archived, so the next run recognises the state and repeats it.
    expect(account.status).not.toBe('archived');
    const action = (await actionsOf(run.id)).find(
      (a) => a.actionType === 'archive_account',
    )!;
    expect(action.status).toBe('failed');
  });

  it('revokes a holding through the inventory when the revoke lands', async () => {
    const { accountId } = await seedLeaver('Bea', 'Vos', 'bea.vos', {
      endDate: day('2026-06-01'),
      holds: ['guid-finance'],
    });
    await withTenant(tenantId, (tx) =>
      tx.accountEntitlement.create({
        data: { tenantId, accountId, entitlementId, origin: 'rule' },
      }),
    );
    await leaversOnly();
    const run = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    await applyProvisionRun(tenantId, provider, run.id, {
      confirm: true,
      confirmedByUserId: await seedConfirmingUser(),
      connector: target as never,
      sleep: noSleep,
    });
    const holding = await withTenant(tenantId, (tx) =>
      tx.accountEntitlement.findFirstOrThrow({ where: { accountId } }),
    );
    expect(holding.state).toBe('revoked');
    expect(holding.revokedAt).not.toBeNull();
  });
});

describe('applyProvisionRun: the confirmation gate on one action', () => {
  /**
   * An unblocked run, so `confirm` can be left off and the per-action gate is
   * the only thing in the way.
   *
   * Every first run is blocked -- no denominator can say anything about one --
   * so `lastAppliedRunAt` is set to take the guard off that branch. The only
   * action is an `enable_account`, which is in the additive, idempotent,
   * deliberately unguarded class and trips no threshold.
   */
  const unblockedReenable = async () => {
    const { accountId, anchor } = await seedLeaver('Bea', 'Vos', 'bea.vos', {
      endDate: day('2027-01-01'),
      // Already holding Finance, and Syntra already records the grant, so the
      // plan proposes no `grant_entitlement` and the re-enable is the ONLY
      // action in the run. Otherwise the unconfirmable grant applies and
      // `applied` is 1 whether the confirmation gate works or not.
      holds: ['guid-finance'],
    });
    await withTenant(tenantId, async (tx) => {
      await tx.accountEntitlement.create({
        data: { tenantId, accountId, entitlementId, origin: 'rule' },
      });
      await tx.targetAccount.update({
        where: { id: accountId },
        // Disabled far outside `reenableWithoutConfirmationDays`, which is
        // what makes the re-enable confirmable: months of accumulated
        // entitlements come back with the login.
        data: { status: 'disabled', disabledAt: day('2026-01-01') },
      });
      await tx.targetSystem.update({
        where: { id: targetId },
        data: { lastAppliedRunAt: day('2026-06-01') },
      });
    });
    await target.write({ domain: 'acme.test' } as never, {
      op: 'disable_account',
      actionId: 'seed-disable',
      anchor,
      reason: 'seeded',
    });
    await leaversOnly();
    return { accountId, anchor };
  };

  it('never auto-applies an action that requires confirmation', async () => {
    const { accountId, anchor } = await unblockedReenable();
    const run = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    expect(run.status).toBe('previewed');
    const enable = (await actionsOf(run.id)).find(
      (a) => a.actionType === 'enable_account',
    )!;
    expect(enable.requiresConfirmation).toBe(true);

    // No `confirm`, which is what the scheduler passes: it never confirms
    // anything.
    const result = await applyProvisionRun(tenantId, provider, run.id, {
      connector: target as never,
      sleep: noSleep,
    });
    expect(result.applied).toBe(0);
    expect(result.skipped).toBe(1);
    expect((await actionsOf(run.id)).find((a) => a.id === enable.id)!.status).toBe(
      'proposed',
    );
    expect(target.objects.get(anchor)!.enabled).toBe(false);
    const account = await withTenant(tenantId, (tx) =>
      tx.targetAccount.findUniqueOrThrow({ where: { id: accountId } }),
    );
    expect(account.status).toBe('disabled');
  });

  it('applies the same action once it is confirmed', async () => {
    const { accountId, anchor } = await unblockedReenable();
    const run = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    const result = await applyProvisionRun(tenantId, provider, run.id, {
      confirm: true,
      confirmedByUserId: await seedConfirmingUser(),
      connector: target as never,
      sleep: noSleep,
    });
    expect(result.applied).toBe(1);
    expect(target.objects.get(anchor)!.enabled).toBe(true);
    const account = await withTenant(tenantId, (tx) =>
      tx.targetAccount.findUniqueOrThrow({ where: { id: accountId } }),
    );
    expect(account.status).toBe('active');
    expect(account.disabledAt).toBeNull();
  });
});

describe('applyProvisionRun: what it reads for an action', () => {
  it('never falls back to another person\'s account', async () => {
    // `personId: action.personId ?? undefined` is dropped by Prisma when it is
    // undefined, so `findFirst` returns the FIRST account at the target --
    // somebody else's. The empty case is the universal case, for the fifth
    // time on this slice.
    await seedLeaver('Bea', 'Vos', 'bea.vos', { endDate: day('2027-01-01') });
    const run = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    const create = (await actionsOf(run.id)).find(
      (a) => a.actionType === 'create_account',
    )!;
    await withTenant(tenantId, (tx) =>
      tx.provisionAction.update({
        where: { id: create.id },
        data: { accountId: null, personId: null },
      }),
    );
    const result = await applyProvisionRun(tenantId, provider, run.id, {
      only: [create.id],
      confirm: true,
      confirmedByUserId: await seedConfirmingUser(),
      connector: target as never,
      sleep: noSleep,
    });
    expect(result.applied).toBe(0);
    const bea = await withTenant(tenantId, (tx) =>
      tx.targetAccount.findFirstOrThrow({ where: { correlationKey: 'bea.vos' } }),
    );
    // Bea's account was not written over by an action that named nobody.
    expect(bea.correlationKey).toBe('bea.vos');
    expect(bea.createdActionId).toBeNull();
  });

  it('refuses an action it cannot express as a write operation', async () => {
    const run = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    const create = (await actionsOf(run.id)).find(
      (a) => a.actionType === 'create_account',
    )!;
    await withTenant(tenantId, (tx) =>
      tx.provisionAction.update({
        where: { id: create.id },
        data: { after: { correlationKey: 'anna.novak', container: '' } },
      }),
    );
    const result = await applyProvisionRun(tenantId, provider, run.id, {
      only: [create.id],
      confirm: true,
      confirmedByUserId: await seedConfirmingUser(),
      connector: target as never,
      sleep: noSleep,
    });
    expect(result.failed).toBe(1);
    expect(target.calls).toHaveLength(0);
  });

  it('does not move an object when the container has not changed', async () => {
    // `update_account` carries a distinguishedName only for a MOVE. Rebuilding
    // the RDN from the correlation key on every update renames any object
    // whose RDN is not `CN=<sAMAccountName>` -- and a rename is supposed to be
    // opt-in and always confirmed.
    const { accountId, anchor } = await seedLeaver('Bea', 'Vos', 'bea.vos', {
      endDate: day('2027-01-01'),
    });
    await withTenant(tenantId, (tx) =>
      tx.targetAccount.update({
        where: { id: accountId },
        data: { lastAppliedAttributes: { displayName: ['Stale Name'] } },
      }),
    );
    await leaversOnly();
    const run = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    await applyProvisionRun(tenantId, provider, run.id, {
      confirm: true,
      confirmedByUserId: await seedConfirmingUser(),
      connector: target as never,
      sleep: noSleep,
    });
    const update = target.calls.find((c) => c.op === 'update_account') as
      | Extract<WriteOperation, { op: 'update_account' }>
      | undefined;
    expect(update).toBeDefined();
    expect(update!.attributes.distinguishedName).toBeUndefined();
    expect(target.objects.get(anchor)!.dn).toBe(`CN=bea.vos,${USERS}`);
  });

  it('does not record a second holding when a grant is applied twice', async () => {
    // There is no unique index over (accountId, entitlementId), so a grant
    // applied against a holding Syntra already records held writes a duplicate
    // row nothing ever reconciles -- and the guard's per-entitlement axis and
    // the drift report both count rows.
    const { runId } = await previewAndApply();
    const grant = (await actionsOf(runId)).find(
      (a) => a.actionType === 'grant_entitlement',
    )!;
    await withTenant(tenantId, async (tx) => {
      await tx.provisionAction.update({
        where: { id: grant.id },
        data: { status: 'proposed' },
      });
      await tx.provisionRun.update({
        where: { id: runId },
        data: { status: 'previewed' },
      });
    });
    const result = await applyProvisionRun(tenantId, provider, runId, {
      only: [grant.id],
      confirm: true,
      confirmedByUserId: await withTenant(tenantId, async (tx) =>
        (await tx.user.findFirstOrThrow({ where: { login: 'reviewer' } })).id,
      ),
      connector: target as never,
      sleep: noSleep,
    });
    expect(result.applied).toBe(1);
    const holdings = await withTenant(tenantId, (tx) => tx.accountEntitlement.findMany({}));
    expect(holdings).toHaveLength(1);
  });

  it('retries a create the target reported successful without an anchor', async () => {
    // An account whose anchor Syntra never learned is one it cannot address
    // again: the next run cannot match the object to the row, proposes a
    // create, and the connector answers `conflict` -- permanently. A success
    // with no anchor is not a success.
    let calls = 0;
    const anchorless = intercepting('create_account', () => {
      calls += 1;
      return calls === 1 ? { ok: true, message: 'created' } : undefined;
    });
    const run = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: anchorless as never,
    });
    await applyProvisionRun(tenantId, provider, run.id, {
      confirm: true,
      confirmedByUserId: await seedConfirmingUser(),
      connector: anchorless as never,
      sleep: noSleep,
    });
    const account = await withTenant(tenantId, (tx) =>
      tx.targetAccount.findFirstOrThrow({}),
    );
    expect(account.anchor).toMatch(/^fake-anchor-/);
    expect(account.status).toBe('active');
  });
});

describe('resolveInFlightActions', () => {
  /** The write that landed, whose answer the caller never received. */
  const landWrite = (actionId: string, correlationKey = 'anna.novak') =>
    target.write({ domain: 'acme.test' } as never, {
      op: 'create_account',
      actionId,
      correlationKey,
      attributes: { distinguishedName: [`CN=${correlationKey},${USERS}`] },
      enabled: true,
      initialPassword: 'Aa1!lost-response',
    });

  it('adopts a create whose response was lost rather than duplicating it', async () => {
    const run = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    const createId = (await actionsOf(run.id)).find(
      (a) => a.actionType === 'create_account',
    )!.id;
    // Simulate a process death between the write and step 3. The write LANDED:
    // the brief's version of this test programmed `loseResponseTimes` and then
    // never called `write` at all, so no object was ever created and the
    // assertions below could not hold.
    await landWrite(createId);
    await withTenant(tenantId, (tx) =>
      tx.provisionAction.update({
        where: { id: createId },
        data: { status: 'in_flight' },
      }),
    );

    const resolved = await resolveInFlightActions(tenantId, provider, targetId, {
      connector: target as never,
    });
    expect(resolved).toBe(1);
    const action = (await actionsOf(run.id)).find((a) => a.id === createId)!;
    // An action found in_flight is in an UNKNOWN state, not a failed one.
    expect(action.status).toBe('applied');
    expect(target.objects.size).toBe(1);
    const account = await withTenant(tenantId, (tx) =>
      tx.targetAccount.findFirstOrThrow({}),
    );
    expect(account.anchor).not.toBeNull();
  });

  it('says plainly that the adopted account\'s initial password was lost', async () => {
    // The password was generated in the process that died and sealed nowhere,
    // because sealing happens in step 3. The account exists, is enabled, and
    // nobody can sign in to it. Recorded rather than silent: an account
    // Provision created and cannot hand over is a support call, not a mystery.
    const run = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    const createId = (await actionsOf(run.id)).find(
      (a) => a.actionType === 'create_account',
    )!.id;
    await landWrite(createId);
    await withTenant(tenantId, (tx) =>
      tx.provisionAction.update({
        where: { id: createId },
        data: { status: 'in_flight' },
      }),
    );
    await resolveInFlightActions(tenantId, provider, targetId, {
      connector: target as never,
    });
    const account = await withTenant(tenantId, (tx) =>
      tx.targetAccount.findFirstOrThrow({}),
    );
    expect(account.statusReason).toMatch(/password/i);
    const events = await eventsOf('provision.action.resolve_in_flight');
    expect(events).toHaveLength(1);
    expect((events[0]!.payload as { credentialSealed?: boolean }).credentialSealed).toBe(
      false,
    );
    const secret = await withTenant(tenantId, (tx) =>
      getSecret(tx, provider, `target/${targetId}/initial/${account.id}`),
    );
    expect(secret).toBeNull();
  });

  it('adopts a landed create whose correlation key the target folded', async () => {
    // Active Directory folds sAMAccountName case and PostgreSQL does not --
    // five case defects on this programme already. An exact comparison here
    // reads a landed write as "did not land", sets the action back to
    // `proposed`, and the next run creates a second object: a `conflict` the
    // administrator has to unpick by hand.
    const run = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    const createId = (await actionsOf(run.id)).find(
      (a) => a.actionType === 'create_account',
    )!.id;
    await landWrite(createId, 'Anna.Novak');
    await withTenant(tenantId, (tx) =>
      tx.provisionAction.update({
        where: { id: createId },
        data: { status: 'in_flight' },
      }),
    );
    await resolveInFlightActions(tenantId, provider, targetId, {
      connector: target as never,
    });
    expect((await actionsOf(run.id)).find((a) => a.id === createId)!.status).toBe(
      'applied',
    );
  });

  it('never adopts an object that does not carry this action\'s marker', async () => {
    // Provenance, not the name. Anybody able to create an object in the target
    // could otherwise choose a name that causes Syntra to hand them an
    // existing person's account.
    target.seedForeignObject('anna.novak');
    const run = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    const createId = (await actionsOf(run.id)).find(
      (a) => a.actionType === 'create_account',
    )!.id;
    await withTenant(tenantId, (tx) =>
      tx.provisionAction.update({
        where: { id: createId },
        data: { status: 'in_flight' },
      }),
    );
    await resolveInFlightActions(tenantId, provider, targetId, {
      connector: target as never,
    });
    const action = (await actionsOf(run.id)).find((a) => a.id === createId)!;
    expect(action.status).toBe('proposed');
    const account = await withTenant(tenantId, (tx) =>
      tx.targetAccount.findFirstOrThrow({}),
    );
    expect(account.anchor).toBeNull();
  });

  it('reads the target once however many actions are in flight', async () => {
    let reads = 0;
    const counting = {
      ...intercepting('create_account', () => undefined),
      read: (c: never) => {
        reads += 1;
        return target.read(c);
      },
    };
    const run = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    await withTenant(tenantId, (tx) =>
      tx.provisionAction.updateMany({
        where: { runId: run.id },
        data: { status: 'in_flight' },
      }),
    );
    const resolved = await resolveInFlightActions(tenantId, provider, targetId, {
      connector: counting as never,
    });
    expect(resolved).toBe(2);
    expect(reads).toBe(1);
  });

  it('reads nothing at all when nothing is in flight', async () => {
    let reads = 0;
    const counting = {
      ...intercepting('create_account', () => undefined),
      read: (c: never) => {
        reads += 1;
        return target.read(c);
      },
    };
    await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    expect(
      await resolveInFlightActions(tenantId, provider, targetId, {
        connector: counting as never,
      }),
    ).toBe(0);
    expect(reads).toBe(0);
  });

  it('starts a new run after a process died mid-apply, and resolves what it left in flight', async () => {
    // Spec section 20's crash-recovery case, end to end and through the
    // production path: kill the process mid-apply, restart. Both halves matter
    // and each was broken on its own. The run left in `applying` violates the
    // partial unique index, so without adoption the create throws and the
    // target is permanently unrunnable; and with the in-flight resolution
    // inserted AFTER the create, it could never run at all, because the create
    // is what throws.
    const first = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    const createId = (await actionsOf(first.id)).find(
      (a) => a.actionType === 'create_account',
    )!.id;
    await withTenant(tenantId, async (tx) => {
      await tx.provisionRun.update({
        where: { id: first.id },
        data: { status: 'applying' },
      });
      await tx.provisionAction.update({
        where: { id: createId },
        data: { status: 'in_flight' },
      });
    });
    // The write landed at the target and the response was lost.
    await landWrite(createId);

    const second = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
      resolveInFlight: (id) =>
        resolveInFlightActions(tenantId, provider, id, { connector: target as never }),
    });

    expect(second.id).not.toBe(first.id);
    const resolved = (await actionsOf(first.id)).find((a) => a.id === createId)!;
    // Unknown, not failed: it is asked about, and the answer is that it landed.
    expect(resolved.status).toBe('applied');
    const adopted = await withTenant(tenantId, (tx) =>
      tx.provisionRun.findUniqueOrThrow({ where: { id: first.id } }),
    );
    expect(adopted.status).toBe('partially_applied');
    // One object at the target, not two.
    expect(target.objects.size).toBe(1);
  });

  it('resolves in flight through the production path with no option passed', async () => {
    // `previewProvisionRun`'s `resolveInFlight` default was a no-op while
    // Task 14 did not exist. The unit tests above call `resolveInFlightActions`
    // directly and pass whether or not the seam is wired, so this is the only
    // test that can fail if the default is still the no-op.
    const first = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    const createId = (await actionsOf(first.id)).find(
      (a) => a.actionType === 'create_account',
    )!.id;
    await withTenant(tenantId, async (tx) => {
      await tx.provisionRun.update({
        where: { id: first.id },
        data: { status: 'applying' },
      });
      await tx.provisionAction.update({
        where: { id: createId },
        data: { status: 'in_flight' },
      });
    });
    await landWrite(createId);

    await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    expect((await actionsOf(first.id)).find((a) => a.id === createId)!.status).toBe(
      'applied',
    );
  });

  it('marks an in-flight create that never landed as proposed again', async () => {
    const run = await previewProvisionRun(tenantId, provider, targetId, {
      now: NOW,
      connector: target as never,
    });
    const createId = (await actionsOf(run.id)).find(
      (a) => a.actionType === 'create_account',
    )!.id;
    await withTenant(tenantId, (tx) =>
      tx.provisionAction.update({
        where: { id: createId },
        data: { status: 'in_flight' },
      }),
    );
    await resolveInFlightActions(tenantId, provider, targetId, {
      connector: target as never,
    });
    const action = (await actionsOf(run.id)).find((a) => a.id === createId)!;
    expect(action.status).toBe('proposed');
  });
});
