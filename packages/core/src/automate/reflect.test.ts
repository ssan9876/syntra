import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { PROVISION_JOB } from '../provision/jobs.js';
import { reflectProvisionOutcomes } from './reflect.js';

const NOW = new Date('2026-06-15T00:00:00Z');
const MUCH_LATER = new Date('2026-06-17T00:00:00Z');
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

let tenantId: string;
let personId: string;
let userId: string;
let targetSystemId: string;
let entitlementId: string;
let requestId: string;
let itemId: string;
let grantId: string;
let runId: string;

const schedulerStub = () => ({
  schedule: vi.fn(async () => undefined),
  unschedule: vi.fn(async () => undefined),
  // A fake schedules nothing in pg-boss, so nothing it was asked for can be
  // missing. Tests that care about reconciliation build their own.
  missingSchedules: vi.fn(async () => []),
  enqueue: vi.fn(async () => 'job-1'),
  register: vi.fn(),
  start: vi.fn(async () => undefined),
  stop: vi.fn(async () => undefined),
});

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;

  const seeded = await withTenant(tenantId, async (tx) => {
    const person = await tx.person.create({
      data: { tenantId, givenName: 'Anna', familyName: 'Novak' },
    });
    const user = await tx.user.create({
      data: {
        tenantId,
        login: 'anna',
        email: 'anna@acme.test',
        displayName: 'Anna Novak',
        personId: person.id,
      },
    });
    const target = await tx.targetSystem.create({
      data: { tenantId, name: 'Acme AD', secretName: 's/ad', config: { tlsMode: 'ldaps' } },
    });
    const entitlement = await tx.entitlement.create({
      data: {
        tenantId,
        targetSystemId: target.id,
        externalId: 'guid-stats',
        type: 'group',
        displayName: 'Stats',
      },
    });
    const request = await tx.accessRequest.create({
      data: {
        tenantId,
        subjectPersonId: person.id,
        requestedByUserId: user.id,
        requestedByPersonId: person.id,
        status: 'awaiting_fulfilment',
        dispatchedAt: NOW,
      },
    });
    const grant = await tx.accessGrant.create({
      data: {
        tenantId,
        subjectPersonId: person.id,
        resourceType: 'entitlement',
        resourceId: entitlement.id,
        targetSystemId: target.id,
        requestId: request.id,
        startsAt: NOW,
        status: 'pending',
      },
    });
    const item = await tx.requestItem.create({
      data: {
        tenantId,
        requestId: request.id,
        resourceType: 'entitlement',
        resourceId: entitlement.id,
        targetSystemId: target.id,
        status: 'dispatched',
        grantId: grant.id,
      },
    });
    const run = await tx.provisionRun.create({
      data: { tenantId, targetSystemId: target.id, status: 'applied' },
    });
    return {
      personId: person.id,
      userId: user.id,
      targetSystemId: target.id,
      entitlementId: entitlement.id,
      requestId: request.id,
      itemId: item.id,
      grantId: grant.id,
      runId: run.id,
    };
  });
  ({ personId, userId, targetSystemId, entitlementId, requestId, itemId, grantId, runId } =
    seeded);
});

const action = (status: string, message: string | null = null) =>
  withTenant(tenantId, (tx) =>
    tx.provisionAction.create({
      data: {
        tenantId,
        runId,
        actionType: 'grant_entitlement',
        personId,
        entitlementId,
        grantId,
        status,
        message,
        sequence: 1,
      },
    }),
  );

describe('reflectProvisionOutcomes', () => {
  it('moves the grant to active and the request to fulfilled when the action applied', async () => {
    await action('applied');
    const result = await reflectProvisionOutcomes(tenantId, { now: NOW });
    expect(result).toMatchObject({ fulfilled: 1, failed: 0 });

    const state = await withTenant(tenantId, async (tx) => ({
      grant: await tx.accessGrant.findUniqueOrThrow({ where: { id: grantId } }),
      item: await tx.requestItem.findUniqueOrThrow({ where: { id: itemId } }),
      request: await tx.accessRequest.findUniqueOrThrow({ where: { id: requestId } }),
      outbox: await tx.notificationOutbox.findMany(),
    }));
    expect(state.grant.status).toBe('active');
    expect(state.item.status).toBe('fulfilled');
    expect(state.request.status).toBe('fulfilled');
    expect(state.outbox.map((o) => o.template)).toContain('automate-fulfilled');
  });

  it('leaves the grant out of active and tells three parties when the action failed', async () => {
    await withTenant(tenantId, async (tx) => {
      const role = await tx.role.create({
        data: { tenantId, name: 'Automate admin', permissions: [PERMISSIONS.AUTOMATE_MANAGE] },
      });
      const admin = await tx.user.create({
        data: { tenantId, login: 'adm', email: 'adm@acme.test', displayName: 'Adm' },
      });
      await tx.roleAssignment.create({ data: { tenantId, roleId: role.id, userId: admin.id } });
    });
    await action('failed', 'WILL_NOT_PERFORM: 0x2082');

    await reflectProvisionOutcomes(tenantId, { now: NOW });
    const state = await withTenant(tenantId, async (tx) => ({
      grant: await tx.accessGrant.findUniqueOrThrow({ where: { id: grantId } }),
      item: await tx.requestItem.findUniqueOrThrow({ where: { id: itemId } }),
      request: await tx.accessRequest.findUniqueOrThrow({ where: { id: requestId } }),
      outbox: await tx.notificationOutbox.findMany({
        where: { template: 'automate-fulfilment-failed' },
      }),
    }));
    // The console must never claim somebody holds something they do not.
    expect(state.grant.status).toBe('pending');
    expect(state.item.status).toBe('failed');
    // The target's OWN message, carried through rather than replaced by a
    // generic one -- the message is the only thing that tells an
    // administrator what to fix.
    expect(state.item.message).toContain('WILL_NOT_PERFORM');
    expect(state.request.status).toBe('fulfilment_failed');
    expect(state.outbox.map((o) => o.to).sort()).toEqual(['adm@acme.test', 'anna@acme.test']);
  });

  it('stays awaiting_fulfilment when the action was superseded, and re-enqueues', async () => {
    // The case that looks like a failure and is not. The grant is still in
    // desired state, so the superseding run re-proposes it.
    const scheduler = schedulerStub();
    await action('superseded');
    const result = await reflectProvisionOutcomes(tenantId, { now: NOW, scheduler });

    const state = await withTenant(tenantId, async (tx) => ({
      item: await tx.requestItem.findUniqueOrThrow({ where: { id: itemId } }),
      request: await tx.accessRequest.findUniqueOrThrow({ where: { id: requestId } }),
    }));
    expect(state.item.status).toBe('dispatched');
    expect(state.request.status).toBe('awaiting_fulfilment');
    expect(result.redispatched).toBe(1);
    expect(scheduler.enqueue).toHaveBeenCalledWith(PROVISION_JOB, {
      tenantId,
      targetSystemId,
    });
  });

  it('recovers a request whose run was never enqueued at all', async () => {
    // The window the non-transactional enqueue opens, and the crash between
    // the commit and the enqueue, are the same failure and this closes both.
    const scheduler = schedulerStub();
    const result = await reflectProvisionOutcomes(tenantId, { now: NOW, scheduler });
    expect(result.redispatched).toBe(1);
    expect(scheduler.enqueue).toHaveBeenCalledWith(PROVISION_JOB, {
      tenantId,
      targetSystemId,
    });
  });

  it('does not enqueue a second run while one is already in flight', async () => {
    const scheduler = schedulerStub();
    await withTenant(tenantId, (tx) =>
      tx.provisionRun.update({ where: { id: runId }, data: { status: 'previewed' } }),
    );
    const result = await reflectProvisionOutcomes(tenantId, { now: NOW, scheduler });
    expect(result.redispatched).toBe(0);
    expect(scheduler.enqueue).not.toHaveBeenCalled();
  });

  it('recovers a request that failed once and succeeded on a later run', async () => {
    // Terminal for the REQUEST is not terminal for the grant: the grant is
    // still in desired state, so a fixed target converges without anybody
    // raising a second request. The request follows its items.
    await action('failed', 'transient');
    await reflectProvisionOutcomes(tenantId, { now: NOW });
    await withTenant(tenantId, (tx) =>
      tx.requestItem.update({ where: { id: itemId }, data: { provisionActionId: null, status: 'dispatched' } }),
    );
    await action('applied');
    await reflectProvisionOutcomes(tenantId, { now: NOW });
    const request = await withTenant(tenantId, (tx) =>
      tx.accessRequest.findUniqueOrThrow({ where: { id: requestId } }),
    );
    expect(request.status).toBe('fulfilled');
  });

  it('warns the holders of automate.manage once past the fulfilment SLA', async () => {
    await withTenant(tenantId, async (tx) => {
      const role = await tx.role.create({
        data: { tenantId, name: 'Automate admin', permissions: [PERMISSIONS.AUTOMATE_MANAGE] },
      });
      const admin = await tx.user.create({
        data: { tenantId, login: 'adm', email: 'adm@acme.test', displayName: 'Adm' },
      });
      await tx.roleAssignment.create({ data: { tenantId, roleId: role.id, userId: admin.id } });
    });

    const first = await reflectProvisionOutcomes(tenantId, { now: MUCH_LATER });
    expect(first.slaAlerts).toBe(1);
    // Once, not on every tick. A dashboard alert that repeats every five
    // minutes is a dashboard alert people filter.
    const second = await reflectProvisionOutcomes(tenantId, { now: MUCH_LATER });
    expect(second.slaAlerts).toBe(0);
  });

  it('does not warn before the SLA has passed', async () => {
    const result = await reflectProvisionOutcomes(tenantId, { now: NOW });
    expect(result.slaAlerts).toBe(0);
  });
});
