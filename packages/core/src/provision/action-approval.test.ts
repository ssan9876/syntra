import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { FakeTarget } from '@syntra/connectors/testing';
import { localMasterKeyProvider } from '../vault/master-key.js';
import {
  createTarget,
  updateTarget,
  upsertAccountProfile,
  upsertBusinessRule,
} from './target-service.js';
import { runProvisionJob } from './jobs.js';
import { previewProvisionRun } from './run-service.js';
import { applyProvisionRun } from './apply.js';
import {
  ACTION_APPROVAL_TTL_MS,
  HeldActionNotApprovableError,
  actionFingerprint,
  approveHeldAction,
  describeHeldActions,
  heldActionCounts,
  heldActionsAttention,
  revokeHeldActionApproval,
} from './action-approval.js';

/**
 * Held actions, approved after the fact, and renames a target confirms by its
 * own setting.
 *
 * Every run here goes through `runProvisionJob` on an `autoApply` target --
 * the path that confirms nothing, and the one the live defect was on: an
 * Entra run applied an attribute update and left the rename it implied
 * `proposed` on a run that ended `partially_applied`, which no console button
 * could reach.
 */

const provider = localMasterKeyProvider(Buffer.alloc(32, 7));
const USERS = 'OU=Users,DC=acme,DC=test';
const FINANCE_DN = 'CN=Finance,OU=Groups,DC=acme,DC=test';
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

const schedulerStub = () => ({
  schedule: vi.fn(async () => undefined),
  unschedule: vi.fn(async () => undefined),
  enqueue: vi.fn(async () => 'job-1'),
  register: vi.fn(),
  start: vi.fn(async () => undefined),
  stop: vi.fn(async () => undefined),
});

let tenantId: string;
let targetId: string;
let entitlementId: string;
let target: FakeTarget;
let reviewerId: string;

beforeEach(async () => {
  await resetDatabase();
  const tenant = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = tenant.id;
  targetId = (
    await createTarget(tenantId, provider, null, {
      type: 'activeDirectory',
      name: 'Acme AD',
      config: {
        url: 'ldaps://dc.acme.test:636',
        tlsMode: 'ldaps',
        rejectUnauthorized: false,
        bindDn: 'CN=svc,DC=acme,DC=test',
        baseDn: USERS,
        entitlementSearchBase: 'OU=Groups,DC=acme,DC=test',
        archiveContainer: 'OU=Archive,DC=acme,DC=test',
      },
      bindPassword: 'secret',
      autoApply: true,
    })
  ).id;
  target = new FakeTarget();
  target.containers.push(USERS);
  target.entitlements.push({ externalId: 'guid-finance', dn: FINANCE_DN, type: 'group', displayName: 'Finance' });

  ({ entitlementId, reviewerId } = await withTenant(tenantId, async (tx) => {
    const entitlement = await tx.entitlement.create({
      data: { tenantId, targetSystemId: targetId, externalId: 'guid-finance', dn: FINANCE_DN, type: 'group', displayName: 'Finance' },
    });
    const reviewer = await tx.user.create({
      data: { tenantId, login: 'reviewer', email: 'reviewer@acme.test', displayName: 'Reviewer' },
    });
    // A bystander on a contract no rule names: without anybody on an active
    // contract the guard refuses the run outright, which would test the
    // population refusal rather than anything here.
    const cor = await tx.person.create({ data: { tenantId, givenName: 'Cor', familyName: 'Jansen' } });
    await tx.contract.create({
      data: { tenantId, personId: cor.id, sequence: 1, isPrimary: true, startDate: day('2020-01-01'), department: 'Legal' },
    });
    // Not a first run: `lastAppliedRunAt` takes the guard off its
    // always-confirm branch, so the run is `previewed` and auto-applies.
    await tx.targetSystem.update({ where: { id: targetId }, data: { lastAppliedRunAt: day('2026-01-01') } });
    return { entitlementId: entitlement.id, reviewerId: reviewer.id };
  }));

  await upsertAccountProfile(tenantId, null, targetId, {
    correlationKeyTemplate: '%person.givenName.first%.%person.familyName%',
    maxUniquenessAttempts: 20,
    containerTemplate: USERS,
    fallbackContainer: USERS,
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
  await updateTarget(tenantId, provider, null, targetId, { ladder: { renameEnabled: true } });
});

/**
 * Bea, employed, holding Finance, whose account at the target is still named
 * `oldKey`: the plan's only change for her is the rename to `bea.vos`.
 */
async function seedBea(oldKey = 'bea.old', options: { disabledSince?: Date } = {}) {
  const created = await target.write({ domain: 'acme.test' } as never, {
    op: 'create_account',
    actionId: `seed-${oldKey}`,
    correlationKey: oldKey,
    attributes: { distinguishedName: [`CN=${oldKey},${USERS}`], displayName: ['Bea Vos'] },
    enabled: options.disabledSince === undefined,
    initialPassword: 'Aa1!seed-password',
  });
  const anchor = created.anchor!;
  await target.write({ domain: 'acme.test' } as never, {
    op: 'grant_entitlement',
    actionId: `seed-g-${oldKey}`,
    anchor,
    entitlementId: 'guid-finance',
  });
  const accountId = await withTenant(tenantId, async (tx) => {
    const person = await tx.person.create({ data: { tenantId, givenName: 'Bea', familyName: 'Vos' } });
    await tx.contract.create({
      data: { tenantId, personId: person.id, sequence: 1, isPrimary: true, startDate: day('2020-01-01'), department: 'Finance' },
    });
    const account = await tx.targetAccount.create({
      data: {
        tenantId,
        targetSystemId: targetId,
        personId: person.id,
        anchor,
        correlationKey: oldKey,
        status: options.disabledSince === undefined ? 'active' : 'disabled',
        disabledAt: options.disabledSince ?? null,
        lastAppliedAttributes: { displayName: ['Bea Vos'] },
      },
    });
    await tx.accountEntitlement.create({ data: { tenantId, accountId: account.id, entitlementId, origin: 'rule' } });
    return account.id;
  });
  return { accountId, anchor };
}

/** One auto-applied run, exactly as the scheduler starts one. */
async function autoRun() {
  await runProvisionJob(schedulerStub() as never, provider, { tenantId, targetSystemId: targetId }, { connector: target as never });
  return withTenant(tenantId, (tx) =>
    tx.provisionRun.findFirstOrThrow({ orderBy: { startedAt: 'desc' }, include: { actions: { orderBy: { sequence: 'asc' } } } }),
  );
}

const heldIn = <A extends { actionType: string; status: string; requiresConfirmation: boolean }>(run: { actions: A[] }, type: string) =>
  run.actions.find((a) => a.actionType === type && a.status === 'proposed' && a.requiresConfirmation);

const approve = (runId: string, actionId: string, now?: Date) =>
  withTenant(tenantId, (tx) =>
    approveHeldAction(tx, { targetSystemId: targetId, runId, actionId }, { userId: reviewerId, sourceIp: '10.0.0.1' }, now),
  );

const events = (action: string) =>
  withTenant(tenantId, (tx) => tx.auditEvent.findMany({ where: { action }, orderBy: { sequence: 'asc' } }));

const keyAtTarget = (anchor: string) => target.objects.get(anchor)!.correlationKey;

describe('a held rename on an auto-applied target', () => {
  it('is left proposed on a run that ends partially_applied, which is the defect', async () => {
    await seedBea();
    const run = await autoRun();
    expect(run.status).toBe('partially_applied');
    const rename = heldIn(run, 'rename_account')!;
    expect(rename).toBeDefined();
    expect(rename).toMatchObject({ message: expect.stringMatching(/requires an explicit confirmation/) });
  });

  it('applies in the next auto-applied run once approved, and only that rename', async () => {
    const { accountId, anchor } = await seedBea();
    const first = await autoRun();
    const rename = heldIn(first, 'rename_account')!;

    const approval = await approve(first.id, (rename as { id: string }).id);
    expect(approval.fingerprint).toBe(actionFingerprint({ ...rename, accountId } as never));

    const second = await autoRun();
    const applied = second.actions.find((a) => a.actionType === 'rename_account')!;
    expect(applied.status).toBe('applied');
    expect(second.status).toBe('applied');
    expect(keyAtTarget(anchor)).toBe('bea.vos');

    const row = await withTenant(tenantId, (tx) => tx.provisionActionApproval.findUniqueOrThrow({ where: { id: approval.id } }));
    expect(row.consumedAt).not.toBeNull();
    expect(row.consumedByActionId).toBe(applied.id);

    // Audited both ways: who approved, and that the apply spent that approval.
    const [approvedEvent] = await events('provision.action.approved');
    expect(approvedEvent).toMatchObject({ actorUserId: reviewerId, targetId: (rename as { id: string }).id, sourceIp: '10.0.0.1' });
    expect(approvedEvent!.payload).toMatchObject({ approvalId: approval.id, actionType: 'rename_account', after: { correlationKey: 'bea.vos' } });
    const [confirmedEvent] = await events('provision.action.confirmed_by_approval');
    expect(confirmedEvent).toMatchObject({ targetId: applied.id });
    expect(confirmedEvent!.payload).toMatchObject({ approvalId: approval.id, approvedByUserId: reviewerId });
    const intents = await events('provision.action.intent');
    expect(intents.find((e) => e.targetId === applied.id)!.payload).toMatchObject({ confirmedBy: 'approval' });
  });

  it('does not cover a change whose plan moved on: a fingerprint mismatch defers it', async () => {
    const { anchor } = await seedBea();
    const first = await autoRun();
    const rename = heldIn(first, 'rename_account') as { id: string };
    await approve(first.id, rename.id);

    // The account was renamed at the target by hand in between, so the next
    // plan's rename starts from a different name: a different change.
    await withTenant(tenantId, (tx) =>
      tx.targetAccount.updateMany({ where: { anchor }, data: { correlationKey: 'bea.renamed' } }),
    );
    target.objects.get(anchor)!.correlationKey = 'bea.renamed';

    const second = await autoRun();
    const again = heldIn(second, 'rename_account');
    expect(again).toBeDefined();
    expect(keyAtTarget(anchor)).toBe('bea.renamed');
    expect(await events('provision.action.confirmed_by_approval')).toHaveLength(0);
    const standing = await withTenant(tenantId, (tx) => tx.provisionActionApproval.findFirstOrThrow({}));
    expect(standing.consumedAt).toBeNull();
  });

  it('does not count an expired approval', async () => {
    const { anchor } = await seedBea();
    const first = await autoRun();
    const rename = heldIn(first, 'rename_account') as { id: string };
    await approve(first.id, rename.id, new Date(Date.now() - ACTION_APPROVAL_TTL_MS - 60_000));
    const second = await autoRun();
    expect(heldIn(second, 'rename_account')).toBeDefined();
    expect(keyAtTarget(anchor)).toBe('bea.old');
  });

  it('does not count a revoked approval, and a revoked one cannot be revoked twice', async () => {
    const { anchor } = await seedBea();
    const first = await autoRun();
    const rename = heldIn(first, 'rename_account') as { id: string };
    await approve(first.id, rename.id);
    const ref = { targetSystemId: targetId, runId: first.id, actionId: rename.id };
    const actor = { userId: reviewerId, sourceIp: null };
    await withTenant(tenantId, (tx) => revokeHeldActionApproval(tx, ref, actor));
    await expect(withTenant(tenantId, (tx) => revokeHeldActionApproval(tx, ref, actor))).rejects.toMatchObject({
      code: 'approval-not-revocable',
    });
    expect(await events('provision.action.approval_revoked')).toHaveLength(1);

    const second = await autoRun();
    expect(heldIn(second, 'rename_account')).toBeDefined();
    expect(keyAtTarget(anchor)).toBe('bea.old');
  });

  it('is single-use: the same change proposed again later is held again', async () => {
    const { accountId, anchor } = await seedBea();
    const first = await autoRun();
    const approval = await approve(first.id, (heldIn(first, 'rename_account') as { id: string }).id);
    await autoRun();
    expect(keyAtTarget(anchor)).toBe('bea.vos');

    // Put the same starting point back, so the next plan proposes the very
    // same change -- same fingerprint -- a second time.
    await withTenant(tenantId, (tx) => tx.targetAccount.update({ where: { id: accountId }, data: { correlationKey: 'bea.old' } }));
    target.objects.get(anchor)!.correlationKey = 'bea.old';
    const third = await autoRun();
    const held = heldIn(third, 'rename_account') as { id: string; accountId: string | null };
    expect(held).toBeDefined();
    expect(actionFingerprint(held as never)).toBe(approval.fingerprint);
    expect(keyAtTarget(anchor)).toBe('bea.old');
  });

  it('does not bypass a guard block: the run stays blocked and the approval unspent', async () => {
    const { anchor } = await seedBea();
    const first = await autoRun();
    await approve(first.id, (heldIn(first, 'rename_account') as { id: string }).id);

    // Nine new Finance starters against one account at the target: far past
    // the 20% create threshold, so the guard holds the run for a person.
    await withTenant(tenantId, async (tx) => {
      for (let i = 0; i < 9; i += 1) {
        const person = await tx.person.create({ data: { tenantId, givenName: `New${i}`, familyName: 'Starter' } });
        await tx.contract.create({
          data: { tenantId, personId: person.id, sequence: 1, isPrimary: true, startDate: day('2020-01-01'), department: 'Finance' },
        });
      }
    });
    const second = await autoRun();
    expect(second.status).toBe('blocked');
    // And nothing unconfirmed can apply it: the approval is per action.
    await expect(
      applyProvisionRun(tenantId, provider, second.id, { connector: target as never }),
    ).rejects.toThrow(/blocked and has not been confirmed/);
    expect(keyAtTarget(anchor)).toBe('bea.old');
    const standing = await withTenant(tenantId, (tx) => tx.provisionActionApproval.findFirstOrThrow({}));
    expect(standing.consumedAt).toBeNull();
  });
});

describe('approveHeldAction refusals', () => {
  it('refuses a second approval, an action that is not held, and a run that has not ended', async () => {
    await seedBea();
    const first = await autoRun();
    const rename = heldIn(first, 'rename_account') as { id: string };

    await approve(first.id, rename.id);
    await expect(approve(first.id, rename.id)).rejects.toMatchObject({ code: 'already-approved' });
    // A held run is confirmed on its own Apply, not approved after the fact.
    const preview = await previewProvisionRun(tenantId, provider, targetId, { connector: target as never });
    const previewRename = await withTenant(tenantId, (tx) =>
      tx.provisionAction.findFirstOrThrow({ where: { runId: preview.id, actionType: 'rename_account' } }),
    );
    await expect(approve(preview.id, previewRename.id)).rejects.toMatchObject({ code: 'run-not-finished' });
    // The new plan superseded the old run's held copy: it describes an older
    // plan and is no longer approvable.
    await expect(approve(first.id, rename.id)).rejects.toBeInstanceOf(HeldActionNotApprovableError);
    await expect(approve(first.id, rename.id)).rejects.toMatchObject({ code: 'action-not-held' });
  });

  it('refuses an older run copy of a change a later finished run planned again', async () => {
    await seedBea();
    const first = await autoRun();
    const second = await autoRun();
    const older = heldIn(first, 'rename_account') as { id: string } | undefined;
    // Superseded by the second run's preview, so already not held; force it
    // back to `proposed` to prove the latest-proposal rule holds on its own.
    const olderId = older?.id ?? first.actions.find((a) => a.actionType === 'rename_account')!.id;
    await withTenant(tenantId, (tx) => tx.provisionAction.update({ where: { id: olderId }, data: { status: 'proposed' } }));
    await expect(approve(first.id, olderId)).rejects.toMatchObject({ code: 'action-superseded' });
    await approve(second.id, (heldIn(second, 'rename_account') as { id: string }).id);
  });

  it('says what the run page and the attention summary need', async () => {
    await seedBea();
    const first = await autoRun();
    const rename = heldIn(first, 'rename_account') as { id: string };
    const views = await withTenant(tenantId, (tx) => describeHeldActions(tx, first));
    expect(views).toEqual([expect.objectContaining({ actionId: rename.id, approvable: true, approval: null })]);
    expect((await withTenant(tenantId, (tx) => heldActionCounts(tx, [first.id]))).get(first.id)).toBe(1);
    const attention = await withTenant(tenantId, (tx) => heldActionsAttention(tx));
    expect(attention).toEqual([
      expect.objectContaining({ targetSystemId: targetId, runId: first.id, count: 1, actionTypes: ['rename_account'] }),
    ]);

    await approve(first.id, rename.id);
    const after = await withTenant(tenantId, (tx) => describeHeldActions(tx, first));
    expect(after[0]).toMatchObject({ approvable: false, approval: { state: 'pending' } });
    // Approved is not waiting for anybody.
    expect(await withTenant(tenantId, (tx) => heldActionsAttention(tx))).toEqual([]);
  });
});

describe('autoConfirmRenames', () => {
  it('applies a rename with nobody confirming, and audits it as the setting', async () => {
    const { anchor } = await seedBea();
    await updateTarget(tenantId, provider, reviewerId, targetId, { autoConfirmRenames: true });
    const run = await autoRun();
    const rename = run.actions.find((a) => a.actionType === 'rename_account')!;
    expect(rename.status).toBe('applied');
    expect(keyAtTarget(anchor)).toBe('bea.vos');
    const [event] = await events('provision.action.auto_confirmed');
    expect(event).toMatchObject({ targetId: rename.id, actorUserId: null });
    expect(event!.payload).toMatchObject({ setting: 'autoConfirmRenames', actionType: 'rename_account' });
  });

  it('does not confirm a re-enable', async () => {
    // Disabled for months: far outside the re-enable window, so the re-enable
    // requires confirmation. Same name, so the plan holds no rename.
    const { anchor } = await seedBea('bea.vos', { disabledSince: day('2025-01-01') });
    await target.write({ domain: 'acme.test' } as never, { op: 'disable_account', actionId: 'seed-disable', anchor, reason: 'seeded' });
    await updateTarget(tenantId, provider, reviewerId, targetId, { autoConfirmRenames: true });
    const run = await autoRun();
    expect(heldIn(run, 'enable_account')).toBeDefined();
    expect(target.objects.get(anchor)!.enabled).toBe(false);
    expect(await events('provision.action.auto_confirmed')).toHaveLength(0);
  });

  it('is audited with a from/to diff when it changes', async () => {
    await updateTarget(tenantId, provider, reviewerId, targetId, { autoConfirmRenames: true });
    const updates = await events('provision.target.update');
    expect(updates.at(-1)!.payload).toMatchObject({ autoConfirmRenames: { from: false, to: true } });
  });
});
