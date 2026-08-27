import type { FastifyInstance } from 'fastify';
import {
  resetCompleteRequest,
  resetPreflightRequest,
  resetPreflightResponse,
  resetRequestRequest,
} from '@syntra/contracts';
import {
  beginWebAuthnAuthentication,
  completePasswordReset,
  preflightPasswordReset,
  requestPasswordReset,
  userForResetToken,
  type Transport,
} from '@syntra/core';
import { ProblemError } from '../plugins/problem-json.js';
import { passwordRejectionMessage } from './password-rejection.js';
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

  /**
   * A WebAuthn challenge for somebody holding a reset link.
   *
   * WITHOUT THIS ROUTE a passkey-only user cannot complete a password reset at
   * all. `completePasswordReset` verifies the assertion against a stored
   * challenge, and the only endpoint that minted one required a live
   * `AuthAttempt` -- which exists after a password has been accepted, not
   * after a link has been opened. The reset flow holds a `PasswordResetToken`,
   * so the lookup always missed, the answer was 401, and somebody whose only
   * factor is a passkey and whose recovery codes were spent had no way back
   * that did not go through an administrator.
   *
   * Deliberately a second endpoint rather than a second credential accepted by
   * the first. The two are authenticated by different things, and an endpoint
   * that takes either is how a reset token comes to satisfy a rule written
   * about a sign-in.
   *
   * The refusal is the one `/complete` gives for a dead token, in the same
   * words: this endpoint must not become an oracle for whether a link is still
   * good, whether the account exists, or what it has enrolled. It carries the
   * same rate limit as every other credential-presenting route here.
   */
  app.post('/webauthn/challenge', { ...LIMIT }, async (request) => {
    const body = resetPreflightRequest.parse(request.body);
    const userId = await userForResetToken(request.tenantId, body.token);
    if (userId === null) {
      throw new ProblemError(
        400,
        'invalid-reset-token',
        'That reset link is no longer usable',
        'Request a new one.',
      );
    }

    const tenant = await request.db((tx) =>
      tx.tenant.findUniqueOrThrow({ where: { id: request.tenantId } }),
    );
    // From the tenant, exactly as `/complete` derives it. The assertion this
    // challenge produces is verified against the tenant's own origin, and a
    // challenge minted against a header would be one whose audience an
    // attacker chooses.
    return beginWebAuthnAuthentication(
      request.tenantId,
      userId,
      tenantRelyingParty(tenant, options.publicUrl),
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
        passwordRejectionMessage(outcome.detail),
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
    if (outcome.reason === 'reused') {
      // Emphatically NOT the fall-through below. The link is still usable and
      // the password is the problem — telling somebody to request a new link
      // would send them to their inbox to make the same mistake again.
      throw new ProblemError(
        400,
        'password-reused',
        'That password does not meet the policy',
        `That is one of your last ${outcome.depth} passwords. Choose one you have not used before.`,
      );
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
