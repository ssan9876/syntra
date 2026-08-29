import type { PersonSnapshotRecord } from '@syntra/connectors';

export type PersonRecordType = 'person' | 'contract';

export interface PersonMappingRule {
  recordType: PersonRecordType;
  sourceColumn: string;
  targetField: string;
  transform: 'none' | 'trim' | 'lowercase';
  isCorrelation: boolean;
}

/**
 * The fields a mapping may write on a Person.
 *
 * `status` and `statusReason` are absent, and that absence is the control.
 * `sync/mapping.ts` makes the argument for `User.status` and it holds harder
 * here: a source column an administrator can point at anything is a way to
 * deactivate a workforce by typo, the guard counts only `depart_person`, and
 * an `update_person` writing `status` would be a straight bypass of it.
 * Departure has exactly two legitimate sources -- a contract `endDate` and
 * `departureOverride` -- and neither is a mapping.
 *
 * `departureOverride` is absent for its own reason: it means a human knew
 * something the contract table did not, and `departureDate()` prefers it over
 * contract dates because of that. A file cannot know it.
 *
 * `id`, `tenantId` and `sourceId` are identity and ownership; a source that
 * could write them could adopt rows belonging to another source. `externalId`
 * is the anchor, fixed at source creation -- remapping it re-anchors every
 * person the source owns, which is not a field edit.
 */
export const ASSIGNABLE_PERSON_FIELDS: readonly string[] = [
  'givenName',
  'familyName',
  'nameConvention',
  'businessEmail',
  'personalEmail',
];

/**
 * `externalId` IS assignable here, unlike on a person: it is the HR system's
 * employment id, and it is the key a contract diff matches on.
 */
export const ASSIGNABLE_CONTRACT_FIELDS: readonly string[] = [
  'externalId',
  'sequence',
  'isPrimary',
  'startDate',
  'endDate',
  'jobTitle',
  'department',
  'costCentre',
  'employer',
  'location',
  'managerExternalId',
  'fte',
];

export function unassignablePersonFields(
  recordType: PersonRecordType,
  fields: Iterable<string>,
): string[] {
  const allowed =
    recordType === 'person' ? ASSIGNABLE_PERSON_FIELDS : ASSIGNABLE_CONTRACT_FIELDS;
  return [...fields].filter((field) => !allowed.includes(field));
}

export interface MappedContract {
  externalId: string | null;
  sequence: number | null;
  /**
   * Null when the file said nothing. Distinct from `false`, which is the file
   * saying no -- only the first lets the diff derive a primary contract.
   */
  isPrimary: boolean | null;
  startDate: Date;
  endDate: Date | null;
  jobTitle: string | null;
  department: string | null;
  costCentre: string | null;
  employer: string | null;
  location: string | null;
  managerExternalId: string | null;
  fte: string | null;
}

export interface MappedPerson {
  externalId: string;
  fields: Record<string, string>;
  contracts: MappedContract[];
}

export type PersonMappingFailure = {
  failed: true;
  anchor: string;
  reason: string;
};

export function isPersonMappingFailure(
  value: MappedPerson | PersonMappingFailure,
): value is PersonMappingFailure {
  return (value as PersonMappingFailure).failed === true;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Rejects malformed strings and impossible days alike.
 *
 * `Date.parse` accepts 2026-02-30 and rolls it forward into March, which would
 * put a contract's start date in the wrong month with no error anywhere -- the
 * same trap `identity/csv-import.ts` documents.
 */
function parseIsoDate(value: string): Date | null {
  if (!ISO_DATE.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  if (date.toISOString().slice(0, 10) !== value) return null;
  return date;
}

function applyTransform(value: string, transform: PersonMappingRule['transform']) {
  switch (transform) {
    case 'trim':
      return value.trim();
    case 'lowercase':
      return value.trim().toLowerCase();
    default:
      return value;
  }
}

/** The spellings a real HR export uses for a boolean. */
const TRUTHY = new Set(['true', 'yes', 'y', '1']);

function collect(
  record: PersonSnapshotRecord,
  rules: PersonMappingRule[],
  recordType: PersonRecordType,
): { values: Record<string, string>; correlation?: string } {
  const values: Record<string, string> = {};
  let correlation: string | undefined;

  for (const rule of rules.filter((r) => r.recordType === recordType)) {
    const raw = record.fields[rule.sourceColumn];
    if (raw === undefined) continue;
    const value = applyTransform(raw, rule.transform);
    // An empty cell is the file saying nothing, not the file saying "".
    // Writing "" would blank a name the directory already holds.
    if (value === '') continue;
    values[rule.targetField] = value;
    if (rule.isCorrelation) correlation = value;
  }

  return correlation === undefined ? { values } : { values, correlation };
}

/**
 * Turns one row into a person and their contract, or fails it by name.
 *
 * Failing is not dropping. Every failure here is counted by the run and
 * excluded from the diff, and the person it names is NOT treated as absent --
 * which is what stops a column rename at the HR vendor reading as a
 * redundancy.
 */
export function mapPersonRecord(
  record: PersonSnapshotRecord,
  rules: PersonMappingRule[],
): MappedPerson | PersonMappingFailure {
  if (record.readFailure !== undefined) {
    return {
      failed: true,
      anchor: record.externalId,
      reason: `the source could not be read completely for this person: ${record.readFailure}`,
    };
  }

  const person = collect(record, rules, 'person');
  if (person.correlation === undefined) {
    return {
      failed: true,
      anchor: record.externalId,
      reason: 'the correlation column is missing or empty in this row',
    };
  }

  const contract = collect(record, rules, 'contract');

  const rawStart = contract.values.startDate;
  if (rawStart === undefined) {
    return {
      failed: true,
      anchor: person.correlation,
      reason: 'no start date is mapped, and a contract cannot exist without one',
    };
  }
  const startDate = parseIsoDate(rawStart);
  if (startDate === null) {
    return {
      failed: true,
      anchor: person.correlation,
      reason: `"${rawStart}" is not a real date in YYYY-MM-DD form`,
    };
  }

  let endDate: Date | null = null;
  const rawEnd = contract.values.endDate;
  if (rawEnd !== undefined) {
    endDate = parseIsoDate(rawEnd);
    if (endDate === null) {
      return {
        failed: true,
        anchor: person.correlation,
        reason: `"${rawEnd}" is not a real date in YYYY-MM-DD form`,
      };
    }
  }

  const rawSequence = contract.values.sequence;
  const sequence = rawSequence === undefined ? null : Number(rawSequence);
  if (sequence !== null && !Number.isInteger(sequence)) {
    return {
      failed: true,
      anchor: person.correlation,
      reason: `"${rawSequence}" is not a whole number, so it cannot be a contract sequence`,
    };
  }

  const rawPrimary = contract.values.isPrimary;
  const isPrimary = rawPrimary === undefined ? null : TRUTHY.has(rawPrimary.toLowerCase());

  // The person's own fields, without the anchor: `externalId` is not an
  // assignable person field, and the correlation rule targets it only to name
  // which column the anchor comes from.
  const fields = { ...person.values };
  delete fields.externalId;

  return {
    externalId: person.correlation,
    fields,
    contracts: [
      {
        externalId: contract.values.externalId ?? null,
        sequence,
        isPrimary,
        startDate,
        endDate,
        jobTitle: contract.values.jobTitle ?? null,
        department: contract.values.department ?? null,
        costCentre: contract.values.costCentre ?? null,
        employer: contract.values.employer ?? null,
        location: contract.values.location ?? null,
        managerExternalId: contract.values.managerExternalId ?? null,
        fte: contract.values.fte ?? null,
      },
    ],
  };
}
