import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  INCIDENT_KINDS,
  PERMISSIONS,
  RESOLVABLE_INCIDENTS,
  acknowledgeIncident,
  hasPermission,
  listIncidents,
  readAttentionSummary,
  recordEvent,
  resolveIncident,
  type IncidentKind,
  type Permission,
} from '@syntra/core';
import { ProblemError } from '../../plugins/problem-json.js';
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
 * Acknowledge and resolve exist, and neither can make the page look clean
 * while it is not:
 *
 *  - ACKNOWLEDGE hides nothing. The incident stays, marked with who is on it,
 *    and the mark lapses the moment something newer happens.
 *  - RESOLVE is offered only for EVENTS -- runs that failed, messages never
 *    sent -- and is a watermark: what happened up to now is dealt with, and a
 *    new failure brings the incident straight back. A CONDITION (a target
 *    skipping its runs, an expired credential) cannot be resolved; it goes
 *    when it is fixed and not before.
 *
 * Acknowledging needs only `AUDIT_READ`, like reading. Resolving needs the
 * management permission of the area the failures are in, because it is a
 * decision that they need no further action.
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
      // Names for whoever acknowledged, read once. An id on screen is
      // something the reader has to go and look up.
      const ackBy = [
        ...new Set(incidents.map((i) => i.acknowledged?.byUserId).filter((id): id is string => !!id)),
      ];
      const names = new Map(
        (ackBy.length === 0
          ? []
          : await request.db((tx) =>
              tx.user.findMany({ where: { id: { in: ackBy } }, select: { id: true, displayName: true } }),
            )
        ).map((u) => [u.id, u.displayName]),
      );
      if (options.schedulerRunning && !options.schedulerRunning()) {
        incidents.unshift({
          kind: 'scheduler_unavailable',
          severity: 'critical',
          title: 'Background work is unavailable',
          detail: 'The job scheduler has not started. Automatic startup retries are in progress; check the server logs if this persists.',
          count: 1,
          lastAt: null,
          href: '/admin/operations',
          items: [],
          resolvable: false,
          acknowledged: null,
        });
      }
      return {
        incidents: incidents.map((incident) => ({
          ...incident,
          lastAt: incident.lastAt?.toISOString() ?? null,
          items: incident.items.map((item) => ({ ...item, at: item.at?.toISOString() ?? null })),
          acknowledged: incident.acknowledged && {
            at: incident.acknowledged.at.toISOString(),
            by: incident.acknowledged.byUserId
              ? (names.get(incident.acknowledged.byUserId) ?? null)
              : null,
            note: incident.acknowledged.note,
          },
        })),
      };
    },
  );

  const kindParam = z.object({ kind: z.enum(INCIDENT_KINDS as [IncidentKind, ...IncidentKind[]]) });
  const noteBody = z
    .object({ note: z.string().trim().max(500).optional() })
    .strict()
    .default({});

  app.post(
    '/incidents/:kind/acknowledge',
    { preHandler: requirePermission(PERMISSIONS.AUDIT_READ) },
    async (request, reply) => {
      const { kind } = kindParam.parse(request.params);
      const { note } = noteBody.parse(request.body ?? {});
      await request.db(async (tx) => {
        await acknowledgeIncident(tx, request.tenantId, kind, request.session.userId, note || null, new Date());
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'incident.acknowledged',
          targetType: 'Incident',
          targetId: null,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { kind, note: note || null },
        });
      });
      return reply.status(204).send();
    },
  );

  /** The area whose management permission resolving a kind of incident needs. */
  const RESOLVE_PERMISSION: Partial<Record<IncidentKind, Permission>> = {
    provision_run_failed: PERMISSIONS.PROVISION_MANAGE,
    sync_run_failed: PERMISSIONS.SYNC_MANAGE,
    webhook_undelivered: PERMISSIONS.TENANT_MANAGE,
    notification_undelivered: PERMISSIONS.TENANT_MANAGE,
    task_failing: PERMISSIONS.AUTOMATE_MANAGE,
  };

  app.post(
    '/incidents/:kind/resolve',
    { preHandler: requirePermission(PERMISSIONS.AUDIT_READ) },
    async (request, reply) => {
      const { kind } = kindParam.parse(request.params);
      const { note } = noteBody.parse(request.body ?? {});
      if (!(RESOLVABLE_INCIDENTS as readonly string[]).includes(kind)) {
        throw new ProblemError(
          409,
          'incident-not-resolvable',
          'This clears when it is fixed',
          'It is a condition that is still true, not an event that is over. Acknowledge it instead, and it goes when the cause is fixed.',
        );
      }
      const needed = RESOLVE_PERMISSION[kind]!;
      const allowed =
        tokenScopeAllows(request, needed) &&
        (await request.db((tx) => hasPermission(tx, request.session.userId, needed)));
      if (!allowed) {
        throw new ProblemError(403, 'forbidden', 'Not allowed', `Resolving this needs ${needed}.`);
      }
      await request.db(async (tx) => {
        await resolveIncident(tx, request.tenantId, kind, request.session.userId, note || null, new Date());
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'incident.resolved',
          targetType: 'Incident',
          targetId: null,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { kind, note: note || null },
        });
      });
      return reply.status(204).send();
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
