import type { TenantClient } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';

export async function createOrgUnit(
  tx: TenantClient,
  name: string,
  parentId?: string,
) {
  const tenantId = await currentTenant(tx);
  return tx.orgUnit.create({
    data: { tenantId, name, parentId: parentId ?? null },
  });
}

export async function listOrgUnits(tx: TenantClient) {
  return tx.orgUnit.findMany({ orderBy: { name: 'asc' } });
}

export async function findOrgUnit(tx: TenantClient, id: string) {
  return tx.orgUnit.findUnique({ where: { id } });
}
