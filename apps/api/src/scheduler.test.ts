import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { SYNC_JOB, syncScheduleKey, type Config } from '@syntra/core';
import { createFakeScheduler } from './test-support.js';
import { scheduleAllSyncSources, startSyncScheduler } from './scheduler.js';

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

describe('scheduleAllSyncSources', () => {
  it('schedules an enabled, cron-bearing source in each of two tenants, each with its own tenantId', async () => {
    const tenantA = await createTenant('A', 'tenant-a');
    const tenantB = await createTenant('B', 'tenant-b');
    const sourceA = await createDirectorySource(tenantA.id, { schedule: '0 1 * * *' });
    const sourceB = await createDirectorySource(tenantB.id, { schedule: '0 2 * * *' });

    const scheduler = createFakeScheduler();
    await scheduleAllSyncSources(scheduler, createFakeLogger());

    expect(scheduler.scheduled).toHaveLength(2);

    const bySource = new Map(
      scheduler.scheduled.map((c) => [(c.data as { sourceId: string }).sourceId, c]),
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

    expect(new Set(scheduler.scheduled.map((c) => c.key)).size).toBe(2);
  });

  it('does not schedule a disabled source or a source with no cron expression', async () => {
    const tenant = await createTenant('Acme', 'acme');
    await createDirectorySource(tenant.id, { enabled: false });
    await createDirectorySource(tenant.id, { schedule: null });
    const eligible = await createDirectorySource(tenant.id);

    const scheduler = createFakeScheduler();
    await scheduleAllSyncSources(scheduler, createFakeLogger());

    expect(scheduler.scheduled).toHaveLength(1);
    expect((scheduler.scheduled[0]!.data as { sourceId: string }).sourceId).toBe(eligible.id);
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
    await scheduleAllSyncSources(scheduler, createFakeLogger());

    expect(scheduler.scheduled).toEqual([]);
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

    await expect(scheduleAllSyncSources(scheduler, createFakeLogger())).resolves.toBeUndefined();

    expect(scheduler.scheduled).toHaveLength(1);
    expect((scheduler.scheduled[0]!.data as { sourceId: string }).sourceId).toBe(good.id);
  });

  it('resolves rather than rejecting, scheduling nothing, when listing tenants fails', async () => {
    const tenant = await createTenant('Acme', 'acme');
    await createDirectorySource(tenant.id);

    vi.spyOn(prisma.tenant, 'findMany').mockRejectedValueOnce(new Error('connection reset'));

    const scheduler = createFakeScheduler();

    await expect(scheduleAllSyncSources(scheduler, createFakeLogger())).resolves.toBeUndefined();

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
    // what got scheduled: scheduleAllSyncSources already has its own
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
