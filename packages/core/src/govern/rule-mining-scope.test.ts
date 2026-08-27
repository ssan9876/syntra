import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { mineFromSnapshot } from './rule-mining.js';

/**
 * `mineFromSnapshot` against a real snapshot, and the org-unit scope it must
 * honour.
 *
 * `rule-mining.test.ts` covers the arithmetic, which is pure. This covers the
 * half that reads rows — including the one that would be a disclosure: a
 * candidate names no person, so it LOOKS exempt from the scope, but it names a
 * cohort and counts it. "Everyone in Engineering holds all-staff" tells a
 * department lead the size and the access shape of a department they cannot
 * otherwise see.
 */

const NOW = new Date('2026-06-15T09:00:00Z');

let tenantId: string;
let snapshotId: string;
let financeIds: string[];

/** `n` people in one department, each holding `resource`. */
async function cohort(department: string, n: number, resource: string): Promise<string[]> {
  return withTenant(tenantId, async (tx) => {
    const ids: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const person = await tx.person.create({
        data: { tenantId, givenName: `${department}${i}`, familyName: 'Person' },
      });
      await tx.contract.create({
        data: {
          tenantId,
          personId: person.id,
          sequence: 1,
          isPrimary: true,
          startDate: new Date('2020-01-01'),
          department,
        },
      });
      await tx.holding.create({
        data: {
          tenantId,
          snapshotId,
          personId: person.id,
          state: 'held',
          resourceKind: 'targetEntitlement',
          resourceId: resource,
          resourceName: resource,
          systemKind: 'targetSystem',
          systemId: 'sys-1',
          subjectKey: `person:${person.id}`,
          observedAt: NOW,
          observedVia: 'targetRead',
          firstSeenAt: NOW,
        },
      });
      ids.push(person.id);
    }
    return ids;
  });
}

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  const snapshot = await withTenant(tenantId, (tx) =>
    tx.accessSnapshot.create({
      data: { tenantId, kind: 'scheduled', asOf: NOW, status: 'complete' },
    }),
  );
  snapshotId = snapshot.id;

  financeIds = await cohort('Finance', 6, 'fin-read');
  await cohort('Engineering', 8, 'eng-deploy');
});

describe('mineFromSnapshot', () => {
  it('finds the rule each department already follows', async () => {
    const found = await withTenant(tenantId, (tx) => mineFromSnapshot(tx, snapshotId));
    const values = found.map((c) => c.value).sort();
    expect(values).toEqual(['Engineering', 'Finance']);
    expect(found.find((c) => c.value === 'Finance')).toMatchObject({
      field: 'department',
      holders: 6,
      population: 6,
      confidence: 1,
    });
  });

  it('mines only the persons a scoped reader may see', async () => {
    // The disclosure, stated. Handed only Finance's person ids, the miner must
    // not describe Engineering at all — not its cohort, not its size, and not
    // the resource its people hold.
    const found = await withTenant(tenantId, (tx) =>
      mineFromSnapshot(tx, snapshotId, { personIds: financeIds }),
    );
    expect(found.map((c) => c.value)).toEqual(['Finance']);
    expect(JSON.stringify(found)).not.toContain('Engineering');
    expect(JSON.stringify(found)).not.toContain('eng-deploy');
  });

  it('counts outside holders only among the persons it may see', async () => {
    // `outsideHolders` is the count this scope is most likely to leak: it is
    // defined as everyone holding the resource who is NOT in the cohort, and
    // computed over all rows it would count people the reader may not know
    // exist.
    const scoped = await withTenant(tenantId, (tx) =>
      mineFromSnapshot(tx, snapshotId, { personIds: financeIds }),
    );
    expect(scoped[0]).toMatchObject({ value: 'Finance', outsideHolders: 0 });
  });

  it('returns nothing for a scope that admits nobody', async () => {
    // An empty admitted list is "this reader may see no one", which is not the
    // same as "no filter" — reading it as the latter would hand the whole
    // tenant to a reader scoped to an empty org unit.
    const found = await withTenant(tenantId, (tx) =>
      mineFromSnapshot(tx, snapshotId, { personIds: [] }),
    );
    expect(found).toEqual([]);
  });

  it('mines everything when no scope is given', async () => {
    // `null` and `undefined` are the tenant-wide case, and must not be
    // confused with the empty list above.
    const withNull = await withTenant(tenantId, (tx) =>
      mineFromSnapshot(tx, snapshotId, { personIds: null }),
    );
    expect(withNull.map((c) => c.value).sort()).toEqual(['Engineering', 'Finance']);
  });
});
