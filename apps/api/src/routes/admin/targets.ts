import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  containerListResponse,
  createTargetRequestSchema,
  idParam,
  movePlacementRequest,
  placementResponse,
  testTargetRequestSchema,
  updateTargetRequestSchema,
  adoptAccountRequest,
} from '@syntra/contracts';
import {
  BUILTIN_CONNECTOR_DOCUMENTS,
  ENTRA_CAPABILITY_MATRIX,
  capabilitiesForTarget,
  connectorLifecycleMetadata,
  entraTargetConnector,
  targetConnectorFor,
  type DiscoveredEntitlement,
} from '@syntra/connectors';
import {
  PERMISSIONS,
  ContainerNotInTargetError,
  LadderConfigurationError,
  NoAccountToMoveError,
  NoCorrelationKeyError,
  PairedDirectorySourceNotFoundError,
  AnchorAlreadyBoundError,
  CandidateNotVisibleError,
  NoAccountToAdoptError,
  NotInConflictError,
  TargetNotFoundError,
  adoptAccount,
  adoptionCandidate,
  clearPlacement,
  createTarget,
  deleteTarget,
  findPlacement,
  type MasterKeyProvider,
  moveAccount,
  recordEvent,
  recordReadinessCheck,
  currentReadiness,
  refreshEntitlements,
  targetContainers,
  targetWithCredential,
  testTargetConfiguration,
  updateTarget,
  previewDocumentEntraMigration,
  applyDocumentEntraMigration,
  TargetMigrationNotAvailableError,
  TargetMigrationPreviewStaleError,
  targetConnectorHealth,
  pauseTargetExternalWrites,
  resumeTargetExternalWrites,
  TargetWriteStopNotFoundError,
  TargetWriteStopStateError,
  TargetWriteStopSeparationError,
  ExternalWritesPausedError,
  pauseTenantExternalWrites,
  resumeTenantExternalWrites,
  tenantExternalWriteStop,
  TenantWriteStopStateError,
  TenantWriteStopSeparationError,
  AdapterRolloutNotFoundError,
  AdapterSelectionError,
  AdapterWritesBlockedError,
  adapterWriteContext,
  targetAdapterReport,
  setTargetAdapterSelection,
  rollbackTargetAdapter,
  grantDeprecationOverride,
  clearDeprecationOverride,
  MAX_DEPRECATION_OVERRIDE_MS,
  type Scheduler,
} from '@syntra/core';
import { ProblemError } from '../../plugins/problem-json.js';
import { requireSession } from '../../plugins/require-session.js';
import { requirePermission } from '../../plugins/require-permission.js';
import { confirmQuery } from './list-query.js';

export interface TargetRouteOptions {
  keyProvider: MasterKeyProvider;
  /**
   * Late-bound, exactly as the source routes take it: the scheduler talks to
   * pg-boss, is started after the app is built, and is allowed to fail to
   * start without keeping the API down.
   */
  scheduler?: () => Scheduler | null;
  authRateLimitMax: number;
}

/**
 * Everything safe to return. `secretName` and the bind credential are not
 * among it, and neither is `concurrency`.
 *
 * `TargetSystem.concurrency` is stored, validated and defaulted, and the apply
 * loop is sequential — the column has never had a reader. Rendering it would
 * put a knob on a screen that does nothing, and a setting an administrator can
 * change with no effect is worse than an absent one: they will change it, and
 * conclude something else is broken. It is left out of the response and out of
 * `updateTargetRequestSchema` until the loop honours it.
 */
const TARGET_FIELDS = {
  id: true,
  name: true,
  type: true,
  config: true,
  pairedDirectorySourceId: true,
  schedule: true,
  autoApply: true,
  enabled: true,
  enforcementMode: true,
  preHireDays: true,
  entitlementRevocationDelayDays: true,
  disableGraceDays: true,
  archiveAfterDays: true,
  reenableWithoutConfirmationDays: true,
  createAccountThresholdPercent: true,
  disableAccountThresholdPercent: true,
  archiveAccountThresholdPercent: true,
  revokeEntitlementThresholdPercent: true,
  deactivateSyntraUserThresholdPercent: true,
  perEntitlementThresholdPercent: true,
  personPopulationDropPercent: true,
  maxAttempts: true,
  renameEnabled: true,
  lastRunAt: true,
  lastAppliedRunAt: true,
  // Ruling P4: a target that has skipped repeatedly must be visibly
  // distinguishable from one running cleanly, so these travel with the list.
  consecutiveSkippedRuns: true,
  lastSkippedAt: true,
  lastSkipReason: true,
  externalWritesPausedAt: true,
  externalWritesPausedByUserId: true,
  externalWritesPauseReason: true,
  externalWritesPauseExpiresAt: true,
  externalWritesResumedAt: true,
  externalWritesResumedByUserId: true,
  maintenanceWindowEnabled: true,
  maintenanceWindowDays: true,
  maintenanceWindowStartMinute: true,
  maintenanceWindowDurationMinutes: true,
} as const;

/**
 * The same object with every `undefined`-valued key removed.
 *
 * `exactOptionalPropertyTypes` is on in this workspace, so `foo?: string` and
 * `foo?: string | undefined` are different types — and Zod produces the second
 * for every `.optional()` while the service interfaces declare the first. The
 * alternative is thirteen `...(x === undefined ? {} : { x })` spreads per call
 * site, which is the same operation written out longhand and one field away
 * from being wrong.
 *
 * Not merely a type assertion: the keys really are deleted, so an absent field
 * cannot arrive at a Prisma `data` as an explicit `undefined` either.
 */
type Defined<T> = { [K in keyof T]: Exclude<T[K], undefined> };
function defined<T extends object>(value: T): Defined<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as Defined<T>;
}

/**
 * A catalog search. `q` is non-blank; `top` is bounded, because for an Entra
 * target the search goes to Graph live and an unbounded page is a request
 * Graph refuses anyway.
 */
export const entitlementSearchQuery = z.object({
  q: z.string().trim().min(1).max(200),
  top: z.coerce.number().int().min(1).max(100).default(25),
});
export const targetHealthQuery = z.object({ days: z.coerce.number().int().min(1).max(90).default(30) });
export const writeStopRequest = z.object({
  reason: z.string().trim().min(1).max(2000),
  expiresAt: z.coerce.date().nullable().default(null),
}).strict();
export const writeResumeRequest = z.object({ reason: z.string().trim().min(1).max(2000) }).strict();
/**
 * The preview revision a native-Entra migration is applied against, so a
 * target changed since the preview was read refuses as stale.
 */
export const nativeEntraMigrationRequest = z.object({ revision: z.string().length(64) }).strict();

/**
 * Adapter rollout bodies. Every change carries a reason of substance: these
 * are the records somebody reads after a canary misbehaved.
 */
const adapterReason = z.string().trim().min(10).max(2000);
export const adapterSelectionRequest = z.object({
  channel: z.enum(['stable', 'canary']),
  version: z.string().regex(/^\d+\.\d+\.\d+$/).nullable().default(null),
  reason: adapterReason,
}).strict();
export const adapterReasonRequest = z.object({ reason: adapterReason }).strict();
export const deprecationOverrideRequest = z.object({
  reason: adapterReason,
  expiresAt: z.coerce.date(),
}).strict();

/** The adapter rollout refusals, as problems. Anything else is rethrown. */
function adapterProblem(error: unknown): never {
  if (error instanceof AdapterRolloutNotFoundError) throw new ProblemError(404, 'not-found', 'Target not found');
  if (error instanceof AdapterSelectionError) {
    throw new ProblemError(409, 'adapter-selection-refused', 'The adapter change was refused', error.message);
  }
  throw error;
}

/** Both ids, so a route cannot read one and forget to validate the other. */
export const placementParams = z.object({
  id: z.string().uuid(),
  personId: z.string().uuid(),
});

/**
 * The adoption service's refusals, as problem responses.
 *
 * Shared by both routes so the GET and the POST cannot describe the same
 * refusal two different ways — the dialog reads the GET's message and then
 * submits to the POST, and an administrator told two stories about one state
 * stops believing either.
 */
function adoptionProblem(cause: unknown): unknown {
  if (cause instanceof NoAccountToAdoptError) {
    return new ProblemError(
      409,
      'nothing-to-adopt',
      'There is no account to adopt',
      cause.message,
    );
  }
  if (cause instanceof NotInConflictError) {
    return new ProblemError(
      409,
      'not-in-conflict',
      'This account is not in conflict',
      cause.message,
    );
  }
  if (cause instanceof AnchorAlreadyBoundError) {
    return new ProblemError(
      409,
      'anchor-already-bound',
      'That object is already taken',
      cause.message,
    );
  }
  if (cause instanceof CandidateNotVisibleError) {
    return new ProblemError(
      404,
      'candidate-not-visible',
      'That account is not visible here',
      cause.message,
    );
  }
  return cause;
}

export async function registerAdminTargetRoutes(
  app: FastifyInstance,
  options: TargetRouteOptions,
): Promise<void> {
  app.addHook('preHandler', requireSession('admin'));
  const provider = options.keyProvider;
  const scheduler = () => options.scheduler?.() ?? undefined;

  app.get(
    '/targets',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_READ) },
    async (request) => ({
      targets: await request.db((tx) =>
        tx.targetSystem.findMany({ select: TARGET_FIELDS, orderBy: { name: 'asc' } }),
      ),
    }),
  );

  /**
   * The connector documents that ship with the product.
   *
   * Served rather than bundled into the console, because
   * `@syntra/connectors` reaches for `node:dns` and `node:https` and does not
   * belong in a browser bundle. This route is also the only place the two
   * ever have to agree, so the console cannot drift from what the connector
   * will actually run.
   *
   * `PROVISION_READ`, not `MANAGE`: these are constants, identical for every
   * tenant, and carry no credential — the `{clientId}` and `{tenant}` in them
   * are placeholders an administrator replaces, not values.
   */
  app.get(
    '/targets/connector-documents',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_READ) },
    async () => ({
      documents: Object.entries(BUILTIN_CONNECTOR_DOCUMENTS).map(([key, document]) => ({
        key,
        name: document.name,
        document,
      })),
    }),
  );

  /**
   * The containers this target holds.
   *
   * A live read through the connector, not a cached list. Provision creates no
   * containers, so this is the closed set an account may be moved into, and a
   * stale copy is a Move screen offering somewhere that no longer exists —
   * or, worse, omitting the one somebody is trying to move an account to.
   */
  app.get(
    '/targets/:id/containers',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_READ) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      // A target this tenant does not have is a 404 before anything is
      // dialled; it was a 502 "target unreachable", which told an operator to
      // go and look at a directory that was never the problem.
      const target = await request.db((tx) =>
        tx.targetSystem.findUnique({ where: { id }, select: { id: true } }),
      );
      if (!target) throw new ProblemError(404, 'not-found', 'Target not found');
      const containers = await targetContainers(request.tenantId, provider, id).catch(
        (cause: unknown) => {
          throw new ProblemError(
            502,
            'target-unreachable',
            'The target could not be read',
            cause instanceof Error ? cause.message : String(cause),
          );
        },
      );
      return containerListResponse.parse({ containers });
    },
  );

  app.get(
    '/targets/:id/placements/:personId',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_READ) },
    async (request) => {
      const { id, personId } = placementParams.parse(request.params);
      const placement = await request.db((tx) => findPlacement(tx, personId, id));
      // `null` rather than a 404: "this person follows the rule" is an answer,
      // and the ordinary one. A 404 would make the common case look like an
      // error on every person page that renders this.
      return placement === null
        ? { placement: null }
        : {
            placement: placementResponse.parse({
              ...placement,
              updatedAt: placement.updatedAt.toISOString(),
            }),
          };
    },
  );

  /**
   * Move one person's account, and record the decision that keeps it moved.
   *
   * `PROVISION_MANAGE`, the same permission as every other write against a
   * target. This is not a read-shaped operation: it writes to the directory
   * and it overrides a placement rule for as long as it stands.
   */
  app.put(
    '/targets/:id/placements/:personId',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_MANAGE) },
    async (request) => {
      const { id, personId } = placementParams.parse(request.params);
      const body = movePlacementRequest.parse(request.body);
      // Both halves of the path are looked up in this tenant before the move
      // opens a connection: another tenant's target or person was a 500 ("no
      // such target", or a credential error from THIS tenant's target when
      // only the person was foreign).
      const found = await request.db(async (tx) => ({
        target: await tx.targetSystem.findUnique({ where: { id }, select: { id: true } }),
        person: await tx.person.findUnique({ where: { id: personId }, select: { id: true } }),
      }));
      if (!found.target) throw new ProblemError(404, 'not-found', 'Target not found');
      if (!found.person) throw new ProblemError(404, 'not-found', 'Person not found');

      const result = await moveAccount(request.tenantId, provider, {
        personId,
        targetSystemId: id,
        container: body.container,
        reason: body.reason,
        actorUserId: request.session.userId,
        sourceIp: request.ip,
      }).catch((cause: unknown) => {
        if (cause instanceof ContainerNotInTargetError) {
          throw new ProblemError(
            400,
            'no-such-container',
            'That container does not exist',
            cause.message,
          );
        }
        if (cause instanceof NoAccountToMoveError || cause instanceof NoCorrelationKeyError) {
          throw new ProblemError(409, 'nothing-to-move', 'There is no account to move', cause.message);
        }
        // A 409 rather than `moved: false`: nothing was attempted, and the
        // administrator needs to know it was the emergency stop and not the
        // directory. The placement itself is recorded, as the detail says.
        if (cause instanceof ExternalWritesPausedError) {
          throw new ProblemError(
            409,
            'external-writes-paused',
            'External writes are paused',
            `${cause.message}. The placement is recorded and the next run proposes the move once writes resume.`,
            { scope: cause.scope },
          );
        }
        if (cause instanceof AdapterWritesBlockedError) {
          throw new ProblemError(
            409,
            'adapter-write-refused',
            'The adapter may not make this write',
            `${cause.message}. The placement is recorded.`,
          );
        }
        throw cause;
      });

      // 200 either way, with `moved` on it. A directory write that failed is
      // not a failed request: the placement stands and the next run retries
      // the move, and answering 500 would tell the administrator their
      // decision was lost when it was not.
      return result;
    },
  );

  /**
   * The object an adoption would bind, read from the target on demand.
   *
   * `PROVISION_MANAGE` despite being a GET. It opens a connection to the
   * directory and names an object by DN; it is not read-shaped just because
   * of its verb. Called when the dialog opens, never on page load.
   */
  app.get(
    '/targets/:id/accounts/:personId/adoption-candidate',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_MANAGE) },
    async (request) => {
      const { id, personId } = placementParams.parse(request.params);
      return adoptionCandidate(request.tenantId, provider, personId, id).catch(
        (cause: unknown) => {
          throw adoptionProblem(cause);
        },
      );
    },
  );

  /**
   * Binding a conflicted account to the object that caused the collision.
   *
   * The exit from a state nothing else clears. `conflict` is set when the
   * target refuses a create because the name is taken, and no run writes it
   * back — reconcile makes the person unprocessable and returns.
   */
  app.post(
    '/targets/:id/accounts/:personId/adopt',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_MANAGE) },
    async (request) => {
      const { id, personId } = placementParams.parse(request.params);
      const body = adoptAccountRequest.parse(request.body);

      return adoptAccount(request.tenantId, provider, {
        personId,
        targetSystemId: id,
        reason: body.reason,
        ifNoCandidate: body.ifNoCandidate,
        actorUserId: request.session.userId,
        sourceIp: request.ip,
      }).catch((cause: unknown) => {
        throw adoptionProblem(cause);
      });
    },
  );

  app.delete(
    '/targets/:id/placements/:personId',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_MANAGE) },
    async (request, reply) => {
      const { id, personId } = placementParams.parse(request.params);
      const cleared = await request.db((tx) => clearPlacement(tx, personId, id));

      if (cleared) {
        await request.db((tx) =>
          recordEvent(tx, {
            actorUserId: request.session.userId,
            action: 'provision.placement_cleared',
            targetType: 'Person',
            targetId: personId,
            outcome: 'success',
            sourceIp: request.ip,
            // No account is moved here. The next run computes the rule's
            // answer and proposes the move, through the guard, in a plan
            // somebody reviews.
            payload: { targetSystemId: id },
          }),
        );
      }
      return reply.status(204).send();
    },
  );

  app.get(
    '/targets/:id',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_READ) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const target = await request.db((tx) =>
        tx.targetSystem.findUnique({ where: { id }, select: TARGET_FIELDS }),
      );
      if (!target) throw new ProblemError(404, 'not-found', 'Target not found');
      return target;
    },
  );

  app.post(
    '/targets',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_MANAGE) },
    async (request, reply) => {
      const body = createTargetRequestSchema.parse(request.body);
      let created;
      try {
        created = await createTarget(
          request.tenantId,
          provider,
          request.session.userId,
          defined(body),
          scheduler(),
        );
      } catch (cause) {
        // 400, not 404: the request names a target that does not exist yet and
        // a source that does not exist at all, and the second is a field an
        // editor can highlight. Unhandled it would be a bare 500 — which is
        // how a mistyped pairing used to look only if you were lucky, since
        // before the existence read it looked like a 201.
        if (cause instanceof LadderConfigurationError) {
          // 422, matching how core's other configuration refusals surface: the
          // body parsed and the values are individually in range -- what fails
          // is the order they put the rungs in.
          throw new ProblemError(
            422,
            cause.code,
            'Cannot be saved',
            cause.message,
            { errors: [{ path: cause.field, message: cause.message }] },
          );
        }
        if (cause instanceof PairedDirectorySourceNotFoundError) {
          throw new ProblemError(
            400,
            'invalid-paired-source',
            'No such directory source',
            cause.message,
            { errors: [{ path: 'pairedDirectorySourceId', message: cause.message }] },
          );
        }
        throw cause;
      }
      // `{ id }`, which is all `createTarget` returns. The row carries only
      // the secret's NAME; the credential is in the vault and is never echoed.
      return reply.code(201).send(created);
    },
  );

  app.patch(
    '/targets/:id',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_MANAGE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      // The two nested bags are destructured out first: they need the same
      // treatment one level down (`Partial<GuardThresholds>` does not admit an
      // explicit `undefined` either), and spreading them twice would leave the
      // compiler unioning the cleaned shape with the uncleaned one.
      const { thresholds, ladder, maintenanceWindow, ...scalars } = updateTargetRequestSchema.parse(
        request.body,
      );
      const startedAt = Date.now();
      try {
        await updateTarget(
          request.tenantId,
          provider,
          request.session.userId,
          id,
          {
            ...defined(scalars),
            ...(thresholds === undefined ? {} : { thresholds: defined(thresholds) }),
            ...(ladder === undefined ? {} : { ladder: defined(ladder) }),
            ...(maintenanceWindow === undefined ? {} : { maintenanceWindow }),
          },
          scheduler(),
        );
      } catch (cause) {
        if (cause instanceof TargetNotFoundError) {
          throw new ProblemError(404, 'not-found', 'Target not found');
        }
        if (cause instanceof LadderConfigurationError) {
          // 422, matching how core's other configuration refusals surface: the
          // body parsed and the values are individually in range -- what fails
          // is the order they put the rungs in.
          throw new ProblemError(
            422,
            cause.code,
            'Cannot be saved',
            cause.message,
            { errors: [{ path: cause.field, message: cause.message }] },
          );
        }
        if (cause instanceof PairedDirectorySourceNotFoundError) {
          // The target exists; the source it was asked to pair with does not.
          // A 404 here would read as "no such target" and send an
          // administrator looking in the wrong place.
          throw new ProblemError(
            400,
            'invalid-paired-source',
            'No such directory source',
            cause.message,
            { errors: [{ path: 'pairedDirectorySourceId', message: cause.message }] },
          );
        }
        throw cause;
      }

      if (scalars.bindPassword !== undefined) {
        // A rotation is a change to the one thing a readiness check attests,
        // so it leaves one behind: the new credential is tried against the
        // saved configuration and the outcome recorded, prefixed so the
        // history says why this check exists. Outside `request.db` -- this
        // opens a socket to a third party, and `testTargetConfiguration`
        // opens its own short transaction for the vault read.
        const saved = await request.db((tx) =>
          tx.targetSystem.findUnique({ where: { id }, select: { type: true, config: true } }),
        );
        if (saved) {
          const result = await testTargetConfiguration(request.tenantId, provider, {
            type: saved.type,
            config: saved.config,
            borrowFromTargetId: id,
          }).catch((cause: unknown) => ({
            ok: false,
            message: cause instanceof Error ? cause.message : String(cause),
          }));
          await recordReadinessCheck(request.tenantId, {
            systemKind: 'target',
            systemId: id,
            configuration: saved.config,
            capabilities:
              'rights' in result
                ? (result.rights?.map((right) => `${right.right}:${right.status}`) ?? [])
                : [],
            status: result.ok ? 'passed' : 'failed',
            latencyMs: Date.now() - startedAt,
            message: `credential rotated: ${result.message}`,
            actorUserId: request.session.userId,
          });
        }
      }
      return reply.code(204).send();
    },
  );

  /**
   * What this target can do, as the console should say it.
   *
   * `capabilities` is the per-target answer (`capabilitiesForTarget` reads an
   * `httpJson` document rather than reporting the family's ceiling); `matrix`
   * is the versioned Entra matrix with its validation status per entry, and
   * null for every other type.
   */
  app.get(
    '/targets/:id/capabilities',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_READ) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const target = await request.db((tx) =>
        tx.targetSystem.findUnique({ where: { id }, select: { type: true, config: true } }),
      );
      if (!target) throw new ProblemError(404, 'not-found', 'Target not found');
      return {
        type: target.type,
        // The catalog's DEFAULT release for the type. What this particular
        // target runs -- after a canary or a pin -- is `/targets/:id/adapter`.
        metadata: connectorLifecycleMetadata(target.type),
        matrix: target.type === 'entraId' ? ENTRA_CAPABILITY_MATRIX : null,
        capabilities: capabilitiesForTarget(target.type, target.config),
      };
    },
  );

  /**
   * Which adapter release this target runs, what that release is certified
   * for, which writes its configuration refuses, and any readiness warning
   * (deprecated, past deprecation, or uncertified).
   */
  app.get(
    '/targets/:id/adapter',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_READ) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      return targetAdapterReport(request.tenantId, id).catch(adapterProblem);
    },
  );

  /** Move the target between channels, or pin an exact certified release. */
  app.put(
    '/targets/:id/adapter',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_MANAGE) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const body = adapterSelectionRequest.parse(request.body);
      await setTargetAdapterSelection(request.tenantId, request.session.userId, id, body).catch(adapterProblem);
      return targetAdapterReport(request.tenantId, id);
    },
  );

  /**
   * Back to the last certified release, now. Only the selection changes:
   * configuration, profile, rules and accounts are untouched, and a run
   * previewed under the abandoned release refuses to apply.
   */
  app.post(
    '/targets/:id/adapter/rollback',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_MANAGE) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const { reason } = adapterReasonRequest.parse(request.body);
      await rollbackTargetAdapter(request.tenantId, request.session.userId, id, reason).catch(adapterProblem);
      return targetAdapterReport(request.tenantId, id);
    },
  );

  app.post(
    '/targets/:id/adapter/deprecation-override',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_MANAGE) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const body = deprecationOverrideRequest.parse(request.body);
      const now = new Date();
      if (body.expiresAt.getTime() - now.getTime() > MAX_DEPRECATION_OVERRIDE_MS) {
        throw new ProblemError(400, 'invalid-expiry', 'Override expiry is too far away', 'A deprecation override may last at most 30 days.');
      }
      await grantDeprecationOverride(request.tenantId, request.session.userId, id, body, { now }).catch(adapterProblem);
      return targetAdapterReport(request.tenantId, id);
    },
  );

  app.post(
    '/targets/:id/adapter/deprecation-override/clear',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_MANAGE) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const { reason } = adapterReasonRequest.parse(request.body);
      await clearDeprecationOverride(request.tenantId, request.session.userId, id, reason).catch(adapterProblem);
      return targetAdapterReport(request.tenantId, id);
    },
  );

  app.get(
    '/targets/:id/migrations/native-entra/preview',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_READ) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      try {
        return await previewDocumentEntraMigration(request.tenantId, id);
      } catch (cause) {
        if (cause instanceof TargetNotFoundError) {
          throw new ProblemError(404, 'not-found', 'Target not found');
        }
        if (cause instanceof TargetMigrationNotAvailableError) {
          throw new ProblemError(409, 'migration-not-available', 'Migration is not available', cause.message);
        }
        throw cause;
      }
    },
  );

  app.post(
    '/targets/:id/migrations/native-entra/apply',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_MANAGE) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const body = nativeEntraMigrationRequest.parse(request.body);
      try {
        return await applyDocumentEntraMigration(
          request.tenantId,
          request.session.userId,
          id,
          body.revision,
        );
      } catch (cause) {
        if (cause instanceof TargetNotFoundError) {
          throw new ProblemError(404, 'not-found', 'Target not found');
        }
        if (cause instanceof TargetMigrationNotAvailableError) {
          throw new ProblemError(409, 'migration-not-available', 'Migration is not available', cause.message);
        }
        if (cause instanceof TargetMigrationPreviewStaleError) {
          throw new ProblemError(409, 'preview-stale', 'Migration preview is stale', cause.message);
        }
        throw cause;
      }
    },
  );

  /**
   * A picker's search of the entitlement catalog.
   *
   * Live against Graph for an Entra target, because its catalog can be tens
   * of thousands of groups and the refresh is what populates the stored copy;
   * a stored search for every other type. The same shape either way, with
   * `manageable` from the connector or from the stored column.
   */
  app.get(
    '/targets/:id/entitlements/search',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_READ) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const { q, top } = entitlementSearchQuery.parse(request.query ?? {});
      const target = await request.db((tx) =>
        tx.targetSystem.findUnique({ where: { id }, select: { id: true, type: true } }),
      );
      if (!target) throw new ProblemError(404, 'not-found', 'Target not found');

      if (target.type === 'entraId') {
        const config = await request.db((tx) => targetWithCredential(tx, provider, id));
        if (!config) {
          throw new ProblemError(409, 'no-credential', 'This target has no saved credential');
        }
        // Outside `request.db`: a network call.
        const entitlements: DiscoveredEntitlement[] = await entraTargetConnector
          .searchEntitlements(config as never, { query: q, top })
          .catch((cause: unknown) => {
            throw new ProblemError(
              502,
              'target-unreachable',
              'The target could not be searched',
              cause instanceof Error ? cause.message : String(cause),
            );
          });
        return {
          source: 'live',
          entitlements: entitlements.map((e) => ({
            externalId: e.externalId,
            dn: e.dn,
            type: e.type,
            displayName: e.displayName,
            description: e.description ?? null,
            manageable: e.manageable ?? true,
            unmanageableReason: e.unmanageableReason ?? null,
            membershipKind: e.membershipKind ?? null,
          })),
        };
      }

      const rows = await request.db((tx) =>
        tx.entitlement.findMany({
          where: { targetSystemId: id, displayName: { contains: q, mode: 'insensitive' } },
          orderBy: { displayName: 'asc' },
          take: top,
        }),
      );
      return {
        source: 'catalog',
        entitlements: rows.map((row) => ({
          externalId: row.externalId,
          dn: row.dn ?? row.externalId,
          type: row.type,
          displayName: row.displayName,
          description: row.description,
          manageable: row.manageable,
          unmanageableReason: row.unmanageableReason,
          membershipKind: row.membershipKind,
        })),
      };
    },
  );

  app.delete(
    '/targets/:id',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_MANAGE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const { confirm } = confirmQuery.parse(request.query ?? {});
      let result;
      try {
        result = await deleteTarget(
          request.tenantId,
          request.session.userId,
          id,
          confirm === 'true',
          scheduler(),
        );
      } catch (cause) {
        if (cause instanceof TargetNotFoundError) {
          throw new ProblemError(404, 'not-found', 'Target not found');
        }
        throw cause;
      }
      if (!result.ok) {
        // 409 and the counts, as the source delete does: this is not a refusal
        // to act, it is the same act awaiting a decision, and the decision
        // needs the numbers behind it.
        throw new ProblemError(
          409,
          'target-not-empty',
          'This target still holds accounts',
          'deleting it removes Syntra record of every account it manages; the accounts themselves are never touched',
          { counts: result.counts },
        );
      }
      return reply.code(204).send();
    },
  );

  app.post(
    '/targets/test',
    {
      preHandler: requirePermission(PERMISSIONS.PROVISION_MANAGE),
      // A test opens an outbound connection to a host the caller names, with
      // a credential on it. Rate limited for the same reason the policy
      // simulator is.
      config: { rateLimit: { max: options.authRateLimitMax, timeWindow: '1 minute' } },
    },
    async (request) => {
      const body = testTargetRequestSchema.parse(request.body);
      // Deliberately outside `request.db`: `withTenant` is a transaction on a
      // five-second budget and this opens a socket to a third party.
      // `testTargetConfiguration` opens its own short transaction for the
      // vault read and closes it before the connection is made.
      const startedAt = Date.now();
      const result = await testTargetConfiguration(request.tenantId, provider, defined(body));
      // A form-only test has no stable system to attest. When the credential
      // is borrowed from a saved target, however, this is evidence for that
      // exact configuration and belongs in the durable readiness history.
      if (body.borrowFromTargetId) {
        await recordReadinessCheck(request.tenantId, {
          systemKind: 'target',
          systemId: body.borrowFromTargetId,
          configuration: body.config,
          capabilities: result.rights?.map((right) => `${right.right}:${right.status}`) ?? [],
          status: result.ok ? 'passed' : 'failed',
          latencyMs: Date.now() - startedAt,
          message: result.message,
          actorUserId: request.session.userId,
        });
      }
      return result;
    },
  );

  app.get(
    '/targets/:id/readiness',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_READ) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const target = await request.db((tx) => tx.targetSystem.findUnique({
        where: { id },
        select: {
          id: true, type: true, config: true, adapterChannel: true, adapterVersionPin: true,
          deprecationOverrideVersion: true, deprecationOverrideReason: true, deprecationOverrideExpiresAt: true,
        },
      }));
      if (!target) throw new ProblemError(404, 'not-found', 'Target not found');
      const readiness = await currentReadiness(request.tenantId, 'target', target.id, target.config);
      // A connection test proves the connection, not the adapter. A deprecated
      // or uncertified release is a readiness warning beside that evidence.
      let adapterWarnings: string[];
      try {
        adapterWarnings = adapterWriteContext(target).warnings;
      } catch (cause) {
        adapterWarnings = [cause instanceof Error ? cause.message : String(cause)];
      }
      return { ...readiness, adapterWarnings };
    },
  );

  app.get(
    '/targets/:id/health-series',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_READ) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const { days } = targetHealthQuery.parse(request.query ?? {});
      const result = await targetConnectorHealth(request.tenantId, id, { days });
      if (!result) throw new ProblemError(404, 'not-found', 'Target not found');
      return result;
    },
  );

  app.post(
    '/targets/:id/external-write-stop',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_MANAGE) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const body = writeStopRequest.parse(request.body);
      const now = new Date();
      if (body.expiresAt && body.expiresAt.getTime() > now.getTime() + 30 * 86_400_000) {
        throw new ProblemError(400, 'invalid-expiry', 'Pause expiry is too far away', 'Emergency stops may expire no more than 30 days from now.');
      }
      try {
        return await pauseTargetExternalWrites(request.tenantId, id, request.session.userId, body.reason, body.expiresAt, now);
      } catch (error) {
        if (error instanceof TargetWriteStopNotFoundError) throw new ProblemError(404, 'not-found', 'Target not found');
        if (error instanceof TargetWriteStopStateError) throw new ProblemError(409, 'write-stop-state', 'External-write stop state conflict', error.message);
        throw error;
      }
    },
  );

  app.post(
    '/targets/:id/external-write-resume',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_MANAGE) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const { reason } = writeResumeRequest.parse(request.body);
      try {
        return await resumeTargetExternalWrites(request.tenantId, id, request.session.userId, reason);
      } catch (error) {
        if (error instanceof TargetWriteStopNotFoundError) throw new ProblemError(404, 'not-found', 'Target not found');
        if (error instanceof TargetWriteStopSeparationError) throw new ProblemError(403, 'four-eyes-required', 'A second administrator must resume writes', error.message);
        if (error instanceof TargetWriteStopStateError) throw new ProblemError(409, 'write-stop-state', 'External-write stop state conflict', error.message);
        throw error;
      }
    },
  );

  /**
   * The tenant-wide emergency stop: no connector write for ANY target while it
   * is active. Same permission, same body, same bounds and the same four-eyes
   * resume as the per-target routes above, so neither scope is the easier one
   * to reach for or to lift. The GET is `PROVISION_READ` so everybody who can
   * see a run can see why it will not apply.
   */
  app.get(
    '/provision/external-write-stop',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_READ) },
    async (request) => tenantExternalWriteStop(request.tenantId),
  );

  app.post(
    '/provision/external-write-stop',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_MANAGE) },
    async (request) => {
      const body = writeStopRequest.parse(request.body);
      const now = new Date();
      if (body.expiresAt && body.expiresAt.getTime() > now.getTime() + 30 * 86_400_000) {
        throw new ProblemError(400, 'invalid-expiry', 'Pause expiry is too far away', 'Emergency stops may expire no more than 30 days from now.');
      }
      try {
        return await pauseTenantExternalWrites(request.tenantId, request.session.userId, body.reason, body.expiresAt, now);
      } catch (error) {
        if (error instanceof TenantWriteStopStateError) throw new ProblemError(409, 'write-stop-state', 'External-write stop state conflict', error.message);
        throw error;
      }
    },
  );

  app.post(
    '/provision/external-write-resume',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_MANAGE) },
    async (request) => {
      const { reason } = writeResumeRequest.parse(request.body);
      try {
        return await resumeTenantExternalWrites(request.tenantId, request.session.userId, reason);
      } catch (error) {
        if (error instanceof TenantWriteStopSeparationError) throw new ProblemError(403, 'four-eyes-required', 'A second administrator must resume writes', error.message);
        if (error instanceof TenantWriteStopStateError) throw new ProblemError(409, 'write-stop-state', 'External-write stop state conflict', error.message);
        throw error;
      }
    },
  );

  app.post(
    '/targets/:id/entitlements/refresh',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_MANAGE) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      // Named before the read, so a refresh against a target that is not there
      // is a 404 rather than a 500 out of "target configuration or credential
      // missing" — which is a real fault and must stay distinguishable from a
      // typo in a URL.
      const target = await request.db((tx) =>
        tx.targetSystem.findUnique({ where: { id }, select: { id: true, type: true } }),
      );
      if (!target) throw new ProblemError(404, 'not-found', 'Target not found');
      return refreshEntitlements(
        request.tenantId,
        provider,
        request.session.userId,
        id,
        targetConnectorFor(target.type),
      );
    },
  );

  app.get(
    '/targets/:id/entitlements',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_READ) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      return {
        entitlements: await request.db((tx) =>
          tx.entitlement.findMany({
            where: { targetSystemId: id },
            orderBy: { displayName: 'asc' },
          }),
        ),
      };
    },
  );
}
