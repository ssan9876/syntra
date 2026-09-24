import { withTenant } from '@syntra/db';
import type { Scheduler } from '../jobs/scheduler.js';
import { recordTargetStopExpiry } from './target-write-stop.js';
import { recordTenantStopExpiry } from './tenant-write-stop.js';

/**
 * Closes emergency stops whose expiry has passed, and says so.
 *
 * Enforcement never waits for this. `externalWriteStopActive` compares the
 * expiry against the clock at the apply boundary, so writes resume the moment
 * the expiry passes whether or not this job has run. What the job adds is the
 * part a predicate cannot do: an audit event (and, because it is a security
 * event, a webhook) saying the containment ended, and a row that no longer
 * looks paused to anybody reading the columns directly.
 *
 * Each close is a conditional update keyed on the `pausedAt` that was read, so
 * two sweeps racing -- or a sweep racing a manual resume or a new stop -- close
 * a stop at most once and never close a stop that replaced it.
 */
export async function expireExternalWriteStops(
  tenantId: string,
  now: Date = new Date(),
): Promise<{ targets: number; tenant: boolean }> {
  return withTenant(tenantId, async (tx) => {
    let targets = 0;
    const lapsed = await tx.targetSystem.findMany({
      where: { externalWritesPausedAt: { not: null }, externalWritesPauseExpiresAt: { lte: now } },
    });
    for (const target of lapsed) {
      const closed = await tx.targetSystem.updateMany({
        where: {
          id: target.id,
          externalWritesPausedAt: target.externalWritesPausedAt,
          externalWritesPauseExpiresAt: { lte: now },
        },
        data: {
          externalWritesPausedAt: null,
          externalWritesPausedByUserId: null,
          externalWritesPauseReason: null,
          externalWritesPauseExpiresAt: null,
          // When it actually ended, not when somebody noticed. Null resumer:
          // no administrator made this decision.
          externalWritesResumedAt: target.externalWritesPauseExpiresAt,
          externalWritesResumedByUserId: null,
        },
      });
      if (closed.count === 1) {
        await recordTargetStopExpiry(tx, target);
        targets += 1;
      }
    }

    let tenant = false;
    const stop = await tx.tenantExternalWriteStop.findFirst({
      where: { pausedAt: { not: null }, pauseExpiresAt: { lte: now } },
    });
    if (stop) {
      const closed = await tx.tenantExternalWriteStop.updateMany({
        where: { id: stop.id, pausedAt: stop.pausedAt, pauseExpiresAt: { lte: now } },
        data: {
          pausedAt: null,
          pausedByUserId: null,
          pauseReason: null,
          pauseExpiresAt: null,
          resumedAt: stop.pauseExpiresAt,
          resumedByUserId: null,
        },
      });
      if (closed.count === 1) {
        await recordTenantStopExpiry(tx, tenantId, stop);
        tenant = true;
      }
    }
    return { targets, tenant };
  });
}

export const WRITE_STOP_EXPIRY_JOB = 'provision.write_stop_expiry';
export interface WriteStopExpiryPayload { tenantId: string }

export function registerWriteStopJobs(scheduler: Scheduler): void {
  scheduler.register<WriteStopExpiryPayload>(WRITE_STOP_EXPIRY_JOB, async ({ tenantId }) => {
    await expireExternalWriteStops(tenantId);
  });
}

/**
 * Every minute. An expiry is a promise to an operator ("writes resume at
 * 14:00"), and the notification that it happened is only useful close to
 * when it did. The pass is one indexed read per tenant when nothing is paused.
 */
export async function scheduleWriteStopExpiry(scheduler: Scheduler, tenantId: string): Promise<void> {
  await scheduler.schedule(WRITE_STOP_EXPIRY_JOB, '* * * * *', { tenantId }, `write-stop-expiry-${tenantId}`);
}
