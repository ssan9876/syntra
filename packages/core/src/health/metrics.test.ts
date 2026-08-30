import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { createUser } from '../directory/user-service.js';
import { ensureActiveKey } from '../keys/signing-key-service.js';
import { localMasterKeyProvider } from '../vault/master-key.js';
import { WEBHOOK_MAX_ATTEMPTS } from '../notify/webhook-retry.js';
import { cachedMetrics, collectMetrics, type MetricsSnapshot } from './metrics.js';
import { createScheduler } from '../jobs/scheduler.js';

const provider = localMasterKeyProvider(Buffer.alloc(32, 7));

// The same default scheduler.test.ts uses, for the same reason: the worker's
// own database, so starting pg-boss here creates its schema where this file's
// queries look for it.
const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://syntra_app:syntra_app@localhost:5432/syntra';

let tenantId: string;

async function seedEndpoint() {
  return withTenant(tenantId, (tx) =>
    tx.webhookEndpoint.create({
      data: { tenantId, name: 'E', url: 'https://e.test/in', enabled: true, events: [] },
    }),
  );
}

async function seedDeliveries(pending: number, abandoned: number) {
  const endpoint = await seedEndpoint();
  await withTenant(tenantId, async (tx) => {
    for (let i = 0; i < pending; i += 1) {
      await tx.webhookDelivery.create({
        data: {
          tenantId, endpointId: endpoint.id, event: 'automate-approved',
          payload: {}, nextAttemptAt: new Date(),
        },
      });
    }
    for (let i = 0; i < abandoned; i += 1) {
      await tx.webhookDelivery.create({
        data: {
          tenantId, endpointId: endpoint.id, event: 'automate-approved',
          payload: {}, nextAttemptAt: new Date(), attempts: WEBHOOK_MAX_ATTEMPTS,
        },
      });
    }
  });
}

beforeEach(async () => {
  await resetDatabase();
  const tenant = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = tenant.id;
});

describe('collectMetrics', () => {
  it('separates a queue that is working from one that has given up', async () => {
    await seedDeliveries(3, 2);

    const snapshot = await collectMetrics();

    expect(snapshot.webhookDeliveriesPending).toBe(3);
    expect(snapshot.webhookDeliveriesAbandoned).toBe(2);
  });

  it('counts users by status', async () => {
    await withTenant(tenantId, async (tx) => {
      await createUser(tx, { login: 'a', email: 'a@acme.test', displayName: 'A' });
      const b = await createUser(tx, { login: 'b', email: 'b@acme.test', displayName: 'B' });
      await tx.user.update({ where: { id: b.id }, data: { status: 'inactive' } });
    });

    const snapshot = await collectMetrics();

    expect(snapshot.usersActive).toBe(1);
    expect(snapshot.usersInactive).toBe(1);
  });

  it('counts a lock with no expiry as locked', async () => {
    // The strictest setting: a lock that does not lift itself. Reading a null
    // lockedUntil as "no expiry recorded, so not locked" would turn it into
    // the weakest, and this is the query form of `isLocked`.
    const user = await withTenant(tenantId, (tx) =>
      createUser(tx, { login: 'c', email: 'c@acme.test', displayName: 'C' }),
    );
    await withTenant(tenantId, (tx) =>
      tx.loginLockout.create({
        data: {
          tenantId, userId: user.id, failedCount: 5,
          firstFailedAt: new Date(), lastFailedAt: new Date(),
          lockedAt: new Date(), lockedUntil: null,
        },
      }),
    );

    expect((await collectMetrics()).accountsLocked).toBe(1);
  });

  it('does not count a lock that has already lifted', async () => {
    const user = await withTenant(tenantId, (tx) =>
      createUser(tx, { login: 'd', email: 'd@acme.test', displayName: 'D' }),
    );
    await withTenant(tenantId, (tx) =>
      tx.loginLockout.create({
        data: {
          tenantId, userId: user.id, failedCount: 5,
          firstFailedAt: new Date(), lastFailedAt: new Date(),
          lockedAt: new Date(Date.now() - 7_200_000),
          lockedUntil: new Date(Date.now() - 3_600_000),
        },
      }),
    );

    expect((await collectMetrics()).accountsLocked).toBe(0);
  });

  it('reports the nearest signing key expiry', async () => {
    await ensureActiveKey(tenantId, provider, 'oidc');

    expect((await collectMetrics()).signingKeyExpiresInSeconds).toBeGreaterThan(0);
  });

  it('reports null rather than zero when there is no key', async () => {
    // Zero reads as "expires now" on a dashboard and pages somebody at three
    // in the morning for a deployment that has issued no tokens.
    expect((await collectMetrics()).signingKeyExpiresInSeconds).toBeNull();
  });

  it('reports job depth as a number where pg-boss has a schema', async () => {
    // pg-boss creates and migrates its own tables, which is why they are not
    // in schema.prisma -- and why a database no scheduler has ever started
    // against has no `pgboss.job` at all. Starting one here makes that this
    // file's own precondition. Inheriting it from whichever other test file
    // happened to share this worker's database is what made this case fail on
    // file ordering alone: the gauge read null, which is the branch below the
    // assertion, not the one it is testing.
    //
    // The null branch is the OTHER case -- a database pg-boss has never
    // touched -- and it is not exercised here because it cannot be produced
    // without dropping a schema the rest of the suite shares. What it protects
    // is the distinction between "the queue is empty" and "nothing is
    // processing the queue", which are different facts and must not both
    // render as 0 on a dashboard.
    const scheduler = createScheduler(DATABASE_URL);
    await scheduler.start();
    try {
      const jobsPending = (await collectMetrics()).jobsPending;
      expect(typeof jobsPending).toBe('number');
      expect(jobsPending).toBeGreaterThanOrEqual(0);
    } finally {
      await scheduler.stop();
    }
  }, 60_000);

  it('counts across tenants, because the series is installation-wide', async () => {
    const other = await prisma.tenant.create({ data: { name: 'Other', slug: 'other' } });
    await withTenant(tenantId, (tx) =>
      createUser(tx, { login: 'x', email: 'x@acme.test', displayName: 'X' }),
    );
    await withTenant(other.id, (tx) =>
      createUser(tx, { login: 'y', email: 'y@other.test', displayName: 'Y' }),
    );

    expect((await collectMetrics()).usersActive).toBe(2);
  });
});

describe('cachedMetrics', () => {
  const snapshot = (n: number) => ({ webhookDeliveriesPending: n } as MetricsSnapshot);

  it('does not re-read inside the window', async () => {
    let calls = 0;
    const read = cachedMetrics(10_000, async () => snapshot(++calls));

    expect((await read()).webhookDeliveriesPending).toBe(1);
    expect((await read()).webhookDeliveriesPending).toBe(1);
    expect(calls).toBe(1);
  });

  it('re-reads once the window has passed', async () => {
    let calls = 0;
    const read = cachedMetrics(0, async () => snapshot(++calls));

    await read();
    expect((await read()).webhookDeliveriesPending).toBe(2);
  });

  it('shares one read between scrapes that arrive together', async () => {
    // A plain timestamp check misses this: two requests landing in the same
    // tick both see an empty cache and both query.
    let calls = 0;
    const read = cachedMetrics(10_000, async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return snapshot(calls);
    });

    await Promise.all([read(), read(), read()]);

    expect(calls).toBe(1);
  });
});
