import type { FastifyInstance } from 'fastify';
import { upstreamIdpRequest } from '@syntra/contracts';
import {
  PERMISSIONS,
  listUpstreams,
  localMasterKeyProvider,
  recordEvent,
  upsertUpstream,
} from '@syntra/core';
import { requirePermission } from '../../plugins/require-permission.js';
import { requireSession } from '../../plugins/require-session.js';

export interface AdminUpstreamRouteOptions {
  /** Wraps the upstream client secret on its way into the vault. */
  masterKey: Buffer;
}

/**
 * The upstream identity providers this tenant may delegate authentication to.
 *
 * Two properties this file exists to hold:
 *
 * - **The client secret goes in and never comes out.** It is written to the
 *   vault under a name the row points at, and `UpstreamIdpRecord` does not
 *   carry `clientSecretName` at all — not the secret, and not the handle that
 *   would tell an attacker with a vault read where to look. Spec section 12
 *   says a secret is replaced rather than read back, and the only way to hold
 *   to that is for no response shape to be able to express it.
 * - **A write is a whole record.** `upsertUpstream` sets every column, which
 *   is why the request schema carries a default for each one: a body that left
 *   `wantAssertionsSigned` out would otherwise reset it, and the field that
 *   silently resets is always the one that mattered. Omitting `clientSecret`
 *   is the single exception, and it leaves the stored one alone.
 */
export async function registerAdminUpstreamRoutes(
  app: FastifyInstance,
  options: AdminUpstreamRouteOptions,
): Promise<void> {
  app.addHook('preHandler', requireSession('admin'));

  const provider = localMasterKeyProvider(options.masterKey);

  app.get(
    '/upstreams',
    { preHandler: requirePermission(PERMISSIONS.ACCESS_READ) },
    async (request) => ({ upstreams: await request.db((tx) => listUpstreams(tx)) }),
  );

  app.post(
    '/upstreams',
    { preHandler: requirePermission(PERMISSIONS.ACCESS_MANAGE) },
    async (request, reply) => {
      const body = upstreamIdpRequest.parse(request.body);

      const record = await request.db(async (tx) => {
        const saved = await upsertUpstream(tx, provider, body);
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'access.upstream_configured',
          targetType: 'UpstreamIdp',
          targetId: saved.id,
          outcome: 'success',
          sourceIp: request.ip,
          // Never the secret, and never its vault name. What a reviewer needs
          // is which provider this tenant now trusts to authenticate people,
          // and whether it is on.
          payload: {
            slug: saved.slug,
            protocol: saved.protocol,
            enabled: saved.enabled,
            issuerUrl: saved.issuerUrl,
            idpEntityId: saved.idpEntityId,
            ssoUrl: saved.ssoUrl,
            createUsers: saved.createUsers,
            // On the audit event, always, and not only when it is on. "Who
            // let this upstream take over existing accounts, and when" is the
            // question a reviewer asks after the fact, and an event that
            // records the setting only in its dangerous state cannot answer
            // when it was turned back off.
            allowLoginAdoption: saved.allowLoginAdoption,
            secretWritten: body.clientSecret !== undefined,
          },
        });
        return saved;
      });

      return reply.status(201).send(record);
    },
  );
}
