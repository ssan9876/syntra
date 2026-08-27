import type { FastifyInstance } from 'fastify';
import { PERMISSIONS, listIncidents } from '@syntra/core';
import { requireSession } from '../../plugins/require-session.js';
import { requirePermission } from '../../plugins/require-permission.js';

/**
 * What has quietly stopped working.
 *
 * `AUDIT_READ`, not a management permission. Everything here is already
 * visible to somebody — on the webhooks page, the targets list, the outbox —
 * and this route only gathers it. Gating the summary harder than its parts
 * would mean the person who noticed something was wrong could not see what.
 *
 * There is deliberately no acknowledge, snooze or dismiss. Every entry
 * disappears when the thing behind it is fixed and not before, so the page
 * cannot be made to look clean by anybody except by making it true.
 */
export async function registerAdminIncidentRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireSession('admin'));

  app.get(
    '/incidents',
    { preHandler: requirePermission(PERMISSIONS.AUDIT_READ) },
    async (request) => {
      const now = new Date();
      const incidents = await request.db((tx) => listIncidents(tx, now));
      return {
        incidents: incidents.map((incident) => ({
          ...incident,
          lastAt: incident.lastAt?.toISOString() ?? null,
        })),
      };
    },
  );
}
