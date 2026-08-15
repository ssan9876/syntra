import { prisma } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { loadConfig, type Scheduler } from '@syntra/core';
import { buildApp } from './app.js';

export const TEST_HOST = 'acme.syntra.test';

export interface ScheduleCall {
  name: string;
  cron: string;
  data: unknown;
  key: string | undefined;
}

export interface FakeScheduler extends Scheduler {
  scheduled: ScheduleCall[];
  unscheduled: { name: string; key: string | undefined }[];
}

/**
 * A `Scheduler` that records what it was asked to do instead of talking to
 * pg-boss.
 *
 * Both arrays matter. Scheduling and unscheduling are two halves of one
 * decision — a source that stops being eligible has to be *removed* from the
 * scheduler, not merely left out of the next round of scheduling — so a test
 * that watched only `scheduled` would pass while a disabled source kept
 * firing.
 *
 * Sources whose id appears in `failSourceIds` reject, to exercise the "one bad
 * source does not stop the rest" path.
 */
export function createFakeScheduler(
  failSourceIds: Set<string> = new Set(),
): FakeScheduler {
  const scheduled: ScheduleCall[] = [];
  const unscheduled: { name: string; key: string | undefined }[] = [];

  return {
    scheduled,
    unscheduled,
    register: () => {},
    start: async () => {},
    stop: async () => {},
    enqueue: async () => null,
    schedule: async (name, cron, data, key) => {
      const sourceId = (data as { sourceId?: string } | undefined)?.sourceId;
      if (sourceId && failSourceIds.has(sourceId)) {
        throw new Error(`schedule failed for source ${sourceId}`);
      }
      scheduled.push({ name, cron, data, key });
    },
    unschedule: async (name, key) => {
      unscheduled.push({ name, key });
    },
  };
}

/**
 * A fresh app against an empty database with one tenant. Logging is off so a
 * deliberately provoked 500 does not print a stack trace into the test output.
 *
 * `scheduler` is how a test watches what the source routes schedule. Left out,
 * they schedule nothing, which is what every test that is not about scheduling
 * wants.
 */
export async function buildTestApp(
  options: { scheduler?: () => Scheduler | null } = {},
) {
  await resetDatabase();
  const tenant = await prisma.tenant.create({
    data: { name: 'Acme', slug: 'acme' },
  });

  const config = loadConfig({
    DATABASE_URL:
      process.env.DATABASE_URL ??
      'postgresql://syntra_app:syntra_app@localhost:5432/syntra',
    PORT: '3000',
    PUBLIC_URL: `http://${TEST_HOST}`,
    SESSION_SECRET: 'x'.repeat(32),
    MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
    SMTP_URL: 'smtp://localhost:1025',
  });

  const app = await buildApp(config, {
    logger: false,
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
  });
  return { app, tenantId: tenant.id, host: TEST_HOST };
}
