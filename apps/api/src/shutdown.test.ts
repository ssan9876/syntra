import { describe, expect, it, vi } from 'vitest';
import type { Scheduler } from '@syntra/core';
import { shutdownHandler, type Closeables } from './shutdown.js';

const harness = (overrides: Partial<Closeables> = {}) => {
  const order: string[] = [];
  const stop = vi.fn(async () => {
    order.push('scheduler');
  });
  const closeables: Closeables = {
    app: {
      close: vi.fn(async () => {
        order.push('http');
      }),
      log: { info: vi.fn(), error: vi.fn() },
    },
    scheduler: () => ({ stop } as unknown as Scheduler),
    disconnect: vi.fn(async () => {
      order.push('database');
    }),
    ...overrides,
  };
  return { closeables, order, stop };
};

describe('shutdownHandler', () => {
  it('drains HTTP before it stops the scheduler', async () => {
    // A request in flight may enqueue — saving a source reschedules it there
    // and then. Stopping the scheduler underneath that request turns an
    // ordinary save into a 500 at the moment an operator can least tell a
    // shutdown from a fault.
    const { closeables, order } = harness();
    await shutdownHandler(closeables)('SIGTERM');
    expect(order).toEqual(['http', 'scheduler', 'database']);
  });

  it('closes once, however many signals arrive', async () => {
    // Kubernetes sends SIGTERM then SIGKILL; an operator presses Ctrl-C twice.
    // Neither is a request for two shutdowns, and the second would call
    // close() on an already-closing server.
    const { closeables, order } = harness();
    const handler = shutdownHandler(closeables);
    await Promise.all([handler('SIGTERM'), handler('SIGINT'), handler('SIGTERM')]);
    expect(order).toEqual(['http', 'scheduler', 'database']);
  });

  it('keeps closing the rest when one step throws', async () => {
    // A half-closed process that reports what it could not close beats one
    // that stopped at the first error still holding a connection pool.
    const { closeables, order } = harness({
      app: {
        close: vi.fn(async () => {
          throw new Error('a socket refused to drain');
        }),
        log: { info: vi.fn(), error: vi.fn() },
      },
    });
    await shutdownHandler(closeables)('SIGTERM');

    expect(order).toEqual(['scheduler', 'database']);
    expect(closeables.app.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ what: 'http' }),
      expect.stringContaining('could not close cleanly'),
    );
  });

  it('does not fall over when the scheduler never started', async () => {
    // `startSyncScheduler` returns null rather than keeping the API down, so
    // null is a state this process genuinely runs in.
    const { closeables, order } = harness({ scheduler: () => null });
    await shutdownHandler(closeables)('SIGTERM');
    expect(order).toEqual(['http', 'database']);
  });
});
