import { createServer, type Server } from 'node:net';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { recordEvent } from '../audit/audit-service.js';
import { listIncidents } from '../health/incidents.js';
import { localMasterKeyProvider } from '../vault/master-key.js';
import { runAuditStreamJob, testAuditStream, type HttpsPoster } from './stream-jobs.js';
import { createAuditStream, listAuditStreams } from './stream-service.js';
import { syslogSender } from './syslog-sender.js';

const provider = localMasterKeyProvider(Buffer.alloc(32, 7));
let tenantId: string;
let clock: number;
const now = () => new Date(clock);
const options = { host: 'idm.acme.example', version: '1.22.0', allowPrivateAddresses: true, now };

async function events(n: number) {
  for (let i = 0; i < n; i++) {
    await withTenant(tenantId, (tx) =>
      recordEvent(tx, { actorUserId: null, action: `test.event_${i}`, targetType: 'Test', targetId: null, outcome: 'success', sourceIp: null, payload: { i } }),
    );
  }
}

async function stream(input: Partial<Parameters<typeof createAuditStream>[2]> = {}) {
  return withTenant(tenantId, (tx) =>
    createAuditStream(
      tx,
      provider,
      { name: 'SIEM', enabled: true, transport: 'https', format: 'json', url: 'http://127.0.0.1:9/ingest', authHeader: 'Authorization', credential: 'Bearer s3cret', startFrom: 'beginning', ...input },
      { allowPrivateAddresses: true },
    ),
  );
}

const state = async () => (await withTenant(tenantId, (tx) => listAuditStreams(tx)))[0]!;

beforeEach(async () => {
  await resetDatabase();
  tenantId = (await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } })).id;
  clock = Date.UTC(2026, 9, 6, 12);
});

describe('audit streaming', () => {
  it('delivers every event in order, in batches, with the credential, and moves the cursor', async () => {
    await events(5);
    await stream();
    await events(250);
    const batches: { body: string; headers: Record<string, string> }[] = [];
    const https: HttpsPoster = async (_url, body, headers) => {
      batches.push({ body, headers });
    };
    await runAuditStreamJob(provider, { tenantId }, { ...options, https });

    const sequences = batches.flatMap((batch) => (JSON.parse(batch.body) as { sequence: number }[]).map((e) => e.sequence));
    expect(batches.map((b) => JSON.parse(b.body).length)).toEqual([200, 55]);
    expect(sequences).toEqual(Array.from({ length: 255 }, (_, i) => i + 1));
    expect(batches[0]!.headers['Authorization']).toBe('Bearer s3cret');
    expect(await state()).toMatchObject({ cursor: 255, behind: 0, status: 'delivering', consecutiveFailures: 0 });
  });

  it('starts from now when asked, and sends nothing old', async () => {
    await events(3);
    await stream({ startFrom: 'now' });
    await events(1);
    const sent: number[] = [];
    await runAuditStreamJob(provider, { tenantId }, { ...options, https: async (_u, body) => void sent.push(...JSON.parse(body).map((e: { sequence: number }) => e.sequence)) });
    expect(sent).toEqual([4]);
  });

  it('keeps the cursor on a failure, backs off, and raises an incident after three', async () => {
    await stream();
    await events(10);
    const failing: HttpsPoster = async () => {
      throw new Error('HTTP 503: Service Unavailable');
    };
    await runAuditStreamJob(provider, { tenantId }, { ...options, https: failing });
    expect(await state()).toMatchObject({ cursor: 0, consecutiveFailures: 1, status: 'failing', lastError: 'HTTP 503: Service Unavailable' });
    expect((await state()).nextAttemptAt).toBe(new Date(clock + 60_000).toISOString());

    // Not due yet: nothing is attempted.
    let attempts = 0;
    const counting: HttpsPoster = async () => {
      attempts += 1;
      throw new Error('HTTP 503');
    };
    await runAuditStreamJob(provider, { tenantId }, { ...options, https: counting });
    expect(attempts).toBe(0);

    clock += 61_000;
    await runAuditStreamJob(provider, { tenantId }, { ...options, https: counting });
    clock += 121_000;
    await runAuditStreamJob(provider, { tenantId }, { ...options, https: counting });
    expect(await state()).toMatchObject({ consecutiveFailures: 3, cursor: 0 });
    const incidents = await withTenant(tenantId, (tx) => listIncidents(tx, now()));
    expect(incidents.find((incident) => incident.kind === 'siem_export_failing')).toMatchObject({
      severity: 'critical',
      items: [expect.objectContaining({ label: 'SIEM', detail: 'HTTP 503' })],
    });

    // Recovery clears the failures and delivers everything held back.
    clock += 300_000;
    const delivered: number[] = [];
    await runAuditStreamJob(provider, { tenantId }, { ...options, https: async (_u, body) => void delivered.push(...JSON.parse(body).map((e: { sequence: number }) => e.sequence)) });
    expect(delivered).toHaveLength(10);
    expect(await state()).toMatchObject({ consecutiveFailures: 0, cursor: 10, status: 'delivering', lastError: null });
  });

  it('lets only one runner hold a stream at a time', async () => {
    await stream();
    await events(3);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    const slow: HttpsPoster = async () => {
      calls += 1;
      await gate;
    };
    const first = runAuditStreamJob(provider, { tenantId }, { ...options, https: slow });
    // Give the first runner time to take the lease and start sending.
    await new Promise((resolve) => setTimeout(resolve, 200));
    await runAuditStreamJob(provider, { tenantId }, { ...options, https: slow });
    release();
    await first;
    expect(calls).toBe(1);
  });

  it('sends RFC 5424 frames over TCP to a real listener', async () => {
    const received: string[] = [];
    const server: Server = createServer((socket) => {
      let data = '';
      socket.setEncoding('utf8').on('data', (chunk: string) => (data += chunk)).on('end', () => received.push(data));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as { port: number }).port;
    try {
      await stream({ transport: 'syslog', format: 'cef', url: null, host: '127.0.0.1', port, tls: false });
      await events(2);
      await runAuditStreamJob(provider, { tenantId }, { ...options, syslog: syslogSender({ allowPrivateAddresses: true }) });
      await new Promise((resolve) => setTimeout(resolve, 100));
      const stream0 = received.join('');
      const frames: string[] = [];
      let rest = stream0;
      while (rest.length) {
        const space = rest.indexOf(' ');
        const length = Number(rest.slice(0, space));
        const body = Buffer.from(rest.slice(space + 1), 'utf8').subarray(0, length).toString('utf8');
        frames.push(body);
        rest = rest.slice(space + 1 + body.length);
      }
      expect(frames).toHaveLength(2);
      expect(frames[0]).toMatch(/^<109>1 \S+ idm\.acme\.example syntra - test\.event_0 \[syntra@32473 tenant="acme" sequence="1" outcome="success"\] CEF:0\|Syntra\|Syntra\|1\.22\.0\|test\.event_0\|/);
      expect(await state()).toMatchObject({ cursor: 2, status: 'delivering' });
    } finally {
      server.close();
    }
  });

  it('refuses a private syslog address unless private addresses are allowed', async () => {
    await expect(syslogSender({ allowPrivateAddresses: false })({ host: '127.0.0.1', port: 514, tls: false }, ['x'])).rejects.toThrow(
      '127.0.0.1 resolves to a private network address. Set OUTBOUND_ALLOW_PRIVATE=true to allow it.',
    );
  });

  it('sends a test event that is not in the log and does not move the cursor', async () => {
    const created = await stream({ startFrom: 'now' });
    let body = '';
    await testAuditStream(provider, tenantId, created.id, { ...options, https: async (_u, b) => void (body = b) });
    expect(JSON.parse(body)[0]).toMatchObject({ action: 'audit_stream.test', sequence: 0, tenant: 'acme' });
    expect(await withTenant(tenantId, (tx) => tx.auditEvent.count())).toBe(0);
    expect((await state()).cursor).toBe(0);
  });
});
