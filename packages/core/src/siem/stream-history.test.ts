import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { recordEvent } from '../audit/audit-service.js';
import { localMasterKeyProvider } from '../vault/master-key.js';
import { DELIVERY_HISTORY, runAuditStreamJob, testAuditStream, type HttpsPoster } from './stream-jobs.js';
import {
  AuditStreamInvalidError,
  createAuditStream,
  listAuditStreamDeliveries,
  listAuditStreams,
  replayAuditStream,
  type AuditStreamInput,
} from './stream-service.js';

const provider = localMasterKeyProvider(Buffer.alloc(32, 7));
let tenantId: string;
let clock: number;
const now = () => new Date(clock);
const options = { host: 'idm.acme.example', version: '1.22.0', allowPrivateAddresses: true, now };

async function event(action: string, outcome: 'success' | 'failure' = 'success') {
  await withTenant(tenantId, (tx) =>
    recordEvent(tx, { actorUserId: null, action, targetType: 'Test', targetId: null, outcome, sourceIp: null, payload: {} }),
  );
}

async function stream(input: Partial<AuditStreamInput> = {}) {
  return withTenant(tenantId, (tx) =>
    createAuditStream(
      tx,
      provider,
      { name: 'SIEM', enabled: true, transport: 'https', format: 'json', url: 'http://127.0.0.1:9/ingest', startFrom: 'beginning', ...input },
      { allowPrivateAddresses: true },
    ),
  );
}

const state = async () => (await withTenant(tenantId, (tx) => listAuditStreams(tx)))[0]!;
const history = (id: string) => withTenant(tenantId, (tx) => listAuditStreamDeliveries(tx, id));

/** Collects the sequences and actions each batch carried. */
function collector() {
  const batches: { sequence: number; action: string }[][] = [];
  const https: HttpsPoster = async (_url, body) => {
    batches.push(JSON.parse(body));
  };
  return { batches, https };
}

beforeEach(async () => {
  await resetDatabase();
  tenantId = (await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } })).id;
  clock = Date.UTC(2026, 9, 7, 12);
});

describe('SIEM stream filters', () => {
  it('sends only matching actions and outcomes, and moves past the rest', async () => {
    await event('auth.login');
    await event('user.created');
    await event('auth.login', 'failure');
    await event('provision.run');
    await event('auth.logout', 'failure');
    const created = await stream({ actionPrefixes: ['auth.*', ' AUTH. ', ''], outcome: 'failure' });
    expect(created).toMatchObject({ actionPrefixes: ['auth.'], outcome: 'failure', behind: 2 });

    const { batches, https } = collector();
    await runAuditStreamJob(provider, { tenantId }, { ...options, https });
    expect(batches.flat().map((e) => e.sequence)).toEqual([3, 5]);
    // The cursor passes the events the filter left out, so nothing is "behind".
    expect(await state()).toMatchObject({ cursor: 5, behind: 0 });

    // Only unrelated events since: the cursor still moves, nothing is sent.
    await event('user.updated');
    await runAuditStreamJob(provider, { tenantId }, { ...options, https });
    expect(batches).toHaveLength(1);
    expect((await state()).cursor).toBe(6);
  });

  it('refuses a prefix that is not one', async () => {
    await expect(stream({ actionPrefixes: ['auth login'] })).rejects.toThrow(AuditStreamInvalidError);
  });
});

describe('SIEM delivery history', () => {
  it('records each batch, each failure with its reason, and each test', async () => {
    const created = await stream();
    for (let i = 0; i < 3; i++) await event(`test.event_${i}`);
    await runAuditStreamJob(provider, { tenantId }, { ...options, https: collector().https });

    await event('test.event_3');
    clock += 60_000;
    await runAuditStreamJob(provider, { tenantId }, {
      ...options,
      https: async () => {
        throw new Error('HTTP 503: Service Unavailable');
      },
    });
    clock += 60_000;
    await testAuditStream(provider, tenantId, created.id, { ...options, https: collector().https });

    const rows = await history(created.id);
    expect(rows!.map(({ kind, firstSequence, lastSequence, count, ok, error }) => ({ kind, firstSequence, lastSequence, count, ok, error }))).toEqual([
      { kind: 'test', firstSequence: null, lastSequence: null, count: 1, ok: true, error: null },
      { kind: 'batch', firstSequence: 4, lastSequence: 4, count: 1, ok: false, error: 'HTTP 503: Service Unavailable' },
      { kind: 'batch', firstSequence: 1, lastSequence: 3, count: 3, ok: true, error: null },
    ]);
  });

  it(`keeps the newest ${DELIVERY_HISTORY} per stream`, async () => {
    const created = await stream();
    await withTenant(tenantId, (tx) =>
      tx.auditStreamDelivery.createMany({
        data: Array.from({ length: DELIVERY_HISTORY + 5 }, (_, i) => ({
          tenantId,
          streamId: created.id,
          kind: 'batch',
          firstSequence: 1,
          lastSequence: 1,
          count: 1,
          ok: true,
          durationMs: 1,
          at: new Date(clock - (DELIVERY_HISTORY + 5 - i) * 1000),
        })),
      }),
    );
    await event('test.event');
    await runAuditStreamJob(provider, { tenantId }, { ...options, https: collector().https });
    expect(await withTenant(tenantId, (tx) => tx.auditStreamDelivery.count())).toBe(DELIVERY_HISTORY);
    expect((await history(created.id))![0]).toMatchObject({ firstSequence: 1, count: 1 });
  });
});

describe('SIEM resend', () => {
  it('moves the cursor to the beginning, a sequence, a time or now', async () => {
    for (let i = 0; i < 5; i++) {
      await event(`test.event_${i}`);
      // Distinct timestamps, so "from the time of #3" cannot also match #2.
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const created = await stream({ startFrom: 'now' });
    const replay = (from: Parameters<typeof replayAuditStream>[2]) => withTenant(tenantId, (tx) => replayAuditStream(tx, created.id, from));

    expect((await replay({ from: 'beginning' }))!).toMatchObject({ previousCursor: 5, stream: { cursor: 0, behind: 5 } });
    expect((await replay({ from: 'sequence', sequence: 4 }))!.stream.cursor).toBe(3);
    const third = await withTenant(tenantId, (tx) => tx.auditEvent.findFirstOrThrow({ where: { sequence: 3 } }));
    expect((await replay({ from: 'time', at: third.occurredAt }))!.stream.cursor).toBe(2);
    expect((await replay({ from: 'time', at: new Date(Date.UTC(2030, 0, 1)) }))!.stream.cursor).toBe(5);
    expect((await replay({ from: 'now' }))!.stream).toMatchObject({ cursor: 5, behind: 0 });
    await expect(replay({ from: 'sequence', sequence: 99 })).rejects.toThrow('The newest event is 5.');

    await replay({ from: 'sequence', sequence: 2 });
    const { batches, https } = collector();
    await runAuditStreamJob(provider, { tenantId }, { ...options, https });
    expect(batches.flat().map((e) => e.sequence)).toEqual([2, 3, 4, 5]);
  });

  it('clears failures and backoff so delivery restarts at once', async () => {
    const created = await stream();
    await event('test.event');
    await runAuditStreamJob(provider, { tenantId }, {
      ...options,
      https: async () => {
        throw new Error('HTTP 500');
      },
    });
    expect(await state()).toMatchObject({ status: 'failing', consecutiveFailures: 1 });
    await withTenant(tenantId, (tx) => replayAuditStream(tx, created.id, { from: 'beginning' }));
    expect(await state()).toMatchObject({ status: 'delivering', consecutiveFailures: 0, nextAttemptAt: null, lastError: null });
  });

  it('wins over a delivery already under way', async () => {
    const created = await stream();
    for (let i = 0; i < 3; i++) await event(`test.event_${i}`);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const running = runAuditStreamJob(provider, { tenantId }, {
      ...options,
      https: async () => {
        await gate;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await withTenant(tenantId, (tx) => replayAuditStream(tx, created.id, { from: 'beginning' }));
    release();
    await running;
    // The batch that was in flight did not move the cursor past the resend.
    expect((await state()).cursor).toBe(0);
  });
});
