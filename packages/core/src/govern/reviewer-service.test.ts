import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import {
  automateResourceType,
  closeDueCampaigns,
  mootDepartedSubjects,
  mootVanishedHoldings,
  previewReviewerResolution,
  reassignInvalidReviewers,
  resolveItemReviewers,
  runCampaignReminders,
} from './reviewer-service.js';

const NOW = new Date('2026-06-15T09:00:00Z');
const DUE = new Date('2026-07-15T09:00:00Z');
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

let tenantId: string;
let campaignId: string;
let snapshotId: string;
const person: Record<string, string> = {};
const user: Record<string, string> = {};

async function seedPerson(
  name: string,
  options: { manager?: string; contractEnd?: Date | null; userStatus?: string } = {},
) {
  await withTenant(tenantId, async (tx) => {
    const p = await tx.person.create({
      data: { tenantId, givenName: name, familyName: 'Test' },
    });
    await tx.contract.create({
      data: {
        tenantId,
        personId: p.id,
        sequence: 1,
        isPrimary: true,
        startDate: day('2020-01-01'),
        endDate: options.contractEnd ?? null,
        ...(options.manager === undefined
          ? {}
          : { managerPersonId: person[options.manager]! }),
      },
    });
    const u = await tx.user.create({
      data: {
        tenantId,
        login: name.toLowerCase(),
        email: `${name.toLowerCase()}@a.test`,
        displayName: `${name} Test`,
        personId: p.id,
        status: options.userStatus ?? 'active',
      },
    });
    person[name] = p.id;
    user[name] = u.id;
  });
}

let resourceSequence = 0;

async function seedItem(subject: string, over: Record<string, unknown> = {}) {
  resourceSequence += 1;
  return withTenant(tenantId, async (tx) => {
    const item = await tx.campaignItem.create({
      data: {
        tenantId,
        campaignId,
        holdingSnapshotId: snapshotId,
        subjectKey: `person:${person[subject]!}`,
        personId: person[subject]!,
        systemId: 'sys-1',
        resourceKind: 'targetEntitlement',
        resourceId: `ent-${resourceSequence}`,
        resourceName: 'Finance-Payments',
        attributions: [],
        observedAt: NOW,
        coverageStatus: 'complete',
        ...over,
      },
    });
    return item.id;
  });
}

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  resourceSequence = 0;
  for (const key of Object.keys(person)) delete person[key];
  for (const key of Object.keys(user)) delete user[key];

  await seedPerson('Jan');
  await seedPerson('Ola');
  await seedPerson('Anna', { manager: 'Jan' });
  await seedPerson('Bram', { manager: 'Ola' });

  const seeded = await withTenant(tenantId, async (tx) => {
    const snapshot = await tx.accessSnapshot.create({
      data: { tenantId, kind: 'manual', status: 'complete', asOf: NOW },
    });
    await tx.snapshotSource.create({
      data: {
        tenantId,
        snapshotId: snapshot.id,
        sourceKind: 'syntraInternal',
        sourceId: 'syntra',
        sourceName: 'Syntra',
        completeness: 'complete',
        staleness: 'fresh',
        freshnessSlaHours: 24,
      },
    });
    const campaign = await tx.campaign.create({
      data: {
        tenantId,
        name: 'Q2 review',
        scope: { resourceKinds: ['targetEntitlement'] },
        snapshotId: snapshot.id,
        reviewerSelector: 'manager',
        reviewerConfig: {},
        fallbackSelector: 'person',
        fallbackConfig: { personId: person['Ola'] },
        ownerPersonId: person['Ola']!,
        opensAt: NOW,
        dueAt: DUE,
        originalDueAt: DUE,
        status: 'open',
      },
    });
    return { snapshotId: snapshot.id, campaignId: campaign.id };
  });
  snapshotId = seeded.snapshotId;
  campaignId = seeded.campaignId;
});

describe('resolution', () => {
  it('resolves the subject’s manager and records the assignment with its via', async () => {
    const itemId = await seedItem('Anna');
    const outcome = await withTenant(tenantId, (tx) =>
      resolveItemReviewers(tx, campaignId, [itemId], NOW),
    );

    expect(outcome.assignedByPerson.get(person['Jan']!)).toBe(1);
    const reviewers = await withTenant(tenantId, (tx) => tx.campaignItemReviewer.findMany());
    expect(reviewers[0]).toMatchObject({
      personId: person['Jan'],
      via: 'selector',
      unassignedAt: null,
    });
  });

  it('DROPS the reviewer who is also the subject, and falls to the fallback', async () => {
    // The new path here: the resource owner who holds the resource. Dropping
    // them from their own item while leaving them the other 300 is correct.
    const itemId = await seedItem('Jan');
    await withTenant(tenantId, (tx) =>
      tx.campaign.update({
        where: { id: campaignId },
        data: { reviewerSelector: 'person', reviewerConfig: { personId: person['Jan'] } },
      }),
    );
    await withTenant(tenantId, (tx) => resolveItemReviewers(tx, campaignId, [itemId], NOW));

    const reviewers = await withTenant(tenantId, (tx) => tx.campaignItemReviewer.findMany());
    expect(reviewers.map((r) => r.personId)).not.toContain(person['Jan']);
    expect(reviewers[0]).toMatchObject({ personId: person['Ola'], via: 'fallback' });
  });

  it('BLOCKS when the fallback is also the subject, rather than deciding anything', async () => {
    const itemId = await seedItem('Ola');
    await withTenant(tenantId, (tx) =>
      tx.campaign.update({
        where: { id: campaignId },
        data: { reviewerSelector: 'person', reviewerConfig: { personId: person['Ola'] } },
      }),
    );
    const outcome = await withTenant(tenantId, (tx) =>
      resolveItemReviewers(tx, campaignId, [itemId], NOW),
    );

    expect(outcome.blocked).toBe(1);
    const item = await withTenant(tenantId, (tx) =>
      tx.campaignItem.findUniqueOrThrow({ where: { id: itemId } }),
    );
    expect(item.status).toBe('blocked_no_reviewer');
    expect(item.statusReason).toContain('would be attesting to their own access');
  });

  it('an unattributed account resolves to the named fallback, or blocks — never to a sentinel', async () => {
    // A zero-UUID `subjectPersonId` is a sentinel a `person` selector
    // configured with that value would silently match, and it is a manager
    // query against a person who does not exist.
    const itemId = await withTenant(tenantId, async (tx) => {
      const item = await tx.campaignItem.create({
        data: {
          tenantId,
          campaignId,
          holdingSnapshotId: snapshotId,
          subjectKey: 'account:sys-1:anchor-9',
          personId: null,
          accountRef: 'anchor-9',
          systemId: 'sys-1',
          resourceKind: 'targetAccount',
          resourceId: 'anchor-9',
          resourceName: 'anchor-9 (active)',
          attributions: [],
          observedAt: NOW,
          coverageStatus: 'complete',
        },
      });
      return item.id;
    });

    // The campaign's fallback IS a named person, so it resolves to them.
    const resolved = await withTenant(tenantId, (tx) =>
      resolveItemReviewers(tx, campaignId, [itemId], NOW),
    );
    expect(resolved.blocked).toBe(0);
    expect([...resolved.assignedByPerson.keys()]).toEqual([person['Ola']]);

    // With a fallback that is not a named person, it BLOCKS and says why.
    await withTenant(tenantId, async (tx) => {
      await tx.campaignItemReviewer.deleteMany({ where: { itemId } });
      await tx.campaignItem.update({ where: { id: itemId }, data: { status: 'pending' } });
      await tx.campaign.update({
        where: { id: campaignId },
        data: { fallbackSelector: 'manager', fallbackConfig: {} },
      });
    });
    const blocked = await withTenant(tenantId, (tx) =>
      resolveItemReviewers(tx, campaignId, [itemId], NOW),
    );
    expect(blocked.blocked).toBe(1);
    const item = await withTenant(tenantId, (tx) =>
      tx.campaignItem.findUniqueOrThrow({ where: { id: itemId } }),
    );
    expect(item.statusReason).toContain('belongs to nobody');
  });

  it('notifies the campaign owner and govern.manage about a blocked item', async () => {
    const itemId = await seedItem('Ola');
    await withTenant(tenantId, (tx) =>
      tx.campaign.update({
        where: { id: campaignId },
        data: { reviewerSelector: 'person', reviewerConfig: { personId: person['Ola'] } },
      }),
    );
    await withTenant(tenantId, (tx) => resolveItemReviewers(tx, campaignId, [itemId], NOW));
    const outbox = await withTenant(tenantId, (tx) =>
      tx.notificationOutbox.findMany({ where: { template: 'govern-campaign-blocked-item' } }),
    );
    expect(outbox.length).toBeGreaterThan(0);
  });

  it('maps only the three kinds Automate has a resource type for', () => {
    // `ResourceOwner` is keyed on `'entitlement' | 'application' | 'group'`.
    // Mapping `syntraRole`, `syntraUser` and `targetAccount` onto
    // `'entitlement'` makes a `resourceOwner` selector look up an entitlement
    // id that is not one, find nothing, and fall through with no explanation.
    expect(automateResourceType('targetEntitlement')).toBe('entitlement');
    expect(automateResourceType('application')).toBe('application');
    expect(automateResourceType('syntraGroup')).toBe('group');
    for (const kind of ['syntraRole', 'syntraUser', 'targetAccount']) {
      expect(automateResourceType(kind), `${kind} has no Automate resource type`).toBeNull();
    }
  });
});

describe('the reviewer who leaves mid-campaign', () => {
  it('reassigns their open items by re-resolving as of now, and records the window', async () => {
    const itemId = await seedItem('Anna');
    await withTenant(tenantId, (tx) => resolveItemReviewers(tx, campaignId, [itemId], NOW));

    // Jan leaves. Anna's manager becomes Ola.
    await withTenant(tenantId, async (tx) => {
      await tx.user.updateMany({
        where: { personId: person['Jan']! },
        data: { status: 'inactive' },
      });
      await tx.contract.updateMany({
        where: { personId: person['Anna']! },
        data: { managerPersonId: person['Ola']! },
      });
    });

    const result = await reassignInvalidReviewers(tenantId, campaignId, { now: NOW });
    expect(result.reassigned).toBe(1);

    const reviewers = await withTenant(tenantId, (tx) =>
      tx.campaignItemReviewer.findMany({ orderBy: { assignedAt: 'asc' } }),
    );
    // "Who was this with, on the Tuesday it was sitting there" stays
    // answerable a year later.
    expect(reviewers[0]).toMatchObject({ personId: person['Jan'], via: 'selector' });
    expect(reviewers[0]!.unassignedAt).not.toBeNull();
    expect(reviewers[0]!.unassignedReason).toContain('no longer valid');
    expect(reviewers[1]).toMatchObject({
      personId: person['Ola'],
      via: 'reassignment',
      unassignedAt: null,
    });
  });

  it('leaves DECIDED items alone — a decision made while valid stands', async () => {
    // Retroactively invalidating a decision because the decider later left is
    // how a campaign becomes unfinishable.
    const itemId = await seedItem('Anna');
    await withTenant(tenantId, (tx) => resolveItemReviewers(tx, campaignId, [itemId], NOW));
    await withTenant(tenantId, async (tx) => {
      await tx.campaignDecision.create({
        data: {
          tenantId,
          itemId,
          personId: person['Jan']!,
          decision: 'certify',
          itemOpenedAt: NOW,
          decidedAt: NOW,
          sessionDecisionOrdinal: 1,
          coverageAtDecision: {},
        },
      });
      await tx.campaignItem.update({ where: { id: itemId }, data: { status: 'certified' } });
      await tx.user.updateMany({
        where: { personId: person['Jan']! },
        data: { status: 'inactive' },
      });
    });

    const result = await reassignInvalidReviewers(tenantId, campaignId, { now: NOW });
    expect(result.reassigned).toBe(0);
    const item = await withTenant(tenantId, (tx) =>
      tx.campaignItem.findUniqueOrThrow({ where: { id: itemId } }),
    );
    expect(item.status).toBe('certified');
  });

  it('returns a reassigned item to pending', async () => {
    // Leaving a successfully-reassigned item on `blocked_no_reviewer` keeps it
    // on the blocked dashboard forever, and would force the decision service to
    // permit a `blocked_no_reviewer -> certified` transition that
    // `CERTIFYING_TRANSITIONS = [{ from: 'pending' }]` says does not exist.
    const itemId = await seedItem('Anna');
    await withTenant(tenantId, (tx) => resolveItemReviewers(tx, campaignId, [itemId], NOW));
    await withTenant(tenantId, async (tx) => {
      await tx.campaignItem.update({
        where: { id: itemId },
        data: { status: 'blocked_no_reviewer' },
      });
      await tx.user.updateMany({
        where: { personId: person['Jan']! },
        data: { status: 'inactive' },
      });
      await tx.contract.updateMany({
        where: { personId: person['Anna']! },
        data: { managerPersonId: person['Ola']! },
      });
    });

    const result = await reassignInvalidReviewers(tenantId, campaignId, { now: NOW });
    expect(result.reassigned).toBe(1);
    const item = await withTenant(tenantId, (tx) =>
      tx.campaignItem.findUniqueOrThrow({ where: { id: itemId } }),
    );
    expect(item.status).toBe('pending');
  });

  it('BLOCKS when re-resolution yields nobody valid, and never auto-decides', async () => {
    const itemId = await seedItem('Anna');
    await withTenant(tenantId, (tx) => resolveItemReviewers(tx, campaignId, [itemId], NOW));
    await withTenant(tenantId, async (tx) => {
      await tx.user.updateMany({
        where: { personId: { in: [person['Jan']!, person['Ola']!] } },
        data: { status: 'inactive' },
      });
      await tx.contract.updateMany({
        where: { personId: person['Anna']! },
        data: { managerPersonId: null },
      });
    });

    const result = await reassignInvalidReviewers(tenantId, campaignId, { now: NOW });
    expect(result.blocked).toBe(1);
    const item = await withTenant(tenantId, (tx) =>
      tx.campaignItem.findUniqueOrThrow({ where: { id: itemId } }),
    );
    expect(item.status).toBe('blocked_no_reviewer');
  });

  it('tells BOTH the outgoing and the incoming reviewer', async () => {
    const itemId = await seedItem('Anna');
    await withTenant(tenantId, (tx) => resolveItemReviewers(tx, campaignId, [itemId], NOW));
    await withTenant(tenantId, async (tx) => {
      await tx.contract.updateMany({
        where: { personId: person['Anna']! },
        data: { managerPersonId: person['Ola']! },
      });
      await tx.user.updateMany({
        where: { personId: person['Jan']! },
        data: { status: 'inactive' },
      });
    });
    await reassignInvalidReviewers(tenantId, campaignId, { now: NOW });

    const outbox = await withTenant(tenantId, (tx) => tx.notificationOutbox.findMany());
    // The outgoing one where they can still be reached; the incoming one always.
    expect(outbox.map((o) => o.template)).toContain('govern-review-reassigned');
  });
});

describe('moot, which is not a bucket to hide things in', () => {
  it('moots a PENDING item whose subject departed, and records the date', async () => {
    const itemId = await seedItem('Anna');
    await withTenant(tenantId, (tx) => resolveItemReviewers(tx, campaignId, [itemId], NOW));
    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({
        where: { personId: person['Anna']! },
        data: { endDate: day('2026-06-01') },
      }),
    );

    const result = await mootDepartedSubjects(tenantId, campaignId, { now: NOW });
    expect(result.mooted).toBe(1);
    const item = await withTenant(tenantId, (tx) =>
      tx.campaignItem.findUniqueOrThrow({ where: { id: itemId } }),
    );
    expect(item.status).toBe('moot');
    expect(item.statusReason).toContain('2026-06-01');
  });

  it('DOES NOT moot an item already carrying a revoke decision — the composition hazard', async () => {
    // Two individually correct rules: "a departed subject's item is moot" and
    // "a decision stands". Composed naively they mean a leaver's holding is
    // mooted, the decision never dispatches, and the campaign reports it
    // handled. A leaver's access must still be removable.
    const itemId = await seedItem('Anna');
    await withTenant(tenantId, async (tx) => {
      await tx.campaignItem.update({ where: { id: itemId }, data: { status: 'revoke_decided' } });
      await tx.contract.updateMany({
        where: { personId: person['Anna']! },
        data: { endDate: day('2026-06-01') },
      });
    });

    const result = await mootDepartedSubjects(tenantId, campaignId, { now: NOW });
    expect(result).toEqual({ mooted: 0, preserved: 1 });
    const item = await withTenant(tenantId, (tx) =>
      tx.campaignItem.findUniqueOrThrow({ where: { id: itemId } }),
    );
    expect(item.status).toBe('revoke_decided');
  });

  it('moots an item whose holding no longer exists, VERIFIED against the current snapshot', async () => {
    // Verified, not inferred from a revocation somebody else dispatched.
    const itemId = await seedItem('Anna');
    const later = await withTenant(tenantId, async (tx) => {
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

    const result = await mootVanishedHoldings(tenantId, campaignId, later, { now: NOW });
    expect(result.mooted).toBe(1);
    const item = await withTenant(tenantId, (tx) =>
      tx.campaignItem.findUniqueOrThrow({ where: { id: itemId } }),
    );
    expect(item.statusReason).toContain(later);
  });
});

describe('the reviewer who does nothing', () => {
  it('reminds at 50% of the time to due, then daily, and never more than once a day', async () => {
    const itemId = await seedItem('Anna');
    await withTenant(tenantId, (tx) => resolveItemReviewers(tx, campaignId, [itemId], NOW));

    const halfway = new Date(NOW.getTime() + (DUE.getTime() - NOW.getTime()) / 2 + 60_000);
    const first = await runCampaignReminders(tenantId, { now: halfway });
    expect(first.reminded).toBe(1);
    const again = await runCampaignReminders(tenantId, {
      now: new Date(halfway.getTime() + 3600_000),
    });
    expect(again.reminded).toBe(0);
    const tomorrow = await runCampaignReminders(tenantId, {
      now: new Date(halfway.getTime() + 86_400_000 + 60_000),
    });
    expect(tomorrow.reminded).toBe(1);
  });

  it('escalates to the reviewer’s manager, ADDS them, and tells the original', async () => {
    // Escalation that silently removes somebody's authority is how a person
    // discovers months later that decisions attributed to them were not theirs.
    await seedPerson('Chief');
    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({
        where: { personId: person['Jan']! },
        data: { managerPersonId: person['Chief']! },
      }),
    );
    const itemId = await seedItem('Anna');
    await withTenant(tenantId, (tx) => resolveItemReviewers(tx, campaignId, [itemId], NOW));

    const result = await runCampaignReminders(tenantId, {
      now: new Date(DUE.getTime() - 60_000),
    });
    expect(result.escalated).toBe(1);

    const reviewers = await withTenant(tenantId, (tx) =>
      tx.campaignItemReviewer.findMany({ where: { unassignedAt: null } }),
    );
    expect(reviewers.map((r) => r.personId).sort()).toEqual(
      [person['Jan'], person['Chief']].sort(),
    );
    const outbox = await withTenant(tenantId, (tx) => tx.notificationOutbox.findMany());
    expect(outbox.map((o) => o.template)).toContain('govern-review-escalated');
  });

  it('reminds EVERY reviewer of a campaign in one run, not just the first', async () => {
    // A de-duplication that asks NotificationOutbox for any reminder naming
    // this campaign in the last 24 hours and narrows it by nothing else
    // reminds the first reviewer in the iteration and skips every other
    // reviewer of the same campaign — forever, because tomorrow the same
    // reviewer is first again. A campaign with 200 reviewers reminds one.
    await seedPerson('Kees');
    const first = await seedItem('Anna');
    const second = await seedItem('Bram');
    await withTenant(tenantId, async (tx) => {
      await resolveItemReviewers(tx, campaignId, [first, second], NOW);
      // Two different reviewers, one campaign.
      await tx.campaignItemReviewer.updateMany({
        where: { itemId: second },
        data: { personId: person['Kees']! },
      });
    });

    const halfway = new Date(NOW.getTime() + (DUE.getTime() - NOW.getTime()) / 2 + 60_000);
    const result = await runCampaignReminders(tenantId, { now: halfway });
    expect(result.reminded).toBe(2);

    const reviewers = await withTenant(tenantId, (tx) =>
      tx.campaignItemReviewer.findMany({ where: { lastRemindedAt: { not: null } } }),
    );
    expect(new Set(reviewers.map((r) => r.personId)).size).toBe(2);
  });

  it('escalates to EACH reviewer’s OWN manager, not to an arbitrary item subject’s manager', async () => {
    // Resolving the manager of the campaign's FIRST PENDING ITEM'S SUBJECT and
    // adding them as a reviewer on all of a silent reviewer's items grants
    // review authority — which §21 says comes from resolution and from nothing
    // else — to somebody with no relationship to those items. It is also
    // self-review-adjacent: if that arbitrary subject's manager is themselves
    // the subject of one of the escalated items, they now review their own
    // access.
    await seedPerson('ChiefOne');
    await seedPerson('ChiefTwo');
    await seedPerson('Kees', { manager: 'ChiefTwo' });
    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({
        where: { personId: person['Jan']! },
        data: { managerPersonId: person['ChiefOne']! },
      }),
    );

    const first = await seedItem('Anna');
    const second = await seedItem('Bram');
    await withTenant(tenantId, async (tx) => {
      await resolveItemReviewers(tx, campaignId, [first, second], NOW);
      await tx.campaignItemReviewer.updateMany({
        where: { itemId: second },
        data: { personId: person['Kees']! },
      });
    });

    await runCampaignReminders(tenantId, { now: new Date(DUE.getTime() - 60_000) });

    const byItem = await withTenant(tenantId, (tx) =>
      tx.campaignItemReviewer.findMany({ where: { via: 'escalation' } }),
    );
    const onFirst = byItem.filter((r) => r.itemId === first).map((r) => r.personId);
    const onSecond = byItem.filter((r) => r.itemId === second).map((r) => r.personId);
    expect(onFirst).toEqual([person['ChiefOne']]);
    expect(onSecond).toEqual([person['ChiefTwo']]);
  });

  it('escalation CREATES the reviewer row rather than upserting on a synthesised id', async () => {
    // An `upsert` on `id: `${itemId}:${personId}`` is not a uuid, so the query
    // errors before `create` is reached — and a query error inside a Prisma
    // interactive transaction leaves the Postgres transaction ABORTED, so a
    // `.catch(() => undefined)` does not rescue the one escalation; every
    // subsequent statement fails with "current transaction is aborted" and the
    // whole reminder run dies silently.
    await seedPerson('Chief');
    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({
        where: { personId: person['Jan']! },
        data: { managerPersonId: person['Chief']! },
      }),
    );
    const itemId = await seedItem('Anna');
    await withTenant(tenantId, (tx) => resolveItemReviewers(tx, campaignId, [itemId], NOW));

    const result = await runCampaignReminders(tenantId, {
      now: new Date(DUE.getTime() - 60_000),
    });
    expect(result).toMatchObject({ reminded: 1, escalated: 1 });

    // Running it again the next day must not duplicate the escalation reviewer.
    const tomorrow = new Date(DUE.getTime() + 86_400_000);
    await runCampaignReminders(tenantId, { now: tomorrow });
    const rows = await withTenant(tenantId, (tx) =>
      tx.campaignItemReviewer.findMany({
        where: { itemId, personId: person['Chief']!, unassignedAt: null },
      }),
    );
    expect(rows).toHaveLength(1);
  });

  it('does NOT remind a reviewer who has left', async () => {
    // A reminder in a leaver's mailbox is a campaign asking somebody who no
    // longer works there to certify somebody else's access.
    const itemId = await seedItem('Anna');
    await withTenant(tenantId, (tx) => resolveItemReviewers(tx, campaignId, [itemId], NOW));
    await withTenant(tenantId, (tx) =>
      tx.user.updateMany({
        where: { personId: person['Jan']! },
        data: { status: 'inactive' },
      }),
    );
    const halfway = new Date(NOW.getTime() + (DUE.getTime() - NOW.getTime()) / 2 + 60_000);
    const result = await runCampaignReminders(tenantId, { now: halfway });
    expect(result.reminded).toBe(0);
  });
});

describe('previewReviewerResolution', () => {
  const seedHoldings = () =>
    withTenant(tenantId, async (tx) => {
      for (const [subject, resourceId] of [
        ['Anna', 'ent-1'],
        ['Ola', 'ent-2'],
      ] as const) {
        await tx.holding.create({
          data: {
            tenantId,
            snapshotId,
            subjectKey: `person:${person[subject]!}`,
            personId: person[subject]!,
            systemKind: 'targetSystem',
            systemId: 'sys-1',
            resourceKind: 'targetEntitlement',
            resourceId,
            resourceName: 'Finance-Payments',
            observedAt: NOW,
            observedVia: 'test',
            firstSeenAt: NOW,
          },
        });
      }
    });

  it('says how many resolve, how many fall to the fallback and NAMES the ones that resolve to nobody', async () => {
    // §20's screen: the one that catches an unreviewable campaign before 200
    // people are emailed rather than at 3am on the due date.
    await seedHoldings();

    const preview = await previewReviewerResolution(tenantId, {
      scope: { resourceKinds: ['targetEntitlement'] },
      reviewerSelector: 'manager',
      reviewerConfig: {},
      // A fallback that is the subject of the second holding, so it blocks.
      fallbackSelector: 'person',
      fallbackConfig: { personId: person['Ola'] },
      snapshotId,
    });

    // Anna resolves to Jan; Ola's own item resolves to nobody, because the
    // manager selector and the fallback both land on Ola herself.
    expect(preview.resolved).toBe(1);
    expect(preview.blocked).toBe(1);
    expect(preview.blockedSample[0]!.resourceName).toBe('Finance-Payments');
  });

  it('writes NO CampaignItem and NO CampaignItemReviewer row', async () => {
    // The whole point of a preview. It runs against a campaign that is still a
    // draft, and a preview that generated items would be a campaign nobody
    // started.
    await seedHoldings();
    const before = await withTenant(tenantId, async (tx) => [
      await tx.campaignItem.count(),
      await tx.campaignItemReviewer.count(),
    ]);
    await previewReviewerResolution(tenantId, {
      scope: { resourceKinds: ['targetEntitlement'] },
      reviewerSelector: 'manager',
      reviewerConfig: {},
      fallbackSelector: 'person',
      fallbackConfig: { personId: person['Ola'] },
      snapshotId,
    });
    const after = await withTenant(tenantId, async (tx) => [
      await tx.campaignItem.count(),
      await tx.campaignItemReviewer.count(),
    ]);
    expect(after).toEqual(before);
  });
});

describe('closing', () => {
  it('marks undecided items UNDECIDED — never certified — and closes incomplete', async () => {
    // There is no status that means "certified because time ran out".
    const itemId = await seedItem('Anna');
    await withTenant(tenantId, (tx) => resolveItemReviewers(tx, campaignId, [itemId], NOW));

    const result = await closeDueCampaigns(tenantId, { now: new Date(DUE.getTime() + 60_000) });
    expect(result).toMatchObject({ closed: 1, undecided: 1 });

    const [campaign, item] = await withTenant(tenantId, async (tx) => [
      await tx.campaign.findUniqueOrThrow({ where: { id: campaignId } }),
      await tx.campaignItem.findUniqueOrThrow({ where: { id: itemId } }),
    ]);
    expect(item.status).toBe('undecided');
    expect(campaign.status).toBe('closed_incomplete');
    expect(campaign.coveragePercent).toBe(0);
  });

  it('creates a remediation item per undecided item, routed to the campaign owner', async () => {
    const itemId = await seedItem('Anna');
    await withTenant(tenantId, (tx) => resolveItemReviewers(tx, campaignId, [itemId], NOW));
    await closeDueCampaigns(tenantId, { now: new Date(DUE.getTime() + 60_000) });

    const items = await withTenant(tenantId, (tx) =>
      tx.remediationItem.findMany({ where: { kind: 'undecided_item' } }),
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.ownerPersonId).toBe(person['Ola']);
  });

  it('raises campaign_low_coverage naming the reviewers who did not respond', async () => {
    // The point of a recertification programme is not the certifications; it is
    // knowing which parts of the organization are not looking.
    const itemId = await seedItem('Anna');
    await withTenant(tenantId, (tx) => resolveItemReviewers(tx, campaignId, [itemId], NOW));
    await closeDueCampaigns(tenantId, { now: new Date(DUE.getTime() + 60_000) });

    const finding = await withTenant(tenantId, (tx) =>
      tx.governFinding.findFirstOrThrow({ where: { kind: 'campaign_low_coverage' } }),
    );
    expect((finding.detail as { reviewers?: string[] }).reviewers).toContain(person['Jan']);
  });

  it('NEVER counts a revocation_requires_change item as revoked, and counts dispatched ones as decided', async () => {
    // `'revocation_dispatched'.startsWith('revoke')` is FALSE — "revocation"
    // begins "revoca" — so a string test matches `revoke_decided` alone and
    // excludes all four `revocation_*` outcome statuses, while explicitly
    // INCLUDING `revocation_requires_change`. Two rules broken at once: the
    // vocabulary rule says `revocation_requires_change` is never counted in a
    // revoked figure, and §13 calls a rule-attributed holding counted as
    // revoked "a lie with a signature on it".
    const dispatched = await seedItem('Anna');
    const requiresChange = await seedItem('Bram');
    await withTenant(tenantId, async (tx) => {
      for (const [itemId, status, personId] of [
        [dispatched, 'revocation_dispatched', person['Jan']!],
        [requiresChange, 'revocation_requires_change', person['Ola']!],
      ] as const) {
        await tx.campaignItem.update({ where: { id: itemId }, data: { status } });
        await tx.campaignDecision.create({
          data: {
            tenantId,
            itemId,
            personId,
            decision: 'revoke',
            comment: 'no longer needed',
            itemOpenedAt: NOW,
            decidedAt: NOW,
            sessionDecisionOrdinal: 1,
            coverageAtDecision: {},
          },
        });
      }
    });

    await closeDueCampaigns(tenantId, { now: new Date(DUE.getTime() + 60_000) });
    const campaign = await withTenant(tenantId, (tx) =>
      tx.campaign.findUniqueOrThrow({ where: { id: campaignId } }),
    );

    // Both carry a decision, so both are DECIDED and coverage is 100.
    expect(campaign.coveragePercent).toBe(100);
    expect(campaign.status).toBe('closed_complete');
    // Both decisions were `revoke`, so both count as revoked...
    expect(campaign.revokedItems).toBe(2);
    // ...and the one Govern could not execute is ALSO reported on its own line.
    expect(campaign.requiresChangeItems).toBe(1);
  });

  it('counts `decided` from CampaignDecision rows, not from statuses', async () => {
    // The negative half. An item whose status was changed without a decision is
    // NOT decided, however final the status looks.
    const itemId = await seedItem('Anna');
    await withTenant(tenantId, (tx) =>
      tx.campaignItem.update({ where: { id: itemId }, data: { status: 'revocation_applied' } }),
    );
    await closeDueCampaigns(tenantId, { now: new Date(DUE.getTime() + 60_000) });
    const campaign = await withTenant(tenantId, (tx) =>
      tx.campaign.findUniqueOrThrow({ where: { id: campaignId } }),
    );
    expect(campaign.coveragePercent).toBe(0);
    expect(campaign.revokedItems).toBe(0);
  });

  it('writes ReviewQualitySignal rows when the campaign closes', async () => {
    // §12's reviewer-quality section "is not hidden behind a toggle". Computing
    // the signals only when a test calls them leaves `ReviewQualitySignal`
    // permanently empty, in the product and in the evidence bundle.
    const itemId = await seedItem('Anna');
    await withTenant(tenantId, async (tx) => {
      await resolveItemReviewers(tx, campaignId, [itemId], NOW);
      await tx.campaignItem.update({ where: { id: itemId }, data: { status: 'certified' } });
      await tx.campaignDecision.create({
        data: {
          tenantId,
          itemId,
          personId: person['Jan']!,
          decision: 'certify',
          itemOpenedAt: NOW,
          decidedAt: NOW,
          sessionDecisionOrdinal: 1,
          coverageAtDecision: {},
        },
      });
    });
    await closeDueCampaigns(tenantId, { now: new Date(DUE.getTime() + 60_000) });
    const signals = await withTenant(tenantId, (tx) => tx.reviewQualitySignal.findMany());
    expect(signals.length).toBeGreaterThan(0);
  });

  it('closes COMPLETE when every item was decided or mooted', async () => {
    const itemId = await seedItem('Anna');
    await withTenant(tenantId, async (tx) => {
      await tx.campaignItem.update({ where: { id: itemId }, data: { status: 'certified' } });
      await tx.campaignDecision.create({
        data: {
          tenantId,
          itemId,
          personId: person['Jan']!,
          decision: 'certify',
          itemOpenedAt: NOW,
          decidedAt: NOW,
          sessionDecisionOrdinal: 1,
          coverageAtDecision: {},
        },
      });
    });
    await closeDueCampaigns(tenantId, { now: new Date(DUE.getTime() + 60_000) });
    const campaign = await withTenant(tenantId, (tx) =>
      tx.campaign.findUniqueOrThrow({ where: { id: campaignId } }),
    );
    expect(campaign.status).toBe('closed_complete');
    expect(campaign.coveragePercent).toBe(100);
  });
});
