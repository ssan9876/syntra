import { invalidateProvider } from '@syntra/protocols';
import type { FastifyInstance } from 'fastify';
import { brandRequest, tenantSettingsRequest } from '@syntra/contracts';
import {
  PERMISSIONS,
  BrandRefusedError,
  TENANT_SETTINGS_OPERATION,
  authPolicyRelaxations,
  isChangeClassHeld,
  readBrand,
  readTenant,
  recordEvent,
  setBrand,
  tenantSettingsRevision,
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
import { heldReply, holdPrivilegedChange } from '../../privileged-changes.js';
import { applyTenantSettings } from './tenant-settings.js';

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
            // In full, unlike the logo: it is a short string, and "who pointed
            // the sign-in page's help link at this address, and when" is
            // precisely what an investigation of a phishing report asks.
            supportUrl: brand.supportUrl,
            supportLabel: brand.supportLabel,
          },
        });
        return brand;
      });
    },
  );

  app.put(
    '/tenant',
    { preHandler: requirePermission(PERMISSIONS.TENANT_MANAGE) },
    async (request, reply) => {
      const body = tenantSettingsRequest.parse(request.body);

      // Read once outside the transaction as well, to compare hostnames after
      // it commits. The in-transaction read inside `applyTenantSettings`
      // stays: the lockout check needs a value the write is serialised
      // against, not one from before it.
      const hostnamesBefore = await request.db((tx) => readTenant(tx));

      const outcome = await request.db(async (tx) => {
        // SEPARATION OF DUTIES. Where the tenant holds authentication-policy
        // relaxations for a second administrator, a body that weakens any
        // sign-in setting is stored whole as a change request instead of
        // applied. Tightening is never held.
        if (await isChangeClassHeld(tx, 'auth_policy')) {
          const relaxed = authPolicyRelaxations(await readTenant(tx), body);
          if (relaxed.length > 0) {
            const held = await holdPrivilegedChange(request, tx, {
              changeClass: 'auth_policy',
              operation: TENANT_SETTINGS_OPERATION,
              targetType: 'Tenant',
              targetId: request.tenantId,
              summary: `Relax sign-in settings: ${relaxed.join(', ')}`,
              proposed: body as Record<string, unknown>,
              baseRevision: await tenantSettingsRevision(tx),
            });
            return { held } as const;
          }
        }
        return {
          saved: await applyTenantSettings(tx, {
            userId: request.session.userId,
            satisfiedFactor: request.session.satisfiedFactor,
            sourceIp: request.ip,
          }, body),
        } as const;
      });
      if ('held' in outcome) return heldReply(reply, outcome.held);
      const { saved } = outcome;

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
      //
      // This is the local fast path. Other replicas rebuild because the same
      // UPDATE bumped `Tenant.oidcConfigGeneration` (a BEFORE trigger on the
      // hostname columns), and the issuer they compute from the fresh row no
      // longer matches the one their cached Provider was built with.
      const hostnamesMoved =
        saved.primaryDomain !== hostnamesBefore.primaryDomain ||
        saved.additionalDomains.join(',') !== hostnamesBefore.additionalDomains.join(',');
      if (hostnamesMoved) invalidateProvider(request.tenantId);

      return saved;
    },
  );
}

const DIGEST = z.string().regex(/^[a-f0-9]{64}$/, 'a SHA-256 digest in lowercase hex');

export const deletionRequestBody = z.object({
  assessmentDigest: DIGEST,
  exportDigest: DIGEST,
  reason: z.string().trim().min(TENANT_DELETION_REASON_MIN_LENGTH).max(2000),
});

export const deletionIdParam = z.object({ id: z.string().uuid() });

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
