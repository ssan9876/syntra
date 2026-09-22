import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createScheduler } from './scheduler.js';

const boss = vi.hoisted(() => ({
  start: vi.fn(), stop: vi.fn(), createQueue: vi.fn(), work: vi.fn(), on: vi.fn(),
}));
vi.mock('pg-boss', () => ({ PgBoss: vi.fn(function () { return boss; }) }));
beforeEach(() => { vi.resetAllMocks(); });

describe('scheduler lifecycle', () => {
  it('closes resources after a queue fails during startup', async () => {
    boss.createQueue.mockRejectedValue(new Error('cannot create queue'));
    const scheduler = createScheduler('postgresql://unused');
    scheduler.register('test.job', async () => {});
    await expect(scheduler.start()).rejects.toThrow('cannot create queue');
    await scheduler.stop();
    expect(boss.stop).toHaveBeenCalledWith({ graceful: true });
  });

  it('installs an error handler before startup so polling errors are reported', () => {
    const report = vi.fn();
    createScheduler('postgresql://unused', report);
    expect(boss.on).toHaveBeenCalledWith('error', report);
    const error = new Error('polling failed');
    boss.on.mock.calls[0]![1](error);
    expect(report).toHaveBeenCalledWith(error);
  });
});
