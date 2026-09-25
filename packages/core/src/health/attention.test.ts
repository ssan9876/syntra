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
    expect(none).toEqual({ total: 0, provisionRuns: null, lifecycle: null, changeRequests: null });
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
