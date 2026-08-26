import type { FastifyInstance } from 'fastify';
import { idParam, isLaunchableUrl, type ApplicationTile } from '@syntra/contracts';
import {
  authorize,
  findApplication,
  isApplicationAssigned,
  recordEvent,
  resolveApplicationsForUser,
} from '@syntra/core';
import { ProblemError } from '../plugins/problem-json.js';
import { perTenantRateLimit } from '../plugins/rate-limit.js';
import { requireSession } from '../plugins/require-session.js';
import { tenantProtocolIdentity } from './protocol-identity.js';
import { tenantRelyingParty } from './relying-party.js';

export interface PortalRouteOptions {
  /** Attempts per minute, per tenant per address. */
  authRateLimitMax: number;
  /** Attempts per minute for the whole tenant, across every address. */
  authRateLimitTenantMax: number;
  publicUrl: string;
}

export async function registerPortalRoutes(
  app: FastifyInstance,
  options: PortalRouteOptions,
): Promise<void> {
  app.addHook('preHandler', requireSession('portal'));

  app.get('/applications', async (request) => {
    const rows = await request.db((tx) =>
      resolveApplicationsForUser(tx, request.session.userId),
    );
    // `ApplicationTile`, the contract, rather than an anonymous literal. A
    // tile is a name and an icon; the schema says so and now the handler is
    // checked against it. Deliberately not the launch URL -- getting to the
    // application goes through /launch, which goes through authorize().
    const applications: ApplicationTile[] = rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      description: row.description,
      iconUrl: row.iconUrl,
    }));
    return { applications };
  });

  app.post(
    '/applications/:id/launch',
    {
      // Both dimensions, like every other route that runs authorize(). A
      // launch evaluates policy and can mint an attempt, so it is a
      // credential-issuing endpoint whatever the URL suggests — and the
      // per-address half alone is bounded only by how many addresses the
      // attacker has.
      config: {
        rateLimit: { max: options.authRateLimitMax, timeWindow: '1 minute' },
      },
      onRequest: perTenantRateLimit(app, options.authRateLimitTenantMax),
    },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const { userId, sessionId } = request.session;

      const assigned = await request.db((tx) => isApplicationAssigned(tx, userId, id));
      if (!assigned) {
        // An unknown application and an unassigned one read the same, so the
        // catalog cannot be enumerated from a portal session.
        throw new ProblemError(403, 'not-assigned', 'Not available to you');
      }

      // Even for an already-signed-in user, entering an application is a
      // separate decision: a rule may name this application and demand a
      // stronger factor than the session was established with. Access II's
      // protocol adapters mount on exactly this call.
      const tenant = await request.db((tx) =>
        tx.tenant.findUniqueOrThrow({ where: { id: request.tenantId } }),
      );

      const decision = await authorize(request.tenantId, {
        kind: 'primary',
        // Only the session id travels with the principal. authorize() reads
        // the factor that established the session off the Session row itself
        // (readSession, keyed on sessionId) rather than trusting a
        // caller-supplied value — the same hardening that closed the "read
        // from the row, not the caller" gap in login. Without that read, a
        // launch that comes back as a challenge, gets answered, and is
        // retried as a fresh primary authentication would see nothing
        // satisfied and issue the same challenge forever.
        principal: { kind: 'session', userId, sessionId },
        applicationId: id,
        sourceIp: request.ip,
        relyingParty: tenantRelyingParty(tenant, options.publicUrl),
        // A launch never elevates. Recorded on any attempt this opens, so the
        // session issued at the far end of a step-up is a portal one even
        // though the caller arrived holding a cookie.
        scope: 'portal',
      });

      if (decision.status === 'deny') {
        throw new ProblemError(403, 'not-assigned', 'Not available to you');
      }

      if (decision.status === 'challenge') {
        return {
          status: 'challenge' as const,
          attemptToken: decision.attemptToken,
          expiresAt: decision.expiresAt.toISOString(),
          acceptableFactors: decision.acceptableFactors,
        };
      }

      // A rule scoped to this application wants a factor the user does not
      // hold. They keep their portal session; what they do not get is this
      // application until they enrol.
      if (decision.status === 'enrol') {
        return {
          status: 'enrol' as const,
          attemptToken: decision.attemptToken,
          expiresAt: decision.expiresAt.toISOString(),
          enrollableFactors: decision.enrollableFactors,
        };
      }

      const application = await request.db((tx) => findApplication(tx, id));
      if (!application) {
        throw new ProblemError(
          409,
          'not-launchable',
          'That application has no launch address configured',
        );
      }

      await request.db((tx) =>
        recordEvent(tx, {
          actorUserId: userId,
          action: 'application.launch',
          targetType: 'Application',
          targetId: id,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { slug: application.slug, type: application.type },
        }),
      );

      // A protocol application's launch address is derived from the tenant's
      // own identity, never stored and never taken from the request. The
      // browser is sent to a Syntra path, which re-enters authorize() — the
      // decision made here does not carry over, and that is deliberate: the
      // protocol endpoint is reachable directly and has to stand on its own.
      if (application.type === 'saml' || application.type === 'oidc') {
        const identity = tenantProtocolIdentity(tenant, options.publicUrl);
        return {
          status: 'launch' as const,
          url:
            application.type === 'saml'
              ? `${identity.base}/saml/start/${application.id}`
              : `${identity.base}/api/portal/oidc-start/${application.id}`,
        };
      }

      // A bookmark. The admin API only accepts http(s) launch URLs (see
      // `isLaunchableUrl` in @syntra/contracts), but that check runs on
      // write. A row created before it existed — an old migration, a seed
      // script, a restore — would otherwise reach this response, and this is
      // the URL the browser is sent to unconditionally. Re-checked here
      // rather than trusted because it was validated somewhere once.
      if (!application.launchUrl || !isLaunchableUrl(application.launchUrl)) {
        throw new ProblemError(
          409,
          'not-launchable',
          'That application has no launch address configured',
        );
      }

      return { status: 'launch' as const, url: application.launchUrl };
    },
  );

  /**
   * Where an OIDC tile sends the browser.
   *
   * OpenID Connect has no identity-provider-initiated flow: only the relying
   * party knows its own `state`, `nonce` and PKCE verifier, so Syntra cannot
   * start one on its behalf. This redirects to the application's own start
   * address — the `launchUrl` an administrator recorded, validated by
   * `webUrl` on the way in — and the application then begins the code flow
   * against `/oidc/auth`, which makes its own `authorize()` decision.
   *
   * A GET rather than part of the launch response because the browser has to
   * be *navigated*: `window.open` on a cross-origin address is what the tile
   * does, and the redirect keeps the address out of the portal's own
   * response body where it would be one XSS away from being a fetch target.
   */
  app.get('/oidc-start/:id', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const assigned = await request.db((tx) =>
      isApplicationAssigned(tx, request.session.userId, id),
    );
    if (!assigned) throw new ProblemError(403, 'not-assigned', 'Not available to you');

    const application = await request.db((tx) => findApplication(tx, id));
    // Re-checked on the way out rather than trusted because it was validated
    // on the way in.
    if (!application?.launchUrl || !isLaunchableUrl(application.launchUrl)) {
      throw new ProblemError(
        409,
        'not-launchable',
        'That application has no start address configured',
      );
    }
    return reply.redirect(application.launchUrl, 302);
  });
}
