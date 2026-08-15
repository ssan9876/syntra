import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
});
