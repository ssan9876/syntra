import { describe, expect, it } from 'vitest';
import { diffPersons, type ExistingSourcePerson, type PersonDiffInput } from './diff.js';
import type { MappedPerson } from './mapping.js';

const start = new Date('2026-01-05T00:00:00Z');

function mapped(externalId: string, over: Partial<MappedPerson> = {}): MappedPerson {
  return {
    externalId,
    fields: { givenName: 'Ada', familyName: 'Lovelace' },
    contracts: [
      {
        externalId: `c-${externalId}`,
        sequence: null,
        isPrimary: null,
        startDate: start,
        endDate: null,
        jobTitle: 'Analyst',
        department: 'Research',
        costCentre: null,
        employer: null,
        location: null,
        managerExternalId: null,
        fte: null,
      },
    ],
    ...over,
  };
}

function existing(externalId: string, over: Partial<ExistingSourcePerson> = {}): ExistingSourcePerson {
  return {
    id: `p-${externalId}`,
    externalId,
    status: 'active',
    fields: { givenName: 'Ada', familyName: 'Lovelace' },
    contracts: [
      {
        id: `k-${externalId}`,
        externalId: `c-${externalId}`,
        sequence: 1,
        isPrimary: true,
        startDate: start,
        endDate: null,
        jobTitle: 'Analyst',
        department: 'Research',
        costCentre: null,
        employer: null,
        location: null,
        managerPersonId: null,
        fte: null,
      },
    ],
    ...over,
  };
}

function input(over: Partial<PersonDiffInput> = {}): PersonDiffInput {
  return {
    mapped: [],
    existing: [],
    feedMode: 'snapshot',
    managerIdByExternalId: new Map(),
    excludedExternalIds: new Set<string>(),
    absenceReliable: true,
    ...over,
  };
}

describe('diffPersons', () => {
  it('proposes nothing when the file matches what is stored', () => {
    const changes = diffPersons(input({ mapped: [mapped('1')], existing: [existing('1')] }));
    expect(changes).toEqual([]);
  });

  it('creates a person and their contract when both are new', () => {
    const changes = diffPersons(input({ mapped: [mapped('1')] }));
    expect(changes.map((c) => c.changeType)).toEqual(['create_person', 'create_contract']);
    expect(changes[0]?.externalId).toBe('1');
  });

  it('updates only the person fields that differ', () => {
    const changes = diffPersons(
      input({
        mapped: [mapped('1', { fields: { givenName: 'Augusta', familyName: 'Lovelace' } })],
        existing: [existing('1')],
      }),
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]?.changeType).toBe('update_person');
    expect(changes[0]?.after).toEqual({ givenName: 'Augusta' });
  });

  it('updates a contract that changed department', () => {
    const record = mapped('1');
    record.contracts[0]!.department = 'Engineering';
    const changes = diffPersons(input({ mapped: [record], existing: [existing('1')] }));
    expect(changes).toHaveLength(1);
    expect(changes[0]?.changeType).toBe('update_contract');
    expect(changes[0]?.after).toEqual({ department: 'Engineering' });
  });

  it('ends a contract the file now gives an end date', () => {
    const record = mapped('1');
    record.contracts[0]!.endDate = new Date('2026-06-30T00:00:00Z');
    const changes = diffPersons(input({ mapped: [record], existing: [existing('1')] }));
    expect(changes.map((c) => c.changeType)).toEqual(['end_contract']);
  });

  /**
   * Clearing an end date is an ordinary update, not an end_contract. The
   * contract came back; the guard must not count that against contracts.
   */
  it('treats a cleared end date as an ordinary update', () => {
    const stored = existing('1');
    stored.contracts[0]!.endDate = new Date('2026-06-30T00:00:00Z');
    const changes = diffPersons(input({ mapped: [mapped('1')], existing: [stored] }));
    expect(changes.map((c) => c.changeType)).toEqual(['update_contract']);
    expect(changes[0]?.after).toMatchObject({ endDate: null });
  });

  /** The rule the whole feature turns on. */
  it('departs a person absent from a snapshot', () => {
    const changes = diffPersons(input({ mapped: [], existing: [existing('1')] }));
    expect(changes.map((c) => c.changeType)).toEqual(['depart_person']);
    expect(changes[0]?.targetId).toBe('p-1');
  });

  /**
   * And the rule that stops it being catastrophic. Not "produced then
   * filtered" -- never produced.
   */
  it('departs nobody in delta mode, however absent they are', () => {
    const changes = diffPersons(
      input({ mapped: [], existing: [existing('1'), existing('2')], feedMode: 'delta' }),
    );
    expect(changes).toEqual([]);
  });

  it('never departs a person who is already inactive', () => {
    const changes = diffPersons(
      input({ mapped: [], existing: [existing('1', { status: 'inactive' })] }),
    );
    expect(changes).toEqual([]);
  });

  it('reactivates a person who reappears after departing', () => {
    const changes = diffPersons(
      input({ mapped: [mapped('1')], existing: [existing('1', { status: 'inactive' })] }),
    );
    expect(changes.map((c) => c.changeType)).toEqual(['reactivate_person']);
  });

  /**
   * Contract identity is the HR system's employment id, not a positional
   * ordinal. Two contracts arriving in the other order must not be rewritten
   * into each other.
   */
  it('matches contracts by external id regardless of order', () => {
    const record = mapped('1');
    record.contracts = [
      { ...record.contracts[0]!, externalId: 'c-b', jobTitle: 'B' },
      { ...record.contracts[0]!, externalId: 'c-a', jobTitle: 'A' },
    ];
    const stored = existing('1');
    stored.contracts = [
      { ...stored.contracts[0]!, id: 'k-a', externalId: 'c-a', jobTitle: 'A', isPrimary: true },
      { ...stored.contracts[0]!, id: 'k-b', externalId: 'c-b', jobTitle: 'B', isPrimary: false },
    ];
    expect(diffPersons(input({ mapped: [record], existing: [stored] }))).toEqual([]);
  });

  it('falls back to sequence when the file carries no contract id', () => {
    const record = mapped('1');
    record.contracts[0] = {
      ...record.contracts[0]!,
      externalId: null,
      sequence: 1,
      jobTitle: 'Lead',
    };
    const stored = existing('1');
    stored.contracts[0] = { ...stored.contracts[0]!, externalId: null, sequence: 1 };
    const changes = diffPersons(input({ mapped: [record], existing: [stored] }));
    expect(changes.map((c) => c.changeType)).toEqual(['update_contract']);
  });

  it('resolves a manager external id to a person id', () => {
    const record = mapped('1');
    record.contracts[0]!.managerExternalId = '9';
    const changes = diffPersons(
      input({
        mapped: [record],
        existing: [existing('1')],
        managerIdByExternalId: new Map([['9', 'p-9']]),
      }),
    );
    expect(changes[0]?.after).toEqual({ managerPersonId: 'p-9' });
  });

  /**
   * A manager not yet imported is ordinary on a first run and fixed by the
   * next one. It must never be a null write, which would clear a manager
   * somebody set by hand.
   *
   * And it must not manufacture a change of its own. A note attached to an
   * otherwise-empty diff is an `update_contract` that writes nothing, is
   * proposed again on every subsequent run because nothing about it ever
   * changes, and under `autoApply` applies a no-op write and an audit event
   * every night for as long as that manager is missing. Nothing is lost by
   * staying quiet: when the manager IS imported, `managerPersonId` genuinely
   * differs from what is stored, and a real change appears then.
   */
  it('proposes nothing when the only news is an unresolvable manager', () => {
    const record = mapped('1');
    record.contracts[0]!.managerExternalId = '9';
    const changes = diffPersons(input({ mapped: [record], existing: [existing('1')] }));
    expect(changes).toEqual([]);
  });

  it('carries the note on a change that exists for another reason', () => {
    const record = mapped('1');
    record.contracts[0]!.managerExternalId = '9';
    record.contracts[0]!.department = 'Engineering';
    const changes = diffPersons(input({ mapped: [record], existing: [existing('1')] }));
    expect(changes).toHaveLength(1);
    expect(changes[0]?.changeType).toBe('update_contract');
    expect(changes[0]?.message).toMatch(/manager "9" is not in the register yet/);
    expect(changes[0]?.after).toEqual({ department: 'Engineering' });
    expect(changes[0]?.after).not.toHaveProperty('managerPersonId');
  });

  /**
   * The whole point of staying quiet: the next run resolves it by itself.
   */
  it('proposes the manager once the person it names has been imported', () => {
    const record = mapped('1');
    record.contracts[0]!.managerExternalId = '9';
    const changes = diffPersons(
      input({
        mapped: [record],
        existing: [existing('1')],
        managerIdByExternalId: new Map([['9', 'p-9']]),
      }),
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]?.after).toEqual({ managerPersonId: 'p-9' });
  });

  it('derives isPrimary as the earliest active contract when the file is silent', () => {
    const record = mapped('1');
    record.contracts = [
      {
        ...record.contracts[0]!,
        externalId: 'c-late',
        startDate: new Date('2026-03-01T00:00:00Z'),
      },
      {
        ...record.contracts[0]!,
        externalId: 'c-early',
        startDate: new Date('2026-01-01T00:00:00Z'),
      },
    ];
    const changes = diffPersons(input({ mapped: [record] }));
    const primary = changes.filter(
      (c) => c.changeType === 'create_contract' && (c.after as { isPrimary?: boolean }).isPrimary,
    );
    expect(primary).toHaveLength(1);
    expect((primary[0]?.after as { externalId: string }).externalId).toBe('c-early');
  });

  /**
   * Ties are broken by key, not by insertion order, so two runs over the same
   * file cannot disagree about which contract is primary.
   */
  it('breaks a same-day tie deterministically', () => {
    const record = mapped('1');
    record.contracts = [
      { ...record.contracts[0]!, externalId: 'c-b' },
      { ...record.contracts[0]!, externalId: 'c-a' },
    ];
    const first = diffPersons(input({ mapped: [record] }));
    const reversed = mapped('1');
    reversed.contracts = [...record.contracts].reverse();
    const second = diffPersons(input({ mapped: [reversed] }));

    const primaryOf = (changes: ReturnType<typeof diffPersons>) =>
      (
        changes.find(
          (c) => c.changeType === 'create_contract' && (c.after as { isPrimary?: boolean }).isPrimary,
        )?.after as { externalId: string }
      ).externalId;

    expect(primaryOf(first)).toBe('c-a');
    expect(primaryOf(second)).toBe('c-a');
  });

  it('honours an explicit primary flag over the derived one', () => {
    const record = mapped('1');
    record.contracts = [
      {
        ...record.contracts[0]!,
        externalId: 'c-late',
        startDate: new Date('2026-03-01T00:00:00Z'),
        isPrimary: true,
      },
      {
        ...record.contracts[0]!,
        externalId: 'c-early',
        startDate: new Date('2026-01-01T00:00:00Z'),
        isPrimary: false,
      },
    ];
    const changes = diffPersons(input({ mapped: [record] }));
    const primary = changes.filter(
      (c) => c.changeType === 'create_contract' && (c.after as { isPrimary?: boolean }).isPrimary,
    );
    expect(primary).toHaveLength(1);
    expect((primary[0]?.after as { externalId: string }).externalId).toBe('c-late');
  });

  it('adds a contract that is new for a person who already exists', () => {
    const record = mapped('1');
    record.contracts = [
      { ...record.contracts[0]! },
      { ...record.contracts[0]!, externalId: 'c-second', isPrimary: false },
    ];
    const changes = diffPersons(input({ mapped: [record], existing: [existing('1')] }));
    expect(changes.map((c) => c.changeType)).toEqual(['create_contract']);
    expect(changes[0]?.targetId).toBe('p-1');
  });

  /**
   * A contract the file stopped mentioning is left alone. Absence is a
   * statement about people, and only in snapshot mode; extending it to
   * contracts would end an engagement because a column moved.
   */
  it('leaves a contract the file no longer mentions alone', () => {
    const stored = existing('1');
    stored.contracts = [
      { ...stored.contracts[0]! },
      { ...stored.contracts[0]!, id: 'k-old', externalId: 'c-old', isPrimary: false },
    ];
    const changes = diffPersons(input({ mapped: [mapped('1')], existing: [stored] }));
    expect(changes).toEqual([]);
  });

  /**
   * Returned is returned. A row that failed to map is still a row the source
   * gave us, so the person it names is excluded from the diff -- never absent.
   */
  it('does not depart a person whose row was returned but could not be mapped', () => {
    const changes = diffPersons(
      input({
        mapped: [],
        existing: [existing('1')],
        excludedExternalIds: new Set(['1']),
      }),
    );
    expect(changes).toEqual([]);
  });

  /**
   * The renamed-column case. Every row fails, no failure names anybody, and
   * every person looks absent -- so the absence half is withheld entirely
   * rather than departing the whole workforce.
   */
  it('departs nobody when a failure could not be attributed to a person', () => {
    const changes = diffPersons(
      input({
        mapped: [],
        existing: [existing('1'), existing('2'), existing('3')],
        absenceReliable: false,
      }),
    );
    expect(changes).toEqual([]);
  });

  it('still departs the others when one failure is attributable', () => {
    const changes = diffPersons(
      input({
        mapped: [],
        existing: [existing('1'), existing('2')],
        excludedExternalIds: new Set(['1']),
      }),
    );
    expect(changes.map((c) => c.externalId)).toEqual(['2']);
  });

  it('carries the person external id on a create so apply can find them', () => {
    const changes = diffPersons(input({ mapped: [mapped('1')] }));
    const create = changes.find((c) => c.changeType === 'create_contract');
    expect((create?.after as { personExternalId: string }).personExternalId).toBe('1');
  });
});
