import type { Scheduler } from '@syntra/core';

interface Logger {
  error(data: object, message: string): void;
  warn(data: object, message: string): void;
  info(data: object, message: string): void;
}

/** Serial startup attempts with capped backoff. Shutdown cancels retries and
 * waits for an in-flight attempt before closing its scheduler. */
export function schedulerRecovery(start: () => Promise<Scheduler | null>, logger: Logger) {
  let scheduler: Scheduler | null = null;
  let stopped = false;
  let attempts = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;

  const attempt = (): Promise<void> => {
    if (stopped || scheduler) return Promise.resolve();
    if (pending) return pending;
    pending = (async () => {
      attempts += 1;
      try {
        scheduler = await start();
      } catch (err) {
        logger.error({ err }, 'background scheduler startup failed');
      }
      if (stopped) return;
      if (scheduler) {
        logger.info({ attempts }, 'background scheduler is running');
      } else {
        const retryInMs = Math.min(1_000 * 2 ** Math.min(attempts - 1, 6), 60_000);
        logger.warn({ attempts, retryInMs }, 'background work is unavailable; retrying scheduler startup');
        timer = setTimeout(() => { timer = undefined; void attempt(); }, retryInMs);
        timer.unref?.();
      }
    })().finally(() => { pending = undefined; });
    return pending;
  };

  return {
    start: attempt,
    current: () => scheduler,
    async stop(): Promise<void> {
      if (stopping) return stopping;
      stopped = true;
      if (timer) clearTimeout(timer);
      stopping = (async () => {
        await pending;
        const active = scheduler;
        scheduler = null;
        await active?.stop();
      })();
      return stopping;
    },
  };
}
