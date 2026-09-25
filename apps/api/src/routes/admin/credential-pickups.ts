import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { TenantClient } from '@syntra/db';
import {
  credentialPickupHistoryResponse,
  sendLoginInfoRequest,
  sendLoginInfoResponse,
} from '@syntra/contracts';
import {
  PERMISSIONS,
  STEP_UP_MAX_AGE_MS,
  NoDeliveryAddressError,
  NoInitialSecretError,
  NoTargetAccountError,
  credentialPickupHistory,
  isRecentElevation,
  recordEvent,
  sendCredentialPickup,
  type Transport,
} from '@syntra/core';
import { ProblemError } from '../../plugins/problem-json.js';
import { requireSession } from '../../plugins/require-session.js';
import { requirePermission } from '../../plugins/require-permission.js';
import { placementParams } from './targets.js';

export interface CredentialPickupAdminRouteOptions {
  transport: Transport;
  publicUrl: string;
}

/**
 * A created account's sign-in link, from the console: its history, and
 * "Send login info" to send a fresh one.
 *
 * Addressed like the adoption routes -- target, then person -- because that
 * is how the console finds an account and there is one per pair.
 *
 * Sending is `provision.manage` AND a freshly stepped-up console session, and
 * never a machine token (`TOKEN_DENIED_ROUTES`). It hands out the ability to
 * read somebody's password, once, to an address the administrator chooses --
 * including their own -- which is the same authority as setting somebody's
 * password, and the password routes demand the same. A stolen console
 * session that could press it quietly would be a way to collect every
 * joiner's first password; the step-up makes it one that has to re-present
 * the password and every factor the tenant demands.
 */
export async function registerAdminCredentialPickupRoutes(
  app: FastifyInstance,
  options: CredentialPickupAdminRouteOptions,
): Promise<void> {
  app.addHook('preHandler', requireSession('admin'));

  app.get(
    '/targets/:id/accounts/:personId/credential-pickups',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_READ) },
    async (request) => {
      const { id, personId } = placementParams.parse(request.params);
      const history = await request.db((tx) => credentialPickupHistory(tx, id, personId));
      if (history === null) {
        throw new ProblemError(404, 'not-found', 'This person has no account on this target');
      }
      return credentialPickupHistoryResponse.parse({
        hasInitialSecret: history.hasInitialSecret,
        pickups: history.pickups.map((row) => ({
          ...row,
          createdAt: row.createdAt.toISOString(),
          expiresAt: row.expiresAt.toISOString(),
          viewedAt: row.viewedAt?.toISOString() ?? null,
          revokedAt: row.revokedAt?.toISOString() ?? null,
        })),
      });
    },
  );

  app.post(
    '/targets/:id/accounts/:personId/send-login-info',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_MANAGE) },
    async (request) => {
      const { id, personId } = placementParams.parse(request.params);
      const body = sendLoginInfoRequest.parse(request.body);

      // Belt to `TOKEN_DENIED_ROUTES`' braces: a principal that got here by a
      // token has no elevation to be recent.
      if (request.session.viaToken || !isRecentElevation(request.session)) {
        await request.db((tx) =>
          // Refusals are audited too. Somebody pressing this without a fresh
          // elevation is either an administrator who needs to step up or a
          // session that should not be trying.
          recordRefusal(tx, request, id, personId, 'step_up_required'),
        );
        throw new ProblemError(
          403,
          'step-up-required',
          'Confirm it is you first',
          `Sending somebody's sign-in details needs a console session started in the last ${STEP_UP_MAX_AGE_MS / 60_000} minutes. Elevate again, then retry.`,
        );
      }

      try {
        const result = await sendCredentialPickup(request.tenantId, options.transport, options.publicUrl, {
          targetSystemId: id,
          personId,
          recipient: body.recipient,
          actorUserId: request.session.userId,
          sourceIp: request.ip,
        });
        return sendLoginInfoResponse.parse({ ...result, expiresAt: result.expiresAt.toISOString() });
      } catch (cause) {
        if (cause instanceof NoTargetAccountError) {
          throw new ProblemError(404, 'not-found', 'This person has no account on this target');
        }
        if (cause instanceof NoInitialSecretError || cause instanceof NoDeliveryAddressError) {
          await request.db((tx) =>
            recordRefusal(
              tx,
              request,
              id,
              personId,
              cause instanceof NoInitialSecretError ? 'no_initial_secret' : 'no_delivery_address',
            ),
          );
          throw new ProblemError(
            409,
            cause instanceof NoInitialSecretError ? 'no-initial-secret' : 'no-delivery-address',
            cause instanceof NoInitialSecretError
              ? 'There is no initial password to send'
              : 'There is nowhere to send it',
            cause instanceof NoInitialSecretError
              ? 'Syntra holds no initial password for this account. It was not created by Provision, or it was created before initial passwords were kept.'
              : cause.message,
          );
        }
        throw cause;
      }
    },
  );
}

async function recordRefusal(
  tx: TenantClient,
  request: FastifyRequest,
  targetSystemId: string,
  personId: string,
  reason: string,
): Promise<void> {
  await recordEvent(tx, {
    actorUserId: request.session.userId,
    action: 'provision.credential.link_sent',
    targetType: 'Person',
    targetId: personId,
    outcome: 'failure',
    sourceIp: request.ip,
    payload: { targetSystemId, reason },
  });
}
