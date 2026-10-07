import { randomUUID } from 'node:crypto';
import { prisma, withTenant, type TenantClient } from '@syntra/db';
import type { Scheduler } from '../jobs/scheduler.js';
import { guardedFetch } from '../net/guarded-fetch.js';
import type { MasterKeyProvider } from '../vault/master-key.js';
import { getSecret } from '../vault/vault-service.js';
import { scrubText } from '@syntra/connectors';
import {
  httpsJsonBody,
  octetFrame,
  splunkHecBody,
  syslogMessage,
  type StreamableEvent,
  type StreamContext,
} from './stream-format.js';
import { latestSequence, streamFilter, streamSecretName, type StreamFormat, type StreamTransport } from './stream-service.js';
import { syslogSender, type SyslogSender } from './syslog-sender.js';

export const AUDIT_STREAM_JOB = 'audit.stream';

export interface AuditStreamJobPayload {
  tenantId: string;
}

export const auditStreamScheduleKey = (tenantId: string) => `audit-stream/${tenantId}`;

/** Every minute, per tenant, as webhook delivery is. */
export async function applyAuditStreamSchedule(scheduler: Scheduler, tenantId: string): Promise<void> {
  await scheduler.schedule(AUDIT_STREAM_JOB, '* * * * *', { tenantId } satisfies AuditStreamJobPayload, auditStreamScheduleKey(tenantId));
}

export type HttpsPoster = (url: string, body: string, headers: Record<string, string>) => Promise<void>;

/** POSTs a batch; anything but a 2xx is a failure that names the status. */
export function httpsPoster(allowPrivateAddresses: boolean): HttpsPoster {
  const send = guardedFetch({ allowPrivateAddresses, timeoutMs: 30_000 });
  return async (url, body, headers) => {
    const response = await send(url, { method: 'POST', body, headers });
    if (response.status < 200 || response.status > 299) {
      const text = (await response.text().catch(() => '')).slice(0, 200);
      throw new Error(`HTTP ${response.status}${text ? `: ${text}` : ''}`);
    }
  };
}

export interface AuditStreamJobOptions {
  now?: () => Date;
  https?: HttpsPoster;
  syslog?: SyslogSender;
  allowPrivateAddresses?: boolean;
  /** PUBLIC_URL's host, as the events' `host`. */
  host: string;
  version: string;
  batchSize?: number;
  /** Stop starting new batches after this long; the next minute continues. */
  budgetMs?: number;
}

const LEASE_MS = 2 * 60_000;
/** Deliveries kept per stream in its history. */
export const DELIVERY_HISTORY = 500;
const MAX_BACKOFF_MS = 30 * 60_000;

/** 1, 2, 4 ... minutes after each consecutive failure, at most 30. */
export const streamBackoffMs = (failures: number) => Math.min(60_000 * 2 ** Math.max(0, failures - 1), MAX_BACKOFF_MS);

export interface StreamTarget {
  transport: StreamTransport;
  format: StreamFormat;
  url: string | null;
  host: string | null;
  port: number | null;
  tls: boolean;
  authHeader: string | null;
  credential: string | null;
}

/** Sends one batch to one destination. Throws with the receiver's reason. */
export async function sendBatch(
  target: StreamTarget,
  events: StreamableEvent[],
  ctx: StreamContext,
  senders: { https: HttpsPoster; syslog: SyslogSender },
): Promise<void> {
  if (target.transport === 'https') {
    const body = target.format === 'splunk-hec' ? splunkHecBody(events, ctx) : httpsJsonBody(events, ctx);
    const headers: Record<string, string> = { 'content-type': 'application/json', 'user-agent': `Syntra/${ctx.version}` };
    if (target.authHeader && target.credential) headers[target.authHeader] = target.credential;
    await senders.https(target.url!, body, headers);
    return;
  }
  const format = target.format === 'cef' ? 'cef' : 'json';
  const frames = events.map((event) => octetFrame(syslogMessage(event, ctx, format)));
  await senders.syslog({ host: target.host!, port: target.port!, tls: target.tls }, frames);
}

/**
 * Delivers each of a tenant's enabled streams that is due: batches of audit
 * events after its cursor, oldest first, until it has caught up or the
 * budget is spent. The cursor moves only after a batch is accepted, so a
 * failure means the same events next time, never a gap.
 */
export async function runAuditStreamJob(
  provider: MasterKeyProvider,
  payload: AuditStreamJobPayload,
  options: AuditStreamJobOptions,
): Promise<void> {
  const now = options.now ?? (() => new Date());
  const allowPrivate = options.allowPrivateAddresses ?? false;
  const senders = {
    https: options.https ?? httpsPoster(allowPrivate),
    syslog: options.syslog ?? syslogSender({ allowPrivateAddresses: allowPrivate }),
  };
  const batchSize = options.batchSize ?? 200;
  const deadline = now().getTime() + (options.budgetMs ?? 45_000);

  const tenant = await prisma.tenant.findUnique({ where: { id: payload.tenantId }, select: { slug: true } });
  if (!tenant) return;
  const ctx: StreamContext = { tenant: tenant.slug, host: options.host, version: options.version };

  const due = await withTenant(payload.tenantId, (tx) =>
    tx.auditStream.findMany({
      where: { enabled: true, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now() } }] },
      select: { id: true },
    }),
  );

  for (const { id } of due) {
    // The lease: a conditional update that only one replica can win.
    const claimed = await withTenant(payload.tenantId, (tx) =>
      tx.auditStream.updateMany({
        where: { id, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now() } }] },
        data: { leaseUntil: new Date(now().getTime() + LEASE_MS) },
      }),
    );
    if (claimed.count === 0) continue;
    try {
      await deliverOne(provider, payload.tenantId, id, ctx, senders, batchSize, deadline, now);
    } finally {
      await withTenant(payload.tenantId, (tx) => tx.auditStream.updateMany({ where: { id }, data: { leaseUntil: null } }));
    }
  }
}

async function deliverOne(
  provider: MasterKeyProvider,
  tenantId: string,
  id: string,
  ctx: StreamContext,
  senders: { https: HttpsPoster; syslog: SyslogSender },
  batchSize: number,
  deadline: number,
  now: () => Date,
): Promise<void> {
  const loaded = await withTenant(tenantId, async (tx) => {
    const stream = await tx.auditStream.findFirst({ where: { id } });
    if (!stream) return null;
    const credential = await getSecret(tx, provider, streamSecretName(id));
    return { stream, credential };
  });
  if (!loaded) return;
  const { stream, credential } = loaded;
  const target: StreamTarget = { ...stream, transport: stream.transport as StreamTransport, format: stream.format as StreamFormat, credential };
  let cursor = stream.cursor;
  let failures = stream.consecutiveFailures;
  const filter = streamFilter(stream);
  let recorded = false;

  while (now().getTime() < deadline) {
    // Events at or below the ceiling are all the stream will see this round,
    // so a cursor moved to it skips only events the filter left out.
    const ceiling = await withTenant(tenantId, (tx) => latestSequence(tx));
    if (ceiling <= cursor) break;
    const events = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({
        where: { sequence: { gt: cursor, lte: ceiling }, ...filter },
        orderBy: { sequence: 'asc' },
        take: batchSize,
      }),
    );
    const next = events.length < batchSize ? ceiling : events.at(-1)!.sequence;
    if (events.length > 0) {
      const started = Date.now();
      try {
        await sendBatch(target, events, ctx, senders);
      } catch (err) {
        failures += 1;
        const message = scrubText(err instanceof Error ? err.message : String(err), 300);
        await withTenant(tenantId, async (tx) => {
          await recordDelivery(tx, tenantId, id, events, false, message, Date.now() - started);
          await tx.auditStream.updateMany({
            where: { id, cursor, generation: stream.generation },
            data: {
              consecutiveFailures: failures,
              lastError: message,
              lastErrorAt: now(),
              nextAttemptAt: new Date(now().getTime() + streamBackoffMs(failures)),
            },
          });
        });
        recorded = true;
        break;
      }
      await withTenant(tenantId, (tx) => recordDelivery(tx, tenantId, id, events, true, null, Date.now() - started));
      recorded = true;
    }
    // Conditional on the cursor and generation this round started from: a
    // resend meanwhile wins, and this runner stops.
    const moved = await withTenant(tenantId, (tx) =>
      tx.auditStream.updateMany({
        where: { id, cursor, generation: stream.generation },
        data: {
          cursor: next,
          ...(events.length > 0 ? { lastDeliveredAt: now(), consecutiveFailures: 0, lastError: null, nextAttemptAt: null } : {}),
        },
      }),
    );
    if (moved.count === 0) break;
    cursor = next;
    failures = 0;
    if (events.length < batchSize) break;
  }
  if (recorded) await withTenant(tenantId, (tx) => pruneDeliveries(tx, id));
}

async function recordDelivery(
  tx: TenantClient,
  tenantId: string,
  streamId: string,
  events: StreamableEvent[],
  ok: boolean,
  error: string | null,
  durationMs: number,
): Promise<void> {
  await tx.auditStreamDelivery.create({
    data: {
      tenantId,
      streamId,
      kind: 'batch',
      firstSequence: events[0]!.sequence,
      lastSequence: events.at(-1)!.sequence,
      count: events.length,
      ok,
      error,
      durationMs,
    },
  });
}

/** Keeps the newest DELIVERY_HISTORY deliveries of a stream. */
async function pruneDeliveries(tx: TenantClient, streamId: string): Promise<void> {
  const oldestKept = await tx.auditStreamDelivery.findFirst({
    where: { streamId },
    orderBy: { at: 'desc' },
    skip: DELIVERY_HISTORY - 1,
    select: { at: true },
  });
  if (oldestKept) await tx.auditStreamDelivery.deleteMany({ where: { streamId, at: { lt: oldestKept.at } } });
}

/**
 * Sends one made-up event to a stream's destination, so Test in the console
 * proves the address, the credential and the format before real events go.
 * Not an audit event: it is not in the log and does not move the cursor.
 */
export async function testAuditStream(
  provider: MasterKeyProvider,
  tenantId: string,
  id: string,
  options: AuditStreamJobOptions,
): Promise<void> {
  const allowPrivate = options.allowPrivateAddresses ?? false;
  const loaded = await withTenant(tenantId, async (tx) => {
    const stream = await tx.auditStream.findFirst({ where: { id } });
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { slug: true } });
    if (!stream || !tenant) return null;
    return { stream, tenant, credential: await getSecret(tx, provider, streamSecretName(id)) };
  });
  if (!loaded) throw new Error('No such stream.');
  const now = (options.now ?? (() => new Date()))();
  const event: StreamableEvent = {
    id: randomUUID(),
    sequence: 0,
    occurredAt: now,
    actorUserId: null,
    action: 'audit_stream.test',
    targetType: 'AuditStream',
    targetId: id,
    outcome: 'success',
    sourceIp: null,
    correlationId: null,
    payload: { test: true, stream: loaded.stream.name },
    hash: '',
    prevHash: '',
  };
  const started = Date.now();
  let error: string | null = null;
  try {
    await sendBatch(
      { ...loaded.stream, transport: loaded.stream.transport as StreamTransport, format: loaded.stream.format as StreamFormat, credential: loaded.credential },
      [event],
      { tenant: loaded.tenant.slug, host: options.host, version: options.version },
      {
        https: options.https ?? httpsPoster(allowPrivate),
        syslog: options.syslog ?? syslogSender({ allowPrivateAddresses: allowPrivate }),
      },
    );
  } catch (err) {
    error = scrubText(err instanceof Error ? err.message : String(err), 300);
    throw err;
  } finally {
    await withTenant(tenantId, async (tx) => {
      await tx.auditStreamDelivery.create({
        data: { tenantId, streamId: id, kind: 'test', count: 1, ok: error === null, error, durationMs: Date.now() - started },
      });
      await pruneDeliveries(tx, id);
    });
  }
}

export function registerAuditStreamJobs(
  scheduler: Scheduler,
  provider: MasterKeyProvider,
  options: Omit<AuditStreamJobOptions, 'now' | 'https' | 'syslog'>,
): void {
  scheduler.register<AuditStreamJobPayload>(AUDIT_STREAM_JOB, async (payload) => {
    await runAuditStreamJob(provider, payload, options);
  });
}
