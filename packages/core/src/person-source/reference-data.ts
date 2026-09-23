import type { TenantClient } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';
import { recordEvent } from '../audit/audit-service.js';

export const IDENTITY_REFERENCE_KINDS = ['department', 'location'] as const;
export type IdentityReferenceKind = (typeof IDENTITY_REFERENCE_KINDS)[number];

export const normalizeIdentityReference = (value: string) =>
  value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();

export function listIdentityReferenceValues(tx: TenantClient, kind?: IdentityReferenceKind) {
  return tx.identityReferenceValue.findMany({
    where: kind === undefined ? {} : { kind },
    orderBy: [{ kind: 'asc' }, { value: 'asc' }],
  });
}

export async function createIdentityReferenceValue(
  tx: TenantClient,
  actorUserId: string,
  input: { kind: IdentityReferenceKind; value: string },
) {
  const tenantId = await currentTenant(tx);
  const value = input.value.trim().replace(/\s+/g, ' ');
  const created = await tx.identityReferenceValue.create({
    data: {
      tenantId,
      kind: input.kind,
      value,
      normalizedValue: normalizeIdentityReference(value),
      createdByUserId: actorUserId,
    },
  });
  await recordEvent(tx, {
    actorUserId,
    action: 'identity_reference.create',
    targetType: 'identity_reference_value',
    targetId: created.id,
    outcome: 'success',
    sourceIp: null,
    payload: { kind: created.kind, value: created.value },
  });
  return created;
}

export async function setIdentityReferenceValueActive(
  tx: TenantClient,
  actorUserId: string,
  id: string,
  active: boolean,
) {
  const updated = await tx.identityReferenceValue.update({ where: { id }, data: { active } });
  await recordEvent(tx, {
    actorUserId,
    action: active ? 'identity_reference.enable' : 'identity_reference.disable',
    targetType: 'identity_reference_value',
    targetId: id,
    outcome: 'success',
    sourceIp: null,
    payload: { kind: updated.kind, value: updated.value },
  });
  return updated;
}
