import { describe, expect, it } from 'vitest';
import {
  ASSIGNABLE_CONTRACT_FIELDS,
  ASSIGNABLE_PERSON_FIELDS,
  isPersonMappingFailure,
  mapPersonRecord,
  unassignablePersonFields,
} from './mapping.js';

const rules = [
  { recordType: 'person' as const, sourceColumn: 'employeeId', targetField: 'externalId', transform: 'trim' as const, isCorrelation: true },
  { recordType: 'person' as const, sourceColumn: 'firstName', targetField: 'givenName', transform: 'trim' as const, isCorrelation: false },
  { recordType: 'contract' as const, sourceColumn: 'hireDate', targetField: 'startDate', transform: 'none' as const, isCorrelation: false },
  { recordType: 'contract' as const, sourceColumn: 'dept', targetField: 'department', transform: 'none' as const, isCorrelation: false },
];

function record(fields: Record<string, string>) {
  return { externalId: 'row-1', fields, contracts: [] };
}

describe('the assignable field lists', () => {
  /**
   * The single most important assertion in this file. A source column an
   * administrator can point anywhere must never reach `status`: mapping it
   * would be a way to deactivate a workforce by typo, the guard counts only
   * `depart_person`, and an `update_person` writing `status` would be a
   * straight bypass of it.
   */
  it('does not let a mapping write a person status', () => {
    expect(ASSIGNABLE_PERSON_FIELDS).not.toContain('status');
    expect(ASSIGNABLE_PERSON_FIELDS).not.toContain('statusReason');
    expect(unassignablePersonFields('person', ['status'])).toEqual(['status']);
  });

  /**
   * departureOverride means a human knew something the contract table did
   * not, and departureDate() prefers it over contract dates for that reason.
   * A file cannot know it.
   */
  it('does not let a mapping write the departure override', () => {
    expect(ASSIGNABLE_PERSON_FIELDS).not.toContain('departureOverride');
    expect(unassignablePersonFields('person', ['departureOverride'])).toEqual([
      'departureOverride',
    ]);
  });

  it('does not let a mapping write identity or ownership', () => {
    expect(unassignablePersonFields('person', ['id', 'tenantId', 'sourceId'])).toEqual([
      'id',
      'tenantId',
      'sourceId',
    ]);
  });

  /**
   * The anchor is set once at source creation. Remapping it re-anchors every
   * person the source owns, which is not a field edit.
   */
  it('does not let a mapping write the person external id as an ordinary field', () => {
    expect(ASSIGNABLE_PERSON_FIELDS).not.toContain('externalId');
  });

  it('lets a mapping write the contract external id, which is a contract key', () => {
    expect(ASSIGNABLE_CONTRACT_FIELDS).toContain('externalId');
    expect(unassignablePersonFields('contract', ['externalId'])).toEqual([]);
  });
});

describe('mapPersonRecord', () => {
  it('maps person fields and builds one contract from the same row', () => {
    const mapped = mapPersonRecord(
      record({ employeeId: ' 42 ', firstName: 'Ada', hireDate: '2026-01-05', dept: 'Research' }),
      rules,
    );
    if (isPersonMappingFailure(mapped)) throw new Error(mapped.reason);
    expect(mapped.externalId).toBe('42');
    expect(mapped.fields.givenName).toBe('Ada');
    expect(mapped.contracts).toHaveLength(1);
    expect(mapped.contracts[0]?.startDate).toEqual(new Date('2026-01-05T00:00:00Z'));
    expect(mapped.contracts[0]?.department).toBe('Research');
  });

  it('fails a record whose correlation column is empty', () => {
    const mapped = mapPersonRecord(record({ employeeId: '  ', firstName: 'Ada' }), rules);
    expect(isPersonMappingFailure(mapped)).toBe(true);
  });

  it('fails a record whose correlation column is absent entirely', () => {
    const mapped = mapPersonRecord(record({ firstName: 'Ada' }), rules);
    expect(isPersonMappingFailure(mapped)).toBe(true);
  });

  /**
   * Date.parse accepts 2026-02-30 and rolls it into March. A contract whose
   * start date silently moved a month is worse than one that failed.
   */
  it('fails a record whose start date is not a real day', () => {
    const mapped = mapPersonRecord(
      record({ employeeId: '42', hireDate: '2026-02-30' }),
      rules,
    );
    expect(isPersonMappingFailure(mapped)).toBe(true);
    if (isPersonMappingFailure(mapped)) expect(mapped.reason).toMatch(/2026-02-30/);
  });

  it('fails a record with no start date, since a contract needs one', () => {
    const mapped = mapPersonRecord(record({ employeeId: '42', firstName: 'Ada' }), rules);
    expect(isPersonMappingFailure(mapped)).toBe(true);
  });

  /**
   * A readFailure record is failed rather than mapped. The run counts it as
   * read and excludes it -- it is never absent, so a schema change at the
   * source cannot propose departing real people.
   */
  it('fails a record the connector could not read completely', () => {
    const mapped = mapPersonRecord(
      {
        externalId: 'row-1',
        fields: { employeeId: '42', hireDate: '2026-01-05' },
        contracts: [],
        readFailure: 'the row was truncated',
      },
      rules,
    );
    expect(isPersonMappingFailure(mapped)).toBe(true);
    if (isPersonMappingFailure(mapped)) expect(mapped.reason).toMatch(/truncated/);
  });

  it('names the person in a failure once the correlation value is known', () => {
    const mapped = mapPersonRecord(
      record({ employeeId: '42', hireDate: 'not-a-date' }),
      rules,
    );
    expect(isPersonMappingFailure(mapped)).toBe(true);
    if (isPersonMappingFailure(mapped)) expect(mapped.anchor).toBe('42');
  });

  it('lowercases where the rule says to', () => {
    const mapped = mapPersonRecord(
      record({ employeeId: '42', email: 'ADA@ACME.TEST', hireDate: '2026-01-05' }),
      [
        ...rules,
        { recordType: 'person' as const, sourceColumn: 'email', targetField: 'businessEmail', transform: 'lowercase' as const, isCorrelation: false },
      ],
    );
    if (isPersonMappingFailure(mapped)) throw new Error(mapped.reason);
    expect(mapped.fields.businessEmail).toBe('ada@acme.test');
  });

  it('reads an end date when the file carries one', () => {
    const mapped = mapPersonRecord(
      record({ employeeId: '42', hireDate: '2026-01-05', leaveDate: '2026-06-30' }),
      [
        ...rules,
        { recordType: 'contract' as const, sourceColumn: 'leaveDate', targetField: 'endDate', transform: 'none' as const, isCorrelation: false },
      ],
    );
    if (isPersonMappingFailure(mapped)) throw new Error(mapped.reason);
    expect(mapped.contracts[0]?.endDate).toEqual(new Date('2026-06-30T00:00:00Z'));
  });

  it('fails a record whose end date is not a real day', () => {
    const mapped = mapPersonRecord(
      record({ employeeId: '42', hireDate: '2026-01-05', leaveDate: '30-06-2026' }),
      [
        ...rules,
        { recordType: 'contract' as const, sourceColumn: 'leaveDate', targetField: 'endDate', transform: 'none' as const, isCorrelation: false },
      ],
    );
    expect(isPersonMappingFailure(mapped)).toBe(true);
  });

  it('fails a contract sequence that is not a whole number', () => {
    const mapped = mapPersonRecord(
      record({ employeeId: '42', hireDate: '2026-01-05', seq: 'first' }),
      [
        ...rules,
        { recordType: 'contract' as const, sourceColumn: 'seq', targetField: 'sequence', transform: 'none' as const, isCorrelation: false },
      ],
    );
    expect(isPersonMappingFailure(mapped)).toBe(true);
  });

  it('reads the truthy spellings a real export uses for a primary flag', () => {
    const primaryRules = [
      ...rules,
      { recordType: 'contract' as const, sourceColumn: 'main', targetField: 'isPrimary', transform: 'none' as const, isCorrelation: false },
    ];
    for (const value of ['true', 'TRUE', 'yes', 'Y', '1']) {
      const mapped = mapPersonRecord(
        record({ employeeId: '42', hireDate: '2026-01-05', main: value }),
        primaryRules,
      );
      if (isPersonMappingFailure(mapped)) throw new Error(mapped.reason);
      expect(mapped.contracts[0]?.isPrimary).toBe(true);
    }
    const no = mapPersonRecord(
      record({ employeeId: '42', hireDate: '2026-01-05', main: 'no' }),
      primaryRules,
    );
    if (isPersonMappingFailure(no)) throw new Error(no.reason);
    expect(no.contracts[0]?.isPrimary).toBe(false);
  });

  /**
   * Null, not false. "The file did not say" and "the file said no" are
   * different, and only the first lets the diff derive a primary contract.
   */
  it('leaves isPrimary unset when nothing is mapped onto it', () => {
    const mapped = mapPersonRecord(
      record({ employeeId: '42', hireDate: '2026-01-05' }),
      rules,
    );
    if (isPersonMappingFailure(mapped)) throw new Error(mapped.reason);
    expect(mapped.contracts[0]?.isPrimary).toBeNull();
  });

  it('ignores a column no rule names', () => {
    const mapped = mapPersonRecord(
      record({ employeeId: '42', hireDate: '2026-01-05', unmapped: 'ignored' }),
      rules,
    );
    if (isPersonMappingFailure(mapped)) throw new Error(mapped.reason);
    expect(mapped.fields).not.toHaveProperty('unmapped');
  });
});
