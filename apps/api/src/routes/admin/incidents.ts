import type { FastifyInstance } from 'fastify';
import { PERMISSIONS, hasPermission, listIncidents, readAttentionSummary, type Permission } from '@syntra/core';
import { requireSession } from '../../plugins/require-session.js';
import { requirePermission, tokenScopeAllows } from '../../plugins/require-permission.js';

/** Who may decide a privileged change request; mirrors `change-control.ts`. */
const CHANGE_APPROVER_PERMISSIONS: Permission[] = [
  PERMISSIONS.TENANT_MANAGE,
  PERMISSIONS.RBAC_MANAGE,
  PERMISSIONS.TOKEN_MANAGE,
];

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
export async function registerAdminIncidentRoutes(
  app: FastifyInstance,
  options: { schedulerRunning?: () => boolean } = {},
): Promise<void> {
  app.addHook('preHandler', requireSession('admin'));

  app.get(
    '/incidents',
    { preHandler: requirePermission(PERMISSIONS.AUDIT_READ) },
    async (request) => {
      const now = new Date();
      const incidents = await request.db((tx) => listIncidents(tx, now));
      if (options.schedulerRunning && !options.schedulerRunning()) {
        incidents.unshift({
          kind: 'scheduler_unavailable',
          severity: 'critical',
          title: 'Background work is unavailable',
          detail: 'The job scheduler has not started. Automatic startup retries are in progress; check the server logs if this persists.',
          count: 1,
          lastAt: null,
          href: '/admin/incidents',
        });
      }
      return {
        incidents: incidents.map((incident) => ({
          ...incident,
          lastAt: incident.lastAt?.toISOString() ?? null,
        })),
      };
    },
  );

  /**
   * Work waiting for a person: provisioning runs held for review, lifecycle
   * operations that failed or wait on read-back verification, and privileged
   * changes waiting for a second administrator.
   *
   * No permission guard of its own, like `/break-glass/status`: the console
   * banner calls it on every page for every administrator. Instead each
   * section is read only when the caller may read what it lists — runs and
   * lifecycle work with `provision.read`, change requests with a permission
   * that could decide one — and a section they may not read comes back
   * `null`, not empty, so it is never mistaken for "nothing waiting".
   */
  app.get('/attention/summary', async (request) => {
    const may = async (permission: Permission) =>
      tokenScopeAllows(request, permission) &&
      (await request.db((tx) => hasPermission(tx, request.session.userId, permission)));
    const provision = await may(PERMISSIONS.PROVISION_READ);
    let changeRequests = false;
    for (const permission of CHANGE_APPROVER_PERMISSIONS) {
      if (await may(permission)) { changeRequests = true; break; }
    }
    const now = new Date();
    const summary = await request.db((tx) => readAttentionSummary(tx, { provision, changeRequests }, now));
    return {
      total: summary.total,
      provisionRuns: summary.provisionRuns && {
        count: summary.provisionRuns.count,
        items: summary.provisionRuns.items.map((item) => ({ ...item, startedAt: item.startedAt.toISOString() })),
      },
      heldActions: summary.heldActions && {
        count: summary.heldActions.count,
        items: summary.heldActions.items.map((item) => ({
          ...item,
          finishedAt: item.finishedAt?.toISOString() ?? null,
        })),
      },
      lifecycle: summary.lifecycle && {
        ...summary.lifecycle,
        items: summary.lifecycle.items.map((item) => ({ ...item, updatedAt: item.updatedAt.toISOString() })),
      },
      changeRequests: summary.changeRequests && {
        count: summary.changeRequests.count,
        items: summary.changeRequests.items.map((item) => ({
          ...item,
          requestedAt: item.requestedAt.toISOString(),
          expiresAt: item.expiresAt.toISOString(),
        })),
      },
    };
  });
}
