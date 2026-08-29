import { createHash } from 'node:crypto';
import type { TenantClient } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';
import { isSecurityEvent, securityProjection } from '../notify/security-events.js';
import { enqueueWebhooks } from '../notify/webhook-service.js';

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
/**
 * EXPORTED because Govern's evidence bundles must have a stable digest and
 * must use THIS serialization, not a second one. A bundle serialised by a
 * different sorted-key implementation would have a digest that a later reader
 * recomputing it from the same content could not reproduce.
 */
export function stableStringify(value: unknown): string {
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
/**
 * The payload exactly as the database will hold it.
 *
 * Two known ways a payload changes on its way into `jsonb`, and the digest has
 * to be taken over the far side of both or the writer and the verifier
 * disagree about a log nobody touched:
 *
 *  - **`undefined`.** Prisma drops the key on write and it returns absent, so
 *    the key is dropped here too.
 *  - **Float precision.** Prisma's engine re-serialises a JS number at 16
 *    significant digits, so `0.1 + 0.2` is written as `0.3` -- the seventeenth
 *    digit never reaches the database. Non-integers are therefore projected to
 *    15 significant digits, which is a FIXED POINT of that formatting: a double
 *    that is the nearest one to a 15-digit decimal has a shortest
 *    representation of at most 15 digits, so re-formatting it at 16 returns it
 *    unchanged. Integers are left alone -- `toPrecision(15)` would corrupt
 *    `Number.MAX_SAFE_INTEGER`, which the engine stores exactly.
 *
 * Used for the digest AND for the value written, so the two cannot drift: what
 * is hashed is literally what is stored.
 */
export function canonicalPayload(value: unknown): unknown {
  if (typeof value === 'number') {
    return Number.isInteger(value) || !Number.isFinite(value)
      ? value
      : Number(value.toPrecision(15));
  }
  if (Array.isArray(value)) return value.map(canonicalPayload);
  if (value === null || typeof value !== 'object' || value instanceof Date) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, canonicalPayload(v)]),
  );
}

/**
 * EXPORTED as `auditEventHash` because Govern verifies the chain INCREMENTALLY
 * -- from a checkpoint's sequence, seeded with its hash -- while `verifyChain`
 * walks every event ever recorded with no bound. A second implementation would
 * drift from the one that wrote the chain, and the drift would report a whole
 * chain as broken.
 */
export function auditEventHash(e: Hashable): string {
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

  // Hashed AND written, so the digest is taken over exactly the bytes the
  // database ends up holding. Rejecting an awkward value at the door would be
  // the other resolution and is worse: `exactOptionalPropertyTypes` makes
  // `{ foo: x ?? undefined }` an ordinary idiom across three subsystems, and a
  // float nobody rounded on purpose would fail the write for the hash's sake.
  const payload = canonicalPayload(input.payload) as Record<string, unknown>;

  const hash = auditEventHash({
    ...input,
    payload,
    tenantId,
    sequence,
    occurredAt,
    prevHash,
  });

  const event = await tx.auditEvent.create({
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
      payload: payload as never,
      prevHash,
      hash,
    },
  });

  // The fan-out to any endpoint that subscribed to this kind of event.
  //
  // HERE rather than at the twenty-odd security `recordEvent` call sites,
  // because a fan-out a caller has to remember is a fan-out a caller will
  // forget -- `refresh-token.ts` is the docstring of the last time that lesson
  // was paid for here, and `end-sessions.ts` is what it cost to unlearn.
  //
  // AFTER the row, because the projection carries the sequence number and the
  // sequence does not exist until the row is written. INSIDE the transaction,
  // because an event that was audited and not announced -- or announced and
  // not audited -- is two records disagreeing about one thing that happened.
  //
  // An action that is not a security event pays one set membership test and
  // goes no further, and a tenant with no endpoints costs `enqueueWebhooks`
  // one indexed read.
  if (isSecurityEvent(input.action)) {
    await enqueueWebhooks(
      tx,
      [
        {
          event: input.action,
          requestId: null,
          // Nobody was mailed. The Automate events carry recipients because a
          // person was; a lockout is addressed to no one.
          recipients: [],
          data: securityProjection({
            action: input.action,
            outcome: input.outcome,
            occurredAt,
            sequence,
            actorUserId: input.actorUserId,
            targetType: input.targetType,
            targetId: input.targetId,
          }) as unknown as Record<string, unknown>,
        },
      ],
      occurredAt,
    );
  }

  return event;
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

    const recomputed = auditEventHash({
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

/**
 * A page of the log, newest first, optionally narrowed to a set of subjects.
 *
 * `subjectIds` matches BOTH directions -- what was done to the subject and
 * what the subject did. Those are one investigation, not two: an account
 * locked out and the administrator who locked it belong on the same screen,
 * and a log that showed only `targetId` would hide half of every story it
 * told.
 *
 * An empty array is a filter that matches nothing, not an absent filter. It is
 * what a person with no id and no linked accounts produces, and answering that
 * with the tenant's entire log would put every other account's history on
 * their screen.
 */
export async function listEvents(
  tx: TenantClient,
  opts: {
    limit?: number | undefined;
    before?: number | undefined;
    subjectIds?: string[] | undefined;
  } = {},
) {
  const where: Record<string, unknown> = {};
  if (opts.before) where['sequence'] = { lt: opts.before };
  if (opts.subjectIds) {
    where['OR'] = [
      { targetId: { in: opts.subjectIds } },
      { actorUserId: { in: opts.subjectIds } },
    ];
  }

  return tx.auditEvent.findMany({
    where,
    orderBy: { sequence: 'desc' },
    take: opts.limit ?? 50,
  });
}
