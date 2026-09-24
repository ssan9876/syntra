import { createHash } from 'node:crypto';
import { withTenant, type TenantClient } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import { auditSearchSql, type AuditEventRow, type AuditSearchFilters } from '../audit/audit-search.js';
import { governAccessCsv } from '../govern/export-service.js';
import { governReadScope, holdsGovernPermission, type GovernScope } from '../govern/scope.js';
import { enqueueForRow } from '../jobs/enqueue-for-row.js';
import type { Scheduler } from '../jobs/scheduler.js';
import { PERMISSIONS, type Permission } from '../rbac/permissions.js';
import { hasPermission } from '../rbac/rbac-service.js';
import { createEnvelopeSealer, openEnvelope } from '../vault/vault-service.js';
import { SupportBundleWindowError, supportBundleWindow } from './support-bundle-window.js';
import type { MasterKeyProvider } from '../vault/master-key.js';

/**
 * The secure export service (backlog #48).
 *
 * An export is a copy of tenant data leaving every control that governs the
 * data itself, so each step is a control of its own:
 *
 *  1. REQUEST. A row is written and a job queued. The requester's authority
 *     for the kind is checked, and the request is audited.
 *  2. GENERATE. A pg-boss job re-checks the requester's authority AS IT STANDS
 *     THEN -- a role removed while the job waited stops the export -- and
 *     builds the file in bounded batches. Every file carries a watermark
 *     naming the export, the requesting user, the tenant and the generation
 *     time: a header record in JSON Lines, leading columns on every row of a
 *     CSV. The plaintext's SHA-256 is recorded; the bytes are sealed with the
 *     vault's envelope (a fresh AES-256-GCM data key, wrapped by the master
 *     key) and stored in PostgreSQL. Nothing is written to disk.
 *  3. DOWNLOAD. Only the requester, only while ready and unexpired, and only if
 *     their authority still holds AND is the same authority the file was
 *     generated under (a Govern export generated for the whole tenant is not
 *     handed to somebody now scoped to one department). The digest is
 *     re-verified after decryption. Every download and every refusal is
 *     audited.
 *  4. END. Expiry (1-72 hours after ready, 24 by default) or revocation erases
 *     the ciphertext -- a database constraint refuses a terminal row that
 *     still holds it -- and a sweep job erases whatever expired unattended.
 *     The row stays, as the record of who took what.
 */

export const EXPORT_KINDS = ['audit_log', 'govern_access', 'support_bundle'] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

export type ExportStatus = 'queued' | 'running' | 'ready' | 'failed' | 'revoked' | 'expired';

export const EXPORT_JOB = 'exports.generate';
export const EXPORT_SWEEP_JOB = 'exports.sweep';

export const EXPORT_TTL_DEFAULT_HOURS = 24;
export const EXPORT_TTL_MAX_HOURS = 72;
/**
 * The largest file this service will seal. The whole ciphertext is one
 * `bytea` and one buffer in the API process, so the bound is what keeps an
 * export from being a way to exhaust either. A request over it fails with a
 * sentence saying to narrow the filters, rather than producing a truncated
 * file that looks complete.
 */
export const EXPORT_MAX_BYTES = 64 * 1024 * 1024;
/** Rows read per transaction while generating. */
export const EXPORT_BATCH_ROWS = 1000;
/** A queued or running export older than this was abandoned by its worker. */
export const EXPORT_ABANDONED_AFTER_MS = 2 * 60 * 60 * 1000;

const FORMAT: Record<ExportKind, { format: 'jsonl' | 'csv'; contentType: string; stem: string }> = {
  audit_log: { format: 'jsonl', contentType: 'application/x-ndjson; charset=utf-8', stem: 'audit-log' },
  govern_access: { format: 'csv', contentType: 'text/csv; charset=utf-8', stem: 'govern-access' },
  support_bundle: { format: 'jsonl', contentType: 'application/x-ndjson; charset=utf-8', stem: 'support-bundle' },
};

/**
 * The permissions a kind needs, for the API's machine-token scope check. The
 * token's scopes must include every one: an export is an intersection of the
 * account's authority and the token's, as every other route is.
 */
export function exportPermissions(kind: ExportKind): Permission[] {
  if (kind === 'audit_log') return [PERMISSIONS.AUDIT_READ];
  // The support bundle describes the whole tenant's configuration and
  // operations, so it needs authority over the whole tenant.
  if (kind === 'support_bundle') return [PERMISSIONS.TENANT_MANAGE];
  return [PERMISSIONS.GOVERN_READ, PERMISSIONS.GOVERN_EXPORT];
}

export type ExportRefusal =
  | 'forbidden'
  | 'not_found'
  | 'not_ready'
  | 'failed'
  | 'expired'
  | 'revoked'
  | 'authority_changed'
  | 'state';

export class ExportRefusedError extends Error {
  constructor(
    readonly code: ExportRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'ExportRefusedError';
  }
}

export interface ExportAuthority {
  allowed: boolean;
  /**
   * What a file generated now would be allowed to contain. `tenant`, or
   * `org-units:` and a digest of the sorted unit ids of a Govern scope.
   */
  fingerprint: string | null;
  governScope?: GovernScope;
}

function scopeFingerprint(scope: GovernScope): string {
  if (scope.kind !== 'orgUnits') return scope.kind;
  const ids = [...scope.orgUnitIds].sort().join(',');
  return `org-units:${createHash('sha256').update(ids).digest('hex').slice(0, 32)}`;
}

/**
 * Whether `userId` may have an export of `kind` now, and under what authority.
 *
 * The Govern kind asks the Govern questions (`governReadScope` and
 * `holdsGovernPermission`), not Core's unscoped `hasPermission`, for the
 * reason `scope.ts` records: a department lead whose one scoped role carries
 * `govern.read` and `govern.export` may export their department.
 */
export async function exportAuthority(
  tx: TenantClient,
  userId: string,
  kind: ExportKind,
): Promise<ExportAuthority> {
  if (kind === 'audit_log' || kind === 'support_bundle') {
    const allowed = await hasPermission(tx, userId, exportPermissions(kind)[0]!);
    return { allowed, fingerprint: allowed ? 'tenant' : null };
  }
  const scope = await governReadScope(tx, userId);
  if (scope.kind === 'none') return { allowed: false, fingerprint: null };
  const exporter = await holdsGovernPermission(tx, userId, PERMISSIONS.GOVERN_EXPORT);
  if (!exporter) return { allowed: false, fingerprint: null };
  return { allowed: true, fingerprint: scopeFingerprint(scope), governScope: scope };
}

/** The columns every list and status read returns. Never the sealed bytes. */
const SUMMARY = {
  id: true,
  kind: true,
  status: true,
  params: true,
  format: true,
  requestedByUserId: true,
  requestedViaToken: true,
  requestedAt: true,
  ttlHours: true,
  startedAt: true,
  completedAt: true,
  expiresAt: true,
  rowCount: true,
  byteLength: true,
  sha256: true,
  filename: true,
  error: true,
  revokedAt: true,
  revokedByUserId: true,
  purgedAt: true,
  downloadCount: true,
  lastDownloadedAt: true,
} as const;

export interface ExportSummary {
  id: string;
  kind: string;
  status: string;
  params: unknown;
  format: string;
  requestedByUserId: string;
  requestedViaToken: boolean;
  requestedAt: Date;
  ttlHours: number;
  startedAt: Date | null;
  completedAt: Date | null;
  expiresAt: Date | null;
  rowCount: number | null;
  byteLength: number | null;
  sha256: string | null;
  filename: string | null;
  error: string | null;
  revokedAt: Date | null;
  revokedByUserId: string | null;
  purgedAt: Date | null;
  downloadCount: number;
  lastDownloadedAt: Date | null;
}

/**
 * A ready export whose expiry has passed is expired, whether or not the sweep
 * has reached it yet. The download refuses it on the same rule; this is so
 * the list does not offer a button the server will refuse.
 */
function effective(row: ExportSummary, now: Date): ExportSummary {
  if (row.status === 'ready' && row.expiresAt !== null && row.expiresAt <= now) {
    return { ...row, status: 'expired' };
  }
  return row;
}

export async function listExports(
  tx: TenantClient,
  opts: { userId: string; all: boolean; now?: Date; limit?: number },
): Promise<ExportSummary[]> {
  const now = opts.now ?? new Date();
  const rows = await tx.dataExport.findMany({
    where: opts.all ? {} : { requestedByUserId: opts.userId },
    orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
    take: Math.min(opts.limit ?? 100, 200),
    select: SUMMARY,
  });
  return rows.map((row) => effective(row, now));
}

export async function readExport(
  tx: TenantClient,
  exportId: string,
  opts: { userId: string; all: boolean; now?: Date },
): Promise<ExportSummary | null> {
  const row = await tx.dataExport.findUnique({ where: { id: exportId }, select: SUMMARY });
  if (row === null) return null;
  // Not "forbidden": somebody else's export is, to you, an export that does
  // not exist. Its existence says who is taking copies of what.
  if (!opts.all && row.requestedByUserId !== opts.userId) return null;
  return effective(row, opts.now ?? new Date());
}

// ---- request ---------------------------------------------------------------

export interface ExportRequest {
  kind: ExportKind;
  params: Record<string, unknown>;
  ttlHours?: number | undefined;
  requestedByUserId: string;
  requestedViaToken: boolean;
  sourceIp: string | null;
}

/**
 * Records the request and queues the job. Throws `ExportRefusedError` when the
 * requester lacks the authority, after committing an audit event that says
 * so -- a refused attempt to take a copy is part of the record of who tried.
 */
export async function requestExport(
  scheduler: Scheduler,
  tenantId: string,
  input: ExportRequest,
): Promise<ExportSummary> {
  const ttlHours = input.ttlHours ?? EXPORT_TTL_DEFAULT_HOURS;
  if (!Number.isInteger(ttlHours) || ttlHours < 1 || ttlHours > EXPORT_TTL_MAX_HOURS) {
    throw new ExportRefusedError('state', `an export lives between 1 and ${EXPORT_TTL_MAX_HOURS} hours`);
  }

  // A support bundle's window is fixed HERE, at request, as explicit instants:
  // a request for "the last day" means the day before it was asked for, not
  // the day before a delayed job happened to run. At most seven days.
  if (input.kind === 'support_bundle') {
    try {
      const window = supportBundleWindow(input.params);
      input = { ...input, params: { from: window.from.toISOString(), to: window.to.toISOString() } };
    } catch (cause) {
      if (cause instanceof SupportBundleWindowError) throw new ExportRefusedError('state', cause.message);
      throw cause;
    }
  }

  const created = await withTenant(tenantId, async (tx) => {
    const authority = await exportAuthority(tx, input.requestedByUserId, input.kind);
    if (!authority.allowed) return null;
    const row = await tx.dataExport.create({
      data: {
        tenantId,
        kind: input.kind,
        format: FORMAT[input.kind].format,
        params: input.params as never,
        requestedByUserId: input.requestedByUserId,
        requestedViaToken: input.requestedViaToken,
        ttlHours,
      },
      select: SUMMARY,
    });
    await recordEvent(tx, {
      actorUserId: input.requestedByUserId,
      action: 'export.request',
      targetType: 'DataExport',
      targetId: row.id,
      outcome: 'success',
      sourceIp: input.sourceIp,
      payload: {
        kind: input.kind,
        params: input.params,
        ttlHours,
        viaToken: input.requestedViaToken,
        authority: authority.fingerprint,
      },
    });
    return row;
  });

  if (created === null) {
    await withTenant(tenantId, (tx) =>
      recordEvent(tx, {
        actorUserId: input.requestedByUserId,
        action: 'export.request',
        targetType: 'DataExport',
        targetId: null,
        outcome: 'failure',
        sourceIp: input.sourceIp,
        payload: { kind: input.kind, params: input.params, reason: 'forbidden' },
      }),
    );
    throw new ExportRefusedError('forbidden', `this export needs ${exportPermissions(input.kind).join(' and ')}`);
  }

  // Enqueued AFTER the row commits, so a worker never reads an id no
  // transaction has written; a failed enqueue is written onto the row.
  await enqueueForRow(
    EXPORT_JOB,
    () => scheduler.enqueue<ExportJobPayload>(EXPORT_JOB, { tenantId, exportId: created.id }),
    (message) =>
      withTenant(tenantId, (tx) =>
        tx.dataExport.updateMany({
          where: { id: created.id, status: 'queued' },
          data: { status: 'failed', completedAt: new Date(), error: message },
        }),
      ),
  );
  return created;
}

// ---- generate --------------------------------------------------------------

export interface ExportJobPayload {
  tenantId: string;
  exportId: string;
}

class ExportTooLargeError extends Error {}
class ExportRevokedMidway extends Error {}

/** The audit filters as the contract carries them, as the search takes them. */
export function auditFiltersFromParams(params: Record<string, unknown>): AuditSearchFilters {
  const str = (key: string) => (typeof params[key] === 'string' ? (params[key] as string) : undefined);
  const from = str('from');
  const to = str('to');
  const outcome = str('outcome');
  return {
    actorUserId: str('actor'),
    actionPrefix: str('action'),
    targetId: str('target'),
    targetType: str('targetType'),
    correlationId: str('correlation'),
    outcome: outcome === 'success' || outcome === 'failure' ? outcome : undefined,
    from: from === undefined ? undefined : new Date(from),
    to: to === undefined ? undefined : new Date(to),
  };
}

/**
 * Runs one export. Never throws for a failure of the export itself: the
 * failure is written onto the row and audited, and a retry by pg-boss would
 * find the row no longer queued and do nothing -- the requester asks again.
 */
export async function runExportJob(
  tenantId: string,
  exportId: string,
  provider: MasterKeyProvider,
  clock: () => Date = () => new Date(),
): Promise<ExportStatus | null> {
  // CLAIM. Conditional on `queued`, so a revoked export, or a second delivery
  // of the same job, does nothing.
  const claimed = await withTenant(tenantId, (tx) =>
    tx.dataExport.updateMany({
      where: { id: exportId, status: 'queued' },
      data: { status: 'running', startedAt: clock() },
    }),
  );
  if (claimed.count !== 1) return null;

  const row = await withTenant(tenantId, (tx) =>
    tx.dataExport.findUniqueOrThrow({ where: { id: exportId }, select: SUMMARY }),
  );
  const kind = row.kind as ExportKind;

  const fail = async (message: string, reason: string) => {
    const failed = await withTenant(tenantId, async (tx) => {
      const updated = await tx.dataExport.updateMany({
        where: { id: exportId, status: 'running' },
        data: { status: 'failed', completedAt: clock(), error: message },
      });
      if (updated.count === 1) {
        await recordEvent(tx, {
          actorUserId: null,
          action: 'export.fail',
          targetType: 'DataExport',
          targetId: exportId,
          outcome: 'failure',
          sourceIp: null,
          payload: { kind, reason, requestedByUserId: row.requestedByUserId },
        });
      }
      return updated.count === 1;
    });
    return failed ? ('failed' as const) : null;
  };

  // RE-CHECK AT EXECUTION. The request was authorised when it was made; the
  // requester may have lost the role while the job waited in the queue.
  const authority = await withTenant(tenantId, (tx) =>
    exportAuthority(tx, row.requestedByUserId, kind),
  );
  if (!authority.allowed || authority.fingerprint === null) {
    return fail('the requester no longer holds the permission this export needs', 'forbidden');
  }

  const generatedAt = clock();
  const watermark = {
    export_id: exportId,
    tenant_id: tenantId,
    exported_by_user_id: row.requestedByUserId,
    exported_at: generatedAt.toISOString(),
  };

  const sealer = createEnvelopeSealer();
  const digest = createHash('sha256');
  let byteLength = 0;
  const write = (text: string) => {
    const chunk = Buffer.from(text, 'utf8');
    byteLength += chunk.length;
    if (byteLength > EXPORT_MAX_BYTES) throw new ExportTooLargeError();
    digest.update(chunk);
    sealer.update(chunk);
  };

  let rowCount = 0;
  try {
    if (kind === 'audit_log') {
      rowCount = await writeAuditLog(tenantId, exportId, row, watermark, write);
    } else if (kind === 'support_bundle') {
      rowCount = await writeSupportBundle(tenantId, row, watermark, write);
    } else {
      const params = row.params as { snapshotId?: string; systemId: string; resourceId?: string };
      const result = await governAccessCsv(
        tenantId,
        row.requestedByUserId,
        authority.governScope!,
        params,
        watermark,
      );
      // Written in slices so no single cipher update holds the whole report
      // twice over. The report itself is already in memory: the Govern report
      // service reads a snapshot's holdings for one system in one query, which
      // is bounded by that snapshot, not by this service.
      for (let at = 0; at < result.csv.length; at += 64 * 1024) {
        write(result.csv.slice(at, at + 64 * 1024));
      }
      rowCount = result.rowCount;
    }
  } catch (cause) {
    sealer.discard();
    if (cause instanceof ExportRevokedMidway) return 'revoked';
    if (cause instanceof ExportTooLargeError) {
      return fail(
        `the export would exceed ${EXPORT_MAX_BYTES / (1024 * 1024)} MiB; narrow the filters and request it again`,
        'too_large',
      );
    }
    return fail(cause instanceof Error ? cause.message : 'the export could not be generated', 'error');
  }

  // Bound to the tenant, as every stored secret is: an external provider
  // refuses to unwrap a sealed export copied into another tenant's row.
  const sealed = await sealer.seal(provider, { tenantId });
  const sha256 = digest.digest('hex');
  const completedAt = clock();
  const expiresAt = new Date(completedAt.getTime() + row.ttlHours * 3_600_000);
  const day = generatedAt.toISOString().slice(0, 10);
  const filename = `syntra-${FORMAT[kind].stem}-${day}-${exportId.slice(0, 8)}.${FORMAT[kind].format}`;
  const bytes = (b: Buffer) => new Uint8Array(b);

  return withTenant(
    tenantId,
    async (tx) => {
      // Conditional on `running`: a revocation that landed while the file was
      // being built wins, and the sealed bytes are simply never stored.
      const stored = await tx.dataExport.updateMany({
        where: { id: exportId, status: 'running' },
        data: {
          status: 'ready',
          completedAt,
          expiresAt,
          rowCount,
          byteLength,
          sha256,
          filename,
          contentType: FORMAT[kind].contentType,
          authorityFingerprint: authority.fingerprint,
          ciphertext: bytes(sealed.ciphertext),
          iv: bytes(sealed.iv),
          tag: bytes(sealed.tag),
          wrappedDek: bytes(sealed.wrappedDek),
          dekIv: bytes(sealed.dekIv),
          dekTag: bytes(sealed.dekTag),
        },
      });
      if (stored.count !== 1) return 'revoked' as const;
      await recordEvent(tx, {
        actorUserId: null,
        action: 'export.ready',
        targetType: 'DataExport',
        targetId: exportId,
        outcome: 'success',
        sourceIp: null,
        payload: {
          kind,
          requestedByUserId: row.requestedByUserId,
          rowCount,
          byteLength,
          sha256,
          expiresAt: expiresAt.toISOString(),
          authority: authority.fingerprint,
        },
      });
      return 'ready' as const;
    },
    { timeoutMs: 60_000 },
  );
}

/**
 * The audit log as JSON Lines: a watermark record, one record per event in
 * chain order, and an end record carrying the count -- so a truncated file is
 * recognisable as truncated, which a file that simply stops is not.
 *
 * BOUNDED AT THE HEAD AS IT STOOD WHEN GENERATION BEGAN. The export's own
 * `export.ready` event, and everything written while it runs, is after the
 * head; without the bound the file would chase a log that grows as it reads.
 * Batches are keyset reads on `sequence`, each its own short transaction, and
 * each re-reads the export's status so a revocation stops the work at the
 * next batch rather than at the end.
 */
async function writeAuditLog(
  tenantId: string,
  exportId: string,
  row: ExportSummary,
  watermark: Record<string, string>,
  write: (text: string) => void,
): Promise<number> {
  const params = (row.params ?? {}) as Record<string, unknown>;
  const filters = auditFiltersFromParams(params);
  const head = await withTenant(tenantId, (tx) =>
    tx.auditEvent.findFirst({ orderBy: { sequence: 'desc' }, select: { sequence: true } }),
  );
  const headSequence = head?.sequence ?? 0;

  write(
    `${JSON.stringify({
      type: 'syntra-export-watermark',
      ...watermark,
      kind: 'audit_log',
      filters: params,
      head_sequence: headSequence,
      statement:
        'A copy of the Syntra audit log taken by the user named above. Each event keeps its chain hash, so the copy can be checked against the log it came from.',
    })}\n`,
  );

  let cursor = 0;
  let count = 0;
  for (;;) {
    const batch = await withTenant(tenantId, async (tx) => {
      const current = await tx.dataExport.findUnique({
        where: { id: exportId },
        select: { status: true },
      });
      if (current?.status !== 'running') throw new ExportRevokedMidway();
      return tx.$queryRaw<AuditEventRow[]>(
        auditSearchSql(filters, {
          after: cursor,
          maxSequence: headSequence,
          limit: EXPORT_BATCH_ROWS,
          order: 'asc',
        }),
      );
    });
    for (const event of batch) {
      write(
        `${JSON.stringify({
          type: 'event',
          sequence: event.sequence,
          occurredAt: event.occurredAt.toISOString(),
          actorUserId: event.actorUserId,
          action: event.action,
          targetType: event.targetType,
          targetId: event.targetId,
          outcome: event.outcome,
          sourceIp: event.sourceIp,
          payload: event.payload,
          prevHash: event.prevHash,
          hash: event.hash,
        })}\n`,
      );
      count += 1;
    }
    const last = batch[batch.length - 1];
    if (batch.length < EXPORT_BATCH_ROWS || last === undefined) break;
    cursor = last.sequence;
  }

  write(`${JSON.stringify({ type: 'syntra-export-end', export_id: exportId, event_count: count })}\n`);
  return count;
}

/**
 * The support bundle as JSON Lines: the watermark, one record per section,
 * and an end record with the section count. The sections are built and
 * redacted by `support-bundle.ts`; see it for what they may contain.
 *
 * Imported when used rather than at the top: the bundle reads job health,
 * which names this module's job, and a static import would be a cycle.
 */
async function writeSupportBundle(
  tenantId: string,
  row: ExportSummary,
  watermark: Record<string, string>,
  write: (text: string) => void,
): Promise<number> {
  const { buildSupportBundle } = await import('./support-bundle.js');
  const params = (row.params ?? {}) as { from?: string; to?: string };
  const window = supportBundleWindow(params, new Date());
  const sections = await buildSupportBundle(tenantId, window);
  write(
    `${JSON.stringify({
      type: 'syntra-export-watermark',
      ...watermark,
      kind: 'support_bundle',
      window: { from: window.from.toISOString(), to: window.to.toISOString() },
      statement:
        'A redacted operational support bundle for the tenant named above: fingerprints, versions, statuses, counts and error classes only.',
    })}
`,
  );
  for (const section of sections) {
    write(`${JSON.stringify({ type: 'section', name: section.name, data: section.data })}
`);
  }
  write(`${JSON.stringify({ type: 'syntra-export-end', export_id: watermark.export_id, section_count: sections.length })}
`);
  return sections.length;
}

// ---- download --------------------------------------------------------------

export interface ExportDownload {
  body: Buffer;
  filename: string;
  contentType: string;
  sha256: string;
}

async function auditDownloadRefusal(
  tenantId: string,
  exportId: string,
  userId: string,
  sourceIp: string | null,
  reason: ExportRefusal | 'integrity',
): Promise<void> {
  await withTenant(tenantId, (tx) =>
    recordEvent(tx, {
      actorUserId: userId,
      action: 'export.download',
      targetType: 'DataExport',
      targetId: exportId,
      outcome: 'failure',
      sourceIp,
      payload: { reason },
    }),
  );
}

/**
 * The file, to its requester, if everything that authorised it still holds.
 *
 * Refusals that say something about an attempt -- no longer authorised, a
 * different authority, expired, revoked -- are audited in their own committed
 * transaction before the throw. "Not found" is not: it is what somebody
 * else's export looks like, and auditing it would record a guess at an id.
 */
export async function downloadExport(
  tenantId: string,
  input: {
    exportId: string;
    userId: string;
    provider: MasterKeyProvider;
    sourceIp: string | null;
    now?: Date;
  },
): Promise<ExportDownload> {
  const now = input.now ?? new Date();
  const decision = await withTenant(tenantId, async (tx) => {
    const row = await tx.dataExport.findUnique({ where: { id: input.exportId } });
    if (row === null || row.requestedByUserId !== input.userId) {
      return { refused: 'not_found' as const };
    }
    if (row.status === 'revoked') return { refused: 'revoked' as const };
    if (row.status === 'expired' || (row.expiresAt !== null && row.expiresAt <= now)) {
      return { refused: 'expired' as const };
    }
    if (row.status === 'failed') return { refused: 'failed' as const };
    if (row.status !== 'ready') return { refused: 'not_ready' as const };

    // RE-CHECK AT DOWNLOAD. Both halves: the permission, and that it is the
    // same authority the file was generated under.
    const authority = await exportAuthority(tx, input.userId, row.kind as ExportKind);
    if (!authority.allowed) return { refused: 'forbidden' as const };
    if (authority.fingerprint !== row.authorityFingerprint) {
      return { refused: 'authority_changed' as const };
    }
    return { row };
  });

  if ('refused' in decision) {
    const code = decision.refused;
    if (code !== 'not_found' && code !== 'not_ready' && code !== 'failed') {
      await auditDownloadRefusal(tenantId, input.exportId, input.userId, input.sourceIp, code);
    }
    throw new ExportRefusedError(code, REFUSAL_MESSAGES[code]);
  }

  const row = decision.row;
  const body = await openEnvelope(input.provider, {
    ciphertext: Buffer.from(row.ciphertext!),
    iv: Buffer.from(row.iv!),
    tag: Buffer.from(row.tag!),
    wrappedDek: Buffer.from(row.wrappedDek!),
    dekIv: Buffer.from(row.dekIv!),
    dekTag: Buffer.from(row.dekTag!),
  }, { tenantId });
  // GCM already authenticates the ciphertext; this checks the other claim --
  // that what is handed over is the file whose digest was recorded and
  // audited when it was made.
  const sha256 = createHash('sha256').update(body).digest('hex');
  if (sha256 !== row.sha256) {
    await auditDownloadRefusal(tenantId, input.exportId, input.userId, input.sourceIp, 'integrity');
    throw new Error('the export does not match the digest recorded when it was generated');
  }

  await withTenant(tenantId, async (tx) => {
    await tx.dataExport.update({
      where: { id: row.id },
      data: { downloadCount: { increment: 1 }, lastDownloadedAt: now },
    });
    await recordEvent(tx, {
      actorUserId: input.userId,
      action: 'export.download',
      targetType: 'DataExport',
      targetId: row.id,
      outcome: 'success',
      sourceIp: input.sourceIp,
      payload: { kind: row.kind, sha256, byteLength: body.length, rowCount: row.rowCount },
    });
  });

  return { body, filename: row.filename!, contentType: row.contentType!, sha256 };
}

const REFUSAL_MESSAGES: Record<ExportRefusal, string> = {
  forbidden: 'You no longer hold the permission this export needs.',
  not_found: 'Export not found.',
  not_ready: 'This export is still being generated.',
  failed: 'This export failed and has nothing to download.',
  expired: 'This export has expired and its file has been erased.',
  revoked: 'This export was revoked and its file has been erased.',
  authority_changed:
    'Your access has changed since this export was generated, so it can no longer be handed to you. Request it again.',
  state: 'This export is not in a state that allows that.',
};

// ---- revoke ----------------------------------------------------------------

const ERASED = {
  ciphertext: null,
  iv: null,
  tag: null,
  wrappedDek: null,
  dekIv: null,
  dekTag: null,
} as const;

/**
 * Ends an export and erases its file. The requester may revoke their own; an
 * administrator with `manageAll` (the API passes `tenant.manage`) may revoke
 * anybody's -- which is the point of revocation: the person who needs to stop
 * a copy leaving is rarely the person who asked for it.
 */
export async function revokeExport(
  tenantId: string,
  input: {
    exportId: string;
    actorUserId: string;
    manageAll: boolean;
    sourceIp: string | null;
    now?: Date;
  },
): Promise<ExportSummary> {
  const now = input.now ?? new Date();
  return withTenant(tenantId, async (tx) => {
    const row = await tx.dataExport.findUnique({ where: { id: input.exportId }, select: SUMMARY });
    if (row === null || (!input.manageAll && row.requestedByUserId !== input.actorUserId)) {
      throw new ExportRefusedError('not_found', REFUSAL_MESSAGES.not_found);
    }
    if (!['queued', 'running', 'ready'].includes(row.status)) {
      throw new ExportRefusedError('state', `This export is already ${row.status}.`);
    }
    const updated = await tx.dataExport.updateMany({
      where: { id: row.id, status: row.status },
      data: {
        status: 'revoked',
        revokedAt: now,
        revokedByUserId: input.actorUserId,
        purgedAt: row.status === 'ready' ? now : null,
        ...ERASED,
      },
    });
    if (updated.count !== 1) {
      throw new ExportRefusedError('state', 'This export changed state while it was being revoked.');
    }
    await recordEvent(tx, {
      actorUserId: input.actorUserId,
      action: 'export.revoke',
      targetType: 'DataExport',
      targetId: row.id,
      outcome: 'success',
      sourceIp: input.sourceIp,
      payload: {
        kind: row.kind,
        previousStatus: row.status,
        requestedByUserId: row.requestedByUserId,
        downloadCount: row.downloadCount,
      },
    });
    return tx.dataExport.findUniqueOrThrow({ where: { id: row.id }, select: SUMMARY });
  });
}

// ---- sweep -----------------------------------------------------------------

/**
 * Erases what expired, and fails what was abandoned.
 *
 * Downloads never wait for this -- `downloadExport` compares `expiresAt` with
 * the clock itself. The sweep is what makes the bytes stop EXISTING, and what
 * records that they did. Each close is conditional on the status that was
 * read, so two sweeps, or a sweep racing a revocation, close an export once.
 * Bounded per pass; the next pass takes the rest.
 */
export async function sweepExports(
  tenantId: string,
  now: Date = new Date(),
): Promise<{ expired: number; abandoned: number }> {
  return withTenant(tenantId, async (tx) => {
    let expired = 0;
    const lapsed = await tx.dataExport.findMany({
      where: { status: 'ready', expiresAt: { lte: now } },
      select: { id: true, kind: true, requestedByUserId: true, downloadCount: true },
      take: 200,
    });
    for (const row of lapsed) {
      const closed = await tx.dataExport.updateMany({
        where: { id: row.id, status: 'ready' },
        data: { status: 'expired', purgedAt: now, ...ERASED },
      });
      if (closed.count !== 1) continue;
      expired += 1;
      await recordEvent(tx, {
        actorUserId: null,
        action: 'export.expire',
        targetType: 'DataExport',
        targetId: row.id,
        outcome: 'success',
        sourceIp: null,
        payload: {
          kind: row.kind,
          requestedByUserId: row.requestedByUserId,
          downloadCount: row.downloadCount,
        },
      });
    }

    let abandoned = 0;
    const cutoff = new Date(now.getTime() - EXPORT_ABANDONED_AFTER_MS);
    const stale = await tx.dataExport.findMany({
      where: {
        OR: [
          { status: 'queued', requestedAt: { lte: cutoff } },
          { status: 'running', startedAt: { lte: cutoff } },
        ],
      },
      select: { id: true, kind: true, status: true, requestedByUserId: true },
      take: 200,
    });
    for (const row of stale) {
      const closed = await tx.dataExport.updateMany({
        where: { id: row.id, status: row.status },
        data: {
          status: 'failed',
          completedAt: now,
          error: 'abandoned: no worker finished this export within two hours; request it again',
        },
      });
      if (closed.count !== 1) continue;
      abandoned += 1;
      await recordEvent(tx, {
        actorUserId: null,
        action: 'export.fail',
        targetType: 'DataExport',
        targetId: row.id,
        outcome: 'failure',
        sourceIp: null,
        payload: { kind: row.kind, reason: 'abandoned', requestedByUserId: row.requestedByUserId },
      });
    }
    return { expired, abandoned };
  });
}

// ---- jobs ------------------------------------------------------------------

export interface ExportSweepPayload {
  tenantId: string;
}

export function registerExportJobs(scheduler: Scheduler, provider: MasterKeyProvider): void {
  scheduler.register<ExportJobPayload>(EXPORT_JOB, async ({ tenantId, exportId }) => {
    await runExportJob(tenantId, exportId, provider);
  });
  scheduler.register<ExportSweepPayload>(EXPORT_SWEEP_JOB, async ({ tenantId }) => {
    await sweepExports(tenantId);
  });
}

/**
 * Every fifteen minutes. The bound on how long an expired file's ciphertext
 * outlives its expiry; one indexed read per tenant when there is nothing.
 */
export async function scheduleExportSweep(scheduler: Scheduler, tenantId: string): Promise<void> {
  await scheduler.schedule(EXPORT_SWEEP_JOB, '*/15 * * * *', { tenantId }, `export-sweep-${tenantId}`);
}
