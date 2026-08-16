import type { FastifyInstance } from 'fastify';
import {
  authorize,
  isApplicationAssigned,
  recordAuthorizationDecision,
  recordEvent,
  resolveSession,
} from '@syntra/core';
import { SYNTRA_DECISION_KEY } from '@syntra/protocols';
import { ProblemError } from '../plugins/problem-json.js';
import { perTenantRateLimit } from '../plugins/rate-limit.js';
import { SESSION_COOKIE } from '../plugins/require-session.js';
import { tenantRelyingParty } from './relying-party.js';
import { challengeRedirect } from './session-reply.js';
import { oidcProviderFor, type OidcRouteOptions } from './oidc-op.js';

/**
 * The only place an OIDC interaction is resolved.
 *
 * `oidc-provider` cannot issue a code for a request whose interaction is
 * unresolved, and `syntraAuthorizePrompt` guarantees every authorization
 * request has one. This route resolves it, and only from an `allow` out of
 * `authorize()`. There is no other call to `provider.interactionFinished`
 * anywhere in the codebase.
 *
 * It also writes the `AuthorizationDecision` the token endpoint independently
 * requires. The two writes are the two halves of one fact — the chokepoint
 * allowed — recorded in two places on purpose.
 */
export async function registerOidcInteractionRoutes(
  app: FastifyInstance,
  options: OidcRouteOptions,
): Promise<void> {
  app.get(
    '/interaction/:uid',
    {
      // A launch evaluates policy and can mint an attempt, so both dimensions,
      // as at every other authorize() entry point.
      config: { rateLimit: { max: options.authRateLimitMax, timeWindow: '1 minute' } },
      onRequest: perTenantRateLimit(app, options.authRateLimitTenantMax),
    },
    async (request, reply) => {
      const provider = await oidcProviderFor(request, options);
      const { uid, prompt, params } = await provider.interactionDetails(
        request.raw, reply.raw,
      );

      const clientId = String(params.client_id ?? '');
      const oidcClient = await request.db((tx) =>
        tx.oidcClient.findFirst({ where: { clientId } }),
      );
      if (!oidcClient) {
        throw new ProblemError(400, 'oidc-unknown-client', 'Unknown client');
      }

      const token = request.cookies[SESSION_COOKIE];
      const session = token ? await request.db((tx) => resolveSession(tx, token)) : null;
      if (!session) {
        const next = encodeURIComponent(`/oidc/interaction/${uid}`);
        return reply.redirect(`/login?next=${next}`, 302);
      }

      const assigned = await request.db((tx) =>
        isApplicationAssigned(tx, session.userId, oidcClient.applicationId),
      );
      if (!assigned) {
        throw new ProblemError(403, 'not-assigned', 'Not available to you');
      }

      const tenant = await request.db((tx) =>
        tx.tenant.findUniqueOrThrow({ where: { id: request.tenantId } }),
      );

      const decision = await authorize(request.tenantId, {
        kind: 'primary',
        // Session id only; authorize() reads the satisfied factor off the row.
        principal: { kind: 'session', userId: session.userId, sessionId: session.sessionId },
        applicationId: oidcClient.applicationId,
        sourceIp: request.ip,
        relyingParty: tenantRelyingParty(tenant, options.publicUrl),
        scope: 'portal',
      });

      if (decision.status === 'deny') {
        throw new ProblemError(403, 'not-assigned', 'Not available to you');
      }

      if (decision.status === 'challenge' || decision.status === 'enrol') {
        return challengeRedirect(reply, decision, `/oidc/interaction/${uid}`);
      }

      // Written BEFORE the interaction is resolved. If this throws, no code is
      // ever minted; if it succeeded and the resolve then failed, the decision
      // simply expires unspent. The order that could issue a code with no
      // decision behind it is the other one.
      await recordAuthorizationDecision(request.tenantId, {
        userId: decision.userId,
        clientId,
        interactionUid: uid,
        satisfiedFactor: decision.satisfiedFactor,
      });

      await request.db((tx) =>
        recordEvent(tx, {
          actorUserId: decision.userId,
          action: 'oidc.interaction_resolved',
          targetType: 'Application',
          targetId: oidcClient.applicationId,
          outcome: 'success',
          sourceIp: request.ip,
          payload: {
            clientId,
            prompt: prompt.name,
            interactionUid: uid,
            satisfiedFactor: decision.satisfiedFactor,
          },
        }),
      );

      reply.hijack();
      // `login.accountId` is the Syntra user id and nothing else — never a
      // value taken off the request. The `syntraDecision` key is what
      // `syntraAuthorizePrompt` looks for; without it the prompt fires again
      // and the request loops rather than issuing anything.
      //
      // `consent: {}` is resolved unconditionally alongside it, for the same
      // reason: `oidc-provider`'s built-in consent prompt is `requestable`,
      // so whenever a client asks for it explicitly (`prompt=consent` — the
      // only way to keep `offline_access` alive through `check_scope.js`, see
      // `provider-factory.ts`), its own gating check
      // (`interaction_policy/prompt.js`) stays pending forever unless
      // `result.consent` is present, independent of whether the scope is
      // actually covered. Syntra never runs an interactive consent screen —
      // `loadExistingGrant` grants exactly what a client is registered for on
      // every launch — so there is nothing to withhold here; omitting this key
      // does not skip consent, it only leaves the built-in prompt unable to
      // ever resolve, and the authorization request loops between here and
      // `/auth` until it exhausts its redirect budget.
      await provider.interactionFinished(
        request.raw,
        reply.raw,
        {
          login: {
            accountId: decision.userId,
            remember: false,
            ...(decision.satisfiedFactor ? { amr: [decision.satisfiedFactor] } : {}),
          },
          consent: {},
          [SYNTRA_DECISION_KEY]: { clientId, at: Date.now() },
        } as never,
        { mergeWithLastSubmission: false },
      );
    },
  );
}
