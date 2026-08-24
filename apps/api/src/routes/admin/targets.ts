import type { FastifyInstance } from 'fastify';
import {
  createTargetRequestSchema,
  idParam,
  testTargetRequestSchema,
  updateTargetRequestSchema,
} from '@syntra/contracts';
import {
  PERMISSIONS,
  LadderConfigurationError,
  PairedDirectorySourceNotFoundError,
  TargetNotFoundError,
  createTarget,
  deleteTarget,
  localMasterKeyProvider,
  refreshEntitlements,
  testTargetConfiguration,
  updateTarget,
  type Scheduler,
} from '@syntra/core';
import { ProblemError } from '../../plugins/problem-json.js';
import { requireSession } from '../../plugins/require-session.js';
import { requirePermission } from '../../plugins/require-permission.js';

export interface TargetRouteOptions {
  masterKey: Buffer;
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

export async function registerAdminTargetRoutes(
  app: FastifyInstance,
  options: TargetRouteOptions,
): Promise<void> {
  app.addHook('preHandler', requireSession('admin'));
  const provider = localMasterKeyProvider(options.masterKey);
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
      const { thresholds, ladder, ...scalars } = updateTargetRequestSchema.parse(
        request.body,
      );
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
      return reply.code(204).send();
    },
  );

  app.delete(
    '/targets/:id',
    { preHandler: requirePermission(PERMISSIONS.PROVISION_MANAGE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const { confirm } = request.query as { confirm?: string };
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
      return testTargetConfiguration(request.tenantId, provider, defined(body));
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
        tx.targetSystem.findUnique({ where: { id }, select: { id: true } }),
      );
      if (!target) throw new ProblemError(404, 'not-found', 'Target not found');
      return refreshEntitlements(request.tenantId, provider, request.session.userId, id);
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
