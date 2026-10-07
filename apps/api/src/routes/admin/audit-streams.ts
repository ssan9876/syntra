import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AuditStreamInvalidError,
  PERMISSIONS,
  createAuditStream,
  deleteAuditStream,
  listAuditStreamDeliveries,
  listAuditStreams,
  recordEvent,
  replayAuditStream,
  testAuditStream,
  updateAuditStream,
  type AuditStreamView,
  type MasterKeyProvider,
} from '@syntra/core';
import { ProblemError } from '../../plugins/problem-json.js';
import { requireSession } from '../../plugins/require-session.js';
import { requirePermission } from '../../plugins/require-permission.js';

export interface AuditStreamRouteOptions {
  keyProvider: MasterKeyProvider;
  allowPrivateAddresses: boolean;
  /** PUBLIC_URL's host, stamped on every event sent. */
  host: string;
  version: string;
}

export const idParam = z.object({ id: z.string().uuid() });

export const auditStreamBody = z.object({
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean().default(true),
  transport: z.enum(['https', 'syslog']),
  format: z.enum(['json', 'splunk-hec', 'cef']),
  url: z.string().trim().max(2048).nullish(),
  host: z.string().trim().max(253).nullish(),
  port: z.number().int().min(1).max(65535).nullish(),
  tls: z.boolean().optional(),
  authHeader: z.string().trim().max(64).nullish(),
  /** The header's value. Omitted keeps the stored one; null removes it. Never read back. */
  credential: z.string().max(4096).nullish(),
  startFrom: z.enum(['now', 'beginning']).optional(),
  /** Only events whose action starts with one of these. Empty or omitted: every event. */
  actionPrefixes: z.array(z.string().max(100)).max(50).optional(),
  /** Only events with this outcome. Null or omitted: both. */
  outcome: z.enum(['success', 'failure']).nullish(),
});

export const auditStreamReplayBody = z.discriminatedUnion('from', [
  z.object({ from: z.literal('beginning') }),
  z.object({ from: z.literal('now') }),
  z.object({ from: z.literal('sequence'), sequence: z.number().int().min(1) }),
  z.object({ from: z.literal('time'), at: z.string().datetime({ offset: true }) }),
]);

export const auditStreamDeliveriesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

/**
 * SIEM destinations for the tenant's audit log (Settings -> SIEM).
 *
 * `tenant.manage`: a stream sends every audit event of the tenant to an
 * address outside Syntra, which is a decision about the tenant's data rather
 * than about reading it.
 */
export async function registerAdminAuditStreamRoutes(
  app: FastifyInstance,
  options: AuditStreamRouteOptions,
): Promise<void> {
  app.addHook('preHandler', requireSession('admin'));
  const guard = { preHandler: requirePermission(PERMISSIONS.TENANT_MANAGE) };
  const policy = { allowPrivateAddresses: options.allowPrivateAddresses };

  const destination = (stream: AuditStreamView) =>
    stream.transport === 'https' ? stream.url : `${stream.host}:${stream.port}`;

  const audit = (request: FastifyRequest, action: string, stream: AuditStreamView, extra: Record<string, unknown> = {}) =>
    request.db((tx) =>
      recordEvent(tx, {
        actorUserId: request.session.userId,
        action,
        targetType: 'AuditStream',
        targetId: stream.id,
        outcome: 'success',
        sourceIp: request.ip,
        payload: {
          name: stream.name,
          transport: stream.transport,
          format: stream.format,
          destination: destination(stream),
          enabled: stream.enabled,
          actionPrefixes: stream.actionPrefixes,
          outcome: stream.outcome,
          ...extra,
        },
      }),
    );

  const invalid = (cause: unknown): never => {
    if (cause instanceof AuditStreamInvalidError) {
      throw new ProblemError(400, 'invalid-audit-stream', 'Stream refused', cause.message, {
        errors: [{ path: cause.field, message: cause.message }],
      });
    }
    throw cause;
  };

  app.get('/audit-streams', guard, async (request) => ({
    streams: await request.db((tx) => listAuditStreams(tx)),
  }));

  app.post('/audit-streams', guard, async (request, reply) => {
    const body = auditStreamBody.parse(request.body);
    const stream = await request
      .db((tx) => createAuditStream(tx, options.keyProvider, body, policy))
      .catch(invalid);
    await audit(request, 'audit.stream_created', stream);
    return reply.status(201).send({ stream });
  });

  app.put('/audit-streams/:id', guard, async (request) => {
    const { id } = idParam.parse(request.params);
    const body = auditStreamBody.parse(request.body);
    const stream = await request
      .db((tx) => updateAuditStream(tx, options.keyProvider, id, body, policy))
      .catch(invalid);
    if (!stream) throw new ProblemError(404, 'not-found', 'Stream not found');
    await audit(request, 'audit.stream_updated', stream);
    return { stream };
  });

  app.delete('/audit-streams/:id', guard, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const existing = (await request.db((tx) => listAuditStreams(tx))).find((stream) => stream.id === id);
    if (!existing) throw new ProblemError(404, 'not-found', 'Stream not found');
    await request.db((tx) => deleteAuditStream(tx, id));
    await audit(request, 'audit.stream_deleted', existing);
    return reply.status(204).send();
  });

  app.get('/audit-streams/:id/deliveries', guard, async (request) => {
    const { id } = idParam.parse(request.params);
    const { limit } = auditStreamDeliveriesQuery.parse(request.query);
    const deliveries = await request.db((tx) => listAuditStreamDeliveries(tx, id, limit));
    if (!deliveries) throw new ProblemError(404, 'not-found', 'Stream not found');
    return { deliveries };
  });

  app.post('/audit-streams/:id/replay', guard, async (request) => {
    const { id } = idParam.parse(request.params);
    const body = auditStreamReplayBody.parse(request.body);
    const replay = body.from === 'time' ? { from: 'time' as const, at: new Date(body.at) } : body;
    const result = await request.db((tx) => replayAuditStream(tx, id, replay)).catch(invalid);
    if (!result) throw new ProblemError(404, 'not-found', 'Stream not found');
    await audit(request, 'audit.stream_replayed', result.stream, {
      from: body.from,
      previousCursor: result.previousCursor,
      cursor: result.stream.cursor,
    });
    return { stream: result.stream };
  });

  app.post('/audit-streams/:id/test', guard, async (request) => {
    const { id } = idParam.parse(request.params);
    const existing = (await request.db((tx) => listAuditStreams(tx))).find((stream) => stream.id === id);
    if (!existing) throw new ProblemError(404, 'not-found', 'Stream not found');
    try {
      await testAuditStream(options.keyProvider, request.tenantId, id, {
        allowPrivateAddresses: options.allowPrivateAddresses,
        host: options.host,
        version: options.version,
      });
    } catch (cause) {
      throw new ProblemError(
        422,
        'audit-stream-test-failed',
        'Test event not accepted',
        `${destination(existing)}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    return { ok: true };
  });
}
