import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  BREAK_GLASS_DELAY_BOUNDS,
  BREAK_GLASS_DURATION_BOUNDS,
  BREAK_GLASS_REASON_MIN_LENGTH,
  BREAK_GLASS_REVIEW_MIN_LENGTH,
  BREAK_GLASS_STEP_UP_MAX_AGE_MS,
  BreakGlassRefusedError,
  PERMISSIONS,
  approveBreakGlassActivation,
  breakGlassBanner,
  breakGlassOverview,
  designateBreakGlassAccount,
  endBreakGlassActivation,
  mailBreakGlassNotice,
  reviewBreakGlassActivation,
  revokeBreakGlassAccount,
  rotateBreakGlassCredential,
  setBreakGlassActivationDelay,
  type Transport,
} from '@syntra/core';
import { ProblemError } from '../../plugins/problem-json.js';
import { requirePermission } from '../../plugins/require-permission.js';
import { requireSession } from '../../plugins/require-session.js';

export const breakGlassAccountBody = z.object({ userId: z.string().uuid() }).strict();
export const breakGlassUserParams = z.object({ userId: z.string().uuid() });
export const breakGlassActivationParams = z.object({ id: z.string().uuid() });
export const breakGlassSettingsBody = z.object({
  activationDelayMinutes: z.number().int().min(BREAK_GLASS_DELAY_BOUNDS.min).max(BREAK_GLASS_DELAY_BOUNDS.max),
}).strict();
export const breakGlassReviewBody = z.object({
  notes: z.string().trim().min(BREAK_GLASS_REVIEW_MIN_LENGTH).max(4000),
}).strict();

/** Break-glass refusals keep their own codes for the console to explain. */
export async function breakGlassRefusals<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof BreakGlassRefusedError)) throw error;
    const status = error.code === 'not-found' || error.code === 'not-designated' ? 404
      : error.code === 'invalid-credentials' ? 401
        : error.code === 'self-not-allowed' || error.code === 'step-up-required' ? 403
          : error.code === 'reason-required' || error.code === 'invalid-duration' || error.code === 'invalid-delay' ? 400
            : 409;
    throw new ProblemError(status, error.code, 'Break-glass refused', error.message);
  }
}

export interface BreakGlassRouteOptions { transport: Transport }

/**
 * Emergency access administration: designating accounts, the activation
 * delay, approving, ending and reviewing activations. See
 * `packages/core/src/privileged/break-glass.ts` for the design and the threat
 * model. Requesting an activation is not here: it is unauthenticated by
 * nature and lives at `POST /api/auth/break-glass/activate`.
 *
 * Every route needs `tenant.manage` except the banner, which every
 * administrator's console reads. None accepts a machine token.
 */
export async function registerAdminBreakGlassRoutes(
  app: FastifyInstance,
  options: BreakGlassRouteOptions,
): Promise<void> {
  app.addHook('preHandler', requireSession('admin'));
  const manage = { preHandler: requirePermission(PERMISSIONS.TENANT_MANAGE) };
  const actor = (request: FastifyRequest) => ({
    actorUserId: request.session.userId,
    stepUpAt: request.session.createdAt,
    sourceIp: request.ip,
  });

  /**
   * The console banner. Deliberately open to every administrative session:
   * an emergency activation is something every administrator should see,
   * whatever part of the console they work in.
   */
  app.get('/break-glass/status', async (request) => {
    const banner = await breakGlassBanner(request.tenantId);
    return { ...banner, viewerActivationId: request.session.breakGlassActivationId ?? null };
  });

  app.get('/break-glass', manage, async (request) => ({
    ...(await breakGlassOverview(request.tenantId)),
    viewerUserId: request.session.userId,
    policy: {
      delayBounds: BREAK_GLASS_DELAY_BOUNDS,
      durationBounds: BREAK_GLASS_DURATION_BOUNDS,
      reasonMinLength: BREAK_GLASS_REASON_MIN_LENGTH,
      reviewMinLength: BREAK_GLASS_REVIEW_MIN_LENGTH,
      stepUpMaxAgeMinutes: BREAK_GLASS_STEP_UP_MAX_AGE_MS / 60_000,
    },
  }));

  app.put('/break-glass/settings', manage, async (request) => {
    const body = breakGlassSettingsBody.parse(request.body);
    const minutes = await breakGlassRefusals(() =>
      request.db((tx) => setBreakGlassActivationDelay(tx, body.activationDelayMinutes, actor(request))));
    return { activationDelayMinutes: minutes };
  });

  /** The sealed credential is in this response and nowhere else, ever. */
  app.post('/break-glass/accounts', manage, async (request, reply) => {
    const body = breakGlassAccountBody.parse(request.body);
    const issued = await breakGlassRefusals(() => designateBreakGlassAccount(request.tenantId, body.userId, actor(request)));
    return reply.status(201).header('cache-control', 'no-store').send(issued);
  });

  app.post('/break-glass/accounts/:userId/rotate', manage, async (request, reply) => {
    const { userId } = breakGlassUserParams.parse(request.params);
    const issued = await breakGlassRefusals(() => rotateBreakGlassCredential(request.tenantId, userId, actor(request)));
    return reply.header('cache-control', 'no-store').send(issued);
  });

  app.delete('/break-glass/accounts/:userId', manage, async (request, reply) => {
    const { userId } = breakGlassUserParams.parse(request.params);
    await breakGlassRefusals(() => revokeBreakGlassAccount(request.tenantId, userId, actor(request)));
    return reply.status(204).send();
  });

  /** Four-eyes early activation: a different administrator, stepped up. */
  app.post('/break-glass/activations/:id/approve', manage, async (request) => {
    const { id } = breakGlassActivationParams.parse(request.params);
    const notice = await breakGlassRefusals(() => approveBreakGlassActivation(request.tenantId, id, actor(request)));
    await mailBreakGlassNotice(options.transport, request.tenantId, notice, 'activated', (error, purpose) =>
      request.log.error({ err: error, purpose }, 'notification not delivered'));
    const { tenantId: _tenantId, ...activation } = notice.activation;
    return { activation };
  });

  /** Cancels a pending activation, or ends an active one early. */
  app.post('/break-glass/activations/:id/end', manage, async (request) => {
    const { id } = breakGlassActivationParams.parse(request.params);
    const row = await breakGlassRefusals(() => endBreakGlassActivation(request.tenantId, id, {
      actorUserId: request.session.userId, sourceIp: request.ip,
    }));
    const { tenantId: _tenantId, ...activation } = row;
    return { activation };
  });

  app.post('/break-glass/activations/:id/review', manage, async (request) => {
    const { id } = breakGlassActivationParams.parse(request.params);
    const body = breakGlassReviewBody.parse(request.body);
    const row = await breakGlassRefusals(() => reviewBreakGlassActivation(request.tenantId, id, { ...actor(request), notes: body.notes }));
    const { tenantId: _tenantId, ...activation } = row;
    return { activation };
  });
}
