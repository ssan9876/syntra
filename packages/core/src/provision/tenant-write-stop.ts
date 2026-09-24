import { withTenant, type TenantClient } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import { ExternalWritesPausedError, externalWriteStopActive } from './target-write-stop.js';

/**
 * The tenant-wide external-write circuit breaker.
 *
 * The per-target stop (`target-write-stop.ts`) contains one misbehaving
 * connector. This one is for the incident where the question is not WHICH
 * target is wrong -- a compromised administrator, a bad HR feed about to turn
 * into a thousand disables, a rule change nobody can yet explain -- and the
 * only safe answer is "nothing leaves this tenant until somebody has looked".
 *
 * The semantics are the per-target ones, deliberately, so an operator who has
 * learnt one knows the other:
 *
 *   - placing a stop needs a reason and may carry a bounded expiry;
 *   - while active, `applyProvisionRun` refuses before a run enters
 *     `applying`, for every target, so no connector write is attempted;
 *     previews, reads and evidence keep working, which is what the people
 *     investigating need;
 *   - lifting it early needs a DIFFERENT administrator, so the person whose
 *     judgement (or session) is in question cannot undo the containment alone;
 *   - an expiry is honoured at the boundary the moment it passes, and the
 *     sweep in `write-stop-expiry.ts` closes the row and announces it.
 *
 * Every transition is a security event, so the webhook fan-out in
 * `recordEvent` notifies subscribed endpoints without a second mechanism.
 */

export class TenantWriteStopStateError extends Error {}
export class TenantWriteStopSeparationError extends Error {}

type StopRow = {
  pausedAt: Date | null;
  pausedByUserId: string | null;
  pauseReason: string | null;
  pauseExpiresAt: Date | null;
};

export function tenantWriteStopActive(stop: StopRow | null, now: Date = new Date()): boolean {
  if (!stop) return false;
  // Expressed through the target predicate so the two scopes cannot drift into
  // different definitions of "active" -- in particular of what an expiry that
  // equals `now` means.
  return externalWriteStopActive(
    { externalWritesPausedAt: stop.pausedAt, externalWritesPauseExpiresAt: stop.pauseExpiresAt },
    now,
  );
}

/**
 * The single guard every connector-write path calls before it writes.
 *
 * The tenant stop is checked FIRST: when both are active, the broader one is
 * the one that has to be lifted before anything moves, so it is the one the
 * refusal names.
 */
export async function assertExternalWritesAllowed(
  tx: TenantClient,
  target: {
    id: string;
    externalWritesPausedAt: Date | null;
    externalWritesPauseReason: string | null;
    externalWritesPauseExpiresAt: Date | null;
  },
  now: Date = new Date(),
): Promise<void> {
  const tenantStop = await tx.tenantExternalWriteStop.findFirst();
  if (tenantStop && tenantWriteStopActive(tenantStop, now)) {
    throw new ExternalWritesPausedError(
      target.id,
      tenantStop.pauseReason ?? 'tenant emergency stop',
      tenantStop.pauseExpiresAt,
      'tenant',
    );
  }
  if (externalWriteStopActive(target, now)) {
    throw new ExternalWritesPausedError(
      target.id,
      target.externalWritesPauseReason ?? 'emergency stop',
      target.externalWritesPauseExpiresAt,
    );
  }
}

/** The stop as the console shows it, including a resume that already happened. */
export async function tenantExternalWriteStop(tenantId: string, now: Date = new Date()) {
  const row = await withTenant(tenantId, (tx) => tx.tenantExternalWriteStop.findFirst());
  return presentStop(row, now);
}

function presentStop(
  row: (StopRow & { resumedAt: Date | null; resumedByUserId: string | null }) | null,
  now: Date,
) {
  return {
    active: tenantWriteStopActive(row, now),
    pausedAt: row?.pausedAt ?? null,
    pausedByUserId: row?.pausedByUserId ?? null,
    pauseReason: row?.pauseReason ?? null,
    pauseExpiresAt: row?.pauseExpiresAt ?? null,
    resumedAt: row?.resumedAt ?? null,
    resumedByUserId: row?.resumedByUserId ?? null,
  };
}

export async function pauseTenantExternalWrites(
  tenantId: string,
  actorUserId: string,
  reason: string,
  expiresAt: Date | null,
  now: Date = new Date(),
) {
  if (expiresAt !== null && expiresAt <= now) throw new TenantWriteStopStateError('Pause expiry must be in the future');
  return withTenant(tenantId, async (tx) => {
    const existing = await tx.tenantExternalWriteStop.findFirst();
    if (tenantWriteStopActive(existing, now)) throw new TenantWriteStopStateError('External writes are already paused for this tenant');
    // Same reasoning as the target stop: a lapsed stop the sweep has not closed
    // yet gets its expiry announced before the new stop replaces it.
    if (existing && existing.pausedAt !== null) await recordTenantStopExpiry(tx, tenantId, existing);
    const data = {
      pausedAt: now,
      pausedByUserId: actorUserId,
      pauseReason: reason,
      pauseExpiresAt: expiresAt,
      resumedAt: null,
      resumedByUserId: null,
    };
    const updated = await tx.tenantExternalWriteStop.upsert({
      where: { tenantId },
      create: { tenantId, ...data },
      update: data,
    });
    await recordEvent(tx, {
      actorUserId, action: 'provision.tenant.external_writes.pause', targetType: 'Tenant', targetId: tenantId,
      outcome: 'success', sourceIp: null, payload: { reason, expiresAt: expiresAt?.toISOString() ?? null },
    });
    return presentStop(updated, now);
  });
}

export async function resumeTenantExternalWrites(
  tenantId: string,
  actorUserId: string,
  reason: string,
  now: Date = new Date(),
) {
  return withTenant(tenantId, async (tx) => {
    const existing = await tx.tenantExternalWriteStop.findFirst();
    if (!existing || !tenantWriteStopActive(existing, now)) {
      throw new TenantWriteStopStateError('External writes are not paused for this tenant');
    }
    if (existing.pausedByUserId === actorUserId) {
      throw new TenantWriteStopSeparationError('A different administrator must resume external writes');
    }
    const updated = await tx.tenantExternalWriteStop.update({
      where: { tenantId },
      data: {
        pausedAt: null,
        pausedByUserId: null,
        pauseReason: null,
        pauseExpiresAt: null,
        resumedAt: now,
        resumedByUserId: actorUserId,
      },
    });
    await recordEvent(tx, {
      actorUserId, action: 'provision.tenant.external_writes.resume', targetType: 'Tenant', targetId: tenantId,
      outcome: 'success', sourceIp: null,
      payload: { reason, pausedAt: existing.pausedAt?.toISOString() ?? null, pausedByUserId: existing.pausedByUserId },
    });
    return presentStop(updated, now);
  });
}

/** See `recordTargetStopExpiry`: the clock resumed it, so there is no actor. */
export async function recordTenantStopExpiry(tx: TenantClient, tenantId: string, stop: StopRow): Promise<void> {
  await recordEvent(tx, {
    actorUserId: null, action: 'provision.tenant.external_writes.expire', targetType: 'Tenant', targetId: tenantId,
    outcome: 'success', sourceIp: null,
    payload: {
      reason: stop.pauseReason,
      pausedAt: stop.pausedAt?.toISOString() ?? null,
      pausedByUserId: stop.pausedByUserId,
      expiresAt: stop.pauseExpiresAt?.toISOString() ?? null,
    },
  });
}
