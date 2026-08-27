import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  enrolBeginRequest,
  enrolTotpConfirmRequest,
  enrolWebauthnFinishRequest,
} from '@syntra/contracts';
import {
  authorize,
  beginTotpEnrolment,
  beginWebAuthnRegistration,
  confirmTotpEnrolment,
  hasTotp,
  finishWebAuthnRegistration,
  findAttempt,
  localMasterKeyProvider,
  recordEvent,
  type FactorType,
  type ResolvedAttempt,
  type Transport,
} from '@syntra/core';
import { ProblemError } from '../plugins/problem-json.js';
import { perTenantRateLimit } from '../plugins/rate-limit.js';
import { tenantRelyingParty } from './relying-party.js';
import { issueSession, renewReply } from './session-reply.js';
import { qrDataUrl, tellOwnerAFactorWasAdded, webauthnContext } from './mfa.js';
import { clientFacts } from '../plugins/client-facts.js';

export interface EnrolRouteOptions {
  masterKey: Buffer;
  publicUrl: string;
  /** Attempts per minute, per tenant per address. */
  authRateLimitMax: number;
  /** Attempts per minute for the whole tenant, across every address. */
  authRateLimitTenantMax: number;
  transport: Transport;
}

/**
 * Enrolment during a forced-enrolment challenge.
 *
 * There is no session here and no session guard. The credential is the
 * enrolment attempt token, which authorize() issued after primary
 * authentication succeeded and the policy asked for a factor the user does not
 * hold. It buys exactly one thing: enrolling a factor of the required kind.
 *
 * SECURITY TRADE, ACCEPTED DELIBERATELY: whoever holds the password can enrol
 * their own factor here. The alternative is a product in which no tenant can
 * ever turn MFA on, because the first rule they save locks out everyone who has
 * not already enrolled. The same password previously bought a full session with
 * no factor at all, so this is not a step backwards — but every enrolment that
 * happens through this router is audited with `underForcedEnrolment: true`, so
 * it can be found afterwards.
 */
export async function registerEnrolRoutes(
  app: FastifyInstance,
  options: EnrolRouteOptions,
): Promise<void> {
  const provider = localMasterKeyProvider(options.masterKey);
  const LIMIT = {
    config: {
      rateLimit: { max: options.authRateLimitMax, timeWindow: '1 minute' },
    },
    onRequest: perTenantRateLimit(app, options.authRateLimitTenantMax),
  };

  /**
   * Resolves the attempt and checks that the factor about to be enrolled is
   * the kind the rule asked for. A rule demanding WebAuthn must not be
   * satisfiable by enrolling an authenticator app.
   */
  async function attemptFor(
    request: FastifyRequest,
    token: string,
    factor: FactorType,
  ): Promise<ResolvedAttempt> {
    const attempt = await request.db((tx) => findAttempt(tx, token, new Date()));
    if (!attempt || attempt.purpose !== 'enrol') {
      throw new ProblemError(401, 'invalid-credentials', 'Invalid credentials');
    }
    if (
      attempt.requiredOutcome === 'require_factor' &&
      attempt.requiredFactor !== factor
    ) {
      throw new ProblemError(
        400,
        'wrong-factor-type',
        'That is not the kind of factor this account needs',
      );
    }
    return attempt;
  }

  /**
   * Hands the enrolment back to the chokepoint, which re-reads what the user
   * actually holds, consumes the attempt, audits the forced enrolment and
   * re-evaluates the policy. This route never decides that a session may be
   * issued; it only reports what authorize() decided.
   */
  async function finish(
    request: FastifyRequest,
    reply: FastifyReply,
    token: string,
    factor: FactorType,
  ) {
    const tenant = await request.db((tx) =>
      tx.tenant.findUniqueOrThrow({ where: { id: request.tenantId } }),
    );

    const result = await authorize(request.tenantId, {
      kind: 'enrolled',
      attemptToken: token,
      enrolledFactor: factor,
      sourceIp: request.ip,
      client: clientFacts(request),
      relyingParty: tenantRelyingParty(tenant, options.publicUrl),
    });

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
    if (result.status === 'enrol') {
      return reply.status(200).send({
        status: 'enrol',
        attemptToken: result.attemptToken,
        expiresAt: result.expiresAt.toISOString(),
        enrollableFactors: result.enrollableFactors,
      });
    }

    // The scope comes off the attempt through authorize(), which is where the
    // issuer recorded it. An elevation that ended in forced enrolment must come
    // back as an administrative session, and a portal sign-in must not.

    // The password aged past the tenant's limit. Same shape as `enrol` above,
    // and for the same reason: a half-finished sign-in holding a token that
    // buys exactly one next step.
    if (result.status === 'renew') {
      return reply.status(200).send(renewReply(result));
    }

    return issueSession(request, reply, result);
  }

  app.post('/totp/begin', { ...LIMIT }, async (request) => {
    const body = enrolBeginRequest.parse(request.body);
    const attempt = await attemptFor(request, body.attemptToken, 'totp');

    // beginTotpEnrolment throws a plain Error when a *confirmed* credential
    // already exists — two tabs, a double-click, or a factor enrolled from a
    // signed-in session while this attempt was open. That is a conflict the
    // caller can act on, not a server fault, and the sibling self-service
    // route already answers it this way. A bare 500 here also prints a stack
    // trace into the log for an ordinary double-click.
    const enrolment = await request.db(async (tx) => {
      if (await hasTotp(tx, attempt.userId)) {
        throw new ProblemError(
          409,
          'already-enrolled',
          'An authenticator app is already set up',
          'Sign in with the code it shows, or remove it from your security settings first.',
        );
      }
      return beginTotpEnrolment(tx, provider, attempt.userId);
    });
    // QR encoding outside the transaction: pure CPU work with no business
    // inside Prisma's 5000 ms transaction budget.
    return { ...enrolment, qr: qrDataUrl(enrolment.uri) };
  });

  app.post('/totp/confirm', { ...LIMIT }, async (request, reply) => {
    const body = enrolTotpConfirmRequest.parse(request.body);
    const attempt = await attemptFor(request, body.attemptToken, 'totp');

    const ok = await confirmTotpEnrolment(
      request.tenantId,
      provider,
      attempt.userId,
      body.code,
    );
    if (!ok) {
      // A wrong code costs a retry, not the attempt: the user is standing in
      // front of a screen with no session and nowhere else to go.
      throw new ProblemError(400, 'invalid-code', 'That code did not match');
    }

    await request.db((tx) =>
      recordEvent(tx, {
        actorUserId: attempt.userId,
        action: 'mfa.enrolled',
        targetType: 'User',
        targetId: attempt.userId,
        outcome: 'success',
        sourceIp: request.ip,
        payload: { factor: 'totp', underForcedEnrolment: true, ruleId: attempt.ruleId },
      }),
    );
    // Outside every transaction, and unconditional. This is the mail that
    // reaches the one person who can tell a legitimate enrolment from one made
    // by whoever held the password — and it matters most here, because this
    // path is the one a stolen password can reach.
    await tellOwnerAFactorWasAdded(
      request,
      options.transport,
      attempt.userId,
      'authenticator app',
    );

    return finish(request, reply, body.attemptToken, 'totp');
  });

  app.post('/webauthn/begin', { ...LIMIT }, async (request) => {
    const body = enrolBeginRequest.parse(request.body);
    const attempt = await attemptFor(request, body.attemptToken, 'webauthn');
    // Refuses with a 409 naming the fix when this tenant has no primary domain
    // set, rather than registering a credential against an origin taken from
    // the request. The enrolment screen renders that message.
    const { rp } = await webauthnContext(request, options.publicUrl);
    return beginWebAuthnRegistration(request.tenantId, attempt.userId, rp);
  });

  app.post('/webauthn/finish', { ...LIMIT }, async (request, reply) => {
    const body = enrolWebauthnFinishRequest.parse(request.body);
    const attempt = await attemptFor(request, body.attemptToken, 'webauthn');
    const { rp } = await webauthnContext(request, options.publicUrl);

    const outcome = await finishWebAuthnRegistration(
      request.tenantId,
      attempt.userId,
      rp,
      body.label,
      body.response as never,
    );
    if (!outcome.ok) {
      await request.db((tx) =>
        recordEvent(tx, {
          actorUserId: attempt.userId,
          action: 'mfa.enrol_failed',
          targetType: 'User',
          targetId: attempt.userId,
          outcome: 'failure',
          sourceIp: request.ip,
          payload: {
            factor: 'webauthn',
            reason: outcome.reason,
            underForcedEnrolment: true,
          },
        }),
      );
      throw new ProblemError(
        400,
        'registration-rejected',
        'That security key was not accepted',
      );
    }

    await request.db((tx) =>
      recordEvent(tx, {
        actorUserId: attempt.userId,
        action: 'mfa.enrolled',
        targetType: 'User',
        targetId: attempt.userId,
        outcome: 'success',
        sourceIp: request.ip,
        payload: {
          factor: 'webauthn',
          label: body.label,
          underForcedEnrolment: true,
          ruleId: attempt.ruleId,
        },
      }),
    );
    await tellOwnerAFactorWasAdded(
      request,
      options.transport,
      attempt.userId,
      'security key',
    );

    return finish(request, reply, body.attemptToken, 'webauthn');
  });
}
