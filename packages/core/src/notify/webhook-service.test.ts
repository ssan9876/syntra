import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { localMasterKeyProvider } from '../vault/master-key.js';
import { getSecret } from '../vault/vault-service.js';
import { enqueueOutbox } from '../automate/notify.js';
import {
  createEndpoint,
  deleteEndpoint,
  endpointSecret,
  listEndpoints,
  rotateEndpointSecret,
  updateEndpoint,
  webhookSecretName,
  type EndpointInput,
} from './webhook-service.js';

const provider = localMasterKeyProvider(Buffer.alloc(32, 7));
let tenantId: string;

const anEndpoint = (over: Partial<EndpointInput> = {}): EndpointInput => ({
  name: 'Ticketing',
  url: 'https://hooks.example.com/syntra',
  enabled: true,
  events: [],
  ...over,
});

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
});

describe('createEndpoint', () => {
  it('returns the signing secret exactly once', async () => {
    const created = await withTenant(tenantId, (tx) =>
      createEndpoint(tx, provider, anEndpoint()),
    );
    expect(created.secret).toMatch(/^whsec_[A-Za-z0-9_-]{40,}$/);

    const listed = await withTenant(tenantId, (tx) => listEndpoints(tx));
    // Not on the way back out. The secret's whole job is to let a receiver
    // tell a real delivery from a forged one, and a value any admin screen
    // will re-display is one that leaks by being looked at.
    expect(JSON.stringify(listed)).not.toContain(created.secret);
  });

  it('seals the secret rather than storing it on the row', async () => {
    const created = await withTenant(tenantId, (tx) =>
      createEndpoint(tx, provider, anEndpoint()),
    );
    const row = await withTenant(tenantId, (tx) =>
      tx.webhookEndpoint.findUniqueOrThrow({ where: { id: created.id } }),
    );
    expect(JSON.stringify(row)).not.toContain(created.secret);

    const sealed = await withTenant(tenantId, (tx) =>
      getSecret(tx, provider, webhookSecretName(created.id)),
    );
    expect(sealed).toBe(created.secret);
  });

  it('refuses a url this deployment will not send to', async () => {
    await expect(
      withTenant(tenantId, (tx) =>
        createEndpoint(tx, provider, anEndpoint({ url: 'file:///etc/passwd' })),
      ),
      // The message now comes from the SHARED `assertOutboundUrl` rather than
      // from a check of this module's own. This assertion pinned the old
      // wording and went red when the two were consolidated — which is the
      // guard working, not a nuisance: a scheme refusal quietly becoming some
      // other refusal is exactly what it should catch.
    ).rejects.toThrow(/only http and https/);
  });
});

describe('rotateEndpointSecret', () => {
  it('replaces the secret and returns the new one', async () => {
    const created = await withTenant(tenantId, (tx) =>
      createEndpoint(tx, provider, anEndpoint()),
    );
    const rotated = await withTenant(tenantId, (tx) =>
      rotateEndpointSecret(tx, provider, created.id),
    );
    expect(rotated).not.toBe(created.secret);
    expect(
      await withTenant(tenantId, (tx) => endpointSecret(tx, provider, created.id)),
    ).toBe(rotated);
  });
});

describe('deleteEndpoint', () => {
  it('takes the sealed secret with it', async () => {
    const created = await withTenant(tenantId, (tx) =>
      createEndpoint(tx, provider, anEndpoint()),
    );
    await withTenant(tenantId, (tx) => deleteEndpoint(tx, created.id));

    // A secret outliving the thing it signed for is a credential nobody owns
    // and nobody will ever rotate.
    expect(
      await withTenant(tenantId, (tx) =>
        getSecret(tx, provider, webhookSecretName(created.id)),
      ),
    ).toBeNull();
  });
});

describe('enqueueOutbox, fanning out to webhooks', () => {
  const drafts = [
    {
      template: 'automate-stage-opened' as const,
      to: 'approver@example.com',
      vars: { productName: 'Finance' },
      requestId: null,
      userId: null,
    },
    {
      template: 'automate-stage-opened' as const,
      to: 'second@example.com',
      vars: { productName: 'Finance' },
      requestId: null,
      userId: null,
    },
  ];

  it('writes one delivery per endpoint, not one per recipient', async () => {
    await withTenant(tenantId, (tx) => createEndpoint(tx, provider, anEndpoint()));
    await withTenant(tenantId, (tx) => enqueueOutbox(tx, drafts));

    const deliveries = await withTenant(tenantId, (tx) => tx.webhookDelivery.findMany());
    // Two people were mailed about ONE thing that happened. A receiver
    // opening a ticket per delivery would open two for one event.
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.event).toBe('automate-stage-opened');
  });

  it('names every recipient on the one delivery', async () => {
    await withTenant(tenantId, (tx) => createEndpoint(tx, provider, anEndpoint()));
    await withTenant(tenantId, (tx) => enqueueOutbox(tx, drafts));

    const delivery = await withTenant(tenantId, (tx) =>
      tx.webhookDelivery.findFirstOrThrow(),
    );
    expect((delivery.payload as { recipients: string[] }).recipients).toEqual([
      'approver@example.com',
      'second@example.com',
    ]);
  });

  it('skips an endpoint that did not subscribe to the event', async () => {
    await withTenant(tenantId, (tx) =>
      createEndpoint(tx, provider, anEndpoint({ events: ['govern-*'] })),
    );
    await withTenant(tenantId, (tx) => enqueueOutbox(tx, drafts));
    expect(await withTenant(tenantId, (tx) => tx.webhookDelivery.count())).toBe(0);
  });

  it('skips a disabled endpoint', async () => {
    const created = await withTenant(tenantId, (tx) =>
      createEndpoint(tx, provider, anEndpoint()),
    );
    await withTenant(tenantId, (tx) =>
      updateEndpoint(tx, provider, created.id, { enabled: false }),
    );
    await withTenant(tenantId, (tx) => enqueueOutbox(tx, drafts));
    expect(await withTenant(tenantId, (tx) => tx.webhookDelivery.count())).toBe(0);
  });

  it('still writes the mail when there is no endpoint at all', async () => {
    // The outbox is the product; webhooks are an addition to it. A tenant
    // with no integration must be entirely unaffected by this code path.
    await withTenant(tenantId, (tx) => enqueueOutbox(tx, drafts));
    expect(await withTenant(tenantId, (tx) => tx.notificationOutbox.count())).toBe(2);
  });

  it('separates two templates enqueued in one call', async () => {
    await withTenant(tenantId, (tx) => createEndpoint(tx, provider, anEndpoint()));
    await withTenant(tenantId, (tx) =>
      enqueueOutbox(tx, [
        ...drafts,
        {
          template: 'automate-fulfilment-failed' as const,
          to: 'ops@example.com',
          vars: {},
          requestId: null,
          userId: null,
        },
      ]),
    );
    const events = await withTenant(tenantId, (tx) =>
      tx.webhookDelivery.findMany({ orderBy: { event: 'asc' }, select: { event: true } }),
    );
    expect(events.map((e) => e.event)).toEqual([
      'automate-fulfilment-failed',
      'automate-stage-opened',
    ]);
  });

  it('makes the first attempt due immediately', async () => {
    await withTenant(tenantId, (tx) => createEndpoint(tx, provider, anEndpoint()));
    const before = new Date();
    await withTenant(tenantId, (tx) => enqueueOutbox(tx, drafts));
    const delivery = await withTenant(tenantId, (tx) =>
      tx.webhookDelivery.findFirstOrThrow(),
    );
    expect(delivery.attempts).toBe(0);
    expect(delivery.nextAttemptAt.getTime()).toBeLessThanOrEqual(before.getTime() + 1000);
  });
});
