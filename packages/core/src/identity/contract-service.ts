import type { TenantClient } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';
import { assertReferenceInTenant } from '../tenant-reference.js';

export interface CreateContractInput {
  sequence: number;
  isPrimary?: boolean | undefined;
  startDate: Date;
  endDate?: Date | undefined;
  jobTitle?: string | undefined;
  department?: string | undefined;
  costCentre?: string | undefined;
  employer?: string | undefined;
  location?: string | undefined;
  managerPersonId?: string | undefined;
  fte?: number | undefined;
}

export type ContractStrategy = 'primary' | 'lowestSequence';

/**
 * A contract is inclusive at both ends, so a one-day contract is valid but a
 * date range that ends before it starts is never a meaningful employment
 * record.  Keep this guard in the service as well as at the HTTP boundary:
 * CSV and future event sources call this layer directly.
 */
export function assertValidContractDates(startDate: Date, endDate?: Date | null): void {
  if (endDate !== null && endDate !== undefined && endDate < startDate) {
    throw new RangeError('contract endDate must be on or after startDate');
  }
}

export async function createContract(
  tx: TenantClient,
  personId: string,
  input: CreateContractInput,
) {
  const tenantId = await currentTenant(tx);
  assertValidContractDates(input.startDate, input.endDate);
  // A manager is another person IN THIS TENANT; the foreign key alone would
  // accept one from any tenant. See tenant-reference.ts.
  await assertReferenceInTenant(tx, 'person', input.managerPersonId, 'managerPersonId');
  return tx.contract.create({
    data: {
      tenantId,
      personId,
      sequence: input.sequence,
      isPrimary: input.isPrimary ?? false,
      startDate: input.startDate,
      endDate: input.endDate ?? null,
      jobTitle: input.jobTitle ?? null,
      department: input.department ?? null,
      costCentre: input.costCentre ?? null,
      employer: input.employer ?? null,
      location: input.location ?? null,
      managerPersonId: input.managerPersonId ?? null,
      fte: input.fte ?? null,
    },
  });
}

export async function listContracts(tx: TenantClient, personId: string) {
  return tx.contract.findMany({
    where: { personId },
    orderBy: { sequence: 'asc' },
  });
}

/**
 * Contracts in force on `on`: started on or before it, and either open-ended
 * or ending on or after it. Both boundaries are inclusive — a contract is
 * active on its first and last day.
 */
export async function activeContracts(
  tx: TenantClient,
  personId: string,
  on: Date = new Date(),
) {
  return tx.contract.findMany({
    where: {
      personId,
      startDate: { lte: on },
      OR: [{ endDate: null }, { endDate: { gte: on } }],
    },
    orderBy: { sequence: 'asc' },
  });
}

/**
 * The person's primary contract regardless of whether it is currently in
 * force. A uniqueness constraint guarantees there is at most one.
 */
export async function primaryContract(tx: TenantClient, personId: string) {
  return tx.contract.findFirst({ where: { personId, isPrimary: true } });
}

/**
 * Picks the contract that supplies attribute values for claims and policy
 * decisions. Returns null when no active contract matches, so callers omit
 * the value rather than emitting an empty one.
 */
export async function resolveContractForMapping(
  tx: TenantClient,
  personId: string,
  strategy: ContractStrategy,
  on: Date = new Date(),
) {
  const active = await activeContracts(tx, personId, on);
  if (active.length === 0) return null;

  if (strategy === 'primary') {
    return active.find((c) => c.isPrimary) ?? null;
  }
  // activeContracts is ordered by sequence, so the first is the lowest.
  return active[0] ?? null;
}
