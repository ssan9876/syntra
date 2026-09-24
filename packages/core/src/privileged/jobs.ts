import type { Scheduler } from '../jobs/scheduler.js';
import { deliverMessage } from '../notify/delivery.js';
import { renderMessage, type Transport } from '../notify/notification-service.js';
import { activationNotices, sweepBreakGlass, type ActivationNotice } from './break-glass.js';
import { expirePrivilegedChanges } from './change-control.js';

/**
 * Mails every `tenant.manage` holder about a break-glass activation.
 *
 * Never throws: `deliverMessage` records a failed send as
 * `notify.delivery_failed`, which is itself the signal that this control
 * stopped working. The security event that the same transition recorded is
 * what reaches webhook receivers; this is the human channel beside it.
 */
export async function mailBreakGlassNotice(
  transport: Transport,
  tenantId: string,
  notice: ActivationNotice,
  kind: 'requested' | 'activated',
  log?: (error: unknown, purpose: string) => void,
): Promise<number> {
  let sent = 0;
  const { activation, account } = notice;
  for (const recipient of notice.recipients) {
    const message = renderMessage(notice.tenantName, kind === 'requested' ? 'break-glass-requested' : 'break-glass-activated', recipient.email, {
      displayName: recipient.displayName,
      accountName: account.displayName,
      login: account.login,
      reason: activation.reason,
      sourceIp: activation.requestedFromIp ?? 'an unknown address',
      activatesAt: activation.activatesAt.toISOString(),
      expiresAt: activation.expiresAt?.toISOString() ?? '',
      activatedBy: activation.activatedBy === 'approval' ? 'approved by a second administrator' : 'after the announced delay',
      durationMinutes: String(activation.durationMinutes),
    });
    if (await deliverMessage(transport, message, { tenantId, userId: recipient.userId, purpose: `break-glass-${kind}`, log })) sent += 1;
  }
  return sent;
}

export const PRIVILEGED_ACCESS_SWEEP_JOB = 'privileged.access_sweep';
export interface PrivilegedAccessSweepPayload { tenantId: string }

/**
 * The once-a-minute pass: pending change requests past their window close,
 * break-glass activations whose delay has passed take effect (and are
 * mailed), and active ones past their expiry end.
 *
 * Enforcement never waits for it -- `authorize()`, session liveness and every
 * decision route apply the clock themselves. What the sweep adds is the
 * events and mail that say a transition happened when nobody was looking.
 */
export async function runPrivilegedAccessSweep(tenantId: string, transport: Transport | null, now: Date = new Date()) {
  const expired = await expirePrivilegedChanges(tenantId, now);
  const activated = await sweepBreakGlass(tenantId, now);
  if (transport) {
    for (const notice of await activationNotices(tenantId, activated)) {
      await mailBreakGlassNotice(transport, tenantId, notice, 'activated');
    }
  }
  return { expired, activated: activated.length };
}

export function registerPrivilegedAccessJobs(scheduler: Scheduler, transport: Transport): void {
  scheduler.register<PrivilegedAccessSweepPayload>(PRIVILEGED_ACCESS_SWEEP_JOB, async ({ tenantId }) => {
    await runPrivilegedAccessSweep(tenantId, transport);
  });
}

export async function schedulePrivilegedAccessSweep(scheduler: Scheduler, tenantId: string): Promise<void> {
  await scheduler.schedule(PRIVILEGED_ACCESS_SWEEP_JOB, '* * * * *', { tenantId }, `privileged-access-sweep-${tenantId}`);
}
