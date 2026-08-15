import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@syntra/db';
import { syncScheduleKey } from '../sync/jobs.js';
import { createScheduler, type Scheduler } from './scheduler.js';

let scheduler: Scheduler;

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://syntra_app:syntra_app@localhost:5432/syntra';

beforeEach(() => {
  scheduler = createScheduler(DATABASE_URL);
});

afterEach(async () => {
  await scheduler.stop();
});

const waitFor = async (predicate: () => boolean, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out waiting for condition');
};

describe('scheduler', () => {
  it('runs an enqueued job', async () => {
    const seen: string[] = [];
    scheduler.register<{ value: string }>('test.echo', async (data) => {
      seen.push(data.value);
    });
    await scheduler.start();
    await scheduler.enqueue('test.echo', { value: 'hello' });

    await waitFor(() => seen.length === 1);
    expect(seen).toEqual(['hello']);
  });

  it('carries the tenant in the payload rather than ambiently', async () => {
    // A background job has no request and therefore no bound tenant. The
    // handler must be told which tenant it is acting for.
    const seen: string[] = [];
    scheduler.register<{ tenantId: string }>('test.tenant', async (data) => {
      seen.push(data.tenantId);
    });
    await scheduler.start();
    await scheduler.enqueue('test.tenant', { tenantId: 'tenant-abc' });

    await waitFor(() => seen.length === 1);
    expect(seen).toEqual(['tenant-abc']);
  });

  it('retries a handler that throws', async () => {
    let attempts = 0;
    scheduler.register('test.flaky', async () => {
      attempts++;
      if (attempts < 2) throw new Error('transient');
    });
    await scheduler.start();
    await scheduler.enqueue('test.flaky', {});

    await waitFor(() => attempts >= 2, 60_000);
    expect(attempts).toBeGreaterThanOrEqual(2);
  }, 90_000);

  it('refuses to enqueue a job with no registered handler', async () => {
    await scheduler.start();
    await expect(scheduler.enqueue('test.unknown', {})).rejects.toThrow(
      /no handler/i,
    );
  });

  it('refuses to schedule a job with no registered handler', async () => {
    await scheduler.start();
    await expect(
      scheduler.schedule('test.unknown', '0 * * * *'),
    ).rejects.toThrow(/no handler/i);
  });

  it('is safe to stop without ever starting', async () => {
    await expect(scheduler.stop()).resolves.toBeUndefined();
  });

  it('keeps one schedule per key on a shared queue, and removes only the key it is asked to', async () => {
    // Directory sources all share the `sync.run` queue, and pg-boss keys its
    // schedule table on (name, key) with key defaulting to ''. Without a key
    // per source the second schedule silently overwrites the first, and only
    // the last source scheduled ever runs. That is why `schedule()` takes a
    // key at all, so this asserts it against the real table rather than a
    // stub.
    const queue = 'test.keyed';
    const schedules = () =>
      prisma.$queryRaw<{ key: string; cron: string }[]>`
        SELECT key, cron FROM pgboss.schedule WHERE name = ${queue} ORDER BY key
      `;

    // The production key shape, not a convenient stand-in. pg-boss runs every
    // key through `Attorney.assertKey`, which allows only word characters,
    // dots, hyphens and slashes -- so a test using `source-a` would prove the
    // keying works and prove nothing about whether the keys this code actually
    // generates are ones pg-boss will take. The two source ids differ in their
    // last digit only, so the shared tenant prefix leaves them in this order.
    const tenantId = '11111111-1111-4111-8111-111111111111';
    const first = syncScheduleKey(tenantId, '22222222-2222-4222-8222-222222222221');
    const second = syncScheduleKey(tenantId, '22222222-2222-4222-8222-222222222222');

    scheduler.register(queue, async () => {});
    await scheduler.start();

    try {
      await scheduler.schedule(queue, '0 1 * * *', { n: 1 }, first);
      await scheduler.schedule(queue, '0 2 * * *', { n: 2 }, second);

      expect(await schedules()).toEqual([
        { key: first, cron: '0 1 * * *' },
        { key: second, cron: '0 2 * * *' },
      ]);

      // Rescheduling one leaves the other alone, and replaces rather than
      // duplicates: this is the path an edited source takes.
      await scheduler.schedule(queue, '0 3 * * *', { n: 1 }, first);
      expect(await schedules()).toEqual([
        { key: first, cron: '0 3 * * *' },
        { key: second, cron: '0 2 * * *' },
      ]);

      await scheduler.unschedule(queue, first);
      expect((await schedules()).map((r) => r.key)).toEqual([second]);
    } finally {
      // pg-boss keeps its schema outside `public`, so resetDatabase() does not
      // truncate any of this.
      await scheduler.unschedule(queue, first);
      await scheduler.unschedule(queue, second);
    }
  }, 60_000);
});
