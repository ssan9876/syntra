import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import {
  KEY_ROTATION_CRON,
  KEY_ROTATION_JOB,
  PROVISION_JOB,
  SYNC_JOB,
  keyRotationScheduleKey,
  memoryTransport,
  provisionScheduleKey,
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

async function createTargetSystem(
  tenantId: string,
  overrides: { schedule?: string | null; enabled?: boolean } = {},
) {
  // `'schedule' in overrides`, for the reason `createDirectorySource` records.
  const schedule: string | null =
    'schedule' in overrides ? (overrides.schedule ?? null) : '0 2 * * *';
  return withTenant(tenantId, (tx) =>
    tx.targetSystem.create({
      data: {
        tenantId,
        name: `target-${Math.random().toString(36).slice(2)}`,
        // `target_system_encrypted_transport` is a CHECK on the JSON: a target
        // that says nothing about its transport is refused outright.
        config: { url: 'ldaps://dc.acme.test:636', tlsMode: 'ldaps' },
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

/** Only the provisioning schedules, for the same reason. */
const provisionSchedules = (scheduler: ReturnType<typeof createFakeScheduler>) =>
  scheduler.scheduled.filter((c) => c.name === PROVISION_JOB);

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

    // Saved and put back by hand, NOT `vi.spyOn` plus `restoreAllMocks`.
    // Vitest's restore leaves `prisma.tenant.findMany` undefined on Prisma's
    // model delegate, so every later test in this file got
    // `findMany is not a function` and quietly scheduled nothing -- passing,
    // because the assertions that survived it were about what was NOT
    // scheduled. Task 16's target tests are the first ones here that assert
    // something WAS, and they are what made it visible.
    const original = prisma.tenant.findMany;
    prisma.tenant.findMany = (() => {
      throw new Error('connection reset');
    }) as typeof prisma.tenant.findMany;

    const scheduler = createFakeScheduler();

    try {
      await expect(
        scheduleBackgroundWork(scheduler, createFakeLogger()),
      ).resolves.toBeUndefined();
    } finally {
      prisma.tenant.findMany = original;
    }

    expect(scheduler.scheduled).toHaveLength(0);
  });
});

describe('scheduleBackgroundWork - provisioning targets', () => {
  it('schedules an enabled, cron-bearing target in each of two tenants under its own key', async () => {
    const tenantA = await createTenant('A', 'tenant-a');
    const tenantB = await createTenant('B', 'tenant-b');
    const targetA = await createTargetSystem(tenantA.id, { schedule: '0 1 * * *' });
    const targetB = await createTargetSystem(tenantB.id, { schedule: '0 2 * * *' });

    const scheduler = createFakeScheduler();
    await scheduleBackgroundWork(scheduler, createFakeLogger());

    expect(provisionSchedules(scheduler)).toHaveLength(2);
    const byTarget = new Map(
      provisionSchedules(scheduler).map((c) => [
        (c.data as { targetSystemId: string }).targetSystemId,
        c,
      ]),
    );

    const callA = byTarget.get(targetA.id);
    expect(callA).toBeDefined();
    expect(callA!.cron).toBe('0 1 * * *');
    expect(callA!.data).toEqual({ tenantId: tenantA.id, targetSystemId: targetA.id });
    // The lesson every directory source once taught by sharing `key: ''`:
    // pg-boss keys on (queue, key), so two schedules with the same key are one
    // row and only the last target in the last tenant ever runs.
    expect(callA!.key).toBe(provisionScheduleKey(tenantA.id, targetA.id));

    const callB = byTarget.get(targetB.id);
    expect(callB).toBeDefined();
    expect(callB!.key).toBe(provisionScheduleKey(tenantB.id, targetB.id));

    expect(new Set(provisionSchedules(scheduler).map((c) => c.key)).size).toBe(2);
  });

  it('unschedules a target that is no longer eligible, rather than merely skipping it', async () => {
    const tenant = await createTenant('Acme', 'acme');
    const disabled = await createTargetSystem(tenant.id, { enabled: false });
    const manual = await createTargetSystem(tenant.id, { schedule: null });

    const scheduler = createFakeScheduler();
    await scheduleBackgroundWork(scheduler, createFakeLogger());

    expect(provisionSchedules(scheduler)).toEqual([]);
    const keys = scheduler.unscheduled
      .filter((c) => c.name === PROVISION_JOB)
      .map((c) => c.key)
      .sort();
    expect(keys).toEqual(
      [
        provisionScheduleKey(tenant.id, disabled.id),
        provisionScheduleKey(tenant.id, manual.id),
      ].sort(),
    );
  });

  it('keeps scheduling the remaining targets when one schedule() call throws', async () => {
    const tenant = await createTenant('Acme', 'acme');
    const bad = await createTargetSystem(tenant.id, { schedule: '* * * * *' });
    const good = await createTargetSystem(tenant.id, { schedule: '0 3 * * *' });

    const scheduler = createFakeScheduler(new Set([bad.id]));

    await expect(
      scheduleBackgroundWork(scheduler, createFakeLogger()),
    ).resolves.toBeUndefined();

    expect(provisionSchedules(scheduler)).toHaveLength(1);
    expect(
      (provisionSchedules(scheduler)[0]!.data as { targetSystemId: string })
        .targetSystemId,
    ).toBe(good.id);
  });

  it('still schedules the sources when the target read fails, and resolves', async () => {
    // "Log and do nothing for this piece". The three loops are independent: a
    // provisioning read that fails must not cost the tenant its directory
    // sync, and an API that comes up with provisioning unscheduled is strictly
    // better than one that does not come up at all.
    const tenant = await createTenant('Acme', 'acme');
    const source = await createDirectorySource(tenant.id, { schedule: '0 4 * * *' });
    await createTargetSystem(tenant.id);

    // The sources read is the first transaction of the run and the targets
    // read is the second, so failing only the second breaks exactly the loop
    // this test is about. Saved and restored by hand for the reason the
    // tenant-listing test above records.
    const original = prisma.$transaction;
    let calls = 0;
    prisma.$transaction = ((...args: unknown[]) => {
      calls += 1;
      if (calls === 2) return Promise.reject(new Error('connection reset'));
      return (original as (...a: unknown[]) => unknown).apply(prisma, args);
    }) as typeof prisma.$transaction;

    const scheduler = createFakeScheduler();
    try {
      await expect(
        scheduleBackgroundWork(scheduler, createFakeLogger()),
      ).resolves.toBeUndefined();
    } finally {
      prisma.$transaction = original;
    }

    expect(provisionSchedules(scheduler)).toEqual([]);
    expect(
      syncSchedules(scheduler).map((c) => (c.data as { sourceId: string }).sourceId),
    ).toEqual([source.id]);
  });

  it('schedules nothing at all for a tenant with no targets', async () => {
    // The empty case is the universal case on this slice, four defects over.
    await createTenant('Acme', 'acme');
    const scheduler = createFakeScheduler();
    await expect(
      scheduleBackgroundWork(scheduler, createFakeLogger()),
    ).resolves.toBeUndefined();
    expect(provisionSchedules(scheduler)).toEqual([]);
    expect(scheduler.unscheduled.filter((c) => c.name === PROVISION_JOB)).toEqual([]);
  });
});

describe('startSyncScheduler', () => {
  const config = {
    databaseUrl: process.env.DATABASE_URL ?? '',
    masterKey: Buffer.alloc(32, 7),
    smtpUrl: 'smtp://localhost:1025',
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

  it('registers the provisioning queue alongside sync and key rotation', async () => {
    // Ruling P16. A queue with a schedule and no handler is a schedule that
    // fires into nothing: pg-boss has a row, the target carries a cron
    // expression on its screen, and no run ever happens.
    const scheduler = createFakeScheduler();
    await startSyncScheduler(config, createFakeLogger(), () => scheduler, {
      transport: memoryTransport(),
    });
    expect(scheduler.registered).toContain(PROVISION_JOB);
    expect(scheduler.registered).toContain(SYNC_JOB);
  });
});
