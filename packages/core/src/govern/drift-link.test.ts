import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { upsertFindings, type FindingDraft } from './finding-service.js';
import {
  DRIFT_LINKABLE,
  adoptDriftClosures,
  linkDrafts,
  reconcileLinkedFindings,
  type DriftRow,
} from './drift-link.js';

const NOW = new Date('2026-06-15T09:00:00Z');

const orphanDraft = (over: Partial<FindingDraft> = {}): FindingDraft => ({
  kind: 'orphan_account',
  severity: 'medium',
  subjectRefType: 'account',
  subjectRefId: 'sys-1:ANCHOR-7',
  detail: { systemId: 'sys-1', accountRef: 'ANCHOR-7' },
  ...over,
});

const drift = (over: Partial<DriftRow> = {}): DriftRow => ({
  id: 'd-1',
  kind: 'orphan_account',
  targetSystemId: 'sys-1',
  accountId: null,
  entitlementId: null,
  subjectAnchor: 'anchor-7',
  status: 'open',
  ...over,
});

describe('linkDrafts — the natural key', () => {
  it('stamps driftFindingId on an orphan_account draft, folding case', () => {
    // AD folds case and PostgreSQL does not. Three defects on Provision came
    // from that, and an account anchor is exactly an identifier that crosses
    // the line between the two.
    const [linked] = linkDrafts([orphanDraft()], [drift()], new Map());
    expect(linked!.driftFindingId).toBe('d-1');
  });

  it('leaves driftFindingId null when no drift row matches', () => {
    const [linked] = linkDrafts([orphanDraft()], [drift({ targetSystemId: 'sys-2' })], new Map());
    expect(linked!.driftFindingId ?? null).toBeNull();
  });

  it('links an unattributable targetEntitlement holding to unmanaged_entitlement', () => {
    const draft: FindingDraft = {
      kind: 'unattributable_holding',
      severity: 'high',
      subjectRefType: 'holding',
      subjectRefId: 'person:p-1|sys-1|targetEntitlement|ent-1',
      detail: { systemId: 'sys-1', accountRef: 'anchor-7', resourceKind: 'targetEntitlement', resourceId: 'ent-1' },
    };
    const [linked] = linkDrafts(
      [draft],
      [drift({ id: 'd-9', kind: 'unmanaged_entitlement', accountId: 'acc-1', entitlementId: 'ent-1', subjectAnchor: null })],
      new Map([['sys-1|anchor-7', 'acc-1']]),
    );
    expect(linked!.driftFindingId).toBe('d-9');
  });

  it('does NOT link an unattributable holding that is not a targetEntitlement', () => {
    // A syntraGroup nobody can explain is Govern's alone; Provision has no row
    // for it, and matching it to one would attach the wrong problem.
    const draft: FindingDraft = {
      kind: 'unattributable_holding',
      severity: 'high',
      subjectRefType: 'holding',
      subjectRefId: 'person:p-1|syntra|syntraGroup|g-1',
      detail: { systemId: 'syntra', accountRef: null, resourceKind: 'syntraGroup', resourceId: 'g-1' },
    };
    const [linked] = linkDrafts([draft], [drift({ kind: 'unmanaged_entitlement', entitlementId: 'g-1' })], new Map());
    expect(linked!.driftFindingId ?? null).toBeNull();
  });

  it('ignores a drift row Provision has already resolved', () => {
    const [linked] = linkDrafts([orphanDraft()], [drift({ status: 'resolved' })], new Map());
    expect(linked!.driftFindingId ?? null).toBeNull();
  });

  it('links exactly two kinds and no others', () => {
    // The map is the whole policy. A third entry must be a deliberate edit.
    expect(Object.keys(DRIFT_LINKABLE).sort()).toEqual(['orphan_account', 'unattributable_holding']);
  });
});

describe('one problem, one row, in both dashboards', () => {
  let tenantId: string;
  let snapshotId: string;
  let targetSystemId: string;
  let driftId: string;

  beforeEach(async () => {
    await resetDatabase();
    const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
    tenantId = t.id;
    const seeded = await withTenant(tenantId, async (tx) => {
      const target = await tx.targetSystem.create({
        // `TargetSystem` has `type`, not `kind`, and it defaults to
        // 'activeDirectory' -- so the plan's `kind: 'ldap'` is a column that
        // does not exist.
        // `config: {}` violates Provision's `target_system_encrypted_transport`
        // check: a target has to declare an encrypted transport, and refusing
        // a plaintext bind is the point of that constraint.
        data: {
          tenantId,
          name: 'Acme AD',
          secretName: 'acme-ad',
          config: { tlsMode: 'ldaps' } as never,
        },
      });
      const snapshot = await tx.accessSnapshot.create({
        data: { tenantId, kind: 'manual', status: 'complete', asOf: NOW },
      });
      const finding = await tx.driftFinding.create({
        data: {
          tenantId, targetSystemId: target.id, kind: 'orphan_account',
          subjectAnchor: 'anchor-7', detail: {} as never, status: 'open',
          fingerprint: 'orphan_account:-:-:anchor-7',
        },
      });
      return { snapshotId: snapshot.id, targetSystemId: target.id, driftId: finding.id };
    });
    snapshotId = seeded.snapshotId;
    targetSystemId = seeded.targetSystemId;
    driftId = seeded.driftId;
  });

  const draftForTarget = () =>
    orphanDraft({
      subjectRefId: `${targetSystemId}:anchor-7`,
      detail: { systemId: targetSystemId, accountRef: 'anchor-7' },
    });

  it('raises ONE Govern row carrying the drift id rather than a second independent row', async () => {
    const result = await reconcileLinkedFindings(
      tenantId, snapshotId, ['orphan_account'], [draftForTarget()], { now: NOW },
    );
    expect(result).toMatchObject({ opened: 1, linked: 1 });

    const govern = await withTenant(tenantId, (tx) => tx.governFinding.findMany());
    const provision = await withTenant(tenantId, (tx) => tx.driftFinding.findMany());
    expect(govern).toHaveLength(1);
    expect(provision).toHaveLength(1);
    expect(govern[0]!.driftFindingId).toBe(driftId);
    // Still OPEN in both. One problem, one row each, neither closed by the act
    // of linking them.
    expect(govern[0]!.status).toBe('open');
    expect(provision[0]!.status).toBe('open');
  });

  it('closing it on the GOVERN side closes the Provision row', async () => {
    await reconcileLinkedFindings(tenantId, snapshotId, ['orphan_account'], [draftForTarget()], { now: NOW });
    // Next snapshot: the account was claimed, so the draft is gone.
    const second = await reconcileLinkedFindings(tenantId, snapshotId, ['orphan_account'], [], { now: NOW });
    expect(second).toMatchObject({ resolved: 1, driftClosed: 1 });

    const provision = await withTenant(tenantId, (tx) => tx.driftFinding.findFirstOrThrow());
    expect(provision.status).toBe('resolved');
  });

  it('closing it on the PROVISION side resolves the Govern row and says why', async () => {
    await reconcileLinkedFindings(tenantId, snapshotId, ['orphan_account'], [draftForTarget()], { now: NOW });
    await withTenant(tenantId, (tx) =>
      tx.driftFinding.update({ where: { id: driftId }, data: { status: 'resolved' } }),
    );

    const result = await adoptDriftClosures(tenantId, snapshotId, { now: NOW });
    expect(result.adopted).toBe(1);

    const govern = await withTenant(tenantId, (tx) => tx.governFinding.findFirstOrThrow());
    expect(govern.status).toBe('resolved');
    expect(govern.resolvedBySnapshotId).toBe(snapshotId);
    expect((govern.detail as Record<string, unknown>)['resolvedBecause']).toMatch(/Provision/i);
  });

  it('does NOT close a Provision row behind a Govern finding somebody ACCEPTED', async () => {
    // Acceptance is not resolution. Closing Provision's row on an acceptance
    // would tell the other dashboard the problem went away when a human
    // deliberately said it was tolerated and put an expiry on saying so.
    await upsertFindings(tenantId, [draftForTarget()], { now: NOW });
    await withTenant(tenantId, (tx) =>
      // `acceptedUntil` and `acceptedReason` are not decoration: the
      // `govern_finding_accepted_needs_expiry` check refuses an acceptance
      // without them, which is the database saying what this very case says in
      // prose -- a human deliberately tolerated this, and put an expiry on
      // saying so. The plan's fixture set the status alone.
      tx.governFinding.updateMany({
        where: {},
        data: {
          status: 'accepted',
          acceptedReason: 'tolerated until the migration lands',
          acceptedUntil: new Date('2026-12-31T00:00:00Z'),
          driftFindingId: driftId,
        },
      }),
    );
    const result = await reconcileLinkedFindings(tenantId, snapshotId, ['orphan_account'], [], { now: NOW });
    expect(result.driftClosed).toBe(0);
    expect((await withTenant(tenantId, (tx) => tx.driftFinding.findFirstOrThrow())).status).toBe('open');
  });
});
