import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from './index.js';
import { asDatabaseSuperuser, resetDatabase } from './test-support.js';

let tenantId: string;
let otherTenantId: string;

const NOW = new Date('2026-06-15T09:00:00Z');

beforeEach(async () => {
  await resetDatabase();
  const a = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  const b = await prisma.tenant.create({ data: { name: 'Beta', slug: 'beta' } });
  tenantId = a.id;
  otherTenantId = b.id;
});

/** A `complete` snapshot with one holding, which most cases need. */
async function seedSnapshot(tid: string, over: Record<string, unknown> = {}) {
  return withTenant(tid, async (tx) => {
    const snapshot = await tx.accessSnapshot.create({
      data: { tenantId: tid, kind: 'manual', status: 'complete', asOf: NOW, ...over },
    });
    return snapshot.id;
  });
}

describe('GovernSettings', () => {
  it('holds every default the design names, and one row per tenant', async () => {
    const settings = await withTenant(tenantId, (tx) =>
      tx.governSettings.create({ data: { tenantId } }),
    );

    expect(settings.snapshotSchedule).toBe('0 1 * * *');
    expect(settings.snapshotRetentionDays).toBe(400);
    expect(settings.defaultFreshnessSlaHours).toBe(24);
    expect(settings.maxSnapshotAgeDays).toBe(30);
    expect(settings.batchThresholdPercent).toBe(10);
    expect(settings.perResourceThresholdPercent).toBe(30);
    expect(settings.personPopulationDropPercent).toBe(20);
    expect(settings.minimumCoveragePercent).toBe(90);
    expect(settings.bulkCertifyLimit).toBe(50);
    expect(settings.dispatchSlaHours).toBe(72);
    expect(settings.privilegedRecertifyDays).toBe(90);
    expect(settings.maxExceptionDays).toBe(90);
    expect(settings.exceptionWarningDays).toEqual([14, 3]);
    expect(settings.minReciprocalDecisions).toBe(3);
    expect(settings.reciprocityWindowDays).toBe(180);
    expect(settings.lastAppliedBatchAt).toBeNull();
    expect(settings.personsWithActiveContractAtLastBatch).toBeNull();

    await expect(
      withTenant(tenantId, (tx) => tx.governSettings.create({ data: { tenantId } })),
    ).rejects.toThrow(/Unique constraint/i);
  });

  // Prisma fills client-side defaults from its inlined datamodel, so the
  // assertions above would pass with no DEFAULT clause in the database at all.
  // This one reads the DDL, which is the only thing that proves the column
  // has a default a raw INSERT would get.
  it('carries its defaults in the database, not only in the client', async () => {
    const rows = await prisma.$queryRaw<{ column_name: string; column_default: string | null }[]>`
      SELECT column_name, column_default
      FROM information_schema.columns
      WHERE table_name = 'GovernSettings'
        AND column_name IN ('maxSnapshotAgeDays', 'bulkCertifyLimit', 'exceptionWarningDays')
    `;
    const byName = new Map(rows.map((r) => [r.column_name, r.column_default]));
    expect(byName.get('maxSnapshotAgeDays')).toMatch(/^30\b/);
    expect(byName.get('bulkCertifyLimit')).toMatch(/^50\b/);
    expect(byName.get('exceptionWarningDays')).toMatch(/14/);
  });

  it('refuses a percentage outside 0..100', async () => {
    await expect(
      withTenant(tenantId, (tx) =>
        tx.governSettings.create({ data: { tenantId, batchThresholdPercent: 101 } }),
      ),
    ).rejects.toThrow(/govern_settings_thresholds_are_percent/);
  });
});

describe('AccessSnapshot', () => {
  it('permits at most one building snapshot per tenant', async () => {
    await withTenant(tenantId, (tx) =>
      tx.accessSnapshot.create({
        data: { tenantId, kind: 'scheduled', status: 'building', asOf: NOW },
      }),
    );

    await expect(
      withTenant(tenantId, (tx) =>
        tx.accessSnapshot.create({
          data: { tenantId, kind: 'manual', status: 'building', asOf: NOW },
        }),
      ),
      // Thrown, not named. Prisma reports `Unique constraint failed on the
      // (not available)` for a HAND-WRITTEN partial index, because
      // `schema.prisma` cannot express one and the client therefore has no
      // name to report. Matching the index name is an assertion that cannot
      // pass against a correct database, so the refusal is asserted and then
      // the state is checked -- which is what the constraint actually means.
    ).rejects.toThrow();

    const building = await withTenant(tenantId, (tx) =>
      tx.accessSnapshot.findMany({ where: { status: 'building' } }),
    );
    expect(building).toHaveLength(1);
    expect(building[0]?.kind).toBe('scheduled');
  });

  it('permits many complete snapshots, and a second tenant building at the same time', async () => {
    await seedSnapshot(tenantId);
    await seedSnapshot(tenantId);
    await withTenant(tenantId, (tx) =>
      tx.accessSnapshot.create({
        data: { tenantId, kind: 'scheduled', status: 'building', asOf: NOW },
      }),
    );
    await withTenant(otherTenantId, (tx) =>
      tx.accessSnapshot.create({
        data: { tenantId: otherTenantId, kind: 'scheduled', status: 'building', asOf: NOW },
      }),
    );

    const mine = await withTenant(tenantId, (tx) => tx.accessSnapshot.count());
    expect(mine).toBe(3);
  });
});

describe('Holding', () => {
  it('is unique per (snapshot, subject, system, resourceKind, resource)', async () => {
    const snapshotId = await seedSnapshot(tenantId);
    const person = await withTenant(tenantId, (tx) =>
      tx.person.create({ data: { tenantId, givenName: 'Anna', familyName: 'Novak' } }),
    );

    const row = {
      tenantId,
      snapshotId,
      subjectKey: `person:${person.id}`,
      personId: person.id,
      systemKind: 'syntraInternal',
      systemId: 'syntra',
      resourceKind: 'syntraGroup',
      resourceId: 'group-1',
      resourceName: 'Finance',
      state: 'held',
      observedAt: NOW,
      observedVia: 'syntra',
      firstSeenAt: NOW,
    };

    await withTenant(tenantId, (tx) => tx.holding.create({ data: row }));
    await expect(
      withTenant(tenantId, (tx) => tx.holding.create({ data: row })),
    ).rejects.toThrow(/Unique constraint/i);
  });

  it('accepts a subject that is an unattributed account, with a null personId', async () => {
    const snapshotId = await seedSnapshot(tenantId);
    const holding = await withTenant(tenantId, (tx) =>
      tx.holding.create({
        data: {
          tenantId,
          snapshotId,
          subjectKey: 'account:11111111-1111-1111-1111-111111111111:anchor-7',
          accountRef: 'anchor-7',
          systemKind: 'targetSystem',
          systemId: '11111111-1111-1111-1111-111111111111',
          resourceKind: 'targetAccount',
          resourceId: 'anchor-7',
          resourceName: 'svc-backup',
          state: 'held',
          observedAt: NOW,
          observedVia: 'provision-run-3',
          firstSeenAt: NOW,
          unattributable: true,
        },
      }),
    );
    expect(holding.personId).toBeNull();
    expect(holding.unattributable).toBe(true);
  });

  it('refuses a state outside the two-valued set', async () => {
    const snapshotId = await seedSnapshot(tenantId);
    await expect(
      withTenant(tenantId, (tx) =>
        tx.holding.create({
          data: {
            tenantId,
            snapshotId,
            subjectKey: 'account:syntra:x',
            systemKind: 'syntraInternal',
            systemId: 'syntra',
            resourceKind: 'syntraGroup',
            resourceId: 'g',
            resourceName: 'g',
            // `not_held` is never a row. Spec section 6.
            state: 'not_held',
            observedAt: NOW,
            observedVia: 'syntra',
            firstSeenAt: NOW,
          },
        }),
      ),
    ).rejects.toThrow(/holding_state_is_held_or_unknown/);
  });

  it('carries the three indexes the reports actually read by', async () => {
    const rows = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE tablename = 'Holding'
    `;
    const names = rows.map((r) => r.indexname);
    expect(names).toContain('Holding_tenantId_snapshotId_personId_idx');
    expect(names).toContain('Holding_tenantId_snapshotId_systemId_resourceId_idx');
    expect(names).toContain('holding_unattributable_idx');
  });
});

describe('CoverageGap', () => {
  it('is a row with a subject, a scope and a reason — never a flag', async () => {
    const snapshotId = await seedSnapshot(tenantId);
    const gap = await withTenant(tenantId, (tx) =>
      tx.coverageGap.create({
        data: {
          tenantId,
          snapshotId,
          kind: 'resource_unreadable',
          systemKind: 'targetSystem',
          systemId: '11111111-1111-1111-1111-111111111111',
          resourceId: 'ent-domain-admins',
          reason:
            'the connector could not read this group completely; the run named is ' +
            'the target last run, not necessarily the run that failed the read',
          sourceRunId: '22222222-2222-2222-2222-222222222222',
        },
      }),
    );
    expect(gap.personId).toBeNull();
    expect(gap.reason).toContain('not necessarily the run that failed the read');
  });

  it('refuses a kind outside the closed set', async () => {
    const snapshotId = await seedSnapshot(tenantId);
    await expect(
      withTenant(tenantId, (tx) =>
        tx.coverageGap.create({
          data: { tenantId, snapshotId, kind: 'probably_fine', reason: 'x' },
        }),
      ),
    ).rejects.toThrow(/coverage_gap_kind/);
  });
});

describe('GovernFinding', () => {
  it('is unique per (kind, subjectRefType, subjectRefId), so it updates rather than duplicates', async () => {
    const row = {
      tenantId,
      kind: 'unattributable_holding',
      severity: 'high',
      subjectRefType: 'holding',
      subjectRefId: 'syntra:syntraGroup:group-1:person:abc',
      detail: {},
      firstSeenAt: NOW,
      lastSeenAt: NOW,
    };
    await withTenant(tenantId, (tx) => tx.governFinding.create({ data: row }));
    await expect(
      withTenant(tenantId, (tx) => tx.governFinding.create({ data: row })),
    ).rejects.toThrow(/Unique constraint/i);
  });

  it('refuses `accepted` with no expiry', async () => {
    await expect(
      withTenant(tenantId, (tx) =>
        tx.governFinding.create({
          data: {
            tenantId,
            kind: 'stale_source',
            severity: 'medium',
            subjectRefType: 'source',
            subjectRefId: 'src-1',
            detail: {},
            status: 'accepted',
            acceptedReason: 'known and tolerated',
            firstSeenAt: NOW,
            lastSeenAt: NOW,
          },
        }),
      ),
    ).rejects.toThrow(/govern_finding_accepted_needs_expiry/);
  });
});

describe('RemediationItem', () => {
  it('permits one open item per finding and admits a second once the first is done', async () => {
    const finding = await withTenant(tenantId, (tx) =>
      tx.governFinding.create({
        data: {
          tenantId,
          kind: 'orphan_account',
          severity: 'medium',
          subjectRefType: 'account',
          subjectRefId: 'sys:anchor-7',
          detail: {},
          firstSeenAt: NOW,
          lastSeenAt: NOW,
        },
      }),
    );
    const person = await withTenant(tenantId, (tx) =>
      tx.person.create({ data: { tenantId, givenName: 'Jan', familyName: 'Owner' } }),
    );
    const item = {
      tenantId,
      kind: 'orphan_attribution',
      ownerPersonId: person.id,
      dueAt: NOW,
      findingId: finding.id,
      description: 'confirm or deny the proposed owner of svc-backup',
      deepLink: '/admin/govern/orphans',
    };

    const first = await withTenant(tenantId, (tx) => tx.remediationItem.create({ data: item }));
    await expect(
      withTenant(tenantId, (tx) => tx.remediationItem.create({ data: item })),
      // See the note on the snapshot case above: a partial index has no name
      // Prisma can report, so the refusal is what is asserted.
    ).rejects.toThrow();
    expect(
      await withTenant(tenantId, (tx) =>
        tx.remediationItem.count({ where: { status: 'open' } }),
      ),
    ).toBe(1);

    await withTenant(tenantId, (tx) =>
      tx.remediationItem.update({ where: { id: first.id }, data: { status: 'done' } }),
    );
    await withTenant(tenantId, (tx) => tx.remediationItem.create({ data: item }));
  });
});

describe('AccountAttribution', () => {
  it('permits several proposals and only one confirmation per account', async () => {
    const [a, b] = await withTenant(tenantId, async (tx) => [
      await tx.person.create({ data: { tenantId, givenName: 'Anna', familyName: 'Novak' } }),
      await tx.person.create({ data: { tenantId, givenName: 'Anke', familyName: 'Novak' } }),
    ]);
    const base = { tenantId, systemId: 'sys-1', accountRef: 'anchor-7', method: 'mail', confidence: 0.8 };

    await withTenant(tenantId, (tx) =>
      tx.accountAttribution.create({ data: { ...base, proposedPersonId: a!.id } }),
    );
    await withTenant(tenantId, (tx) =>
      tx.accountAttribution.create({ data: { ...base, proposedPersonId: b!.id } }),
    );

    await withTenant(tenantId, (tx) =>
      tx.accountAttribution.updateMany({
        where: { proposedPersonId: a!.id },
        data: { status: 'confirmed', decidedAt: NOW },
      }),
    );
    await expect(
      withTenant(tenantId, (tx) =>
        tx.accountAttribution.updateMany({
          where: { proposedPersonId: b!.id },
          data: { status: 'confirmed', decidedAt: NOW },
        }),
      ),
      // See the note on the snapshot case above.
    ).rejects.toThrow();
    expect(
      await withTenant(tenantId, (tx) =>
        tx.accountAttribution.count({ where: { status: 'confirmed' } }),
      ),
    ).toBe(1);
  });
});

describe('AuditCheckpoint', () => {
  it('is append-only: an UPDATE changes nothing and a DELETE removes nothing', async () => {
    await withTenant(tenantId, (tx) =>
      tx.auditCheckpoint.create({
        data: { tenantId, sequence: 100, hash: 'a'.repeat(64), verifiedAt: NOW },
      }),
    );

    await withTenant(tenantId, (tx) =>
      tx.auditCheckpoint.updateMany({ where: { sequence: 100 }, data: { hash: 'b'.repeat(64) } }),
    );
    await withTenant(tenantId, (tx) =>
      tx.auditCheckpoint.deleteMany({ where: { sequence: 100 } }),
    );

    const rows = await withTenant(tenantId, (tx) => tx.auditCheckpoint.findMany());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.hash).toBe('a'.repeat(64));
  });
});

describe('tenant isolation', () => {
  it('hides every Govern table from another tenant, even when the query names no tenant', async () => {
    const snapshotId = await seedSnapshot(tenantId);
    await withTenant(tenantId, (tx) =>
      tx.coverageGap.create({
        data: { tenantId, snapshotId, kind: 'source_unread', reason: 'never read' },
      }),
    );
    await withTenant(tenantId, (tx) =>
      tx.governFinding.create({
        data: {
          tenantId,
          kind: 'coverage_gap',
          severity: 'high',
          subjectRefType: 'snapshot',
          subjectRefId: snapshotId,
          detail: {},
          firstSeenAt: NOW,
          lastSeenAt: NOW,
        },
      }),
    );

    const seen = await withTenant(otherTenantId, async (tx) => ({
      snapshots: await tx.accessSnapshot.count(),
      gaps: await tx.coverageGap.count(),
      findings: await tx.governFinding.count(),
    }));
    expect(seen).toEqual({ snapshots: 0, gaps: 0, findings: 0 });
  });

  it('refuses a write that names another tenant, through WITH CHECK', async () => {
    await expect(
      withTenant(tenantId, (tx) =>
        tx.governSettings.create({ data: { tenantId: otherTenantId } }),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('forces the policy on the owning role', async () => {
    const rows = await prisma.$queryRaw<{ relname: string; relforcerowsecurity: boolean }[]>`
      SELECT c.relname, c.relforcerowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname IN ('Holding','CoverageGap','GovernFinding','AuditCheckpoint','EvidencePack')
    `;
    expect(rows).toHaveLength(5);
    for (const row of rows) expect(row.relforcerowsecurity).toBe(true);
  });
});
