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

/**
 * Retire a unit without losing it.
 *
 * Deleting one takes the record of who was in it, silently drops every
 * application assignment made on it, and orphans any administrative role
 * scoped to it. Deactivating leaves all three standing and grants nothing —
 * `activeOrgUnitIds` and `hasPermission` are where that becomes true.
 *
 * CHILDREN ARE NOT TOUCHED, deliberately. Closing a department does not close
 * the ones beneath it, an assignment naming a child keeps granting, and
 * reactivating restores exactly the state that was there. A cascade would be a
 * second, larger decision hidden inside this one, and it could not be undone
 * by reactivating the parent — the children it swept up are indistinguishable
 * from the ones already inactive.
 */
export async function deactivateOrgUnit(
  tx: TenantClient,
  id: string,
  reason: string,
) {
  return tx.orgUnit.update({
    where: { id },
    data: { status: 'inactive', statusReason: reason },
  });
}

export async function reactivateOrgUnit(tx: TenantClient, id: string) {
  return tx.orgUnit.update({
    where: { id },
    data: { status: 'active', statusReason: null },
  });
}

/**
 * Whether moving `id` under `parentId` would make a loop.
 *
 * `parentId` is a self-relation with no database-level acyclicity check, so
 * nothing but this stops a unit becoming its own ancestor. A cycle does not
 * crash anything — `orgUnitChain` carries a depth cap and a seen-set for
 * exactly this reason — it does something worse: the units in the loop drop
 * out of the tree the console draws, and the assignments made on them stop
 * reaching anybody, with no error to say why.
 *
 * Walks UP from the proposed parent. If `id` is anywhere on that path, the
 * move would close the loop. A unit named as its own parent is the shortest
 * case of it and is caught by the same walk.
 */
export async function wouldCycle(
  tx: TenantClient,
  id: string,
  parentId: string,
): Promise<boolean> {
  let current: string | null = parentId;
  const seen = new Set<string>();
  while (current) {
    if (current === id) return true;
    // A loop that already exists further up must not hang this check.
    if (seen.has(current)) return false;
    seen.add(current);
    const row: { parentId: string | null } | null = await tx.orgUnit.findUnique({
      where: { id: current },
      select: { parentId: true },
    });
    current = row?.parentId ?? null;
  }
  return false;
}
