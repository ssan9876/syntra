import type { MappedContract, MappedPerson } from './mapping.js';
import type { FeedMode } from './source-service.js';

export type PersonChangeType =
  | 'create_person'
  | 'update_person'
  | 'depart_person'
  | 'reactivate_person'
  | 'create_contract'
  | 'update_contract'
  | 'end_contract';

export interface PersonProposedChange {
  changeType: PersonChangeType;
  recordType: 'person' | 'contract';
  targetId: string | null;
  externalId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  status: 'proposed';
  message?: string;
}

export interface ExistingContract {
  id: string;
  externalId: string | null;
  sequence: number;
  isPrimary: boolean;
  startDate: Date;
  endDate: Date | null;
  jobTitle: string | null;
  department: string | null;
  costCentre: string | null;
  employer: string | null;
  location: string | null;
  managerPersonId: string | null;
  fte: string | null;
}

export interface ExistingPerson {
  id: string;
  externalId: string;
  status: string;
  fields: Record<string, string>;
  contracts: ExistingContract[];
}

export interface PersonDiffInput {
  mapped: MappedPerson[];
  /** Only persons this source owns. A person it does not own is not its business. */
  existing: ExistingPerson[];
  feedMode: FeedMode;
  managerIdByExternalId: Map<string, string>;
}

const CONTRACT_SCALARS = [
  'jobTitle',
  'department',
  'costCentre',
  'employer',
  'location',
  'fte',
] as const;

function sameDay(a: Date | null, b: Date | null): boolean {
  if (a === null || b === null) return a === b;
  return a.getTime() === b.getTime();
}

/**
 * The key a contract is matched on.
 *
 * The HR system's employment id where the file carries one. Where it does not,
 * `sequence` -- which is a positional ordinal and therefore only safe while
 * the file's order is stable. The mapping screen warns about exactly this; the
 * fallback exists because a real file sometimes has nothing else.
 */
function contractKey(contract: {
  externalId: string | null;
  sequence: number | null;
}): string {
  return contract.externalId ?? `seq:${contract.sequence ?? 1}`;
}

/**
 * Which contract is the primary one, when the file does not say.
 *
 * The earliest-starting contract that has not ended, ties broken by key so two
 * runs over the same file cannot disagree. Never insertion order: that is not
 * a property of the file, it is a property of how it happened to be written.
 */
function derivePrimary(contracts: MappedContract[]): string | null {
  const active = contracts.filter((c) => c.endDate === null);
  const pool = active.length > 0 ? active : contracts;
  const sorted = [...pool].sort((a, b) => {
    const byDate = a.startDate.getTime() - b.startDate.getTime();
    return byDate !== 0 ? byDate : contractKey(a).localeCompare(contractKey(b));
  });
  return sorted.length === 0 ? null : contractKey(sorted[0] as MappedContract);
}

function resolveManager(
  contract: MappedContract,
  input: PersonDiffInput,
): { managerPersonId?: string; note?: string } {
  if (contract.managerExternalId === null) return {};
  const id = input.managerIdByExternalId.get(contract.managerExternalId);
  if (id === undefined) {
    // Ordinary on a first run and fixed by the next one. A note on the change,
    // not a failure -- and not a null write, which would clear a manager
    // somebody set by hand.
    return {
      note:
        `manager "${contract.managerExternalId}" is not in the register yet; ` +
        `the field is left as it is and the next run will resolve it`,
    };
  }
  return { managerPersonId: id };
}

function contractCreate(
  externalId: string,
  personId: string | null,
  contract: MappedContract,
  primaryKey: string | null,
  input: PersonDiffInput,
): PersonProposedChange {
  const manager = resolveManager(contract, input);
  const after: Record<string, unknown> = {
    externalId: contract.externalId,
    sequence: contract.sequence,
    isPrimary: contract.isPrimary ?? contractKey(contract) === primaryKey,
    startDate: contract.startDate,
    endDate: contract.endDate,
    // Carried so apply can find the person this contract belongs to. Stripped
    // before any write to the Contract row.
    personExternalId: externalId,
  };
  for (const field of CONTRACT_SCALARS) after[field] = contract[field];
  if (manager.managerPersonId !== undefined) after.managerPersonId = manager.managerPersonId;

  return {
    changeType: 'create_contract',
    recordType: 'contract',
    targetId: personId,
    externalId,
    before: null,
    after,
    status: 'proposed',
    ...(manager.note === undefined ? {} : { message: manager.note }),
  };
}

function contractUpdate(
  externalId: string,
  stored: ExistingContract,
  contract: MappedContract,
  primaryKey: string | null,
  input: PersonDiffInput,
): PersonProposedChange | null {
  const manager = resolveManager(contract, input);
  const after: Record<string, unknown> = {};

  for (const field of CONTRACT_SCALARS) {
    if (contract[field] !== stored[field]) after[field] = contract[field];
  }
  const isPrimary = contract.isPrimary ?? contractKey(contract) === primaryKey;
  if (isPrimary !== stored.isPrimary) after.isPrimary = isPrimary;
  if (!sameDay(contract.startDate, stored.startDate)) after.startDate = contract.startDate;
  if (
    manager.managerPersonId !== undefined &&
    manager.managerPersonId !== stored.managerPersonId
  ) {
    after.managerPersonId = manager.managerPersonId;
  }

  const before: Record<string, unknown> = {
    jobTitle: stored.jobTitle,
    department: stored.department,
    isPrimary: stored.isPrimary,
  };

  // An end date arriving is its own change type, so the guard can count it
  // against contracts rather than lumping it in with ordinary edits.
  if (!sameDay(contract.endDate, stored.endDate) && contract.endDate !== null) {
    return {
      changeType: 'end_contract',
      recordType: 'contract',
      targetId: stored.id,
      externalId,
      before: { endDate: stored.endDate },
      after: { ...after, endDate: contract.endDate },
      status: 'proposed',
      ...(manager.note === undefined ? {} : { message: manager.note }),
    };
  }

  // An end date being cleared is an ordinary update: the contract came back.
  if (!sameDay(contract.endDate, stored.endDate)) after.endDate = contract.endDate;

  if (Object.keys(after).length === 0 && manager.note === undefined) return null;

  return {
    changeType: 'update_contract',
    recordType: 'contract',
    targetId: stored.id,
    externalId,
    before,
    after,
    status: 'proposed',
    ...(manager.note === undefined ? {} : { message: manager.note }),
  };
}

export function diffPersons(input: PersonDiffInput): PersonProposedChange[] {
  const changes: PersonProposedChange[] = [];
  const existingByExternalId = new Map(input.existing.map((p) => [p.externalId, p]));
  const seen = new Set<string>();

  for (const person of input.mapped) {
    seen.add(person.externalId);
    const stored = existingByExternalId.get(person.externalId);
    const primaryKey = derivePrimary(person.contracts);

    if (stored === undefined) {
      changes.push({
        changeType: 'create_person',
        recordType: 'person',
        targetId: null,
        externalId: person.externalId,
        before: null,
        after: { ...person.fields },
        status: 'proposed',
      });
      for (const contract of person.contracts) {
        changes.push(contractCreate(person.externalId, null, contract, primaryKey, input));
      }
      continue;
    }

    // A person the file returned who is currently departed is coming back.
    // Reactivation is an ordinary reviewable change, not a silent side effect
    // of an update.
    if (stored.status !== 'active') {
      changes.push({
        changeType: 'reactivate_person',
        recordType: 'person',
        targetId: stored.id,
        externalId: person.externalId,
        before: { status: stored.status },
        after: { status: 'active' },
        status: 'proposed',
      });
    }

    const fieldDelta: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(person.fields)) {
      if (stored.fields[field] !== value) fieldDelta[field] = value;
    }
    if (Object.keys(fieldDelta).length > 0) {
      changes.push({
        changeType: 'update_person',
        recordType: 'person',
        targetId: stored.id,
        externalId: person.externalId,
        before: stored.fields,
        after: fieldDelta,
        status: 'proposed',
      });
    }

    const storedByKey = new Map(stored.contracts.map((c) => [contractKey(c), c]));
    for (const contract of person.contracts) {
      const storedContract = storedByKey.get(contractKey(contract));
      if (storedContract === undefined) {
        changes.push(
          contractCreate(person.externalId, stored.id, contract, primaryKey, input),
        );
        continue;
      }
      const change = contractUpdate(
        person.externalId,
        storedContract,
        contract,
        primaryKey,
        input,
      );
      if (change !== null) changes.push(change);
    }
  }

  // Absence.
  //
  // In delta mode this loop does not run at all: a delta file says nothing
  // about who it omits, and a `depart_person` that is produced and then
  // filtered is a safety property one refactor of the filter away from
  // vanishing.
  if (input.feedMode === 'snapshot') {
    for (const stored of input.existing) {
      if (seen.has(stored.externalId)) continue;
      if (stored.status !== 'active') continue;
      changes.push({
        changeType: 'depart_person',
        recordType: 'person',
        targetId: stored.id,
        externalId: stored.externalId,
        before: { status: stored.status },
        after: { status: 'inactive' },
        status: 'proposed',
        message: 'this person is not in the file',
      });
    }
  }

  return changes;
}
