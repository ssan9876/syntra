import { withTenant, type TenantClient } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';

export class TargetWriteStopNotFoundError extends Error {}
export class TargetWriteStopStateError extends Error {}
export class TargetWriteStopSeparationError extends Error {}
/**
 * The refusal at the apply boundary, for either scope.
 *
 * One class rather than one per scope, because every caller that handles it
 * wants the same thing -- "nothing was written, and here is why" -- and a
 * second class is a second `instanceof` somebody forgets. `scope` says which
 * stop refused, so the console can point at the control that lifts it.
 */
export class ExternalWritesPausedError extends Error {
  constructor(
    readonly targetSystemId: string,
    readonly reason: string,
    readonly expiresAt: Date | null,
    readonly scope: 'target' | 'tenant' = 'target',
  ) {
    super(
      scope === 'tenant'
        ? `external writes are paused for every target in this tenant: ${reason}`
        : `external writes are paused for target ${targetSystemId}: ${reason}`,
    );
    this.name = 'ExternalWritesPausedError';
  }
}

export function externalWriteStopActive(
  target: { externalWritesPausedAt: Date | null; externalWritesPauseExpiresAt: Date | null },
  now: Date = new Date(),
): boolean {
  return target.externalWritesPausedAt !== null &&
    (target.externalWritesPauseExpiresAt === null || target.externalWritesPauseExpiresAt > now);
}

export async function pauseTargetExternalWrites(
  tenantId: string,
  targetSystemId: string,
  actorUserId: string,
  reason: string,
  expiresAt: Date | null,
  now: Date = new Date(),
) {
  if (expiresAt !== null && expiresAt <= now) throw new TargetWriteStopStateError('Pause expiry must be in the future');
  return withTenant(tenantId, async (tx) => {
    const target = await tx.targetSystem.findFirst({ where: { id: targetSystemId } });
    if (!target) throw new TargetWriteStopNotFoundError('Target not found');
    if (externalWriteStopActive(target, now)) throw new TargetWriteStopStateError('External writes are already paused');
    // A stop that lapsed and has not been swept yet is closed here, with its
    // own event, before the new one replaces it. Otherwise the expiry would
    // never be announced: the sweep only looks for stops that are still set.
    if (target.externalWritesPausedAt !== null) await recordTargetStopExpiry(tx, target);
    const updated = await tx.targetSystem.update({
      where: { id: targetSystemId },
      data: {
        externalWritesPausedAt: now,
        externalWritesPausedByUserId: actorUserId,
        externalWritesPauseReason: reason,
        externalWritesPauseExpiresAt: expiresAt,
        externalWritesResumedAt: null,
        externalWritesResumedByUserId: null,
      },
    });
    await recordEvent(tx, {
      actorUserId, action: 'provision.target.external_writes.pause', targetType: 'TargetSystem', targetId: targetSystemId,
      outcome: 'success', sourceIp: null, payload: { reason, expiresAt: expiresAt?.toISOString() ?? null },
    });
    return updated;
  });
}

export async function resumeTargetExternalWrites(
  tenantId: string,
  targetSystemId: string,
  actorUserId: string,
  reason: string,
  now: Date = new Date(),
) {
  return withTenant(tenantId, async (tx) => {
    const target = await tx.targetSystem.findFirst({ where: { id: targetSystemId } });
    if (!target) throw new TargetWriteStopNotFoundError('Target not found');
    if (!externalWriteStopActive(target, now)) throw new TargetWriteStopStateError('External writes are not paused');
    if (target.externalWritesPausedByUserId === actorUserId) {
      throw new TargetWriteStopSeparationError('A different administrator must resume external writes');
    }
    const updated = await tx.targetSystem.update({
      where: { id: targetSystemId },
      data: {
        externalWritesPausedAt: null,
        externalWritesPausedByUserId: null,
        externalWritesPauseReason: null,
        externalWritesPauseExpiresAt: null,
        externalWritesResumedAt: now,
        externalWritesResumedByUserId: actorUserId,
      },
    });
    await recordEvent(tx, {
      actorUserId, action: 'provision.target.external_writes.resume', targetType: 'TargetSystem', targetId: targetSystemId,
      outcome: 'success', sourceIp: null, payload: { reason, pausedAt: target.externalWritesPausedAt?.toISOString() ?? null },
    });
    return updated;
  });
}

/**
 * The audit event that closes a target stop which ran out on its own.
 *
 * `actorUserId` is null: nobody resumed it, the clock did, and naming the
 * administrator who placed it would claim a decision they did not make. The
 * event is a security event, so subscribed endpoints hear about it the same
 * way they heard about the stop.
 */
export async function recordTargetStopExpiry(
  tx: TenantClient,
  target: {
    id: string;
    externalWritesPausedAt: Date | null;
    externalWritesPausedByUserId: string | null;
    externalWritesPauseReason: string | null;
    externalWritesPauseExpiresAt: Date | null;
  },
): Promise<void> {
  await recordEvent(tx, {
    actorUserId: null, action: 'provision.target.external_writes.expire', targetType: 'TargetSystem', targetId: target.id,
    outcome: 'success', sourceIp: null,
    payload: {
      reason: target.externalWritesPauseReason,
      pausedAt: target.externalWritesPausedAt?.toISOString() ?? null,
      pausedByUserId: target.externalWritesPausedByUserId,
      expiresAt: target.externalWritesPauseExpiresAt?.toISOString() ?? null,
    },
  });
}
