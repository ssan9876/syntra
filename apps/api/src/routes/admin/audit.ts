import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PERMISSIONS, listEvents, verifyChain } from '@syntra/core';
import { requireSession } from '../../plugins/require-session.js';
import { requirePermission } from '../../plugins/require-permission.js';

const query = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.coerce.number().int().positive().optional(),
});

export async function registerAdminAuditRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.addHook('preHandler', requireSession('admin'));

  app.get(
    '/audit',
    { preHandler: requirePermission(PERMISSIONS.AUDIT_READ) },
    async (request) => {
      const { limit, before } = query.parse(request.query);

      return request.db(async (tx) => {
        const events = await listEvents(tx, { limit, before });

        // Verification travels with the page. Serving entries without saying
        // whether the chain still holds would present a tampered log as
        // trustworthy, which is worse than having no log at all.
        const chain = await verifyChain(tx);

        return {
          events,
          chainValid: chain.valid,
          ...(chain.valid ? {} : { brokenAtSequence: chain.brokenAtSequence }),
        };
      });
    },
  );
}
