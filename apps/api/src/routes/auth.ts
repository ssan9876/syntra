import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { elevateRequest, loginRequest } from '@syntra/contracts';
import {
  authenticate,
  createSession,
  isAdministrator,
  permissionsForUser,
  recordEvent,
  revokeSession,
  type SessionScope,
} from '@syntra/core';
import { ProblemError } from '../plugins/problem-json.js';
import { requireSession, SESSION_COOKIE } from '../plugins/require-session.js';

const SECURE = process.env.NODE_ENV === 'production';

const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax' as const,
  path: '/',
  secure: SECURE,
};

/** Password endpoints are limited far more tightly than ordinary reads. */
function passwordRateLimit(max: number) {
  return { rateLimit: { max, timeWindow: '1 minute' } };
}

async function sessionBody(
  request: FastifyRequest,
  userId: string,
  scope: SessionScope,
) {
  const user = await request.db((tx) =>
    tx.user.findUnique({ where: { id: userId } }),
  );
  const permissions = await request.db((tx) => permissionsForUser(tx, userId));

  return {
    userId,
    displayName: user?.displayName ?? '',
    scope,
    mayElevate: permissions.size > 0,
    permissions: [...permissions],
  };
}

export interface AuthRouteOptions {
  authRateLimitMax: number;
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  options: AuthRouteOptions,
): Promise<void> {
  const PASSWORD_RATE_LIMIT = passwordRateLimit(options.authRateLimitMax);

  app.post('/login', { config: PASSWORD_RATE_LIMIT }, async (request, reply) => {
    const body = loginRequest.parse(request.body);

    const result = await request.db((tx) =>
      authenticate(tx, { ...body, sourceIp: request.ip }),
    );

    // Every failure reason collapses into one response. Which of them applied
    // is recorded in the audit log, where an administrator can see it and an
    // attacker cannot.
    if (!result.ok) {
      throw new ProblemError(401, 'invalid-credentials', 'Invalid credentials');
    }

    const { token } = await request.db((tx) =>
      createSession(tx, result.userId, 'portal'),
    );
    reply.setCookie(SESSION_COOKIE, token, cookieOptions);

    return sessionBody(request, result.userId, 'portal');
  });

  app.post(
    '/elevate',
    { preHandler: requireSession('portal'), config: PASSWORD_RATE_LIMIT },
    async (request, reply) => {
      const body = elevateRequest.parse(request.body);
      const { userId } = request.session;

      const admin = await request.db((tx) => isAdministrator(tx, userId));
      if (!admin) {
        throw new ProblemError(
          403,
          'not-an-administrator',
          'Not an administrator',
        );
      }

      const user = await request.db((tx) =>
        tx.user.findUnique({ where: { id: userId } }),
      );
      if (!user) {
        throw new ProblemError(401, 'unauthenticated', 'Unauthenticated');
      }

      // The password is re-entered rather than trusted from the existing
      // session: elevation is a fresh authentication, not a flag flip.
      const recheck = await request.db((tx) =>
        authenticate(tx, {
          login: user.login,
          password: body.password,
          sourceIp: request.ip,
        }),
      );
      if (!recheck.ok) {
        throw new ProblemError(
          401,
          'invalid-credentials',
          'Invalid credentials',
        );
      }

      const { token } = await request.db((tx) =>
        createSession(tx, userId, 'admin'),
      );
      await request.db((tx) =>
        recordEvent(tx, {
          actorUserId: userId,
          action: 'auth.elevate',
          targetType: 'Session',
          targetId: null,
          outcome: 'success',
          sourceIp: request.ip,
          payload: {},
        }),
      );

      reply.setCookie(SESSION_COOKIE, token, cookieOptions);
      return sessionBody(request, userId, 'admin');
    },
  );

  app.get(
    '/session',
    { preHandler: requireSession('portal') },
    async (request) => {
      const { userId, scope } = request.session;
      return sessionBody(request, userId, scope);
    },
  );

  app.post(
    '/logout',
    { preHandler: requireSession('portal') },
    async (request, reply: FastifyReply) => {
      const token = request.cookies[SESSION_COOKIE]!;
      await request.db((tx) => revokeSession(tx, token));
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return { ok: true };
    },
  );
}
