import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
// `@syntra/connectors/testing`, not the package root. Commit `00b7631` took
// `FakeTarget` out of the root barrel — a fake reachable from production code
// is a fake that will eventually be reached — and the package declares an
// `exports` map, so the root import the brief specified does not resolve.
import { FakeTarget } from '@syntra/connectors/testing';
import { memoryTransport } from '../notify/notification-service.js';
import { localMasterKeyProvider } from '../vault/master-key.js';
import {
  createTarget,
  deleteTarget,
  updateTarget,
  upsertAccountProfile,
} from './target-service.js';
import { ProvisionRunInFlightError } from './run-service.js';
import {
  PROVISION_JOB,
  STALE_RUN_MS,
  applyTargetSchedule,
  provisionJobPayload,
  provisionScheduleKey,
  registerProvisionJobs,
  removeTargetSchedule,
  runProvisionJob,
} from './jobs.js';

const provider = localMasterKeyProvider(Buffer.alloc(32, 7));
let tenantId: string;
let targetId: string;
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

const schedulerStub = () => ({
  schedule: vi.fn(async () => undefined),
  unschedule: vi.fn(async () => undefined),
  enqueue: vi.fn(async () => 'job-1'),
  register: vi.fn(),
  start: vi.fn(async () => undefined),
  stop: vi.fn(async () => undefined),
});

beforeEach(async () => {
  await resetDatabase();
  // No network. Every other entry point in this plan takes a connector; this
  // one has to as well, or the tests below that actually start a run reach
  // for a domain controller that does not exist, the promise rejects, and
  // every assertion after the call is unreachable.
  target = new FakeTarget();
  target.containers.push('OU=Users,DC=acme,DC=test');
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  const created = await createTarget(tenantId, provider, null, {
    name: 'Acme AD',
    config,
    bindPassword: 'secret',
    schedule: '0 2 * * *',
  });
  targetId = created.id;
  await upsertAccountProfile(tenantId, null, targetId, {
    correlationKeyTemplate: '%person.familyName%',
    maxUniquenessAttempts: 20,
    containerTemplate: 'OU=Users,DC=acme,DC=test',
    fallbackContainer: 'OU=Users,DC=acme,DC=test',
    attributeTemplates: {},
    initialPasswordPolicy: {},
    initialPasswordDelivery: 'vaultOnly',
  });
});

describe('provisionScheduleKey', () => {
  it('names both the tenant and the target', () => {
    // pg-boss keys its schedule table on (queue, key) with key defaulting to
    // the empty string. Every directory source once shared one, and only the
    // last one scheduled ever ran.
    expect(provisionScheduleKey('tenant-a', 'target-b')).toBe('tenant-a/target-b');
  });

  it('gives two targets in one tenant different keys', () => {
    expect(provisionScheduleKey('t', 'a')).not.toBe(provisionScheduleKey('t', 'b'));
  });

  it('gives the same target id in two tenants different keys', () => {
    expect(provisionScheduleKey('t1', 'a')).not.toBe(provisionScheduleKey('t2', 'a'));
  });
});

describe('provisionJobPayload', () => {
  it('carries the tenant, because a background job has no bound tenant', () => {
    expect(provisionJobPayload('t', 'x')).toEqual({
      tenantId: 't',
      targetSystemId: 'x',
    });
  });
});

describe('applyTargetSchedule', () => {
  it('schedules an enabled target with a cron expression under its own key', async () => {
    const scheduler = schedulerStub();
    await applyTargetSchedule(scheduler as never, tenantId, {
      id: targetId,
      schedule: '0 2 * * *',
      enabled: true,
    });
    expect(scheduler.schedule).toHaveBeenCalledWith(
      PROVISION_JOB,
      '0 2 * * *',
      { tenantId, targetSystemId: targetId },
      `${tenantId}/${targetId}`,
    );
  });

  it('unschedules a disabled target rather than skipping it', async () => {
    // Skipping would be right only if it had never been scheduled; for a
    // target that just had `enabled` turned off it would leave the old
    // schedule firing against a target the administrator believes is stopped.
    const scheduler = schedulerStub();
    await applyTargetSchedule(scheduler as never, tenantId, {
      id: targetId,
      schedule: '0 2 * * *',
      enabled: false,
    });
    expect(scheduler.unschedule).toHaveBeenCalledWith(
      PROVISION_JOB,
      `${tenantId}/${targetId}`,
    );
    expect(scheduler.schedule).not.toHaveBeenCalled();
  });

  it('unschedules a target whose cron expression was cleared', async () => {
    const scheduler = schedulerStub();
    await applyTargetSchedule(scheduler as never, tenantId, {
      id: targetId,
      schedule: null,
      enabled: true,
    });
    expect(scheduler.unschedule).toHaveBeenCalled();
    expect(scheduler.schedule).not.toHaveBeenCalled();
  });

  it('unschedules a target whose cron expression is the empty string', async () => {
    // The empty case is the universal case on this slice, four defects over.
    // An empty cron expression is not a cron expression; handing it to pg-boss
    // is either a throw at boot or a schedule nobody wrote.
    const scheduler = schedulerStub();
    await applyTargetSchedule(scheduler as never, tenantId, {
      id: targetId,
      schedule: '',
      enabled: true,
    });
    expect(scheduler.unschedule).toHaveBeenCalled();
    expect(scheduler.schedule).not.toHaveBeenCalled();
  });
});

describe('removeTargetSchedule', () => {
  it('removes the schedule under the same key', async () => {
    const scheduler = schedulerStub();
    await removeTargetSchedule(scheduler as never, tenantId, targetId);
    expect(scheduler.unschedule).toHaveBeenCalledWith(
      PROVISION_JOB,
      `${tenantId}/${targetId}`,
    );
  });
});

describe('the schedule follows the target through create, update and delete', () => {
  it('schedules a target the moment it is created', async () => {
    const scheduler = schedulerStub();
    const created = await createTarget(
      tenantId,
      provider,
      null,
      {
        name: 'Second AD',
        config,
        bindPassword: 'secret',
        schedule: '*/15 * * * *',
      },
      scheduler as never,
    );
    expect(scheduler.schedule).toHaveBeenCalledWith(
      PROVISION_JOB,
      '*/15 * * * *',
      { tenantId, targetSystemId: created.id },
      `${tenantId}/${created.id}`,
    );
  });

  it('unschedules a target created with no cron expression', async () => {
    const scheduler = schedulerStub();
    await createTarget(
      tenantId,
      provider,
      null,
      { name: 'Third AD', config, bindPassword: 'secret' },
      scheduler as never,
    );
    expect(scheduler.schedule).not.toHaveBeenCalled();
    expect(scheduler.unschedule).toHaveBeenCalled();
  });

  it('reschedules on the new cron expression when one is updated', async () => {
    const scheduler = schedulerStub();
    await updateTarget(
      tenantId,
      provider,
      null,
      targetId,
      { schedule: '30 3 * * *' },
      scheduler as never,
    );
    expect(scheduler.schedule).toHaveBeenCalledWith(
      PROVISION_JOB,
      '30 3 * * *',
      { tenantId, targetSystemId: targetId },
      `${tenantId}/${targetId}`,
    );
  });

  it('unschedules when the cron expression is cleared', async () => {
    const scheduler = schedulerStub();
    await updateTarget(
      tenantId,
      provider,
      null,
      targetId,
      { schedule: null },
      scheduler as never,
    );
    expect(scheduler.unschedule).toHaveBeenCalledWith(
      PROVISION_JOB,
      `${tenantId}/${targetId}`,
    );
    expect(scheduler.schedule).not.toHaveBeenCalled();
  });

  it('unschedules when the target is disabled, reading the row after the update', async () => {
    // Read after the update, not from the request body: an update that only
    // sets `enabled: false` says nothing about the cron expression, and
    // reconciling from the input alone would leave the old schedule firing at
    // a target the administrator just stopped.
    const scheduler = schedulerStub();
    await updateTarget(
      tenantId,
      provider,
      null,
      targetId,
      { enabled: false },
      scheduler as never,
    );
    expect(scheduler.unschedule).toHaveBeenCalled();
    expect(scheduler.schedule).not.toHaveBeenCalled();
  });

  it('reschedules an unrelated update from the stored cron expression', async () => {
    const scheduler = schedulerStub();
    await updateTarget(
      tenantId,
      provider,
      null,
      targetId,
      { autoApply: true },
      scheduler as never,
    );
    expect(scheduler.schedule).toHaveBeenCalledWith(
      PROVISION_JOB,
      '0 2 * * *',
      { tenantId, targetSystemId: targetId },
      `${tenantId}/${targetId}`,
    );
  });

  it('removes the schedule when the target is deleted', async () => {
    const scheduler = schedulerStub();
    await deleteTarget(tenantId, null, targetId, true, scheduler as never);
    expect(scheduler.unschedule).toHaveBeenCalledWith(
      PROVISION_JOB,
      `${tenantId}/${targetId}`,
    );
  });

  it('leaves the schedule alone when the delete was only a dry run', async () => {
    // `confirm: false` reports the counts and deletes nothing. Unscheduling
    // there would stop a target that still exists, from a request that was a
    // question rather than an instruction.
    const scheduler = schedulerStub();
    const result = await deleteTarget(
      tenantId,
      null,
      targetId,
      false,
      scheduler as never,
    );
    expect(result.ok).toBe(false);
    expect(scheduler.unschedule).not.toHaveBeenCalled();
  });

  it('still works with no scheduler at all', async () => {
    // Task 12's own tests pass none, and a script or a migration may have no
    // scheduler to hand.
    await expect(
      updateTarget(tenantId, provider, null, targetId, { schedule: '0 5 * * *' }),
    ).resolves.toBeUndefined();
  });
});

describe('runProvisionJob — the skip, made loud', () => {
  const seedAwaitingReview = () =>
    withTenant(tenantId, (tx) =>
      tx.provisionRun.create({
        data: {
          tenantId,
          targetSystemId: targetId,
          status: 'blocked',
          requiresConfirmation: true,
          blockedReason: 'first run',
        },
      }),
    );

  it('does not start while a run is awaiting review, and records the skip on the target', async () => {
    await seedAwaitingReview();
    const scheduler = schedulerStub();
    await runProvisionJob(scheduler as never, provider, {
      tenantId,
      targetSystemId: targetId,
    });

    const target = await withTenant(tenantId, (tx) =>
      tx.targetSystem.findUniqueOrThrow({ where: { id: targetId } }),
    );
    // Ruling P4: on the target's own row, where somebody looks. Not only in an
    // audit event.
    expect(target.consecutiveSkippedRuns).toBe(1);
    expect(target.lastSkippedAt).not.toBeNull();
    expect(target.lastSkipReason).toContain('awaiting review');

    // And the run awaiting review is untouched.
    const runs = await withTenant(tenantId, (tx) => tx.provisionRun.findMany());
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('blocked');
  });

  it('counts consecutive skips so a repeatedly skipping target is distinguishable', async () => {
    await seedAwaitingReview();
    const scheduler = schedulerStub();
    for (let i = 0; i < 3; i += 1) {
      await runProvisionJob(scheduler as never, provider, {
        tenantId,
        targetSystemId: targetId,
      });
    }
    const target = await withTenant(tenantId, (tx) =>
      tx.targetSystem.findUniqueOrThrow({ where: { id: targetId } }),
    );
    expect(target.consecutiveSkippedRuns).toBe(3);
  });

  it('audits the skip as well, in addition to the visible counter', async () => {
    await seedAwaitingReview();
    await runProvisionJob(schedulerStub() as never, provider, {
      tenantId,
      targetSystemId: targetId,
    });
    const events = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'provision.run.skipped' } }),
    );
    expect(events).toHaveLength(1);
  });

  it('names the run it skipped for in the audit payload', async () => {
    const blocked = await seedAwaitingReview();
    await runProvisionJob(schedulerStub() as never, provider, {
      tenantId,
      targetSystemId: targetId,
    });
    const event = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findFirstOrThrow({ where: { action: 'provision.run.skipped' } }),
    );
    expect((event.payload as { blockedRunId?: string }).blockedRunId).toBe(blocked.id);
    expect(event.targetId).toBe(targetId);
    expect(event.outcome).toBe('failure');
  });

  it('resets the skip counter once a run actually starts', async () => {
    await withTenant(tenantId, (tx) =>
      tx.targetSystem.update({
        where: { id: targetId },
        data: {
          consecutiveSkippedRuns: 4,
          lastSkippedAt: new Date(),
          lastSkipReason: 'awaiting review',
        },
      }),
    );
    const scheduler = schedulerStub();
    await runProvisionJob(
      scheduler as never,
      provider,
      { tenantId, targetSystemId: targetId },
      { connector: target as never },
    );
    const row = await withTenant(tenantId, (tx) =>
      tx.targetSystem.findUniqueOrThrow({ where: { id: targetId } }),
    );
    expect(row.consecutiveSkippedRuns).toBe(0);
    expect(row.lastSkipReason).toBeNull();
    expect(row.lastSkippedAt).toBeNull();
  });

  it('does nothing for a disabled target', async () => {
    await withTenant(tenantId, (tx) =>
      tx.targetSystem.update({ where: { id: targetId }, data: { enabled: false } }),
    );
    await runProvisionJob(schedulerStub() as never, provider, {
      tenantId,
      targetSystemId: targetId,
    });
    const runs = await withTenant(tenantId, (tx) => tx.provisionRun.findMany());
    expect(runs).toEqual([]);
  });

  it('does not count a disabled target as a skip', async () => {
    // A target an administrator switched off is not a target failing to run,
    // and counting it would make the one signal Ruling P4 relies on fire for
    // the single case nobody needs telling about.
    await withTenant(tenantId, (tx) =>
      tx.targetSystem.update({ where: { id: targetId }, data: { enabled: false } }),
    );
    await runProvisionJob(schedulerStub() as never, provider, {
      tenantId,
      targetSystemId: targetId,
    });
    const row = await withTenant(tenantId, (tx) =>
      tx.targetSystem.findUniqueOrThrow({ where: { id: targetId } }),
    );
    expect(row.consecutiveSkippedRuns).toBe(0);
  });

  it('does nothing at all for a target that no longer exists', async () => {
    // A schedule outliving its target is what `removeTargetSchedule` exists to
    // prevent; this is what happens if one slips through anyway.
    await expect(
      runProvisionJob(schedulerStub() as never, provider, {
        tenantId,
        targetSystemId: '00000000-0000-0000-0000-000000000000',
      }),
    ).resolves.toBeUndefined();
    const runs = await withTenant(tenantId, (tx) => tx.provisionRun.findMany());
    expect(runs).toEqual([]);
  });

  it('does not apply a blocked run even with autoApply on', async () => {
    await withTenant(tenantId, (tx) =>
      tx.targetSystem.update({ where: { id: targetId }, data: { autoApply: true } }),
    );
    await runProvisionJob(
      schedulerStub() as never,
      provider,
      { tenantId, targetSystemId: targetId },
      { connector: target as never },
    );
    const run = await withTenant(tenantId, (tx) => tx.provisionRun.findFirstOrThrow({}));
    // A first run is always blocked pending confirmation, and the scheduler
    // never confirms anything.
    expect(run.status).toBe('blocked');
    expect(run.confirmedByUserId).toBeNull();
  });

  it('does not start while a run is still `running`, and records that skip too', async () => {
    // `running` is one of the four statuses the partial unique index covers.
    // Omitting it from this check means the scheduler keeps firing into a
    // target whose create will throw, and does not even record a skip -- so a
    // target that has been unrunnable since a crash looks exactly like one
    // running cleanly.
    await withTenant(tenantId, (tx) =>
      tx.provisionRun.create({
        data: { tenantId, targetSystemId: targetId, status: 'running' },
      }),
    );
    await runProvisionJob(
      schedulerStub() as never,
      provider,
      { tenantId, targetSystemId: targetId },
      { connector: target as never },
    );
    const row = await withTenant(tenantId, (tx) =>
      tx.targetSystem.findUniqueOrThrow({ where: { id: targetId } }),
    );
    expect(row.consecutiveSkippedRuns).toBe(1);
    expect(row.lastSkipReason).toContain('running');
  });

  it('does not start while a run is still `applying`', async () => {
    await withTenant(tenantId, (tx) =>
      tx.provisionRun.create({
        data: { tenantId, targetSystemId: targetId, status: 'applying' },
      }),
    );
    await runProvisionJob(
      schedulerStub() as never,
      provider,
      { tenantId, targetSystemId: targetId },
      { connector: target as never },
    );
    const row = await withTenant(tenantId, (tx) =>
      tx.targetSystem.findUniqueOrThrow({ where: { id: targetId } }),
    );
    expect(row.consecutiveSkippedRuns).toBe(1);
    expect(row.lastSkipReason).toContain('applying');
  });

  it('does not start while a run is `previewed` and nobody has applied it', async () => {
    await withTenant(tenantId, (tx) =>
      tx.provisionRun.create({
        data: { tenantId, targetSystemId: targetId, status: 'previewed' },
      }),
    );
    await runProvisionJob(
      schedulerStub() as never,
      provider,
      { tenantId, targetSystemId: targetId },
      { connector: target as never },
    );
    const row = await withTenant(tenantId, (tx) =>
      tx.targetSystem.findUniqueOrThrow({ where: { id: targetId } }),
    );
    expect(row.consecutiveSkippedRuns).toBe(1);
    expect(row.lastSkipReason).toContain('awaiting review');
  });

  it('starts normally when the only earlier run is terminal', async () => {
    await withTenant(tenantId, (tx) =>
      tx.provisionRun.create({
        data: {
          tenantId,
          targetSystemId: targetId,
          status: 'applied',
          finishedAt: new Date(),
        },
      }),
    );
    await runProvisionJob(
      schedulerStub() as never,
      provider,
      { tenantId, targetSystemId: targetId },
      { connector: target as never },
    );
    const runs = await withTenant(tenantId, (tx) => tx.provisionRun.findMany());
    expect(runs).toHaveLength(2);
  });

  it('records a loud skip rather than throwing when a run is already in progress', async () => {
    // `ProvisionRunInFlightError` reaches this handler by two routes. The skip
    // check above catches the ordinary one, in its own transaction, and this
    // asserts the other: the run is created between that check and the create,
    // the partial unique index refuses it, and Task 13 converts the P2002 into
    // this error. Simulated by having the preview raise it directly, because
    // the real trigger is a race between two processes and a test that tried
    // to stage one would be asserting the scheduler's timing rather than this
    // handler's behaviour.
    const scheduler = schedulerStub();
    await runProvisionJob(
      scheduler as never,
      provider,
      { tenantId, targetSystemId: targetId },
      {
        connector: target as never,
        preview: async () => {
          throw new ProvisionRunInFlightError(targetId);
        },
      },
    );
    const row = await withTenant(tenantId, (tx) =>
      tx.targetSystem.findUniqueOrThrow({ where: { id: targetId } }),
    );
    // Recorded where somebody looks, and not thrown: a job that throws here
    // is retried by pg-boss into the same refusal.
    expect(row.consecutiveSkippedRuns).toBe(1);
    expect(row.lastSkipReason).toContain('already in progress');
  });

  it('audits the in-flight refusal too', async () => {
    await runProvisionJob(
      schedulerStub() as never,
      provider,
      { tenantId, targetSystemId: targetId },
      {
        connector: target as never,
        preview: async () => {
          throw new ProvisionRunInFlightError(targetId);
        },
      },
    );
    const events = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'provision.run.skipped' } }),
    );
    expect(events).toHaveLength(1);
  });

  it('still throws anything that is not an in-flight refusal', async () => {
    // A skip is a decision this handler made. A failure is not, and swallowing
    // one would leave pg-boss believing the run succeeded with nothing
    // anywhere saying otherwise.
    await expect(
      runProvisionJob(
        schedulerStub() as never,
        provider,
        { tenantId, targetSystemId: targetId },
        {
          connector: target as never,
          preview: async () => {
            throw new Error('the directory refused the bind');
          },
        },
      ),
    ).rejects.toThrow('the directory refused the bind');
    const row = await withTenant(tenantId, (tx) =>
      tx.targetSystem.findUniqueOrThrow({ where: { id: targetId } }),
    );
    expect(row.consecutiveSkippedRuns).toBe(0);
  });
});

describe('runProvisionJob — a crashed run must not brick the schedule', () => {
  /**
   * Two slices have shipped a "one non-terminal row per X" index whose stale
   * rows nothing cleared, and one of them bricked a target permanently.
   * `previewProvisionRun` has the supersession path — Task 13's
   * `adoptStaleRunsAndStart` — but a skip check that refuses to call it for
   * ANY `running` row puts the brick straight back: the process dies in phase
   * 4, the row stays `running` for ever, and every scheduled run from then on
   * skips. This is the test that crashes one and starts another.
   */
  it('adopts a `running` run left behind by a dead process and starts a new one', async () => {
    const crashed = await withTenant(tenantId, (tx) =>
      tx.provisionRun.create({
        data: {
          tenantId,
          targetSystemId: targetId,
          status: 'running',
          startedAt: new Date(Date.now() - STALE_RUN_MS - 60_000),
        },
      }),
    );
    await runProvisionJob(
      schedulerStub() as never,
      provider,
      { tenantId, targetSystemId: targetId },
      { connector: target as never },
    );
    const rows = await withTenant(tenantId, (tx) =>
      tx.provisionRun.findMany({ orderBy: { startedAt: 'asc' } }),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.id).toBe(crashed.id);
    expect(rows[0]!.status).toBe('failed');
    const row = await withTenant(tenantId, (tx) =>
      tx.targetSystem.findUniqueOrThrow({ where: { id: targetId } }),
    );
    expect(row.consecutiveSkippedRuns).toBe(0);
  });

  it('adopts an `applying` run left behind by a dead process', async () => {
    await withTenant(tenantId, (tx) =>
      tx.provisionRun.create({
        data: {
          tenantId,
          targetSystemId: targetId,
          status: 'applying',
          startedAt: new Date(Date.now() - STALE_RUN_MS - 60_000),
        },
      }),
    );
    await runProvisionJob(
      schedulerStub() as never,
      provider,
      { tenantId, targetSystemId: targetId },
      { connector: target as never },
    );
    const rows = await withTenant(tenantId, (tx) =>
      tx.provisionRun.findMany({ orderBy: { startedAt: 'asc' } }),
    );
    expect(rows).toHaveLength(2);
    // An interrupted apply is `partially_applied`, never `failed`: writes may
    // have landed at the target.
    expect(rows[0]!.status).toBe('partially_applied');
  });

  it('still skips a `running` run that is younger than the staleness window', async () => {
    await withTenant(tenantId, (tx) =>
      tx.provisionRun.create({
        data: {
          tenantId,
          targetSystemId: targetId,
          status: 'running',
          startedAt: new Date(Date.now() - STALE_RUN_MS + 60_000),
        },
      }),
    );
    await runProvisionJob(
      schedulerStub() as never,
      provider,
      { tenantId, targetSystemId: targetId },
      { connector: target as never },
    );
    const rows = await withTenant(tenantId, (tx) => tx.provisionRun.findMany());
    expect(rows).toHaveLength(1);
  });

  it('never adopts a stale run that is awaiting a human decision', async () => {
    // A `blocked` run is somebody's outstanding decision, not a crash. Ageing
    // it out would silently supersede a plan a person was asked to approve,
    // which is the one thing the skip rule exists to prevent — so the counter
    // climbs instead, visibly, until they act.
    await withTenant(tenantId, (tx) =>
      tx.provisionRun.create({
        data: {
          tenantId,
          targetSystemId: targetId,
          status: 'blocked',
          requiresConfirmation: true,
          blockedReason: 'first run',
          startedAt: new Date(Date.now() - STALE_RUN_MS * 10),
        },
      }),
    );
    await runProvisionJob(
      schedulerStub() as never,
      provider,
      { tenantId, targetSystemId: targetId },
      { connector: target as never },
    );
    const rows = await withTenant(tenantId, (tx) => tx.provisionRun.findMany());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('blocked');
    const row = await withTenant(tenantId, (tx) =>
      tx.targetSystem.findUniqueOrThrow({ where: { id: targetId } }),
    );
    expect(row.consecutiveSkippedRuns).toBe(1);
  });

  it('supersedes a blocked run nobody can confirm, however young it is', async () => {
    /**
     * The wedge. A run the guard refused OUTRIGHT — `requiresConfirmation`
     * false — cannot be applied (`applyProvisionRun` throws
     * `ProvisionRunNotConfirmableError` for it unconditionally), cannot be
     * discarded by any route, and used to count as "awaiting review", which
     * meant it was never superseded either. All five of those refusals are
     * conditions the administrator goes and fixes; they fixed the cause and
     * then could not re-run. Nobody has been asked anything about this run, so
     * it is not somebody's outstanding decision and the next run adopts it.
     */
    const wedged = await withTenant(tenantId, (tx) =>
      tx.provisionRun.create({
        data: {
          tenantId,
          targetSystemId: targetId,
          status: 'blocked',
          requiresConfirmation: false,
          blockedReason: 'the target returned no accounts at all',
          // Minutes old, not hours: no elapsed time turns an unconfirmable
          // refusal into something a person can act on, so it does not wait
          // for the staleness window either.
          startedAt: new Date(Date.now() - 60_000),
        },
      }),
    );
    await runProvisionJob(
      schedulerStub() as never,
      provider,
      { tenantId, targetSystemId: targetId },
      { connector: target as never },
    );
    const rows = await withTenant(tenantId, (tx) =>
      tx.provisionRun.findMany({ orderBy: { startedAt: 'asc' } }),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.id).toBe(wedged.id);
    expect(rows[0]!.status).toBe('failed');
    const row = await withTenant(tenantId, (tx) =>
      tx.targetSystem.findUniqueOrThrow({ where: { id: targetId } }),
    );
    expect(row.consecutiveSkippedRuns).toBe(0);
  });

  it('does not adopt an `applying` run that is still showing signs of life', async () => {
    /**
     * `startedAt` is stamped at preview and never restamped, so a run
     * previewed at T and confirmed at T+7h enters `applying` already older
     * than the staleness window. Measured from that column, the next scheduled
     * job declares a LIVE apply abandoned, marks its unreached actions
     * superseded while they are being written to the domain controller, and
     * starts a second run against a half-mutated directory. `lastProgressAt`
     * is the column that answers when this run last showed a sign of life.
     */
    await withTenant(tenantId, (tx) =>
      tx.provisionRun.create({
        data: {
          tenantId,
          targetSystemId: targetId,
          status: 'applying',
          startedAt: new Date(Date.now() - STALE_RUN_MS * 2),
          lastProgressAt: new Date(Date.now() - 30_000),
        },
      }),
    );
    await runProvisionJob(
      schedulerStub() as never,
      provider,
      { tenantId, targetSystemId: targetId },
      { connector: target as never },
    );
    const rows = await withTenant(tenantId, (tx) => tx.provisionRun.findMany());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('applying');
    const row = await withTenant(tenantId, (tx) =>
      tx.targetSystem.findUniqueOrThrow({ where: { id: targetId } }),
    );
    expect(row.consecutiveSkippedRuns).toBe(1);
  });

  it('still adopts an `applying` run whose last sign of life is old', async () => {
    // The other direction of the same column: a heartbeat that stopped is a
    // process that died, and the run has to be adoptable or one crash mid-apply
    // bricks the target for ever.
    await withTenant(tenantId, (tx) =>
      tx.provisionRun.create({
        data: {
          tenantId,
          targetSystemId: targetId,
          status: 'applying',
          startedAt: new Date(Date.now() - STALE_RUN_MS * 2),
          lastProgressAt: new Date(Date.now() - STALE_RUN_MS - 60_000),
        },
      }),
    );
    await runProvisionJob(
      schedulerStub() as never,
      provider,
      { tenantId, targetSystemId: targetId },
      { connector: target as never },
    );
    const rows = await withTenant(tenantId, (tx) =>
      tx.provisionRun.findMany({ orderBy: { startedAt: 'asc' } }),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.status).toBe('partially_applied');
  });

  it('says in the skip reason how long the run has been in progress', async () => {
    const startedAt = new Date(Date.now() - 90_000);
    await withTenant(tenantId, (tx) =>
      tx.provisionRun.create({
        data: { tenantId, targetSystemId: targetId, status: 'running', startedAt },
      }),
    );
    await runProvisionJob(schedulerStub() as never, provider, {
      tenantId,
      targetSystemId: targetId,
    });
    const row = await withTenant(tenantId, (tx) =>
      tx.targetSystem.findUniqueOrThrow({ where: { id: targetId } }),
    );
    expect(row.lastSkipReason).toContain(startedAt.toISOString());
  });
});

describe('registerProvisionJobs — what the registration passes, and what arrives', () => {
  const previewed = async () => ({
    id: 'run-1',
    status: 'previewed',
    requiresConfirmation: false,
    blockedReason: null,
  });

  /** Loosely typed on purpose: the assertions below read argument 3. */
  const appliedNothing = async (..._args: unknown[]) => ({
    status: 'applied',
    applied: 0,
    failed: 0,
    pendingRetry: 0,
    inFlight: 0,
    deferred: 0,
    skipped: 0,
  });

  it('registers a handler on the provision queue', () => {
    const scheduler = schedulerStub();
    registerProvisionJobs(scheduler as never, provider, memoryTransport());
    expect(scheduler.register).toHaveBeenCalledWith(PROVISION_JOB, expect.any(Function));
  });

  it('carries the transport all the way to the apply', async () => {
    // Ruling P16. A job registration that wires one option and drops it at the
    // next hop is this programme's most repeated defect: without the transport
    // here, an unattended autoApply run seals every initial password into the
    // vault and delivers it to nobody, and the scheduled path is where a
    // missing delivery goes unnoticed longest.
    const scheduler = schedulerStub();
    const transport = memoryTransport();
    const apply = vi.fn(appliedNothing);
    await withTenant(tenantId, (tx) =>
      tx.targetSystem.update({ where: { id: targetId }, data: { autoApply: true } }),
    );

    registerProvisionJobs(scheduler as never, provider, transport, {
      preview: previewed as never,
      apply: apply as never,
    });
    const handler = scheduler.register.mock.calls[0]![1] as (
      payload: unknown,
    ) => Promise<void>;
    await handler({ tenantId, targetSystemId: targetId });

    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0]![3]).toMatchObject({ transport });
  });

  it('never confirms anything, however the run was blocked', async () => {
    // Ruling P25's non-confirmable verdicts — "no persons hold an active
    // contract", "the target returned no accounts" — must not be waved through
    // by a tick, and Task 14 found the brief letting one. A scheduled run has
    // no human to name, so it passes neither half of the gate.
    const apply = vi.fn(appliedNothing);
    await withTenant(tenantId, (tx) =>
      tx.targetSystem.update({ where: { id: targetId }, data: { autoApply: true } }),
    );
    await runProvisionJob(
      schedulerStub() as never,
      provider,
      { tenantId, targetSystemId: targetId },
      { preview: previewed as never, apply: apply as never },
    );
    const options = apply.mock.calls[0]![3] as Record<string, unknown>;
    expect(options).not.toHaveProperty('confirm');
    expect(options).not.toHaveProperty('confirmedByUserId');
  });

  it('does not apply at all when autoApply is off', async () => {
    const apply = vi.fn(appliedNothing);
    await runProvisionJob(
      schedulerStub() as never,
      provider,
      { tenantId, targetSystemId: targetId },
      { preview: previewed as never, apply: apply as never },
    );
    expect(apply).not.toHaveBeenCalled();
  });

  it('does not apply a run the preview left blocked', async () => {
    const apply = vi.fn(appliedNothing);
    await withTenant(tenantId, (tx) =>
      tx.targetSystem.update({ where: { id: targetId }, data: { autoApply: true } }),
    );
    await runProvisionJob(
      schedulerStub() as never,
      provider,
      { tenantId, targetSystemId: targetId },
      {
        preview: (async () => ({
          id: 'run-1',
          status: 'blocked',
          requiresConfirmation: true,
          blockedReason: 'the guard refused',
        })) as never,
        apply: apply as never,
      },
    );
    expect(apply).not.toHaveBeenCalled();
  });

  it('enqueues no paired sync when the apply changed nothing', async () => {
    const scheduler = schedulerStub();
    // The paired source matters: without one `enqueuePairedSync` returns
    // early whatever the applied count is, so the fixture would agree with a
    // `result.applied >= 0` bug and this test could not fail. Found by
    // mutation, and it is the "fixture cannot distinguish pass from fail"
    // shape this slice keeps turning up.
    const source = await withTenant(tenantId, (tx) =>
      tx.directorySource.create({
        data: {
          tenantId,
          name: 'Acme AD source',
          type: 'ldap',
          config: {},
          secretName: 'src',
        },
      }),
    );
    await withTenant(tenantId, (tx) =>
      tx.targetSystem.update({
        where: { id: targetId },
        data: { autoApply: true, pairedDirectorySourceId: source.id },
      }),
    );
    await runProvisionJob(
      scheduler as never,
      provider,
      { tenantId, targetSystemId: targetId },
      { preview: previewed as never, apply: appliedNothing as never },
    );
    expect(scheduler.enqueue).not.toHaveBeenCalled();
  });

  it('claims Syntra users and enqueues the paired sync once something applied', async () => {
    // A freshly provisioned person cannot sign in until the next directory
    // sync, so the run that created them asks for one.
    const scheduler = schedulerStub();
    const source = await withTenant(tenantId, (tx) =>
      tx.directorySource.create({
        data: {
          tenantId,
          name: 'Acme AD source',
          type: 'ldap',
          config: {},
          secretName: 'src',
        },
      }),
    );
    await withTenant(tenantId, (tx) =>
      tx.targetSystem.update({
        where: { id: targetId },
        data: { autoApply: true, pairedDirectorySourceId: source.id },
      }),
    );
    await runProvisionJob(
      scheduler as never,
      provider,
      { tenantId, targetSystemId: targetId },
      {
        preview: previewed as never,
        apply: (async () => ({
          status: 'applied',
          applied: 2,
          failed: 0,
          pendingRetry: 0,
          skipped: 0,
        })) as never,
      },
    );
    expect(scheduler.enqueue).toHaveBeenCalledWith('sync.run', {
      tenantId,
      sourceId: source.id,
    });
  });
});

describe('runProvisionJob — claiming the Syntra login', () => {
  const previewed = async () => ({
    id: 'run-1',
    status: 'previewed',
    requiresConfirmation: false,
    blockedReason: null,
  });

  /**
   * A leaver's login, unclaimed: a `User` the paired source created, carrying
   * the same anchor as the person's `TargetAccount` and no `personId`.
   */
  const seedUnclaimedLogin = async () => {
    return withTenant(tenantId, async (tx) => {
      const source = await tx.directorySource.create({
        data: {
          tenantId,
          name: 'Acme AD source',
          type: 'ldap',
          config: {},
          secretName: 'src',
        },
      });
      await tx.targetSystem.update({
        where: { id: targetId },
        data: { pairedDirectorySourceId: source.id },
      });
      const person = await tx.person.create({
        data: { tenantId, givenName: 'Anna', familyName: 'Novak' },
      });
      await tx.targetAccount.create({
        data: {
          tenantId,
          targetSystemId: targetId,
          personId: person.id,
          correlationKey: 'novak',
          status: 'disabled',
          anchor: 'guid-anna',
        },
      });
      const user = await tx.user.create({
        data: {
          tenantId,
          login: 'anna.novak',
          email: 'anna@acme.test',
          displayName: 'Anna Novak',
          sourceId: source.id,
          sourceAnchor: 'guid-anna',
        },
      });
      return { personId: person.id, userId: user.id };
    });
  };

  const personIdOf = (userId: string) =>
    withTenant(tenantId, async (tx) =>
      (await tx.user.findUniqueOrThrow({ where: { id: userId } })).personId,
    );

  it('claims before the plan is computed, so this run can see the login', async () => {
    // `previewProvisionRun` reads logins with `personId: { not: null }`, so a
    // login claimed AFTER the plan is a login the plan could not propose
    // deactivating. This asserts the ordering, not merely the outcome.
    const seeded = await seedUnclaimedLogin();
    let personIdAtPreviewTime: string | null = null;
    await runProvisionJob(
      schedulerStub() as never,
      provider,
      { tenantId, targetSystemId: targetId },
      {
        preview: (async () => {
          personIdAtPreviewTime = await personIdOf(seeded.userId);
          return previewed();
        }) as never,
      },
    );
    expect(personIdAtPreviewTime).toBe(seeded.personId);
  });

  it('claims on a run that applies nothing at all', async () => {
    // The whole failure: a converged target proposes nothing, so `applied` is
    // 0, so the claim the gate hung on never ran — and a departed person whose
    // account an administrator had already disabled by hand keeps an active
    // Syntra login with a Syntra-held password for good, because nothing about
    // them ever changes again and no later run produces an action either.
    const seeded = await seedUnclaimedLogin();
    await withTenant(tenantId, (tx) =>
      tx.targetSystem.update({ where: { id: targetId }, data: { autoApply: true } }),
    );
    await runProvisionJob(
      schedulerStub() as never,
      provider,
      { tenantId, targetSystemId: targetId },
      {
        preview: previewed as never,
        apply: (async () => ({
          status: 'applied',
          applied: 0,
          failed: 0,
          pendingRetry: 0,
          inFlight: 0,
          deferred: 0,
          skipped: 0,
        })) as never,
      },
    );
    expect(await personIdOf(seeded.userId)).toBe(seeded.personId);
  });

  it('claims on a run that never applies, because autoApply is off', async () => {
    const seeded = await seedUnclaimedLogin();
    await runProvisionJob(
      schedulerStub() as never,
      provider,
      { tenantId, targetSystemId: targetId },
      { preview: previewed as never },
    );
    expect(await personIdOf(seeded.userId)).toBe(seeded.personId);
  });

  it('does not claim for a target that is switched off', async () => {
    // A disabled target does not run, and a run that does not start does no
    // maintenance either: the claim is the run's first step, not a step beside
    // it.
    const seeded = await seedUnclaimedLogin();
    await withTenant(tenantId, (tx) =>
      tx.targetSystem.update({ where: { id: targetId }, data: { enabled: false } }),
    );
    await runProvisionJob(
      schedulerStub() as never,
      provider,
      { tenantId, targetSystemId: targetId },
      { preview: previewed as never },
    );
    expect(await personIdOf(seeded.userId)).toBeNull();
  });
});
