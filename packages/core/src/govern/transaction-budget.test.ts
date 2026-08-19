import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { collectTenant } from './collect.js';
import { buildSnapshot } from './snapshot-service.js';

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
const BUDGET_MS = 2500;

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
const PEOPLE = 4_000;
const GROUPS = 20;
const MEMBERSHIPS_PER_PERSON = 5;

let tenantId: string;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;

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
}, 300_000);

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
    const { slowest } = await timedTransactions(() =>
      buildSnapshot(tenantId, { batchSize: Number.MAX_SAFE_INTEGER }),
    );
    expect(slowest).toBeGreaterThan(BUDGET_MS);
  }, 300_000);
});
