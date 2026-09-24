import type { TenantClient } from '@syntra/db';

/**
 * Saved audit searches, private to the administrator who saved them.
 *
 * A view is FILTERS, never results. Opening one runs the search again under
 * the reader's authority at that moment, so a saved view cannot become a way
 * to keep seeing what somebody is no longer allowed to read -- and it cannot
 * go stale either, because it holds nothing that could.
 *
 * Not audited. Saving a search reads nothing and changes nothing anybody else
 * can see; the search it names is read through `GET /audit`, like any other.
 */

/** Enough for a working set; a list of hundreds is a list nobody picks from. */
export const MAX_SAVED_VIEWS_PER_USER = 50;

export class SavedViewLimitError extends Error {
  constructor() {
    super(`at most ${MAX_SAVED_VIEWS_PER_USER} saved searches per administrator`);
    this.name = 'SavedViewLimitError';
  }
}

export async function listSavedViews(tx: TenantClient, userId: string) {
  return tx.auditSavedView.findMany({
    where: { userId },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, filters: true, updatedAt: true },
  });
}

/**
 * Saves under a name, replacing a view of the same name -- "save" twice with
 * one name is one view that changed, not an error to recover from.
 */
export async function saveView(
  tx: TenantClient,
  tenantId: string,
  userId: string,
  name: string,
  filters: Record<string, unknown>,
) {
  const existing = await tx.auditSavedView.findFirst({ where: { userId, name }, select: { id: true } });
  if (existing === null) {
    const count = await tx.auditSavedView.count({ where: { userId } });
    if (count >= MAX_SAVED_VIEWS_PER_USER) throw new SavedViewLimitError();
  }
  return tx.auditSavedView.upsert({
    where: { tenantId_userId_name: { tenantId, userId, name } },
    create: { tenantId, userId, name, filters: filters as never },
    update: { filters: filters as never },
    select: { id: true, name: true, filters: true, updatedAt: true },
  });
}

/** True when a view of the caller's was deleted; somebody else's is not theirs to delete. */
export async function deleteSavedView(tx: TenantClient, userId: string, id: string): Promise<boolean> {
  const deleted = await tx.auditSavedView.deleteMany({ where: { id, userId } });
  return deleted.count === 1;
}
