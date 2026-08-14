import type { TenantClient } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';

export async function createGroup(
  tx: TenantClient,
  name: string,
  description?: string,
) {
  const tenantId = await currentTenant(tx);
  return tx.group.create({
    data: { tenantId, name, description: description ?? null },
  });
}

export async function listGroups(tx: TenantClient) {
  return tx.group.findMany({ orderBy: { name: 'asc' } });
}

/** Idempotent: adding an existing member is a no-op, not an error. */
export async function addMember(
  tx: TenantClient,
  groupId: string,
  userId: string,
): Promise<void> {
  const tenantId = await currentTenant(tx);
  await tx.groupMembership.upsert({
    where: { groupId_userId: { groupId, userId } },
    create: { tenantId, groupId, userId },
    update: {},
  });
}

export async function removeMember(
  tx: TenantClient,
  groupId: string,
  userId: string,
): Promise<void> {
  await tx.groupMembership.deleteMany({ where: { groupId, userId } });
}

export async function listMembers(tx: TenantClient, groupId: string) {
  const rows = await tx.groupMembership.findMany({
    where: { groupId },
    include: { user: true },
  });
  return rows.map((r) => r.user);
}

export async function listGroupsForUser(tx: TenantClient, userId: string) {
  const rows = await tx.groupMembership.findMany({
    where: { userId },
    include: { group: true },
  });
  return rows.map((r) => r.group);
}
