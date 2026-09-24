import type { FastifyInstance } from 'fastify';
import { auditSavedViewBody, auditSearchQuery, idParam } from '@syntra/contracts';
import {
  PERMISSIONS,
  SavedViewLimitError,
  deleteSavedView,
  listSavedViews,
  saveView,
  searchAuditEvents,
  verifyChain,
} from '@syntra/core';
import { ProblemError } from '../../plugins/problem-json.js';
import { requireSession } from '../../plugins/require-session.js';
import { requirePermission } from '../../plugins/require-permission.js';

/**
 * The audit log, searched on the server (backlog #73).
 *
 * Every filter is applied in SQL and the page is a keyset read on `sequence`
 * -- see `audit-search.ts` for why neither may be done any other way on a log
 * that grows for ever. The response carries `nextBefore`, the cursor for the
 * next (older) page, or null when there is none.
 *
 * "Export these results" is not here: it is `POST /exports` with kind
 * `audit_log` and these same filters as its `params`, so the file is generated
 * by a background job, sealed, watermarked and audited, and the request that
 * asked for it returns at once.
 */
export async function registerAdminAuditRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.addHook('preHandler', requireSession('admin'));

  app.get(
    '/audit',
    { preHandler: requirePermission(PERMISSIONS.AUDIT_READ) },
    async (request) => {
      const q = auditSearchQuery.parse(request.query);

      return request.db(async (tx) => {
        const page = await searchAuditEvents(
          tx,
          {
            actorUserId: q.actor,
            actionPrefix: q.action,
            targetId: q.target,
            targetType: q.targetType,
            outcome: q.outcome,
            correlationId: q.correlation,
            from: q.from === undefined ? undefined : new Date(q.from),
            to: q.to === undefined ? undefined : new Date(q.to),
            // Whose log this is: done by or to any of these ids. See
            // `listEvents` for why an empty list matches nothing.
            ...(q.subject ? { subjectIds: q.subject } : {}),
          },
          { before: q.before, limit: q.limit },
        );

        // Verification travels with the page. Serving entries without saying
        // whether the chain still holds would present a tampered log as
        // trustworthy, which is worse than having no log at all.
        const chain = await verifyChain(tx);

        return {
          events: page.events,
          nextBefore: page.nextBefore,
          chainValid: chain.valid,
          ...(chain.valid ? {} : { brokenAtSequence: chain.brokenAtSequence }),
        };
      });
    },
  );

  // ---- saved searches: filters only, private to the administrator --------

  app.get(
    '/audit/views',
    { preHandler: requirePermission(PERMISSIONS.AUDIT_READ) },
    async (request) => ({
      views: await request.db((tx) => listSavedViews(tx, request.session.userId)),
    }),
  );

  app.put(
    '/audit/views',
    { preHandler: requirePermission(PERMISSIONS.AUDIT_READ) },
    async (request) => {
      const body = auditSavedViewBody.parse(request.body ?? {});
      try {
        const view = await request.db((tx) =>
          saveView(tx, request.tenantId, request.session.userId, body.name, body.filters),
        );
        return { view };
      } catch (cause) {
        if (cause instanceof SavedViewLimitError) {
          throw new ProblemError(409, 'saved-view-limit', 'Too many saved searches', cause.message);
        }
        throw cause;
      }
    },
  );

  app.delete(
    '/audit/views/:id',
    { preHandler: requirePermission(PERMISSIONS.AUDIT_READ) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const deleted = await request.db((tx) => deleteSavedView(tx, request.session.userId, id));
      if (!deleted) throw new ProblemError(404, 'not-found', 'Saved search not found');
      return reply.status(204).send();
    },
  );
}
