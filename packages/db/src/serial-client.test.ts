import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from './client.js';
import { SerialClient } from './serial-client.js';
import { resetDatabase } from './test-support.js';
import { withTenant } from './with-tenant.js';

/** pg 8's own bookkeeping: the query on the wire and the ones queued behind it. */
interface PgInternals {
  _activeQuery: unknown;
  _queryQueue: unknown[];
}

/**
 * Records every query handed to pg's `Client.query` while that connection was
 * already running one -- the condition pg 8 warns about and pg 9 rejects.
 * Counted here rather than by listening for the warning, which pg prints once
 * per process and so never again after the first test to provoke it.
 */
function watchOverlap(): { queries: number; overlaps: string[] } {
  const original = pg.Client.prototype.query;
  const watch = { queries: 0, overlaps: [] as string[] };
  vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function (
    this: pg.Client,
    ...args: unknown[]
  ) {
    watch.queries += 1;
    const internals = this as unknown as PgInternals;
    if (internals._activeQuery || internals._queryQueue.length > 0) {
      const [config] = args;
      watch.overlaps.push(
        typeof config === 'string' ? config : String((config as { text?: unknown }).text),
      );
    }
    return (original as (...a: unknown[]) => unknown).apply(this, args) as never;
  });
  return watch;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SerialClient', () => {
  it('runs concurrent queries on one connection one at a time, in call order', async () => {
    const watch = watchOverlap();
    const client = new SerialClient({ connectionString: process.env.DATABASE_URL! });
    await client.connect();
    try {
      const results = await Promise.all(
        [1, 2, 3].map((n) => client.query<{ n: number }>('SELECT $1::int AS n', [n])),
      );
      expect(results.map((r) => r.rows[0]!.n)).toEqual([1, 2, 3]);
      expect(watch.overlaps).toEqual([]);
    } finally {
      await client.end();
    }
  });

  it('keeps going after a query fails, as pg does', async () => {
    const client = new SerialClient({ connectionString: process.env.DATABASE_URL! });
    await client.connect();
    try {
      const [bad, good] = await Promise.allSettled([
        client.query('SELECT * FROM no_such_table'),
        client.query<{ n: number }>('SELECT 1 AS n'),
      ]);
      expect(bad.status).toBe('rejected');
      expect(good.status === 'fulfilled' && good.value.rows[0]!.n).toBe(1);
    } finally {
      await client.end();
    }
  });
});

describe('the shared Prisma client', () => {
  let tenantId: string;

  beforeEach(async () => {
    await resetDatabase();
    tenantId = (await prisma.tenant.create({ data: { name: 'A', slug: 'a' } })).id;
    await withTenant(tenantId, async (tx) => {
      const root = await tx.orgUnit.create({ data: { tenantId, name: 'Root' } });
      await tx.orgUnit.create({ data: { tenantId, name: 'Child', parentId: root.id } });
    });
  });

  it('does not overlap the queries of an include inside a transaction', async () => {
    // Prisma loads `parent` and `children` at the same moment, and inside a
    // transaction both go to the one connection the transaction holds.
    const watch = watchOverlap();
    const units = await withTenant(tenantId, (tx) =>
      tx.orgUnit.findMany({
        include: { parent: true, children: true, users: true },
        orderBy: { name: 'asc' },
      }),
    );
    expect(watch.queries).toBeGreaterThan(1);
    expect(units.map((u) => [u.name, u.parent?.name ?? null, u.children.length])).toEqual([
      ['Child', 'Root', 0],
      ['Root', null, 1],
    ]);
    expect(watch.overlaps).toEqual([]);
  });
});
