import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { FakePersonSource } from '@syntra/connectors/testing';
import { localMasterKeyProvider } from '../vault/master-key.js';
import { createPersonSource, setPersonMappings } from './source-service.js';
import { PERSON_IMPORT_APPLY_ORDER, applyImportRun, previewImportRun } from './run-service.js';

const provider = localMasterKeyProvider(Buffer.alloc(32, 7));

const connectorFor = vi.hoisted(() => vi.fn());
vi.mock('@syntra/connectors', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@syntra/connectors')>()),
  personSourceConnectorFor: connectorFor,
}));

const rules = [
  { recordType: 'person' as const, sourceColumn: 'employeeId', targetField: 'externalId', transform: 'trim' as const, isCorrelation: true },
  { recordType: 'person' as const, sourceColumn: 'firstName', targetField: 'givenName', transform: 'trim' as const, isCorrelation: false },
  { recordType: 'person' as const, sourceColumn: 'lastName', targetField: 'familyName', transform: 'trim' as const, isCorrelation: false },
  { recordType: 'contract' as const, sourceColumn: 'hireDate', targetField: 'startDate', transform: 'none' as const, isCorrelation: false },
  { recordType: 'contract' as const, sourceColumn: 'dept', targetField: 'department', transform: 'none' as const, isCorrelation: false },
  { recordType: 'contract' as const, sourceColumn: 'leaveDate', targetField: 'endDate', transform: 'none' as const, isCorrelation: false },
];

function row(employeeId: string, over: Record<string, string> = {}) {
  return {
    externalId: `row-${employeeId}`,
    fields: {
      employeeId,
      firstName: 'Ada',
      lastName: 'Lovelace',
      hireDate: '2026-01-05',
      dept: 'Research',
      ...over,
    },
    contracts: [],
  };
}

let tenantId: string;
let sourceId: string;

beforeEach(async () => {
  await resetDatabase();
  connectorFor.mockReset();
  const tenant = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = tenant.id;
  const source = await withTenant(tenantId, async (tx) => {
    const created = await createPersonSource(tx, provider, {
      name: 'HR',
      type: 'sftpDelimited',
      feedMode: 'snapshot',
      config: { host: 'hr.test', username: 'u', remotePath: '/f.csv' },
      credential: 'x',
    });
    await setPersonMappings(tx, created.id, rules);
    return created;
  });
  sourceId = source.id;
});

const changesOf = (runId: string) =>
  withTenant(tenantId, (tx) => tx.personImportChange.findMany({ where: { runId } }));

describe('previewImportRun', () => {
  it('creates persons and contracts on a first run, and applies them', async () => {
    connectorFor.mockReturnValue(new FakePersonSource([row('1'), row('2')]));

    const run = await previewImportRun(tenantId, provider, sourceId);
    expect(run.status).toBe('previewed');
    expect(run.recordsRead).toBe(2);

    await applyImportRun(tenantId, run.id);

    const persons = await withTenant(tenantId, (tx) =>
      tx.person.findMany({ include: { contracts: true }, orderBy: { externalId: 'asc' } }),
    );
    expect(persons).toHaveLength(2);
    expect(persons[0]?.sourceId).toBe(sourceId);
    expect(persons[0]?.contracts).toHaveLength(1);
    expect(persons[0]?.contracts[0]?.department).toBe('Research');
  });

  it('proposes nothing on a second run over the same file', async () => {
    connectorFor.mockReturnValue(new FakePersonSource([row('1')]));
    const first = await previewImportRun(tenantId, provider, sourceId);
    await applyImportRun(tenantId, first.id);

    const second = await previewImportRun(tenantId, provider, sourceId);
    expect(await changesOf(second.id)).toEqual([]);
  });

  /**
   * The record was returned, so it is read. It could not be mapped, so it is
   * excluded. It is NOT absent, so nobody is departed for it -- which is what
   * stops a column rename at the HR vendor reading as a redundancy.
   */
  it('counts a mapping failure as read and departs nobody for it', async () => {
    connectorFor.mockReturnValue(new FakePersonSource([row('1')]));
    const first = await previewImportRun(tenantId, provider, sourceId);
    await applyImportRun(tenantId, first.id);

    connectorFor.mockReturnValue(
      new FakePersonSource([{ ...row('1'), readFailure: 'the row was truncated' }]),
    );
    const second = await previewImportRun(tenantId, provider, sourceId);

    expect(second.recordsRead).toBe(1);
    expect(second.mappingFailures).toBe(1);
    expect(second.personsAbsent).toBe(0);
    expect(second.mappingFailureReasons[0]).toMatch(/truncated/);
    expect(await changesOf(second.id)).toEqual([]);
  });

  /**
   * The renamed-column catastrophe, end to end. Every row fails to map because
   * the correlation column is gone, so no failure names anybody -- and the run
   * proposes no leaver at all rather than departing the entire register.
   */
  it('departs nobody when the correlation column disappears', async () => {
    connectorFor.mockReturnValue(
      new FakePersonSource([row('1'), row('2'), row('3'), row('4'), row('5')]),
    );
    const first = await previewImportRun(tenantId, provider, sourceId);
    await applyImportRun(tenantId, first.id);

    // The vendor renamed employeeId, so every row loses its correlation value
    // and every failure's anchor is the connector's row placeholder.
    connectorFor.mockReturnValue(
      new FakePersonSource(
        ['1', '2', '3', '4', '5'].map((id) => {
          const r = row(id);
          const { employeeId: _gone, ...rest } = r.fields;
          return { ...r, fields: { ...rest, staffNumber: id } };
        }),
      ),
    );
    const second = await previewImportRun(tenantId, provider, sourceId);

    expect(second.recordsRead).toBe(5);
    expect(second.mappingFailures).toBe(5);
    expect(second.personsAbsent).toBe(0);
    expect(await changesOf(second.id)).toEqual([]);
    expect(second.mappingFailureReasons.join(' ')).toMatch(/no leaver is proposed/);

    const stillHere = await withTenant(tenantId, (tx) =>
      tx.person.count({ where: { status: 'active' } }),
    );
    expect(stillHere).toBe(5);
  });

  /**
   * The narrow case still works: one bad row among good ones excludes only the
   * person that row was about, and everybody else's departure is proposed.
   */
  it('excludes only the person whose row failed, and departs the rest', async () => {
    connectorFor.mockReturnValue(
      new FakePersonSource([row('1'), row('2'), row('3'), row('4'), row('5')]),
    );
    const first = await previewImportRun(tenantId, provider, sourceId);
    await applyImportRun(tenantId, first.id);

    // 1 has an unreadable date -- attributable, so excluded. 5 is simply gone.
    connectorFor.mockReturnValue(
      new FakePersonSource([
        row('1', { hireDate: 'not-a-date' }),
        row('2'),
        row('3'),
        row('4'),
      ]),
    );
    const second = await previewImportRun(tenantId, provider, sourceId);

    expect(second.mappingFailures).toBe(1);
    expect(second.personsAbsent).toBe(1);
    const departures = (await changesOf(second.id)).filter(
      (c) => c.changeType === 'depart_person',
    );
    expect(departures.map((c) => c.externalId)).toEqual(['5']);
  });

  it('blocks a run that read nothing, and refuses to apply it', async () => {
    connectorFor.mockReturnValue(new FakePersonSource([]));
    const run = await previewImportRun(tenantId, provider, sourceId);
    expect(run.status).toBe('blocked');
    expect(run.requiresConfirmation).toBe(false);
    expect(run.blockedReason).toMatch(/returned no records/);

    await expect(applyImportRun(tenantId, run.id, { confirm: true })).rejects.toThrow(
      /blocked/,
    );
  });

  /**
   * A read that gives out partway fails the run. It must never become a
   * snapshot in which everyone unread is absent.
   */
  it('fails the run when the read throws, and proposes nothing', async () => {
    connectorFor.mockReturnValue(
      new FakePersonSource([row('1')], { failWith: new Error('connection reset') }),
    );
    const run = await previewImportRun(tenantId, provider, sourceId);
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/connection reset/);
    expect(await changesOf(run.id)).toEqual([]);
  });

  it('departs a person absent from a later snapshot', async () => {
    connectorFor.mockReturnValue(
      new FakePersonSource([row('1'), row('2'), row('3'), row('4'), row('5')]),
    );
    const first = await previewImportRun(tenantId, provider, sourceId);
    await applyImportRun(tenantId, first.id);

    // One of five is 20%, over the default 10% threshold, so it needs
    // confirming -- which is the realistic shape of a single leaver.
    connectorFor.mockReturnValue(
      new FakePersonSource([row('1'), row('2'), row('3'), row('4')]),
    );
    const second = await previewImportRun(tenantId, provider, sourceId);
    expect(second.personsAbsent).toBe(1);
    await applyImportRun(tenantId, second.id, { confirm: true });

    const gone = await withTenant(tenantId, (tx) =>
      tx.person.findFirst({ where: { externalId: '5' } }),
    );
    expect(gone?.status).toBe('inactive');
    expect(gone?.statusReason).toMatch(/not in the file/);
    // Never departureOverride: that means a human knew something the contract
    // table did not, and an import knows only that a row was missing.
    expect(gone?.departureOverride).toBeNull();
  });

  it('never departs a person the source does not own', async () => {
    await withTenant(tenantId, (tx) =>
      tx.person.create({
        data: { tenantId, givenName: 'Hand', familyName: 'Made', externalId: '99' },
      }),
    );
    connectorFor.mockReturnValue(new FakePersonSource([row('1')]));
    const run = await previewImportRun(tenantId, provider, sourceId);
    await applyImportRun(tenantId, run.id);

    const untouched = await withTenant(tenantId, (tx) =>
      tx.person.findFirst({ where: { externalId: '99' } }),
    );
    expect(untouched?.status).toBe('active');
    expect(untouched?.sourceId).toBeNull();
  });

  it('proposes no departure at all when the source is a delta feed', async () => {
    await withTenant(tenantId, (tx) =>
      tx.personSource.update({ where: { id: sourceId }, data: { feedMode: 'delta' } }),
    );
    connectorFor.mockReturnValue(new FakePersonSource([row('1'), row('2')]));
    const first = await previewImportRun(tenantId, provider, sourceId);
    await applyImportRun(tenantId, first.id);

    connectorFor.mockReturnValue(new FakePersonSource([row('1')]));
    const second = await previewImportRun(tenantId, provider, sourceId);
    const departures = (await changesOf(second.id)).filter(
      (c) => c.changeType === 'depart_person',
    );
    expect(departures).toEqual([]);
    expect(second.personsAbsent).toBe(0);
  });

  it('ends a contract the file gave an end date', async () => {
    connectorFor.mockReturnValue(new FakePersonSource([row('1')]));
    const first = await previewImportRun(tenantId, provider, sourceId);
    await applyImportRun(tenantId, first.id);

    connectorFor.mockReturnValue(
      new FakePersonSource([row('1', { leaveDate: '2026-06-30' })]),
    );
    const second = await previewImportRun(tenantId, provider, sourceId);
    const changes = await changesOf(second.id);
    expect(changes.map((c) => c.changeType)).toEqual(['end_contract']);

    await applyImportRun(tenantId, second.id, { confirm: true });
    const contract = await withTenant(tenantId, (tx) => tx.contract.findFirst({}));
    expect(contract?.endDate?.toISOString().slice(0, 10)).toBe('2026-06-30');
  });

  it('reactivates a person who reappears in a later file', async () => {
    connectorFor.mockReturnValue(new FakePersonSource([row('1'), row('2')]));
    const first = await previewImportRun(tenantId, provider, sourceId);
    await applyImportRun(tenantId, first.id);

    connectorFor.mockReturnValue(new FakePersonSource([row('1')]));
    const second = await previewImportRun(tenantId, provider, sourceId);
    await applyImportRun(tenantId, second.id, { confirm: true });

    connectorFor.mockReturnValue(new FakePersonSource([row('1'), row('2')]));
    const third = await previewImportRun(tenantId, provider, sourceId);
    await applyImportRun(tenantId, third.id);

    const back = await withTenant(tenantId, (tx) =>
      tx.person.findFirst({ where: { externalId: '2' } }),
    );
    expect(back?.status).toBe('active');
    expect(back?.statusReason).toBeNull();
  });
});

describe('applyImportRun', () => {
  it('refuses a blocked run without confirmation and accepts it with one', async () => {
    connectorFor.mockReturnValue(new FakePersonSource([row('1'), row('2')]));
    const first = await previewImportRun(tenantId, provider, sourceId);
    await applyImportRun(tenantId, first.id);

    // Both gone at once: 2 of 2 is 100%, far over the 10% threshold.
    connectorFor.mockReturnValue(new FakePersonSource([row('3')]));
    const second = await previewImportRun(tenantId, provider, sourceId);
    expect(second.status).toBe('blocked');
    expect(second.requiresConfirmation).toBe(true);

    await expect(applyImportRun(tenantId, second.id)).rejects.toThrow(/blocked/);

    const confirmer = '11111111-1111-1111-1111-111111111111';
    await applyImportRun(tenantId, second.id, { confirm: true, confirmedBy: confirmer });

    const run = await withTenant(tenantId, (tx) =>
      tx.personImportRun.findUnique({ where: { id: second.id } }),
    );
    expect(run?.confirmedBy).toBe(confirmer);
  });

  /**
   * A run that applied half of itself must not read as complete, and one
   * whose every change failed must not read as a success. `sync` calls that
   * `partially_applied`; so does this.
   */
  it('reports a partial apply as partially applied', async () => {
    connectorFor.mockReturnValue(new FakePersonSource([row('1'), row('2')]));
    const run = await previewImportRun(tenantId, provider, sourceId);
    const creates = (await changesOf(run.id)).filter(
      (c) => c.changeType === 'create_person',
    );
    await applyImportRun(tenantId, run.id, { only: [creates[0]!.id] });

    const after = await withTenant(tenantId, (tx) =>
      tx.personImportRun.findUnique({ where: { id: run.id } }),
    );
    expect(after?.status).toBe('partially_applied');
    expect(after?.finishedAt).not.toBeNull();
  });

  it('reports a fully applied run as applied', async () => {
    connectorFor.mockReturnValue(new FakePersonSource([row('1')]));
    const run = await previewImportRun(tenantId, provider, sourceId);
    await applyImportRun(tenantId, run.id);

    const after = await withTenant(tenantId, (tx) =>
      tx.personImportRun.findUnique({ where: { id: run.id } }),
    );
    expect(after?.status).toBe('applied');
  });

  /**
   * The knock-on the status change could have caused: `previewImportRun`
   * looks for a previously applied run to decide whether the drop guard has a
   * baseline. A source that applied half a run has still applied, and
   * treating it as never-applied would skip that guard on the next run.
   */
  it('still guards the next run after a partial apply', async () => {
    connectorFor.mockReturnValue(
      new FakePersonSource([row('1'), row('2'), row('3'), row('4'), row('5')]),
    );
    const first = await previewImportRun(tenantId, provider, sourceId);
    const creates = (await changesOf(first.id)).filter(
      (c) => c.changeType === 'create_person',
    );
    // Everything but one, so the run is partially applied on purpose.
    await applyImportRun(tenantId, first.id, {
      only: creates.slice(0, 4).map((c) => c.id),
    });

    // Now everybody vanishes. The guard must still have a baseline to refuse
    // against.
    connectorFor.mockReturnValue(new FakePersonSource([row('9')]));
    const second = await previewImportRun(tenantId, provider, sourceId);
    expect(second.status).toBe('blocked');
    expect(second.requiresConfirmation).toBe(true);
  });

  it('applies only the changes it was given', async () => {
    connectorFor.mockReturnValue(new FakePersonSource([row('1'), row('2')]));
    const run = await previewImportRun(tenantId, provider, sourceId);
    const creates = (await changesOf(run.id)).filter(
      (c) => c.changeType === 'create_person',
    );
    await applyImportRun(tenantId, run.id, { only: [creates[0]!.id] });

    const persons = await withTenant(tenantId, (tx) => tx.person.findMany());
    expect(persons).toHaveLength(1);
  });

  it('records an audit event for the run', async () => {
    connectorFor.mockReturnValue(new FakePersonSource([row('1')]));
    const run = await previewImportRun(tenantId, provider, sourceId);
    await applyImportRun(tenantId, run.id);

    const events = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'person_import.run.apply' } }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.targetId).toBe(run.id);
  });

  it('marks a change failed without failing the whole run', async () => {
    connectorFor.mockReturnValue(new FakePersonSource([row('1')]));
    const run = await previewImportRun(tenantId, provider, sourceId);
    const changes = await changesOf(run.id);
    const contract = changes.find((c) => c.changeType === 'create_contract');
    // Apply the contract alone: its person does not exist yet, so it fails.
    const result = await applyImportRun(tenantId, run.id, { only: [contract!.id] });

    expect(result).toEqual({ applied: 0, failed: 1 });
    const after = await changesOf(run.id);
    expect(after.find((c) => c.id === contract!.id)?.status).toBe('failed');
  });

  /**
   * Departure is last. A person whose contract ends in the same run must not
   * be departed before the contract that would have kept them active is
   * written.
   */
  it('orders departure after every other change type', () => {
    expect(PERSON_IMPORT_APPLY_ORDER[PERSON_IMPORT_APPLY_ORDER.length - 1]).toBe('depart_person');
    expect(PERSON_IMPORT_APPLY_ORDER.indexOf('create_person')).toBeLessThan(
      PERSON_IMPORT_APPLY_ORDER.indexOf('create_contract'),
    );
    expect(PERSON_IMPORT_APPLY_ORDER.indexOf('end_contract')).toBeLessThan(
      PERSON_IMPORT_APPLY_ORDER.indexOf('depart_person'),
    );
  });
});
