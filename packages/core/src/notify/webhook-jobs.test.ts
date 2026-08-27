import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { localMasterKeyProvider } from '../vault/master-key.js';
import { enqueueOutbox } from '../automate/notify.js';
import { createEndpoint } from './webhook-service.js';
import { verifyWebhook } from './webhook-signature.js';
import { WEBHOOK_MAX_ATTEMPTS, RETRY_DELAYS_MS } from './webhook-retry.js';
import { runWebhookJob, type PostAttempt, type WebhookPoster } from './webhook-jobs.js';

const provider = localMasterKeyProvider(Buffer.alloc(32, 3));
let tenantId: string;
let secret: string;

/** Records what was posted and answers with whatever the test dictates. */
function poster(...answers: PostAttempt[]): WebhookPoster & { calls: { url: string; body: string; headers: Record<string, string> }[] } {
  const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
  let i = 0;
  const fn = async (url: string, body: string, headers: Record<string, string>) => {
    calls.push({ url, body, headers });
    return answers[Math.min(i++, answers.length - 1)] ?? { status: 200 };
  };
  return Object.assign(fn, { calls });
}

const drafts = [
  {
    template: 'automate-stage-opened' as const,
    to: 'approver@example.com',
    vars: { productName: 'Finance' },
    requestId: null,
    userId: null,
  },
];

/**
 * Queues one delivery and, when the test drives a fixed clock, makes it due at
 * that clock's time.
 *
 * `enqueueWebhooks` stamps `nextAttemptAt` from the real clock, so a test whose
 * `now` is a fixed instant would otherwise be racing today's actual time of
 * day: the sender reads `nextAttemptAt <= now`, and half the day that read
 * returns nothing.
 */
async function queueOne(due?: Date) {
  const created = await withTenant(tenantId, (tx) =>
    createEndpoint(tx, provider, {
      name: 'Ticketing',
      url: 'https://hooks.example.com/syntra',
      enabled: true,
      events: [],
    }),
  );
  secret = created.secret;
  await withTenant(tenantId, (tx) => enqueueOutbox(tx, drafts));
  if (due) {
    await withTenant(tenantId, (tx) =>
      tx.webhookDelivery.updateMany({ data: { nextAttemptAt: due } }),
    );
  }
  return created;
}

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
});

describe('runWebhookJob', () => {
  it('posts the stored body and marks the row delivered', async () => {
    await queueOne();
    const post = poster({ status: 200 });

    const result = await runWebhookJob(provider, { tenantId }, { poster: post });

    expect(result).toEqual({ delivered: 1, failed: 0, abandoned: 0 });
    expect(post.calls[0]!.url).toBe('https://hooks.example.com/syntra');
    const row = await withTenant(tenantId, (tx) => tx.webhookDelivery.findFirstOrThrow());
    expect(row.deliveredAt).not.toBeNull();
    expect(row.lastStatus).toBe(200);
  });

  it('signs the body it actually sent', async () => {
    await queueOne();
    const post = poster({ status: 200 });
    await runWebhookJob(provider, { tenantId }, { poster: post });

    const { body, headers } = post.calls[0]!;
    expect(
      verifyWebhook(secret, body, headers['x-syntra-signature']!, new Date()),
    ).toBe(true);
    // The delivery id is inside the signed body, so a receiver can discard a
    // duplicate without trusting an unsigned header to tell it which one.
    const row = await withTenant(tenantId, (tx) => tx.webhookDelivery.findFirstOrThrow());
    expect(JSON.parse(body).id).toBe(row.id);
  });

  it('names the event and the delivery in headers a receiver can route on', async () => {
    await queueOne();
    const post = poster({ status: 200 });
    await runWebhookJob(provider, { tenantId }, { poster: post });

    const { headers } = post.calls[0]!;
    expect(headers['content-type']).toBe('application/json');
    expect(headers['x-syntra-event']).toBe('automate-stage-opened');
    expect(headers['x-syntra-delivery']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('schedules a retry after a server error', async () => {
    const now = new Date('2026-08-26T12:00:00.000Z');
    await queueOne(now);
    const result = await runWebhookJob(
      provider,
      { tenantId },
      { poster: poster({ status: 503 }), now },
    );

    expect(result).toEqual({ delivered: 0, failed: 1, abandoned: 0 });
    const row = await withTenant(tenantId, (tx) => tx.webhookDelivery.findFirstOrThrow());
    expect(row.attempts).toBe(1);
    expect(row.deliveredAt).toBeNull();
    expect(row.nextAttemptAt.getTime()).toBe(now.getTime() + RETRY_DELAYS_MS[0]!);
  });

  it('does not retry a refusal the receiver understood', async () => {
    await queueOne();
    const result = await runWebhookJob(
      provider,
      { tenantId },
      { poster: poster({ status: 400 }) },
    );

    expect(result).toEqual({ delivered: 0, failed: 0, abandoned: 1 });
    const row = await withTenant(tenantId, (tx) => tx.webhookDelivery.findFirstOrThrow());
    // Spent, so the sender's read will not pick it up again — but the row is
    // still here, saying what the receiver said.
    expect(row.attempts).toBe(WEBHOOK_MAX_ATTEMPTS);
    expect(row.lastStatus).toBe(400);
  });

  it('retries a transport failure that never got a status', async () => {
    await queueOne();
    const result = await runWebhookJob(
      provider,
      { tenantId },
      { poster: poster({ error: 'ECONNREFUSED' }) },
    );

    expect(result).toEqual({ delivered: 0, failed: 1, abandoned: 0 });
    const row = await withTenant(tenantId, (tx) => tx.webhookDelivery.findFirstOrThrow());
    expect(row.lastStatus).toBeNull();
    expect(row.lastError).toContain('ECONNREFUSED');
  });

  it('leaves a row alone until its retry is due', async () => {
    const now = new Date('2026-08-26T12:00:00.000Z');
    await queueOne(now);
    await runWebhookJob(provider, { tenantId }, { poster: poster({ status: 503 }), now });

    const post = poster({ status: 200 });
    const result = await runWebhookJob(
      provider,
      { tenantId },
      { poster: post, now: new Date(now.getTime() + 1000) },
    );
    expect(result).toEqual({ delivered: 0, failed: 0, abandoned: 0 });
    expect(post.calls).toHaveLength(0);
  });

  it('gives up once the attempts are spent, and says so in the audit trail', async () => {
    let now = new Date('2026-08-26T12:00:00.000Z');
    await queueOne(now);
    for (let i = 0; i < WEBHOOK_MAX_ATTEMPTS; i += 1) {
      await runWebhookJob(provider, { tenantId }, { poster: poster({ status: 503 }), now });
      now = new Date(now.getTime() + 86_400_000);
    }

    const row = await withTenant(tenantId, (tx) => tx.webhookDelivery.findFirstOrThrow());
    expect(row.attempts).toBe(WEBHOOK_MAX_ATTEMPTS);
    expect(row.deliveredAt).toBeNull();

    // Through withTenant, or row-level security hides the audit row and the
    // assertion holds no matter what the job did.
    const event = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findFirst({ where: { action: 'notify.webhook_abandoned' } }),
    );
    expect(event).not.toBeNull();
    expect(event!.outcome).toBe('failure');
  });

  it('does not send a delivery whose endpoint has been switched off since', async () => {
    const created = await queueOne();
    await withTenant(tenantId, (tx) =>
      tx.webhookEndpoint.update({ where: { id: created.id }, data: { enabled: false } }),
    );
    const post = poster({ status: 200 });
    await runWebhookJob(provider, { tenantId }, { poster: post });
    expect(post.calls).toHaveLength(0);
  });

  it('reports the status and nothing the receiver said', async () => {
    // `PostAttempt` carries no body field at all, so there is nowhere for a
    // response body to arrive — the guarantee is structural rather than a
    // discipline the write path has to keep. The console shows `lastError`,
    // and a response body echoed into it would turn a webhook into a way to
    // read whatever the server can reach.
    await queueOne();
    await runWebhookJob(provider, { tenantId }, { poster: poster({ status: 500 }) });
    const row = await withTenant(tenantId, (tx) => tx.webhookDelivery.findFirstOrThrow());
    expect(row.lastStatus).toBe(500);
    expect(row.lastError).toBe('the receiver answered 500');
  });

  it('waits as long as a throttled receiver asked', async () => {
    const now = new Date('2026-08-26T12:00:00.000Z');
    await queueOne(now);
    await runWebhookJob(
      provider,
      { tenantId },
      { poster: poster({ status: 429, retryAfterMs: 600_000 }), now },
    );
    const row = await withTenant(tenantId, (tx) => tx.webhookDelivery.findFirstOrThrow());
    // Ten minutes, not the thirty seconds our own schedule would have used.
    expect(row.nextAttemptAt.getTime()).toBe(now.getTime() + 600_000);
  });

  it('will not let a receiver shorten the backoff', async () => {
    // `Retry-After: 1` against a struggling receiver is a tight loop. The
    // header may push a retry later, never sooner.
    const now = new Date('2026-08-26T12:00:00.000Z');
    await queueOne(now);
    await runWebhookJob(
      provider,
      { tenantId },
      { poster: poster({ status: 429, retryAfterMs: 1000 }), now },
    );
    const row = await withTenant(tenantId, (tx) => tx.webhookDelivery.findFirstOrThrow());
    expect(row.nextAttemptAt.getTime()).toBe(now.getTime() + RETRY_DELAYS_MS[0]!);
  });

  it('does nothing at all for a tenant with no deliveries', async () => {
    const post = poster({ status: 200 });
    const result = await runWebhookJob(provider, { tenantId }, { poster: post });
    expect(result).toEqual({ delivered: 0, failed: 0, abandoned: 0 });
    expect(post.calls).toHaveLength(0);
  });
});
