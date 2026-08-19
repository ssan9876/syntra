import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import type { CollectedTenant } from './collect.js';
import { SnapshotNotReadableError, readableSnapshot } from './readable.js';
import {
  SNAPSHOT_STALL_MINUTES,
  beginSnapshot,
  buildSnapshot,
  pruneSnapshots,
} from './snapshot-service.js';

const NOW = new Date('2026-06-15T09:00:00Z');
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

let tenantId: string;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
});

const emptyCollection = (over: Partial<CollectedTenant> = {}): CollectedTenant => ({
  asOf: NOW,
  holdings: [],
  gaps: [],
  sources: [
    {
      sourceKind: 'syntraInternal',
      sourceId: 'syntra',
      sourceName: 'Syntra',
      lastRunId: null,
      lastSuccessfulReadAt: NOW,
      lastAttemptedReadAt: NOW,
      completeness: 'complete',
      freshnessSlaHours: 24,
      gapCount: 0,
    },
  ],
  personIds: [],
  personsWithActiveContract: 0,
  unattributedAccountKeys: [],
  queryCount: 9,
  ...over,
});

describe('readableSnapshot — the one enforced accessor', () => {
  it('admits a complete snapshot', async () => {
    const built = await buildSnapshot(tenantId, {
      now: NOW,
      collect: async () => emptyCollection(),
    });
    const readable = await withTenant(tenantId, (tx) => readableSnapshot(tx, built.snapshotId));
    expect(readable).toMatchObject({ id: built.snapshotId, status: 'complete', asOf: NOW });
  });

  it('REFUSES a building snapshot rather than reading half a picture', async () => {
    // A half-built snapshot is indistinguishable from a small organization,
    // and that is the whole reason this function exists.
    const id = await beginSnapshot(tenantId, 'manual', NOW, null);
    await expect(
      withTenant(tenantId, (tx) => readableSnapshot(tx, id)),
    ).rejects.toBeInstanceOf(SnapshotNotReadableError);
  });

  it('REFUSES a failed snapshot', async () => {
    const id = await beginSnapshot(tenantId, 'manual', NOW, null);
    await withTenant(tenantId, (tx) =>
      tx.accessSnapshot.update({ where: { id }, data: { status: 'failed', error: 'boom' } }),
    );
    await expect(
      withTenant(tenantId, (tx) => readableSnapshot(tx, id)),
    ).rejects.toMatchObject({ reason: 'failed' });
  });

  it('REFUSES a complete snapshot with NO SnapshotSource rows', async () => {
    // The empty case. A snapshot that recorded no source has not been shown to
    // have read anything, and a report over it would print totals with a
    // header claiming coverage it never established.
    const id = await withTenant(tenantId, async (tx) => {
      const s = await tx.accessSnapshot.create({
        data: { tenantId, kind: 'manual', status: 'complete', asOf: NOW },
      });
      return s.id;
    });
    await expect(
      withTenant(tenantId, (tx) => readableSnapshot(tx, id)),
    ).rejects.toMatchObject({ reason: 'no_sources' });
  });

  it('defaults to the newest complete snapshot, never to a newer building one', async () => {
    const first = await buildSnapshot(tenantId, { now: NOW, collect: async () => emptyCollection() });
    await beginSnapshot(tenantId, 'scheduled', new Date(NOW.getTime() + 60_000), null);
    const readable = await withTenant(tenantId, (tx) => readableSnapshot(tx));
    expect(readable.id).toBe(first.snapshotId);
  });

  it('refuses when no snapshot exists at all', async () => {
    await expect(
      withTenant(tenantId, (tx) => readableSnapshot(tx)),
    ).rejects.toMatchObject({ reason: 'not_found' });
  });
});

describe('beginSnapshot supersedes a stalled build', () => {
  it('refuses a second concurrent build inside the stall window', async () => {
    await beginSnapshot(tenantId, 'scheduled', NOW, null);
    await expect(beginSnapshot(tenantId, 'manual', NOW, null)).rejects.toThrow(
      /already building/i,
    );
  });

  it('SUPERSEDES a build that crashed, so a crash cannot brick the tenant', async () => {
    // The escape hatch, in the same task as the index. This programme has
    // shipped a one-non-terminal-row index with no adoption path twice: one
    // permanently bricked a target, the other permanently stopped every grant
    // expiring.
    const stalled = await beginSnapshot(tenantId, 'scheduled', NOW, null);
    const later = new Date(NOW.getTime() + (SNAPSHOT_STALL_MINUTES + 1) * 60_000);

    const fresh = await beginSnapshot(tenantId, 'manual', later, null);
    expect(fresh).not.toBe(stalled);

    const rows = await withTenant(tenantId, (tx) =>
      tx.accessSnapshot.findMany({ orderBy: { startedAt: 'asc' } }),
    );
    expect(rows[0]).toMatchObject({ id: stalled, status: 'failed' });
    expect(rows[0]!.error).toContain('superseded');
    expect(rows[1]).toMatchObject({ id: fresh, status: 'building' });
  });

  it('a superseded build is not readable, and the new one is once complete', async () => {
    const stalled = await beginSnapshot(tenantId, 'scheduled', NOW, null);
    const later = new Date(NOW.getTime() + (SNAPSHOT_STALL_MINUTES + 1) * 60_000);
    const built = await buildSnapshot(tenantId, { now: later, collect: async () => emptyCollection({ asOf: later }) });

    await expect(withTenant(tenantId, (tx) => readableSnapshot(tx, stalled))).rejects.toMatchObject({
      reason: 'failed',
    });
    await expect(withTenant(tenantId, (tx) => readableSnapshot(tx, built.snapshotId))).resolves.toMatchObject({
      status: 'complete',
    });
  });
});

describe('buildSnapshot', () => {
  it('writes holdings with their attributions and the derived unattributable flag', async () => {
    const personId = await withTenant(tenantId, async (tx) => {
      const p = await tx.person.create({ data: { tenantId, givenName: 'Anna', familyName: 'Novak' } });
      return p.id;
    });

    const built = await buildSnapshot(tenantId, {
      now: NOW,
      collect: async () =>
        emptyCollection({
          personIds: [personId],
          holdings: [
            {
              subject: { kind: 'person', personId },
              systemKind: 'targetSystem',
              systemId: 'sys-1',
              systemName: 'Acme AD',
              resourceKind: 'targetEntitlement',
              resourceId: 'ent-1',
              resourceName: 'Finance-Payments',
              state: 'held',
              observedAt: day('2026-06-03'),
              observedVia: 'provision:sys-1',
              attribution: {
                rules: [],
                requests: [],
                directAssignments: [],
                groupInheritance: [],
                orgUnitInheritance: [],
                directorySources: [],
                discovered: [{ firstRunId: null, discoveredAt: '2024-02-01T00:00:00Z' }],
                manual: [],
              },
            },
          ],
        }),
    });

    const [holding, attributions] = await withTenant(tenantId, async (tx) => [
      await tx.holding.findFirstOrThrow({ where: { snapshotId: built.snapshotId } }),
      await tx.holdingAttribution.findMany(),
    ]);

    expect(holding).toMatchObject({
      subjectKey: `person:${personId}`,
      personId,
      resourceKind: 'targetEntitlement',
      state: 'held',
      unattributable: true,
      attributionCount: 1,
    });
    // observedAt is the target's truth-time, NOT the snapshot's asOf, and the
    // two being days apart is the whole point of section 8.
    expect(holding.observedAt).toEqual(day('2026-06-03'));
    expect(attributions.map((a) => a.kind)).toEqual(['discovered']);
    expect(built.unattributableCount).toBe(1);
  });

  it('marks a syntraRole holding privileged with no configuration at all', async () => {
    const personId = await withTenant(tenantId, async (tx) => {
      const p = await tx.person.create({ data: { tenantId, givenName: 'A', familyName: 'B' } });
      return p.id;
    });
    const built = await buildSnapshot(tenantId, {
      now: NOW,
      collect: async () =>
        emptyCollection({
          holdings: [
            {
              subject: { kind: 'person', personId },
              systemKind: 'syntraInternal',
              systemId: 'syntra',
              systemName: 'Syntra',
              resourceKind: 'syntraRole',
              resourceId: 'role-1',
              resourceName: 'Owner (tenant.manage)',
              state: 'held',
              observedAt: NOW,
              observedVia: 'syntra',
              attribution: {
                rules: [], requests: [], directAssignments: [], groupInheritance: [],
                orgUnitInheritance: [], directorySources: [], discovered: [], manual: [],
              },
            },
          ],
        }),
    });
    const holding = await withTenant(tenantId, (tx) =>
      tx.holding.findFirstOrThrow({ where: { snapshotId: built.snapshotId } }),
    );
    expect(holding.privileged).toBe(true);
  });

  it('marks a holding privileged from ResourceClassification', async () => {
    const personId = await withTenant(tenantId, async (tx) => {
      const p = await tx.person.create({ data: { tenantId, givenName: 'A', familyName: 'B' } });
      await tx.resourceClassification.create({
        data: { tenantId, systemId: 'sys-1', resourceKind: 'targetEntitlement', resourceId: 'ent-1', privileged: true },
      });
      return p.id;
    });
    const built = await buildSnapshot(tenantId, {
      now: NOW,
      collect: async () =>
        emptyCollection({
          holdings: [
            {
              subject: { kind: 'person', personId },
              systemKind: 'targetSystem', systemId: 'sys-1', systemName: 'AD',
              resourceKind: 'targetEntitlement', resourceId: 'ent-1', resourceName: 'Domain Admins',
              state: 'held', observedAt: NOW, observedVia: 'provision:sys-1',
              attribution: {
                rules: [], requests: [], directAssignments: [], groupInheritance: [],
                orgUnitInheritance: [], directorySources: [], discovered: [], manual: [],
              },
            },
          ],
        }),
    });
    const holding = await withTenant(tenantId, (tx) =>
      tx.holding.findFirstOrThrow({ where: { snapshotId: built.snapshotId } }),
    );
    expect(holding.privileged).toBe(true);
  });

  it('carries firstSeenAt forward from the previous snapshot rather than resetting it', async () => {
    const personId = await withTenant(tenantId, async (tx) => {
      const p = await tx.person.create({ data: { tenantId, givenName: 'A', familyName: 'B' } });
      return p.id;
    });
    const one: Parameters<typeof buildSnapshot>[1] = {
      now: NOW,
      collect: async () =>
        emptyCollection({
          holdings: [
            {
              subject: { kind: 'person', personId },
              systemKind: 'syntraInternal', systemId: 'syntra', systemName: 'Syntra',
              resourceKind: 'syntraGroup', resourceId: 'g-1', resourceName: 'Finance',
              state: 'held', observedAt: NOW, observedVia: 'syntra',
              attribution: {
                rules: [], requests: [], directAssignments: [], groupInheritance: [],
                orgUnitInheritance: [], directorySources: [], discovered: [], manual: [],
              },
            },
          ],
        }),
    };
    await buildSnapshot(tenantId, one);
    const later = new Date(NOW.getTime() + 86_400_000);
    const second = await buildSnapshot(tenantId, {
      ...one,
      now: later,
      collect: async () => ({ ...(await one.collect!(tenantId, { asOf: later })), asOf: later }),
    });

    const holding = await withTenant(tenantId, (tx) =>
      tx.holding.findFirstOrThrow({ where: { snapshotId: second.snapshotId } }),
    );
    expect(holding.firstSeenAt).toEqual(NOW);
  });

  it('writes HoldingEvent rows against the previous snapshot', async () => {
    const personId = await withTenant(tenantId, async (tx) => {
      const p = await tx.person.create({ data: { tenantId, givenName: 'A', familyName: 'B' } });
      return p.id;
    });
    const holdingOf = (resourceId: string) => ({
      subject: { kind: 'person' as const, personId },
      systemKind: 'syntraInternal' as const, systemId: 'syntra', systemName: 'Syntra',
      resourceKind: 'syntraGroup' as const, resourceId, resourceName: resourceId,
      state: 'held' as const, observedAt: NOW, observedVia: 'syntra',
      attribution: {
        rules: [], requests: [], directAssignments: [], groupInheritance: [],
        orgUnitInheritance: [], directorySources: [], discovered: [], manual: [],
      },
    });

    await buildSnapshot(tenantId, { now: NOW, collect: async () => emptyCollection({ holdings: [holdingOf('g-1')] }) });
    const later = new Date(NOW.getTime() + 86_400_000);
    const second = await buildSnapshot(tenantId, {
      now: later,
      collect: async () => emptyCollection({ asOf: later, holdings: [holdingOf('g-2')] }),
    });

    const events = await withTenant(tenantId, (tx) =>
      tx.holdingEvent.findMany({ where: { toSnapshotId: second.snapshotId }, orderBy: { resourceId: 'asc' } }),
    );
    expect(events.map((e) => [e.resourceId, e.change])).toEqual([
      ['g-1', 'lost'],
      ['g-2', 'gained'],
    ]);
    expect(second.eventCount).toBe(2);
  });

  it('marks the snapshot failed and leaves its rows behind when the write throws', async () => {
    // Deleting several million rows inside the failure handler is the same
    // mistake in a different costume. The cleanup job removes them.
    const built = buildSnapshot(tenantId, {
      now: NOW,
      collect: async () => {
        throw new Error('the collector fell over');
      },
    });
    await expect(built).rejects.toThrow('the collector fell over');

    const rows = await withTenant(tenantId, (tx) => tx.accessSnapshot.findMany());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'failed' });
    expect(rows[0]!.error).toContain('the collector fell over');
  });

  it('writes ONE audit event for the whole build, naming the counts', async () => {
    const built = await buildSnapshot(tenantId, { now: NOW, collect: async () => emptyCollection() });
    const events = await withTenant(tenantId, (tx) => tx.auditEvent.findMany());

    // ONE `build` event, not one event in total. The builder deliberately
    // writes a second, `govern.snapshot.begin`, and that one is load-bearing:
    // it is where a superseded stalled build is recorded
    // (`supersededSnapshotId`). Superseding another snapshot is an act on
    // another row, so it carries its own audit entry in the same transaction —
    // and if this build later fails, the `begin` event is the only record that
    // the supersession happened at all. Counting every audit event asserts a
    // total that a correct implementation does not produce.
    const build = events.filter((e) => e.action === 'govern.snapshot.build');
    expect(build).toHaveLength(1);
    expect(build[0]).toMatchObject({ action: 'govern.snapshot.build', targetId: built.snapshotId });
    expect(events.filter((e) => e.action === 'govern.snapshot.begin')).toHaveLength(1);
    // And nothing else: the build writes exactly these two and no third.
    expect(events).toHaveLength(2);
  });

  it('batches the writes so no transaction carries the whole tenant', async () => {
    const personId = await withTenant(tenantId, async (tx) => {
      const p = await tx.person.create({ data: { tenantId, givenName: 'A', familyName: 'B' } });
      return p.id;
    });
    const many = Array.from({ length: 25 }, (_, i) => ({
      subject: { kind: 'person' as const, personId },
      systemKind: 'syntraInternal' as const, systemId: 'syntra', systemName: 'Syntra',
      resourceKind: 'syntraGroup' as const, resourceId: `g-${i}`, resourceName: `g-${i}`,
      state: 'held' as const, observedAt: NOW, observedVia: 'syntra',
      attribution: {
        rules: [], requests: [], directAssignments: [], groupInheritance: [],
        orgUnitInheritance: [], directorySources: [], discovered: [], manual: [],
      },
    }));

    const built = await buildSnapshot(tenantId, {
      now: NOW,
      batchSize: 5,
      collect: async () => emptyCollection({ holdings: many }),
    });
    expect(built.holdingCount).toBe(25);
    const count = await withTenant(tenantId, (tx) =>
      tx.holding.count({ where: { snapshotId: built.snapshotId } }),
    );
    expect(count).toBe(25);
  });
});

describe('pruneSnapshots', () => {
  it('prunes past the retention window and NEVER prunes one an evidence pack points at', async () => {
    const old = await buildSnapshot(tenantId, {
      now: day('2024-01-01'),
      collect: async () => emptyCollection({ asOf: day('2024-01-01') }),
    });
    const alsoOld = await buildSnapshot(tenantId, {
      now: day('2024-01-02'),
      collect: async () => emptyCollection({ asOf: day('2024-01-02') }),
    });
    await withTenant(tenantId, (tx) =>
      tx.evidencePack.create({
        data: {
          tenantId, kind: 'report', snapshotId: alsoOld.snapshotId,
          chainHeadSequence: 1, chainHeadHash: 'x', chainVerificationResult: 'valid',
          chainFromSequence: 1, chainToSequence: 1, digest: 'd', byteLength: 10,
        },
      }),
    );

    const result = await pruneSnapshots(tenantId, { now: NOW, retentionDays: 30 });
    expect(result).toEqual({ pruned: 1, retainedForReference: 1 });

    const remaining = await withTenant(tenantId, (tx) =>
      tx.accessSnapshot.findMany({ select: { id: true } }),
    );
    expect(remaining.map((r) => r.id)).toContain(alsoOld.snapshotId);
    expect(remaining.map((r) => r.id)).not.toContain(old.snapshotId);
  });

  it('never prunes a snapshot an open finding points at', async () => {
    const old = await buildSnapshot(tenantId, {
      now: day('2024-01-01'),
      collect: async () => emptyCollection({ asOf: day('2024-01-01') }),
    });
    await withTenant(tenantId, (tx) =>
      tx.governFinding.create({
        data: {
          tenantId, kind: 'coverage_gap', severity: 'high',
          subjectRefType: 'snapshot', subjectRefId: old.snapshotId,
          detail: {}, firstSeenAt: NOW, lastSeenAt: NOW,
        },
      }),
    );
    const result = await pruneSnapshots(tenantId, { now: NOW, retentionDays: 30 });
    expect(result).toEqual({ pruned: 0, retainedForReference: 1 });
  });
});
