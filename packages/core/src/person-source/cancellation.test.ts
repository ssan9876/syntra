import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { FakePersonSource } from '@syntra/connectors/testing';
import { localMasterKeyProvider } from '../vault/master-key.js';
import {
  RunNotAppliableError,
  RunNotCancellableError,
  requestCancellation,
} from '../jobs/cancellation.js';
import { recordEvent } from '../audit/audit-service.js';
import { createPersonSource, setPersonMappings } from './source-service.js';
import { applyImportRun, previewImportRun, requestCancelImportRun } from './run-service.js';
import { listDuplicateReviews } from './duplicate-review.js';

/*
 * Cooperative cancellation of HR person imports.
 *
 * `recordEvent` is wrapped because every applied change writes one inside the
 * change's own transaction: it is the one observable point that lands a
 * cancellation request exactly between two changes.
 */
const connectorFor = vi.hoisted(() => vi.fn());
vi.mock('@syntra/connectors', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@syntra/connectors')>()),
  personSourceConnectorFor: connectorFor,
}));
vi.mock('../audit/audit-service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../audit/audit-service.js')>();
  return { ...real, recordEvent: vi.fn(real.recordEvent) };
});

const provider = localMasterKeyProvider(Buffer.alloc(32, 7));

const rules = [
  { recordType: 'person' as const, sourceColumn: 'employeeId', targetField: 'externalId', transform: 'trim' as const, isCorrelation: true },
  { recordType: 'person' as const, sourceColumn: 'firstName', targetField: 'givenName', transform: 'trim' as const, isCorrelation: false },
  { recordType: 'person' as const, sourceColumn: 'lastName', targetField: 'familyName', transform: 'trim' as const, isCorrelation: false },
  { recordType: 'person' as const, sourceColumn: 'email', targetField: 'businessEmail', transform: 'lowercase' as const, isCorrelation: false },
  { recordType: 'contract' as const, sourceColumn: 'hireDate', targetField: 'startDate', transform: 'none' as const, isCorrelation: false },
  { recordType: 'contract' as const, sourceColumn: 'dept', targetField: 'department', transform: 'none' as const, isCorrelation: false },
];

function row(employeeId: string, over: Record<string, string> = {}) {
  return {
    externalId: `row-${employeeId}`,
    fields: {
      employeeId,
      firstName: 'Ada',
      lastName: `Lovelace ${employeeId}`,
      email: `${employeeId}@example.test`,
      hireDate: '2026-01-05',
      dept: 'Research',
      ...over,
    },
    contracts: [],
  };
}

let tenantId: string;
let sourceId: string;
let actorId: string;

beforeEach(async () => {
  await resetDatabase();
  connectorFor.mockReset();
  vi.mocked(recordEvent).mockClear();
  const tenant = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = tenant.id;
  await withTenant(tenantId, async (tx) => {
    const created = await createPersonSource(tx, provider, {
      name: 'HR',
      type: 'sftpDelimited',
      feedMode: 'snapshot',
      config: { host: 'hr.test', username: 'u', remotePath: '/f.csv' },
      credential: 'x',
    });
    await setPersonMappings(tx, created.id, rules);
    sourceId = created.id;
    actorId = (
      await tx.user.create({
        data: { tenantId, login: 'operator', email: 'operator@acme.test', displayName: 'Operator' },
      })
    ).id;
  });
});

const cancel = (runId: string) =>
  withTenant(tenantId, (tx) =>
    requestCancelImportRun(tx, runId, { userId: actorId, sourceIp: '203.0.113.9' }),
  );

/**
 * The request as it lands while the apply is inside a change's transaction.
 * The audited route would wait on that transaction's audit-chain lock — which
 * is itself proof the request cannot interleave with a change's write — so
 * the test records the request state directly, from its own transaction.
 */
const requestDuringApply = (runId: string) =>
  withTenant(tenantId, (tx) =>
    requestCancellation(tx.personImportRun as never, runId, actorId, {
      immediate: [],
      cooperative: ['applying'],
    }),
  );

const changesOf = (runId: string) =>
  withTenant(tenantId, (tx) => tx.personImportChange.findMany({ where: { runId } }));

describe('HR import run cancellation', () => {
  it('stops an apply between changes, keeping every applied change recorded', async () => {
    connectorFor.mockReturnValue(new FakePersonSource([row('e1'), row('e2'), row('e3')]));
    const run = await previewImportRun(tenantId, provider, sourceId);
    expect(run.status).toBe('previewed');
    const proposed = (await changesOf(run.id)).filter((c) => c.status === 'proposed');
    expect(proposed).toHaveLength(6); // three persons, three contracts

    // After the SECOND person is created, and inside its transaction.
    const real = vi.mocked(recordEvent).getMockImplementation()!;
    let creates = 0;
    vi.mocked(recordEvent).mockImplementation(async (tx, input) => {
      const written = await real(tx, input);
      if (input.action === 'person_import.create_person' && ++creates === 2) {
        expect((await requestDuringApply(run.id)).outcome).toBe('requested');
      }
      return written;
    });

    const result = await applyImportRun(tenantId, run.id, { confirmedBy: actorId });
    vi.mocked(recordEvent).mockImplementation(real);

    expect(result).toEqual({ applied: 2, failed: 0, cancelled: true });
    const after = await changesOf(run.id);
    expect(after.filter((c) => c.status === 'applied').map((c) => c.changeType)).toEqual([
      'create_person',
      'create_person',
    ]);
    expect(after.filter((c) => c.status === 'skipped')).toHaveLength(4);
    expect(
      after
        .filter((c) => c.status === 'skipped')
        .every((c) => c.message === 'not applied: the run was cancelled'),
    ).toBe(true);
    // The persons table says exactly what the run says.
    expect(await withTenant(tenantId, (tx) => tx.person.count())).toBe(2);

    const persisted = await withTenant(tenantId, (tx) =>
      tx.personImportRun.findUniqueOrThrow({ where: { id: run.id } }),
    );
    expect(persisted.status).toBe('cancelled');
    expect(persisted.cancelState).toBe('cancelled');
    expect(persisted.confirmedBy).toBe(actorId);
    const honoured = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findFirstOrThrow({ where: { action: 'person_import.run.cancelled' } }),
    );
    expect(honoured.actorUserId).toBe(actorId);
    expect(honoured.payload).toMatchObject({ phase: 'apply', applied: 2, notAttempted: 4 });

    await expect(applyImportRun(tenantId, run.id)).rejects.toBeInstanceOf(RunNotAppliableError);
    await expect(cancel(run.id)).rejects.toBeInstanceOf(RunNotCancellableError);
  });

  it('stops a preview at a read checkpoint and departs nobody', async () => {
    // A person the source already owns. A preview that ran on after the
    // cancellation with a truncated read would propose departing them.
    connectorFor.mockReturnValue(new FakePersonSource([row('e1')]));
    const first = await previewImportRun(tenantId, provider, sourceId);
    await applyImportRun(tenantId, first.id);

    connectorFor.mockReturnValue({
      read: async function* () {
        const running = await withTenant(tenantId, (tx) =>
          tx.personImportRun.findFirstOrThrow({ where: { sourceId, status: 'running' } }),
        );
        expect((await cancel(running.id)).outcome).toBe('requested');
        yield row('e2');
      },
    });

    const run = await previewImportRun(tenantId, provider, sourceId);

    expect(run.status).toBe('cancelled');
    expect(run.cancelState).toBe('cancelled');
    expect(await changesOf(run.id)).toEqual([]);
  });

  it('cancels a run waiting on duplicate review and closes its reviews', async () => {
    await withTenant(tenantId, (tx) =>
      tx.person.create({
        data: { tenantId, givenName: 'Existing', familyName: 'Person', businessEmail: 'e1@example.test' },
      }),
    );
    connectorFor.mockReturnValue(new FakePersonSource([row('e1')]));
    const run = await previewImportRun(tenantId, provider, sourceId);
    expect(run.status).toBe('blocked');
    expect(await listDuplicateReviews(tenantId)).toHaveLength(1);

    const result = await cancel(run.id);

    expect(result).toEqual({ outcome: 'cancelled', previousStatus: 'blocked' });
    expect(await listDuplicateReviews(tenantId)).toEqual([]);
    const [closed] = await listDuplicateReviews(tenantId, 'resolved');
    expect(closed?.resolution).toBe('run_cancelled');
    expect(closed?.reviewedByUserId).toBe(actorId);
    expect((await changesOf(run.id)).every((c) => c.status === 'skipped')).toBe(true);
    await expect(applyImportRun(tenantId, run.id, { confirm: true })).rejects.toThrow();
  });
});
