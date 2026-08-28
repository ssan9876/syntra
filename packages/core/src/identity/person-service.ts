import type { TenantClient } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';

export interface CreatePersonInput {
  givenName: string;
  familyName: string;
  businessEmail?: string | undefined;
  personalEmail?: string | undefined;
  externalId?: string | undefined;
  /**
   * Where this person sits, which is what the placement ladder reads to decide
   * the container their account is created in on each target.
   *
   * Distinct from `User.orgUnitId`, which feeds access resolution. A person
   * routinely has no User at all in a Syntra-front-door deployment, so
   * placement hangs off the person or it does not apply to most of the
   * population it exists for.
   */
  orgUnitId?: string | undefined;
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
      orgUnitId: input.orgUnitId ?? null,
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

export interface UpdateContractInput {
  isPrimary?: boolean | undefined;
  startDate?: Date | undefined;
  endDate?: Date | null | undefined;
  jobTitle?: string | null | undefined;
  department?: string | null | undefined;
  costCentre?: string | null | undefined;
  employer?: string | null | undefined;
  location?: string | null | undefined;
  managerPersonId?: string | null | undefined;
  fte?: number | null | undefined;
}

/**
 * Correcting a contract in place.
 *
 * The alternative — and what the console forced until now — was adding a
 * second contract at a new sequence, which does not say "that department was a
 * typo". It says "they took a second job", and `desiredState` reads it that
 * way: a person with two contracts in force has two sets of derived access.
 *
 * Promoting to primary demotes the incumbent in the same transaction, the same
 * rule the create path applies. Two primary contracts would make
 * `resolveContractForMapping` return whichever the planner happened to reach
 * first, which is a claim mapping that changes on its own between runs.
 *
 * Returns null when this person holds no contract at that sequence, so the
 * caller decides what a 404 is.
 */
export async function updateContract(
  tx: TenantClient,
  personId: string,
  sequence: number,
  data: UpdateContractInput,
) {
  const existing = await tx.contract.findFirst({ where: { personId, sequence } });
  if (!existing) return null;

  if (data.isPrimary === true) {
    await tx.contract.updateMany({
      where: { personId, isPrimary: true, sequence: { not: sequence } },
      data: { isPrimary: false },
    });
  }

  return tx.contract.update({
    where: { id: existing.id },
    // Spread key by key rather than passing `data` whole. An omitted field
    // must leave the column alone while an explicit null must clear it, and
    // those are two different requests that a single spread would collapse
    // into one.
    data: {
      ...(data.isPrimary === undefined ? {} : { isPrimary: data.isPrimary }),
      ...(data.startDate === undefined ? {} : { startDate: data.startDate }),
      ...(data.endDate === undefined ? {} : { endDate: data.endDate }),
      ...(data.jobTitle === undefined ? {} : { jobTitle: data.jobTitle }),
      ...(data.department === undefined ? {} : { department: data.department }),
      ...(data.costCentre === undefined ? {} : { costCentre: data.costCentre }),
      ...(data.employer === undefined ? {} : { employer: data.employer }),
      ...(data.location === undefined ? {} : { location: data.location }),
      ...(data.managerPersonId === undefined
        ? {}
        : { managerPersonId: data.managerPersonId }),
      ...(data.fte === undefined ? {} : { fte: data.fte }),
    },
  });
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
