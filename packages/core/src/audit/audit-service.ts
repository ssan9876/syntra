import { createHash } from 'node:crypto';
import type { TenantClient } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';

export const GENESIS_HASH = '0'.repeat(64);

export interface AuditInput {
  actorUserId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  outcome: 'success' | 'failure';
  sourceIp: string | null;
  payload: Record<string, unknown>;
}

interface Hashable extends AuditInput {
  tenantId: string;
  sequence: number;
  occurredAt: Date;
  prevHash: string;
}

/**
 * Key order in a JSON object is not guaranteed across writers, so the payload
 * is serialised with sorted keys. Without this, an event could hash
 * differently on verification than it did on insert.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
  );
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
    .join(',')}}`;
}

/** Fixed field order, so the same event always produces the same digest. */
function computeHash(e: Hashable): string {
  const canonical = JSON.stringify([
    e.tenantId,
    e.sequence,
    e.occurredAt.toISOString(),
    e.actorUserId,
    e.action,
    e.targetType,
    e.targetId,
    e.outcome,
    e.sourceIp,
    stableStringify(e.payload),
    e.prevHash,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

export async function recordEvent(tx: TenantClient, input: AuditInput) {
  const tenantId = await currentTenant(tx);

  // Serialise appenders for this tenant so two concurrent writers cannot claim
  // the same sequence number or chain from the same predecessor. Released
  // when the transaction ends.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId}))`;

  const last = await tx.auditEvent.findFirst({
    orderBy: { sequence: 'desc' },
    select: { sequence: true, hash: true },
  });

  const sequence = (last?.sequence ?? 0) + 1;
  const prevHash = last?.hash ?? GENESIS_HASH;
  const occurredAt = new Date();

  const hash = computeHash({
    ...input,
    tenantId,
    sequence,
    occurredAt,
    prevHash,
  });

  return tx.auditEvent.create({
    data: {
      tenantId,
      sequence,
      occurredAt,
      actorUserId: input.actorUserId,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      outcome: input.outcome,
      sourceIp: input.sourceIp,
      payload: input.payload as never,
      prevHash,
      hash,
    },
  });
}

export type ChainResult =
  | { valid: true }
  | { valid: false; brokenAtSequence: number };

/**
 * Walks the chain, recomputing each digest. Reports the first sequence number
 * where the chain does not hold — either the link to the previous event is
 * wrong (an event was removed) or the row's own contents no longer hash to
 * its stored digest (an event was altered).
 */
export async function verifyChain(tx: TenantClient): Promise<ChainResult> {
  const tenantId = await currentTenant(tx);
  const events = await tx.auditEvent.findMany({ orderBy: { sequence: 'asc' } });

  let expectedPrev = GENESIS_HASH;
  for (const e of events) {
    if (e.prevHash !== expectedPrev) {
      return { valid: false, brokenAtSequence: e.sequence };
    }

    const recomputed = computeHash({
      tenantId,
      sequence: e.sequence,
      occurredAt: e.occurredAt,
      actorUserId: e.actorUserId,
      action: e.action,
      targetType: e.targetType,
      targetId: e.targetId,
      outcome: e.outcome as 'success' | 'failure',
      sourceIp: e.sourceIp,
      payload: e.payload as Record<string, unknown>,
      prevHash: e.prevHash,
    });
    if (recomputed !== e.hash) {
      return { valid: false, brokenAtSequence: e.sequence };
    }

    expectedPrev = e.hash;
  }

  return { valid: true };
}

export async function listEvents(
  tx: TenantClient,
  opts: { limit?: number | undefined; before?: number | undefined } = {},
) {
  return tx.auditEvent.findMany({
    where: opts.before ? { sequence: { lt: opts.before } } : {},
    orderBy: { sequence: 'desc' },
    take: opts.limit ?? 50,
  });
}
