import type { TenantClient } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';

export interface CreatePersonInput {
  givenName: string;
  familyName: string;
  businessEmail?: string | undefined;
  personalEmail?: string | undefined;
  externalId?: string | undefined;
}

export async function createPerson(
  tx: TenantClient,
  input: CreatePersonInput,
) {
  const tenantId = await currentTenant(tx);
  return tx.person.create({
    data: {
      tenantId,
      givenName: input.givenName,
      familyName: input.familyName,
      businessEmail: input.businessEmail ?? null,
      personalEmail: input.personalEmail ?? null,
      externalId: input.externalId ?? null,
    },
  });
}

export async function listPersons(tx: TenantClient) {
  return tx.person.findMany({ orderBy: [{ familyName: 'asc' }, { givenName: 'asc' }] });
}

export async function findPerson(tx: TenantClient, id: string) {
  return tx.person.findUnique({ where: { id } });
}

/** One person may hold several accounts: an everyday login and an admin one. */
/**
 * Deactivates a person. Their USERS ARE LEFT ALONE, deliberately.
 *
 * A person and a login are different things — that separation is what this
 * product is built on — and cascading would make one button do two jobs with
 * only one of them named. A leaver's accounts are deactivated per account, by
 * whoever owns them, and the record of which accounts those were survives
 * either way.
 *
 * `Person` has no `statusReason` column, so the reason travels on the audit
 * event rather than the row. That is where a reader looks for "why, and who
 * decided" in any case.
 */
export async function deactivatePerson(tx: TenantClient, id: string) {
  return tx.person.update({ where: { id }, data: { status: 'inactive' } });
}

export async function reactivatePerson(tx: TenantClient, id: string) {
  return tx.person.update({ where: { id }, data: { status: 'active' } });
}

export async function linkUserToPerson(
  tx: TenantClient,
  userId: string,
  personId: string,
): Promise<void> {
  await tx.user.update({ where: { id: userId }, data: { personId } });
}

export async function unlinkUser(
  tx: TenantClient,
  userId: string,
): Promise<void> {
  await tx.user.update({ where: { id: userId }, data: { personId: null } });
}

export async function usersForPerson(tx: TenantClient, personId: string) {
  return tx.user.findMany({ where: { personId }, orderBy: { login: 'asc' } });
}

/** Null for a service account, which is ordinary rather than exceptional. */
export async function personForUser(tx: TenantClient, userId: string) {
  const user = await tx.user.findUnique({ where: { id: userId } });
  if (!user?.personId) return null;
  return tx.person.findUnique({ where: { id: user.personId } });
}
