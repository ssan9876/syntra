import type { FastifyInstance } from 'fastify';
import { idParam, isLaunchableUrl } from '@syntra/contracts';
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
    // Deliberately not the launch URL. A tile is a name and an icon; getting
    // to the application goes through /launch, which goes through authorize().
    return {
      applications: rows.map((row) => ({
        id: row.id,
        name: row.name,
        slug: row.slug,
        description: row.description,
        iconUrl: row.iconUrl,
      })),
    };
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
      // The admin API only accepts http(s) launch URLs (see
      // `isLaunchableUrl` in @syntra/contracts), but that check runs on
      // write. A row created before it existed — an old migration, a seed
      // script, a restore — would otherwise reach this response, and this is
      // the URL the browser is sent to unconditionally. Re-checked here
      // rather than trusted because it was validated somewhere once.
      if (!application?.launchUrl || !isLaunchableUrl(application.launchUrl)) {
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
          payload: { slug: application.slug },
        }),
      );

      return { status: 'launch' as const, url: application.launchUrl };
    },
  );
}
