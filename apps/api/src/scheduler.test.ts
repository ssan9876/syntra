import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import {
  KEY_ROTATION_CRON,
  KEY_ROTATION_JOB,
  SYNC_JOB,
  keyRotationScheduleKey,
  syncScheduleKey,
  type Config,
} from '@syntra/core';
import { createFakeScheduler } from './test-support.js';
import { scheduleBackgroundWork, startSyncScheduler } from './scheduler.js';

function createFakeLogger(): FastifyBaseLogger {
  const noop = () => {};
  return {
    error: noop,
    warn: noop,
    info: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
    silent: noop,
    level: 'info',
    child: () => createFakeLogger(),
  } as unknown as FastifyBaseLogger;
}

async function createTenant(name: string, slug: string) {
  return prisma.tenant.create({ data: { name, slug } });
}

async function createDirectorySource(
  tenantId: string,
  overrides: { schedule?: string | null; enabled?: boolean } = {},
) {
  // `'schedule' in overrides`, not `??`: a caller explicitly passing
  // `schedule: null` (to test the no-cron case) must not be silently
  // overwritten by the default just because `null` is also nullish.
  const schedule: string | null =
    'schedule' in overrides ? (overrides.schedule ?? null) : '0 * * * *';
  return withTenant(tenantId, (tx) =>
    tx.directorySource.create({
      data: {
        tenantId,
        name: `source-${Math.random().toString(36).slice(2)}`,
        config: {},
        secretName: 'unused',
        schedule,
        enabled: overrides.enabled ?? true,
      },
    }),
  );
}

beforeEach(async () => {
  await resetDatabase();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Only the sync schedules.
 *
 * Every tenant also gets a key-rotation schedule now, and the assertions below
 * are about directory sources. Filtering by queue keeps them saying what they
 * were written to say instead of counting two unrelated things together.
 */
const syncSchedules = (scheduler: ReturnType<typeof createFakeScheduler>) =>
  scheduler.scheduled.filter((c) => c.name === SYNC_JOB);

describe('scheduleBackgroundWork', () => {
  it('schedules an enabled, cron-bearing source in each of two tenants, each with its own tenantId', async () => {
    const tenantA = await createTenant('A', 'tenant-a');
    const tenantB = await createTenant('B', 'tenant-b');
    const sourceA = await createDirectorySource(tenantA.id, { schedule: '0 1 * * *' });
    const sourceB = await createDirectorySource(tenantB.id, { schedule: '0 2 * * *' });

    const scheduler = createFakeScheduler();
    await scheduleBackgroundWork(scheduler, createFakeLogger());

    expect(syncSchedules(scheduler)).toHaveLength(2);

    const bySource = new Map(
      syncSchedules(scheduler).map((c) => [(c.data as { sourceId: string }).sourceId, c]),
    );

    const callA = bySource.get(sourceA.id);
    expect(callA).toBeDefined();
    expect(callA!.name).toBe(SYNC_JOB);
    expect(callA!.cron).toBe('0 1 * * *');
    expect(callA!.data).toEqual({ tenantId: tenantA.id, sourceId: sourceA.id });
    // Every source on this queue needs a key of its own. pg-boss keys its
    // schedule table on (queue, key) with key defaulting to '', so without
    // one the second source scheduled silently replaces the first and only
    // the last source in the last tenant ever runs.
    expect(callA!.key).toBe(syncScheduleKey(tenantA.id, sourceA.id));

    const callB = bySource.get(sourceB.id);
    expect(callB).toBeDefined();
    expect(callB!.cron).toBe('0 2 * * *');
    expect(callB!.data).toEqual({ tenantId: tenantB.id, sourceId: sourceB.id });
    expect(callB!.key).toBe(syncScheduleKey(tenantB.id, sourceB.id));

    expect(new Set(syncSchedules(scheduler).map((c) => c.key)).size).toBe(2);
  });

  it('does not schedule a disabled source or a source with no cron expression', async () => {
    const tenant = await createTenant('Acme', 'acme');
    await createDirectorySource(tenant.id, { enabled: false });
    await createDirectorySource(tenant.id, { schedule: null });
    const eligible = await createDirectorySource(tenant.id);

    const scheduler = createFakeScheduler();
    await scheduleBackgroundWork(scheduler, createFakeLogger());

    expect(syncSchedules(scheduler)).toHaveLength(1);
    expect((syncSchedules(scheduler)[0]!.data as { sourceId: string }).sourceId).toBe(
      eligible.id,
    );
  });

  it('unschedules a source that is no longer eligible, rather than merely skipping it', async () => {
    // pg-boss keeps schedules in the database, so one written before a source
    // was disabled outlives the process that wrote it. Skipping the source at
    // boot would leave that schedule firing against a source an administrator
    // believes is stopped.
    const tenant = await createTenant('Acme', 'acme');
    const disabled = await createDirectorySource(tenant.id, { enabled: false });
    const manual = await createDirectorySource(tenant.id, { schedule: null });

    const scheduler = createFakeScheduler();
    await scheduleBackgroundWork(scheduler, createFakeLogger());

    expect(syncSchedules(scheduler)).toEqual([]);
    expect(scheduler.unscheduled.map((c) => c.key).sort()).toEqual(
      [
        syncScheduleKey(tenant.id, disabled.id),
        syncScheduleKey(tenant.id, manual.id),
      ].sort(),
    );
  });

  it('keeps scheduling the remaining sources when one schedule() call throws, and resolves rather than rejecting', async () => {
    const tenant = await createTenant('Acme', 'acme');
    const bad = await createDirectorySource(tenant.id, { schedule: '* * * * *' });
    const good = await createDirectorySource(tenant.id, { schedule: '0 3 * * *' });

    const scheduler = createFakeScheduler(new Set([bad.id]));

    await expect(scheduleBackgroundWork(scheduler, createFakeLogger())).resolves.toBeUndefined();

    expect(syncSchedules(scheduler)).toHaveLength(1);
    expect((syncSchedules(scheduler)[0]!.data as { sourceId: string }).sourceId).toBe(good.id);
  });

  it('schedules one signing key rotation per tenant, keyed so neither replaces the other', async () => {
    // Spec section 12 asks for rotation on a schedule. The mechanism has been
    // built and correct since Task 3 and had no caller at all -- no job, no
    // route, no CLI -- so a key was published, used, and never rolled.
    const tenantA = await createTenant('A', 'tenant-a');
    const tenantB = await createTenant('B', 'tenant-b');

    const scheduler = createFakeScheduler();
    await scheduleBackgroundWork(scheduler, createFakeLogger());

    const rotations = scheduler.scheduled.filter((c) => c.name === KEY_ROTATION_JOB);
    expect(rotations).toHaveLength(2);
    for (const tenant of [tenantA, tenantB]) {
      const call = rotations.find(
        (c) => (c.data as { tenantId: string }).tenantId === tenant.id,
      );
      expect(call).toBeDefined();
      expect(call!.cron).toBe(KEY_ROTATION_CRON);
      // OIDC only: a SAML service provider typically pins the certificate, so
      // rotating one on a timer would break working integrations a week later.
      expect(call!.data).toEqual({ tenantId: tenant.id, kind: 'oidc' });
      expect(call!.key).toBe(keyRotationScheduleKey(tenant.id, 'oidc'));
    }
    // The lesson every directory source once taught by sharing `key: ''`:
    // pg-boss keys on (queue, key), so two schedules with the same key are one
    // row and only the last tenant's ever runs.
    expect(new Set(rotations.map((c) => c.key)).size).toBe(2);
  });

  it('resolves rather than rejecting, scheduling nothing, when listing tenants fails', async () => {
    const tenant = await createTenant('Acme', 'acme');
    await createDirectorySource(tenant.id);

    vi.spyOn(prisma.tenant, 'findMany').mockRejectedValueOnce(new Error('connection reset'));

    const scheduler = createFakeScheduler();

    await expect(scheduleBackgroundWork(scheduler, createFakeLogger())).resolves.toBeUndefined();

    expect(scheduler.scheduled).toHaveLength(0);
  });
});

describe('startSyncScheduler', () => {
  const config = {
    databaseUrl: process.env.DATABASE_URL ?? '',
    masterKey: Buffer.alloc(32, 7),
  } as unknown as Config;

  it('resolves with null rather than rejecting when the scheduler cannot start', async () => {
    // server.ts states that a scheduling failure must never keep the API from
    // coming up. pg-boss failing to start is the loudest way that could
    // happen, so it is the one this asserts.
    const scheduler = createFakeScheduler();
    scheduler.start = async () => {
      throw new Error('pg-boss could not reach the database');
    };

    await expect(
      startSyncScheduler(config, createFakeLogger(), () => scheduler),
    ).resolves.toBeNull();
  });

  it('starts the scheduler and hands it back when it comes up', async () => {
    // Deliberately asserts on start() and the return value rather than on
    // what got scheduled: scheduleBackgroundWork already has its own
    // coverage above, and reaching for the database here would make this
    // test order-dependent on the tenant-listing mock in that block.
    const scheduler = createFakeScheduler();
    let started = false;
    scheduler.start = async () => {
      started = true;
    };

    const result = await startSyncScheduler(
      config,
      createFakeLogger(),
      () => scheduler,
    );

    expect(started).toBe(true);
    expect(result).toBe(scheduler);
  });
});
