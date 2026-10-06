import { randomUUID } from 'node:crypto';
import type { TenantClient } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';
import { assertOutboundUrl } from '../net/outbound.js';
import type { MasterKeyProvider } from '../vault/master-key.js';
import { deleteSecret, getSecret, putSecret } from '../vault/vault-service.js';

/**
 * Where a tenant's audit log goes: SIEM destinations, configured in Settings
 * -> SIEM and delivered by `runAuditStreamJob`.
 */
export type StreamTransport = 'https' | 'syslog';
export type StreamFormat = 'json' | 'splunk-hec' | 'cef';

export const FORMATS_FOR: Record<StreamTransport, readonly StreamFormat[]> = {
  https: ['json', 'splunk-hec'],
  syslog: ['json', 'cef'],
};

export interface AuditStreamInput {
  name: string;
  enabled: boolean;
  transport: StreamTransport;
  format: StreamFormat;
  url?: string | null | undefined;
  host?: string | null | undefined;
  port?: number | null | undefined;
  tls?: boolean | undefined;
  authHeader?: string | null | undefined;
  /** The header's value. Undefined keeps the stored one; null removes it. */
  credential?: string | null | undefined;
  /** New streams: only events from now on, or the whole log first. */
  startFrom?: 'now' | 'beginning' | undefined;
}

export type AuditStreamStatus = 'delivering' | 'behind' | 'failing' | 'paused';

/** What a settings screen may read. Never the credential. */
export interface AuditStreamView {
  id: string;
  name: string;
  enabled: boolean;
  transport: StreamTransport;
  format: StreamFormat;
  url: string | null;
  host: string | null;
  port: number | null;
  tls: boolean;
  authHeader: string | null;
  hasCredential: boolean;
  cursor: number;
  /** Events written but not yet delivered. */
  behind: number;
  status: AuditStreamStatus;
  lastDeliveredAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  consecutiveFailures: number;
  nextAttemptAt: string | null;
}

export class AuditStreamInvalidError extends Error {
  constructor(readonly field: string, message: string) {
    super(message);
    this.name = 'AuditStreamInvalidError';
  }
}

export const streamSecretName = (id: string) => `audit-stream:${id}`;

/** More than this many events behind is "behind" rather than "delivering". */
const BEHIND_AFTER = 1000;

type Row = {
  id: string;
  name: string;
  enabled: boolean;
  transport: string;
  format: string;
  url: string | null;
  host: string | null;
  port: number | null;
  tls: boolean;
  authHeader: string | null;
  cursor: number;
  lastDeliveredAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
  consecutiveFailures: number;
  nextAttemptAt: Date | null;
};

function statusOf(row: Row, behind: number): AuditStreamStatus {
  if (!row.enabled) return 'paused';
  if (row.consecutiveFailures > 0) return 'failing';
  return behind > BEHIND_AFTER ? 'behind' : 'delivering';
}

function view(row: Row, latest: number, hasCredential: boolean): AuditStreamView {
  const behind = Math.max(0, latest - row.cursor);
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    transport: row.transport as StreamTransport,
    format: row.format as StreamFormat,
    url: row.url,
    host: row.host,
    port: row.port,
    tls: row.tls,
    authHeader: row.authHeader,
    hasCredential,
    cursor: row.cursor,
    behind,
    status: statusOf(row, behind),
    lastDeliveredAt: row.lastDeliveredAt?.toISOString() ?? null,
    lastError: row.lastError,
    lastErrorAt: row.lastErrorAt?.toISOString() ?? null,
    consecutiveFailures: row.consecutiveFailures,
    nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
  };
}

async function latestSequence(tx: TenantClient): Promise<number> {
  const top = await tx.auditEvent.findFirst({ orderBy: { sequence: 'desc' }, select: { sequence: true } });
  return top?.sequence ?? 0;
}

/**
 * Checks the destination before anything is stored.
 *
 * HTTPS only, unless private addresses are allowed: the whole audit log
 * crossing a network in the clear is not a setting to offer by default. A
 * lab receiver on plain http works where OUTBOUND_ALLOW_PRIVATE is set.
 */
async function validate(input: AuditStreamInput, allowPrivateAddresses: boolean): Promise<void> {
  if (!FORMATS_FOR[input.transport].includes(input.format)) {
    throw new AuditStreamInvalidError('format', `${input.format} is not a format for ${input.transport}.`);
  }
  if (input.transport === 'https') {
    if (!input.url) throw new AuditStreamInvalidError('url', 'URL is required.');
    if (!input.url.startsWith('https://') && !(allowPrivateAddresses && input.url.startsWith('http://'))) {
      throw new AuditStreamInvalidError('url', 'Use an https:// URL.');
    }
    try {
      await assertOutboundUrl(input.url, { allowPrivateAddresses });
    } catch (err) {
      throw new AuditStreamInvalidError('url', err instanceof Error ? err.message : String(err));
    }
    if (input.authHeader && !/^[A-Za-z0-9-]{1,64}$/.test(input.authHeader)) {
      throw new AuditStreamInvalidError('authHeader', 'Header name may use letters, digits and hyphens only.');
    }
  } else {
    if (!input.host || !/^[A-Za-z0-9.:-]{1,253}$/.test(input.host)) {
      throw new AuditStreamInvalidError('host', 'Host is required.');
    }
    if (!input.port || input.port < 1 || input.port > 65535) {
      throw new AuditStreamInvalidError('port', 'Port must be between 1 and 65535.');
    }
  }
}

function fields(input: AuditStreamInput) {
  const https = input.transport === 'https';
  return {
    name: input.name,
    enabled: input.enabled,
    transport: input.transport,
    format: input.format,
    url: https ? (input.url ?? null) : null,
    host: https ? null : (input.host ?? null),
    port: https ? null : (input.port ?? null),
    tls: https ? true : (input.tls ?? true),
    authHeader: https ? (input.authHeader || null) : null,
  };
}

export async function listAuditStreams(tx: TenantClient): Promise<AuditStreamView[]> {
  const [rows, latest, secrets] = await Promise.all([
    tx.auditStream.findMany({ orderBy: { name: 'asc' } }),
    latestSequence(tx),
    tx.secret.findMany({ where: { name: { startsWith: 'audit-stream:' } }, select: { name: true } }),
  ]);
  const sealed = new Set(secrets.map((secret) => secret.name));
  return rows.map((row) => view(row, latest, sealed.has(streamSecretName(row.id))));
}

export async function createAuditStream(
  tx: TenantClient,
  provider: MasterKeyProvider,
  input: AuditStreamInput,
  options: { allowPrivateAddresses: boolean },
): Promise<AuditStreamView> {
  await validate(input, options.allowPrivateAddresses);
  const tenantId = await currentTenant(tx);
  const latest = await latestSequence(tx);
  const row = await tx.auditStream.create({
    data: {
      id: randomUUID(),
      tenantId,
      ...fields(input),
      cursor: input.startFrom === 'beginning' ? 0 : latest,
    },
  });
  if (input.credential) await putSecret(tx, provider, streamSecretName(row.id), input.credential);
  return view(row, latest, Boolean(input.credential));
}

export async function updateAuditStream(
  tx: TenantClient,
  provider: MasterKeyProvider,
  id: string,
  input: AuditStreamInput,
  options: { allowPrivateAddresses: boolean },
): Promise<AuditStreamView | null> {
  const existing = await tx.auditStream.findFirst({ where: { id } });
  if (!existing) return null;
  await validate(input, options.allowPrivateAddresses);
  const row = await tx.auditStream.update({
    where: { id },
    // A changed destination gets a fresh start: the old one's failures and
    // backoff say nothing about the new one.
    data: { ...fields(input), consecutiveFailures: 0, nextAttemptAt: null, lastError: null, lastErrorAt: null },
  });
  if (input.credential === null) await deleteSecret(tx, streamSecretName(id));
  else if (input.credential) await putSecret(tx, provider, streamSecretName(id), input.credential);
  const hasCredential = (await getSecret(tx, provider, streamSecretName(id))) !== null;
  return view(row, await latestSequence(tx), hasCredential);
}

export async function deleteAuditStream(tx: TenantClient, id: string): Promise<boolean> {
  const { count } = await tx.auditStream.deleteMany({ where: { id } });
  await deleteSecret(tx, streamSecretName(id));
  return count > 0;
}
