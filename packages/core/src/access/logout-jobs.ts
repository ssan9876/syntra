import type { Scheduler } from '../jobs/scheduler.js';
import type { MasterKeyProvider } from '../vault/master-key.js';
import { runLogoutDeliveryJob } from './logout-delivery.js';

export const LOGOUT_DELIVER_JOB = 'access.logout_deliver';

export interface LogoutJobPayload {
  tenantId: string;
}

export function logoutJobPayload(tenantId: string): LogoutJobPayload {
  return { tenantId };
}

export function logoutScheduleKey(tenantId: string): string {
  // Slashes, not colons: pg-boss's `assertObjectName` refuses a colon and the
  // refusal is swallowed by the scheduler's caller. See
  // `jobs/schedule-key.test.ts`.
  return `logout/deliver/${tenantId}`;
}

export function registerLogoutJobs(
  scheduler: Scheduler,
  provider: MasterKeyProvider,
  options: { allowPrivateAddresses?: boolean; publicUrl?: string } = {},
): void {
  scheduler.register<LogoutJobPayload>(LOGOUT_DELIVER_JOB, async (payload) => {
    await runLogoutDeliveryJob(payload.tenantId, provider, {
      allowPrivateAddresses: options.allowPrivateAddresses ?? true,
      ...(options.publicUrl === undefined ? {} : { publicUrl: options.publicUrl }),
    });
  });
}

/**
 * Every minute, on the same cadence as the webhook sender and for the same
 * reason: the interval is the floor on how late a delivery can be, not a
 * policy anybody has an opinion about.
 *
 * A logout has a stronger claim on promptness than a webhook does — the gap
 * between "revoked here" and "revoked there" is the window this whole feature
 * exists to close — but a minute is already the tightest a cron schedule
 * offers, and the first attempt is queued due immediately, so an ordinary
 * logout goes out on the next tick rather than waiting a full interval.
 */
export async function applyLogoutSchedule(
  scheduler: Scheduler,
  tenantId: string,
): Promise<void> {
  await scheduler.schedule(
    LOGOUT_DELIVER_JOB,
    '* * * * *',
    logoutJobPayload(tenantId),
    logoutScheduleKey(tenantId),
  );
}
