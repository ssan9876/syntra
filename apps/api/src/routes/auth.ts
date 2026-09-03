import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  changePasswordRequest,
  elevateRequest,
  loginRequest,
  renewPasswordRequest,
} from '@syntra/contracts';
import {
  changeOwnPassword,
  authorize,
  renewExpiredPassword,
  isAdministrator,
  localMasterKeyProvider,
  recordEvent,
  endSessions,
} from '@syntra/core';
import { ProblemError } from '../plugins/problem-json.js';
import { passwordRejectionMessage } from './password-rejection.js';
import { requireSession, SESSION_COOKIE } from '../plugins/require-session.js';
import { perTenantRateLimit } from '../plugins/rate-limit.js';
import { tenantRelyingParty } from './relying-party.js';
import { issueSession, sessionBody, renewReply } from './session-reply.js';
import { clientFacts } from '../plugins/client-facts.js';

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
  /**
   * Needed to unseal a directory source's bind credential, so a password
   * change on a write-back source can reach the directory.
   */
  masterKey: Buffer;
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  options: AuthRouteOptions,
): Promise<void> {
  const PASSWORD_RATE_LIMIT = passwordRateLimit(app, options);
  const provider = localMasterKeyProvider(options.masterKey);

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
      client: clientFacts(request),
      relyingParty: rp,
      scope: 'portal',
    });

    // Every failure reason collapses into one response, with one exception
    // below. Which of them applied is recorded in the audit log, where an
    // administrator can see it and an attacker cannot — a policy denial must
    // not be distinguishable from a wrong password, or the policy itself
    // becomes an oracle.
    //
    // The exception is a locked account, and it is safe for a reason that
    // belongs to `authenticate()` rather than to this route: the lock is
    // checked *after* the password, so this reason is only ever produced for
    // somebody who supplied the correct one. It therefore tells an attacker
    // nothing they did not already have, and withholding it leaves a real
    // user retrying a password they know is right until they raise a ticket.
    if (result.status === 'deny' && result.reason === 'account_locked') {
      throw new ProblemError(
        401,
        'account-locked',
        'Too many failed sign-in attempts. Wait until the lock lifts, or ask an administrator to unlock the account.',
      );
    }
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


    // The password aged past the tenant's limit. Same shape as `enrol` above,
    // and for the same reason: a half-finished sign-in holding a token that
    // buys exactly one next step.
    if (result.status === 'renew') {
      return reply.status(200).send(renewReply(result));
    }

    return issueSession(request, reply, result);
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

      const { tenant, rp } = await relyingPartyFor(request);

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
        client: clientFacts(request),
        relyingParty: rp,
        // The scope stamped on any attempt opened here, and the scope of the
        // session issued at the end of it. Recorded, never inferred.
        scope: 'admin',
        // A floor the caller imposes. It can only strengthen the policy
        // outcome — a tenant rule that denies is still a denial, and a floor
        // never turns one into an allow.
        ...(tenant.adminMfaRequired ? { floor: 'require_mfa' as const } : {}),
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

      // An expired password stops an elevation too. The console is precisely
      // where it matters most, and letting it through here because the caller
      // already holds a portal session would make expiry a rule that binds
      // everyone except administrators.
      if (decision.status === 'renew') {
        return reply.status(200).send(renewReply(decision));
      }

      // The decision's user id, not the ambient one. They agree today — the
      // password checked was this session's own login — but "they agree" is a
      // fact about today's code, and the decision is the thing that was
      // actually authenticated.
      await request.db((tx) =>
        recordEvent(tx, {
          actorUserId: decision.userId,
          action: 'auth.elevate',
          targetType: 'Session',
          targetId: null,
          outcome: 'success',
          sourceIp: request.ip,
          payload: {},
        }),
      );

      return issueSession(request, reply, decision);
    },
  );

  /**
   * Self-service password change.
   *
   * `requireSession('portal')` and not `'admin'`: this is the one security
   * action every user has, and gating it behind elevation would make it
   * unreachable for the people who need it most.
   *
   * Rate limited exactly as `/login` and `/elevate` are. It takes a password
   * and answers whether it was right, which is the same oracle a sign-in is,
   * and the fact that the caller already holds a session does not change that.
   */
  app.post(
    '/password',
    { preHandler: requireSession('portal'), ...PASSWORD_RATE_LIMIT },
    async (request) => {
      const body = changePasswordRequest.parse(request.body);
      const { userId, sessionId } = request.session;

      const outcome = await changeOwnPassword(request.tenantId, provider, {
        userId,
        currentPassword: body.currentPassword,
        newPassword: body.newPassword,
        sessionId,
        sourceIp: request.ip,
      });

      if (outcome.ok) {
        return { ok: true, otherSessionsRevoked: outcome.otherSessionsRevoked };
      }

      switch (outcome.reason) {
        case 'upstream':
          // 409, not 403: nothing about the caller is wrong. The account's
          // password is simply held somewhere else, and the useful part of
          // the answer is where.
          throw new ProblemError(
            409,
            'password-held-upstream',
            'Password is managed elsewhere',
            outcome.hint
              ? `This account signs in through ${outcome.hint}. Change the password there.`
              : 'This account signs in through an external provider. Change the password there.',
          );
        case 'no_password':
          throw new ProblemError(
            409,
            'no-password-set',
            'No password to change',
            'This account signs in without a password. Ask an administrator to set one.',
          );
        case 'wrong_password':
          throw new ProblemError(
            403,
            'wrong-password',
            'Current password is incorrect',
            'The current password does not match.',
            { errors: [{ path: 'currentPassword', message: 'Incorrect' }] },
          );
        case 'directory_policy':
          // The DOMAIN refused it, not Syntra, and saying so is the whole
          // value of the message: somebody told "password rejected" by a
          // portal that just accepted the same rule has no idea their
          // employer's policy is the one talking.
          throw new ProblemError(
            422,
            'directory-password-policy',
            'The directory refused the new password',
            'Your organisation’s directory rejected this password. It may be too ' +
              'simple, one you have used before, or changed too recently.',
            { errors: [{ path: 'newPassword', message: 'directory_policy' }] },
          );
        case 'directory_unavailable':
          // 503, not 500: nothing is broken here, something else is
          // unreachable, and it is worth trying again shortly.
          throw new ProblemError(
            503,
            'directory-unavailable',
            'The directory could not be reached',
            'This password is held in your organisation’s directory, which ' +
              'could not be reached just now. Nothing was changed. Try again shortly.',
          );
        case 'weak_password':
          throw new ProblemError(
            422,
            'weak-password',
            'Password rejected',
            passwordRejectionMessage(outcome.detail),
            { errors: [{ path: 'newPassword', message: outcome.detail }] },
          );
        case 'unchanged':
          throw new ProblemError(
            422,
            'password-unchanged',
            'Password rejected',
            'That is already your password. Choose a different one.',
            { errors: [{ path: 'newPassword', message: 'unchanged' }] },
          );
        case 'reused':
          // The depth is SAID. "A previous password" is a rule somebody has to
          // guess at; "any of your last five" is one they can comply with.
          throw new ProblemError(
            422,
            'password-reused',
            'Password rejected',
            `That is one of your last ${outcome.depth} passwords. Choose one you have not used before.`,
            { errors: [{ path: 'newPassword', message: 'reused' }] },
          );
      }
    },
  );

  /**
   * Choosing a new password after the old one expired mid-sign-in.
   *
   * No session yet, and no `requireSession` — the attempt token is the
   * credential, exactly as it is for the MFA and enrolment endpoints. It buys
   * one thing and expires in minutes.
   *
   * Two steps rather than one: the password is written, and then the sign-in
   * is re-decided by `authorize()`, which spends the attempt. Re-deciding is
   * what makes a rule tightened while the user was typing still apply, and it
   * runs the expiry check again against the credential they just wrote.
   */
  app.post('/renew-password', { ...PASSWORD_RATE_LIMIT }, async (request, reply) => {
    const body = renewPasswordRequest.parse(request.body);
    const { rp } = await relyingPartyFor(request);

    const outcome = await renewExpiredPassword(request.tenantId, {
      attemptToken: body.attemptToken,
      newPassword: body.newPassword,
      sourceIp: request.ip,
    });

    if (!outcome.ok) {
      switch (outcome.reason) {
        case 'attempt_invalid':
        case 'user_inactive':
          // One answer for both, as everywhere else: which of them applied is
          // in the audit log, and the caller holds an expired token either
          // way. The fix is the same — start again.
          throw new ProblemError(
            401,
            'attempt-invalid',
            'That sign-in has expired',
            'Start signing in again.',
          );
        case 'weak_password':
          throw new ProblemError(
            422,
            'weak-password',
            'Password rejected',
            passwordRejectionMessage(outcome.detail),
            { errors: [{ path: 'newPassword', message: outcome.detail }] },
          );
        case 'unchanged':
          throw new ProblemError(
            422,
            'password-unchanged',
            'Password rejected',
            'That is the password that expired. Choose a different one.',
            { errors: [{ path: 'newPassword', message: 'unchanged' }] },
          );
        case 'reused':
          throw new ProblemError(
            422,
            'password-reused',
            'Password rejected',
            `That is one of your last ${outcome.depth} passwords. Choose one you have not used before.`,
            { errors: [{ path: 'newPassword', message: 'reused' }] },
          );
      }
    }

    const decision = await authorize(request.tenantId, {
      kind: 'renewed',
      attemptToken: body.attemptToken,
      sourceIp: request.ip,
      client: clientFacts(request),
      relyingParty: rp,
    });

    if (decision.status === 'deny') {
      throw new ProblemError(401, 'invalid-credentials', 'Invalid credentials');
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
    // Still expired after a change that reported success would be a bug, not a
    // state to loop the user through. It comes back as `renew` rather than a
    // session, and the screen says so.
    if (decision.status === 'renew') {
      return reply.status(200).send(renewReply(decision));
    }

    return issueSession(request, reply, decision);
  });

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
      // Through the funnel, so signing out reaches the relying parties this
      // session signed into. This is a WIDENING: `revokeSession` ended the
      // session here and told nobody, which is what
      // `configure.md` describes when it says every other service provider
      // keeps its own session until that session expires.
      //
      // A back-channel logout that does not fire on logout would barely fire
      // at all -- administrative revocation is rare and signing out is
      // constant -- so it would be single logout in name only.
      await request.db((tx) =>
        endSessions(tx, request.session.userId, {
          trigger: 'logout',
          actorUserId: request.session.userId,
          sourceIp: request.ip,
          onlySessionId: request.session.sessionId,
        }),
      );
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return { ok: true };
    },
  );
}
