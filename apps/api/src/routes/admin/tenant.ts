import type { FastifyInstance } from 'fastify';
import { tenantSettingsRequest } from '@syntra/contracts';
import {
  PERMISSIONS,
  enrolledFactorTypes,
  hasRecoveryCodes,
  PasskeysWouldBreakError,
  passkeysAtRisk,
  readTenant,
  recordEvent,
  updateTenant,
} from '@syntra/core';
import { ProblemError } from '../../plugins/problem-json.js';
import { requirePermission } from '../../plugins/require-permission.js';
import { requireSession } from '../../plugins/require-session.js';

/**
 * The tenant's own settings.
 *
 * `adminMfaRequired` and `selfEnrolmentEnabled` are read by `authorize()` and
 * by the elevation endpoint, and until this route existed they were written
 * nowhere: the README told an operator to turn admin MFA on once the owner had
 * enrolled, and the only way to do it was direct SQL against the `Tenant`
 * table. A hardening control that ships switched off and cannot be switched on
 * is not a control.
 */
export async function registerAdminTenantRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.addHook('preHandler', requireSession('admin'));

  app.get(
    '/tenant',
    { preHandler: requirePermission(PERMISSIONS.TENANT_MANAGE) },
    async (request) => request.db((tx) => readTenant(tx)),
  );

  app.put(
    '/tenant',
    { preHandler: requirePermission(PERMISSIONS.TENANT_MANAGE) },
    async (request) => {
      const body = tenantSettingsRequest.parse(request.body);

      return request.db(async (tx) => {
        const before = await readTenant(tx);
        const after = { ...before, ...body };

        // The one combination that locks the console from the inside.
        //
        // `adminMfaRequired` with self-enrolment off means an administrator who
        // holds no factor is refused outright rather than offered one — the
        // chokepoint answers `factor_not_enrolled`, and there is no
        // self-service way back. Checked against the administrator making the
        // change, because they are the one this would certainly shut out and
        // the one standing in front of a screen that can say so. With
        // self-enrolment left on, the same pair is survivable: the next
        // elevation offers enrolment, which is the whole reason that default
        // exists.
        if (after.adminMfaRequired && !after.selfEnrolmentEnabled) {
          const held = await enrolledFactorTypes(tx, request.session.userId);
          const recovery = await hasRecoveryCodes(tx, request.session.userId);
          if (held.length === 0 && !recovery) {
            throw new ProblemError(
              409,
              'would-lock-you-out',
              'Set up your own second factor first',
              'Requiring a factor for the console while self-enrolment is off refuses anyone who does not already hold one — including you. Enrol from the Security page, then save this again.',
            );
          }
        }

        // THE DOMAIN IS THE WEBAUTHN RELYING PARTY, and moving it does not
        // migrate the keys bound to the old one — it makes every one of them
        // unusable, silently, at whatever moment its holder next tries to
        // sign in. So the change is refused until somebody has been shown the
        // number and sent it back.
        //
        // The same conversation `DELETE /sources/:id` has about the accounts a
        // source owns: 409 carrying the count, then the same request again
        // with the count acknowledged.
        const { ackPasskeys, ...settings } = body;
        const atRisk = await passkeysAtRisk(tx, settings.primaryDomain);
        if (atRisk > 0 && ackPasskeys !== atRisk) {
          const error = new PasskeysWouldBreakError(atRisk);
          throw new ProblemError(
            409,
            'passkeys-would-break',
            'Confirmation required',
            error.message,
            { passkeys: atRisk },
          );
        }

        const saved = await updateTenant(tx, settings);

        // Same transaction as the change, like every other admin mutation.
        // Both settings, always, rather than only what the body mentioned: an
        // operator reading this log later wants the state that resulted, not
        // the diff of a form they cannot see.
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'tenant.settings_updated',
          targetType: 'Tenant',
          targetId: request.tenantId,
          outcome: 'success',
          sourceIp: request.ip,
          payload: {
            changed: Object.keys(settings),
            adminMfaRequired: saved.adminMfaRequired,
            selfEnrolmentEnabled: saved.selfEnrolmentEnabled,
            passwordMinLength: saved.passwordMinLength,
            primaryDomain: saved.primaryDomain,
            // On the event whether or not any broke, so "who moved the domain,
            // when, and what did it cost" is answerable from the log alone.
            passkeysInvalidated: atRisk,
          },
        });
        return saved;
      });
    },
  );
}
