import { Byte, Encoder } from '@nuintun/qrcode';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  mfaVerifyRequest,
  totpConfirmRequest,
  webauthnChallengeRequest,
  webauthnCredentialRemoveParams,
  webauthnRegisterRequest,
} from '@syntra/contracts';
import {
  authorize,
  beginTotpEnrolment,
  beginWebAuthnAuthentication,
  beginWebAuthnRegistration,
  confirmTotpEnrolment,
  countUnusedRecoveryCodes,
  deliverMessage,
  enrolledFactorTypes,
  finishWebAuthnRegistration,
  findAttempt,
  generateRecoveryCodes,
  hasTotp,
  listWebAuthnCredentials,
  localMasterKeyProvider,
  recordEvent,
  removeWebAuthnCredential,
  renderMessage,
  revokeOrphanedRecoveryCodes,
  type RelyingPartyIdentity,
  type Transport,
} from '@syntra/core';
import { ProblemError } from '../plugins/problem-json.js';
import { requireSession } from '../plugins/require-session.js';
import { perTenantRateLimit } from '../plugins/rate-limit.js';
import { assertWebAuthnUsable, tenantRelyingParty } from './relying-party.js';
import { issueSession } from './session-reply.js';

export interface MfaRouteOptions {
  masterKey: Buffer;
  publicUrl: string;
  /** Attempts per minute, per tenant per address. */
  authRateLimitMax: number;
  /** Attempts per minute for the whole tenant, across every address. */
  authRateLimitTenantMax: number;
  transport: Transport;
}

/**
 * Reads the tenant, derives its relying party, and refuses if this request did
 * not arrive on the tenant's own host.
 *
 * One helper rather than three call sites doing it by hand: every WebAuthn
 * endpoint needs the same three things in the same order, and a site that
 * forgot `assertWebAuthnUsable` would be a phishable endpoint that looked
 * exactly like the others.
 */
export async function webauthnContext(
  request: FastifyRequest,
  publicUrl: string,
): Promise<{ rp: RelyingPartyIdentity }> {
  const tenant = await request.db((tx) =>
    tx.tenant.findUniqueOrThrow({ where: { id: request.tenantId } }),
  );
  const rp = tenantRelyingParty(tenant, publicUrl);
  assertWebAuthnUsable(request, tenant, rp);
  // Registration also wants a display name for the browser prompt;
  // verification does not.
  return { rp: { ...rp, name: tenant.name } };
}

/**
 * Tells the account owner a factor was added.
 *
 * Rendered and sent outside every transaction — `renderMessage` reads nothing
 * and `sendMessage` takes no transaction, so an SMTP round trip cannot end up
 * inside Prisma's 5000 ms interactive-transaction budget.
 *
 * Unconditional rather than reserved for forced enrolment: the product already
 * mails on a password change, and a factor added by a stolen password is the
 * more serious of the two, because it survives the password reset that would
 * otherwise fix things. It is the only control that reaches the one person who
 * can tell a legitimate enrolment from an attacker's.
 *
 * Module scope, and the transport is a parameter rather than a closure over
 * `options`, because the forced-enrolment router in Task 9 calls it too and is
 * registered separately.
 *
 * Delivery goes through `deliverMessage`, which does not throw. Every caller
 * below reaches this line *after* the enrolment has committed, so a mail
 * server that is down used to turn a successful enrolment into a 500: the
 * factor was registered, and the user was told it had failed. It is not
 * swallowed either — a failure is logged through the Fastify logger and
 * recorded as `notify.delivery_failed` against the account it should have
 * reached. This mail is one of only two things that make "a stolen password
 * can enrol a factor" an acceptable trade, and a control nobody can tell has
 * stopped working is not a control.
 */
export async function tellOwnerAFactorWasAdded(
  request: FastifyRequest,
  transport: Transport,
  userId: string,
  factor: string,
): Promise<void> {
  const { user, tenantName } = await request.db(async (tx) => ({
    user: await tx.user.findUnique({ where: { id: userId } }),
    tenantName: (
      await tx.tenant.findUniqueOrThrow({ where: { id: request.tenantId } })
    ).name,
  }));
  if (!user) return;

  const message = renderMessage(tenantName, 'factor-added', user.email, {
    displayName: user.displayName,
    factor,
    when: new Date().toISOString(),
    sourceIp: request.ip,
  });
  await deliverMessage(transport, message, {
    tenantId: request.tenantId,
    userId: user.id,
    purpose: 'factor-added',
    log: (error, purpose) =>
      request.log.error({ err: error, purpose }, 'notification not delivered'),
  });
}

/**
 * Tells the account owner a factor was taken off.
 *
 * The mirror of `tellOwnerAFactorWasAdded`, and the more important of the two.
 * Removal needs only a session -- no current password, no step-up -- and it
 * cascades recovery-code revocation, so an attacker holding a stolen session
 * can strip every way back in off an account in two requests. Additions were
 * mailed precisely because a factor enrolled by somebody else survives the
 * password change that would otherwise fix things; a factor REMOVED by
 * somebody else is the step that comes first, and until this it produced no
 * signal the owner could see at all.
 *
 * `codesNote` is part of the message rather than a separate mail: "and the
 * recovery codes you printed have stopped working" is the sentence that turns
 * this from a notification into something the reader can act on, and sending
 * it separately means half of them arrive and half do not.
 *
 * Delivery goes through `deliverMessage`, which does not throw: the removal has
 * already committed, and a mail server that is down must not turn it into a 500
 * for the user who just made it. A failure is logged and recorded as
 * `notify.delivery_failed`.
 */
export async function tellOwnerAFactorWasRemoved(
  request: FastifyRequest,
  transport: Transport,
  userId: string,
  factor: string,
  recoveryCodesRevoked = 0,
): Promise<void> {
  const { user, tenantName } = await request.db(async (tx) => ({
    user: await tx.user.findUnique({ where: { id: userId } }),
    tenantName: (
      await tx.tenant.findUniqueOrThrow({ where: { id: request.tenantId } })
    ).name,
  }));
  if (!user) return;

  const message = renderMessage(tenantName, 'factor-removed', user.email, {
    displayName: user.displayName,
    factor,
    when: new Date().toISOString(),
    sourceIp: request.ip,
    codesNote:
      recoveryCodesRevoked === 0
        ? ''
        : ` ${recoveryCodesRevoked} unused recovery code${
            recoveryCodesRevoked === 1 ? '' : 's'
          } stopped working with it, because recovery codes are a way back in when a real factor is lost and there is no longer one to lose.`,
  });
  await deliverMessage(transport, message, {
    tenantId: request.tenantId,
    userId: user.id,
    purpose: 'factor-removed',
    log: (error, purpose) =>
      request.log.error({ err: error, purpose }, 'notification not delivered'),
  });
}

export const qrDataUrl = (text: string) =>
  new Encoder({ level: 'M' }).encode(new Byte(text)).toDataURL(4, { margin: 8 });

export async function registerMfaRoutes(
  app: FastifyInstance,
  options: MfaRouteOptions,
): Promise<void> {
  const provider = localMasterKeyProvider(options.masterKey);
  // Every endpoint below that presents or issues a credential carries it.
  // Guessing a six-digit code or a recovery code is only expensive if the
  // guesses are rationed, and the rate for that is the same one the password
  // endpoints already use — both halves of it. A wrong factor deliberately
  // does not consume the attempt, so the per-tenant ceiling is what stands
  // between a twenty-bit code and an attacker with a thousand addresses.
  const LIMIT = {
    config: {
      rateLimit: { max: options.authRateLimitMax, timeWindow: '1 minute' },
    },
    onRequest: perTenantRateLimit(app, options.authRateLimitTenantMax),
  };

  // ---- The step-up half of a sign-in. No session yet, so no session guard.

  app.post('/verify', { ...LIMIT }, async (request, reply) => {
    const body = mfaVerifyRequest.parse(request.body);

    const factor =
      body.type === 'webauthn'
        ? ({ type: 'webauthn', assertion: body.assertion } as const)
        : ({ type: body.type, code: body.code } as const);

    const tenant = await request.db((tx) =>
      tx.tenant.findUniqueOrThrow({ where: { id: request.tenantId } }),
    );

    const result = await authorize(request.tenantId, {
      kind: 'continue',
      attemptToken: body.attemptToken,
      factor,
      sourceIp: request.ip,
      relyingParty: tenantRelyingParty(tenant, options.publicUrl),
    });

    if (result.status === 'deny') {
      // One refusal is named, because the user is looking at a code that is
      // arithmetically correct and needs to be told why it was not taken. It
      // is safe to distinguish here and nowhere else: reaching this point
      // required a valid attempt token, which only exists after primary
      // authentication has already succeeded.
      if (result.reason === 'factor_used_for_enrolment') {
        throw new ProblemError(
          400,
          'code-already-used-for-setup',
          'That code completed your setup',
          'It cannot be used again to sign in. Wait for your app to show the next code.',
        );
      }
      // Everything else collapses into one response. A bad code, an unknown
      // attempt token and an expired one read identically, so nothing tells an
      // attacker which half to work on.
      throw new ProblemError(401, 'invalid-credentials', 'Invalid credentials');
    }

    // The factor was accepted and the policy now wants something else — which
    // only happens when a rule tightened while the user was reaching for their
    // phone. Hand the new demand back rather than issuing a session.
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

    // Everything the session records comes off the decision, and the decision
    // took its scope from the attempt, which recorded what its issuer meant.
    // Never from whether this request happened to carry a cookie — the web
    // client sends one on every call, so that inference hands an
    // administrative session to any portal user completing a step-up.
    return issueSession(request, reply, result);
  });

  /**
   * A WebAuthn step-up needs a challenge before the browser can sign anything,
   * and the caller holds an attempt token rather than a session. The attempt is
   * read but not consumed, so a user who cancels the browser prompt can try
   * again.
   */
  app.post('/webauthn/challenge', { ...LIMIT }, async (request) => {
    const body = webauthnChallengeRequest.parse(request.body);
    const attempt = await request.db((tx) =>
      findAttempt(tx, body.attemptToken, new Date()),
    );
    if (!attempt || attempt.purpose !== 'verify') {
      throw new ProblemError(401, 'invalid-credentials', 'Invalid credentials');
    }

    const { rp } = await webauthnContext(request, options.publicUrl);
    return beginWebAuthnAuthentication(request.tenantId, attempt.userId, rp);
  });

  // ---- Enrolment by a user who is already signed in. Everything below needs
  // a live session; Task 9 adds the same operations under an enrolment attempt
  // for a user who is not signed in yet.

  await app.register(async (secured) => {
    secured.addHook('preHandler', requireSession('portal'));

    secured.get('/', async (request) => {
      const { userId } = request.session;
      const totp = await request.db((tx) => hasTotp(tx, userId));
      const credentials = await request.db((tx) =>
        listWebAuthnCredentials(tx, userId),
      );
      const remaining = await request.db((tx) =>
        countUnusedRecoveryCodes(tx, userId),
      );

      // Whether a security key can be registered here at all, so the screen can
      // say why the button is disabled instead of offering an action that
      // always fails.
      let webauthnAvailable = true;
      let webauthnUnavailableReason: string | null = null;
      try {
        await webauthnContext(request, options.publicUrl);
      } catch (cause) {
        webauthnAvailable = false;
        webauthnUnavailableReason =
          cause instanceof ProblemError ? (cause.detail ?? cause.title) : null;
      }

      return {
        totp: { enrolled: totp },
        webauthn: {
          available: webauthnAvailable,
          unavailableReason: webauthnUnavailableReason,
          credentials: credentials.map((c) => ({
            id: c.id,
            label: c.label,
            createdAt: c.createdAt.toISOString(),
            lastUsedAt: c.lastUsedAt?.toISOString() ?? null,
          })),
        },
        recoveryCodes: { remaining },
      };
    });

    secured.post('/totp/begin', { ...LIMIT }, async (request) => {
      // beginTotpEnrolment throws when a *confirmed* credential already
      // exists. That is a conflict the caller can act on — remove the old one
      // first — not a server fault, and a 500 here would also print a stack
      // trace into the log for an ordinary double-click.
      const enrolment = await request.db(async (tx) => {
        if (await hasTotp(tx, request.session.userId)) {
          throw new ProblemError(
            409,
            'already-enrolled',
            'An authenticator app is already set up',
            'Remove the existing one before setting up another.',
          );
        }
        return beginTotpEnrolment(tx, provider, request.session.userId);
      });
      // QR encoding happens outside the transaction above: it is pure CPU work
      // and has no business inside Prisma's 5000 ms transaction budget.
      return { ...enrolment, qr: qrDataUrl(enrolment.uri) };
    });

    secured.post('/totp/confirm', { ...LIMIT }, async (request, reply) => {
      const body = totpConfirmRequest.parse(request.body);
      const ok = await confirmTotpEnrolment(
        request.tenantId,
        provider,
        request.session.userId,
        body.code,
      );
      if (!ok) {
        throw new ProblemError(400, 'invalid-code', 'That code did not match');
      }
      await request.db((tx) =>
        recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'mfa.enrolled',
          targetType: 'User',
          targetId: request.session.userId,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { factor: 'totp', underForcedEnrolment: false },
        }),
      );
      // Outside every transaction above, and awaited so a mail failure is
      // logged and audited rather than becoming an unhandled rejection — or,
      // worse, a 500 on an enrolment that has already committed.
      await tellOwnerAFactorWasAdded(
        request,
        options.transport,
        request.session.userId,
        'authenticator app',
      );
      return reply.status(204).send();
    });

    secured.post('/webauthn/begin', { ...LIMIT }, async (request) => {
      const { rp } = await webauthnContext(request, options.publicUrl);
      return beginWebAuthnRegistration(request.tenantId, request.session.userId, rp);
    });

    secured.post('/webauthn/finish', { ...LIMIT }, async (request, reply) => {
      const body = webauthnRegisterRequest.parse(request.body);
      const { rp } = await webauthnContext(request, options.publicUrl);
      const outcome = await finishWebAuthnRegistration(
        request.tenantId,
        request.session.userId,
        rp,
        body.label,
        body.response as never,
      );
      if (!outcome.ok) {
        // The reason is recorded rather than dropped: a rejected registration
        // that leaves no trace is a support call with nothing to look at.
        await request.db((tx) =>
          recordEvent(tx, {
            actorUserId: request.session.userId,
            action: 'mfa.enrol_failed',
            targetType: 'User',
            targetId: request.session.userId,
            outcome: 'failure',
            sourceIp: request.ip,
            payload: { factor: 'webauthn', reason: outcome.reason },
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
          actorUserId: request.session.userId,
          action: 'mfa.enrolled',
          targetType: 'User',
          targetId: request.session.userId,
          outcome: 'success',
          sourceIp: request.ip,
          payload: {
            factor: 'webauthn',
            label: body.label,
            underForcedEnrolment: false,
          },
        }),
      );
      await tellOwnerAFactorWasAdded(
        request,
        options.transport,
        request.session.userId,
        'security key',
      );
      return reply.status(204).send();
    });

    secured.delete('/webauthn/:credentialId', async (request, reply) => {
      const { credentialId } = webauthnCredentialRemoveParams.parse(
        request.params,
      );
      const revoked = await request.db(async (tx) => {
        await removeWebAuthnCredential(tx, request.session.userId, credentialId);
        // Removing the last real factor takes the recovery codes with it. They
        // are the way back in when a factor is lost, which is why holding one
        // is a precondition of issuing them; leaving them behind here would
        // reach the state that gate exists to prevent from the other side.
        const dropped = await revokeOrphanedRecoveryCodes(
          tx,
          request.session.userId,
        );
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'mfa.removed',
          targetType: 'User',
          targetId: request.session.userId,
          outcome: 'success',
          sourceIp: request.ip,
          payload: {
            factor: 'webauthn',
            credentialId,
            recoveryCodesRevoked: dropped,
          },
        });
        return dropped;
      });

      // Outside the transaction above, and awaited so a mail failure is logged
      // and audited rather than becoming an unhandled rejection on a removal
      // that has already committed.
      await tellOwnerAFactorWasRemoved(
        request,
        options.transport,
        request.session.userId,
        'security key',
        revoked,
      );
      return reply.status(200).send({ recoveryCodesRevoked: revoked });
    });

    secured.post('/recovery-codes', { ...LIMIT }, async (request) => {
      // Recovery codes are the fallback for a factor you already hold, not a
      // factor in themselves. Without this gate a user with nothing can mint
      // ten codes today, and a require_mfa rule saved next month is satisfied
      // by a printed code forever — the forced-enrolment path is never
      // reached, and the rule buys the tenant nothing. This is the check the
      // module's own comment already claimed was made somewhere.
      const held = await request.db((tx) =>
        enrolledFactorTypes(tx, request.session.userId),
      );
      if (held.length === 0) {
        throw new ProblemError(
          409,
          'no-factor-to-recover',
          'Set up a second factor first',
          'Recovery codes are a way back in when you lose your authenticator app or security key, so there has to be one to lose.',
        );
      }

      const codes = await request.db((tx) =>
        generateRecoveryCodes(tx, request.session.userId),
      );
      await request.db((tx) =>
        recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'mfa.recovery_codes_issued',
          targetType: 'User',
          targetId: request.session.userId,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { count: codes.length },
        }),
      );
      // Shown once. There is no endpoint that returns them again, because the
      // database holds only digests.
      return { codes };
    });
  });
}
