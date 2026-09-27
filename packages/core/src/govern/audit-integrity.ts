import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withTenant, type TenantClient } from '@syntra/db';
import { GENESIS_HASH, auditEventHash, recordEvent } from '../audit/audit-service.js';
import { type Transport } from '../notify/notification-service.js';
import { resolveAuditIntegrityFindings, upsertFindings } from './finding-service.js';
import { AUDIT_CHAIN_REF, AUDIT_CHECKPOINT_REF } from './types.js';

/**
 * The built `verifyChain` calls `findMany` with no bound and walks every event
 * ever recorded, loading them all into memory at once. That is correct and it
 * is O(n) in both time and memory over a table that grows forever. A tenant
 * with ten million events cannot verify nightly that way, and the practical
 * outcome of an integrity check too expensive to run is an integrity check
 * nobody runs.
 */
export const AUDIT_VERIFY_PAGE = 1000;

export interface SegmentResult {
  fromSequence: number;
  toSequence: number;
  result: 'valid' | 'broken';
  brokenAtSequence: number | null;
  durationMs: number;
}

/**
 * Walks from `fromSequence`, seeded with `expectedPrevHash`, in pages.
 *
 * An EMPTY segment is `valid` with `toSequence` one below `fromSequence`. There
 * is nothing wrong with a chain that has not grown since the last checkpoint,
 * and throwing here would make the nightly job noisy on every quiet tenant.
 */
export async function verifySegment(
  tenantId: string,
  fromSequence: number,
  expectedPrevHash: string,
  options: { pageSize?: number; maxSequence?: number } = {},
): Promise<SegmentResult> {
  const pageSize = options.pageSize ?? AUDIT_VERIFY_PAGE;
  const startedAt = Date.now();

  let expectedPrev = expectedPrevHash;
  let cursor = fromSequence;
  let last = fromSequence - 1;

  for (;;) {
    const page = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({
        where: {
          sequence: {
            gte: cursor,
            ...(options.maxSequence === undefined ? {} : { lte: options.maxSequence }),
          },
        },
        orderBy: { sequence: 'asc' },
        take: pageSize,
      }),
    );
    if (page.length === 0) break;

    for (const e of page) {
      if (e.prevHash !== expectedPrev) {
        return {
          fromSequence,
          toSequence: e.sequence,
          result: 'broken',
          brokenAtSequence: e.sequence,
          durationMs: Date.now() - startedAt,
        };
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
        return {
          fromSequence,
          toSequence: e.sequence,
          result: 'broken',
          brokenAtSequence: e.sequence,
          durationMs: Date.now() - startedAt,
        };
      }
      expectedPrev = e.hash;
      last = e.sequence;
    }

    cursor = last + 1;
    if (page.length < pageSize) break;
  }

  return {
    fromSequence,
    toSequence: last,
    result: 'valid',
    brokenAtSequence: null,
    durationMs: Date.now() - startedAt,
  };
}

export interface CheckpointSigner {
  keyId: string;
  sign(payload: string): Promise<string>;
  verify(payload: string, signature: string): Promise<boolean>;
}

/**
 * A signature over (sequence, hash) with a key the application holds and the
 * database does not. It raises the bar from "database access" to "database
 * access plus the signing key". It is NOT proof against the operator; only
 * anchoring is, and `integrityStatus` says so on the screen.
 *
 * A distinct interface from `MasterKeyProvider`, which is `{ wrap, unwrap }`:
 * envelope encryption with no `sign` and no `verify`. Signing a digest and
 * encrypting one are different operations with different key lifetimes, and
 * borrowing the vault's interface would mean either widening it for a caller
 * that encrypts nothing or calling an encryption a signature.
 */
export function localFileCheckpointSigner(keyId: string, key: Buffer): CheckpointSigner {
  if (key.length < 32) throw new Error('Checkpoint signing key must be at least 32 bytes.');
  const mac = (payload: string) => createHmac('sha256', key).update(payload).digest('hex');
  return {
    keyId,
    async sign(payload) {
      return mac(payload);
    },
    async verify(payload, signature) {
      const expected = Buffer.from(mac(payload), 'hex');
      const given = Buffer.from(signature, 'hex');
      return expected.length === given.length && timingSafeEqual(expected, given);
    },
  };
}

/**
 * What the last checkpoint's signature is worth. Returned by `checkpointTrust`
 * and reported by `integrityStatus`, because §20's integrity screen must be
 * able to say it in words the way it already says the anchoring state.
 */
export type SignatureState =
  | 'signed_and_verified'
  | 'unsigned_no_signer_configured'
  | 'unsigned_while_signer_configured'
  | 'unknown_key'
  | 'invalid';

/**
 * MAY THIS CHECKPOINT BE SEEDED FROM?
 *
 * This is the whole of C5, and it is the difference between a verifier and a
 * verifier-shaped object. `verifyIncremental` takes a checkpoint's `hash` as
 * the expected `prevHash` of the next event. If that hash is taken on trust,
 * the attack §17 names is not merely undetected — it is CHEAPER than §17
 * claims. An actor with database write access rewrites events 1..N, recomputes
 * their digests, inserts a checkpoint row at N with `signature: null` and
 * `keyId: null`, and every subsequent nightly run reports `valid` over a
 * segment that starts after the tampering. The signing key is never needed.
 * §17's mitigation — "raises the bar from database access to database access
 * plus the signing key" — is then inert, and it is printed on the cover of
 * every evidence bundle as though it were true.
 *
 * The append-only RULE pair on `AuditCheckpoint` does not help: `DO INSTEAD
 * NOTHING` on UPDATE and DELETE is application-level, a superuser drops the
 * rule, and this attack only needs an INSERT, which the rules permit.
 *
 * The rule is on the ROW, not on the deployment:
 *  - the row claims a signature (`keyId !== null`) -> a signer with that exact
 *    `keyId` must verify it;
 *  - the row claims none and no signer is configured -> honest, seedable, and
 *    `integrityStatus` says in words what that verification is worth;
 *  - the row claims none while a signer IS configured -> this is exactly the
 *    forged checkpoint, and it is refused.
 *
 * WHAT TURNING SIGNING ON FOR THE FIRST TIME ACTUALLY COSTS. The pre-existing
 * unsigned checkpoint is refused, so that run raises one `critical` finding and
 * walks from genesis. It does NOT do so forever: `verifyIncremental` treats a
 * clean genesis walk as the evidence a checkpoint stands for and writes a new,
 * signed one (Ruling G-12), so the run after it is incremental again and closes
 * the finding. An earlier draft of this docstring said "ONE finding and ONE
 * full walk" while the code could write no checkpoint at all in that state —
 * which made it one per run, forever, on an append-only table nothing could
 * repair. The sentence was reassurance the mechanism did not support, printed
 * in three places; it is the mechanism that changed, not the sentence.
 */
export async function checkpointTrust(
  checkpoint: { sequence: number; hash: string; signature: string | null; keyId: string | null },
  signer: CheckpointSigner | null,
): Promise<{ seedable: boolean; state: SignatureState }> {
  if (checkpoint.keyId !== null) {
    if (signer === null || signer.keyId !== checkpoint.keyId) {
      return { seedable: false, state: 'unknown_key' };
    }
    if (checkpoint.signature === null) return { seedable: false, state: 'invalid' };
    const ok = await signer.verify(`${checkpoint.sequence}:${checkpoint.hash}`, checkpoint.signature);
    return ok
      ? { seedable: true, state: 'signed_and_verified' }
      : { seedable: false, state: 'invalid' };
  }
  return signer === null
    ? { seedable: true, state: 'unsigned_no_signer_configured' }
    : { seedable: false, state: 'unsigned_while_signer_configured' };
}

const UNTRUSTED_CHECKPOINT_STATEMENT =
  'Checkpoint signature is not valid. Verification restarted from the first event.';

const REESTABLISHED_CHECKPOINT_STATEMENT =
  'Full chain verified from the first event. New checkpoint written at the current head.';

export async function verifyIncremental(
  tenantId: string,
  options: { now?: Date; pageSize?: number; signer?: CheckpointSigner | null } = {},
): Promise<SegmentResult & { checkpointSequence: number | null; signatureState: SignatureState | null }> {
  const now = options.now ?? new Date();
  const signer = options.signer ?? null;

  const checkpoint = await withTenant(tenantId, (tx) =>
    tx.auditCheckpoint.findFirst({ orderBy: { sequence: 'desc' } }),
  );

  // THE SEED IS NOT TAKEN ON TRUST. `signer.verify` is called here, on the
  // production path, and not only in a test.
  const trust =
    checkpoint === null
      ? { seedable: true, state: null as SignatureState | null }
      : await checkpointTrust(checkpoint, signer);

  const seedFrom = trust.seedable ? checkpoint : null;
  const from = (seedFrom?.sequence ?? 0) + 1;
  const seed = seedFrom?.hash ?? GENESIS_HASH;
  const walked = await verifySegment(tenantId, from, seed, {
    ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
  });

  // An unverifiable checkpoint is itself a break in the evidence, and reporting
  // `valid` for a run that had to ignore one is the "we checked" lie this
  // whole task exists to refuse. The walk still happens — from genesis — so the
  // AuditChainCheck row records what was actually examined.
  const result: SegmentResult =
    trust.seedable || checkpoint === null
      ? walked
      : { ...walked, result: 'broken', brokenAtSequence: walked.brokenAtSequence ?? checkpoint.sequence };

  await withTenant(tenantId, async (tx) => {
    await tx.auditChainCheck.create({
      data: {
        tenantId,
        fromSequence: result.fromSequence,
        toSequence: result.toSequence,
        result: result.result,
        brokenAtSequence: result.brokenAtSequence,
        startedAt: now,
        durationMs: result.durationMs,
        mode: trust.seedable ? 'incremental' : 'full_fallback',
      },
    });
  });

  // -- The two `critical` findings, both `audit_chain_broken` ----------------
  //
  // NOT `coverage_gap`, and the difference is the whole of C-a. `coverage_gap`
  // is a member of the detect stage's `STANDING_KINDS`, whose only producer
  // emits `subjectRefType: 'source'` -- so the nightly snapshot build's sweep
  // resolved both of these findings on the run after they were raised, with
  // `resolvedBySnapshotId` naming a snapshot that had read no audit events at
  // all. C1's exact defect, at the two sites C5's fix created: the integrity
  // alarm switched off overnight, every night, by the thing that tidies up
  // findings. `audit_chain_broken` is deliberately absent from `STANDING_KINDS`
  // and is closed only by `resolveAuditIntegrityFindings`, below.
  //
  // `upsertFindings`, never `reconcileFindings`: this caller has no snapshot to
  // name, and a whole-tenant sweep from here would close every standing finding
  // the nightly build opened (C1, the other direction).
  if (checkpoint !== null && !trust.seedable) {
    await upsertFindings(
      tenantId,
      [
        {
          kind: 'audit_chain_broken',
          severity: 'critical',
          subjectRefType: 'snapshot',
          subjectRefId: `${AUDIT_CHECKPOINT_REF}${checkpoint.sequence}`,
          detail: {
            checkpointSequence: checkpoint.sequence,
            signatureState: trust.state,
            keyId: checkpoint.keyId,
            statement: UNTRUSTED_CHECKPOINT_STATEMENT,
          },
        },
      ],
      { now },
    );
  }

  if (result.result === 'broken' && walked.result === 'broken') {
    // A failed verification is a `critical` finding, notified immediately and
    // NEVER digested, and it names the sequence.
    await upsertFindings(
      tenantId,
      [
        {
          kind: 'audit_chain_broken',
          severity: 'critical',
          subjectRefType: 'snapshot',
          subjectRefId: `${AUDIT_CHAIN_REF}${result.brokenAtSequence}`,
          detail: {
            brokenAtSequence: result.brokenAtSequence,
            fromSequence: result.fromSequence,
            statement:
              'Audit chain breaks at this sequence: an event was altered or removed.',
          },
        },
      ],
      { now },
    );
  }

  // -- The ordinary checkpoint ------------------------------------------------
  // Reachable only when the seed was trusted (or there was none), because
  // `result.result` is forced to `broken` otherwise.
  if (result.result === 'valid' && result.toSequence >= result.fromSequence) {
    const head = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findFirst({ where: { sequence: result.toSequence } }),
    );
    if (head !== null) {
      const payload = `${head.sequence}:${head.hash}`;
      const signature = signer === null ? null : await signer.sign(payload);
      await withTenant(tenantId, (tx) =>
        tx.auditCheckpoint.create({
          data: {
            tenantId,
            sequence: head.sequence,
            hash: head.hash,
            verifiedAt: now,
            signature,
            keyId: signer?.keyId ?? null,
          },
        }),
      );
    }
  }

  // -- Recovery from an untrusted checkpoint (Ruling G-12) --------------------
  //
  // WITHOUT THIS, AN UNTRUSTED CHECKPOINT IS PERMANENT. `verifyIncremental` is
  // the only production writer of `AuditCheckpoint` -- `verifyFull` writes only
  // an `AuditChainCheck` -- the ordinary write above is unreachable while
  // `result` is forced `broken`, and the table carries append-only RULEs
  // (`DO INSTEAD NOTHING` on UPDATE and DELETE), so the offending row can never
  // be removed or re-signed. A tenant that once wrote an unsigned checkpoint
  // would walk from genesis on EVERY build for the life of the system, with a
  // `critical` finding nothing could ever clear and a walk that grows without
  // bound. That is not a safety property, it is a trap.
  //
  // A clean walk from genesis IS the evidence a checkpoint is supposed to stand
  // for, so it may establish a new one. This concedes nothing: an attacker who
  // can forge a clean genesis walk can forge the chain, which was already
  // conceded when the walk was made the verification.
  //
  // APPEND-ONLY IS PRESERVED -- a later row supersedes and nothing is rewritten.
  // The audit event is written FIRST on purpose, not incidentally:
  // `AuditCheckpoint` is `@@unique([tenantId, sequence])`, so a second row at
  // the refused checkpoint's own sequence is impossible. Appending the event
  // moves the head past it, and the appended event chains from a head this run
  // has just verified, so the chain through it holds by construction. The
  // `head.sequence > checkpoint.sequence` guard is what makes the supersession
  // real: a new row BELOW the refused one would leave the refused one as head
  // and the trap in place.
  if (checkpoint !== null && !trust.seedable && walked.result === 'valid') {
    await withTenant(tenantId, (tx) =>
      recordEvent(tx, {
        actorUserId: null,
        action: 'govern.audit.checkpoint_reestablished',
        targetType: 'AuditCheckpoint',
        targetId: null,
        outcome: 'success',
        sourceIp: null,
        payload: {
          refusedCheckpointSequence: checkpoint.sequence,
          refusedSignatureState: trust.state,
          verifiedFromSequence: walked.fromSequence,
          verifiedToSequence: walked.toSequence,
          statement: REESTABLISHED_CHECKPOINT_STATEMENT,
        },
      }),
    );
    const head = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findFirst({ orderBy: { sequence: 'desc' } }),
    );
    if (head !== null && head.sequence > checkpoint.sequence) {
      const signature = signer === null ? null : await signer.sign(`${head.sequence}:${head.hash}`);
      await withTenant(tenantId, (tx) =>
        tx.auditCheckpoint.create({
          data: {
            tenantId,
            sequence: head.sequence,
            hash: head.hash,
            verifiedAt: now,
            signature,
            keyId: signer?.keyId ?? null,
          },
        }),
      );
    }
  }

  // -- Closing what this run has evidence for, and nothing else ---------------
  //
  // `trustedCheckpointSequence` is the checkpoint this run SEEDED FROM and
  // verified -- deliberately NOT the one the recovery above may have just
  // written. A recovery must not close the `critical` finding it raised seconds
  // earlier in the same run: the operator would never see it, and a forged
  // checkpoint over a rewritten-but-self-consistent chain is detectable ONLY by
  // that finding. So the alarm stands for one run and clears on the next, once
  // a checkpoint that verifies is the head.
  //
  // `genesisWalkClean` requires a walk that started at 1 AND covered at least
  // one event: a walk over an emptied table returns `valid` and proves nothing.
  await resolveAuditIntegrityFindings(
    tenantId,
    {
      trustedCheckpointSequence: trust.seedable && checkpoint !== null ? checkpoint.sequence : null,
      genesisWalkClean:
        walked.result === 'valid' &&
        walked.fromSequence === 1 &&
        walked.toSequence >= walked.fromSequence,
    },
    { now },
  );

  return {
    ...result,
    checkpointSequence: seedFrom?.sequence ?? null,
    signatureState: trust.state,
  };
}

/** Full verification from genesis stays available as a separate, explicitly invoked, paged job. */
export async function verifyFull(
  tenantId: string,
  options: { pageSize?: number } = {},
): Promise<SegmentResult> {
  const result = await verifySegment(tenantId, 1, GENESIS_HASH, {
    ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
  });
  await withTenant(tenantId, (tx) =>
    tx.auditChainCheck.create({
      data: {
        tenantId,
        fromSequence: result.fromSequence,
        toSequence: result.toSequence,
        result: result.result,
        brokenAtSequence: result.brokenAtSequence,
        durationMs: result.durationMs,
        mode: 'full',
      },
    }),
  );
  return result;
}
export interface AnchorSink {
  method: 'file' | 'mail';
  deliver(payload: {
    tenantId: string;
    sequence: number;
    hash: string;
    anchoredAt: Date;
  }): Promise<string>;
}

/** Write-once storage, if the operator mounts one. A directory otherwise. */
export function fileAnchorSink(directory: string): AnchorSink {
  return {
    method: 'file',
    async deliver(payload) {
      mkdirSync(directory, { recursive: true });
      const name = `anchor-${payload.tenantId}-${payload.sequence}.json`;
      const body = JSON.stringify(
        {
          tenantId: payload.tenantId,
          sequence: payload.sequence,
          hash: payload.hash,
          anchoredAt: payload.anchoredAt.toISOString(),
        },
        null,
        2,
      );
      writeFileSync(join(directory, name), body, { flag: 'wx' });
      return name;
    },
  };
}

/** A mail to an auditor's mailbox: somewhere the operator does not control. */
export function mailAnchorSink(transport: Transport, to: string, tenantName: string): AnchorSink {
  return {
    method: 'mail',
    async deliver(payload) {
      const body =
        `Audit chain anchor for ${tenantName}\n\n` +
        `sequence: ${payload.sequence}\nhash: ${payload.hash}\n` +
        `anchored at: ${payload.anchoredAt.toISOString()}\n\n` +
        `Keep this email. It lets you detect a rewrite of the audit log later.`;
      await transport.send({
        to,
        subject: `Syntra audit anchor — ${tenantName} — sequence ${payload.sequence}`,
        text: body,
        html: `<pre>${body}</pre>`,
      });
      return `mail:${to}:${payload.sequence}`;
    },
  };
}

export async function anchorHead(
  tenantId: string,
  sink: AnchorSink,
  options: { now?: Date } = {},
): Promise<{ sequence: number; status: 'anchored' | 'failed' }> {
  const now = options.now ?? new Date();
  const head = await withTenant(tenantId, (tx) =>
    tx.auditEvent.findFirst({ orderBy: { sequence: 'desc' } }),
  );
  if (head === null) return { sequence: 0, status: 'anchored' };

  // The sink is network or filesystem I/O and never runs inside withTenant.
  let receipt: string | null = null;
  let error: string | null = null;
  try {
    receipt = await sink.deliver({ tenantId, sequence: head.sequence, hash: head.hash, anchoredAt: now });
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }

  await withTenant(tenantId, (tx) =>
    tx.auditAnchor.create({
      data: {
        tenantId,
        sequence: head.sequence,
        hash: head.hash,
        anchoredAt: now,
        method: sink.method,
        receipt: receipt ?? '',
        status: error === null ? 'anchored' : 'failed',
        error,
      },
    }),
  );

  return { sequence: head.sequence, status: error === null ? 'anchored' : 'failed' };
}

export interface IntegrityStatus {
  headSequence: number;
  headHash: string;
  lastCheckpoint: {
    sequence: number;
    verifiedAt: Date;
    signed: boolean;
    /** Which key signed it, so a rotated-out key is identifiable. */
    keyId: string | null;
    /**
     * The SAME predicate `verifyIncremental` seeds on, so the screen cannot
     * say one thing while the verifier does another.
     */
    signatureState: SignatureState | 'none';
  } | null;
  /**
   * The checkpoint's trust, in a sentence a person can act on.
   *
   * `signed: true` alone would let a screen print "signed" over a checkpoint
   * whose signature does not verify. The statement says which of the states
   * this is, and the implementation already produced it -- only this
   * declaration was narrower, which is why `integrityStatus` did not compile
   * against its own return value.
   */
  checkpointStatement: string;
  lastCheck: {
    fromSequence: number;
    toSequence: number;
    result: string;
    startedAt: Date;
    mode: string;
  } | null;
  anchoring: { configured: boolean; lastAnchoredSequence: number | null; statement: string };
}

const NOT_ANCHORED_STATEMENT =
  'External anchoring is off. Someone with database write access and the ability to run code ' +
  'could rewrite the audit log undetected. Turn on anchoring to detect this.';

const ANCHORED_STATEMENT =
  'External anchoring is on. Each anchor records the chain head outside the database.';

const CHECKPOINT_STATEMENTS: Readonly<Record<SignatureState | 'none', string>> = {
  none: 'No checkpoint yet. Verification starts from the first event.',
  signed_and_verified:
    'Last checkpoint is signed and the signature is valid.',
  unsigned_no_signer_configured:
    'Last checkpoint is unsigned and no signing key is set. Set GOVERN_CHECKPOINT_KEY.',
  // The advice NAMES THE VARIABLE, because an earlier version said "configure a
  // checkpoint signing key" while no configuration key for one existed and the
  // scheduler passed `signer: null` on every run. Advice a deployer cannot act
  // on is worse than no advice: it reads as a setting somebody forgot rather
  // than as a feature nobody wired. Task 12 Step 4a adds the variable and Step 5
  // passes it (H-e).
  unsigned_while_signer_configured:
    'Last checkpoint is unsigned but a signing key is set, so the chain was re-verified from the first event. ' +
    'Normal once after turning on signing; if it persists, the checkpoint may be forged.',
  unknown_key:
    'Last checkpoint uses a signing key this deployment does not have. Chain re-verified from the first event.',
  invalid:
    'Last checkpoint signature is not valid. Chain re-verified from the first event.',
};

export async function integrityStatus(
  tx: TenantClient,
  anchoringConfigured: boolean,
  signer: CheckpointSigner | null = null,
): Promise<IntegrityStatus> {
  const head = await tx.auditEvent.findFirst({ orderBy: { sequence: 'desc' } });
  const checkpoint = await tx.auditCheckpoint.findFirst({ orderBy: { sequence: 'desc' } });
  // `checkpointTrust` is an HMAC over 64 bytes with a key already in memory: no
  // network, no KMS, no Argon2. It is the one signing-adjacent call this plan
  // permits inside a `withTenant`, and it is named here so the exception is
  // deliberate. A KMS-backed signer must be verified OUTSIDE the transaction.
  const trust =
    checkpoint === null
      ? { seedable: true, state: 'none' as const }
      : await checkpointTrust(checkpoint, signer);
  const check = await tx.auditChainCheck.findFirst({ orderBy: { startedAt: 'desc' } });
  const anchor = await tx.auditAnchor.findFirst({
    where: { status: 'anchored' },
    orderBy: { sequence: 'desc' },
  });

  return {
    headSequence: head?.sequence ?? 0,
    headHash: head?.hash ?? GENESIS_HASH,
    lastCheckpoint:
      checkpoint === null
        ? null
        : {
            sequence: checkpoint.sequence,
            verifiedAt: checkpoint.verifiedAt,
            signed: checkpoint.signature !== null,
            keyId: checkpoint.keyId,
            // The SAME predicate `verifyIncremental` seeds on, so the screen
            // cannot say one thing while the verifier does another.
            signatureState: trust.state,
          },
    lastCheck:
      check === null
        ? null
        : {
            fromSequence: check.fromSequence,
            toSequence: check.toSequence,
            result: check.result,
            startedAt: check.startedAt,
            mode: check.mode,
          },
    // §20's integrity screen says the checkpoint's signature state in words,
    // the same way it already says the anchoring state, because "signed: false"
    // rendered as a grey dot is exactly how a mitigation that is not in force
    // gets read as one that is.
    checkpointStatement: CHECKPOINT_STATEMENTS[trust.state],
    anchoring: {
      configured: anchoringConfigured,
      lastAnchoredSequence: anchor?.sequence ?? null,
      // Printed in these words, not as a badge. A tenant that has not
      // configured anchoring sees what that means rather than a green tick.
      statement: anchoringConfigured ? ANCHORED_STATEMENT : NOT_ANCHORED_STATEMENT,
    },
  };
}
