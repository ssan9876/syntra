import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { asDatabaseSuperuser, resetDatabase } from '@syntra/db/src/test-support.js';
import { memoryTransport } from '../notify/notification-service.js';
import { auditEventHash, recordEvent, stableStringify } from '../audit/audit-service.js';
import { AUDIT_CHAIN_REF } from './types.js';
import {
  anchorHead,
  fileAnchorSink,
  integrityStatus,
  localFileCheckpointSigner,
  mailAnchorSink,
  verifyFull,
  verifyIncremental,
  verifySegment,
} from './audit-integrity.js';

const NOW = new Date('2026-06-15T09:00:00Z');
let tenantId: string;

async function appendEvents(count: number) {
  for (let i = 0; i < count; i += 1) {
    await withTenant(tenantId, (tx) =>
      recordEvent(tx, {
        actorUserId: null,
        action: `test.event.${i}`,
        targetType: 'Test',
        targetId: null,
        outcome: 'success',
        sourceIp: null,
        payload: { i },
      }),
    );
  }
}

/**
 * Tampering, with the append-only rules stood down for the duration.
 *
 * `AuditEvent` carries `audit_no_update` and `audit_no_delete`, both
 * `DO INSTEAD NOTHING`, and **a rule is not bypassed by being a superuser** —
 * unlike row-level security, which is. So the plan's bare
 * `asDatabaseSuperuser('UPDATE "AuditEvent" …')` silently did nothing, the
 * chain was genuinely intact, and every case that tampers reported `valid`
 * and failed for a reason that had nothing to do with the verifier.
 *
 * This is the shape `packages/db/src/automate-schema.test.ts` already uses for
 * `ApprovalDecision`. Re-enabled in a `finally` so one failing case cannot
 * leave the table writable for the rest of the file.
 */
const APPEND_ONLY: ReadonlyArray<readonly [table: string, update: string, del: string]> = [
  ['AuditEvent', 'audit_no_update', 'audit_no_delete'],
  ['AuditCheckpoint', 'govern_checkpoint_no_update', 'govern_checkpoint_no_delete'],
];

async function tamper(sql: string, params: unknown[] = []): Promise<void> {
  for (const [table, upd, del] of APPEND_ONLY) {
    await asDatabaseSuperuser(`ALTER TABLE "${table}" DISABLE RULE ${upd}`);
    await asDatabaseSuperuser(`ALTER TABLE "${table}" DISABLE RULE ${del}`);
  }
  try {
    await asDatabaseSuperuser(sql, params);
  } finally {
    for (const [table, upd, del] of APPEND_ONLY) {
      await asDatabaseSuperuser(`ALTER TABLE "${table}" ENABLE RULE ${upd}`);
      await asDatabaseSuperuser(`ALTER TABLE "${table}" ENABLE RULE ${del}`);
    }
  }
}

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
});

describe('the exported primitives', () => {
  it('stableStringify sorts keys, so two orderings of one object agree', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
  });

  it('auditEventHash reproduces the digest recordEvent wrote', async () => {
    // The whole point of exporting it rather than reimplementing it. If this
    // ever disagrees, incremental verification reports a whole chain broken.
    await appendEvents(1);
    const event = await withTenant(tenantId, (tx) => tx.auditEvent.findFirstOrThrow());
    expect(
      auditEventHash({
        tenantId,
        sequence: event.sequence,
        occurredAt: event.occurredAt,
        actorUserId: event.actorUserId,
        action: event.action,
        targetType: event.targetType,
        targetId: event.targetId,
        outcome: event.outcome as 'success',
        sourceIp: event.sourceIp,
        payload: event.payload as Record<string, unknown>,
        prevHash: event.prevHash,
      }),
    ).toBe(event.hash);
  });
});

describe('verifySegment', () => {
  it('verifies a segment from a mid-chain sequence, seeded with the predecessor hash', async () => {
    await appendEvents(10);
    const fifth = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findFirstOrThrow({ where: { sequence: 5 } }),
    );
    const result = await verifySegment(tenantId, 6, fifth.hash);
    expect(result).toMatchObject({ fromSequence: 6, toSequence: 10, result: 'valid' });
  });

  it('pages, so a long chain never loads at once', async () => {
    await appendEvents(25);
    const result = await verifySegment(tenantId, 1, '0'.repeat(64), { pageSize: 4 });
    expect(result).toMatchObject({ result: 'valid', toSequence: 25 });
  });

  it('reports the sequence where an ALTERED event stops reproducing its digest', async () => {
    await appendEvents(5);
    await tamper(`UPDATE "AuditEvent" SET payload = '{"i":99}'::jsonb WHERE "tenantId" = $1 AND sequence = 3`,
      [tenantId],
    );
    const result = await verifySegment(tenantId, 1, '0'.repeat(64));
    expect(result).toMatchObject({ result: 'broken', brokenAtSequence: 3 });
  });

  it('reports the sequence where a DELETED event breaks its successor', async () => {
    await appendEvents(5);
    await tamper(`DELETE FROM "AuditEvent" WHERE "tenantId" = $1 AND sequence = 3`,
      [tenantId],
    );
    const result = await verifySegment(tenantId, 1, '0'.repeat(64));
    expect(result).toMatchObject({ result: 'broken', brokenAtSequence: 4 });
  });

  it('reports valid over an EMPTY segment rather than throwing', async () => {
    const result = await verifySegment(tenantId, 1, '0'.repeat(64));
    expect(result).toMatchObject({ result: 'valid', fromSequence: 1, toSequence: 0 });
  });

  it('the WRITER and the VERIFIER agree on an awkward payload', async () => {
    // `recordEvent` hashes the IN-MEMORY payload; `verifySegment` hashes the
    // payload read back OUT OF JSONB. Anywhere those two disagree, the nightly
    // job reports a `critical` broken chain on a log nobody touched — and a
    // verifier that cries wolf is how an organization learns to ignore it.
    //
    // Two divergences, both found by this fixture:
    //
    //  - `undefined`: Prisma drops the key on write and it returns absent.
    //  - `0.1 + 0.2`: Prisma's engine re-serialises a JS number at 16
    //    significant digits, so `0.30000000000000004` reaches the database as
    //    `0.3`. `SELECT payload::text` confirms it -- the digit is lost on the
    //    WRITE, not on the read back.
    //
    // `canonicalPayload` resolves both by hashing and storing the same value.
    // THIS TEST is what says so, and it must be made to pass by changing the
    // code and not by deleting an awkward key from the fixture.
    await withTenant(tenantId, (tx) =>
      recordEvent(tx, {
        actorUserId: null,
        action: 'govern.test.awkward',
        targetType: 'Test',
        targetId: null,
        outcome: 'success',
        sourceIp: null,
        payload: {
          absent: undefined,
          unicode: 'Ijsbrand — ij, naive, nihongo, emoji',
          nested: [1, [2, 3], { a: null }],
          float: 0.1 + 0.2,
          bigish: 9007199254740991,
          negativeZero: -0,
          emptyString: '',
          emptyObject: {},
        } as Record<string, unknown>,
      }),
    );

    const result = await verifySegment(tenantId, 1, '0'.repeat(64));
    expect(result).toMatchObject({ result: 'valid' });
  });
});

describe('verifyIncremental', () => {
  it('writes a checkpoint and an AuditChainCheck, and verifies only the new segment next time', async () => {
    await appendEvents(5);
    const first = await verifyIncremental(tenantId, { now: NOW });
    expect(first).toMatchObject({ result: 'valid', fromSequence: 1, toSequence: 5 });

    await appendEvents(3);
    const second = await verifyIncremental(tenantId, { now: NOW });
    // The whole point: the second run starts at 6, not at 1.
    expect(second.fromSequence).toBe(6);
    expect(second.checkpointSequence).toBe(5);

    const [checkpoints, checks] = await withTenant(tenantId, async (tx) => [
      await tx.auditCheckpoint.findMany({ orderBy: { sequence: 'asc' } }),
      await tx.auditChainCheck.findMany({ orderBy: { fromSequence: 'asc' } }),
    ]);
    expect(checkpoints.map((c) => c.sequence)).toEqual([5, 8]);
    expect(checks.map((c) => [c.fromSequence, c.toSequence, c.mode])).toEqual([
      [1, 5, 'incremental'],
      [6, 8, 'incremental'],
    ]);
  });

  it('raises a CRITICAL finding when the chain does not hold, naming the sequence', async () => {
    await appendEvents(5);
    await tamper(`UPDATE "AuditEvent" SET action = 'tampered' WHERE "tenantId" = $1 AND sequence = 2`,
      [tenantId],
    );
    const result = await verifyIncremental(tenantId, { now: NOW });
    expect(result.result).toBe('broken');

    const critical = await withTenant(tenantId, (tx) =>
      tx.governFinding.findFirstOrThrow({ where: { severity: 'critical' } }),
    );
    expect(critical.kind).toBe('audit_chain_broken');
    expect(critical.subjectRefId).toBe(`${AUDIT_CHAIN_REF}2`);
    expect(critical.detail).toMatchObject({ brokenAtSequence: 2 });

    // C-a's regression guard, and the reason it is an assertion rather than a
    // comment. Both integrity findings were once raised under `coverage_gap`,
    // which IS a member of the snapshot build's `STANDING_KINDS`, so the next
    // nightly build resolved them with a snapshot that had read no audit events
    // at all. The kind is the fix; this line is what stops somebody un-fixing it
    // by reaching for an existing kind.
    //
    // (An earlier form of this test looked up `coverage_gap` with
    // `findFirstOrThrow(...).catch(() => null)` and asserted `toBeNull()` while
    // the code raised exactly that kind — red against its own step. It now
    // passes for the reason it claims to.)
    const coverageGap = await withTenant(tenantId, (tx) =>
      tx.governFinding.findFirst({ where: { kind: 'coverage_gap' } }),
    );
    expect(coverageGap).toBeNull();
  });

  it('RE-ESTABLISHES a checkpoint after a clean genesis walk, so the refusal is not a trap', async () => {
    // Ruling G-12. Before this, an untrusted checkpoint was permanent: the
    // checkpoint write is unreachable while `result` is forced `broken`,
    // `AuditCheckpoint` is append-only, and `verifyFull` writes no checkpoint —
    // so the tenant walked from genesis on every run for the life of the system
    // with a `critical` finding nothing could clear.
    const signer = localFileCheckpointSigner('key-1', Buffer.alloc(32, 9));
    await appendEvents(3);
    await verifyIncremental(tenantId, { now: NOW, signer });
    await tamper(`UPDATE "AuditCheckpoint" SET signature = NULL, "keyId" = NULL WHERE "tenantId" = $1`,
      [tenantId],
    );

    // The refusal is NOT softened: this run still reports broken and still
    // raises the finding. What changes is that it leaves a way out.
    const refused = await verifyIncremental(tenantId, { now: NOW, signer });
    expect(refused.result).toBe('broken');
    expect(refused.signatureState).toBe('unsigned_while_signer_configured');

    const checkpoints = await withTenant(tenantId, (tx) =>
      tx.auditCheckpoint.findMany({ orderBy: { sequence: 'asc' } }),
    );
    // Append-only preserved: the refused row is untouched and a LATER row
    // supersedes it. `@@unique([tenantId, sequence])` is why the new one cannot
    // sit at sequence 3, and why the audit event is appended first.
    expect(checkpoints).toHaveLength(2);
    expect(checkpoints[0]).toMatchObject({ sequence: 3, signature: null, keyId: null });
    expect(checkpoints[1]!.sequence).toBeGreaterThan(3);
    expect(checkpoints[1]!.keyId).toBe('key-1');

    // And it says why, in the log the chain itself protects.
    const event = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findFirstOrThrow({
        where: { action: 'govern.audit.checkpoint_reestablished' },
      }),
    );
    expect(event.payload).toMatchObject({
      refusedCheckpointSequence: 3,
      refusedSignatureState: 'unsigned_while_signer_configured',
    });

    // The finding SURVIVES the run that recovered. An alarm raised and cleared
    // inside one run is an alarm nobody ever sees, and a forged checkpoint over
    // a rewritten-but-self-consistent chain is detectable ONLY by this finding.
    const stillOpen = await withTenant(tenantId, (tx) =>
      tx.governFinding.findFirstOrThrow({ where: { kind: 'audit_chain_broken' } }),
    );
    expect(stillOpen.status).toBe('open');

    // It clears on the NEXT run, which is incremental again because the head
    // checkpoint now verifies.
    await appendEvents(2);
    const recovered = await verifyIncremental(tenantId, { now: NOW, signer });
    expect(recovered.result).toBe('valid');
    expect(recovered.signatureState).toBe('signed_and_verified');
    expect(recovered.fromSequence).toBeGreaterThan(1);

    const closed = await withTenant(tenantId, (tx) =>
      tx.governFinding.findFirstOrThrow({ where: { kind: 'audit_chain_broken' } }),
    );
    expect(closed.status).toBe('resolved');
    // The one kind that resolves without naming a snapshot. The CHECK
    // constraint exempts it by name, because no snapshot build can show an
    // audit chain break gone.
    expect(closed.resolvedBySnapshotId).toBeNull();
  });

  it('writes NO new checkpoint when the head is BEHIND the refused one', async () => {
    // Truncation. `recordEvent` assigns `(max(sequence) ?? 0) + 1`, so once the
    // tail of the log is gone the next event reuses a sequence BELOW the
    // refused checkpoint — and `AuditCheckpoint` is `@@unique([tenantId,
    // sequence])`, so a row written there is either a constraint violation or,
    // worse, a "later" row that is not later at all and leaves the refused
    // checkpoint as head. A walk from genesis over a truncated log returns
    // `valid` (nothing in the surviving prefix is wrong), which is exactly why
    // the checkpoint that outranks it must keep its finding.
    const signer = localFileCheckpointSigner('key-1', Buffer.alloc(32, 9));
    await appendEvents(5);
    await verifyIncremental(tenantId, { now: NOW, signer });
    await tamper(`DELETE FROM "AuditEvent" WHERE "tenantId" = $1 AND sequence > 3`,
      [tenantId],
    );
    await tamper(`UPDATE "AuditCheckpoint" SET signature = NULL, "keyId" = NULL WHERE "tenantId" = $1`,
      [tenantId],
    );

    const result = await verifyIncremental(tenantId, { now: NOW, signer });
    expect(result.result).toBe('broken');

    const checkpoints = await withTenant(tenantId, (tx) =>
      tx.auditCheckpoint.findMany({ orderBy: { sequence: 'asc' } }),
    );
    expect(checkpoints.map((c) => c.sequence)).toEqual([5]);

    const finding = await withTenant(tenantId, (tx) =>
      tx.governFinding.findFirstOrThrow({ where: { kind: 'audit_chain_broken' } }),
    );
    expect(finding.status).toBe('open');
  });

  it('writes NO new checkpoint when the genesis walk ALSO fails', async () => {
    // Recovery is gated on evidence, not on state. A refused checkpoint over a
    // chain that does not hold gets no way out, which is the whole point.
    const signer = localFileCheckpointSigner('key-1', Buffer.alloc(32, 9));
    await appendEvents(4);
    await verifyIncremental(tenantId, { now: NOW, signer });
    await tamper(`UPDATE "AuditCheckpoint" SET signature = NULL, "keyId" = NULL WHERE "tenantId" = $1`,
      [tenantId],
    );
    await tamper(`UPDATE "AuditEvent" SET action = 'tampered' WHERE "tenantId" = $1 AND sequence = 2`,
      [tenantId],
    );

    const result = await verifyIncremental(tenantId, { now: NOW, signer });
    expect(result.result).toBe('broken');

    const checkpoints = await withTenant(tenantId, (tx) => tx.auditCheckpoint.findMany());
    expect(checkpoints).toHaveLength(1);
    const events = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'govern.audit.checkpoint_reestablished' } }),
    );
    expect(events).toEqual([]);
  });

  it('an INCREMENTAL clean run never closes a break it did not look at', async () => {
    // The other half of the resolution rule. A run seeded from a trusted
    // checkpoint verified the segment AFTER it and said nothing whatever about
    // the range before, so it must not resolve an `audit-chain:*` finding.
    await appendEvents(3);
    await verifyIncremental(tenantId, { now: NOW });

    await withTenant(tenantId, (tx) =>
      tx.governFinding.create({
        data: {
          tenantId,
          kind: 'audit_chain_broken',
          severity: 'critical',
          subjectRefType: 'snapshot',
          subjectRefId: `${AUDIT_CHAIN_REF}2`,
          detail: {},
          firstSeenAt: NOW,
          lastSeenAt: NOW,
        },
      }),
    );

    await appendEvents(2);
    const second = await verifyIncremental(tenantId, { now: NOW });
    expect(second.fromSequence).toBe(4);
    expect(second.result).toBe('valid');

    const finding = await withTenant(tenantId, (tx) =>
      tx.governFinding.findFirstOrThrow({ where: { kind: 'audit_chain_broken' } }),
    );
    expect(finding.status).toBe('open');
  });

  it('writes NO checkpoint when the segment is broken', async () => {
    // A checkpoint over a broken segment would seed the next incremental run
    // with a hash from a chain that does not hold, and every subsequent run
    // would report valid.
    await appendEvents(4);
    await tamper(`UPDATE "AuditEvent" SET action = 'x' WHERE "tenantId" = $1 AND sequence = 2`,
      [tenantId],
    );
    await verifyIncremental(tenantId, { now: NOW });
    const checkpoints = await withTenant(tenantId, (tx) => tx.auditCheckpoint.findMany());
    expect(checkpoints).toEqual([]);
  });

  it('signs the checkpoint when a signer is supplied, and the signature verifies', async () => {
    await appendEvents(3);
    const signer = localFileCheckpointSigner('key-1', Buffer.alloc(32, 9));
    await verifyIncremental(tenantId, { now: NOW, signer });

    const checkpoint = await withTenant(tenantId, (tx) => tx.auditCheckpoint.findFirstOrThrow());
    expect(checkpoint.signature).not.toBeNull();
    expect(checkpoint.keyId).toBe('key-1');
    await expect(
      signer.verify(`${checkpoint.sequence}:${checkpoint.hash}`, checkpoint.signature!),
    ).resolves.toBe(true);
    await expect(signer.verify(`999:${checkpoint.hash}`, checkpoint.signature!)).resolves.toBe(false);
  });

  it('REFUSES to seed from a checkpoint whose hash was tampered with, and reports broken', async () => {
    // The attack section 17 names, executed exactly: rewrite the chain, insert
    // a checkpoint that vouches for the rewrite. If `verify` is never called on
    // the production path, every subsequent run reports `valid` over a segment
    // that begins after the tampering, forever — and section 17's mitigation is
    // printed on the cover of every evidence bundle as though it held.
    const signer = localFileCheckpointSigner('key-1', Buffer.alloc(32, 9));
    await appendEvents(4);
    await verifyIncremental(tenantId, { now: NOW, signer });

    await tamper(`UPDATE "AuditCheckpoint" SET hash = $2 WHERE "tenantId" = $1`,
      [tenantId, 'f'.repeat(64)],
    );
    await appendEvents(2);

    const result = await verifyIncremental(tenantId, { now: NOW, signer });
    expect(result.result).toBe('broken');
    expect(result.signatureState).toBe('invalid');
    // It re-walked from genesis rather than trusting the checkpoint's sequence.
    expect(result.fromSequence).toBe(1);

    const check = await withTenant(tenantId, (tx) =>
      tx.auditChainCheck.findFirstOrThrow({ orderBy: { startedAt: 'desc' } }),
    );
    expect(check.mode).toBe('full_fallback');

    const finding = await withTenant(tenantId, (tx) =>
      tx.governFinding.findFirstOrThrow({ where: { subjectRefId: { startsWith: 'audit-checkpoint:' } } }),
    );
    expect(finding.severity).toBe('critical');
    expect(finding.detail).toMatchObject({ checkpointSequence: 4 });
    expect(String((finding.detail as Record<string, unknown>)['statement'])).toContain(
      'does not carry a valid signature',
    );
  });

  it('REFUSES to seed from an UNSIGNED checkpoint while a signer is configured', async () => {
    // The cheaper half of the same attack: the forger does not need the key at
    // all if an unsigned checkpoint is honoured.
    const signer = localFileCheckpointSigner('key-1', Buffer.alloc(32, 9));
    await appendEvents(3);
    await verifyIncremental(tenantId, { now: NOW, signer });
    await tamper(`UPDATE "AuditCheckpoint" SET signature = NULL, "keyId" = NULL WHERE "tenantId" = $1`,
      [tenantId],
    );

    const result = await verifyIncremental(tenantId, { now: NOW, signer });
    expect(result.signatureState).toBe('unsigned_while_signer_configured');
    expect(result.fromSequence).toBe(1);
    expect(result.result).toBe('broken');
  });

  it('DOES seed from an unsigned checkpoint when no signer is configured, and says what that is worth', async () => {
    // The honest case. Requiring a signature where none was ever configured
    // would turn every incremental run into a full walk forever, which is the
    // integrity check too expensive to run that this task exists to avoid.
    await appendEvents(3);
    await verifyIncremental(tenantId, { now: NOW });
    await appendEvents(2);

    const result = await verifyIncremental(tenantId, { now: NOW });
    expect(result.fromSequence).toBe(4);
    expect(result.result).toBe('valid');
    expect(result.signatureState).toBe('unsigned_no_signer_configured');

    const status = await withTenant(tenantId, (tx) => integrityStatus(tx, false, null));
    expect(status.checkpointStatement).toContain('UNSIGNED and no signing key is configured');
    expect(status.lastCheckpoint).toMatchObject({ signatureState: 'unsigned_no_signer_configured' });
  });
});

describe('verifyFull', () => {
  it('walks from genesis regardless of checkpoints', async () => {
    await appendEvents(6);
    await verifyIncremental(tenantId, { now: NOW });
    const full = await verifyFull(tenantId, { pageSize: 2 });
    expect(full).toMatchObject({ fromSequence: 1, toSequence: 6, result: 'valid' });

    const check = await withTenant(tenantId, (tx) =>
      tx.auditChainCheck.findFirstOrThrow({ where: { mode: 'full' } }),
    );
    expect(check.fromSequence).toBe(1);
  });
});

describe('anchoring', () => {
  it('writes a file receipt and records the anchor', async () => {
    await appendEvents(3);
    const dir = mkdtempSync(join(tmpdir(), 'syntra-anchor-'));
    const result = await anchorHead(tenantId, fileAnchorSink(dir), { now: NOW });
    expect(result).toEqual({ sequence: 3, status: 'anchored' });

    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(readFileSync(join(dir, files[0]!), 'utf8')).toContain('"sequence": 3');

    const row = await withTenant(tenantId, (tx) => tx.auditAnchor.findFirstOrThrow());
    expect(row).toMatchObject({ sequence: 3, method: 'file', status: 'anchored' });
  });

  it('records a FAILED anchor rather than throwing, and says why', async () => {
    await appendEvents(1);
    const failing = {
      method: 'file' as const,
      deliver: async () => {
        throw new Error('the write-once volume is not mounted');
      },
    };
    const result = await anchorHead(tenantId, failing, { now: NOW });
    expect(result.status).toBe('failed');
    const row = await withTenant(tenantId, (tx) => tx.auditAnchor.findFirstOrThrow());
    expect(row.error).toContain('write-once volume');
  });

  it('mails a receipt through the transport', async () => {
    await appendEvents(2);
    const transport = memoryTransport();
    await anchorHead(tenantId, mailAnchorSink(transport, 'auditor@example.test', 'Acme'), { now: NOW });
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]!.to).toBe('auditor@example.test');
  });
});

describe('integrityStatus', () => {
  it('states IN WORDS that anchoring is not configured, rather than a green tick', async () => {
    await appendEvents(2);
    await verifyIncremental(tenantId, { now: NOW });
    const status = await withTenant(tenantId, (tx) => integrityStatus(tx, false));
    expect(status.anchoring.configured).toBe(false);
    expect(status.anchoring.statement).toContain('not proof against the operator');
    expect(status.headSequence).toBe(2);
    expect(status.lastCheckpoint).toMatchObject({ sequence: 2, signed: false });
  });

  it('says what anchoring does establish once it is configured', async () => {
    await appendEvents(2);
    const dir = mkdtempSync(join(tmpdir(), 'syntra-anchor-'));
    await anchorHead(tenantId, fileAnchorSink(dir), { now: NOW });
    const status = await withTenant(tenantId, (tx) => integrityStatus(tx, true));
    expect(status.anchoring.lastAnchoredSequence).toBe(2);
    expect(status.anchoring.statement).toContain('outside the database');
  });
});
