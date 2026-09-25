import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import {
  entraTargetConnector,
  forgetEntraTokens,
  type TargetConnector,
  type TargetReadBack,
} from '@syntra/connectors';
import { startFakeGraphServer, type FakeGraphServer } from '@syntra/connectors/testing';
import type { Scheduler } from '../jobs/scheduler.js';
import { localMasterKeyProvider } from '../vault/master-key.js';
import { createTarget, upsertAccountProfile, upsertBusinessRule } from './target-service.js';
import { previewProvisionRun } from './run-service.js';
import { applyProvisionRun } from './apply.js';
import { runPersonProvision } from './person-receipts.js';

/**
 * A person whose account already exists at the target — created or adopted
 * by a DIFFERENT run — through the receipt path, end to end: real Entra
 * connector, fake Graph service on loopback.
 *
 * Found live: the receipt's preview planned nothing for the person, so the
 * receipt finished `verification_pending` without reading the target, and
 * the empty preview it started was left `previewed`, refusing every later
 * receipt on the target as "awaiting review".
 */
const provider = localMasterKeyProvider(Buffer.alloc(32, 7));
const TENANT_GUID = '11111111-2222-3333-4444-555555555555';
const CLIENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SECRET = 'client-secret-value';
const noSleep = async () => undefined;

let tenantId: string;
let graph: FakeGraphServer;

const scheduler = () => ({ enqueue: vi.fn(async () => 'job-1') }) as unknown as Scheduler;

/** The same seam `flat-target.test.ts` uses: stored https URLs, calls pointed at the fake. */
const entra = (readBack?: () => Promise<TargetReadBack>): TargetConnector<never> =>
  new Proxy(entraTargetConnector, {
    get(target, property, receiver) {
      if (property === 'readBack' && readBack) return readBack;
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== 'function') return value;
      return (config: Record<string, unknown>, ...rest: unknown[]) =>
        (value as (...a: unknown[]) => unknown).call(
          target,
          { ...config, graphBaseUrl: graph.baseUrl, tokenUrl: graph.tokenUrl },
          ...rest,
        );
    },
  }) as unknown as TargetConnector<never>;

async function seedPerson(givenName: string, familyName: string) {
  return withTenant(tenantId, async (tx) => {
    const person = await tx.person.create({ data: { tenantId, givenName, familyName } });
    await tx.contract.create({
      data: {
        tenantId,
        personId: person.id,
        sequence: 1,
        isPrimary: true,
        startDate: new Date('2020-01-01T00:00:00Z'),
        department: 'Finance',
      },
    });
    return person.id;
  });
}

async function entraTarget() {
  const { id } = await createTarget(tenantId, provider, null, {
    type: 'entraId',
    name: 'Contoso Entra',
    config: {
      tenantId: TENANT_GUID,
      clientId: CLIENT,
      graphBaseUrl: 'https://graph.fake.test/v1.0',
      tokenUrl: `https://login.fake.test/${TENANT_GUID}/oauth2/v2.0/token`,
      allowPrivateAddresses: true,
      userPrincipalDomain: 'contoso.com',
    },
    bindPassword: SECRET,
  });
  await upsertAccountProfile(tenantId, null, id, {
    correlationKeyTemplate: '%person.givenName.first%.%person.familyName%',
    maxUniquenessAttempts: 20,
    containerTemplate: '/',
    fallbackContainer: '/',
    attributeTemplates: {
      displayName: '%person.givenName% %person.familyName%',
      givenName: '%person.givenName%',
      familyName: '%person.familyName%',
    },
    initialPasswordPolicy: { length: 24 },
    initialPasswordDelivery: 'vaultOnly',
  });
  await upsertBusinessRule(tenantId, null, id, {
    name: 'Finance staff',
    condition: { field: 'contract.department', op: 'equals', value: 'Finance' },
    grantsAccount: true,
    enabled: true,
    entitlementIds: [],
  });
  return id;
}

/** The account comes from a scheduled/manual run, not from any receipt. */
async function createAccountsThroughARun(targetId: string) {
  const run = await previewProvisionRun(tenantId, provider, targetId, { connector: entra() });
  const confirmedByUserId = await withTenant(tenantId, async (tx) =>
    (await tx.user.create({ data: { tenantId, login: 'reviewer', email: 'r@acme.test', displayName: 'Reviewer' } })).id,
  );
  const result = await applyProvisionRun(tenantId, provider, run.id, {
    confirm: true,
    confirmedByUserId,
    connector: entra(),
    sleep: noSleep,
  });
  expect(result.status).toBe('applied');
}

/** An onboarding operation whose target step the receipt reports into. */
async function onboardingReceipt(personId: string, targetId: string, key: string) {
  return withTenant(tenantId, async (tx) => {
    const operation = await tx.lifecycleOperation.create({
      data: {
        tenantId, personId, kind: 'onboard', idempotencyKey: key, status: 'running', inputFingerprint: key, input: {},
        steps: { create: { tenantId, key: 'targets', title: 'Targets', position: 0, status: 'running' } },
      },
    });
    const receipt = await tx.personProvisionReceipt.create({
      data: { tenantId, personId, targetSystemId: targetId, targetName: 'Contoso Entra', requestKey: operation.id },
    });
    return { operationId: operation.id, receiptId: receipt.id };
  });
}

const stateOf = (receiptId: string, operationId: string) =>
  withTenant(tenantId, async (tx) => {
    const receipt = await tx.personProvisionReceipt.findUniqueOrThrow({ where: { id: receiptId } });
    const operation = await tx.lifecycleOperation.findUniqueOrThrow({
      where: { id: operationId },
      include: { steps: true },
    });
    const run = receipt.runId ? await tx.provisionRun.findUniqueOrThrow({ where: { id: receipt.runId } }) : null;
    return { receipt, operation, step: operation.steps[0]!, run };
  });

beforeEach(async () => {
  await resetDatabase();
  tenantId = (await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } })).id;
  forgetEntraTokens();
  graph = await startFakeGraphServer({
    tenantId: TENANT_GUID,
    clientId: CLIENT,
    clientSecret: SECRET,
    users: [],
    groups: [],
  });
});

afterEach(async () => {
  await graph.close();
});

describe('a receipt whose person already has an account at the target', () => {
  it('confirms the existing account by read-back, completes the operation and closes its empty run', async () => {
    const targetId = await entraTarget();
    const anna = await seedPerson('Anna', 'Novak');
    await createAccountsThroughARun(targetId);

    const first = await onboardingReceipt(anna, targetId, 'first');
    await runPersonProvision(scheduler(), provider, { tenantId, receiptId: first.receiptId }, { connector: entra() });

    const after = await stateOf(first.receiptId, first.operationId);
    expect(after.receipt.status).toBe('applied');
    expect(after.receipt.message).toMatch(/confirmed by read-back/);
    expect(after.step.status).toBe('succeeded');
    expect(after.operation.status).toBe('completed');
    // The empty preview is closed like an applied empty run, not left
    // `previewed` to block the target.
    expect(after.run?.status).toBe('applied');
    const closeEvent = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findFirst({ where: { action: 'provision.run.apply', targetId: after.run!.id } }),
    );
    expect(closeEvent?.payload).toMatchObject({ emptyPlan: true, applied: 0 });

    // ...so a second request on the same target is not refused as
    // "Another run is in progress or awaiting review".
    const second = await onboardingReceipt(anna, targetId, 'second');
    await runPersonProvision(scheduler(), provider, { tenantId, receiptId: second.receiptId }, { connector: entra() });
    const again = await stateOf(second.receiptId, second.operationId);
    expect(again.receipt.message ?? '').not.toMatch(/Another run/);
    expect(again.receipt.status).toBe('applied');
    expect(again.operation.status).toBe('completed');
  });

  it('stays verification_pending when the read-back does not match, and still frees the target', async () => {
    const targetId = await entraTarget();
    const anna = await seedPerson('Anna', 'Novak');
    await createAccountsThroughARun(targetId);

    const disabledAtTarget = async (): Promise<TargetReadBack> => ({
      account: { anchor: 'x', objectType: 'user', dn: 'x', attributes: {} },
      entitlementIds: [],
      enabled: false,
      complete: true,
    });
    const { receiptId, operationId } = await onboardingReceipt(anna, targetId, 'mismatch');
    await runPersonProvision(scheduler(), provider, { tenantId, receiptId }, { connector: entra(disabledAtTarget) });

    const after = await stateOf(receiptId, operationId);
    expect(after.receipt.status).toBe('verification_pending');
    expect(after.receipt.message).toMatch(/needed no changes.*did not match.*Manual verification is required/);
    expect(after.step.status).toBe('running');
    expect(after.step.responseCategory).toBe('read_back_incomplete');
    expect(after.operation.status).not.toBe('completed');
    expect(after.run?.status).toBe('applied');
  });

  it('stays verification_pending when the read-back is incomplete', async () => {
    const targetId = await entraTarget();
    const anna = await seedPerson('Anna', 'Novak');
    await createAccountsThroughARun(targetId);

    const incomplete = async (): Promise<TargetReadBack> => ({
      account: { anchor: 'x', objectType: 'user', dn: 'x', attributes: {} },
      entitlementIds: [],
      enabled: true,
      complete: false,
    });
    const { receiptId, operationId } = await onboardingReceipt(anna, targetId, 'incomplete');
    await runPersonProvision(scheduler(), provider, { tenantId, receiptId }, { connector: entra(incomplete) });
    const after = await stateOf(receiptId, operationId);
    expect(after.receipt.status).toBe('verification_pending');
    expect(after.receipt.message).toMatch(/incomplete/);
  });

  it('leaves a receipt preview that holds work for somebody else previewed, for a person to review', async () => {
    const targetId = await entraTarget();
    const anna = await seedPerson('Anna', 'Novak');
    await createAccountsThroughARun(targetId);
    // Ben arrives after the run: the receipt's preview plans his account.
    // The create threshold is opened so the plan is `previewed` rather than
    // held by the guard (1 of 1 accounts is 100%).
    await seedPerson('Ben', 'Okafor');
    await withTenant(tenantId, (tx) =>
      tx.targetSystem.update({ where: { id: targetId }, data: { createAccountThresholdPercent: 100 } }),
    );

    const { receiptId, operationId } = await onboardingReceipt(anna, targetId, 'others');
    await runPersonProvision(scheduler(), provider, { tenantId, receiptId }, { connector: entra() });
    const after = await stateOf(receiptId, operationId);
    // Anna herself is confirmed...
    expect(after.receipt.status).toBe('applied');
    // ...but the plan that creates Ben's account is not this receipt's to
    // apply or to discard.
    expect(after.run?.status).toBe('previewed');
    const actions = await withTenant(tenantId, (tx) => tx.provisionAction.findMany({ where: { runId: after.run!.id } }));
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every((action) => action.personId !== anna)).toBe(true);
  });
});

/**
 * Another run on the target, and what it means for a receipt.
 *
 * Found live: a `previewed` plan holding somebody ELSE's work refused every
 * onboarding and offboarding retry on the target as "Another run is in
 * progress or awaiting review" until a person applied it.
 */
describe('a receipt and another run on the same target', () => {
  it("supersedes a leftover preview holding somebody else's work, and audits it", async () => {
    const targetId = await entraTarget();
    const anna = await seedPerson('Anna', 'Novak');
    await createAccountsThroughARun(targetId);
    await seedPerson('Ben', 'Okafor');
    await withTenant(tenantId, (tx) =>
      tx.targetSystem.update({ where: { id: targetId }, data: { createAccountThresholdPercent: 100 } }),
    );
    // The leftover: a receipt preview that planned Ben's account and was left
    // `previewed` for a person to apply.
    const first = await onboardingReceipt(anna, targetId, 'first');
    await runPersonProvision(scheduler(), provider, { tenantId, receiptId: first.receiptId }, { connector: entra() });
    const leftover = (await stateOf(first.receiptId, first.operationId)).run!;
    expect(leftover.status).toBe('previewed');

    const retry = await onboardingReceipt(anna, targetId, 'retry');
    await runPersonProvision(scheduler(), provider, { tenantId, receiptId: retry.receiptId }, { connector: entra() });

    const after = await stateOf(retry.receiptId, retry.operationId);
    expect(after.receipt.message ?? '').not.toMatch(/Another run/);
    expect(after.receipt.status).toBe('applied');
    const old = await withTenant(tenantId, (tx) => tx.provisionRun.findUniqueOrThrow({ where: { id: leftover.id } }));
    expect(old).toMatchObject({ status: 'failed', error: 'superseded by a later run' });
    // Nothing was written on its behalf: its actions were superseded, not applied.
    const oldActions = await withTenant(tenantId, (tx) => tx.provisionAction.findMany({ where: { runId: leftover.id } }));
    expect(oldActions.length).toBeGreaterThan(0);
    expect(oldActions.every((action) => action.status === 'superseded')).toBe(true);
    const event = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findFirst({ where: { action: 'provision.run.superseded', targetId: leftover.id } }),
    );
    expect(event?.payload).toMatchObject({ previousStatus: 'previewed', receiptId: retry.receiptId });
    // Ben's work is carried by the new plan, still for a person to apply.
    expect(after.run?.status).toBe('previewed');
    expect(graph.users.size).toBe(1);
  });

  it('does not step over a run held for confirmation, and applies nothing', async () => {
    const targetId = await entraTarget();
    const anna = await seedPerson('Anna', 'Novak');
    await createAccountsThroughARun(targetId);
    // Ben's account is 1 of 1: over the default create threshold, so the
    // run is held for a person to confirm.
    await seedPerson('Ben', 'Okafor');
    const held = await previewProvisionRun(tenantId, provider, targetId, { connector: entra() });
    expect(held.status).toBe('blocked');
    const heldRow = await withTenant(tenantId, (tx) => tx.provisionRun.findUniqueOrThrow({ where: { id: held.id } }));
    expect(heldRow.requiresConfirmation).toBe(true);
    const runsBefore = await withTenant(tenantId, (tx) => tx.provisionRun.count());

    const { receiptId, operationId } = await onboardingReceipt(anna, targetId, 'held');
    await runPersonProvision(scheduler(), provider, { tenantId, receiptId }, { connector: entra() });
    // Retrying changes nothing either.
    await withTenant(tenantId, (tx) =>
      tx.personProvisionReceipt.update({ where: { id: receiptId }, data: { status: 'pending' } }),
    );
    await runPersonProvision(scheduler(), provider, { tenantId, receiptId }, { connector: entra() });

    const after = await stateOf(receiptId, operationId);
    expect(after.receipt.status).toBe('blocked');
    expect(after.receipt.message).toMatch(/held for confirmation/);
    const stillHeld = await withTenant(tenantId, (tx) => tx.provisionRun.findUniqueOrThrow({ where: { id: held.id } }));
    expect(stillHeld.status).toBe('blocked');
    expect(await withTenant(tenantId, (tx) => tx.provisionRun.count())).toBe(runsBefore);
    const heldActions = await withTenant(tenantId, (tx) => tx.provisionAction.findMany({ where: { runId: held.id } }));
    expect(heldActions.length).toBeGreaterThan(0);
    expect(heldActions.every((action) => action.status === 'proposed')).toBe(true);
    // Ben's account was not created at the target.
    expect(graph.users.size).toBe(1);
  });

  it('waits, and is requeued, while another run is applying', async () => {
    const targetId = await entraTarget();
    const anna = await seedPerson('Anna', 'Novak');
    await createAccountsThroughARun(targetId);
    const applying = await withTenant(tenantId, (tx) =>
      tx.provisionRun.create({
        data: { tenantId, targetSystemId: targetId, status: 'applying', lastProgressAt: new Date() },
      }),
    );

    const jobs = scheduler();
    const { receiptId, operationId } = await onboardingReceipt(anna, targetId, 'busy');
    await runPersonProvision(jobs, provider, { tenantId, receiptId }, { connector: entra() });

    const after = await stateOf(receiptId, operationId);
    expect(after.receipt.status).toBe('deferred');
    expect(after.receipt.message).toMatch(/Waiting: another run on this target is applying/);
    expect(jobs.enqueue).toHaveBeenCalledWith('provision.person', { tenantId, receiptId }, { startAfterSeconds: 30 });
    const untouched = await withTenant(tenantId, (tx) => tx.provisionRun.findUniqueOrThrow({ where: { id: applying.id } }));
    expect(untouched.status).toBe('applying');
  });
});
