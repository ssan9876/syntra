import { invalidateProvider } from '@syntra/protocols';
import type { FastifyInstance } from 'fastify';
import { brandRequest, tenantSettingsRequest } from '@syntra/contracts';
import {
  PERMISSIONS,
  BrandRefusedError,
  enrolledFactorTypes,
  DomainTakenError,
  assertDomainsFree,
  hasRecoveryCodes,
  PasskeysWouldBreakError,
  passkeysAtRisk,
  readBrand,
  readTenant,
  recordEvent,
  setBrand,
  updateTenant,
  assessTenantOffboarding,
  createTenantDataExport,
  approveTenantDeletion,
  cancelTenantDeletion,
  executeTenantDeletion,
  getTenantDeletionState,
  requestTenantDeletion,
  TenantDeletionRefusedError,
  TENANT_DELETION_APPROVAL_WINDOW_MS,
  TENANT_DELETION_COOLING_OFF_MS,
  TENANT_DELETION_EXECUTION_WINDOW_MS,
  TENANT_DELETION_REASON_MIN_LENGTH,
  TENANT_DELETION_STEP_UP_MAX_AGE_MS,
  type TenantDeletionRequestRow,
} from '@syntra/core';
import { z } from 'zod';
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

  app.post(
    '/tenant/offboarding/assess',
    { preHandler: requirePermission(PERMISSIONS.TENANT_MANAGE) },
    async (request) => assessTenantOffboarding(request.tenantId, request.session.userId),
  );

  app.post(
    '/tenant/offboarding/export',
    { preHandler: requirePermission(PERMISSIONS.TENANT_MANAGE) },
    async (request, reply) => {
      const artifact = await createTenantDataExport(request.tenantId, request.session.userId);
      return reply
        .header('content-type', 'application/json; charset=utf-8')
        .header('content-disposition', `attachment; filename="syntra-tenant-${request.tenantId}.json"`)
        .header('x-syntra-export-digest', artifact.digest)
        .send(artifact);
    },
  );

  // ---- Tenant deletion: request, four-eyes approval, execution. ----------
  //
  // Every step is `tenant.manage`, and none accepts a machine token (see
  // TOKEN_DENIED_ROUTES): erasing a tenant is a thing people decide. Approval
  // and execution also need a FRESH administrative session -- its creation
  // time is the step-up evidence core checks and records.

  app.get(
    '/tenant/deletion',
    { preHandler: requirePermission(PERMISSIONS.TENANT_MANAGE) },
    async (request) => ({
      request: presentDeletion(await getTenantDeletionState(request.tenantId)),
      viewerUserId: request.session.userId,
      policy: DELETION_POLICY,
    }),
  );

  app.post(
    '/tenant/deletion/requests',
    { preHandler: requirePermission(PERMISSIONS.TENANT_MANAGE) },
    async (request) => {
      const body = deletionRequestBody.parse(request.body);
      return presentDeletion(await refusalsAsProblems(() => requestTenantDeletion(request.tenantId, {
        actorUserId: request.session.userId, ...body,
      })));
    },
  );

  app.post(
    '/tenant/deletion/requests/:id/approve',
    { preHandler: requirePermission(PERMISSIONS.TENANT_MANAGE) },
    async (request) => {
      const { id } = deletionIdParam.parse(request.params);
      return presentDeletion(await refusalsAsProblems(() => approveTenantDeletion(request.tenantId, id, {
        actorUserId: request.session.userId, stepUpAt: request.session.createdAt,
      })));
    },
  );

  app.post(
    '/tenant/deletion/requests/:id/cancel',
    { preHandler: requirePermission(PERMISSIONS.TENANT_MANAGE) },
    async (request) => {
      const { id } = deletionIdParam.parse(request.params);
      return presentDeletion(await refusalsAsProblems(() => cancelTenantDeletion(request.tenantId, id, request.session.userId)));
    },
  );

  /**
   * The irreversible one. On success the tenant no longer resolves, this
   * session is among the rows erased, and the response is the only copy of
   * the receipt the caller will be handed -- so it is returned whole.
   */
  app.post(
    '/tenant/deletion/requests/:id/execute',
    { preHandler: requirePermission(PERMISSIONS.TENANT_MANAGE) },
    async (request) => {
      const { id } = deletionIdParam.parse(request.params);
      return refusalsAsProblems(() => executeTenantDeletion(request.tenantId, id, {
        actorUserId: request.session.userId, stepUpAt: request.session.createdAt,
      }));
    },
  );

  app.get(
    '/tenant/brand',
    { preHandler: requirePermission(PERMISSIONS.TENANT_MANAGE) },
    async (request) => request.db((tx) => readBrand(tx)),
  );

  /**
   * The refusals here are the point of the endpoint.
   *
   * A colour that cannot be read, or a logo that fetches from somewhere, is
   * not a validation nicety — both render on the unauthenticated sign-in page.
   * They come back as 400 with the reason and the measured number attached,
   * because the administrator is standing in front of the message and "that
   * colour is not allowed" sends them back to guessing.
   */
  app.put(
    '/tenant/brand',
    { preHandler: requirePermission(PERMISSIONS.TENANT_MANAGE) },
    async (request) => {
      const body = brandRequest.parse(request.body);
      return request.db(async (tx) => {
        let brand;
        try {
          brand = await setBrand(tx, body);
        } catch (cause) {
          if (cause instanceof BrandRefusedError) {
            throw new ProblemError(400, 'brand-refused', 'That branding cannot be used', cause.message);
          }
          throw cause;
        }
        await recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'tenant.brand_updated',
          targetType: 'Tenant',
          targetId: null,
          outcome: 'success',
          sourceIp: request.ip,
          // The logo itself is NOT in the payload. An audit event is read far
          // more often than a logo changes, and a quarter-megabyte data URI in
          // every export is a cost nobody signed up for. Whether one is set is
          // the fact anybody auditing this actually wants.
          payload: {
            name: brand.name,
            primary: brand.primary,
            accent: brand.accent,
            logo: brand.logo === null ? 'none' : 'set',
          },
        });
        return brand;
      });
    },
  );

  app.put(
    '/tenant',
    { preHandler: requirePermission(PERMISSIONS.TENANT_MANAGE) },
    async (request) => {
      const body = tenantSettingsRequest.parse(request.body);

      // Read once outside the transaction as well, to compare hostnames after
      // it commits. The in-transaction read below stays: the lockout check
      // needs a value the write is serialised against, not one from before it.
      const hostnamesBefore = await request.db((tx) => readTenant(tx));

      const saved = await request.db(async (tx) => {
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

        // Before anything is written. `resolveTenantId` returns the FIRST
        // match, so two tenants claiming one hostname is not an error at
        // request time — it is whichever row the database happened to return,
        // which is the quietest possible way to serve one organization's data
        // to another.
        try {
          await assertDomainsFree(tx, settings);
        } catch (cause) {
          if (cause instanceof DomainTakenError) {
            throw new ProblemError(409, 'domain-taken', 'That hostname is in use', cause.message, {
              domain: cause.domain,
            });
          }
          throw cause;
        }

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
            lockoutThreshold: saved.lockoutThreshold,
            lockoutWindowMinutes: saved.lockoutWindowMinutes,
            lockoutDurationMinutes: saved.lockoutDurationMinutes,
            passwordMaxAgeDays: saved.passwordMaxAgeDays,
            passwordHistoryDepth: saved.passwordHistoryDepth,
            primaryDomain: saved.primaryDomain,
            additionalDomains: saved.additionalDomains,
            // On the event whether or not any broke, so "who moved the domain,
            // when, and what did it cost" is answerable from the log alone.
            passkeysInvalidated: atRisk,
          },
        });
        return saved;
      });

      // AFTER the commit, and only when a hostname actually moved.
      //
      // `providerFor` caches one Provider per tenant with the issuer fixed at
      // construction -- oidc-provider asserts a single web URI and never
      // re-reads it. `invalidateProvider` was wired to client changes and to
      // key rotation and not to this route, which is the only one that changes
      // `primaryDomain`, so every token carried the old `iss` until a restart
      // or an unrelated rotation. A relying party validates `iss` against the
      // issuer it discovered, so those tokens were simply rejected, with
      // nothing anywhere saying why.
      //
      // Guarded on the hostnames rather than called unconditionally: rebuilding
      // the provider discards every cached client and re-reads the key set,
      // and this route is saved from for reasons that have nothing to do with
      // the issuer.
      const hostnamesMoved =
        saved.primaryDomain !== hostnamesBefore.primaryDomain ||
        saved.additionalDomains.join(',') !== hostnamesBefore.additionalDomains.join(',');
      if (hostnamesMoved) invalidateProvider(request.tenantId);

      return saved;
    },
  );
}

const DIGEST = z.string().regex(/^[a-f0-9]{64}$/, 'a SHA-256 digest in lowercase hex');

const deletionRequestBody = z.object({
  assessmentDigest: DIGEST,
  exportDigest: DIGEST,
  reason: z.string().trim().min(TENANT_DELETION_REASON_MIN_LENGTH).max(2000),
});

const deletionIdParam = z.object({ id: z.string().uuid() });

/** The windows the console explains; the server enforces them regardless. */
const DELETION_POLICY = {
  approvalWindowHours: TENANT_DELETION_APPROVAL_WINDOW_MS / 3_600_000,
  coolingOffHours: TENANT_DELETION_COOLING_OFF_MS / 3_600_000,
  executionWindowHours: TENANT_DELETION_EXECUTION_WINDOW_MS / 3_600_000,
  stepUpMaxAgeMinutes: TENANT_DELETION_STEP_UP_MAX_AGE_MS / 60_000,
  reasonMinLength: TENANT_DELETION_REASON_MIN_LENGTH,
};

/** The request as the console shows it. The stored receipt stays server-side. */
function presentDeletion(row: TenantDeletionRequestRow | null) {
  if (row === null) return null;
  const { receipt: _receipt, tenantId: _tenantId, ...rest } = row;
  return rest;
}

/**
 * Refusals are the expected outcome of most calls here -- a hold, a stale
 * export, the same administrator approving -- so each keeps its own code for
 * the console to explain.
 */
async function refusalsAsProblems<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof TenantDeletionRefusedError)) throw error;
    const status = error.code === 'not-found' ? 404
      : error.code === 'four-eyes-required' || error.code === 'step-up-required' ? 403
        : error.code === 'reason-required' ? 400
          : 409;
    throw new ProblemError(status, error.code, 'Tenant deletion refused', error.message);
  }
}
