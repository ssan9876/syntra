import type { TenantClient } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';
import { assertReferenceInTenant } from '../tenant-reference.js';

export type AssignmentSubject =
  | { type: 'user'; id: string }
  | { type: 'group'; id: string }
  | { type: 'orgUnit'; id: string };

/**
 * Grants an application to one subject. Idempotent: the same grant twice is one
 * assignment.
 *
 * Not an upsert. Prisma cannot address a compound unique key holding a null,
 * and for good reason — SQL treats NULL as distinct from NULL, so a compound
 * constraint over the three nullable subject columns would not constrain
 * anything at all. Three partial unique indexes enforce it in the database;
 * this lookup keeps the call idempotent rather than throwing.
 */
export async function assignApplication(
  tx: TenantClient,
  applicationId: string,
  subject: AssignmentSubject,
): Promise<void> {
  const where = {
    applicationId,
    userId: subject.type === 'user' ? subject.id : null,
    groupId: subject.type === 'group' ? subject.id : null,
    orgUnitId: subject.type === 'orgUnit' ? subject.id : null,
  };

  const existing = await tx.appAssignment.findFirst({ where });
  if (existing) return;
  // The subject is looked up in THIS tenant before it is granted anything: the
  // foreign key would accept another tenant's user. See tenant-reference.ts.
  await assertReferenceInTenant(tx, subject.type, subject.id, 'id');

  const tenantId = await currentTenant(tx);
  await tx.appAssignment.create({
    data: { tenantId, subjectType: subject.type, ...where },
  });
}

/**
 * Removes one assignment OF THIS APPLICATION. Idempotent: an assignment that is
 * not there -- or that belongs to a different application than the one the
 * route names -- is removed by nobody, and the answer is the same.
 *
 * Scoped by the application as well as the id, which it was not: the
 * tenant-isolation probe called `DELETE /applications/<another app>/
 * assignments/<this app's assignment>` and it deleted the assignment while the
 * audit event recorded the other application as the target.
 */
export async function unassignApplication(
  tx: TenantClient,
  applicationId: string,
  assignmentId: string,
): Promise<number> {
  const { count } = await tx.appAssignment.deleteMany({ where: { id: assignmentId, applicationId } });
  return count;
}

export async function listAssignments(tx: TenantClient, applicationId: string) {
  return tx.appAssignment.findMany({
    where: { applicationId },
    orderBy: { createdAt: 'asc' },
  });
}
