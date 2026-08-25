import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { recordEvent } from '../audit/audit-service.js';
import {
  BUNDLE_LIMITATIONS,
  bundleDigest,
  createEvidencePack,
  exportReportCsv,
  fetchEvidencePack,
  toCsv,
} from './export-service.js';
import { buildHeader, envelope } from './report-service.js';
import { readableSnapshot } from './readable.js';

const NOW = new Date('2026-06-15T09:00:00Z');
let tenantId: string;
let snapshotId: string;
/**
 * A REAL user id. `AuditEvent.actorUserId` is `@db.Uuid`, so the plan's
 * `'user-1'` was a Postgres cast error on every one of these cases rather than
 * an assertion about the export (Ruling G-16).
 */
let actorUserId: string;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  const seeded = await withTenant(tenantId, async (tx) => {
    const user = await tx.user.create({
      data: {
        tenantId,
        login: 'auditor',
        email: 'auditor@example.test',
        displayName: 'Ada Auditor',
      },
    });
    const s = await tx.accessSnapshot.create({
      data: {
        tenantId,
        kind: 'manual',
        status: 'complete',
        asOf: NOW,
        holdingCount: 1,
        unattributableCount: 1,
        coverageGapCount: 2,
        unattributedAccountCount: 3,
      },
    });
    await tx.snapshotSource.create({
      data: {
        tenantId,
        snapshotId: s.id,
        sourceKind: 'targetSystem',
        sourceId: 'sys-1',
        sourceName: 'Acme AD',
        lastSuccessfulReadAt: NOW,
        completeness: 'complete',
        staleness: 'fresh',
        freshnessSlaHours: 24,
      },
    });
    await recordEvent(tx, {
      actorUserId: null,
      action: 'seed',
      targetType: 'T',
      targetId: null,
      outcome: 'success',
      sourceIp: null,
      payload: {},
    });
    return { snapshotId: s.id, actorUserId: user.id };
  });
  snapshotId = seeded.snapshotId;
  actorUserId = seeded.actorUserId;
});

describe('CSV', () => {
  it('repeats every header field on EVERY row', async () => {
    const header = await withTenant(tenantId, async (tx) =>
      buildHeader(await readableSnapshot(tx, snapshotId), 'sys-1'),
    );
    const csv = toCsv(header, [{ subject: 'Anna Novak' }, { subject: 'Bram Visser' }]);
    const lines = csv.split('\n');
    expect(lines).toHaveLength(3);
    // A header that lives only in row 1 does not survive being sorted.
    expect(lines[1]).toContain(snapshotId);
    expect(lines[2]).toContain(snapshotId);
    expect(lines[1]).toContain('2026-06-15T09:00:00.000Z');
    expect(lines[2]).toContain('2026-06-15T09:00:00.000Z');
  });

  it('emits a row saying so for an EMPTY scope rather than a zero-byte file', () => {
    const header = {
      snapshotId: 'x',
      asOf: NOW.toISOString(),
      live: false as const,
      sources: [],
      coverageGapCount: 0,
      unattributableCount: 0,
      unattributedAccountCount: 0,
      scopeDescription: 's',
    };
    const csv = toCsv(header, []);
    expect(csv.split('\n')).toHaveLength(2);
    expect(csv).toContain('no rows in this scope');
  });

  it('escapes a value containing a comma or a quote', () => {
    const header = {
      snapshotId: 'x',
      asOf: NOW.toISOString(),
      live: false as const,
      sources: [],
      coverageGapCount: 0,
      unattributableCount: 0,
      unattributedAccountCount: 0,
      scopeDescription: 's',
    };
    expect(toCsv(header, [{ subject: 'Novak, Anna "A"' }])).toContain('"Novak, Anna ""A"""');
  });

  it('REFUSES to export a live report', async () => {
    const live = envelope(
      {
        live: true as const,
        computedAt: NOW.toISOString(),
        exportable: false as const,
        caveat: 'live',
      },
      { rows: [], holderCount: { known: true, value: 0 } },
    );
    await expect(exportReportCsv(tenantId, actorUserId, live, {})).rejects.toThrow(/no as-of time/);
  });

  it('records an audit event naming the actor, the scope and the row count', async () => {
    const header = await withTenant(tenantId, async (tx) =>
      buildHeader(await readableSnapshot(tx, snapshotId), 'sys-1'),
    );
    await exportReportCsv(
      tenantId,
      actorUserId,
      envelope(header, { rows: [], holderCount: null }),
      { systemId: 'sys-1' },
    );
    const event = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findFirstOrThrow({ where: { action: 'govern.report.export' } }),
    );
    expect(event.actorUserId).toBe(actorUserId);
    expect(event.payload).toMatchObject({
      format: 'csv',
      rowCount: 0,
      scope: { systemId: 'sys-1' },
    });
  });
});

describe('the evidence bundle', () => {
  it('carries its limitations on its cover, in words', async () => {
    const { bundle } = await createEvidencePack(tenantId, actorUserId, {
      kind: 'report',
      snapshotId,
      scope: {},
    });
    expect(bundle.limitations).toEqual(BUNDLE_LIMITATIONS);
    // Case-insensitive: the sentences are copied verbatim from §17, which
    // capitalises the NOT, and the assertion is about the claim being on the
    // cover rather than about how it is typeset.
    const cover = bundle.limitations.join(' ');
    expect(cover).toMatch(/not proof against the operator/i);
    expect(cover).toMatch(/proves a click, not a judgement/i);
  });

  it('has a digest that is STABLE across two serializations of the same content', async () => {
    const first = await createEvidencePack(tenantId, actorUserId, {
      kind: 'report',
      snapshotId,
      scope: { a: 1, b: 2 },
    });
    const { digest: _d, ...withoutDigest } = first.bundle;

    // ACTUALLY reversed, at the top level and inside the header (Ruling G-20).
    // The plan wrote `{ ...withoutDigest, header: { ...withoutDigest.header } }`
    // and called it "key order reversed" — a spread preserves insertion order,
    // so nothing moved and the case passed just as happily with
    // `JSON.stringify` in `bundleDigest`. A digest test that cannot tell a
    // stable serialization from an unstable one is not testing the digest.
    const reverseKeys = <T extends object>(o: T): T =>
      Object.fromEntries(Object.entries(o).reverse()) as T;
    const reordered = reverseKeys({
      ...withoutDigest,
      header: reverseKeys(withoutDigest.header),
    });

    expect(Object.keys(reordered)).not.toEqual(Object.keys(withoutDigest));
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(withoutDigest));
    expect(bundleDigest(reordered)).toBe(first.digest);
  });

  it('carries the chain range it covers and its verification result', async () => {
    const { bundle } = await createEvidencePack(tenantId, actorUserId, {
      kind: 'report',
      snapshotId,
      scope: {},
    });
    expect(bundle.chain).toMatchObject({ fromSequence: 1, result: 'valid' });
    expect(bundle.chain.headSequence).toBeGreaterThanOrEqual(1);
  });

  it('records the pack and an audit event', async () => {
    const { id, digest } = await createEvidencePack(tenantId, actorUserId, {
      kind: 'report',
      snapshotId,
      scope: {},
    });
    const [pack, event] = await withTenant(tenantId, async (tx) => [
      await tx.evidencePack.findUniqueOrThrow({ where: { id } }),
      await tx.auditEvent.findFirstOrThrow({ where: { action: 'govern.evidence.create' } }),
    ]);
    expect(pack.digest).toBe(digest);
    expect(pack.byteLength).toBeGreaterThan(0);
    expect(event.targetId).toBe(id);
  });
});

/**
 * A campaign with something actually in it: two items (one certified, one
 * terminally undecided), one reviewer, one decision, and one revocation
 * dispatch. The bundle's whole job is to carry these, and every one of them
 * used to be dropped.
 */
async function seedDecidedCampaign(): Promise<{ campaignId: string }> {
  return withTenant(tenantId, async (tx) => {
    const owner = await tx.person.create({
      data: { tenantId, givenName: 'Ola', familyName: 'Berg' },
    });
    const reviewer = await tx.person.create({
      data: { tenantId, givenName: 'Jan', familyName: 'Kowal' },
    });
    const reviewerUser = await tx.user.create({
      data: {
        tenantId,
        login: 'jan.kowal',
        email: 'jan@example.test',
        displayName: 'Jan Kowal',
        personId: reviewer.id,
      },
    });
    const campaign = await tx.campaign.create({
      data: {
        tenantId,
        name: 'Q2 finance review',
        scope: {},
        snapshotId,
        reviewerSelector: 'manager',
        fallbackSelector: 'campaign_owner',
        ownerPersonId: owner.id,
        opensAt: NOW,
        dueAt: new Date(NOW.getTime() + 30 * 86_400_000),
        originalDueAt: new Date(NOW.getTime() + 30 * 86_400_000),
        status: 'closed_incomplete',
      },
    });

    const mk = async (resourceId: string, status: string) =>
      tx.campaignItem.create({
        data: {
          tenantId,
          campaignId: campaign.id,
          holdingSnapshotId: snapshotId,
          subjectKey: `person:${owner.id}`,
          personId: owner.id,
          systemId: 'sys-1',
          resourceKind: 'targetEntitlement',
          resourceId,
          resourceName: `Entitlement ${resourceId}`,
          observedAt: NOW,
          coverageStatus: 'complete',
          status,
        },
      });
    const certified = await mk('ent-1', 'certified');
    await mk('ent-2', 'undecided');

    await tx.campaignItemReviewer.create({
      data: {
        tenantId,
        itemId: certified.id,
        personId: reviewer.id,
        via: 'selector',
        assignedAt: NOW,
        openedAt: NOW,
      },
    });
    await tx.campaignDecision.create({
      data: {
        tenantId,
        itemId: certified.id,
        personId: reviewer.id,
        decidedByUserId: reviewerUser.id,
        decision: 'certify',
        comment: null,
        itemOpenedAt: NOW,
        neverOpened: false,
        decidedAt: NOW,
        sessionDecisionOrdinal: 1,
        coverageAtDecision: {},
      },
    });

    const batch = await tx.revocationBatch.create({
      data: { tenantId, campaignId: campaign.id, status: 'previewed' },
    });
    await tx.revocationDispatch.create({
      data: {
        tenantId,
        batchId: batch.id,
        itemId: certified.id,
        holdingDescriptor: {},
        route: 'provision',
        status: 'proposed',
        sequence: 1,
      },
    });

    return { campaignId: campaign.id };
  });
}

describe('the evidence bundle carries the campaign it names', () => {
  /**
   * THE BUNDLE WAS STRUCTURALLY EMPTY, and it verified perfectly.
   *
   * `createEvidencePack` took a `campaignId`, stored it on the row, and never
   * read it: items, decisions, reviewers, notifications and dispatches were
   * hard-coded `[]`. The digest was computed over the empty document, so it
   * checked out -- while the printed cover asserted "an item marked
   * `undecided` in this bundle was NOT attested", a statement about items the
   * bundle does not contain.
   *
   * That is §1's harm in its most direct form: a report that looks complete, is
   * not, and is signed anyway.
   */
  it('contains the campaign’s items, decisions, reviewers and dispatches', async () => {
    const seeded = await seedDecidedCampaign();

    const { bundle } = await createEvidencePack(tenantId, actorUserId, {
      kind: 'campaign',
      snapshotId,
      campaignId: seeded.campaignId,
      scope: { campaignId: seeded.campaignId },
    });

    expect(bundle.campaignId).toBe(seeded.campaignId);
    expect(bundle.items).toHaveLength(2);
    expect(bundle.decisions).toHaveLength(1);
    expect(bundle.reviewers).toHaveLength(1);
    expect(bundle.dispatches).toHaveLength(1);

    // The item the cover makes a statement about is IN it, with the status the
    // statement is about.
    expect(bundle.items.some((i) => i.status === 'undecided')).toBe(true);
    // And the decision carries the quality signals §17 puts in the bundle "for
    // exactly this reason": they are the closest thing to evidence of
    // engagement the system can honestly produce.
    expect(bundle.decisions[0]).toMatchObject({ decision: 'certify', neverOpened: false });
  });

  it('names a campaign bundle’s own campaign, and a report bundle’s absence of one', async () => {
    const { bundle } = await createEvidencePack(tenantId, actorUserId, {
      kind: 'report',
      snapshotId,
      scope: { systemId: 'sys-1' },
    });
    expect(bundle.campaignId).toBeNull();
    expect(bundle.items).toEqual([]);
    // NOT silently empty. A report bundle legitimately has no campaign, and the
    // cover has to distinguish that from a campaign bundle that lost its
    // contents -- which is the state every bundle used to be in.
    expect(bundle.limitations.join(' ')).toMatch(/no campaign/i);
  });

  /**
   * §17: the digest exists so "a reader can recompute it a year later". It
   * could not: nothing recorded where the bytes were, `storageRef` was never
   * written, and re-creating the pack produced a different document because the
   * chain head had moved.
   */
  it('can be fetched again and recomputes to the same digest', async () => {
    const seeded = await seedDecidedCampaign();
    const created = await createEvidencePack(tenantId, actorUserId, {
      kind: 'campaign',
      snapshotId,
      campaignId: seeded.campaignId,
      scope: { campaignId: seeded.campaignId },
    });

    const row = await withTenant(tenantId, (tx) =>
      tx.evidencePack.findUniqueOrThrow({ where: { id: created.id } }),
    );
    expect(row.storageRef).toBe(`/api/admin/govern/evidence/${created.id}`);

    // More audit events happen. The bundle must not change: it is built from
    // the range the PACK recorded, not from the chain as it stands today.
    await withTenant(tenantId, (tx) =>
      recordEvent(tx, {
        actorUserId,
        action: 'govern.report.export',
        targetType: 'AccessSnapshot',
        targetId: snapshotId,
        outcome: 'success',
        sourceIp: null,
        payload: {},
      }),
    );

    const fetched = await fetchEvidencePack(tenantId, created.id);
    expect(fetched.digestMatches).toBe(true);
    expect(fetched.bundle.digest).toBe(created.digest);
  });
});
