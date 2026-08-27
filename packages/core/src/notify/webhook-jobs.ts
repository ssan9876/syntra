import { prisma, withTenant } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import type { Scheduler } from '../jobs/scheduler.js';
import type { MasterKeyProvider } from '../vault/master-key.js';
import { webhookBody, type WebhookEvent } from './webhook-event.js';
import { classifyStatus, nextAttemptAt, WEBHOOK_MAX_ATTEMPTS } from './webhook-retry.js';
import { signWebhook } from './webhook-signature.js';
import { endpointSecret } from './webhook-service.js';
import { guardedFetch } from '../net/guarded-fetch.js';

export const WEBHOOK_DELIVER_JOB = 'notify.webhook';

export interface WebhookJobPayload {
  tenantId: string;
}

export function webhookJobPayload(tenantId: string): WebhookJobPayload {
  return { tenantId };
}

export function webhookScheduleKey(tenantId: string): string {
  // Slashes, not colons: pg-boss's `assertObjectName` refuses a colon and the
  // refusal is swallowed by the scheduler's caller. See
  // `jobs/schedule-key.test.ts`.
  return `webhook/deliver/${tenantId}`;
}

/**
 * The result of one attempt: either the receiver answered with a status, or
 * the request never got that far.
 *
 * A union rather than a status of 0, because "the receiver said 500" and "we
 * could not reach the receiver" are different facts and the console shows a
 * different thing for each.
 */
export type PostAttempt =
  | {
      status: number;
      /**
       * What the receiver asked for, in milliseconds, where it said.
       *
       * Honoured on a throttle. A receiver answering 429 with `Retry-After:
       * 300` is applying backpressure explicitly, and retrying it in thirty
       * seconds because that is what our own schedule says is hammering
       * somebody who asked us not to.
       */
      retryAfterMs?: number;
    }
  | { error: string };

export type WebhookPoster = (
  url: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number,
) => Promise<PostAttempt>;

/** How long one delivery may take before it counts as a failure. */
export const WEBHOOK_TIMEOUT_MS = 10_000;

/**
 * The real poster.
 *
 * `guardedFetch` rather than the global `fetch`, and that is the whole of the
 * server-side-request-forgery story for this feature. An administrator types
 * the URL and the SERVER makes the request, from inside a network that
 * administrator may not be able to reach — so the delivery goes through the
 * same guard every other administrator-supplied URL in this product goes
 * through, which resolves the name, classifies every address it answers with,
 * and then PINS the socket to the address it classified. Checking a name and
 * then handing the name to a socket leaves a rebinding window; pinning closes
 * it. It also refuses redirects, which is the other way a checked URL becomes
 * an unchecked one.
 *
 * The response body is read only to be discarded. Nothing about it reaches the
 * row, the console or the log — a webhook whose response text came back to an
 * administrator's screen would be a way to read any HTTP endpoint the server
 * can reach.
 */
export function httpPoster(allowPrivateAddresses: boolean): WebhookPoster {
  const send = guardedFetch({ allowPrivateAddresses, timeoutMs: WEBHOOK_TIMEOUT_MS });
  return async (url, body, headers, timeoutMs) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await send(url, {
        method: 'POST',
        body,
        headers,
        signal: controller.signal,
      });
      return { status: response.status };
    } catch (cause) {
      // Everything the guard refuses arrives here too: a private address, a
      // redirect, a name that will not resolve. All of them are "this did not
      // get delivered", and all of them are worth retrying, because all of
      // them can be fixed by an administrator without a new event.
      return { error: cause instanceof Error ? cause.message : String(cause) };
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * `Retry-After` in seconds, where the receiver sent a sane one.
 *
 * Only the delta-seconds form. The HTTP-date form is legal and almost never
 * used by an API, and parsing a date from an untrusted header to compute a
 * delay against our own clock is a way to be told to wait until next year.
 * Anything else is ignored and the built-in schedule applies.
 */
function retryAfterSeconds(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (raw === null) return undefined;
  if (!/^\d+$/.test(raw.trim())) return undefined;
  const seconds = Number(raw.trim());
  // Capped at a day. A receiver asking for a year is a receiver whose header
  // nobody should be following literally.
  return Number.isFinite(seconds) ? Math.min(seconds, 86_400) : undefined;
}

export interface WebhookJobOptions {
  now?: Date;
  poster?: WebhookPoster;
  batchSize?: number;
  allowPrivateAddresses?: boolean;
}

/**
 * Sends the deliveries that are due.
 *
 * The same three-phase shape as `runOutboxJob`, and for the same reason: read
 * the rows out, do the network with NO transaction held, write the results
 * back in one short transaction. An HTTP round trip inside
 * `prisma.$transaction` is a P2028 against Prisma's 5000 ms budget waiting for
 * the first slow receiver, and it has already shipped as a defect on this
 * project twice.
 *
 * The secret is read in phase one, alongside the rows, because reading it
 * needs a transaction and signing does not.
 */
export async function runWebhookJob(
  provider: MasterKeyProvider,
  payload: WebhookJobPayload,
  options: WebhookJobOptions = {},
): Promise<{ delivered: number; failed: number; abandoned: number }> {
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? 100;
  const post = options.poster ?? httpPoster(options.allowPrivateAddresses ?? true);

  const tenant = await prisma.tenant.findUnique({
    where: { id: payload.tenantId },
    select: { id: true },
  });
  if (tenant === null) return { delivered: 0, failed: 0, abandoned: 0 };

  // Phase 1: read out, with the endpoint and its secret.
  const work = await withTenant(payload.tenantId, async (tx) => {
    const rows = await tx.webhookDelivery.findMany({
      where: {
        deliveredAt: null,
        nextAttemptAt: { lte: now },
        attempts: { lt: WEBHOOK_MAX_ATTEMPTS },
        // Read here rather than filtered afterwards: an endpoint switched off
        // while its deliveries were queued should stop sending, not drain.
        endpoint: { enabled: true },
      },
      orderBy: { nextAttemptAt: 'asc' },
      take: batchSize,
      include: { endpoint: { select: { id: true, url: true } } },
    });

    const secrets = new Map<string, string | null>();
    for (const row of rows) {
      if (secrets.has(row.endpoint.id)) continue;
      secrets.set(row.endpoint.id, await endpointSecret(tx, provider, row.endpoint.id));
    }
    return { rows, secrets };
  });

  if (work.rows.length === 0) return { delivered: 0, failed: 0, abandoned: 0 };

  // Phase 2: the network. No transaction is held.
  const results: { id: string; attempt: PostAttempt }[] = [];
  for (const row of work.rows) {
    const secret = work.secrets.get(row.endpoint.id);
    if (!secret) {
      // The endpoint exists and its secret does not. Signing with a
      // placeholder would send a delivery every receiver correctly rejects,
      // five times; saying so is the only useful thing left.
      results.push({
        id: row.id,
        attempt: { error: 'no signing secret is stored for this endpoint — rotate it' },
      });
      continue;
    }

    // No address check here. `httpPoster` goes through `guardedFetch`, which
    // checks the address it is about to connect to and then connects to that
    // one — strictly stronger than anything that could be checked from here,
    // where the answer could still be stale by the time the socket opens.

    // Rebuilt through `webhookBody` from the stored payload rather than
    // `JSON.stringify`d here, so the key order is the one `webhookBody`
    // defines. The signature covers these exact bytes, and a body serialised
    // any other way verifies nowhere.
    const body = webhookBody(row.payload as unknown as WebhookEvent);
    const attempt = await post(
      row.endpoint.url,
      body,
      {
        'content-type': 'application/json',
        'user-agent': 'Syntra',
        'x-syntra-event': row.event,
        'x-syntra-delivery': row.id,
        'x-syntra-signature': signWebhook(secret, body, now),
      },
      WEBHOOK_TIMEOUT_MS,
    );
    results.push({ id: row.id, attempt });
  }

  // Phase 3: write the results back.
  let delivered = 0;
  let failed = 0;
  const abandoned: { id: string; event: string; endpointId: string; reason: string }[] = [];

  await withTenant(payload.tenantId, async (tx) => {
    for (const { id, attempt } of results) {
      const row = work.rows.find((r) => r.id === id)!;
      const status = 'status' in attempt ? attempt.status : null;
      const outcome = status === null ? 'retry' : classifyStatus(status);

      if (outcome === 'delivered') {
        await tx.webhookDelivery.update({
          where: { id },
          data: { deliveredAt: now, attempts: row.attempts + 1, lastStatus: status, lastError: null },
        });
        delivered += 1;
        continue;
      }

      // `permanent` spends every remaining attempt at once. The row stops
      // being picked up without needing a second column to say why, and the
      // status it stopped on is still on it.
      const attempts = outcome === 'permanent' ? WEBHOOK_MAX_ATTEMPTS : row.attempts + 1;
      const scheduled = nextAttemptAt(attempts, now);
      // The receiver's own answer wins over our schedule, but only to push the
      // retry LATER. A `Retry-After: 1` must not shorten the backoff into a
      // tight loop against a struggling receiver.
      const asked =
        'retryAfterMs' in attempt && attempt.retryAfterMs !== undefined
          ? new Date(now.getTime() + attempt.retryAfterMs)
          : null;
      const due =
        scheduled === null
          ? null
          : asked !== null && asked > scheduled
            ? asked
            : scheduled;
      const lastError =
        'error' in attempt
          ? attempt.error
          : // NEVER the response body. See `httpPoster`.
            `the receiver answered ${status}`;

      await tx.webhookDelivery.update({
        where: { id },
        data: {
          attempts,
          lastStatus: status,
          lastError,
          // Left where it was when there will be no next attempt, so the
          // column keeps saying when the last one was tried.
          ...(due === null ? {} : { nextAttemptAt: due }),
        },
      });

      if (due === null) {
        abandoned.push({
          id,
          event: row.event,
          endpointId: row.endpoint.id,
          reason: lastError,
        });
      } else {
        failed += 1;
      }
    }
  });

  // Audited outside the update transaction: `recordEvent` takes a per-tenant
  // advisory lock, and holding it across every write of a hundred-row batch
  // would serialise the whole sender behind the audit chain.
  for (const row of abandoned) {
    await withTenant(payload.tenantId, (tx) =>
      recordEvent(tx, {
        actorUserId: null,
        action: 'notify.webhook_abandoned',
        targetType: 'WebhookEndpoint',
        targetId: row.endpointId,
        outcome: 'failure',
        sourceIp: null,
        // An integration that has quietly stopped receiving is the failure
        // this whole subsystem is most likely to have, and the least likely
        // to be noticed. It goes in the trail somebody already reads.
        payload: { deliveryId: row.id, event: row.event, reason: row.reason },
      }),
    );
  }

  return { delivered, failed, abandoned: abandoned.length };
}

export function registerWebhookJobs(
  scheduler: Scheduler,
  provider: MasterKeyProvider,
  options: { allowPrivateAddresses?: boolean } = {},
): void {
  scheduler.register<WebhookJobPayload>(WEBHOOK_DELIVER_JOB, async (payload) => {
    await runWebhookJob(provider, payload, {
      allowPrivateAddresses: options.allowPrivateAddresses ?? true,
    });
  });
}

/**
 * Every minute.
 *
 * Not configurable per tenant, unlike the Automate schedules. The cadence is
 * the floor on how late a delivery can be, not a policy anybody has an opinion
 * about, and a tenant that set it to hourly would have built a queue that
 * looks broken.
 */
export async function applyWebhookSchedule(
  scheduler: Scheduler,
  tenantId: string,
): Promise<void> {
  await scheduler.schedule(
    WEBHOOK_DELIVER_JOB,
    '* * * * *',
    webhookJobPayload(tenantId),
    webhookScheduleKey(tenantId),
  );
}
