import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from './index.js';
import { resetDatabase } from './test-support.js';

let tenantId: string;
let otherTenantId: string;

beforeEach(async () => {
  await resetDatabase();
  const [a, b] = await Promise.all([
    prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } }),
    prisma.tenant.create({ data: { name: 'Globex', slug: 'globex' } }),
  ]);
  tenantId = a.id;
  otherTenantId = b.id;
});

const anEndpoint = (over: Record<string, unknown> = {}) => ({
  tenantId,
  name: 'Ticketing',
  url: 'https://hooks.example.com/syntra',
  ...over,
});

describe('the webhook tables', () => {
  it('force row-level security on the owning role', async () => {
    const rows = await prisma.$queryRaw<
      { relname: string; relforcerowsecurity: boolean }[]
    >`
      SELECT c.relname, c.relforcerowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname IN ('WebhookEndpoint','WebhookDelivery')
    `;
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.relforcerowsecurity).toBe(true);
  });

  it('refuses a row written for another tenant', async () => {
    await expect(
      withTenant(tenantId, (tx) =>
        tx.webhookEndpoint.create({ data: anEndpoint({ tenantId: otherTenantId }) }),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("hides another tenant's endpoints from a read", async () => {
    await withTenant(otherTenantId, (tx) =>
      tx.webhookEndpoint.create({ data: anEndpoint({ tenantId: otherTenantId }) }),
    );
    expect(await withTenant(tenantId, (tx) => tx.webhookEndpoint.count())).toBe(0);
  });

  it('lets two tenants use the same endpoint name', async () => {
    // The unique index is per tenant. One organisation naming its integration
    // "Ticketing" must not stop another doing the same.
    await withTenant(tenantId, (tx) => tx.webhookEndpoint.create({ data: anEndpoint() }));
    await expect(
      withTenant(otherTenantId, (tx) =>
        tx.webhookEndpoint.create({ data: anEndpoint({ tenantId: otherTenantId }) }),
      ),
    ).resolves.toBeTruthy();
  });

  it('refuses two endpoints with one name inside a tenant', async () => {
    await withTenant(tenantId, (tx) => tx.webhookEndpoint.create({ data: anEndpoint() }));
    await expect(
      withTenant(tenantId, (tx) => tx.webhookEndpoint.create({ data: anEndpoint() })),
    ).rejects.toThrow();
  });

  it("takes a deleted endpoint's deliveries with it", async () => {
    const endpoint = await withTenant(tenantId, (tx) =>
      tx.webhookEndpoint.create({ data: anEndpoint() }),
    );
    await withTenant(tenantId, (tx) =>
      tx.webhookDelivery.create({
        data: {
          tenantId,
          endpointId: endpoint.id,
          event: 'automate-stage-opened',
          payload: {},
          nextAttemptAt: new Date(),
        },
      }),
    );

    await withTenant(tenantId, (tx) =>
      tx.webhookEndpoint.delete({ where: { id: endpoint.id } }),
    );
    // A delivery addressed to an endpoint that no longer exists has nobody to
    // be sent to and no question left to answer.
    expect(await withTenant(tenantId, (tx) => tx.webhookDelivery.count())).toBe(0);
  });

  it('refuses a negative attempt count', async () => {
    const endpoint = await withTenant(tenantId, (tx) =>
      tx.webhookEndpoint.create({ data: anEndpoint() }),
    );
    await expect(
      withTenant(tenantId, (tx) =>
        tx.webhookDelivery.create({
          data: {
            tenantId,
            endpointId: endpoint.id,
            event: 'automate-stage-opened',
            payload: {},
            nextAttemptAt: new Date(),
            attempts: -1,
          },
        }),
      ),
    ).rejects.toThrow();
  });
});
