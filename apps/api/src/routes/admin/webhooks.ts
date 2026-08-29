import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  webhookCreateRequest,
  webhookDeliveryListResponse,
  webhookListResponse,
  webhookSecretResponse,
  webhookUpdateRequest,
} from '@syntra/contracts';
import {
  PERMISSIONS,
  WEBHOOK_MAX_ATTEMPTS,
  createEndpoint,
  deleteEndpoint,
  listEndpoints,
  localMasterKeyProvider,
  recordEvent,
  rotateEndpointSecret,
  updateEndpoint,
  type EndpointView,
} from '@syntra/core';
import { ProblemError } from '../../plugins/problem-json.js';
import { requirePermission } from '../../plugins/require-permission.js';
import { requireSession } from '../../plugins/require-session.js';

export interface WebhookRouteOptions {
  masterKey: Buffer;
  /** From `OUTBOUND_ALLOW_PRIVATE`. See `assertOutboundUrl`. */
  outboundAllowPrivate: boolean;
}

/**
 * Outbound webhooks: where a tenant tells another system what happened here.
 *
 * `TENANT_MANAGE` rather than a permission of its own. An endpoint is tenant
 * configuration in the same sense the mail settings are, and it confers no
 * authority over anything — the deliveries carry what Syntra was already
 * mailing to people. A new permission would need backfilling into every
 * built-in role for no separation anybody asked for.
 */
export async function registerAdminWebhookRoutes(
  app: FastifyInstance,
  options: WebhookRouteOptions,
): Promise<void> {
  app.addHook('preHandler', requireSession('admin'));
  const provider = localMasterKeyProvider(options.masterKey);
  const guard = { allowPrivateNetworks: options.outboundAllowPrivate };
  const manage = { preHandler: requirePermission(PERMISSIONS.TENANT_MANAGE) };

  /**
   * Turns the refusals from `assertOutboundUrl` into a 400 the form can show
   * against the URL field.
   *
   * Rethrown untouched otherwise. A unique-name clash and a database failure
   * are not the same thing as a bad address, and flattening them all into one
   * message is how a 500 comes to read like a validation error.
   */
  const asProblem = (cause: unknown): never => {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (
      message.includes('only http and https') ||
      message.includes('not a usable address') ||
      message.includes('resolves') ||
      message.includes('put the credential in a header')
    ) {
      throw new ProblemError(400, 'unusable-url', 'That address cannot be used', message);
    }
    throw cause;
  };

  /**
   * The counts the list screen shows beside each endpoint.
   *
   * One grouped query for every endpoint rather than one per endpoint: the
   * page renders a health chip per row, and a query per row is how a settings
   * page becomes slow the moment somebody has ten integrations.
   *
   * A single `GROUP BY "endpointId"`, with Postgres's aggregate `FILTER`
   * doing the pending/failing split and the "most recent failure" max in the
   * same pass, rather than pulling every undelivered row and doing that
   * filtering and sorting per endpoint in JS.
   */
  const withHealth = async (request: FastifyRequest, endpoints: EndpointView[]) => {
    if (endpoints.length === 0) return [];
    const rows = await request.db(
      (tx) => tx.$queryRaw<
        { endpointId: string; pending: number; failing: number; lastFailureAt: Date | null }[]
      >`
        SELECT "endpointId",
          COUNT(*) FILTER (WHERE "attempts" < ${WEBHOOK_MAX_ATTEMPTS})::int AS "pending",
          COUNT(*) FILTER (WHERE "attempts" >= ${WEBHOOK_MAX_ATTEMPTS})::int AS "failing",
          MAX("createdAt") FILTER (WHERE "lastError" IS NOT NULL) AS "lastFailureAt"
        FROM "WebhookDelivery"
        WHERE "deliveredAt" IS NULL
        GROUP BY "endpointId"
      `,
    );
    const byEndpoint = new Map(rows.map((row) => [row.endpointId, row]));
    return endpoints.map((endpoint) => {
      const health = byEndpoint.get(endpoint.id);
      return {
        ...endpoint,
        createdAt: endpoint.createdAt.toISOString(),
        updatedAt: endpoint.updatedAt.toISOString(),
        pending: health?.pending ?? 0,
        failing: health?.failing ?? 0,
        lastFailureAt: health?.lastFailureAt?.toISOString() ?? null,
      };
    });
  };

  app.get('/webhooks', manage, async (request) => {
    const endpoints = await request.db((tx) => listEndpoints(tx));
    return webhookListResponse.parse({ endpoints: await withHealth(request, endpoints) });
  });

  app.post('/webhooks', manage, async (request, reply) => {
    const body = webhookCreateRequest.parse(request.body);

    const created = await request
      .db((tx) => createEndpoint(tx, provider, body, guard))
      .catch(asProblem);

    await request.db((tx) =>
      recordEvent(tx, {
        actorUserId: request.session.userId,
        action: 'notify.webhook_created',
        targetType: 'WebhookEndpoint',
        targetId: created.id,
        outcome: 'success',
        sourceIp: request.ip,
        // The URL, deliberately, and never the secret. Where a tenant's
        // notifications are being sent is exactly the kind of change an
        // auditor needs to be able to find later.
        payload: { name: created.name, url: created.url, events: created.events },
      }),
    );

    const { secret, ...endpoint } = created;
    return reply.status(201).send(
      webhookSecretResponse.parse({
        endpoint: (await withHealth(request, [endpoint]))[0],
        secret,
      }),
    );
  });

  app.put('/webhooks/:id', manage, async (request) => {
    const { id } = request.params as { id: string };
    const body = webhookUpdateRequest.parse(request.body);

    const saved = await request
      .db((tx) => updateEndpoint(tx, provider, id, body, guard))
      .catch(asProblem);

    await request.db((tx) =>
      recordEvent(tx, {
        actorUserId: request.session.userId,
        action: 'notify.webhook_updated',
        targetType: 'WebhookEndpoint',
        targetId: id,
        outcome: 'success',
        sourceIp: request.ip,
        payload: { name: saved.name, url: saved.url, events: saved.events, enabled: saved.enabled },
      }),
    );

    return (await withHealth(request, [saved]))[0];
  });

  app.post('/webhooks/:id/secret', manage, async (request) => {
    const { id } = request.params as { id: string };
    const secret = await request.db((tx) => rotateEndpointSecret(tx, provider, id));

    await request.db((tx) =>
      recordEvent(tx, {
        actorUserId: request.session.userId,
        action: 'notify.webhook_secret_rotated',
        targetType: 'WebhookEndpoint',
        targetId: id,
        outcome: 'success',
        sourceIp: request.ip,
        payload: {},
      }),
    );

    const [endpoint] = await request.db((tx) => listEndpoints(tx)).then((all) =>
      all.filter((e) => e.id === id),
    );
    return webhookSecretResponse.parse({
      endpoint: (await withHealth(request, [endpoint!]))[0],
      secret,
    });
  });

  app.delete('/webhooks/:id', manage, async (request, reply) => {
    const { id } = request.params as { id: string };
    await request.db((tx) => deleteEndpoint(tx, id));

    await request.db((tx) =>
      recordEvent(tx, {
        actorUserId: request.session.userId,
        action: 'notify.webhook_deleted',
        targetType: 'WebhookEndpoint',
        targetId: id,
        outcome: 'success',
        sourceIp: request.ip,
        payload: {},
      }),
    );

    return reply.status(204).send();
  });

  /**
   * The recent deliveries for one endpoint.
   *
   * This is the answer to "the integration stopped working" — the question the
   * whole `WebhookDelivery` table exists to make answerable. Capped, newest
   * first; nobody debugging reads past the first screen.
   */
  app.get('/webhooks/:id/deliveries', manage, async (request) => {
    const { id } = request.params as { id: string };
    const rows = await request.db((tx) =>
      tx.webhookDelivery.findMany({
        where: { endpointId: id },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    );

    return webhookDeliveryListResponse.parse({
      deliveries: rows.map((row) => ({
        id: row.id,
        event: row.event,
        attempts: row.attempts,
        maxAttempts: WEBHOOK_MAX_ATTEMPTS,
        nextAttemptAt: row.nextAttemptAt.toISOString(),
        deliveredAt: row.deliveredAt?.toISOString() ?? null,
        lastStatus: row.lastStatus,
        lastError: row.lastError,
        createdAt: row.createdAt.toISOString(),
        // Decided here rather than in the browser, so the list screen's chip
        // and any future screen cannot disagree about what "failed" means.
        state:
          row.deliveredAt !== null
            ? ('delivered' as const)
            : row.attempts >= WEBHOOK_MAX_ATTEMPTS
              ? ('failed' as const)
              : ('queued' as const),
      })),
    });
  });

  /**
   * Puts a spent delivery back in the queue.
   *
   * Resets the attempts rather than creating a new row, so the history stays
   * one line per event rather than one per time somebody pressed the button —
   * and so "this was retried by hand" is visible in the attempt count instead
   * of being lost.
   */
  app.post('/webhooks/:id/deliveries/:deliveryId/retry', manage, async (request) => {
    const { id, deliveryId } = request.params as { id: string; deliveryId: string };
    const updated = await request.db((tx) =>
      tx.webhookDelivery.updateMany({
        where: { id: deliveryId, endpointId: id, deliveredAt: null },
        data: { attempts: 0, nextAttemptAt: new Date(), lastError: null },
      }),
    );
    if (updated.count === 0) {
      throw new ProblemError(
        404,
        'no-such-delivery',
        'That delivery cannot be retried',
        'It has already been delivered, or it belongs to another endpoint.',
      );
    }
    return { ok: true };
  });
}
