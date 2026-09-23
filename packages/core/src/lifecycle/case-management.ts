import { withTenant } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';

export const lifecycleResolutionCodes = [
  'recovered',
  'manually_verified',
  'configuration_corrected',
  'accepted_risk',
  'duplicate',
  'cancelled',
] as const;
export type LifecycleResolutionCode = (typeof lifecycleResolutionCodes)[number];

export class LifecycleCaseStateError extends Error {}

export async function addLifecycleCaseNote(
  tenantId: string,
  operationId: string,
  actorUserId: string,
  message: string,
) {
  return withTenant(tenantId, async (tx) => {
    await tx.lifecycleOperation.findFirstOrThrow({ where: { id: operationId } });
    const event = await tx.lifecycleCaseEvent.create({
      data: { tenantId, operationId, kind: 'note', actorUserId, message },
    });
    await recordEvent(tx, {
      actorUserId,
      action: 'lifecycle.case.note',
      targetType: 'lifecycle_operation',
      targetId: operationId,
      outcome: 'success',
      sourceIp: null,
      payload: { caseEventId: event.id },
    });
    return event;
  });
}

export async function resolveLifecycleCase(
  tenantId: string,
  operationId: string,
  actorUserId: string,
  code: LifecycleResolutionCode,
  summary: string,
) {
  return withTenant(tenantId, async (tx) => {
    const operation = await tx.lifecycleOperation.findFirstOrThrow({ where: { id: operationId } });
    if (operation.caseStatus === 'resolved') throw new LifecycleCaseStateError('Lifecycle case is already resolved');
    const now = new Date();
    const updated = await tx.lifecycleOperation.update({
      where: { id: operationId },
      data: { caseStatus: 'resolved', resolvedAt: now, resolvedByUserId: actorUserId, resolutionCode: code, resolutionSummary: summary },
    });
    const event = await tx.lifecycleCaseEvent.create({
      data: { tenantId, operationId, kind: 'resolution', actorUserId, message: summary, metadata: { code } },
    });
    await recordEvent(tx, {
      actorUserId,
      action: 'lifecycle.case.resolve',
      targetType: 'lifecycle_operation',
      targetId: operationId,
      outcome: 'success',
      sourceIp: null,
      payload: { code, caseEventId: event.id },
    });
    return { operation: updated, event };
  });
}

export async function reopenLifecycleCase(
  tenantId: string,
  operationId: string,
  actorUserId: string,
  reason: string,
) {
  return withTenant(tenantId, async (tx) => {
    const operation = await tx.lifecycleOperation.findFirstOrThrow({ where: { id: operationId } });
    if (operation.caseStatus !== 'resolved') throw new LifecycleCaseStateError('Lifecycle case is already open');
    const updated = await tx.lifecycleOperation.update({
      where: { id: operationId },
      data: { caseStatus: 'open', resolvedAt: null, resolvedByUserId: null, resolutionCode: null, resolutionSummary: null },
    });
    const event = await tx.lifecycleCaseEvent.create({
      data: { tenantId, operationId, kind: 'reopened', actorUserId, message: reason },
    });
    await recordEvent(tx, {
      actorUserId,
      action: 'lifecycle.case.reopen',
      targetType: 'lifecycle_operation',
      targetId: operationId,
      outcome: 'success',
      sourceIp: null,
      payload: { caseEventId: event.id },
    });
    return { operation: updated, event };
  });
}
