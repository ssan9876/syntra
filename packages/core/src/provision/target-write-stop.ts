import { withTenant } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';

export class TargetWriteStopNotFoundError extends Error {}
export class TargetWriteStopStateError extends Error {}
export class TargetWriteStopSeparationError extends Error {}
export class ExternalWritesPausedError extends Error {
  constructor(readonly targetSystemId: string, readonly reason: string, readonly expiresAt: Date | null) {
    super(`external writes are paused for target ${targetSystemId}: ${reason}`);
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
