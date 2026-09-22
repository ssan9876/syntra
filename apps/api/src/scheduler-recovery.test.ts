import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Scheduler } from '@syntra/core';
import { schedulerRecovery } from './scheduler-recovery.js';

const logger = () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() });
const worker = () => ({ stop: vi.fn(async () => {}) }) as unknown as Scheduler;
afterEach(() => { vi.useRealTimers(); });

describe('scheduler startup recovery', () => {
  it('retries a failure and exposes the recovered worker', async () => {
    vi.useFakeTimers();
    const scheduler = worker();
    const start = vi.fn<() => Promise<Scheduler | null>>()
      .mockResolvedValueOnce(null).mockResolvedValueOnce(scheduler);
    const recovery = schedulerRecovery(start, logger());
    await recovery.start();
    expect(recovery.current()).toBeNull();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(recovery.current()).toBe(scheduler);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(start).toHaveBeenCalledTimes(2);
    await recovery.stop();
    expect(scheduler.stop).toHaveBeenCalledOnce();
  });

  it('backs off to at most one attempt per minute and handles rejected starts', async () => {
    vi.useFakeTimers();
    const log = logger();
    const start = vi.fn(async () => { throw new Error('database unavailable'); });
    const recovery = schedulerRecovery(start, log);
    await recovery.start();
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]) {
      const before = start.mock.calls.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(start).toHaveBeenCalledTimes(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(start).toHaveBeenCalledTimes(before + 1);
    }
    expect(log.error).toHaveBeenCalled();
    await recovery.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(start).toHaveBeenCalledTimes(9);
  });

  it('waits for an in-flight start on shutdown without scheduling another attempt', async () => {
    vi.useFakeTimers();
    const scheduler = worker();
    let resolve!: (value: Scheduler) => void;
    const start = vi.fn(() => new Promise<Scheduler>((done) => { resolve = done; }));
    const recovery = schedulerRecovery(start, logger());
    const first = recovery.start();
    const second = recovery.start();
    expect(start).toHaveBeenCalledOnce();
    const stop = recovery.stop();
    resolve(scheduler);
    await Promise.all([first, second, stop, recovery.stop()]);
    expect(scheduler.stop).toHaveBeenCalledOnce();
    expect(recovery.current()).toBeNull();
    await vi.advanceTimersByTimeAsync(120_000);
    await recovery.start();
    expect(start).toHaveBeenCalledOnce();
  });
});
