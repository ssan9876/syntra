import type { TenantClient } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';

export interface CreatePersonInput {
  givenName: string;
  familyName: string;
  businessEmail?: string;
  personalEmail?: string;
  externalId?: string;
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
