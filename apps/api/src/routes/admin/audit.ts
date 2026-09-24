import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PERMISSIONS, listEvents, verifyChain } from '@syntra/core';
import { requireSession } from '../../plugins/require-session.js';
import { requirePermission } from '../../plugins/require-permission.js';

const query = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.coerce.number().int().positive().optional(),
  /**
   * Whose log this is. Repeatable, because a person's log is their own id
   * together with every account linked to them, and the caller reading
   * `GET /persons/:id` already holds that list -- resolving it here would put
   * the person/account relationship inside the audit endpoint, which has no
   * other reason to know about it.
   *
   * `uuid()` is load-bearing rather than tidy: both columns it filters are
   * `uuid`, so an arbitrary string reaches PostgreSQL as a cast failure. A
   * caller who mistypes an id deserves 400 and not 500.
   */
  subject: z
    .preprocess(
      (v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v]),
      z.array(z.string().uuid()),
    )
    .optional(),
  /**
   * Every event recorded in one request or job: the id every log line and
   * (when tracing is on) every span of that request or job carries, and that
   * every response returns in `x-correlation-id`. The same 32-hex format the
   * column's CHECK enforces, so a malformed value is a 400 and not a scan.
   */
  correlation: z.string().regex(/^[0-9a-f]{32}$/).optional(),
});

export async function registerAdminAuditRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.addHook('preHandler', requireSession('admin'));

  app.get(
    '/audit',
    { preHandler: requirePermission(PERMISSIONS.AUDIT_READ) },
    async (request) => {
      const { limit, before, subject, correlation } = query.parse(request.query);

      return request.db(async (tx) => {
        const events = await listEvents(tx, {
          limit,
          before,
          ...(correlation ? { correlationId: correlation } : {}),
          ...(subject ? { subjectIds: subject } : {}),
        });

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
