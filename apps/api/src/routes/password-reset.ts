import type { FastifyInstance } from 'fastify';
import {
  resetCompleteRequest,
  resetPreflightRequest,
  resetPreflightResponse,
  resetRequestRequest,
} from '@syntra/contracts';
import {
  completePasswordReset,
  preflightPasswordReset,
  requestPasswordReset,
  type Transport,
} from '@syntra/core';
import { ProblemError } from '../plugins/problem-json.js';
import { perTenantRateLimit } from '../plugins/rate-limit.js';
import { tenantRelyingParty } from './relying-party.js';

export interface PasswordResetRouteOptions {
  transport: Transport;
  publicUrl: string;
  /** Attempts per minute, per tenant per address. */
  authRateLimitMax: number;
  /** Attempts per minute for the whole tenant, across every address. */
  authRateLimitTenantMax: number;
}

export async function registerPasswordResetRoutes(
  app: FastifyInstance,
  options: PasswordResetRouteOptions,
): Promise<void> {
  // Guessing a reset token is only expensive if the guesses are rationed, and
  // the request form is a free outbound-mail button for anyone who finds it.
  // Both get the rate the password endpoints already use.
  const LIMIT = {
    config: {
      rateLimit: { max: options.authRateLimitMax, timeWindow: '1 minute' },
    },
    onRequest: perTenantRateLimit(app, options.authRateLimitTenantMax),
  };

  app.post('/request', { ...LIMIT }, async (request, reply) => {
    const body = resetRequestRequest.parse(request.body);

    // Awaited, and it always resolves. The status and the body are fixed
    // before the call is made — nothing about what happened inside reaches the
    // response, and the call itself is padded to a fixed floor so its duration
    // does not either. Sending the mail is queued inside, off this path.
    await requestPasswordReset(request.tenantId, options.transport, options.publicUrl, {
      login: body.login,
      sourceIp: request.ip,
    });

    return reply.status(202).send({ ok: true });
  });

  app.post('/preflight', { ...LIMIT }, async (request) => {
    const body = resetPreflightRequest.parse(request.body);
    const result = await preflightPasswordReset(request.tenantId, body.token);
    return resetPreflightResponse.parse(
      result.valid
        ? result
        : { valid: false, requiresFactor: false, acceptableFactors: [] },
    );
  });

  app.post('/complete', { ...LIMIT }, async (request, reply) => {
    const body = resetCompleteRequest.parse(request.body);
    const tenant = await request.db((tx) =>
      tx.tenant.findUniqueOrThrow({ where: { id: request.tenantId } }),
    );

    const factor =
      body.factor === undefined
        ? undefined
        : body.factor.type === 'webauthn'
          ? ({ type: 'webauthn', assertion: body.factor.assertion } as const)
          : ({ type: body.factor.type, code: body.factor.code } as const);

    const outcome = await completePasswordReset(request.tenantId, options.transport, {
      token: body.token,
      newPassword: body.newPassword,
      ...(factor === undefined ? {} : { factor }),
      // From the tenant, not the request. A WebAuthn assertion presented to
      // complete a reset is verified against the tenant's own origin, the same
      // as everywhere else — this endpoint is unauthenticated, so it is the
      // last place that should trust a header.
      relyingParty: tenantRelyingParty(tenant, options.publicUrl),
      sourceIp: request.ip,
    });

    if (outcome.ok) return reply.status(204).send();

    if (outcome.reason === 'weak_password') {
      throw new ProblemError(
        400,
        'weak-password',
        'That password does not meet the policy',
        outcome.detail === 'too_short'
          ? 'Choose a longer password.'
          : outcome.detail === 'too_long'
            ? 'Choose a shorter password.'
            : 'Choose something less predictable than your own name or login.',
      );
    }
    if (outcome.reason === 'factor_required') {
      throw new ProblemError(
        400,
        'factor-required',
        'A second factor is required',
        'This account has a second factor registered, so resetting the password needs it too.',
      );
    }
    if (outcome.reason === 'factor_invalid') {
      throw new ProblemError(400, 'factor-invalid', 'That second factor was not accepted');
    }
    // Unknown, spent and expired all land here and read the same.
    throw new ProblemError(
      400,
      'invalid-reset-token',
      'That reset link is no longer usable',
      'Request a new one.',
    );
  });
}
