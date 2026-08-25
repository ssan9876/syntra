import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { collectTenant } from './collect.js';
import { buildSnapshot } from './snapshot-service.js';
import { createCampaign, startCampaign } from './campaign-service.js';
import { computeReviewQualitySignals } from './decision-service.js';
import {
  closeDueCampaigns,
  mootDepartedSubjects,
  mootVanishedHoldings,
  reassignInvalidReviewers,
  runCampaignReminders,
} from './reviewer-service.js';
import {
  computeRevocationBatch,
  confirmRevocationBatch,
  reflectRevocationOutcomes,
} from './revocation-service.js';

/**
 * Section 23: "No `withTenant` call encloses a loop over an unbounded
 * collection, checked in test by a client wrapper that fails when a transaction
 * exceeds a time budget under a seeded large tenant."
 *
 * The budget is deliberately well under Prisma's 5000 ms default. A test that
 * used 5000 ms would only fail once the defect was already shipping.
 *
 * The slice-2 half of this file — `startCampaign`, `closeDueCampaigns`, the four
 * sweeps, the revocation batch and `reflectRevocationOutcomes` over a seeded
 * 2,000-item campaign — is appended by the last of the campaign tasks, because
 * it cannot compile before those modules exist.
 */
/**
 * 2,500 ms, and OVERRIDABLE — because the number is calibrated against
 * hardware, not against the code.
 *
 * The budget is deliberately half of Prisma's 5,000 ms interactive-transaction
 * ceiling: a test set at the ceiling only fails once the defect is already
 * shipping. That reasoning is sound and unchanged. What does not transfer is
 * the calibration. On a GitHub-hosted runner the BOUNDED cases measured 2,505,
 * 2,561, 2,633 and 2,959 ms against this 2,500 — one of them missing by five
 * milliseconds. At that point the assertion is reporting the speed of the
 * runner, and a suite that goes red on every push for reasons unrelated to the
 * change is a suite people stop reading.
 *
 * CI was then set to 3,500 and slice 2's bounded case measured 3,560. The
 * figure had been calibrated from slice 1's numbers alone and slice 2's
 * bounded case is the heavier of the two; CI now allows 4,500. Worth knowing
 * before calibrating from one half again.
 *
 * Raising it does not blunt the check completely, and the detail matters
 * because half of it is easy to overclaim. MEASURED at `GOVERN_BUDGET_MS`
 * = 999999:
 *
 *   - slice 1's "fails when the write batch is unbounded" goes RED. It compares
 *     a measurement against the budget, so an absurd budget makes the mutation
 *     half unable to breach it, and the file says so.
 *   - slice 2's "FAILS when reviewer resolution is unbounded" stays green. It
 *     accepts an abort at Prisma's own 5,000 ms ceiling as the breach, and that
 *     is budget-independent by construction — it proves the defect is
 *     detectable, not that this number is meaningful.
 *
 * So slice 1 polices the value and slice 2 does not. A budget raised past
 * 5,000 ms would be caught; one raised to 4,000 would not be. That is the real
 * guarantee, and it is worth knowing before somebody reaches for this knob.
 *
 * The default stays 2,500 so a developer's machine keeps the strict figure.
 */
const BUDGET_MS = Number(process.env.GOVERN_BUDGET_MS ?? 2500);

/**
 * FOUR THOUSAND, not the four hundred the plan seeded.
 *
 * At 400 people the unbounded-write case — the one Global Constraint 4 exists
 * for — measured **571 ms** against a 2500 ms budget. It could not fail, so the
 * file proved nothing about the rule it enforces. The seed has to be large
 * enough that "everything in one transaction" and "two hundred rows at a time"
 * are different numbers, or the budget is a constant nobody reads.
 *
 * Measured on this machine at 4,000 people: bounded **368 ms**, unbounded
 * **4,287 ms** — an 11x separation, with the failing case 71% clear of the
 * budget. At 2,000 it was 2,269 ms and would not have failed at all; at 3,000,
 * 3,193 ms, close enough to the line that a faster machine would flip it.
 * §17 calls a 50,000-item population ordinary, so this is still small.
 * `createMany` keeps the seed itself off the critical path.
 */
const NOW = new Date('2026-06-15T09:00:00Z');
const DUE = new Date('2026-07-15T09:00:00Z');

const PEOPLE = 4_000;
const GROUPS = 20;
const MEMBERSHIPS_PER_PERSON = 5;

let tenantId: string;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
}, 300_000);

/**
 * The slice-1 population, seeded by slice 1 ONLY.
 *
 * It was a file-level `beforeEach`, which meant every slice-2 case paid for
 * 4,000 people, 4,000 logins and 20,000 memberships it never reads — on top of
 * its own 2,000-holding campaign — before its first assertion. Slice 2 measures
 * a campaign, not a directory.
 */
async function seedLargePopulation(): Promise<void> {
  // Set-based, in a handful of statements. Seeding row by row inside one
  // `withTenant` would itself exceed the transaction budget this file measures,
  // and a seed that trips the instrument tells you nothing about the code.
  const { ouId, groupIds } = await withTenant(tenantId, async (tx) => {
    const groups = [];
    for (let g = 0; g < GROUPS; g += 1) {
      groups.push(await tx.group.create({ data: { tenantId, name: `group-${g}` } }));
    }
    const ou = await tx.orgUnit.create({ data: { tenantId, name: 'HQ' } });
    const app = await tx.application.create({ data: { tenantId, name: 'Stats', slug: 'stats' } });
    await tx.appAssignment.create({
      data: { tenantId, applicationId: app.id, subjectType: 'orgUnit', orgUnitId: ou.id },
    });
    return { ouId: ou.id, groupIds: groups.map((g) => g.id) };
  });

  const personIds = Array.from({ length: PEOPLE }, () => randomUUID());
  const userIds = Array.from({ length: PEOPLE }, () => randomUUID());

  await withTenant(tenantId, (tx) =>
    tx.person.createMany({
      data: personIds.map((id, i) => ({
        id,
        tenantId,
        givenName: `P${i}`,
        familyName: 'Test',
      })),
    }),
  );

  await withTenant(tenantId, (tx) =>
    tx.contract.createMany({
      data: personIds.map((personId) => ({
        tenantId,
        personId,
        sequence: 1,
        isPrimary: true,
        startDate: new Date('2020-01-01'),
      })),
    }),
  );

  await withTenant(tenantId, (tx) =>
    tx.user.createMany({
      data: userIds.map((id, i) => ({
        id,
        tenantId,
        login: `u${i}`,
        email: `u${i}@acme.test`,
        displayName: `P${i} Test`,
        personId: personIds[i]!,
        orgUnitId: ouId,
      })),
    }),
  );

  await withTenant(tenantId, (tx) =>
    tx.groupMembership.createMany({
      data: userIds.flatMap((userId, i) =>
        Array.from({ length: MEMBERSHIPS_PER_PERSON }, (_unused, g) => ({
          tenantId,
          groupId: groupIds[(i + g) % GROUPS]!,
          userId,
        })),
      ),
    }),
  );
}

/** Times every transaction the callback opens, by timing withTenant itself. */
async function timedTransactions<T>(fn: () => Promise<T>): Promise<{ result: T; slowest: number }> {
  const durations: number[] = [];
  const original = Reflect.get(prisma, '$transaction') as (...args: unknown[]) => Promise<unknown>;
  Reflect.set(prisma, '$transaction', async (...args: unknown[]) => {
    const started = Date.now();
    try {
      return await original.apply(prisma, args);
    } finally {
      durations.push(Date.now() - started);
    }
  });
  try {
    const result = await fn();
    return { result, slowest: Math.max(0, ...durations) };
  } finally {
    Reflect.set(prisma, '$transaction', original);
  }
}

describe('the transaction budget', () => {
  beforeEach(seedLargePopulation, 300_000);

  it('collects a large tenant with no transaction over the budget', async () => {
    const { result, slowest } = await timedTransactions(() => collectTenant(tenantId));
    expect(result.holdings.length).toBeGreaterThan(PEOPLE);
    expect(result.queryCount).toBe(9);
    expect(slowest).toBeLessThan(BUDGET_MS);
  }, 300_000);

  it('builds a snapshot over the same tenant with no transaction over the budget', async () => {
    const { result, slowest } = await timedTransactions(() =>
      buildSnapshot(tenantId, { batchSize: 200 }),
    );
    expect(result.status).toBe('complete');
    expect(slowest).toBeLessThan(BUDGET_MS);
  }, 300_000);

  it('fails when the write batch is unbounded — the mutation this test exists for', async () => {
    // EXECUTED, not documented. A test that asserted `BUDGET_MS < 5000` would be
    // an assertion about a constant, and Global Constraint 4 says "Task 12 makes
    // the rule a test".
    let aborted = false;
    const { slowest } = await timedTransactions(async () => {
      try {
        await buildSnapshot(tenantId, { batchSize: Number.MAX_SAFE_INTEGER });
      } catch {
        // Prisma's own 5,000 ms interactive-transaction ceiling ends it first:
        // "Transaction already closed... the timeout for this transaction was
        // 5000 ms". That is the SAME finding as breaching the budget, arriving
        // as an exception instead of a number, and it is the shape the defect
        // takes in production — the snapshot half-written, its attributions
        // never recorded.
        //
        // The slice-2 half of this file has said so since it was written. This
        // half measured only, so on a loaded machine — where crossing 2,500 ms
        // and crossing 5,000 ms are the same run — the test that exists to
        // prove the budget matters failed by proving it.
        aborted = true;
      }
    });

    const breached = aborted || slowest > BUDGET_MS;
    expect(breached).toBe(true);
  }, 300_000);
});

/**
 * SLICE 2. The budget file covered `collectTenant` and `buildSnapshot` only,
 * and slice 2 is where the unbounded loops were: `startCampaign` resolved every
 * reviewer inside the item-creation transaction, `closeDueCampaigns` held one
 * transaction over every campaign and every item, and four sweeps did the same.
 *
 * A 2,000-item campaign is the size §17 calls ordinary — it explicitly
 * contemplates 50,000 — and it is small enough to seed in a test.
 */
describe('the transaction budget — slice 2', () => {
  const SUBJECTS = 200;
  const PER_SUBJECT = 10;
  const ITEMS = SUBJECTS * PER_SUBJECT;
  const REVIEWERS = 50;
  /**
   * The unbounded case is measured at the ORDINARY size, against the REVIEWER
   * loop rather than the item loop.
   *
   * `batchSize` bounds item creation, which is one `createMany` per page: at
   * 2,000 items unbounded it measured **648 ms** against a 2500 ms budget, and
   * at 12,000 only **1,325 ms** — it could not fail at any size a test would
   * seed, because writing rows in bulk is what a database is fast at. Reviewer
   * resolution does per-item work, which is the loop Global Constraint 4 is
   * about and the one `REVIEWER_BATCH` exists for.
   */
  const UNBOUNDED_PER_SUBJECT = 10;
  /**
   * How many dispatch rows the CONFIRM and REFLECT cases carry.
   *
   * `computeRevocationBatch` is measured at the full 2,000, because its budget
   * property is "one transaction for the whole batch" and only the whole batch
   * tests it. `confirmRevocationBatch` opens roughly four short transactions
   * PER ROW and `reflectRevocationOutcomes` pages at 200: at 2,000 rows that is
   * eight thousand round trips, and the number that comes back measures the
   * harness rather than the code. 400 rows is two full pages and a per-row loop
   * long enough that one slow row would show.
   */
  const DISPATCH_ROWS = 400;

  let campaignId: string;
  let snapshotId: string;
  let actorUserId: string;

  /**
   * Bumped per call, because the unbounded case seeds TWICE in one test and
   * `User.login`, `TargetSystem.name` and the service account all carry unique
   * constraints. A collision there would fail the seed, not the assertion.
   */
  let seedSeq = 0;

  /** Seeds the ordinary 2,000-item campaign and binds the three ids. */
  async function seedOrdinaryCampaign(): Promise<void> {
    const seeded = await seedLargeCampaign(PER_SUBJECT);
    campaignId = seeded.campaignId;
    snapshotId = seeded.snapshotId;
    actorUserId = seeded.actorUserId;
  }

  /**
   * A campaign over 2,000 holdings, 200 subjects and 50 reviewers.
   *
   * Every row goes in with `createMany`. A seed written row by row inside one
   * `withTenant` would itself exceed the budget this file measures, and a seed
   * that trips the instrument tells you nothing about the code.
   */
  async function seedLargeCampaign(perSubject: number): Promise<{
    campaignId: string;
    snapshotId: string;
    actorUserId: string;
  }> {
    seedSeq += 1;
    const tag = seedSeq;
    const reviewerIds = Array.from({ length: REVIEWERS }, () => randomUUID());
    const subjectIds = Array.from({ length: SUBJECTS }, () => randomUUID());
    const entitlementIds = Array.from({ length: perSubject }, () => randomUUID());

    const { targetId, snapshotId: builtSnapshotId, actorId } = await withTenant(
      tenantId,
      async (tx) => {
        const target = await tx.targetSystem.create({
          data: {
            tenantId,
            name: `Acme AD ${tag}`,
            secretName: 's/ad',
            config: { tlsMode: 'ldaps' },
            lastRunAt: NOW,
            lastAppliedRunAt: NOW,
          },
        });
        const actor = await tx.user.create({
          data: {
            tenantId,
            login: `svc${tag}`,
            email: `svc${tag}@acme.test`,
            displayName: 'Service',
          },
        });
        const snapshot = await tx.accessSnapshot.create({
          data: {
            tenantId,
            kind: 'campaign',
            status: 'complete',
            asOf: NOW,
            personsWithActiveContract: SUBJECTS + REVIEWERS,
            holdingCount: SUBJECTS * perSubject,
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
        return { targetId: target.id, snapshotId: snapshot.id, actorId: actor.id };
      },
    );

    await withTenant(tenantId, (tx) =>
      tx.person.createMany({
        data: [
          ...reviewerIds.map((id, i) => ({
            id,
            tenantId,
            givenName: `Reviewer${i}`,
            familyName: 'Manager',
          })),
          ...subjectIds.map((id, i) => ({
            id,
            tenantId,
            givenName: `Subject${i}`,
            familyName: 'Novak',
          })),
        ],
      }),
    );

    await withTenant(tenantId, (tx) =>
      tx.contract.createMany({
        data: [
          ...reviewerIds.map((personId) => ({
            tenantId,
            personId,
            sequence: 1,
            isPrimary: true,
            startDate: new Date('2020-01-01'),
          })),
          // Spread across the 50 reviewers, so the `manager` selector is a real
          // cost rather than one lookup repeated 2,000 times.
          ...subjectIds.map((personId, i) => ({
            tenantId,
            personId,
            sequence: 1,
            isPrimary: true,
            startDate: new Date('2020-01-01'),
            managerPersonId: reviewerIds[i % REVIEWERS]!,
          })),
        ],
      }),
    );

    // The reviewers need logins: reviewer resolution drops a person with no
    // active account, and a campaign whose every item fell to the fallback
    // would measure the fallback.
    await withTenant(tenantId, (tx) =>
      tx.user.createMany({
        data: reviewerIds.map((personId, i) => ({
          tenantId,
          login: `reviewer${tag}-${i}`,
          email: `reviewer${tag}-${i}@acme.test`,
          displayName: `Reviewer${i} Manager`,
          personId,
        })),
      }),
    );

    await withTenant(tenantId, (tx) =>
      tx.entitlement.createMany({
        data: entitlementIds.map((id, i) => ({
          id,
          tenantId,
          targetSystemId: targetId,
          externalId: `guid-${i}`,
          type: 'group',
          displayName: `Group ${i}`,
        })),
      }),
    );

    // One account per subject: every holding routes to a `RevocationOrder`, and
    // `createRevocationOrder` needs the account it names.
    await withTenant(tenantId, (tx) =>
      tx.targetAccount.createMany({
        data: subjectIds.map((personId, i) => ({
          tenantId,
          targetSystemId: targetId,
          personId,
          anchor: `guid-${i}`,
          correlationKey: `subject.${i}`,
          status: 'active',
          lastReconciledAt: NOW,
        })),
      }),
    );

    await withTenant(tenantId, (tx) =>
      tx.holding.createMany({
        data: subjectIds.flatMap((personId) =>
          entitlementIds.map((resourceId, e) => ({
            tenantId,
            snapshotId: builtSnapshotId,
            subjectKey: `person:${personId}`,
            personId,
            systemKind: 'targetSystem',
            systemId: targetId,
            resourceKind: 'targetEntitlement',
            resourceId,
            resourceName: `Group ${e}`,
            state: 'held',
            observedAt: NOW,
            observedVia: 'provision',
            firstSeenAt: NOW,
          })),
        ),
      }),
    );

    const campaign = await createCampaign(tenantId, actorId, {
      name: `Q2 review ${tag}`,
      description: null,
      scope: { resourceKinds: ['targetEntitlement'] },
      reviewerSelector: 'manager',
      reviewerConfig: {},
      fallbackSelector: 'person',
      fallbackConfig: { personId: reviewerIds[0]! },
      ownerPersonId: reviewerIds[0]!,
      opensAt: NOW,
      dueAt: DUE,
      allowBulkCertify: false,
      snapshotId: builtSnapshotId,
    });

    return { campaignId: campaign.id, snapshotId: builtSnapshotId, actorUserId: actorId };
  }

  /** Every item decided, set-based. The decisions are fixture, not measurement. */
  async function decideEveryItem(decision: 'revoke' | 'certify'): Promise<void> {
    const items = await withTenant(tenantId, (tx) =>
      tx.campaignItem.findMany({ where: { campaignId }, select: { id: true, personId: true } }),
    );
    const reviewer = await withTenant(tenantId, (tx) =>
      tx.person.findFirstOrThrow({ where: { familyName: 'Manager' }, select: { id: true } }),
    );
    await withTenant(tenantId, (tx) =>
      tx.campaignDecision.createMany({
        data: items.map((item, i) => ({
          tenantId,
          itemId: item.id,
          personId: reviewer.id,
          decision,
          comment: 'no longer needed',
          itemOpenedAt: NOW,
          decidedAt: NOW,
          sessionDecisionOrdinal: i + 1,
          coverageAtDecision: {},
        })),
      }),
    );
    await withTenant(tenantId, (tx) =>
      tx.campaignItem.updateMany({
        where: { campaignId },
        data: { status: decision === 'revoke' ? 'revoke_decided' : 'certified' },
      }),
    );
  }

  it('starts a 2,000-item campaign with no transaction over the budget', async () => {
    await seedOrdinaryCampaign();
    const { result, slowest } = await timedTransactions(() =>
      startCampaign(tenantId, actorUserId, campaignId, { now: NOW }),
    );
    expect(result.itemCount).toBe(ITEMS);
    expect(slowest).toBeLessThan(BUDGET_MS);
  }, 300_000);

  it('closes a 2,000-item campaign with no transaction over the budget', async () => {
    await seedOrdinaryCampaign();
    await startCampaign(tenantId, actorUserId, campaignId, { now: NOW });
    // REVOKE, not certify. The close now computes the revocation batch §13 says
    // it must, and that is one transaction for the whole batch by design -- so
    // certifying every item would measure a close that skips the heaviest thing
    // it does.
    await decideEveryItem('revoke');
    const { result, slowest } = await timedTransactions(() =>
      closeDueCampaigns(tenantId, { now: new Date(DUE.getTime() + 60_000) }),
    );
    expect(result.batches).toBe(1);
    expect(slowest).toBeLessThan(BUDGET_MS);
  }, 300_000);

  it('runs the sweeps over the same campaign within the budget', async () => {
    await seedOrdinaryCampaign();
    await startCampaign(tenantId, actorUserId, campaignId, { now: NOW });
    const { slowest } = await timedTransactions(async () => {
      await mootDepartedSubjects(tenantId, campaignId, { now: NOW });
      await mootVanishedHoldings(tenantId, campaignId, snapshotId, { now: NOW });
      await reassignInvalidReviewers(tenantId, campaignId, { now: NOW });
      await runCampaignReminders(tenantId, { now: new Date(DUE.getTime() - 60_000) });
      await computeReviewQualitySignals(tenantId, campaignId, NOW);
    });
    expect(slowest).toBeLessThan(BUDGET_MS);
  }, 300_000);

  it('computes a 2,000-row revocation batch in ONE transaction within the budget', async () => {
    await seedOrdinaryCampaign();
    await startCampaign(tenantId, actorUserId, campaignId, { now: NOW });
    await decideEveryItem('revoke');
    const { result, slowest } = await timedTransactions(() =>
      computeRevocationBatch(tenantId, actorUserId, campaignId, { now: NOW }),
    );
    expect(result.status).toBe('previewed');
    // The whole batch is one transaction by design — "a batch is thousands of
    // rows at most" — so this is the case where the two grouped denominator
    // queries matter. Two per resource would be 400 extra round trips inside
    // this one transaction.
    expect(slowest).toBeLessThan(BUDGET_MS);
  }, 300_000);

  it('confirms and reflects a batch with no transaction over the budget', async () => {
    await seedOrdinaryCampaign();
    await startCampaign(tenantId, actorUserId, campaignId, { now: NOW });
    await decideEveryItem('revoke');
    const { batchId } = await computeRevocationBatch(tenantId, actorUserId, campaignId, {
      now: NOW,
    });

    // Trimmed set-based, in one statement, for the reason DISPATCH_ROWS gives.
    // `confirmRevocationBatch` reads only `proposed` rows, and a per-row skip is
    // a decision it must not undo — which is exactly what makes this a legal
    // way to shorten the loop without changing its shape.
    const surplus = await withTenant(tenantId, (tx) =>
      tx.revocationDispatch.findMany({
        where: { batchId, status: 'proposed' },
        orderBy: { sequence: 'asc' },
        skip: DISPATCH_ROWS,
        select: { id: true },
      }),
    );
    await withTenant(tenantId, (tx) =>
      tx.revocationDispatch.updateMany({
        where: { id: { in: surplus.map((row) => row.id) } },
        data: { status: 'skipped', message: 'trimmed by the budget fixture' },
      }),
    );

    const confirmTiming = await timedTransactions(() =>
      confirmRevocationBatch(tenantId, actorUserId, batchId, { now: NOW, confirmed: true }),
    );
    expect(confirmTiming.result.dispatched).toBe(DISPATCH_ROWS);
    // One short transaction PER DISPATCH ROW, so the slowest is one row's work
    // and not the batch's.
    expect(confirmTiming.slowest).toBeLessThan(BUDGET_MS);

    // And the reflection pages at 200, so 400 rows is two full pages.
    const reflectTiming = await timedTransactions(() =>
      reflectRevocationOutcomes(tenantId, snapshotId, { now: NOW }),
    );
    expect(reflectTiming.slowest).toBeLessThan(BUDGET_MS);
  }, 300_000);

  it('FAILS when reviewer resolution is unbounded — the mutation this half exists for', async () => {
    // EXECUTED, not documented. `REVIEWER_BATCH` was exported by the reviewer
    // task and referenced by nothing: a budget stored and never read, which no
    // test could catch because there was no slice-2 budget test at all.
    // The bounded half first, over the same shape of campaign, so the contrast
    // is a measurement rather than a claim: whatever this machine is, 200
    // reviewers at a time stays well inside the budget.
    const bounded = await seedLargeCampaign(UNBOUNDED_PER_SUBJECT);
    const boundedTiming = await timedTransactions(() =>
      startCampaign(tenantId, bounded.actorUserId, bounded.campaignId, { now: NOW }),
    );
    expect(boundedTiming.slowest).toBeLessThan(BUDGET_MS);

    const unbounded = await seedLargeCampaign(UNBOUNDED_PER_SUBJECT);
    let aborted = false;
    const { slowest } = await timedTransactions(async () => {
      try {
        await startCampaign(tenantId, unbounded.actorUserId, unbounded.campaignId, {
          now: NOW,
          reviewerBatchSize: Number.MAX_SAFE_INTEGER,
        });
      } catch {
        // Prisma's own 5,000 ms interactive-transaction ceiling ends it first:
        // `Transaction not found. Transaction ID is invalid, refers to an old
        // closed transaction`. That is the SAME finding as breaching the
        // budget, arriving as an exception instead of a number — and it is the
        // shape the defect takes in production, where the campaign half-starts
        // and the reviewers are never assigned.
        aborted = true;
      }
    });

    const breached = aborted || slowest > BUDGET_MS;
    expect(breached).toBe(true);
  }, 300_000);
});
