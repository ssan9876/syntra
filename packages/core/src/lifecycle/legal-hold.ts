import { withTenant } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';

/**
 * `person` holds everything about one person: a data-subject erasure is
 * refused while one is active, and the retention job keeps the person's
 * lifecycle evidence as it keeps a held operation's.
 */
export type LegalHoldSubjectType = 'lifecycle_operation' | 'lifecycle_simulation' | 'person';

export async function placeLifecycleLegalHold(
  tenantId: string,
  input: { subjectType: LegalHoldSubjectType; subjectId: string; reference: string; reason: string; actorUserId: string | null },
) {
  return withTenant(tenantId, async (tx) => {
    const subjectExists = input.subjectType === 'lifecycle_operation'
      ? await tx.lifecycleOperation.count({ where: { id: input.subjectId } })
      : input.subjectType === 'person'
        ? await tx.person.count({ where: { id: input.subjectId } })
        : await tx.lifecycleSimulation.count({ where: { id: input.subjectId } });
    if (subjectExists === 0) throw new Error('Legal-hold subject not found');
    const existing = await tx.lifecycleLegalHold.findFirst({
      where: { subjectType: input.subjectType, subjectId: input.subjectId, reference: input.reference, releasedAt: null },
    });
    if (existing) return existing;
    const hold = await tx.lifecycleLegalHold.create({
      data: { tenantId, subjectType: input.subjectType, subjectId: input.subjectId, reference: input.reference, reason: input.reason, placedByUserId: input.actorUserId },
    });
    await recordEvent(tx, {
      actorUserId: input.actorUserId, action: 'lifecycle.legalHold.place', targetType: input.subjectType,
      targetId: input.subjectId, outcome: 'success', sourceIp: null, payload: { holdId: hold.id, reference: input.reference, reason: input.reason },
    });
    return hold;
  });
}

export async function listLifecycleLegalHolds(
  tenantId: string,
  options: { activeOnly?: boolean; subjectType?: LegalHoldSubjectType; subjectId?: string } = {},
) {
  return withTenant(tenantId, (tx) => tx.lifecycleLegalHold.findMany({
    where: {
      ...(options.activeOnly ? { releasedAt: null } : {}),
      ...(options.subjectType ? { subjectType: options.subjectType } : {}),
      ...(options.subjectId ? { subjectId: options.subjectId } : {}),
    },
    orderBy: [{ placedAt: 'desc' }, { id: 'asc' }],
  }));
}

export async function releaseLifecycleLegalHold(tenantId: string, holdId: string, actorUserId: string | null) {
  return withTenant(tenantId, async (tx) => {
    const hold = await tx.lifecycleLegalHold.findFirstOrThrow({ where: { id: holdId, releasedAt: null } });
    const released = await tx.lifecycleLegalHold.update({ where: { id: hold.id }, data: { releasedAt: new Date(), releasedByUserId: actorUserId } });
    await recordEvent(tx, {
      actorUserId, action: 'lifecycle.legalHold.release', targetType: hold.subjectType, targetId: hold.subjectId,
      outcome: 'success', sourceIp: null, payload: { holdId: hold.id, reference: hold.reference },
    });
    return released;
  });
}

export async function activeLifecycleHoldSubjectIds(tenantId: string, subjectType: LegalHoldSubjectType): Promise<string[]> {
  return withTenant(tenantId, async (tx) =>
    (await tx.lifecycleLegalHold.findMany({ where: { subjectType, releasedAt: null }, select: { subjectId: true } })).map((hold) => hold.subjectId),
  );
}
