import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import {
  CampaignRefusedError,
  campaignScopeSchema,
  coverageOf,
  createCampaign,
  extendCampaign,
  previewCampaignScope,
  rebaseCampaign,
  startCampaign,
} from './campaign-service.js';
// Task 19, dispatched before this one. Step 9a's composition test calls the
// function that writes the projection in PRODUCTION, never a hand-built row.
import { recordCampaignDecision } from './decision-service.js';
import { buildSnapshot } from './snapshot-service.js';
import type { CollectedTenant } from './collect.js';

const NOW = new Date('2026-06-15T09:00:00Z');
const DUE = new Date('2026-07-15T09:00:00Z');

let tenantId: string;
let ownerPersonId: string;
let managerPersonId: string;
let managerUserId: string;
let subjectPersonId: string;
/** A REAL user id: `AuditEvent.actorUserId` is `@db.Uuid`, so 'user-1' is a cast error. */
let actorUserId: string;

async function seedTenant(sourceFresh: boolean) {
  return withTenant(tenantId, async (tx) => {
    const manager = await tx.person.create({
      data: { tenantId, givenName: 'Jan', familyName: 'Manager' },
    });
    const owner = await tx.person.create({
      data: { tenantId, givenName: 'Ola', familyName: 'Owner' },
    });
    const subject = await tx.person.create({
      data: { tenantId, givenName: 'Anna', familyName: 'Novak' },
    });
    const users: Record<string, string> = {};
    for (const p of [manager, owner, subject]) {
      await tx.contract.create({
        data: {
          tenantId,
          personId: p.id,
          sequence: 1,
          isPrimary: true,
          startDate: new Date('2020-01-01'),
          ...(p.id === subject.id ? { managerPersonId: manager.id } : {}),
        },
      });
      const u = await tx.user.create({
        data: {
          tenantId,
          login: p.givenName.toLowerCase(),
          email: `${p.givenName.toLowerCase()}@a.test`,
          displayName: `${p.givenName} ${p.familyName}`,
          personId: p.id,
        },
      });
      users[p.id] = u.id;
    }
    const target = await tx.targetSystem.create({
      data: {
        tenantId,
        name: 'Acme AD',
        secretName: 's',
        config: { tlsMode: 'ldaps' },
        lastRunAt: sourceFresh ? NOW : new Date('2026-05-01T00:00:00Z'),
        lastAppliedRunAt: sourceFresh ? NOW : new Date('2026-05-01T00:00:00Z'),
      },
    });
    const entitlement = await tx.entitlement.create({
      data: {
        tenantId,
        targetSystemId: target.id,
        externalId: 'g1',
        type: 'group',
        displayName: 'Finance-Payments',
      },
    });
    const account = await tx.targetAccount.create({
      data: {
        tenantId,
        targetSystemId: target.id,
        personId: subject.id,
        anchor: 'a1',
        correlationKey: 'anna.novak',
        status: 'active',
        lastReconciledAt: NOW,
      },
    });
    await tx.accountEntitlement.create({
      data: { tenantId, accountId: account.id, entitlementId: entitlement.id, origin: 'discovered' },
    });
    return {
      managerId: manager.id,
      managerUserId: users[manager.id]!,
      ownerId: owner.id,
      ownerUserId: users[owner.id]!,
      subjectId: subject.id,
      targetId: target.id,
    };
  });
}

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  const seeded = await seedTenant(true);
  managerPersonId = seeded.managerId;
  managerUserId = seeded.managerUserId;
  ownerPersonId = seeded.ownerId;
  subjectPersonId = seeded.subjectId;
  actorUserId = seeded.ownerUserId;
});

const draft = (over: Record<string, unknown> = {}) => ({
  name: 'Q2 finance review',
  description: null,
  scope: { resourceKinds: ['targetEntitlement'] as ('targetEntitlement' | 'syntraRole')[] },
  reviewerSelector: 'manager',
  reviewerConfig: {},
  fallbackSelector: 'person',
  fallbackConfig: { personId: ownerPersonId },
  ownerPersonId,
  opensAt: NOW,
  dueAt: DUE,
  allowBulkCertify: true,
  ...over,
});

/**
 * A collection with no holdings, for the cases that need the world to have
 * MOVED ON rather than merely to have been re-read. `buildSnapshot`'s default
 * `collect` reads the seeded tenant, so a second build produces the same
 * holdings and nothing re-opens.
 */
const emptyCollectionAt = (asOf: Date): CollectedTenant => ({
  asOf,
  holdings: [],
  gaps: [],
  sources: [
    {
      sourceKind: 'syntraInternal',
      sourceId: 'syntra',
      sourceName: 'Syntra',
      lastRunId: null,
      lastSuccessfulReadAt: asOf,
      lastAttemptedReadAt: asOf,
      completeness: 'complete',
      freshnessSlaHours: 24,
      gapCount: 0,
    },
  ],
  personIds: [],
  personsWithActiveContract: 0,
  unattributedAccountKeys: [],
  queryCount: 9,
});

describe('the scope language', () => {
  it('refuses a scope with NO resource kinds', () => {
    // The empty case, in the dangerous direction. "Review the finance system"
    // with a blank kind list must mean nothing, not everything.
    expect(() => campaignScopeSchema.parse({ resourceKinds: [] })).toThrow();
  });

  it('refuses a subject condition with a blank value', () => {
    expect(() =>
      campaignScopeSchema.parse({
        resourceKinds: ['syntraGroup'],
        subjectCondition: { field: 'contract.department', op: 'contains', value: '' },
      }),
    ).toThrow();
  });

  it('accepts a scope naming one kind and nothing else', () => {
    expect(campaignScopeSchema.parse({ resourceKinds: ['syntraRole'] })).toMatchObject({
      resourceKinds: ['syntraRole'],
    });
  });
});

describe('previewCampaignScope', () => {
  it('says how many holdings, persons and systems it covers, before anybody is emailed', async () => {
    await buildSnapshot(tenantId, { now: NOW });
    const preview = await previewCampaignScope(tenantId, { resourceKinds: ['targetEntitlement'] });
    expect(preview.holdings).toBe(1);
    expect(preview.persons).toBe(1);
    expect(preview.systems).toBe(1);
    expect(preview.sample[0]!.resourceName).toBe('Finance-Payments');
  });

  it('covers nothing for a kind nobody holds', async () => {
    await buildSnapshot(tenantId, { now: NOW });
    expect(
      (await previewCampaignScope(tenantId, { resourceKinds: ['syntraRole'] })).holdings,
    ).toBe(0);
  });
});

describe('the stale refusal', () => {
  it('REFUSES to start when a source the scope depends on is stale, naming the source and the clock', async () => {
    await resetDatabase();
    const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
    tenantId = t.id;
    const seeded = await seedTenant(false);
    ownerPersonId = seeded.ownerId;
    actorUserId = seeded.ownerUserId;
    await buildSnapshot(tenantId, { now: NOW });

    const { id } = await createCampaign(tenantId, actorUserId, draft());
    const failure = await startCampaign(tenantId, actorUserId, id, { now: NOW }).catch((e) => e);
    expect(failure).toBeInstanceOf(CampaignRefusedError);
    expect(failure.code).toBe('stale_source');
    expect(failure.clock).toBe('source');
    expect(failure.message).toContain('Acme AD');
    expect(failure.message).toContain('hours ago');
  });

  it('refuses only for sources the scope ACTUALLY depends on', async () => {
    // Not every source in the tenant: the sources contributing holdings the
    // campaign's items would be drawn from. A campaign over Syntra roles must
    // not be blocked by a target nobody has read.
    await resetDatabase();
    const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
    tenantId = t.id;
    const seeded = await seedTenant(false);
    ownerPersonId = seeded.ownerId;
    actorUserId = seeded.ownerUserId;
    await withTenant(tenantId, async (tx) => {
      const role = await tx.role.create({
        data: { tenantId, name: 'Auditor', permissions: ['audit.read'] },
      });
      const user = await tx.user.findFirstOrThrow({ where: { personId: seeded.subjectId } });
      await tx.roleAssignment.create({ data: { tenantId, roleId: role.id, userId: user.id } });
    });
    await buildSnapshot(tenantId, { now: NOW });

    const { id } = await createCampaign(
      tenantId,
      actorUserId,
      draft({ scope: { resourceKinds: ['syntraRole'] } }),
    );
    const result = await startCampaign(tenantId, actorUserId, id, { now: NOW });
    expect(result.status).toBe('open');
  });

  it('refuses to start a campaign whose snapshot is already past maxSnapshotAgeDays', async () => {
    await buildSnapshot(tenantId, { now: NOW });
    const { id } = await createCampaign(tenantId, actorUserId, draft());
    const muchLater = new Date(NOW.getTime() + 60 * 86_400_000);
    const failure = await startCampaign(tenantId, actorUserId, id, { now: muchLater }).catch(
      (e) => e,
    );
    expect(failure.code).toBe('stale_snapshot');
    expect(failure.clock).toBe('snapshot');
  });
});

describe('generation', () => {
  it('generates ONE item per (subject, resource), copies the provenance, and opens', async () => {
    await buildSnapshot(tenantId, { now: NOW });
    const { id } = await createCampaign(tenantId, actorUserId, draft());
    const result = await startCampaign(tenantId, actorUserId, id, { now: NOW });

    expect(result.itemCount).toBe(1);
    const [campaign, items] = await withTenant(tenantId, async (tx) => [
      await tx.campaign.findUniqueOrThrow({ where: { id } }),
      await tx.campaignItem.findMany({ where: { campaignId: id } }),
    ]);
    expect(campaign.status).toBe('open');
    expect(campaign.totalItems).toBe(1);
    expect(items[0]).toMatchObject({
      subjectKey: `person:${subjectPersonId}`,
      resourceName: 'Finance-Payments',
      status: 'pending',
    });
    // Copied, not referenced by id: editing the world afterwards must not
    // change what somebody attested to.
    expect(items[0]!.attributions).toEqual([expect.objectContaining({ kind: 'discovered' })]);
    expect(items[0]!.riskFlags).toContain('unattributable');
  });

  it('writes needs_review and sod_violation into riskFlags — the two bulk-certify carve-outs', async () => {
    // §12: "That flag exists precisely so a campaign can consume it, and it is
    // exactly the item a bulk certify must not sweep up." Both flags living in
    // `HIGH_RISK_FLAGS` and in test fixtures and in nothing production runs
    // would mean bulk certify swept up both.
    await buildSnapshot(tenantId, { now: NOW });
    await withTenant(tenantId, async (tx) => {
      const entitlement = await tx.entitlement.findFirstOrThrow();
      await tx.accessGrant.create({
        data: {
          tenantId,
          subjectPersonId,
          resourceType: 'entitlement',
          resourceId: entitlement.id,
          // `access_grant_target_matches_type`: an entitlement grant carries
          // the target it lives at, and nothing else does.
          targetSystemId: entitlement.targetSystemId,
          status: 'active',
          origin: 'request',
          startsAt: NOW,
          needsReview: true,
        },
      });
    });
    const { id } = await createCampaign(tenantId, actorUserId, draft());
    await startCampaign(tenantId, actorUserId, id, { now: NOW });

    const items = await withTenant(tenantId, (tx) =>
      tx.campaignItem.findMany({ where: { campaignId: id } }),
    );
    expect(items.filter((i) => i.riskFlags.includes('needs_review'))).toHaveLength(1);

    // And it is not a blanket flag. The negative half, which is what stops the
    // fixture passing against a `riskFlags: ['needs_review']` constant.
    await withTenant(tenantId, (tx) =>
      tx.accessGrant.updateMany({ where: {}, data: { needsReview: false } }),
    );
    const { id: second } = await createCampaign(
      tenantId,
      actorUserId,
      draft({ name: 'Q3 finance review' }),
    );
    await startCampaign(tenantId, actorUserId, second, { now: NOW });
    const later = await withTenant(tenantId, (tx) =>
      tx.campaignItem.findMany({ where: { campaignId: second } }),
    );
    expect(later.every((i) => !i.riskFlags.includes('needs_review'))).toBe(true);
  });

  it('flags an item on either side of an OPEN SodViolation', async () => {
    await buildSnapshot(tenantId, { now: NOW });
    await withTenant(tenantId, async (tx) => {
      const snapshot = await tx.accessSnapshot.findFirstOrThrow();
      const holding = await tx.holding.findFirstOrThrow({
        where: { resourceKind: 'targetEntitlement' },
      });
      const fnA = await tx.businessFunction.create({ data: { tenantId, name: 'AP entry', ownerPersonId: subjectPersonId } });
      const fnB = await tx.businessFunction.create({ data: { tenantId, name: 'AP approve', ownerPersonId: subjectPersonId } });
      const rule = await tx.sodRule.create({
        data: {
          tenantId,
          name: 'AP entry vs approve',
          functionAId: fnA.id,
          functionBId: fnB.id,
          severity: 'critical',
          rationale: 'one person must not both raise and pay an invoice',
        },
      });
      await tx.sodViolation.create({
        data: {
          tenantId,
          ruleId: rule.id,
          personId: subjectPersonId,
          severity: 'critical',
          status: 'open',
          holdingsA: [
            {
              systemId: holding.systemId,
              resourceKind: holding.resourceKind,
              resourceId: holding.resourceId,
              resourceName: holding.resourceName,
              contractIds: [],
            },
          ] as never,
          holdingsB: [] as never,
          contractsA: [] as never,
          contractsB: [] as never,
          firstSeenAt: NOW,
          lastSeenAt: NOW,
          lastSnapshotId: snapshot.id,
        },
      });
    });

    const { id } = await createCampaign(tenantId, actorUserId, draft());
    await startCampaign(tenantId, actorUserId, id, { now: NOW });
    const items = await withTenant(tenantId, (tx) =>
      tx.campaignItem.findMany({ where: { campaignId: id } }),
    );
    expect(items.some((i) => i.riskFlags.includes('sod_violation'))).toBe(true);
  });

  it('does NOT flag from a violation last seen in an OLDER snapshot', async () => {
    // The negative half of the flag, and the reason the query filters on
    // `lastSnapshotId`. A violation last observed in a snapshot the campaign is
    // not built from says nothing about the holdings this campaign covers — the
    // holding on the other side may since have gone.
    await buildSnapshot(tenantId, { now: NOW });
    await withTenant(tenantId, async (tx) => {
      const older = await tx.accessSnapshot.create({
        data: {
          tenantId,
          kind: 'manual',
          status: 'complete',
          asOf: new Date(NOW.getTime() - 86_400_000),
        },
      });
      const holding = await tx.holding.findFirstOrThrow({
        where: { resourceKind: 'targetEntitlement' },
      });
      const fnA = await tx.businessFunction.create({ data: { tenantId, name: 'AP entry', ownerPersonId: subjectPersonId } });
      const fnB = await tx.businessFunction.create({ data: { tenantId, name: 'AP approve', ownerPersonId: subjectPersonId } });
      const rule = await tx.sodRule.create({
        data: {
          tenantId,
          name: 'AP entry vs approve',
          functionAId: fnA.id,
          functionBId: fnB.id,
          severity: 'critical',
          rationale: 'one person must not both raise and pay an invoice',
        },
      });
      await tx.sodViolation.create({
        data: {
          tenantId,
          ruleId: rule.id,
          personId: subjectPersonId,
          severity: 'critical',
          status: 'open',
          holdingsA: [
            {
              systemId: holding.systemId,
              resourceKind: holding.resourceKind,
              resourceId: holding.resourceId,
              resourceName: holding.resourceName,
              contractIds: [],
            },
          ] as never,
          holdingsB: [] as never,
          contractsA: [] as never,
          contractsB: [] as never,
          firstSeenAt: NOW,
          lastSeenAt: NOW,
          // The OLDER snapshot, not the one the campaign is built from.
          lastSnapshotId: older.id,
        },
      });
    });

    const { id } = await createCampaign(tenantId, actorUserId, draft());
    await startCampaign(tenantId, actorUserId, id, { now: NOW });
    const items = await withTenant(tenantId, (tx) =>
      tx.campaignItem.findMany({ where: { campaignId: id } }),
    );
    expect(items.every((i) => !i.riskFlags.includes('sod_violation'))).toBe(true);
  });

  it('resolves reviewers in REVIEWER_BATCH transactions, not inside the item-creation one', () => {
    // Creating ITEM_BATCH items and resolving reviewers for all of them in the
    // SAME transaction costs a full `resolveStageApprovers` per item inside one
    // 5000 ms budget. The structural assertion is the one that survives a fast
    // fixture.
    const source = readFileSync(new URL('./campaign-service.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/REVIEWER_BATCH/);
    const creationBlock = source.slice(
      source.indexOf('// ---- create the items'),
      source.indexOf('// ---- resolve reviewers'),
    );
    expect(
      creationBlock,
      'reviewer resolution must not run inside the item-creation transaction',
    ).not.toMatch(/resolveItemReviewers/);
  });

  it('is INVISIBLE to reviewers while generating, and nobody is notified until it opens', async () => {
    await buildSnapshot(tenantId, { now: NOW });
    const { id } = await createCampaign(tenantId, actorUserId, draft());
    const before = await withTenant(tenantId, (tx) => tx.notificationOutbox.count());
    await startCampaign(tenantId, actorUserId, id, { now: NOW });
    const after = await withTenant(tenantId, (tx) => tx.notificationOutbox.count());
    expect(before).toBe(0);
    expect(after).toBeGreaterThan(0);

    // AND the ordering, structurally — because the counts above are taken
    // outside the call and cannot see a notification sent DURING generation,
    // which is the failure this rule exists to prevent. A reviewer told while
    // the queue is still filling opens a queue that is still filling.
    const source = readFileSync(new URL('./campaign-service.ts', import.meta.url), 'utf8');
    const body = source.slice(
      source.indexOf('export async function startCampaign'),
      source.indexOf('export async function extendCampaign'),
    );
    const opened = body.indexOf("status: 'open'");
    const notified = body.indexOf('enqueueOutbox(');
    expect(opened, 'startCampaign must set status open').toBeGreaterThan(-1);
    expect(notified, 'startCampaign must notify').toBeGreaterThan(-1);
    expect(notified, 'nobody is notified until the campaign is open').toBeGreaterThan(opened);
  });

  it('batches generation so no transaction carries the whole scope', async () => {
    await buildSnapshot(tenantId, { now: NOW });
    const { id } = await createCampaign(tenantId, actorUserId, draft());
    const result = await startCampaign(tenantId, actorUserId, id, { now: NOW, batchSize: 1 });
    expect(result.itemCount).toBe(1);
  });

  it('generating twice over the same scope creates no duplicate item', async () => {
    // A `startCampaign` that crashes mid-generation and is retried would
    // otherwise duplicate everything it had already written, and the campaign
    // has no `generating`-supersession path.
    // `@@unique([campaignId, subjectKey, systemId, resourceKind, resourceId])`
    // plus `skipDuplicates` is what stands in for one.
    await buildSnapshot(tenantId, { now: NOW });
    const { id } = await createCampaign(tenantId, actorUserId, draft());
    await startCampaign(tenantId, actorUserId, id, { now: NOW });

    // Simulate the crash-then-retry: put it back and run again.
    await withTenant(tenantId, (tx) =>
      tx.campaign.update({ where: { id }, data: { status: 'draft' } }),
    );
    const second = await startCampaign(tenantId, actorUserId, id, { now: NOW });
    expect(second.itemCount).toBe(1);
    expect(
      await withTenant(tenantId, (tx) => tx.campaignItem.count({ where: { campaignId: id } })),
    ).toBe(1);
  });

  it('refuses to start a campaign that is not a draft', async () => {
    await buildSnapshot(tenantId, { now: NOW });
    const { id } = await createCampaign(tenantId, actorUserId, draft());
    await startCampaign(tenantId, actorUserId, id, { now: NOW });
    await expect(startCampaign(tenantId, actorUserId, id, { now: NOW })).rejects.toMatchObject({
      code: 'not_draft',
    });
  });

  it('refuses to start a campaign whose scope covers NOTHING', async () => {
    // 200 managers emailed about an empty queue is worse than a refusal.
    await buildSnapshot(tenantId, { now: NOW });
    const { id } = await createCampaign(
      tenantId,
      actorUserId,
      draft({ scope: { resourceKinds: ['syntraUser'] } }),
    );
    await withTenant(tenantId, (tx) =>
      tx.holding.deleteMany({ where: { resourceKind: 'syntraUser' } }),
    );
    await expect(startCampaign(tenantId, actorUserId, id, { now: NOW })).rejects.toMatchObject({
      code: 'empty_scope',
    });
  });
});

describe('extending is an act', () => {
  it('records who extended it and by how long, keeps the original date, and notifies', async () => {
    await buildSnapshot(tenantId, { now: NOW });
    const { id } = await createCampaign(tenantId, actorUserId, draft());
    await startCampaign(tenantId, actorUserId, id, { now: NOW });

    const newDue = new Date(DUE.getTime() + 14 * 86_400_000);
    await extendCampaign(tenantId, actorUserId, id, newDue);

    const campaign = await withTenant(tenantId, (tx) =>
      tx.campaign.findUniqueOrThrow({ where: { id } }),
    );
    expect(campaign).toMatchObject({ extensionCount: 1, dueAt: newDue, originalDueAt: DUE });
    const event = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findFirstOrThrow({ where: { action: 'govern.campaign.extend' } }),
    );
    expect(event.payload).toMatchObject({
      originalDueAt: DUE.toISOString(),
      extensionCount: 1,
    });
  });

  it('refuses to move the due date BACKWARDS past the original', async () => {
    await buildSnapshot(tenantId, { now: NOW });
    const { id } = await createCampaign(tenantId, actorUserId, draft());
    await startCampaign(tenantId, actorUserId, id, { now: NOW });
    await expect(
      extendCampaign(tenantId, actorUserId, id, new Date(DUE.getTime() - 86_400_000)),
    ).rejects.toThrow(/backwards/i);
  });
});

describe('re-basing re-opens only what changed', () => {
  it('keeps a certification of a holding that did not change and re-opens one that did', async () => {
    await buildSnapshot(tenantId, { now: NOW });
    const { id } = await createCampaign(tenantId, actorUserId, draft());
    await startCampaign(tenantId, actorUserId, id, { now: NOW });
    const item = await withTenant(tenantId, (tx) => tx.campaignItem.findFirstOrThrow());
    await withTenant(tenantId, async (tx) => {
      await tx.campaignDecision.create({
        data: {
          tenantId,
          itemId: item.id,
          personId: managerPersonId,
          decision: 'certify',
          itemOpenedAt: NOW,
          decidedAt: NOW,
          sessionDecisionOrdinal: 1,
          coverageAtDecision: {},
        },
      });
      await tx.campaignItem.update({ where: { id: item.id }, data: { status: 'certified' } });
    });

    const later = new Date(NOW.getTime() + 86_400_000);
    const rebuilt = await buildSnapshot(tenantId, { now: later });
    const result = await rebaseCampaign(tenantId, actorUserId, id, rebuilt.snapshotId);

    // A certification of a holding that has not changed is STILL GOOD.
    expect(result).toEqual({ reopened: 0, kept: 1, untouched: 0 });
    const after = await withTenant(tenantId, (tx) =>
      tx.campaignItem.findUniqueOrThrow({ where: { id: item.id } }),
    );
    expect(after.status).toBe('certified');
  });

  it('re-opens an item whose holding gained an attribution', async () => {
    await buildSnapshot(tenantId, { now: NOW });
    const { id } = await createCampaign(tenantId, actorUserId, draft());
    await startCampaign(tenantId, actorUserId, id, { now: NOW });
    const item = await withTenant(tenantId, (tx) => tx.campaignItem.findFirstOrThrow());
    await withTenant(tenantId, async (tx) => {
      await tx.campaignDecision.create({
        data: {
          tenantId,
          itemId: item.id,
          personId: managerPersonId,
          decision: 'certify',
          itemOpenedAt: NOW,
          decidedAt: NOW,
          sessionDecisionOrdinal: 1,
          coverageAtDecision: {},
        },
      });
      await tx.campaignItem.update({ where: { id: item.id }, data: { status: 'certified' } });
      // The holding stops being unattributable: somebody recorded a cause.
      const holding = await tx.accountEntitlement.findFirstOrThrow();
      await tx.accountEntitlement.update({ where: { id: holding.id }, data: { origin: 'manual' } });
    });

    const later = new Date(NOW.getTime() + 86_400_000);
    const rebuilt = await buildSnapshot(tenantId, { now: later });
    const result = await rebaseCampaign(tenantId, actorUserId, id, rebuilt.snapshotId);
    expect(result.reopened).toBe(1);
    const after = await withTenant(tenantId, (tx) =>
      tx.campaignItem.findUniqueOrThrow({ where: { id: item.id } }),
    );
    expect(after.status).toBe('pending');
  });

  /**
   * §11 calls `undecided` TERMINAL: "the campaign closed and nobody decided
   * this item. It was NOT attested." Re-base had no status filter at all, so it
   * put terminal items back to `pending` -- resurrecting a decision nobody
   * made, deleting the record that nobody made it, and leaving the
   * `undecided_item` remediation row pointing at an item that is no longer
   * undecided.
   */
  it('leaves a terminal undecided item alone', async () => {
    await buildSnapshot(tenantId, { now: NOW });
    const { id } = await createCampaign(tenantId, actorUserId, draft());
    await startCampaign(tenantId, actorUserId, id, { now: NOW });
    const item = await withTenant(tenantId, (tx) => tx.campaignItem.findFirstOrThrow());
    await withTenant(tenantId, (tx) =>
      tx.campaignItem.update({ where: { id: item.id }, data: { status: 'undecided' } }),
    );

    const later = new Date(NOW.getTime() + 86_400_000);
    const rebuilt = await buildSnapshot(tenantId, { now: later });
    const result = await rebaseCampaign(tenantId, actorUserId, id, rebuilt.snapshotId);

    expect(result).toEqual({ reopened: 0, kept: 0, untouched: 1 });
    const after = await withTenant(tenantId, (tx) =>
      tx.campaignItem.findUniqueOrThrow({ where: { id: item.id } }),
    );
    expect(after.status).toBe('undecided');
  });

  /**
   * A dispatched revocation that Provision APPLIED is absent from the next
   * snapshot -- which is the outcome, not a disappearance. Overwriting it to
   * `moot` erased the one thing §13's whole dispatch vocabulary exists to
   * record, and the campaign then reported the removal it caused as a holding
   * that happened to stop existing.
   */
  it('leaves a dispatched revocation alone even though the holding is gone', async () => {
    await buildSnapshot(tenantId, { now: NOW });
    const { id } = await createCampaign(tenantId, actorUserId, draft());
    await startCampaign(tenantId, actorUserId, id, { now: NOW });
    const item = await withTenant(tenantId, (tx) => tx.campaignItem.findFirstOrThrow());
    await withTenant(tenantId, (tx) =>
      tx.campaignItem.update({
        where: { id: item.id },
        data: { status: 'revocation_dispatched' },
      }),
    );

    // A snapshot with no holdings at all: the removal landed.
    const later = new Date(NOW.getTime() + 86_400_000);
    const rebuilt = await buildSnapshot(tenantId, {
      now: later,
      collect: async () => emptyCollectionAt(later),
    });
    const result = await rebaseCampaign(tenantId, actorUserId, id, rebuilt.snapshotId);

    expect(result.untouched).toBe(1);
    const after = await withTenant(tenantId, (tx) =>
      tx.campaignItem.findUniqueOrThrow({ where: { id: item.id } }),
    );
    expect(after.status).toBe('revocation_dispatched');
  });

  it('refuses to re-base a campaign that is not open', async () => {
    // Re-basing exists so a stale campaign's revocations can execute (§8 rule
    // 2). A closed campaign has no revocations left to unblock, and re-opening
    // its items would put a queue in front of reviewers for a campaign whose
    // coverage figure is already signed.
    await buildSnapshot(tenantId, { now: NOW });
    const { id } = await createCampaign(tenantId, actorUserId, draft());
    await startCampaign(tenantId, actorUserId, id, { now: NOW });
    await withTenant(tenantId, (tx) =>
      tx.campaign.update({ where: { id }, data: { status: 'closed_complete' } }),
    );

    const later = new Date(NOW.getTime() + 86_400_000);
    const rebuilt = await buildSnapshot(tenantId, { now: later });
    await expect(
      rebaseCampaign(tenantId, actorUserId, id, rebuilt.snapshotId),
    ).rejects.toMatchObject({ code: 'not_open' });
  });
});

/**
 * Step 9a(a). The dispatch order is 19, 18, 17, so this is the first point at
 * which `campaign-service.ts` and `decision-service.ts` both exist and the
 * hazard can be tested with BOTH HALVES REAL.
 */
describe('the certification projection and the re-base composition hazard', () => {
  /** A real decision through the production path — never a hand-built projection row. */
  const seedCertifiedItem = async () => {
    await buildSnapshot(tenantId, { now: NOW });
    const { id } = await createCampaign(tenantId, actorUserId, draft());
    await startCampaign(tenantId, actorUserId, id, { now: NOW });
    const item = await withTenant(tenantId, (tx) => tx.campaignItem.findFirstOrThrow());
    await recordCampaignDecision(
      tenantId,
      {
        itemId: item.id,
        deciderPersonId: managerPersonId,
        deciderUserId: managerUserId,
        decision: 'certify',
        // The seeded holding is `origin: 'discovered'`, so the snapshot marks
        // it unattributable and the decision service requires a comment naming
        // who said it was fine. That rule firing here is the two modules
        // composing correctly, and supplying the comment is what a reviewer
        // would do.
        comment: 'confirmed with the finance systems manager on 2026-06-12',
      },
      { now: NOW },
    );
    return { itemId: item.id, campaignId: id };
  };

  it('keeps the projection for an item a re-base did NOT re-open', async () => {
    // Two individually correct rules: "re-basing re-opens only what changed"
    // and "the projection is rebuilt from decisions". Composed naively, a
    // re-base rolls the projection back for items whose holding did not change,
    // and a certification that is still good reads as never made.
    //
    // A version that SIMULATED the re-base with a `campaign.update` could not
    // fail against a `rebaseCampaign` that deleted the projection. Here both
    // functions are called for real.
    const { itemId, campaignId } = await seedCertifiedItem();
    const before = await withTenant(tenantId, (tx) =>
      tx.holdingCertification.findFirstOrThrow(),
    );

    const later = new Date(NOW.getTime() + 86_400_000);
    const rebuilt = await buildSnapshot(tenantId, { now: later });
    const result = await rebaseCampaign(tenantId, actorUserId, campaignId, rebuilt.snapshotId);
    expect(result).toEqual({ reopened: 0, kept: 1, untouched: 0 });

    const after = await withTenant(tenantId, (tx) => tx.holdingCertification.findFirstOrThrow());
    expect(after.lastCertifiedAt).toEqual(before.lastCertifiedAt);
    expect(after.lastDecisionId).toBe(before.lastDecisionId);
    // And the item itself was not re-opened, because its holding did not change.
    const item = await withTenant(tenantId, (tx) =>
      tx.campaignItem.findUniqueOrThrow({ where: { id: itemId } }),
    );
    expect(item.status).toBe('certified');
  });

  /**
   * The other half of the composition hazard this function's docstring names.
   *
   * An item it KEEPS must keep its projection -- rolling that back would make a
   * certification that is still good read as never made. An item it RE-OPENS is
   * the opposite case: the holding changed, so what was certified is not what
   * is there now, and a `HoldingCertification` left behind says a named human
   * attested to facts nobody showed them.
   */
  it('drops the certification projection for a certified item it re-opens', async () => {
    await buildSnapshot(tenantId, { now: NOW });
    const { id } = await createCampaign(tenantId, actorUserId, draft());
    await startCampaign(tenantId, actorUserId, id, { now: NOW });
    const item = await withTenant(tenantId, (tx) => tx.campaignItem.findFirstOrThrow());
    await recordCampaignDecision(
      tenantId,
      {
        itemId: item.id,
        deciderPersonId: managerPersonId,
        deciderUserId: managerUserId,
        decision: 'certify',
        // The seeded holding is UNATTRIBUTABLE, and certifying one of those
        // requires a comment saying who said it was fine. That refusal is the
        // subject of its own test elsewhere; here it is just the price of
        // getting a projection row to exist at all.
        comment: 'the finance lead confirmed this is required for the year-end close',
      },
      { now: NOW },
    );
    expect(await withTenant(tenantId, (tx) => tx.holdingCertification.count())).toBe(1);

    // A snapshot in which the holding is gone: the item re-opens as `moot`.
    const later = new Date(NOW.getTime() + 86_400_000);
    const rebuilt = await buildSnapshot(tenantId, {
      now: later,
      collect: async () => emptyCollectionAt(later),
    });
    const result = await rebaseCampaign(tenantId, actorUserId, id, rebuilt.snapshotId);

    expect(result.reopened).toBe(1);
    expect(await withTenant(tenantId, (tx) => tx.holdingCertification.count())).toBe(0);
  });
});

describe('coverageOf', () => {
  it('is (decided + moot) / total, and moot is in the numerator', () => {
    const coverage = coverageOf({ total: 1840, decided: 1693, moot: 63 });
    expect(coverage).toEqual({
      known: true,
      value: { percent: 95.4, numerator: 1756, denominator: 1840 },
    });
  });

  it('is unknown for an EMPTY campaign rather than 0% or 100%', () => {
    expect(coverageOf({ total: 0, decided: 0, moot: 0 }).known).toBe(false);
  });
});

/**
 * A value stored, shown on the screen, and consulted by nothing.
 *
 * `opensAt` is `REQUIRED` on the row and is the first half of the reminder
 * cadence -- `runCampaignReminders` computes `elapsed / total` from it -- so a
 * campaign scheduled to open next month was live the moment somebody pressed
 * start, and its reminder share was NEGATIVE until the opening date passed.
 * "Scheduled for next quarter" was a label, not a behaviour.
 */
describe('opensAt', () => {
  it('refuses to start a campaign before it opens', async () => {
    await buildSnapshot(tenantId, { now: NOW });
    const { id } = await createCampaign(
      tenantId,
      actorUserId,
      draft({ opensAt: new Date(NOW.getTime() + 7 * 86_400_000) }),
    );
    await expect(
      startCampaign(tenantId, actorUserId, id, { now: NOW }),
    ).rejects.toMatchObject({ code: 'not_open_yet' });

    const campaign = await withTenant(tenantId, (tx) =>
      tx.campaign.findUniqueOrThrow({ where: { id } }),
    );
    expect(campaign.status).toBe('draft');
  });

  it('starts it once the opening date has passed', async () => {
    await buildSnapshot(tenantId, { now: NOW });
    const { id } = await createCampaign(
      tenantId,
      actorUserId,
      draft({ opensAt: new Date(NOW.getTime() - 86_400_000) }),
    );
    const started = await startCampaign(tenantId, actorUserId, id, { now: NOW });
    expect(started.status).toBe('open');
  });
});

/**
 * "A due date that can be moved quietly is not a due date" -- and a due date
 * that can be moved after the campaign closed is not a due date either. The
 * function checked only that the new date was later, so a closed campaign's
 * `dueAt` could be pushed out, its `extensionCount` raised, and its reviewers
 * re-notified about a queue nobody can decide in. The evidence bundle then
 * carries a due date the campaign never actually ran to.
 */
describe('extendCampaign', () => {
  it('refuses to extend a campaign that has closed', async () => {
    await buildSnapshot(tenantId, { now: NOW });
    const { id } = await createCampaign(tenantId, actorUserId, draft());
    await withTenant(tenantId, (tx) =>
      tx.campaign.update({ where: { id }, data: { status: 'closed_incomplete' } }),
    );
    await expect(
      extendCampaign(tenantId, actorUserId, id, new Date(DUE.getTime() + 30 * 86_400_000)),
    ).rejects.toMatchObject({ code: 'not_open' });
  });
});
