import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { asDatabaseSuperuser, resetDatabase } from '@syntra/db/src/test-support.js';
import { recordEvent } from '../audit/audit-service.js';
import { verifyIncremental } from './audit-integrity.js';
import type { CollectedTenant } from './collect.js';
import { SnapshotNotReadableError, readableSnapshot } from './readable.js';
import {
  GAIN_LINK_BATCH,
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

  /**
   * THE PROMISE IN THIS FUNCTION'S OWN DOCSTRING, which the code kept for two
   * of the three references and not for the third.
   *
   * A campaign closed 400 days ago is precisely the campaign an auditor asks
   * about. `Campaign.snapshotId` is a bare uuid with no foreign key, so nothing
   * stopped the delete at the database either -- the campaign was simply left
   * pointing at a snapshot that no longer exists, and `readableSnapshot` then
   * throws `not_found` for its report, its re-base and its evidence pack. The
   * attestation somebody signed can no longer be shown against the facts it was
   * signed about, which is the destruction of evidence this whole module exists
   * to prevent.
   */
  it('NEVER prunes a snapshot a campaign points at', async () => {
    const old = await buildSnapshot(tenantId, {
      now: day('2024-01-01'),
      collect: async () => emptyCollection({ asOf: day('2024-01-01') }),
    });
    const owner = await withTenant(tenantId, (tx) =>
      tx.person.create({ data: { tenantId, givenName: 'Ola', familyName: 'Berg' } }),
    );
    await withTenant(tenantId, (tx) =>
      tx.campaign.create({
        data: {
          tenantId,
          name: 'Q1 2024 review',
          scope: {},
          snapshotId: old.snapshotId,
          reviewerSelector: 'manager',
          fallbackSelector: 'campaign_owner',
          ownerPersonId: owner.id,
          opensAt: day('2024-01-01'),
          dueAt: day('2024-02-01'),
          originalDueAt: day('2024-02-01'),
          status: 'closed_complete',
        },
      }),
    );

    const result = await pruneSnapshots(tenantId, { now: NOW, retentionDays: 30 });
    expect(result).toEqual({ pruned: 0, retainedForReference: 1 });
    expect(
      await withTenant(tenantId, (tx) =>
        tx.accessSnapshot.count({ where: { id: old.snapshotId } }),
      ),
    ).toBe(1);
  });

  /**
   * A re-based campaign points at TWO snapshots and both are evidence: the one
   * it was generated from and the one it was moved onto. §8 rule 2 records the
   * re-base "with counts" precisely so the pair can be compared later, and a
   * comparison with one side deleted is not a comparison.
   */
  it('retains the snapshot a re-based campaign came FROM as well', async () => {
    const from = await buildSnapshot(tenantId, {
      now: day('2024-01-01'),
      collect: async () => emptyCollection({ asOf: day('2024-01-01') }),
    });
    const onto = await buildSnapshot(tenantId, {
      now: day('2024-02-01'),
      collect: async () => emptyCollection({ asOf: day('2024-02-01') }),
    });
    const owner = await withTenant(tenantId, (tx) =>
      tx.person.create({ data: { tenantId, givenName: 'Ola', familyName: 'Berg' } }),
    );
    await withTenant(tenantId, (tx) =>
      tx.campaign.create({
        data: {
          tenantId,
          name: 'Q1 2024 review',
          scope: {},
          snapshotId: onto.snapshotId,
          rebasedFromSnapshotId: from.snapshotId,
          reviewerSelector: 'manager',
          fallbackSelector: 'campaign_owner',
          ownerPersonId: owner.id,
          opensAt: day('2024-01-01'),
          dueAt: day('2024-02-01'),
          originalDueAt: day('2024-02-01'),
          status: 'closed_complete',
        },
      }),
    );

    const result = await pruneSnapshots(tenantId, { now: NOW, retentionDays: 30 });
    expect(result).toEqual({ pruned: 0, retainedForReference: 2 });
  });

  /**
   * And the item's OWN snapshot, which a re-base moves per item -- so a
   * campaign whose items sit on three different snapshots holds all three.
   * `CampaignItem.holdingSnapshotId` is the snapshot the copied attribution set
   * came from, and it is what "attested against these facts" means.
   */
  it('retains a snapshot only a campaign ITEM points at', async () => {
    const itemSnapshot = await buildSnapshot(tenantId, {
      now: day('2024-01-01'),
      collect: async () => emptyCollection({ asOf: day('2024-01-01') }),
    });
    const campaignSnapshot = await buildSnapshot(tenantId, {
      now: day('2024-02-01'),
      collect: async () => emptyCollection({ asOf: day('2024-02-01') }),
    });
    const owner = await withTenant(tenantId, (tx) =>
      tx.person.create({ data: { tenantId, givenName: 'Ola', familyName: 'Berg' } }),
    );
    await withTenant(tenantId, async (tx) => {
      const campaign = await tx.campaign.create({
        data: {
          tenantId,
          name: 'Q1 2024 review',
          scope: {},
          snapshotId: campaignSnapshot.snapshotId,
          reviewerSelector: 'manager',
          fallbackSelector: 'campaign_owner',
          ownerPersonId: owner.id,
          opensAt: day('2024-01-01'),
          dueAt: day('2024-02-01'),
          originalDueAt: day('2024-02-01'),
          status: 'closed_complete',
        },
      });
      await tx.campaignItem.create({
        data: {
          tenantId,
          campaignId: campaign.id,
          holdingSnapshotId: itemSnapshot.snapshotId,
          subjectKey: `person:${owner.id}`,
          personId: owner.id,
          systemId: 'syntra',
          resourceKind: 'syntraGroup',
          resourceId: 'g1',
          resourceName: 'Ward Nurses',
          observedAt: day('2024-01-01'),
          coverageStatus: 'complete',
          status: 'certified',
        },
      });
    });

    const result = await pruneSnapshots(tenantId, { now: NOW, retentionDays: 30 });
    expect(result).toEqual({ pruned: 0, retainedForReference: 2 });
  });
});

describe('the audit integrity finding and the nightly detect stage (C-a)', () => {
  it('does NOT resolve an audit_chain_broken finding on the next snapshot build', async () => {
    // C1's fix and C5's fix meet here. The detect stage sweeps STANDING_KINDS
    // with the drafts it computed; `coverage_gap` is a member and its only
    // producer emits `subjectRefType: 'source'`. While the audit verifier
    // raised its two `critical` findings under `coverage_gap`, EVERY nightly
    // build resolved them — `resolvedBySnapshotId` naming a snapshot that had
    // read no audit events at all. Slice 1's headline integrity output went
    // quiet overnight, exactly as its findings output did before C1.
    //
    // No individual finding asks this question, because each was verified
    // against the world before the other existed (Ruling G-11).
    await withTenant(tenantId, async (tx) => {
      for (let i = 0; i < 5; i += 1) {
        await recordEvent(tx, {
          actorUserId: null,
          action: `govern.test.event.${i}`,
          targetType: 'Test',
          targetId: null,
          outcome: 'success',
          sourceIp: null,
          payload: { i },
        });
      }
    });
    // The rules have to come off first. PostgreSQL RULES are NOT bypassed by
    // superuser the way RLS is, so a bare superuser UPDATE against
    // `AuditEvent` is rewritten to DO INSTEAD NOTHING: it reports success,
    // changes nothing, and this case then asserts that an UNTAMPERED chain
    // raised no finding -- which it would not.
    await asDatabaseSuperuser('ALTER TABLE "AuditEvent" DISABLE RULE audit_no_update');
    try {
      await asDatabaseSuperuser(
        `UPDATE "AuditEvent" SET action = 'tampered' WHERE "tenantId" = $1 AND sequence = 2`,
        [tenantId],
      );
    } finally {
      await asDatabaseSuperuser('ALTER TABLE "AuditEvent" ENABLE RULE audit_no_update');
    }
    await verifyIncremental(tenantId, { now: NOW });

    const raised = await withTenant(tenantId, (tx) =>
      tx.governFinding.findFirstOrThrow({ where: { kind: 'audit_chain_broken' } }),
    );
    expect(raised.status).toBe('open');

    // A whole, ordinary nightly build. It runs the detect stage and its sweep.
    const built = await buildSnapshot(tenantId, {
      now: NOW,
      collect: async () => emptyCollection(),
    });

    const after = await withTenant(tenantId, (tx) =>
      tx.governFinding.findUniqueOrThrow({ where: { id: raised.id } }),
    );
    expect(after.status).toBe('open');
    expect(after.resolvedBySnapshotId).toBeNull();
    expect(after.resolvedBySnapshotId).not.toBe(built.snapshotId);
  });
});

/**
 * One person, two `User` rows -- explicitly supported by the sync design,
 * and the shape that used to end every nightly build.
 *
 * `collect` emits a holding per (userId, resource) while the subject key is
 * the PERSON, so two accounts holding one application collide on
 * `Holding`'s unique key. `createMany` has no upsert: the snapshot failed
 * with P2002, and so did every build after it, because the shape does not
 * go away on its own.
 */
describe('a person holding one resource through two accounts', () => {
  const viaTwoAccounts = (personId: string): Partial<CollectedTenant> => ({
    personIds: [personId],
    personsWithActiveContract: 1,
    holdings: [
      {
        subject: { kind: 'person', personId },
        systemKind: 'syntraInternal',
        systemId: 'syntra',
        systemName: 'Syntra',
        resourceKind: 'application',
        resourceId: 'app-1',
        resourceName: 'CRM',
        state: 'held',
        observedAt: NOW,
        observedVia: 'user-a',
        attribution: {
          rules: [], requests: [], directAssignments: [],
          groupInheritance: [{ groupId: 'g1', groupName: 'Ward Nurses', assignmentId: 'a-1' }],
          orgUnitInheritance: [], directorySources: [], discovered: [], manual: [],
        },
      },
      {
        subject: { kind: 'person', personId },
        systemKind: 'syntraInternal',
        systemId: 'syntra',
        systemName: 'Syntra',
        resourceKind: 'application',
        resourceId: 'app-1',
        resourceName: 'CRM',
        state: 'held',
        observedAt: NOW,
        observedVia: 'user-b',
        attribution: {
          rules: [], requests: [], directAssignments: [],
          groupInheritance: [{ groupId: 'g2', groupName: 'Bank Staff', assignmentId: 'a-2' }],
          orgUnitInheritance: [], directorySources: [], discovered: [], manual: [],
        },
      },
    ],
  });

  const buildFor = async (personId: string) =>
    buildSnapshot(tenantId, {
      now: NOW,
      collect: async () => emptyCollection(viaTwoAccounts(personId)),
    });

  const aPerson = async () =>
    withTenant(tenantId, (tx) =>
      tx.person.create({ data: { tenantId, givenName: 'Maya', familyName: 'Okafor' } }),
    );

  it('builds instead of failing the snapshot', async () => {
    const person = await aPerson();
    const built = await buildFor(person.id);

    const snapshot = await withTenant(tenantId, (tx) =>
      tx.accessSnapshot.findUniqueOrThrow({ where: { id: built.snapshotId } }),
    );
    expect(snapshot.status).toBe('complete');
    expect(snapshot.error).toBeNull();
  });

  it('writes ONE holding, not two', async () => {
    const person = await aPerson();
    const built = await buildFor(person.id);

    const holdings = await withTenant(tenantId, (tx) =>
      tx.holding.findMany({ where: { snapshotId: built.snapshotId } }),
    );
    expect(holdings).toHaveLength(1);
  });

  /**
   * Union rather than discard. Each account is a separate true reason the
   * person holds this, and dropping one would make the holding look less
   * attributable than it is -- which is a claim the reviewer acts on.
   */
  it('keeps BOTH accounts as attributions of the one holding', async () => {
    const person = await aPerson();
    const built = await buildFor(person.id);

    const holding = await withTenant(tenantId, (tx) =>
      tx.holding.findFirstOrThrow({
        where: { snapshotId: built.snapshotId },
        include: { attributions: true },
      }),
    );
    expect(holding.attributions).toHaveLength(2);
    expect(holding.attributionCount).toBe(2);
  });
});

/**
 * The cross-reference that used to end the build.
 *
 * `explained = false` on a gain is, in this file's own words, "the most
 * valuable row this system produces": access appeared and SYNTRA DID NOT CAUSE
 * IT. It was produced by a loop issuing one `update` per gain inside a single
 * transaction -- so after a bulk provisioning run, which is the day the change
 * report matters most, it blew the 5000 ms ceiling, `buildSnapshot`'s catch
 * marked the whole snapshot `failed`, and the night's holdings, findings and
 * diff went with it.
 */
describe('the gain / audit cross-reference', () => {
  const holdingOf = (personId: string, resourceId: string, asOf: Date) => ({
    subject: { kind: 'person' as const, personId },
    systemKind: 'syntraInternal' as const,
    systemId: 'syntra',
    systemName: 'Syntra',
    resourceKind: 'syntraGroup' as const,
    resourceId,
    resourceName: `Group ${resourceId}`,
    state: 'held' as const,
    observedAt: asOf,
    observedVia: 'syntra',
    attribution: {
      rules: [],
      requests: [],
      directAssignments: [],
      groupInheritance: [],
      orgUnitInheritance: [],
      directorySources: [],
      discovered: [],
      manual: [],
    },
  });

  const personNamed = async (name: string): Promise<string> =>
    withTenant(tenantId, async (tx) => {
      const p = await tx.person.create({ data: { tenantId, givenName: name, familyName: 'Okafor' } });
      return p.id;
    });

  it('marks a gain EXPLAINED when an audit event accounts for it', async () => {
    const personId = await personNamed('Maya');

    await buildSnapshot(tenantId, { now: NOW, collect: async () => emptyCollection() });

    await withTenant(tenantId, (tx) =>
      recordEvent(tx, {
        actorUserId: null,
        action: 'rbac.role.assign',
        targetType: 'User',
        targetId: null,
        outcome: 'success',
        sourceIp: null,
        payload: { personId, resourceId: 'g1' },
      }),
    );

    const later = new Date(NOW.getTime() + 3_600_000);
    const built = await buildSnapshot(tenantId, {
      now: later,
      collect: async () =>
        emptyCollection({
          asOf: later,
          personIds: [personId],
          personsWithActiveContract: 1,
          holdings: [holdingOf(personId, 'g1', later)],
        }),
    });

    const events = await withTenant(tenantId, (tx) =>
      tx.holdingEvent.findMany({ where: { toSnapshotId: built.snapshotId, change: 'gained' } }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.explained).toBe(true);
    expect(events[0]!.auditEventSequence).not.toBeNull();
  });

  it('leaves a gain UNEXPLAINED when nothing accounts for it', async () => {
    // The row this whole pass exists to produce.
    const personId = await personNamed('Maya');

    await buildSnapshot(tenantId, { now: NOW, collect: async () => emptyCollection() });
    const later = new Date(NOW.getTime() + 3_600_000);
    const built = await buildSnapshot(tenantId, {
      now: later,
      collect: async () =>
        emptyCollection({
          asOf: later,
          personIds: [personId],
          personsWithActiveContract: 1,
          holdings: [holdingOf(personId, 'g2', later)],
        }),
    });

    const events = await withTenant(tenantId, (tx) =>
      tx.holdingEvent.findMany({ where: { toSnapshotId: built.snapshotId, change: 'gained' } }),
    );
    expect(events[0]!.explained).toBe(false);
    expect(events[0]!.auditEventSequence).toBeNull();
  });

  it('links every gain when there are more of them than one batch', async () => {
    // The batching itself, over a population larger than `GAIN_LINK_BATCH`, so
    // a paging bug shows as a count rather than as a slow test.
    // ONE `createMany` with pre-generated ids, not 205 sequential creates.
    // This file's `beforeEach` truncates every table, and a test that spends
    // 205 round trips on its fixture pushes the ones after it past the 30 s
    // hook timeout -- which reads as an unrelated failure somewhere else in the
    // file. The ids have to be known up front because the holdings and the
    // audit payloads both reference them.
    const people = Array.from({ length: GAIN_LINK_BATCH + 5 }, () => randomUUID());
    await withTenant(tenantId, (tx) =>
      tx.person.createMany({
        data: people.map((id, i) => ({
          id,
          tenantId,
          givenName: `Person${i}`,
          familyName: 'Okafor',
        })),
      }),
    );

    await buildSnapshot(tenantId, { now: NOW, collect: async () => emptyCollection() });
    await withTenant(tenantId, async (tx) => {
      for (const id of people) {
        await recordEvent(tx, {
          actorUserId: null,
          action: 'rbac.role.assign',
          targetType: 'User',
          targetId: null,
          outcome: 'success',
          sourceIp: null,
          payload: { personId: id, resourceId: 'g1' },
        });
      }
    });

    const later = new Date(NOW.getTime() + 3_600_000);
    const built = await buildSnapshot(tenantId, {
      now: later,
      collect: async () =>
        emptyCollection({
          asOf: later,
          personIds: people,
          personsWithActiveContract: people.length,
          holdings: people.map((id) => holdingOf(id, 'g1', later)),
        }),
    });

    const explained = await withTenant(tenantId, (tx) =>
      tx.holdingEvent.count({ where: { toSnapshotId: built.snapshotId, explained: true } }),
    );
    expect(explained).toBe(people.length);
  });
});
