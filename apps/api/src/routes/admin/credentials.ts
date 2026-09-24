import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  credentialKeyParam,
  credentialMetadataRequest,
  credentialScanRequest,
  idParam,
  rotationListQuery,
  securityNotificationSettingsRequest,
  stageRotationRequest,
} from '@syntra/contracts';
import {
  PERMISSIONS,
  SECURITY_NOTIFICATION_CATEGORIES,
  SECURITY_NOTIFICATION_CATEGORY_KEYS,
  CredentialRefusedError,
  RotationRefusedError,
  buildCredentialInventory,
  cancelRotation,
  completeRotation,
  credentialItemView,
  cutOverRotation,
  hasPermission,
  listRotations,
  readRotation,
  readSecurityNotificationSettings,
  rollbackRotation,
  rotationSystemKind,
  scanCredentials,
  stageRotation,
  updateCredentialMetadata,
  updateSecurityNotificationSettings,
  verifyRotation,
  type MasterKeyProvider,
  type Permission,
  type RotatableSystemKind,
  type RotationRefusal,
} from '@syntra/core';
import { ProblemError } from '../../plugins/problem-json.js';
import { requirePermission, tokenScopeAllows } from '../../plugins/require-permission.js';
import { requireSession } from '../../plugins/require-session.js';

/**
 * The credential inventory, the dual-secret rotation workflow and the
 * security notification policy (backlog #34, #52, #67).
 *
 * Reading the inventory is `audit.read`, like the incident list it feeds: it
 * holds names and dates, never a credential, and the person who notices an
 * expiry should be able to see it. Changing an owner or a declared expiry and
 * running a scan are `tenant.manage`. A rotation needs the permission that
 * already governs the system's credential -- `provision.manage` for a target,
 * `sync.manage` for a directory source or HR feed -- checked in the handler
 * because it depends on the system, exactly as the connector screens check it.
 */

const ROTATION_PERMISSION: Record<RotatableSystemKind, Permission> = {
  target: PERMISSIONS.PROVISION_MANAGE,
  source: PERMISSIONS.SYNC_MANAGE,
  person_source: PERMISSIONS.SYNC_MANAGE,
};

const ROTATION_STATUS: Record<RotationRefusal, number> = {
  not_found: 404,
  system_not_found: 404,
  no_credential: 409,
  already_open: 409,
  state: 409,
  not_verified: 409,
  verification_stale: 409,
  configuration_changed: 409,
  check_failed: 422,
};

function rotationProblem(cause: unknown): never {
  if (cause instanceof RotationRefusedError) {
    throw new ProblemError(
      ROTATION_STATUS[cause.code],
      `rotation-${cause.code.replace(/_/g, '-')}`,
      'Rotation refused',
      cause.message,
    );
  }
  throw cause;
}

async function assertRotationAuthority(request: FastifyRequest, kind: RotatableSystemKind): Promise<void> {
  const permission = ROTATION_PERMISSION[kind];
  const allowed = await request.db((tx) => hasPermission(tx, request.session.userId, permission));
  if (!allowed || !tokenScopeAllows(request, permission)) {
    throw new ProblemError(403, 'forbidden', 'Forbidden', `Requires ${permission}`);
  }
}

async function authorityForRotation(request: FastifyRequest, id: string): Promise<void> {
  const kind = await request.db((tx) => rotationSystemKind(tx, id));
  if (!kind) throw new ProblemError(404, 'rotation-not-found', 'Rotation not found');
  await assertRotationAuthority(request, kind);
}

export async function registerAdminCredentialRoutes(
  app: FastifyInstance,
  options: { keyProvider: MasterKeyProvider },
): Promise<void> {
  app.addHook('preHandler', requireSession('admin'));
  const provider = options.keyProvider;

  app.get(
    '/credentials',
    { preHandler: requirePermission(PERMISSIONS.AUDIT_READ) },
    async (request) => {
      const { alertDays, items } = await request.db((tx) => buildCredentialInventory(tx));
      const open = await request.db((tx) => listRotations(tx, { open: true }));
      return {
        alertDays,
        items: items.map((item) => ({
          ...credentialItemView(item),
          openRotation: item.rotation
            ? (open.find((r) => r.systemKind === item.rotation!.systemKind && r.systemId === item.rotation!.systemId) ?? null)
            : null,
        })),
      };
    },
  );

  app.patch(
    '/credentials/:key',
    { preHandler: requirePermission(PERMISSIONS.TENANT_MANAGE) },
    async (request) => {
      const { key } = credentialKeyParam.parse(request.params);
      const body = credentialMetadataRequest.parse(request.body);
      return request
        .db((tx) =>
          updateCredentialMetadata(tx, request.session.userId, key, {
            ...(body.ownerUserId !== undefined ? { ownerUserId: body.ownerUserId } : {}),
            ...(body.declaredExpiresAt !== undefined
              ? { declaredExpiresAt: body.declaredExpiresAt === null ? null : new Date(body.declaredExpiresAt) }
              : {}),
            ...(body.note !== undefined ? { note: body.note === '' ? null : body.note } : {}),
          }),
        )
        .catch((cause: unknown) => {
          if (cause instanceof CredentialRefusedError) {
            throw new ProblemError(
              cause.code === 'not_declarable' ? 409 : 404,
              `credential-${cause.code.replace(/_/g, '-')}`,
              'Credential refused',
              cause.message,
            );
          }
          throw cause;
        });
    },
  );

  /**
   * Runs the expiry scan now: Entra discovery (where the registration may read
   * itself), then any alert whose threshold has been crossed. Outside
   * `request.db` -- discovery talks to Microsoft.
   */
  app.post(
    '/credentials/scan',
    { preHandler: requirePermission(PERMISSIONS.TENANT_MANAGE) },
    async (request) => {
      const body = credentialScanRequest.parse(request.body ?? {});
      return scanCredentials(request.tenantId, provider, { forceDiscovery: body.forceDiscovery });
    },
  );

  app.get(
    '/credentials/rotations',
    { preHandler: requirePermission(PERMISSIONS.AUDIT_READ) },
    async (request) => {
      const query = rotationListQuery.parse(request.query ?? {});
      return {
        rotations: await request.db((tx) =>
          listRotations(tx, {
            systemKind: query.systemKind,
            systemId: query.systemId,
            open: query.open === 'true',
          }),
        ),
      };
    },
  );

  app.get(
    '/credentials/rotations/:id',
    { preHandler: requirePermission(PERMISSIONS.AUDIT_READ) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const rotation = await request.db((tx) => readRotation(tx, id));
      if (!rotation) throw new ProblemError(404, 'rotation-not-found', 'Rotation not found');
      return rotation;
    },
  );

  app.post('/credentials/rotations', async (request, reply) => {
    const body = stageRotationRequest.parse(request.body);
    await assertRotationAuthority(request, body.systemKind);
    const rotation = await stageRotation(request.tenantId, provider, request.session.userId, {
      systemKind: body.systemKind,
      systemId: body.systemId,
      secret: body.secret,
      newExpiresAt: body.newExpiresAt ? new Date(body.newExpiresAt) : null,
      reason: body.reason ?? null,
    }).catch(rotationProblem);
    return reply.code(201).send(rotation);
  });

  const step = (
    path: string,
    run: (id: string, userId: string, tenantId: string) => Promise<unknown>,
  ) =>
    app.post(`/credentials/rotations/:id/${path}`, async (request) => {
      const { id } = idParam.parse(request.params);
      await authorityForRotation(request, id);
      return run(id, request.session.userId, request.tenantId).catch(rotationProblem);
    });

  step('verify', (id, userId, tenantId) => verifyRotation(tenantId, provider, userId, id));
  step('cutover', (id, userId, tenantId) => cutOverRotation(tenantId, provider, userId, id));
  step('complete', (id, userId, tenantId) => completeRotation(tenantId, provider, userId, id));
  step('rollback', (id, userId, tenantId) => rollbackRotation(tenantId, provider, userId, id));
  step('cancel', (id, userId, tenantId) => cancelRotation(tenantId, userId, id));

  /** The security notification policy: what exists, and what this tenant mails. */
  app.get(
    '/security-notifications',
    { preHandler: requirePermission(PERMISSIONS.TENANT_MANAGE) },
    async (request) => {
      const settings = await request.db((tx) => readSecurityNotificationSettings(tx));
      return {
        ...settings,
        categories: SECURITY_NOTIFICATION_CATEGORY_KEYS.map((key) => ({
          key,
          label: SECURITY_NOTIFICATION_CATEGORIES[key].label,
          description: SECURITY_NOTIFICATION_CATEGORIES[key].description,
          actions: [...SECURITY_NOTIFICATION_CATEGORIES[key].actions],
          emailEnabled: settings.emailCategories.includes(key),
        })),
      };
    },
  );

  app.put(
    '/security-notifications',
    { preHandler: requirePermission(PERMISSIONS.TENANT_MANAGE) },
    async (request) => {
      const body = securityNotificationSettingsRequest.parse(request.body);
      return request.db((tx) =>
        updateSecurityNotificationSettings(tx, request.session.userId, {
          emailCategories: body.emailCategories,
          alertDays: body.alertDays,
        }),
      );
    },
  );
}
