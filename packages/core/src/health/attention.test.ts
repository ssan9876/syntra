import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { readAttentionSummary, runAttentionSummary } from './attention.js';

let tenantId: string;

beforeEach(async () => {
  await resetDatabase();
  tenantId = (await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } })).id;
});

const counters = {
  createAccountCount: 0, updateAccountCount: 0, enableAccountCount: 0, disableAccountCount: 0,
  archiveAccountCount: 0, renameAccountCount: 0, grantEntitlementCount: 0, revokeEntitlementCount: 0,
  deactivateSyntraUserCount: 0, reactivateSyntraUserCount: 0,
};

describe('attention summary', () => {
  it('gathers held runs, stuck lifecycle work and pending change requests, per permission', async () => {
    await withTenant(tenantId, async (tx) => {
      const target = await tx.targetSystem.create({
        data: { tenantId, name: 'AD', config: { url: 'ldaps://dc.test:636', tlsMode: 'ldaps' }, secretName: 'target/a' },
      });
      await tx.provisionRun.create({ data: { tenantId, targetSystemId: target.id, status: 'previewed', createAccountCount: 2, grantEntitlementCount: 1 } });
      await tx.lifecycleOperation.create({
        data: {
          tenantId, kind: 'onboard', idempotencyKey: 'failed', status: 'failed', inputFingerprint: 'f', input: {},
          steps: { create: { tenantId, key: 'targets', title: 'Targets', position: 0, status: 'failed', message: 'Target refused' } },
        },
      });
      await tx.lifecycleOperation.create({
        data: {
          tenantId, kind: 'onboard', idempotencyKey: 'verify', status: 'running', inputFingerprint: 'v', input: {},
          steps: { create: { tenantId, key: 'targets', title: 'Targets', position: 0, status: 'running', responseCategory: 'read_back_incomplete' } },
        },
      });
      // Completed work is not waiting for anybody.
      await tx.lifecycleOperation.create({
        data: { tenantId, kind: 'onboard', idempotencyKey: 'done', status: 'completed', inputFingerprint: 'd', input: {} },
      });
      const requester = await tx.user.create({ data: { tenantId, login: 'req', email: 'req@acme.test', displayName: 'Req' } });
      const pending = { tenantId, changeClass: 'role_grant', operation: 'op', targetType: 'Role', summary: 'Grant admin', proposed: {}, baseRevision: 'a'.repeat(64), reason: 'Needed for the quarter close', requestedByUserId: requester.id };
      await tx.privilegedChangeRequest.create({ data: { ...pending, expiresAt: new Date(Date.now() + 3_600_000) } });
      // Past its window: nobody can decide it any more.
      await tx.privilegedChangeRequest.create({ data: { ...pending, requestedAt: new Date(Date.now() - 7_200_000), expiresAt: new Date(Date.now() - 1_000) } });
    });

    const all = await withTenant(tenantId, (tx) => readAttentionSummary(tx, { provision: true, changeRequests: true }));
    expect(all.total).toBe(4);
    expect(all.provisionRuns!.items[0]).toMatchObject({
      status: 'previewed', plannedChanges: 3, planned: 'would create 2 accounts, grant 1 entitlement',
    });
    expect(all.lifecycle).toMatchObject({ failed: 1, awaitingVerification: 1 });
    expect(all.lifecycle!.items.map((item) => item.state).sort()).toEqual(['awaiting_verification', 'failed']);
    expect(all.lifecycle!.items.find((item) => item.state === 'failed')!.message).toBe('Target refused');
    expect(all.changeRequests).toMatchObject({ count: 1 });

    const none = await withTenant(tenantId, (tx) => readAttentionSummary(tx, { provision: false, changeRequests: false }));
    expect(none).toEqual({ total: 0, provisionRuns: null, heldActions: null, lifecycle: null, changeRequests: null });
  });

  it('counts held actions in the latest finished run of each target, once per change, and not once approved', async () => {
    const { targetId, runId, reviewerId, accountId } = await withTenant(tenantId, async (tx) => {
      const target = await tx.targetSystem.create({
        data: { tenantId, name: 'Entra', type: 'entraId', config: {}, secretName: 'target/e' },
      });
      const account = await tx.targetAccount.create({
        data: {
          tenantId, targetSystemId: target.id, anchor: 'obj-1', correlationKey: 'aadmin', status: 'active',
          personId: (await tx.person.create({ data: { tenantId, givenName: 'Sam', familyName: 'Admin' } })).id,
        },
      });
      // An older finished run's held rename is not counted: the latest run
      // re-planned it, and one rename must not read as two.
      const older = await tx.provisionRun.create({
        data: { tenantId, targetSystemId: target.id, status: 'partially_applied', startedAt: new Date(Date.now() - 900_000) },
      });
      const run = await tx.provisionRun.create({ data: { tenantId, targetSystemId: target.id, status: 'partially_applied' } });
      const rename = {
        tenantId, actionType: 'rename_account', accountId: account.id, requiresConfirmation: true,
        before: { correlationKey: 'aadmin' }, after: { correlationKey: 'sadmin' },
      };
      await tx.provisionAction.create({ data: { ...rename, runId: older.id } });
      await tx.provisionAction.create({ data: { ...rename, runId: run.id } });
      await tx.provisionAction.create({ data: { ...rename, runId: run.id, sequence: 1 } });
      // Applied, and one that never needed a tick: neither is waiting.
      await tx.provisionAction.create({ data: { tenantId, runId: run.id, actionType: 'update_account', accountId: account.id, status: 'applied' } });
      const reviewer = await tx.user.create({ data: { tenantId, login: 'rev', email: 'rev@acme.test', displayName: 'Rev' } });
      return { targetId: target.id, runId: run.id, reviewerId: reviewer.id, accountId: account.id };
    });

    const summary = await withTenant(tenantId, (tx) => readAttentionSummary(tx, { provision: true, changeRequests: false }));
    expect(summary.heldActions).toMatchObject({
      count: 1,
      items: [{ targetSystemId: targetId, targetName: 'Entra', runId, count: 1, actionTypes: ['rename_account'], href: `/admin/targets/${targetId}/runs/${runId}` }],
    });
    expect(summary.total).toBe(1);

    // A standing approval of exactly that change: nobody is waiting any more.
    const { actionFingerprint } = await import('../provision/action-approval.js');
    await withTenant(tenantId, (tx) =>
      tx.provisionActionApproval.create({
        data: {
          tenantId, targetSystemId: targetId, accountId, actionType: 'rename_account',
          fingerprint: actionFingerprint({ actionType: 'rename_account', accountId, before: { correlationKey: 'aadmin' }, after: { correlationKey: 'sadmin' } }),
          sourceActionId: runId, approvedByUserId: reviewerId, expiresAt: new Date(Date.now() + 3_600_000),
        },
      }),
    );
    const after = await withTenant(tenantId, (tx) => readAttentionSummary(tx, { provision: true, changeRequests: false }));
    expect(after.heldActions).toEqual({ count: 0, items: [] });
  });

  it('says what a held run is waiting on', () => {
    expect(runAttentionSummary({ ...counters, status: 'blocked', requiresConfirmation: true, blockedReason: 'would create 1 of 2 accounts (50.0%), above the 20% threshold; x' }))
      .toBe('Held for confirmation: would create 1 of 2 accounts (50.0%), above the 20% threshold');
    expect(runAttentionSummary({ ...counters, status: 'blocked', requiresConfirmation: false, blockedReason: 'the target returned no accounts at all' }))
      .toBe('Refused by the safety guard: the target returned no accounts at all');
    expect(runAttentionSummary({ ...counters, status: 'previewed', requiresConfirmation: false, blockedReason: null }))
      .toBe('Waiting to be applied: no changes planned');
  });
});
