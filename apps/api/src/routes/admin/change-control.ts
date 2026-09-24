import type { FastifyInstance, FastifyRequest } from 'fastify';
import { invalidateProvider } from '@syntra/protocols';
import { z } from 'zod';
import {
  CHANGE_REQUEST_REASON_MIN_LENGTH,
  CHANGE_REQUEST_STEP_UP_MAX_AGE_MS,
  CHANGE_REQUEST_WINDOW_MS,
  ChangeRequestRefusedError,
  PERMISSIONS,
  PRIVILEGED_CHANGE_CLASSES,
  PRIVILEGED_CHANGE_CLASS_INFO,
  PRIVILEGED_PERMISSIONS,
  TENANT_SETTINGS_OPERATION,
  approvePrivilegedChange,
  hasPermission,
  listPrivilegedChanges,
  readChangeControlPolicy,
  rejectPrivilegedChange,
  setChangeControlPolicy,
  withdrawPrivilegedChange,
  type MasterKeyProvider,
  type Permission,
} from '@syntra/core';
import { ProblemError } from '../../plugins/problem-json.js';
import { declareGuardPermissions, requirePermission } from '../../plugins/require-permission.js';
import { requireSession } from '../../plugins/require-session.js';
import {
  buildPrivilegedChangeHandlers,
  changeReason,
  heldReply,
  presentChangeRequest,
} from '../../privileged-changes.js';

export const changeRequestParams = z.object({ id: z.string().uuid() });
export const changeControlPolicyBody = z.object({
  classes: z.array(z.enum(PRIVILEGED_CHANGE_CLASSES)).max(PRIVILEGED_CHANGE_CLASSES.length),
}).strict();
export const changeDecisionBody = z.object({
  note: z.string().trim().max(1000).nullable().optional(),
}).strict();

export interface ChangeControlRouteOptions {
  keyProvider: MasterKeyProvider;
  outboundAllowPrivate: boolean;
}

const APPROVER_PERMISSIONS: Permission[] = [PERMISSIONS.TENANT_MANAGE, PERMISSIONS.RBAC_MANAGE, PERMISSIONS.TOKEN_MANAGE];

/**
 * Somebody who could approve at least one class. The class a request
 * belongs to is checked again by core at decision time, against the
 * permission that class needs -- this guard only keeps the queue away from
 * administrators who could decide nothing on it.
 */
const approverGuard = declareGuardPermissions(async function approverGuard(request: FastifyRequest) {
  const held = await request.db(async (tx) => {
    for (const permission of APPROVER_PERMISSIONS) {
      if (await hasPermission(tx, request.session.userId, permission)) return true;
    }
    return false;
  });
  if (!held) {
    throw new ProblemError(403, 'forbidden', 'Forbidden', `Requires one of ${APPROVER_PERMISSIONS.join(', ')}`);
  }
}, ...APPROVER_PERMISSIONS);

/**
 * Separation of duties for privileged administrative changes: the policy and
 * the queue of held changes. See `packages/core/src/privileged/change-control.ts`.
 *
 * Every route is refused to machine tokens (`TOKEN_DENIED_ROUTES`): a second
 * pair of eyes that could be a script is not one, and approval needs a
 * stepped-up session a token can never have.
 */
export async function registerAdminChangeControlRoutes(
  app: FastifyInstance,
  options: ChangeControlRouteOptions,
): Promise<void> {
  app.addHook('preHandler', requireSession('admin'));
  const handlers = buildPrivilegedChangeHandlers(options);

  const refusals = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof ChangeRequestRefusedError)) throw error;
      const status = error.code === 'not-found' ? 404
        : error.code === 'four-eyes-required' || error.code === 'step-up-required' || error.code === 'forbidden' ? 403
          : error.code === 'reason-required' || error.code === 'unknown-class' ? 400
            : 409;
      throw new ProblemError(status, error.code, 'Change request refused', error.message);
    }
  };

  app.get('/change-control', { preHandler: approverGuard }, async (request) => {
    const [classes, requests] = await Promise.all([
      request.db((tx) => readChangeControlPolicy(tx)),
      listPrivilegedChanges(request.tenantId),
    ]);
    return {
      classes,
      catalog: PRIVILEGED_CHANGE_CLASSES.map((key) => ({ key, ...PRIVILEGED_CHANGE_CLASS_INFO[key] })),
      privilegedPermissions: PRIVILEGED_PERMISSIONS,
      requests: requests.map(presentChangeRequest),
      viewerUserId: request.session.userId,
      policy: {
        approvalWindowHours: CHANGE_REQUEST_WINDOW_MS / 3_600_000,
        stepUpMaxAgeMinutes: CHANGE_REQUEST_STEP_UP_MAX_AGE_MS / 60_000,
        reasonMinLength: CHANGE_REQUEST_REASON_MIN_LENGTH,
      },
    };
  });

  /**
   * Turning a class ON applies at once. Turning one OFF is itself held for a
   * second administrator -- the first thing a lone administrator bent on a
   * privileged change would otherwise do is switch the control off.
   */
  app.put(
    '/change-control/policy',
    { preHandler: requirePermission(PERMISSIONS.TENANT_MANAGE) },
    async (request, reply) => {
      const body = changeControlPolicyBody.parse(request.body);
      const outcome = await refusals(() => request.db((tx) => setChangeControlPolicy(tx, body.classes, {
        actorUserId: request.session.userId, sourceIp: request.ip, reason: changeReason(request),
      })));
      if (outcome.held) return heldReply(reply, outcome.request);
      return { classes: outcome.classes };
    },
  );

  /**
   * Approval applies the change. The response carries what the direct route
   * would have returned -- for a token or a new webhook endpoint that
   * includes its secret, shown to the approver once and stored nowhere.
   */
  app.post(
    '/change-control/requests/:id/approve',
    { preHandler: approverGuard },
    async (request) => {
      const { id } = changeRequestParams.parse(request.params);
      const body = changeDecisionBody.parse(request.body ?? {});
      const { request: row, result } = await refusals(() => approvePrivilegedChange(request.tenantId, id, {
        actorUserId: request.session.userId,
        stepUpAt: request.session.createdAt,
        satisfiedFactor: request.session.satisfiedFactor,
        sourceIp: request.ip,
        note: body.note,
      }, handlers));
      // A held settings change may have moved a hostname. Rebuilding the OIDC
      // provider is cheap and approvals are rare, so it is not worth
      // computing whether it did.
      if (row.operation === TENANT_SETTINGS_OPERATION) invalidateProvider(request.tenantId);
      return { changeRequest: presentChangeRequest(row), result };
    },
  );

  app.post(
    '/change-control/requests/:id/reject',
    { preHandler: approverGuard },
    async (request) => {
      const { id } = changeRequestParams.parse(request.params);
      const body = changeDecisionBody.parse(request.body ?? {});
      const row = await refusals(() => rejectPrivilegedChange(request.tenantId, id, {
        actorUserId: request.session.userId, sourceIp: request.ip, note: body.note,
      }));
      return { changeRequest: presentChangeRequest(row) };
    },
  );

  /** Only the requester. Withdrawal applies nothing and decides nothing. */
  app.post(
    '/change-control/requests/:id/withdraw',
    { preHandler: approverGuard },
    async (request) => {
      const { id } = changeRequestParams.parse(request.params);
      const row = await refusals(() => withdrawPrivilegedChange(request.tenantId, id, {
        actorUserId: request.session.userId, sourceIp: request.ip,
      }));
      return { changeRequest: presentChangeRequest(row) };
    },
  );
}
