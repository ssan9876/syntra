import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { createUser } from '../directory/user-service.js';
import {
  computeRevocationBatch,
  confirmRevocationBatch,
  loadRevocationOrders,
  reflectRevocationOutcomes,
  skipDispatch,
} from './revocation-service.js';

/**
 * `revokeGrant` is REPLACED, not spied on a namespace object.
 *
 * Under Vitest's ESM transform a bare `vi.spyOn(module, 'fn')` is not reliably
 * writable, and a spy that silently failed to install would let the
 * irreversible path call Automate for real inside a test — the one place a
 * false green is most expensive. The module mock keeps every other export of
 * `fulfil.js` genuine, so nothing else in the path is faked.
 */
const revokeGrantMock = vi.hoisted(() =>
  vi.fn<
    (
      tenantId: string,
      actorUserId: string | null,
      grantId: string,
      reason: string,
    ) => Promise<void>
  >(),
);
vi.mock('../automate/fulfil.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../automate/fulfil.js')>();
  return { ...actual, revokeGrant: revokeGrantMock };
});

const NOW = new Date('2026-06-15T09:00:00Z');

let tenantId: string;
let campaignId: string;
let snapshotId: string;
let targetSystemId: string;
let subjectPersonId: string;
let reviewerPersonId: string;
let reviewerUserId: string;
/** A REAL user id: `AuditEvent.actorUserId` is `@db.Uuid`, so 'u-1' is a cast error. */
let actorUserId: string;
/** Twenty entitlement ids, ORDERED, because `decided` is read `resourceId: 'asc'`. */
let entitlementIds: string[];

/**
 * Explicit ids rather than generated ones, so the batch's row order is the
 * order these were created in. `computeRevocationBatch` reads the decided items
 * `orderBy: { resourceId: 'asc' }`, and random uuids would make the two route
 * assertions below pass or fail on a coin toss.
 */
const entitlementId = (index: number): string =>
  `20000000-0000-0000-0000-${String(index).padStart(12, '0')}`;

/**
 * Two decided items: one `discovered` (routes to an order) and one carrying a
 * live business rule (routes to requires_change). A fixture with only one route
 * could not tell a router that always dispatches from one that never does.
 *
 * Twenty holdings, so the per-resource denominator is a real number read from
 * the campaign's own snapshot rather than an `unknown` that forces confirmation
 * for a reason the test did not intend.
 */
async function seedDecidedItems() {
  return withTenant(tenantId, async (tx) => {
    const reviewer = await tx.person.create({
      data: { tenantId, givenName: 'Jan', familyName: 'Manager' },
    });
    await tx.contract.create({
      data: {
        tenantId,
        personId: reviewer.id,
        sequence: 1,
        isPrimary: true,
        startDate: new Date('2020-01-01'),
      },
    });
    const reviewerLogin = await createUser(tx, {
      login: 'jan',
      email: 'jan@acme.test',
      displayName: 'Jan Manager',
    });
    await tx.user.update({ where: { id: reviewerLogin.id }, data: { personId: reviewer.id } });

    const admin = await createUser(tx, {
      login: 'admin',
      email: 'admin@acme.test',
      displayName: 'Ada Admin',
    });

    const subject = await tx.person.create({
      data: { tenantId, givenName: 'Anna', familyName: 'Novak' },
    });
    await tx.contract.create({
      data: {
        tenantId,
        personId: subject.id,
        sequence: 1,
        isPrimary: true,
        startDate: new Date('2020-01-01'),
      },
    });

    // A REAL target, real entitlements and a real account. `RevocationOrder`'s
    // three reference columns are `@db.Uuid`, so 'sys-1' and 'ent-0' are cast
    // errors on the irreversible path, not merely untidy fixtures.
    const target = await tx.targetSystem.create({
      data: {
        tenantId,
        name: 'Acme AD',
        secretName: 's/ad',
        config: { tlsMode: 'ldaps' },
        lastRunAt: NOW,
        lastAppliedRunAt: NOW,
      },
    });
    const entitlements: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      const row = await tx.entitlement.create({
        data: {
          id: entitlementId(i),
          tenantId,
          targetSystemId: target.id,
          externalId: `guid-${i}`,
          type: 'group',
          displayName: `Group ${i}`,
        },
      });
      entitlements.push(row.id);
    }
    await tx.targetAccount.create({
      data: {
        tenantId,
        targetSystemId: target.id,
        personId: subject.id,
        anchor: 'guid-anna',
        correlationKey: 'anna.novak',
        status: 'active',
        lastReconciledAt: NOW,
      },
    });

    const snapshot = await tx.accessSnapshot.create({
      data: {
        tenantId,
        kind: 'manual',
        status: 'complete',
        asOf: NOW,
        personsWithActiveContract: 2,
        holdingCount: 20,
      },
    });
    await tx.snapshotSource.create({
      data: {
        tenantId,
        snapshotId: snapshot.id,
        sourceKind: 'targetSystem',
        sourceId: target.id,
        sourceName: 'Acme AD',
        lastSuccessfulReadAt: NOW,
        completeness: 'complete',
        staleness: 'fresh',
        freshnessSlaHours: 24,
      },
    });
    for (const resourceId of entitlements) {
      await tx.holding.create({
        data: {
          tenantId,
          snapshotId: snapshot.id,
          subjectKey: `person:${subject.id}`,
          personId: subject.id,
          systemKind: 'targetSystem',
          systemId: target.id,
          resourceKind: 'targetEntitlement',
          resourceId,
          resourceName: `Group ${resourceId}`,
          state: 'held',
          observedAt: NOW,
          observedVia: 'provision',
          firstSeenAt: NOW,
        },
      });
    }

    const campaign = await tx.campaign.create({
      data: {
        tenantId,
        name: 'Q2 review',
        scope: { resourceKinds: ['targetEntitlement'] },
        snapshotId: snapshot.id,
        reviewerSelector: 'manager',
        reviewerConfig: {},
        fallbackSelector: 'person',
        fallbackConfig: { personId: reviewer.id },
        ownerPersonId: reviewer.id,
        opensAt: NOW,
        dueAt: new Date(NOW.getTime() + 86_400_000),
        originalDueAt: new Date(NOW.getTime() + 86_400_000),
        status: 'open',
      },
    });

    const makeItem = async (resourceId: string, attributions: unknown) => {
      const item = await tx.campaignItem.create({
        data: {
          tenantId,
          campaignId: campaign.id,
          holdingSnapshotId: snapshot.id,
          subjectKey: `person:${subject.id}`,
          personId: subject.id,
          systemId: target.id,
          resourceKind: 'targetEntitlement',
          resourceId,
          resourceName: `Group ${resourceId}`,
          attributions: attributions as never,
          observedAt: NOW,
          coverageStatus: 'complete',
          status: 'revoke_decided',
        },
      });
      await tx.campaignDecision.create({
        data: {
          tenantId,
          itemId: item.id,
          personId: reviewer.id,
          decidedByUserId: reviewerLogin.id,
          decision: 'revoke',
          comment: 'not needed',
          itemOpenedAt: NOW,
          decidedAt: NOW,
          sessionDecisionOrdinal: 1,
          coverageAtDecision: {},
        },
      });
      return item.id;
    };

    await makeItem(entitlements[0]!, [{ kind: 'discovered', detail: {} }]);
    await makeItem(entitlements[1]!, [
      { kind: 'business_rule', detail: { ruleName: 'Finance staff', ruleEnabled: true } },
    ]);

    return {
      campaignId: campaign.id,
      snapshotId: snapshot.id,
      targetSystemId: target.id,
      subjectPersonId: subject.id,
      reviewerPersonId: reviewer.id,
      reviewerUserId: reviewerLogin.id,
      actorUserId: admin.id,
      entitlementIds: entitlements,
    };
  });
}

/** Turns the first item into one Automate owns, with a grant behind it. */
async function makeFirstItemAGrant(status = 'active'): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx.campaignItem.updateMany({
      where: { resourceId: entitlementIds[0]! },
      data: { attributions: [{ kind: 'request', detail: {} }] as never },
    });
    await tx.accessGrant.create({
      data: {
        tenantId,
        subjectPersonId,
        resourceType: 'entitlement',
        resourceId: entitlementIds[0]!,
        targetSystemId,
        origin: 'request',
        startsAt: NOW,
        status,
      },
    });
  });
}

beforeEach(async () => {
  revokeGrantMock.mockReset();
  revokeGrantMock.mockResolvedValue(undefined);
  await resetDatabase();
  const tenant = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = tenant.id;
  const seeded = await seedDecidedItems();
  campaignId = seeded.campaignId;
  snapshotId = seeded.snapshotId;
  targetSystemId = seeded.targetSystemId;
  subjectPersonId = seeded.subjectPersonId;
  reviewerPersonId = seeded.reviewerPersonId;
  reviewerUserId = seeded.reviewerUserId;
  actorUserId = seeded.actorUserId;
  entitlementIds = seeded.entitlementIds;
});

describe('computeRevocationBatch', () => {
  it('routes each item and REQUIRES CONFIRMATION on the first batch, whatever its size', async () => {
    // Every denominator is zero and no percentage can say anything about it.
    // Provision found this hole in Directory Sync's guard.
    const result = await computeRevocationBatch(tenantId, actorUserId, campaignId, { now: NOW });
    expect(result.status).toBe('previewed');
    expect(result.requiresConfirmation).toBe(true);
    expect(result.blockedReason).toContain('first revocation batch');

    const dispatches = await withTenant(tenantId, (tx) =>
      tx.revocationDispatch.findMany({ orderBy: { sequence: 'asc' } }),
    );
    expect(dispatches.map((d) => d.route)).toEqual(['revocation_order', 'requires_change_rule']);
    // BOTH rows are `proposed` at compute time (Ruling G-43). The route already
    // carries the distinction, and `revocation_dispatch_requires_change_has_item`
    // requires a remediation item that does not exist until the batch is
    // CONFIRMED — a `requires_change` row with no remediation item is a row
    // saying somebody must change something with nobody named to do it.
    expect(dispatches.map((d) => d.status)).toEqual(['proposed', 'proposed']);
    // An explicit ordinal, because createdAt is transaction start time and
    // every row of the batch's createMany carries the same one.
    expect(dispatches.map((d) => d.sequence)).toEqual([0, 1]);
    // Only the DISPATCHABLE row counts as a proposed revocation.
    const batch = await withTenant(tenantId, (tx) =>
      tx.revocationBatch.findUniqueOrThrow({ where: { id: result.batchId } }),
    );
    expect(batch).toMatchObject({ proposedCount: 1, requiresChangeCount: 1 });
  });

  it('SUPERSEDES a crashed batch rather than colliding with its index', async () => {
    await withTenant(tenantId, (tx) =>
      tx.revocationBatch.create({ data: { tenantId, campaignId, status: 'computing' } }),
    );
    const result = await computeRevocationBatch(tenantId, actorUserId, campaignId, { now: NOW });
    expect(result.status).toBe('previewed');
    // Identified by id, not by position: the new batch carries the injected
    // `now`, which is EARLIER than the crashed row's default `now()`, so any
    // ordering by `startedAt` puts them the other way round.
    const batches = await withTenant(tenantId, (tx) => tx.revocationBatch.findMany());
    expect(batches).toHaveLength(2);
    const crashed = batches.find((b) => b.id !== result.batchId)!;
    expect(crashed.status).toBe('superseded');
    expect(crashed.error).toContain('superseded');
    expect(crashed.finishedAt).not.toBeNull();
  });

  it('BLOCKS outright when the snapshot has aged past the limit', async () => {
    const result = await computeRevocationBatch(tenantId, actorUserId, campaignId, {
      now: new Date(NOW.getTime() + 60 * 86_400_000),
    });
    expect(result.status).toBe('blocked');
    expect(result.blockedReason).toContain('days old');
  });

  it('BLOCKS outright when a source in the batch’s scope has gone stale', async () => {
    await withTenant(tenantId, (tx) =>
      tx.snapshotSource.updateMany({ where: { snapshotId }, data: { staleness: 'stale' } }),
    );
    const result = await computeRevocationBatch(tenantId, actorUserId, campaignId, { now: NOW });
    expect(result.status).toBe('blocked');
    expect(result.blockedReason).toContain('Acme AD');
  });
});

describe('confirmRevocationBatch', () => {
  // Every test here passes `confirmed: true` unless it is testing the refusal
  // itself: the FIRST batch for a tenant always sets `requiresConfirmation`,
  // because every denominator is zero and no percentage can say anything about
  // it. A test that omitted it would be asserting against a refusal.

  it('refuses to confirm a BLOCKED batch — there is nothing to confirm', async () => {
    await withTenant(tenantId, (tx) =>
      tx.snapshotSource.updateMany({ where: { snapshotId }, data: { staleness: 'stale' } }),
    );
    const { batchId } = await computeRevocationBatch(tenantId, actorUserId, campaignId, {
      now: NOW,
    });
    await expect(
      confirmRevocationBatch(tenantId, actorUserId, batchId, { now: NOW, confirmed: true }),
    ).rejects.toMatchObject({ code: 'blocked' });
  });

  it('writes a RevocationOrder carrying the deciding human, the campaign and the reason', async () => {
    // Ruling G1's condition: the record at the point of application must show a
    // human decision and name the campaign and the reviewer.
    const { batchId } = await computeRevocationBatch(tenantId, actorUserId, campaignId, {
      now: NOW,
    });
    await confirmRevocationBatch(tenantId, actorUserId, batchId, { now: NOW, confirmed: true });

    const order = await withTenant(tenantId, (tx) => tx.revocationOrder.findFirstOrThrow());
    expect(order).toMatchObject({
      status: 'open',
      entitlementId: entitlementIds[0]!,
      targetSystemId,
      decidedByPersonId: reviewerPersonId,
      decidedByPersonName: 'Jan Manager',
      campaignName: 'Q2 review',
    });
    expect(order.reason).toContain('not needed');
    expect(order.campaignDecisionId).not.toBeNull();
    // The account it names is the SUBJECT's, not the reviewer's.
    const account = await withTenant(tenantId, (tx) =>
      tx.targetAccount.findUniqueOrThrow({ where: { id: order.accountId } }),
    );
    expect(account.personId).toBe(subjectPersonId);
  });

  it('produces a RemediationItem and NO revocation for the rule-attributed item', async () => {
    const { batchId } = await computeRevocationBatch(tenantId, actorUserId, campaignId, {
      now: NOW,
    });
    const result = await confirmRevocationBatch(tenantId, actorUserId, batchId, {
      now: NOW,
      confirmed: true,
    });

    expect(result).toMatchObject({ dispatched: 1, requiresChange: 1, failed: 0 });
    const remediation = await withTenant(tenantId, (tx) =>
      tx.remediationItem.findFirstOrThrow({ where: { kind: 'rule_change_required' } }),
    );
    // It names the resource, the subject and what has to change. A remediation
    // item naming none of those is a task nobody can act on.
    expect(remediation.description).toContain(`Group ${entitlementIds[1]!}`);
    expect(remediation.description).toContain(`person:${subjectPersonId}`);
    expect(remediation.description).toContain('business rule');
    expect(remediation.description).toContain('business_rule');
    expect(remediation.ownerPersonId).toBe(reviewerPersonId);

    const items = await withTenant(tenantId, (tx) =>
      tx.campaignItem.findMany({ orderBy: { resourceId: 'asc' } }),
    );
    expect(items.map((i) => i.status)).toEqual([
      'revocation_dispatched',
      'revocation_requires_change',
    ]);
    // THE VOCABULARY RULE: exactly one revocation left this batch, and the
    // rule-attributed holding is not it. `Campaign.requiresChangeItems` is
    // written at close by `closeDueCampaigns` and is asserted there.
    const dispatchRow = await withTenant(tenantId, (tx) =>
      tx.revocationDispatch.findFirstOrThrow({ where: { route: 'requires_change_rule' } }),
    );
    expect(dispatchRow.status).toBe('requires_change');
    expect(dispatchRow.remediationItemId).toBe(remediation.id);
    expect(dispatchRow.revocationOrderId).toBeNull();
    expect(await withTenant(tenantId, (tx) => tx.revocationOrder.count())).toBe(1);
  });

  it('reuses the OPEN remediation item when a second batch covers the same holding', async () => {
    // `createRemediationItem` DEDUPLICATES and returns null for a holding it has
    // already filed. A null written to `remediationItemId` violates
    // `revocation_dispatch_requires_change_has_item`, aborts the transaction,
    // and lands the row in the catch as `failed` carrying a database error
    // string in the message a human reads.
    const first = await computeRevocationBatch(tenantId, actorUserId, campaignId, { now: NOW });
    await confirmRevocationBatch(tenantId, actorUserId, first.batchId, {
      now: NOW,
      confirmed: true,
    });
    const remediation = await withTenant(tenantId, (tx) =>
      tx.remediationItem.findFirstOrThrow({ where: { kind: 'rule_change_required' } }),
    );

    await withTenant(tenantId, (tx) =>
      tx.campaignItem.updateMany({
        where: { resourceId: entitlementIds[1]! },
        data: { status: 'revoke_decided' },
      }),
    );
    const second = await computeRevocationBatch(tenantId, actorUserId, campaignId, { now: NOW });
    const result = await confirmRevocationBatch(tenantId, actorUserId, second.batchId, {
      now: NOW,
      confirmed: true,
    });

    expect(result).toMatchObject({ requiresChange: 1, failed: 0 });
    const row = await withTenant(tenantId, (tx) =>
      tx.revocationDispatch.findFirstOrThrow({
        where: { batchId: second.batchId, route: 'requires_change_rule' },
      }),
    );
    expect(row.status).toBe('requires_change');
    expect(row.remediationItemId).toBe(remediation.id);
    // One holding, one open task. Not two.
    expect(
      await withTenant(tenantId, (tx) =>
        tx.remediationItem.count({ where: { kind: 'rule_change_required' } }),
      ),
    ).toBe(1);
  });

  it('calls revokeGrant with the USER the decision was made from', async () => {
    // Integration finding 8: Automate's entry point takes a User id and a
    // reviewer decides as a Person, so re-resolving at dispatch time would pick
    // an arbitrary account.
    await makeFirstItemAGrant();
    const { batchId } = await computeRevocationBatch(tenantId, actorUserId, campaignId, {
      now: NOW,
    });
    await confirmRevocationBatch(tenantId, actorUserId, batchId, { now: NOW, confirmed: true });

    expect(revokeGrantMock).toHaveBeenCalledTimes(1);
    expect(revokeGrantMock).toHaveBeenCalledWith(
      tenantId,
      reviewerUserId,
      expect.any(String),
      expect.stringContaining('Q2 review'),
    );
    // NOT the confirming administrator. The reviewer decided; the administrator
    // only pressed confirm.
    expect(revokeGrantMock.mock.calls[0]![1]).not.toBe(actorUserId);
  });

  it('dispatches with a null actor and SAYS SO when the reviewer holds no account', async () => {
    await makeFirstItemAGrant();
    await withTenant(tenantId, (tx) =>
      // Deactivated, not deleted: `CampaignDecision` is append-only and still
      // names the account. An account that has since been deactivated is not an
      // actor.
      tx.user.updateMany({ where: { id: reviewerUserId }, data: { status: 'inactive' } }),
    );
    const { batchId } = await computeRevocationBatch(tenantId, actorUserId, campaignId, {
      now: NOW,
    });
    await confirmRevocationBatch(tenantId, actorUserId, batchId, { now: NOW, confirmed: true });

    const dispatch = await withTenant(tenantId, (tx) =>
      tx.revocationDispatch.findFirstOrThrow({ where: { route: 'automate_grant' } }),
    );
    // The revocation is not DROPPED because the account is gone.
    expect(dispatch.status).toBe('dispatched');
    expect(dispatch.message).toContain('holds no active Syntra account');
    // It fell back to the confirming administrator rather than to nobody.
    expect(revokeGrantMock.mock.calls[0]![1]).toBe(actorUserId);
  });

  it('records the confirming user, and nothing moves until it is confirmed', async () => {
    const { batchId } = await computeRevocationBatch(tenantId, actorUserId, campaignId, {
      now: NOW,
    });
    const before = await withTenant(tenantId, (tx) =>
      tx.revocationBatch.findUniqueOrThrow({ where: { id: batchId } }),
    );
    // There is no autoApply anywhere: the compute dispatched nothing.
    expect(before.confirmedByUserId).toBeNull();
    expect(await withTenant(tenantId, (tx) => tx.revocationOrder.count())).toBe(0);

    await confirmRevocationBatch(tenantId, actorUserId, batchId, { now: NOW, confirmed: true });
    const batch = await withTenant(tenantId, (tx) =>
      tx.revocationBatch.findUniqueOrThrow({ where: { id: batchId } }),
    );
    expect(batch.confirmedByUserId).toBe(actorUserId);
    expect(batch.status).toBe('applied');
  });

  it('WRITES the population denominator, so the second batch can be refused for a collapse', async () => {
    // C2, the half nobody noticed. `evaluateRevocationGuard` reads
    // `previousPersonsWithActiveContract: settings.personsWithActiveContractAtLastBatch`
    // and `hasEverApplied: settings.lastAppliedBatchAt !== null`, and NOTHING IN
    // THE PLAN WROTE EITHER COLUMN. So the first stayed `null`, the guard's
    // `previousPersonsWithActiveContract !== null && > 0` condition never held,
    // and §13's person-population-collapse refusal — one of the four conditions
    // "no confirmation can fix", whose stated failure is "a truncated HR import
    // makes everybody look like a leaver, and a campaign running over that data
    // revokes the organization" — NEVER FIRED. The guard was present,
    // reachable, read a value nobody wrote, and always passed.
    const { batchId } = await computeRevocationBatch(tenantId, actorUserId, campaignId, {
      now: NOW,
    });
    await confirmRevocationBatch(tenantId, actorUserId, batchId, { now: NOW, confirmed: true });

    const settings = await withTenant(tenantId, (tx) =>
      tx.governSettings.findUniqueOrThrow({ where: { tenantId } }),
    );
    expect(settings.lastAppliedBatchAt).toEqual(NOW);
    expect(settings.personsWithActiveContractAtLastBatch).toBe(2);

    // Now a second batch over a population half the size. The default
    // `personPopulationDropPercent` is 20, so this is REFUSED outright.
    const later = new Date(NOW.getTime() + 3600_000);
    await withTenant(tenantId, async (tx) => {
      await tx.accessSnapshot.update({
        where: { id: snapshotId },
        data: { personsWithActiveContract: 1 },
      });
      // Fresh revoke decisions, so there is something to compute.
      await tx.campaignItem.updateMany({
        where: {
          campaignId,
          status: { in: ['revocation_dispatched', 'revocation_requires_change'] },
        },
        data: { status: 'revoke_decided' },
      });
    });

    const second = await computeRevocationBatch(tenantId, actorUserId, campaignId, { now: later });
    expect(second.status).toBe('blocked');
    expect(second.blockedReason).toMatch(/fewer persons/i);
    await expect(
      confirmRevocationBatch(tenantId, actorUserId, second.batchId, {
        now: later,
        confirmed: true,
      }),
    ).rejects.toMatchObject({ code: 'blocked' });
  });

  it('refuses a batch that requiresConfirmation unless the caller says so explicitly', async () => {
    // Defaulting `confirmed` to true would make the second axis of §13's guard a
    // formality that every caller passes by not thinking about it.
    const computed = await computeRevocationBatch(tenantId, actorUserId, campaignId, { now: NOW });
    expect(computed.requiresConfirmation).toBe(true);
    await expect(
      confirmRevocationBatch(tenantId, actorUserId, computed.batchId, { now: NOW }),
    ).rejects.toMatchObject({ code: 'confirmation_required' });
    // Nothing moved.
    expect(await withTenant(tenantId, (tx) => tx.revocationOrder.count())).toBe(0);

    const result = await confirmRevocationBatch(tenantId, actorUserId, computed.batchId, {
      now: NOW,
      confirmed: true,
    });
    expect(result.dispatched).toBe(1);
  });

  it('RE-READS the guard at execution, not the verdict stored at compute time', async () => {
    // §13 refuses again at execution. A batch computed at 09:00 and confirmed at
    // 17:00 may be a different act; the stored verdict is a report, not a
    // permission.
    const { batchId } = await computeRevocationBatch(tenantId, actorUserId, campaignId, {
      now: NOW,
    });
    await withTenant(tenantId, (tx) =>
      tx.snapshotSource.updateMany({ where: { snapshotId }, data: { staleness: 'stale' } }),
    );
    await expect(
      confirmRevocationBatch(tenantId, actorUserId, batchId, { now: NOW, confirmed: true }),
    ).rejects.toMatchObject({ code: 'blocked' });

    const batch = await withTenant(tenantId, (tx) =>
      tx.revocationBatch.findUniqueOrThrow({ where: { id: batchId } }),
    );
    expect(batch.status).toBe('blocked');
    expect(await withTenant(tenantId, (tx) => tx.revocationOrder.count())).toBe(0);
    expect(revokeGrantMock).not.toHaveBeenCalled();
  });

  it('records a FAILED row and keeps going, rather than abandoning the rest of the batch', async () => {
    // Ruling P11: an error on a destructive path is recorded, never swallowed —
    // and never allowed to abandon the other 339 rows either.
    revokeGrantMock.mockRejectedValue(new Error('the target is unreachable'));
    await makeFirstItemAGrant();
    const { batchId } = await computeRevocationBatch(tenantId, actorUserId, campaignId, {
      now: NOW,
    });
    const result = await confirmRevocationBatch(tenantId, actorUserId, batchId, {
      now: NOW,
      confirmed: true,
    });

    expect(result.failed).toBe(1);
    expect(result.status).toBe('partially_applied');
    const dispatch = await withTenant(tenantId, (tx) =>
      tx.revocationDispatch.findFirstOrThrow({ where: { route: 'automate_grant' } }),
    );
    expect(dispatch.status).toBe('failed');
    expect(dispatch.message).toContain('unreachable');
    const item = await withTenant(tenantId, (tx) =>
      tx.campaignItem.findFirstOrThrow({ where: { resourceId: entitlementIds[0]! } }),
    );
    expect(item.status).toBe('revocation_failed');
    // The OTHER row still got its remediation item.
    expect(result.requiresChange).toBe(1);
  });

  it('records a FAILED row when the grant died between the preview and the confirmation', async () => {
    await makeFirstItemAGrant();
    const { batchId } = await computeRevocationBatch(tenantId, actorUserId, campaignId, {
      now: NOW,
    });
    await withTenant(tenantId, (tx) =>
      tx.accessGrant.updateMany({
        data: { status: 'revoked', endsAt: new Date(NOW.getTime() + 60_000) },
      }),
    );
    const result = await confirmRevocationBatch(tenantId, actorUserId, batchId, {
      now: NOW,
      confirmed: true,
    });

    expect(result.failed).toBe(1);
    // Nothing was called on a dead grant.
    expect(revokeGrantMock).not.toHaveBeenCalled();
    const dispatch = await withTenant(tenantId, (tx) =>
      tx.revocationDispatch.findFirstOrThrow({ where: { route: 'automate_grant' } }),
    );
    expect(dispatch.message).toContain('already ended');
  });

  it('does NOT route a REVOKED grant to Automate', async () => {
    // H22. `status` was selected and never used, so a revoked, expired or
    // handed-back grant still contributed a `grantIds` entry, routed the holding
    // to `automate_grant`, and `revokeGrant` was called on a dead grant — which
    // either errors on the irreversible path or succeeds as a no-op and reports
    // `revocation_dispatched` for a holding nothing removed.
    //
    // The item must carry a GRANT ATTRIBUTION KIND for this to bite. Route 5 is
    // `grantKinds.length > 0 && grantIds.length > 0`, so a `discovered` holding
    // beside a dead grant routes to `revocation_order` whether the status
    // filter is there or not — which is what the first version of this test
    // asserted, and it passed with the filter deleted.
    await makeFirstItemAGrant('revoked');
    const computed = await computeRevocationBatch(tenantId, actorUserId, campaignId, { now: NOW });
    const dispatch = await withTenant(tenantId, (tx) =>
      tx.revocationDispatch.findFirstOrThrow({
        where: { batchId: computed.batchId },
        orderBy: { sequence: 'asc' },
      }),
    );
    expect(dispatch.route).toBe('revocation_order');

    // And nothing is handed to Automate on the irreversible path.
    await confirmRevocationBatch(tenantId, actorUserId, computed.batchId, {
      now: NOW,
      confirmed: true,
    });
    expect(revokeGrantMock).not.toHaveBeenCalled();
  });

  it('routes a DISABLED rule beside a live grant to Automate, not to requires_change', async () => {
    // H6, at the CALLER rather than at the router. `dispatch.test.ts` passes
    // `liveRuleAttribution` in as a literal, so it cannot see how
    // `computeRevocationBatch` computes it — and computing it as "an enabled
    // rule OR any grant kind" routes this holding to `requires_change_rule`,
    // explained as "Provision would grant it back tonight", about a rule that
    // is switched off. The grant, the only live cause, is never revoked, and a
    // `rule_change_required` item is filed against a rule nobody can change
    // because it is already off.
    //
    // The mover shape: the birthright rule was turned off when the person
    // changed job, and the requested grant is what remains.
    await withTenant(tenantId, async (tx) => {
      await tx.campaignItem.updateMany({
        where: { resourceId: entitlementIds[0]! },
        data: {
          attributions: [
            { kind: 'business_rule', detail: { ruleName: 'Finance staff', ruleEnabled: false } },
            { kind: 'request', detail: {} },
          ] as never,
        },
      });
      await tx.accessGrant.create({
        data: {
          tenantId,
          subjectPersonId,
          resourceType: 'entitlement',
          resourceId: entitlementIds[0]!,
          targetSystemId,
          origin: 'request',
          startsAt: NOW,
          status: 'active',
        },
      });
    });
    const computed = await computeRevocationBatch(tenantId, actorUserId, campaignId, { now: NOW });
    const dispatch = await withTenant(tenantId, (tx) =>
      tx.revocationDispatch.findFirstOrThrow({
        where: { batchId: computed.batchId },
        orderBy: { sequence: 'asc' },
      }),
    );
    expect(dispatch.route).toBe('automate_grant');

    // And the grant is what actually gets ended.
    await confirmRevocationBatch(tenantId, actorUserId, computed.batchId, {
      now: NOW,
      confirmed: true,
    });
    expect(revokeGrantMock).toHaveBeenCalledTimes(1);
  });

  it('honours a per-row skip', async () => {
    const { batchId } = await computeRevocationBatch(tenantId, actorUserId, campaignId, {
      now: NOW,
    });
    const dispatch = await withTenant(tenantId, (tx) =>
      tx.revocationDispatch.findFirstOrThrow({ where: { route: 'revocation_order' } }),
    );
    await skipDispatch(tenantId, actorUserId, dispatch.id, 'I meant Anna’s, not the whole group');
    const result = await confirmRevocationBatch(tenantId, actorUserId, batchId, {
      now: NOW,
      confirmed: true,
    });
    expect(result.dispatched).toBe(0);
    const after = await withTenant(tenantId, (tx) =>
      tx.revocationDispatch.findUniqueOrThrow({ where: { id: dispatch.id } }),
    );
    expect(after).toMatchObject({ status: 'skipped' });
    expect(after.message).toContain('not the whole group');
    // A skip is a DECISION, and confirming the batch does not undo it.
    expect(await withTenant(tenantId, (tx) => tx.revocationOrder.count())).toBe(0);
  });
});

describe('the RevocationOrder’s constraints', () => {
  it('is REFUSED at creation when a live attribution appears between preview and confirm', async () => {
    // If a rule wants it, the honest answer is to change the rule, and that is
    // the remediation item, not the order. `liveAttribution` is derived at
    // DISPATCH time for exactly this case.
    const { batchId } = await computeRevocationBatch(tenantId, actorUserId, campaignId, {
      now: NOW,
    });
    await withTenant(tenantId, (tx) =>
      tx.campaignItem.updateMany({
        where: { resourceId: entitlementIds[0]! },
        data: {
          attributions: [{ kind: 'business_rule', detail: { ruleEnabled: true } }] as never,
        },
      }),
    );
    const result = await confirmRevocationBatch(tenantId, actorUserId, batchId, {
      now: NOW,
      confirmed: true,
    });

    expect(result.failed).toBe(1);
    expect(await withTenant(tenantId, (tx) => tx.revocationOrder.count())).toBe(0);
    const dispatch = await withTenant(tenantId, (tx) =>
      tx.revocationDispatch.findFirstOrThrow({ where: { route: 'revocation_order' } }),
    );
    expect(dispatch.message).toContain('a rule or a live grant still wants');
  });

  it('CANCELS an existing open order for the same holding rather than colliding', async () => {
    const { batchId } = await computeRevocationBatch(tenantId, actorUserId, campaignId, {
      now: NOW,
    });
    await confirmRevocationBatch(tenantId, actorUserId, batchId, { now: NOW, confirmed: true });

    await withTenant(tenantId, (tx) =>
      tx.campaignItem.updateMany({
        where: { resourceId: entitlementIds[0]! },
        data: { status: 'revoke_decided' },
      }),
    );
    const second = await computeRevocationBatch(tenantId, actorUserId, campaignId, { now: NOW });
    await confirmRevocationBatch(tenantId, actorUserId, second.batchId, {
      now: NOW,
      confirmed: true,
    });

    const orders = await withTenant(tenantId, (tx) =>
      tx.revocationOrder.findMany({ orderBy: { createdAt: 'asc' } }),
    );
    expect(orders).toHaveLength(2);
    expect(orders[0]).toMatchObject({ status: 'cancelled' });
    expect(orders[0]!.cancelledReason).toContain('superseded');
    expect(orders[1]!.status).toBe('open');
  });

  it('hands Provision the open order as PLAIN VALUES, with its provenance', async () => {
    const { batchId } = await computeRevocationBatch(tenantId, actorUserId, campaignId, {
      now: NOW,
    });
    await confirmRevocationBatch(tenantId, actorUserId, batchId, { now: NOW, confirmed: true });

    const orders = await withTenant(tenantId, (tx) => loadRevocationOrders(tx, targetSystemId));
    expect(orders).toHaveLength(1);
    // Ruling G1's condition: Provision's audit event names a human WITHOUT
    // Provision ever querying Govern, so the provenance travels denormalised.
    expect(orders[0]).toMatchObject({
      entitlementId: entitlementIds[0]!,
      decidedByPersonName: 'Jan Manager',
      campaignName: 'Q2 review',
    });
    expect(orders[0]!.campaignDecisionId).not.toBeNull();
    expect(orders[0]!.reason).toContain('not needed');

    // A PLANNED order is not handed over again: it is a one-shot term, and a
    // plan stage that re-proposed it every night would revoke by inference.
    await withTenant(tenantId, (tx) =>
      tx.revocationOrder.updateMany({ data: { status: 'planned', plannedAt: NOW } }),
    );
    expect(
      await withTenant(tenantId, (tx) => loadRevocationOrders(tx, targetSystemId)),
    ).toHaveLength(0);
  });
});

describe('reflectRevocationOutcomes — the vocabulary rule', () => {
  /** A later snapshot in which the subject holds nothing. */
  async function emptySnapshot(): Promise<string> {
    return withTenant(tenantId, async (tx) => {
      const s = await tx.accessSnapshot.create({
        data: {
          tenantId,
          kind: 'scheduled',
          status: 'complete',
          asOf: new Date(NOW.getTime() + 86_400_000),
        },
      });
      await tx.snapshotSource.create({
        data: {
          tenantId,
          snapshotId: s.id,
          sourceKind: 'syntraInternal',
          sourceId: 'syntra',
          sourceName: 'Syntra',
          completeness: 'complete',
          staleness: 'fresh',
          freshnessSlaHours: 24,
        },
      });
      return s.id;
    });
  }

  /** Computes and confirms the batch, leaving one row `dispatched`. */
  async function dispatchAndConfirm(): Promise<void> {
    const { batchId } = await computeRevocationBatch(tenantId, actorUserId, campaignId, {
      now: NOW,
    });
    await confirmRevocationBatch(tenantId, actorUserId, batchId, { now: NOW, confirmed: true });
  }

  it('advances to `applied` only when confirmed AND observed gone', async () => {
    await dispatchAndConfirm();
    await withTenant(tenantId, (tx) =>
      tx.revocationDispatch.updateMany({
        where: { status: 'dispatched' },
        data: { status: 'confirmed', confirmedAt: NOW },
      }),
    );

    const later = await emptySnapshot();
    const result = await reflectRevocationOutcomes(tenantId, later, { now: NOW });
    expect(result.applied).toBe(1);
    const item = await withTenant(tenantId, (tx) =>
      tx.campaignItem.findFirstOrThrow({ where: { resourceId: entitlementIds[0]! } }),
    );
    expect(item.status).toBe('revocation_applied');
  });

  it('advances `dispatched` to `confirmed` only once the owning subsystem reports it applied', async () => {
    // Govern reads PROVISION's outcome rather than believing its own dispatch.
    await dispatchAndConfirm();
    const order = await withTenant(tenantId, (tx) => tx.revocationOrder.findFirstOrThrow());
    const later = await emptySnapshot();

    // Nothing has applied it yet, so it does not advance and no snapshot
    // observation can promote it either.
    expect(await reflectRevocationOutcomes(tenantId, later, { now: NOW })).toMatchObject({
      confirmed: 0,
      applied: 0,
    });

    await withTenant(tenantId, async (tx) => {
      const run = await tx.provisionRun.create({
        data: { tenantId, targetSystemId, status: 'succeeded' },
      });
      await tx.provisionAction.create({
        data: {
          tenantId,
          runId: run.id,
          actionType: 'revoke_entitlement',
          personId: subjectPersonId,
          entitlementId: entitlementIds[0]!,
          status: 'applied',
          revocationOrderId: order.id,
        },
      });
    });
    expect(await reflectRevocationOutcomes(tenantId, later, { now: NOW })).toMatchObject({
      confirmed: 1,
    });
  });

  it('DOES NOT advance, and raises dispatch_not_applied, when the holding is still there', async () => {
    await dispatchAndConfirm();
    await withTenant(tenantId, (tx) =>
      tx.revocationDispatch.updateMany({
        where: { status: 'dispatched' },
        data: { status: 'confirmed', confirmedAt: NOW },
      }),
    );

    // The same snapshot: the holding is still there.
    const result = await reflectRevocationOutcomes(tenantId, snapshotId, { now: NOW });
    expect(result).toMatchObject({ applied: 0, notApplied: 1 });
    const finding = await withTenant(tenantId, (tx) =>
      tx.governFinding.findFirstOrThrow({ where: { kind: 'dispatch_not_applied' } }),
    );
    expect((finding.detail as { statement?: string }).statement).toContain(
      'still shows the holding',
    );
    const item = await withTenant(tenantId, (tx) =>
      tx.campaignItem.findFirstOrThrow({ where: { resourceId: entitlementIds[0]! } }),
    );
    expect(item.status).toBe('revocation_confirmed');
  });

  it('raises the SLA finding for a dispatch older than dispatchSlaHours', async () => {
    await dispatchAndConfirm();
    const result = await reflectRevocationOutcomes(tenantId, snapshotId, {
      now: new Date(NOW.getTime() + 100 * 3_600_000),
    });
    expect(result.slaBreaches).toBe(1);
    const finding = await withTenant(tenantId, (tx) =>
      tx.governFinding.findFirstOrThrow({ where: { kind: 'dispatch_not_applied' } }),
    );
    expect((finding.detail as { ageHours?: number }).ageHours).toBe(100);
  });

  it('raises NO SLA finding inside the SLA', async () => {
    // The default is 72 hours. An alert that fired at 70 would be an alert that
    // trains people to ignore alerts.
    await dispatchAndConfirm();
    const result = await reflectRevocationOutcomes(tenantId, snapshotId, {
      now: new Date(NOW.getTime() + 70 * 3_600_000),
    });
    expect(result.slaBreaches).toBe(0);
  });

  it('raises NO SLA finding for a CANCELLED dispatch — the composition hazard', async () => {
    // Two individually correct rules: an order cancelled as overtaken, and a
    // finding when a dispatch is not confirmed in time. Composed naively they
    // produce a finding saying a revocation was not applied, about a revocation
    // that was correctly abandoned.
    await dispatchAndConfirm();
    await withTenant(tenantId, (tx) =>
      tx.revocationDispatch.updateMany({
        where: { status: 'dispatched' },
        data: { status: 'cancelled', message: 'overtaken: the holding acquired a request grant' },
      }),
    );
    const result = await reflectRevocationOutcomes(tenantId, snapshotId, {
      now: new Date(NOW.getTime() + 100 * 3_600_000),
    });
    expect(result.slaBreaches).toBe(0);
    expect(
      await withTenant(tenantId, (tx) =>
        tx.governFinding.count({ where: { kind: 'dispatch_not_applied' } }),
      ),
    ).toBe(0);
  });
});
