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
/**
 * Deactivates a group. Its MEMBERSHIPS ARE LEFT IN PLACE.
 *
 * That is the whole reason this exists instead of a delete. A group is the
 * thing entitlements are granted to, so removing one silently revokes access
 * from everybody in it and destroys the record of who had what. A deactivated
 * group is still listed, still shows its members, and grants nothing — and it
 * can come back with its membership intact, which a deleted one cannot.
 *
 * Directory Sync already does exactly this when a group vanishes from the
 * source (`deactivate_group`), and the reasoning does not change because an
 * administrator pressed the button rather than a run.
 */
export async function deactivateGroup(
  tx: TenantClient,
  id: string,
  reason: string,
) {
  return tx.group.update({
    where: { id },
    data: { status: 'inactive', statusReason: reason },
  });
}

export async function reactivateGroup(tx: TenantClient, id: string) {
  return tx.group.update({
    where: { id },
    data: { status: 'active', statusReason: null },
  });
}

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

/**
 * Every group the user is in, ACTIVE OR NOT.
 *
 * This answers a question of fact — where does this account sit — and the
 * answer does not change when a group is deactivated. Callers that GRANT
 * something from group membership want `listActiveGroupsForUser` below; the
 * distinction is the whole of what deactivation means, so it is two functions
 * and not a flag somebody can forget to pass.
 */
export async function listGroupsForUser(tx: TenantClient, userId: string) {
  const rows = await tx.groupMembership.findMany({
    where: { userId },
    include: { group: true },
  });
  return rows.map((r) => r.group);
}

/**
 * The groups that may still hand the user something.
 *
 * A DEACTIVATED GROUP GRANTS NOTHING. That is the promise the console makes in
 * as many words — the toggle says so, the specs say "Deactivation never
 * deletes", and the reason it is deactivate rather than delete is that the
 * record of who had what has to survive the revocation.
 *
 * It was not true. Access resolution and protocol claims both read
 * `listGroupsForUser`, which does not look at status, so deactivating a group
 * left every application it granted still resolving and its name still
 * asserted into every token — a revocation that reported success and revoked
 * nothing.
 *
 * The membership rows are untouched: the group is still listed, still shows
 * its members, and reactivating it puts the access back exactly as it was.
 */
export async function listActiveGroupsForUser(tx: TenantClient, userId: string) {
  const rows = await tx.groupMembership.findMany({
    where: { userId, group: { status: 'active' } },
    include: { group: true },
  });
  return rows.map((r) => r.group);
}
