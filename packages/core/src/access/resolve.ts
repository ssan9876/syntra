import type { TenantClient } from '@syntra/db';
import { listGroupsForUser } from '../directory/group-service.js';

/** A tree deep enough to hit this is a cycle, not an organization. */
const MAX_ORG_UNIT_DEPTH = 64;

/**
 * The org unit the user sits in, and every unit above it.
 *
 * An assignment made on Head Office reaches everyone under it; that is what
 * makes the tree worth having. It does not reach downwards: a grant to Care
 * does not follow the user up to Head Office.
 *
 * The depth cap and the seen-set are not paranoia — parentId is a self-relation
 * with no database-level acyclicity check, and a cycle introduced by a bad
 * import would otherwise hang every sign-in.
 */
async function orgUnitChain(tx: TenantClient, orgUnitId: string | null): Promise<string[]> {
  const chain: string[] = [];
  const seen = new Set<string>();
  let current = orgUnitId;

  for (let depth = 0; current && depth < MAX_ORG_UNIT_DEPTH; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    chain.push(current);
    const row = await tx.orgUnit.findUnique({
      where: { id: current },
      select: { parentId: true },
    });
    current = row?.parentId ?? null;
  }

  return chain;
}

/**
 * Every application the user resolves to, by any path.
 *
 * A union of three sets: assignments naming the user, assignments naming a
 * group they belong to, and assignments naming their org unit or one above it.
 * A retired application is excluded; a hidden one is not, because hidden means
 * "no tile", not "no access".
 */
export async function resolveApplicationIdsForUser(
  tx: TenantClient,
  userId: string,
): Promise<Set<string>> {
  const user = await tx.user.findUnique({
    where: { id: userId },
    select: { orgUnitId: true },
  });
  const groups = await listGroupsForUser(tx, userId);
  const orgUnitIds = await orgUnitChain(tx, user?.orgUnitId ?? null);

  const rows = await tx.appAssignment.findMany({
    where: {
      application: { status: 'active' },
      OR: [
        { userId },
        ...(groups.length > 0 ? [{ groupId: { in: groups.map((g) => g.id) } }] : []),
        ...(orgUnitIds.length > 0 ? [{ orgUnitId: { in: orgUnitIds } }] : []),
      ],
    },
    select: { applicationId: true },
  });

  return new Set(rows.map((row) => row.applicationId));
}

/** The tiles for the portal: resolved, visible, and ordered by name. */
export async function resolveApplicationsForUser(tx: TenantClient, userId: string) {
  const ids = await resolveApplicationIdsForUser(tx, userId);
  if (ids.size === 0) return [];

  return tx.application.findMany({
    where: { id: { in: [...ids] }, visibility: 'assigned' },
    orderBy: { name: 'asc' },
  });
}

export async function isApplicationAssigned(
  tx: TenantClient,
  userId: string,
  applicationId: string,
): Promise<boolean> {
  const ids = await resolveApplicationIdsForUser(tx, userId);
  return ids.has(applicationId);
}
