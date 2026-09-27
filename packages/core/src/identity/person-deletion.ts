import type { TenantClient } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import { deactivateUser } from '../directory/user-service.js';

/**
 * HARD-DELETING A PERSON: the row and everything that references it, gone.
 *
 * Everything else in the person register deactivates. This is the exception,
 * behind `person.purge` -- which only the built-in Data deletion role carries
 * and only an Owner can assign.
 *
 * WHAT GOES. The database's foreign keys onto "Person" are the list:
 *
 *  - cascade, counted then left to the cascade: `Contract`,
 *    `AccountPlacement`, `PersonProvisionReceipt`, `PersonSourceLink`;
 *  - `LifecycleOperation` (ON DELETE SET NULL): deleted instead -- an
 *    operation about nobody is noise. Its steps, notifications and case events
 *    cascade from it;
 *  - `PersonDuplicateReview.candidatePersonId`, `ProvisionException`,
 *    `TargetAccount` (RESTRICT): deleted explicitly. A target account's
 *    entitlements and credential pickups cascade from it. The account in the
 *    target system itself is not touched;
 *  - `PrivacyCase` (RESTRICT): refused while one is open, deleted once closed.
 *
 * WHAT STAYS. Linked logins (`User.personId`, no foreign key): unlinked and
 * deactivated, sessions ended -- a login is not the person's to delete. The
 * audit log, which is immutable.
 *
 * The `person.purged` event carries the reason and the counts, never the
 * person's name or email: audit events outlive the person by design.
 *
 * ONE TRANSACTION: the caller's.
 */

export type PersonDeletionRefusalCode = 'not-found' | 'active' | 'open-privacy-case';

export class PersonDeletionRefusedError extends Error {
  constructor(
    readonly code: PersonDeletionRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = 'PersonDeletionRefusedError';
  }
}

export interface PersonDeletionCounts {
  contracts: number;
  placements: number;
  provisionReceipts: number;
  sourceLinks: number;
  lifecycleOperations: number;
  duplicateReviews: number;
  privacyCases: number;
  provisionExceptions: number;
  targetAccounts: number;
  usersUnlinked: number;
}

export interface HardDeletePersonInput {
  actorUserId: string;
  /** Why, in the administrator's words. Recorded on the audit event. */
  reason: string;
  sourceIp?: string | null | undefined;
}

export const PERSON_DELETION_REASON_MIN_LENGTH = 10;

/** `givenName familyName`: the name typed back to confirm a deletion. */
export function personFullName(person: { givenName: string; familyName: string }): string {
  return `${person.givenName} ${person.familyName}`;
}

export async function hardDeletePerson(
  tx: TenantClient,
  personId: string,
  input: HardDeletePersonInput,
): Promise<PersonDeletionCounts> {
  // Under RLS: another tenant's id and an id nobody holds are the same answer.
  const person = await tx.person.findUnique({
    where: { id: personId },
    select: { id: true, givenName: true, familyName: true, status: true },
  });
  if (!person) throw new PersonDeletionRefusedError('not-found', 'Person not found.');
  const name = personFullName(person);

  if (person.status === 'active') {
    throw new PersonDeletionRefusedError('active', `${name} is active. Deactivate them, then delete.`);
  }

  const openCase = await tx.privacyCase.findFirst({
    where: { personId, status: 'open' },
    select: { reference: true },
  });
  if (openCase) {
    throw new PersonDeletionRefusedError(
      'open-privacy-case',
      `${name} has open privacy case ${openCase.reference}. Close it, then delete.`,
    );
  }

  const where = { personId };
  const [contracts, placements, provisionReceipts, sourceLinks] = await Promise.all([
    tx.contract.count({ where }),
    tx.accountPlacement.count({ where }),
    tx.personProvisionReceipt.count({ where }),
    tx.personSourceLink.count({ where }),
  ]);

  const lifecycleOperations = (await tx.lifecycleOperation.deleteMany({ where })).count;
  const duplicateReviews = (
    await tx.personDuplicateReview.deleteMany({ where: { candidatePersonId: personId } })
  ).count;
  const privacyCases = (await tx.privacyCase.deleteMany({ where })).count;
  const provisionExceptions = (await tx.provisionException.deleteMany({ where })).count;
  const targetAccounts = (await tx.targetAccount.deleteMany({ where })).count;

  const users = await tx.user.findMany({ where, select: { id: true, status: true } });
  for (const user of users) {
    if (user.status === 'active') await deactivateUser(tx, user.id, 'Person deleted');
    await tx.user.update({ where: { id: user.id }, data: { personId: null } });
  }

  await tx.person.delete({ where: { id: personId } });

  const counts: PersonDeletionCounts = {
    contracts,
    placements,
    provisionReceipts,
    sourceLinks,
    lifecycleOperations,
    duplicateReviews,
    privacyCases,
    provisionExceptions,
    targetAccounts,
    usersUnlinked: users.length,
  };

  await recordEvent(tx, {
    actorUserId: input.actorUserId,
    action: 'person.purged',
    targetType: 'Person',
    targetId: personId,
    outcome: 'success',
    sourceIp: input.sourceIp ?? null,
    // Ids and numbers only, plus the reason. No name, no email.
    payload: { reason: input.reason, counts: { ...counts }, userIds: users.map((user) => user.id) },
  });

  return counts;
}
