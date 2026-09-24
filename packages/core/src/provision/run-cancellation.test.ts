import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import type { WriteOperation } from '@syntra/connectors';
import { FakeTarget } from '@syntra/connectors/testing';
import { localMasterKeyProvider } from '../vault/master-key.js';
import { RunNotCancellableError } from '../jobs/cancellation.js';
import { createTarget, upsertAccountProfile, upsertBusinessRule } from './target-service.js';
import { previewProvisionRun } from './run-service.js';
import { applyProvisionRun, ProvisionRunNotAppliableError } from './apply.js';
import { CANCELLED_ACTION_MESSAGE, requestCancelProvisionRun } from './run-cancellation.js';

/*
 * Cooperative cancellation of provisioning runs.
 *
 * The fake target's `write` is wrapped so a request lands while a connector
 * call is in progress — the point in an action's three steps where stopping
 * would be most dangerous, and where the checkpoint must NOT act.
 */

const provider = localMasterKeyProvider(Buffer.alloc(32, 7));
const USERS = 'OU=Users,DC=acme,DC=test';
const FINANCE_DN = 'CN=Finance,OU=Groups,DC=acme,DC=test';
const NOW = new Date('2026-06-15T00:00:00Z');
const noSleep = async () => undefined;

let tenantId: string;
let targetId: string;
let target: FakeTarget;
let actorId: string;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
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
    })
  ).id;
  target = new FakeTarget();
  target.containers.push(USERS);
  target.entitlements.push({ externalId: 'guid-finance', dn: FINANCE_DN, type: 'group', displayName: 'Finance' });

  const entitlementId = await withTenant(tenantId, async (tx) => {
    // Three joiners, so a plan has actions on either side of any checkpoint.
    for (const [given, family] of [['Anna', 'Novak'], ['Ben', 'Okafor'], ['Cleo', 'Ruiz']] as const) {
      const person = await tx.person.create({ data: { tenantId, givenName: given, familyName: family } });
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
    }
    actorId = (
      await tx.user.create({
        data: { tenantId, login: 'operator', email: 'operator@acme.test', displayName: 'Operator' },
      })
    ).id;
    return (
      await tx.entitlement.create({
        data: { tenantId, targetSystemId: targetId, externalId: 'guid-finance', dn: FINANCE_DN, type: 'group', displayName: 'Finance' },
      })
    ).id;
  });

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
});

const preview = () =>
  previewProvisionRun(tenantId, provider, targetId, { now: NOW, connector: target as never });

const apply = (runId: string, only?: string[]) =>
  applyProvisionRun(tenantId, provider, runId, {
    confirm: true,
    confirmedByUserId: actorId,
    connector: target as never,
    now: NOW,
    sleep: noSleep,
    ...(only === undefined ? {} : { only }),
  });

const cancel = (runId: string) =>
  withTenant(tenantId, (tx) =>
    requestCancelProvisionRun(tx, runId, { userId: actorId, sourceIp: '203.0.113.9' }),
  );

const runOf = (runId: string) =>
  withTenant(tenantId, (tx) => tx.provisionRun.findUniqueOrThrow({ where: { id: runId } }));

const actionsOf = (runId: string) =>
  withTenant(tenantId, (tx) =>
    tx.provisionAction.findMany({ where: { runId }, orderBy: { sequence: 'asc' } }),
  );

/** Wraps the fake's write so `during(n)` runs while the n-th write is in progress. */
function onWrite(during: (n: number) => Promise<void>): WriteOperation[] {
  const writes: WriteOperation[] = [];
  const real = target.write.bind(target);
  target.write = async (cfg, op) => {
    writes.push(op);
    await during(writes.length);
    return real(cfg, op);
  };
  return writes;
}

describe('provision run cancellation', () => {
  it('stops between actions, never inside one, and records the partial apply', async () => {
    // `blocked` is the confirmable first-run refusal on an empty target;
    // `apply` below confirms it, as an administrator would.
    const run = await preview();
    expect(['previewed', 'blocked']).toContain(run.status);
    const planned = await actionsOf(run.id);
    expect(planned.length).toBeGreaterThanOrEqual(3);

    // Requested while the FIRST connector call is in flight: that action must
    // finish and record its real outcome; nothing after it may start.
    const writes = onWrite(async (n) => {
      if (n === 1) expect((await cancel(run.id)).outcome).toBe('requested');
    });

    const result = await apply(run.id);

    expect(writes).toHaveLength(1);
    expect(result.status).toBe('cancelled');
    expect(result.applied).toBe(1);

    const after = await actionsOf(run.id);
    expect(after[0]?.status).toBe('applied');
    const rest = after.slice(1);
    expect(rest.every((a) => a.status === 'superseded')).toBe(true);
    expect(rest.every((a) => a.message === CANCELLED_ACTION_MESSAGE)).toBe(true);
    expect(rest.every((a) => a.attempts === 0)).toBe(true);
    // No unknown outcome was manufactured: nothing is left in flight.
    expect(after.some((a) => a.status === 'in_flight')).toBe(false);

    const persisted = await runOf(run.id);
    expect(persisted.status).toBe('cancelled');
    expect(persisted.cancelState).toBe('cancelled');
    expect(persisted.cancelRequestedByUserId).toBe(actorId);
    const events = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({
        where: { action: { in: ['provision.run.cancel', 'provision.run.cancelled', 'provision.run.apply'] } },
        orderBy: { sequence: 'asc' },
      }),
    );
    expect(events.map((e) => e.action)).toEqual([
      'provision.run.cancel',
      'provision.run.cancelled',
      'provision.run.apply',
    ]);
    expect(events[0]?.payload).toMatchObject({ outcome: 'requested', previousStatus: 'applying' });
    expect(events[1]?.payload).toMatchObject({ phase: 'apply', applied: 1, notAttempted: rest.length });
    expect(events[2]?.payload).toMatchObject({ status: 'cancelled', applied: 1 });

    // Terminal, and it frees the target: the next preview starts cleanly and
    // re-proposes what is still desired.
    await expect(cancel(run.id)).rejects.toBeInstanceOf(RunNotCancellableError);
    const next = await preview();
    expect(['previewed', 'blocked']).toContain(next.status);
    expect((await actionsOf(next.id)).length).toBeGreaterThan(0);
  });

  it('records a request the last action finished before observing as moot', async () => {
    const run = await preview();
    const [first] = await actionsOf(run.id);

    onWrite(async () => {
      await cancel(run.id);
    });
    const result = await apply(run.id, [first!.id]);

    expect(result.status).toBe('partially_applied');
    const persisted = await runOf(run.id);
    expect(persisted.status).toBe('partially_applied');
    expect(persisted.cancelState).toBe('moot');
    expect(persisted.cancelResolvedAt).not.toBeNull();
    expect((await actionsOf(run.id))[0]?.status).toBe('applied');
  });

  it('cancels a previewed plan outright, and the plan can no longer be applied', async () => {
    const run = await preview();
    // A campaign's revocation this plan consumed. Bare ids: the order table
    // carries no foreign keys, by design.
    const [carrier] = await actionsOf(run.id);
    const order = await withTenant(tenantId, async (tx) => {
      const created = await tx.revocationOrder.create({
        data: {
          tenantId,
          targetSystemId: targetId,
          accountId: actorId,
          entitlementId: actorId,
          decidedByPersonId: actorId,
          decidedByPersonName: 'Reviewer',
          reason: 'no longer needed',
          status: 'planned',
          plannedAt: NOW,
        },
      });
      await tx.provisionAction.update({
        where: { id: carrier!.id },
        data: { revocationOrderId: created.id },
      });
      return created;
    });

    const result = await cancel(run.id);

    expect(result).toEqual({ outcome: 'cancelled', previousStatus: run.status });
    expect((await actionsOf(run.id)).every((a) => a.status === 'superseded')).toBe(true);
    // Re-opened, so the next run proposes the revocation again rather than
    // treating it as consumed by a plan that will never apply.
    const reopened = await withTenant(tenantId, (tx) =>
      tx.revocationOrder.findUniqueOrThrow({ where: { id: order.id } }),
    );
    expect(reopened.status).toBe('open');
    expect(reopened.plannedAt).toBeNull();
    await expect(apply(run.id)).rejects.toBeInstanceOf(ProvisionRunNotAppliableError);
    expect(target.calls).toEqual([]);
  });

  it('stops a preview at a read checkpoint and writes no plan', async () => {
    const realRead = target.read.bind(target);
    target.read = async function* (cfg) {
      const running = await withTenant(tenantId, (tx) =>
        tx.provisionRun.findFirstOrThrow({ where: { targetSystemId: targetId, status: 'running' } }),
      );
      expect((await cancel(running.id)).outcome).toBe('requested');
      yield* realRead(cfg);
    };

    const run = await preview();

    expect(run.status).toBe('cancelled');
    expect(await actionsOf(run.id)).toEqual([]);
    expect((await runOf(run.id)).cancelState).toBe('cancelled');
  });
});
