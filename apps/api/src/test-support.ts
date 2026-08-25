import { prisma } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { loadConfig, memoryTransport, type Scheduler } from '@syntra/core';
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
  /** Queue names a handler was registered for, in registration order. */
  registered: string[];
  /**
   * One-off jobs, in the order they were sent. A recurring schedule and a
   * single enqueue are different promises to the caller — "every night" against
   * "now, once" — and a fake that recorded only the first would let an endpoint
   * that queues nothing pass.
   */
  enqueued: { name: string; data: unknown }[];
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
 * Sources -- and provisioning targets -- whose id appears in `failIds` reject,
 * to exercise the "one bad source does not stop the rest" path. Both kinds are
 * read out of the payload, because the provisioning queue carries a
 * `targetSystemId` where the sync queue carries a `sourceId`, and a fake that
 * only knew about one of them would make the target loop's failure path
 * untestable while looking exactly like a fake that covered it.
 */
export function createFakeScheduler(
  failIds: Set<string> = new Set(),
): FakeScheduler {
  const scheduled: ScheduleCall[] = [];
  const unscheduled: { name: string; key: string | undefined }[] = [];
  const registered: string[] = [];
  const enqueued: { name: string; data: unknown }[] = [];

  return {
    scheduled,
    unscheduled,
    registered,
    enqueued,
    register: (name) => {
      registered.push(name);
    },
    start: async () => {},
    stop: async () => {},
    enqueue: async (name, data) => {
      enqueued.push({ name, data });
      return null;
    },
    schedule: async (name, cron, data, key) => {
      const payload = data as
        | { sourceId?: string; targetSystemId?: string }
        | undefined;
      const failing = payload?.sourceId ?? payload?.targetSystemId;
      if (failing && failIds.has(failing)) {
        throw new Error(`schedule failed for ${failing}`);
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
 *
 * `mail` is the transport the app was built with, so a test can assert what
 * was sent. It is a memory transport rather than SMTP, which is what makes it
 * impossible for a test run to reach MailDev — or anything else — by accident.
 */
export async function buildTestApp(
  options: {
    scheduler?: () => Scheduler | null;
    /**
     * Rate limits and proxy trust, for the tests that are about them. Left
     * out, the app gets the defaults, which is what every other test wants —
     * a suite that quietly ran with limits of its own would not be testing
     * what ships.
     */
    env?: Record<string, string>;
  } = {},
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
    OUTBOUND_ALLOW_PRIVATE: 'true',
    // THE CHECKPOINT KEY, without which the signed path is untestable -- and
    // its absence is what hid the defect where `POST /govern/integrity/verify`
    // built no signer while the scheduler did. With no key, every checkpoint is
    // unsigned, `checkpointTrust` answers `unsigned` rather than `unknown_key`,
    // and the route and the job agree by accident. A constant, not random: a
    // signature the suite cannot reproduce across runs is not a fixture.
    GOVERN_CHECKPOINT_KEY: Buffer.alloc(32, 11).toString('base64'),
    ...options.env,
  });

  const mail = memoryTransport();
  const app = await buildApp(config, {
    logger: false,
    transport: mail,
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
  });
  return { app, tenantId: tenant.id, host: TEST_HOST, mail };
}
