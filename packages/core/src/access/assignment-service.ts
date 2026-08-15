import type { TenantClient } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';

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

  const tenantId = await currentTenant(tx);
  await tx.appAssignment.create({
    data: { tenantId, subjectType: subject.type, ...where },
  });
}

export async function unassignApplication(
  tx: TenantClient,
  assignmentId: string,
): Promise<void> {
  await tx.appAssignment.deleteMany({ where: { id: assignmentId } });
}

export async function listAssignments(tx: TenantClient, applicationId: string) {
  return tx.appAssignment.findMany({
    where: { applicationId },
    orderBy: { createdAt: 'asc' },
  });
}
