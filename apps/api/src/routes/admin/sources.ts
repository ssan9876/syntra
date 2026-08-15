import type { FastifyInstance } from 'fastify';
import { createSourceRequest, idParam, setMappingsRequest } from '@syntra/contracts';
import { ldapConnector } from '@syntra/connectors';
import {
  PERMISSIONS,
  createSource,
  listSources,
  localMasterKeyProvider,
  mappingsFor,
  previewRun,
  recordEvent,
  setMappings,
  sourceWithPassword,
  type MappingRule,
} from '@syntra/core';
import { ProblemError } from '../../plugins/problem-json.js';
import { requireSession } from '../../plugins/require-session.js';
import { requirePermission } from '../../plugins/require-permission.js';

export interface SourceRouteOptions {
  masterKey: Buffer;
}

export async function registerAdminSourceRoutes(
  app: FastifyInstance,
  options: SourceRouteOptions,
): Promise<void> {
  const provider = localMasterKeyProvider(options.masterKey);

  app.addHook('preHandler', requireSession('admin'));

  app.get(
    '/sources',
    { preHandler: requirePermission(PERMISSIONS.SYNC_READ) },
    async (request) => ({ sources: await request.db((tx) => listSources(tx)) }),
  );

  app.post(
    '/sources',
    { preHandler: requirePermission(PERMISSIONS.SYNC_MANAGE) },
    async (request, reply) => {
      const body = createSourceRequest.parse(request.body);

      const source = await request.db(async (tx) => {
        const created = await createSource(tx, provider, body);
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'source.create',
          targetType: 'DirectorySource',
          targetId: created.id,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { name: created.name },
        });
        return created;
      });

      // The row carries only the secret's name; the password itself is in the
      // vault and is never echoed.
      return reply.status(201).send(source);
    },
  );

  app.put(
    '/sources/:id/mappings',
    { preHandler: requirePermission(PERMISSIONS.SYNC_MANAGE) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const { rules } = setMappingsRequest.parse(request.body);

      await request.db(async (tx) => {
        try {
          await setMappings(tx, id, rules as MappingRule[]);
        } catch (cause) {
          throw new ProblemError(
            400,
            'invalid-mappings',
            'Invalid mappings',
            cause instanceof Error ? cause.message : undefined,
          );
        }
      });

      return { rules: await request.db((tx) => mappingsFor(tx, id)) };
    },
  );

  app.post(
    '/sources/:id/test',
    { preHandler: requirePermission(PERMISSIONS.SYNC_READ) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const config = await request.db((tx) =>
        sourceWithPassword(tx, provider, id),
      );
      if (!config) throw new ProblemError(404, 'not-found', 'Source not found');

      // A failed connection is a result, not a server error: the operator
      // needs the message, not a 500.
      return ldapConnector.test(config);
    },
  );

  app.post(
    '/sources/:id/run',
    { preHandler: requirePermission(PERMISSIONS.SYNC_MANAGE) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      // previewRun takes a tenantId, not a caller's transaction: it opens its
      // own transactions internally, one per phase, so it can durably mark a
      // failed run even after the read/diff work has aborted a transaction.
      return previewRun(request.tenantId, provider, id);
    },
  );
}
