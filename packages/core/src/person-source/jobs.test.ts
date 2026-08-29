import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { FakePersonSource } from '@syntra/connectors/testing';
import { localMasterKeyProvider } from '../vault/master-key.js';
import {
  PersonSourceDisabledError,
  createPersonSource,
  setPersonMappings,
} from './source-service.js';
import {
  PERSON_IMPORT_JOB,
  applyPersonSourceSchedule,
  queueImportRun,
  runPersonImportJob,
} from './jobs.js';

const provider = localMasterKeyProvider(Buffer.alloc(32, 7));

const connectorFor = vi.hoisted(() => vi.fn());
vi.mock('@syntra/connectors', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@syntra/connectors')>()),
  personSourceConnectorFor: connectorFor,
}));

const scheduler = {
  start: vi.fn(),
  stop: vi.fn(),
  register: vi.fn(),
  enqueue: vi.fn(),
  schedule: vi.fn(),
  unschedule: vi.fn(),
};

const rules = [
  { recordType: 'person' as const, sourceColumn: 'employeeId', targetField: 'externalId', transform: 'trim' as const, isCorrelation: true },
  { recordType: 'person' as const, sourceColumn: 'firstName', targetField: 'givenName', transform: 'trim' as const, isCorrelation: false },
  { recordType: 'person' as const, sourceColumn: 'lastName', targetField: 'familyName', transform: 'trim' as const, isCorrelation: false },
  { recordType: 'contract' as const, sourceColumn: 'hireDate', targetField: 'startDate', transform: 'none' as const, isCorrelation: false },
];

function row(employeeId: string) {
  return {
    externalId: `row-${employeeId}`,
    fields: { employeeId, firstName: 'Ada', lastName: 'Lovelace', hireDate: '2026-01-05' },
    contracts: [],
  };
}

let tenantId: string;

beforeEach(async () => {
  await resetDatabase();
  for (const fn of Object.values(scheduler)) fn.mockReset();
  connectorFor.mockReset();
  const tenant = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = tenant.id;
});

async function makeSource(over: Record<string, unknown> = {}) {
  return withTenant(tenantId, async (tx) => {
    const created = await createPersonSource(tx, provider, {
      name: 'HR',
      type: 'sftpDelimited',
      feedMode: 'snapshot',
      config: { host: 'hr.test', username: 'u', remotePath: '/f.csv' },
      credential: 'x',
      ...over,
    });
    await setPersonMappings(tx, created.id, rules);
    return created;
  });
}

describe('queueImportRun', () => {
  it('creates the run row so the response can name it, then enqueues', async () => {
    const source = await makeSource();
    const run = await queueImportRun(scheduler as never, tenantId, source.id);

    expect(run.status).toBe('queued');
    expect(scheduler.enqueue).toHaveBeenCalledWith(
      PERSON_IMPORT_JOB,
      expect.objectContaining({ tenantId, sourceId: source.id, runId: run.id }),
    );
  });

  /**
   * Refused here rather than in the route: a check in the route leaves the
   * hole open for the next caller, and a run that reaches the database is a
   * run somebody has to reap.
   */
  it('refuses a run on a disabled source, writing no row', async () => {
    const source = await makeSource({ enabled: false });
    await expect(
      queueImportRun(scheduler as never, tenantId, source.id),
    ).rejects.toThrow(PersonSourceDisabledError);

    const runs = await withTenant(tenantId, (tx) => tx.personImportRun.findMany());
    expect(runs).toEqual([]);
    expect(scheduler.enqueue).not.toHaveBeenCalled();
  });
});

describe('applyPersonSourceSchedule', () => {
  it('schedules a source that has a cron expression', async () => {
    await applyPersonSourceSchedule(scheduler as never, tenantId, {
      id: 's-1',
      schedule: '0 2 * * *',
      enabled: true,
    });
    expect(scheduler.schedule).toHaveBeenCalledWith(
      PERSON_IMPORT_JOB,
      '0 2 * * *',
      { tenantId, sourceId: 's-1' },
      `${tenantId}:s-1`,
    );
  });

  /**
   * Unscheduled, not skipped: skipping would leave the old schedule firing
   * against a source the administrator believes is stopped.
   */
  it('unschedules a source that is disabled', async () => {
    await applyPersonSourceSchedule(scheduler as never, tenantId, {
      id: 's-1',
      schedule: '0 2 * * *',
      enabled: false,
    });
    expect(scheduler.unschedule).toHaveBeenCalled();
    expect(scheduler.schedule).not.toHaveBeenCalled();
  });

  it('unschedules a source whose cron expression was cleared', async () => {
    await applyPersonSourceSchedule(scheduler as never, tenantId, {
      id: 's-1',
      schedule: null,
      enabled: true,
    });
    expect(scheduler.unschedule).toHaveBeenCalled();
  });

  /**
   * Two sources must not share a schedule row. pg-boss keys on (name, key),
   * so a shared key means the second replaces the first and every source but
   * one silently stops running.
   */
  it('gives each source its own schedule key', async () => {
    await applyPersonSourceSchedule(scheduler as never, tenantId, {
      id: 'a',
      schedule: '0 2 * * *',
      enabled: true,
    });
    await applyPersonSourceSchedule(scheduler as never, tenantId, {
      id: 'b',
      schedule: '0 3 * * *',
      enabled: true,
    });
    const keys = scheduler.schedule.mock.calls.map((call) => call[3]);
    expect(new Set(keys).size).toBe(2);
  });
});

describe('runPersonImportJob', () => {
  it('previews without applying when autoApply is off', async () => {
    const source = await makeSource();
    connectorFor.mockReturnValue(new FakePersonSource([row('1')]));

    await runPersonImportJob(provider, { tenantId, sourceId: source.id });

    const run = await withTenant(tenantId, (tx) => tx.personImportRun.findFirst({}));
    expect(run?.status).toBe('previewed');
    const persons = await withTenant(tenantId, (tx) => tx.person.findMany());
    expect(persons).toEqual([]);
  });

  it('applies a clean run when autoApply is on', async () => {
    const source = await makeSource({ autoApply: true });
    connectorFor.mockReturnValue(new FakePersonSource([row('1')]));

    await runPersonImportJob(provider, { tenantId, sourceId: source.id });

    const persons = await withTenant(tenantId, (tx) => tx.person.findMany());
    expect(persons).toHaveLength(1);
  });

  /**
   * The whole protection. An unattended schedule is exactly when nobody is
   * watching, so autoApply can never satisfy a guard that blocked.
   */
  it('never applies a blocked run, whatever autoApply says', async () => {
    const source = await makeSource({ autoApply: true });
    connectorFor.mockReturnValue(
      new FakePersonSource([row('1'), row('2'), row('3'), row('4'), row('5')]),
    );
    await runPersonImportJob(provider, { tenantId, sourceId: source.id });
    expect(await withTenant(tenantId, (tx) => tx.person.count())).toBe(5);

    // Four of five gone at once: over the threshold, so blocked pending
    // confirmation -- which the scheduler never gives.
    connectorFor.mockReturnValue(new FakePersonSource([row('1')]));
    await runPersonImportJob(provider, { tenantId, sourceId: source.id });

    const latest = await withTenant(tenantId, (tx) =>
      tx.personImportRun.findFirst({ orderBy: { startedAt: 'desc' } }),
    );
    expect(latest?.status).toBe('blocked');
    const stillActive = await withTenant(tenantId, (tx) =>
      tx.person.count({ where: { status: 'active' } }),
    );
    expect(stillActive).toBe(5);
  });

  it('does nothing for a source that was disabled after the job was queued', async () => {
    const source = await makeSource();
    await withTenant(tenantId, (tx) =>
      tx.personSource.update({ where: { id: source.id }, data: { enabled: false } }),
    );
    connectorFor.mockReturnValue(new FakePersonSource([row('1')]));

    await runPersonImportJob(provider, { tenantId, sourceId: source.id });

    const runs = await withTenant(tenantId, (tx) => tx.personImportRun.findMany());
    expect(runs).toEqual([]);
  });
});
