import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { elevateRequest, loginRequest } from '@syntra/contracts';
import {
  authorize,
  createSession,
  isAdministrator,
  permissionsForUser,
  recordEvent,
  revokeSession,
  type SessionScope,
} from '@syntra/core';
import { ProblemError } from '../plugins/problem-json.js';
import { requireSession, SESSION_COOKIE } from '../plugins/require-session.js';
import { perTenantRateLimit } from '../plugins/rate-limit.js';
import { tenantRelyingParty } from './relying-party.js';

const SECURE = process.env.NODE_ENV === 'production';

const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax' as const,
  path: '/',
  secure: SECURE,
};

/**
 * Password endpoints are limited far more tightly than ordinary reads, and in
 * two dimensions at once: per tenant per address, and per tenant across every
 * address. Spelled as a route-options fragment because the second limit is an
 * onRequest hook — a route may carry only one `config.rateLimit`.
 */
function passwordRateLimit(app: FastifyInstance, options: AuthRouteOptions) {
  return {
    config: {
      rateLimit: {
        max: options.authRateLimitMax,
        timeWindow: '1 minute',
      },
    },
    onRequest: perTenantRateLimit(app, options.authRateLimitTenantMax),
  };
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
  /** Attempts per minute, per tenant per address. */
  authRateLimitMax: number;
  /** Attempts per minute for the whole tenant, across every address. */
  authRateLimitTenantMax: number;
  /**
   * The deployment's own base URL. The relying party's scheme and port come
   * from here rather than from the request, because behind a TLS-terminating
   * proxy the request reports `http` and a wrong expected origin fails every
   * WebAuthn assertion.
   */
  publicUrl: string;
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  options: AuthRouteOptions,
): Promise<void> {
  const PASSWORD_RATE_LIMIT = passwordRateLimit(app, options);

  const relyingPartyFor = async (request: FastifyRequest) => {
    const tenant = await request.db((tx) =>
      tx.tenant.findUniqueOrThrow({ where: { id: request.tenantId } }),
    );
    return { tenant, rp: tenantRelyingParty(tenant, options.publicUrl) };
  };

  app.post('/login', { ...PASSWORD_RATE_LIMIT }, async (request, reply) => {
    const body = loginRequest.parse(request.body);
    const { rp } = await relyingPartyFor(request);

    const result = await authorize(request.tenantId, {
      kind: 'primary',
      principal: { kind: 'password', login: body.login, password: body.password },
      applicationId: null,
      sourceIp: request.ip,
      relyingParty: rp,
      scope: 'portal',
    });

    // Every failure reason collapses into one response. Which of them applied
    // is recorded in the audit log, where an administrator can see it and an
    // attacker cannot — a policy denial must not be distinguishable from a
    // wrong password, or the policy itself becomes an oracle.
    if (result.status === 'deny') {
      throw new ProblemError(401, 'invalid-credentials', 'Invalid credentials');
    }

    if (result.status === 'challenge') {
      return reply.status(200).send({
        status: 'challenge',
        attemptToken: result.attemptToken,
        expiresAt: result.expiresAt.toISOString(),
        acceptableFactors: result.acceptableFactors,
      });
    }

    // The password was right and the policy wants a factor this user does not
    // have. They are not signed in — no cookie is set — and the token they get
    // back buys exactly one thing: enrolling a factor of the required kind.
    if (result.status === 'enrol') {
      return reply.status(200).send({
        status: 'enrol',
        attemptToken: result.attemptToken,
        expiresAt: result.expiresAt.toISOString(),
        enrollableFactors: result.enrollableFactors,
      });
    }

    const { token } = await request.db((tx) =>
      createSession(tx, result.userId, result.scope, result.satisfiedFactor),
    );
    reply.setCookie(SESSION_COOKIE, token, cookieOptions);

    return {
      status: 'authenticated',
      ...(await sessionBody(request, result.userId, result.scope)),
    };
  });

  app.post(
    '/elevate',
    { preHandler: requireSession('portal'), ...PASSWORD_RATE_LIMIT },
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

      const { rp } = await relyingPartyFor(request);

      // The password is re-entered rather than trusted from the existing
      // session: elevation is a fresh authentication, not a flag flip.
      const decision = await authorize(request.tenantId, {
        kind: 'primary',
        principal: {
          kind: 'password',
          login: user.login,
          password: body.password,
        },
        applicationId: null,
        sourceIp: request.ip,
        relyingParty: rp,
        // The scope stamped on any attempt opened here, and the scope of the
        // session issued at the end of it. Recorded, never inferred.
        scope: 'admin',
      });

      if (decision.status === 'deny') {
        throw new ProblemError(
          401,
          'invalid-credentials',
          'Invalid credentials',
        );
      }
      if (decision.status === 'challenge') {
        return reply.status(200).send({
          status: 'challenge',
          attemptToken: decision.attemptToken,
          expiresAt: decision.expiresAt.toISOString(),
          acceptableFactors: decision.acceptableFactors,
        });
      }
      if (decision.status === 'enrol') {
        return reply.status(200).send({
          status: 'enrol',
          attemptToken: decision.attemptToken,
          expiresAt: decision.expiresAt.toISOString(),
          enrollableFactors: decision.enrollableFactors,
        });
      }

      const { token } = await request.db((tx) =>
        createSession(tx, userId, decision.scope, decision.satisfiedFactor),
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
      return {
        status: 'authenticated',
        ...(await sessionBody(request, userId, 'admin')),
      };
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
