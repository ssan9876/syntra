import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { idParam } from '@syntra/contracts';
import {
  approvalDelegationBody,
  audiencePreviewBody,
  decideRequestBody,
  delegatedTaskRequest,
  productBody,
  resolutionPreviewBody,
  resourceDelegationBody,
  resourceOwnerBody,
  revokeGrantBody,
  settingsBody,
  sweepApplyBody,
  workflowBody,
} from '@syntra/contracts';
import {
  ACTIONS,
  DecisionRefusedError,
  DelegationRefusedError,
  FormMissingInputError,
  PERMISSIONS,
  ProductConfigurationError,
  UnknownActionError,
  createTask,
  deleteTask,
  recordEvent,
  listTasks,
  updateTask,
  WorkflowConfigurationError,
  applyExpirySweep,
  automateSettings,
  createApprovalDelegation,
  createProduct,
  endApprovalDelegation,
  listAllProducts,
  previewAudience,
  previewExpirySweep,
  previewWorkflowResolution,
  recordDecision,
  revokeGrant,
  updateAutomateSettings,
  updateProduct,
  upsertResourceDelegation,
  upsertResourceOwner,
  upsertWorkflow,
  type Scheduler,
  type RequestStatus,
} from '@syntra/core';
import { ProblemError } from '../../plugins/problem-json.js';
import { requireSession } from '../../plugins/require-session.js';
import { requirePermission } from '../../plugins/require-permission.js';

export interface AdminAutomateRouteOptions {
  publicUrl: string;
  /**
   * How an administrative decision, a revocation and a sweep apply reach the
   * scheduler. A function, not a `Scheduler`, because the scheduler starts
   * after the app is built — the same shape `registerAdminSourceRoutes` uses.
   * Spec section 5: an approval that produces target grants enqueues a run of
   * the affected target system.
   */
  scheduler?: () => Scheduler | null;
}

/**
 * Turns the domain's refusals into RFC 9457 problems.
 *
 * 422 rather than 400: the body was well-formed and the configuration was
 * refused on its merits. The `code` becomes the problem type so the console
 * can put the message against the field that caused it.
 */
function asProblem(cause: unknown): never {
  if (
    cause instanceof ProductConfigurationError ||
    cause instanceof WorkflowConfigurationError ||
    cause instanceof DelegationRefusedError
  ) {
    throw new ProblemError(422, cause.code, 'Cannot be saved', cause.message);
  }
  throw cause;
}

/**
 * The filters the request list takes. Parsed, not cast: `request.query` was
 * spread straight into a Prisma `where`, so `?status=a&status=b` arrived as an
 * array and a product id that was not a uuid reached the database, and both
 * answered 500 for a request that was simply wrong.
 *
 * The status list is checked against core's `RequestStatus` so a state added
 * there cannot be silently unfilterable here.
 */
const requestListQuery = z
  .object({
    status: z
      .enum([
        'pending_approval',
        'blocked_no_approver',
        'approved',
        'awaiting_fulfilment',
        'fulfilled',
        'partially_fulfilled',
        'fulfilment_failed',
        'rejected',
        'cancelled',
        'expired',
      ] as const satisfies readonly RequestStatus[])
      .optional(),
    productId: z.string().uuid().optional(),
  })
  .strict();

export async function registerAdminAutomateRoutes(
  app: FastifyInstance,
  options: AdminAutomateRouteOptions,
): Promise<void> {
  app.addHook('preHandler', requireSession('admin'));

  /** Resolved per request: the scheduler exists only after the app is built. */
  const scheduler = (): Scheduler | null => options.scheduler?.() ?? null;

  /**
   * The two refusals a task definition can produce, as messages the form can
   * put beside the control that caused them.
   *
   * Everything else goes up. A unique-name clash and a database failure are
   * not the same thing as a form that does not match its action, and
   * flattening them together is how a 500 comes to read like a validation
   * error.
   */
  const asTaskProblem = (cause: unknown): never => {
    if (cause instanceof UnknownActionError) {
      throw new ProblemError(400, 'unknown-action', 'No such action', cause.message);
    }
    if (cause instanceof FormMissingInputError) {
      throw new ProblemError(
        400,
        'form-missing-input',
        'The form does not ask for what the action needs',
        cause.message,
      );
    }
    throw cause;
  };

  /**
   * The action library: what a delegated task may be made to do.
   *
   * A constant in code, served rather than restated in the console, so the
   * list the form offers and the list the service accepts cannot drift. There
   * is no entry that takes a command — see `ACTIONS` for why this is a list
   * rather than a script host.
   */
  app.get(
    '/automate/tasks/actions',
    { preHandler: requirePermission(PERMISSIONS.AUTOMATE_READ) },
    async () => ({
      actions: Object.values(ACTIONS).map((action) => ({
        key: action.key,
        label: action.label,
        description: action.description,
        inputs: action.inputs,
      })),
    }),
  );

  app.get(
    '/automate/tasks',
    { preHandler: requirePermission(PERMISSIONS.AUTOMATE_READ) },
    async (request) => ({ tasks: await request.db((tx) => listTasks(tx)) }),
  );

  /**
   * Defining a delegated task is granting authority, so it needs
   * `AUTOMATE_MANAGE` — the permission that already covers creating products
   * and workflows.
   *
   * Worth saying out loud: whoever holds this can build a task that a
   * helpdesk user runs against accounts the helpdesk user could not otherwise
   * touch. What bounds it is that the task can only do what the library does,
   * and that no run may reach an account more privileged than its runner.
   */
  app.post(
    '/automate/tasks',
    { preHandler: requirePermission(PERMISSIONS.AUTOMATE_MANAGE) },
    async (request, reply) => {
      const body = delegatedTaskRequest.parse(request.body);
      const created = await request
        .db((tx) => createTask(tx, body as never))
        .catch(asTaskProblem);

      await request.db((tx) =>
        recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'automate.task_created',
          targetType: 'DelegatedTask',
          targetId: created.id,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { name: created.name, actionKey: created.actionKey },
        }),
      );
      return reply.status(201).send(created);
    },
  );

  app.put(
    '/automate/tasks/:id',
    { preHandler: requirePermission(PERMISSIONS.AUTOMATE_MANAGE) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const body = delegatedTaskRequest.parse(request.body);
      const saved = await request
        .db((tx) => updateTask(tx, id, body as never))
        .catch(asTaskProblem);

      await request.db((tx) =>
        recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'automate.task_updated',
          targetType: 'DelegatedTask',
          targetId: id,
          outcome: 'success',
          sourceIp: request.ip,
          payload: { name: saved.name, actionKey: saved.actionKey, enabled: saved.enabled },
        }),
      );
      return saved;
    },
  );

  app.delete(
    '/automate/tasks/:id',
    { preHandler: requirePermission(PERMISSIONS.AUTOMATE_MANAGE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      await request.db((tx) => deleteTask(tx, id));
      await request.db((tx) =>
        recordEvent(tx, {
          actorUserId: request.session.userId,
          action: 'automate.task_deleted',
          targetType: 'DelegatedTask',
          targetId: id,
          outcome: 'success',
          sourceIp: request.ip,
          payload: {},
        }),
      );
      return reply.status(204).send();
    },
  );

  /**
   * What this task has done. The evidence that makes delegating safe to agree
   * to — including the refusals, which are the interesting ones.
   */
  app.get(
    '/automate/tasks/:id/runs',
    { preHandler: requirePermission(PERMISSIONS.AUTOMATE_READ) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const runs = await request.db((tx) =>
        tx.delegatedTaskRun.findMany({
          where: { taskId: id },
          orderBy: { createdAt: 'desc' },
          take: 100,
        }),
      );
      return { runs };
    },
  );

  app.get(
    '/automate/products',
    { preHandler: requirePermission(PERMISSIONS.AUTOMATE_READ) },
    async (request) => ({ products: await request.db((tx) => listAllProducts(tx)) }),
  );

  /**
   * One product, with its grants.
   *
   * The editor could not load what it edited: the page fetched the LIST and
   * never read it, every field started empty, and `PUT` requires the whole
   * object -- so renaming a product replaced its description, category,
   * grants, form schema and duration mode with the editor's defaults. A
   * catalog entry could be destroyed by fixing a typo in it.
   */
  app.get(
    '/automate/products/:id',
    { preHandler: requirePermission(PERMISSIONS.AUTOMATE_READ) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const product = await request.db((tx) =>
        tx.product.findUnique({ where: { id }, include: { grants: true } }),
      );
      if (product === null) throw new ProblemError(404, 'not-found', 'Not found');
      return product;
    },
  );

  app.post(
    '/automate/products/audience-preview',
    { preHandler: requirePermission(PERMISSIONS.AUTOMATE_READ) },
    async (request) => {
      const body = audiencePreviewBody.parse(request.body);
      return previewAudience(
        request.tenantId,
        body.audienceCondition as never,
        body.limit,
      );
    },
  );

  app.post(
    '/automate/products',
    { preHandler: requirePermission(PERMISSIONS.AUTOMATE_MANAGE) },
    async (request, reply) => {
      const body = productBody.parse(request.body);
      try {
        const created = await createProduct(request.tenantId, request.session.userId, {
          ...body,
          audienceCondition: body.audienceCondition as never,
          formSchema: body.formSchema as never,
          grants: body.grants,
        });
        return reply.status(201).send(created);
      } catch (cause) {
        asProblem(cause);
      }
    },
  );

  app.put(
    '/automate/products/:id',
    { preHandler: requirePermission(PERMISSIONS.AUTOMATE_MANAGE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = productBody.parse(request.body);
      try {
        await updateProduct(request.tenantId, request.session.userId, id, {
          ...body,
          audienceCondition: body.audienceCondition as never,
          formSchema: body.formSchema as never,
          grants: body.grants,
        });
      } catch (cause) {
        asProblem(cause);
      }
      return reply.status(204).send();
    },
  );

  /**
   * Every approval workflow, with its stages and how many products use it.
   *
   * There was no list route of any kind, so `Product.workflowId` -- which is
   * REQUIRED and a uuid -- could not be discovered from the console at all:
   * the product editor asked an administrator to type an id the product gave
   * them no way to learn, and the workflow screen asked for the same id before
   * it would preview anything.
   *
   * `productCount` because a workflow bound to eleven products is not one
   * somebody should edit without knowing that, and `ApprovalWorkflow.products`
   * is a relation this can count without a second query.
   */
  app.get(
    '/automate/workflows',
    { preHandler: requirePermission(PERMISSIONS.AUTOMATE_READ) },
    async (request) => {
      const rows = await request.db((tx) =>
        tx.approvalWorkflow.findMany({
          orderBy: { name: 'asc' },
          include: {
            stages: { orderBy: { sequence: 'asc' } },
            products: { select: { id: true } },
          },
        }),
      );
      return {
        workflows: rows.map(({ products, ...workflow }) => ({
          ...workflow,
          productCount: products.length,
        })),
      };
    },
  );

  app.post(
    '/automate/workflows',
    { preHandler: requirePermission(PERMISSIONS.AUTOMATE_MANAGE) },
    async (request, reply) => {
      const body = workflowBody.parse(request.body);
      try {
        const created = await upsertWorkflow(
          request.tenantId,
          request.session.userId,
          null,
          body,
        );
        return reply.status(201).send(created);
      } catch (cause) {
        asProblem(cause);
      }
    },
  );

  app.put(
    '/automate/workflows/:id',
    { preHandler: requirePermission(PERMISSIONS.AUTOMATE_MANAGE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = workflowBody.parse(request.body);
      try {
        await upsertWorkflow(request.tenantId, request.session.userId, id, body);
      } catch (cause) {
        asProblem(cause);
      }
      return reply.status(204).send();
    },
  );

  app.post(
    '/automate/workflows/resolution-preview',
    { preHandler: requirePermission(PERMISSIONS.AUTOMATE_READ) },
    async (request) => {
      const body = resolutionPreviewBody.parse(request.body);
      const stages = await previewWorkflowResolution(
        request.tenantId,
        body.workflowId,
        body.subjectPersonId,
        body.productId,
      );
      return { stages };
    },
  );

  app.get(
    '/automate/requests',
    { preHandler: requirePermission(PERMISSIONS.AUTOMATE_READ) },
    async (request) => {
      const { status, productId } = requestListQuery.parse(request.query ?? {});
      const requests = await request.db((tx) =>
        tx.accessRequest.findMany({
          where: {
            ...(status === undefined ? {} : { status }),
            ...(productId === undefined ? {} : { productId }),
          },
          include: { product: { select: { name: true } }, items: true },
          // Leading with the ones that are stuck.
          orderBy: [{ status: 'asc' }, { submittedAt: 'asc' }],
          take: 200,
        }),
      );
      return { requests };
    },
  );

  app.get(
    '/automate/requests/:id',
    { preHandler: requirePermission(PERMISSIONS.AUTOMATE_READ) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const found = await request.db((tx) =>
        tx.accessRequest.findUnique({
          where: { id },
          include: {
            product: true,
            items: true,
            steps: {
              include: { approvers: true, decisions: true },
              orderBy: { sequence: 'asc' },
            },
          },
        }),
      );
      if (found === null) throw new ProblemError(404, 'not-found', 'Not found');
      const notifications = await request.db((tx) =>
        tx.notificationOutbox.findMany({ where: { requestId: id } }),
      );
      return { ...found, notifications };
    },
  );

  app.post(
    '/automate/requests/:id/decide',
    { preHandler: requirePermission(PERMISSIONS.AUTOMATE_MANAGE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      // PARSED, not cast, and that distinction was an authorization bug rather
      // than a tidiness one. `recordDecision` branches on `=== 'reject'`, so a
      // capitalised "Reject" took the approval path: it skipped the
      // comment-required guard on the schema, fulfilled the grants, and put
      // the literal string where a decision belongs -- in the decision row and
      // the audit payload, where it reads as a rejection to anybody looking
      // later. A missing field reached Prisma as `undefined` and became a 500.
      //
      // `decideRequestBody` existed and was exported and had no importer.
      const body = decideRequestBody.parse(request.body);
      const person = await request.db((tx) =>
        tx.user.findUnique({
          where: { id: request.session.userId },
          select: { personId: true },
        }),
      );
      if (person?.personId == null) {
        throw new ProblemError(
          403,
          'no-person',
          'Forbidden',
          'Deciding a request requires an account linked to a person.',
        );
      }
      try {
        // Subject to the invariant like every other decision. An administrator
        // is not exempt from it; they are exempt from being on the step.
        const result = await recordDecision(
          request.tenantId,
          {
            requestId: id,
            deciderPersonId: person.personId,
            deciderUserId: request.session.userId,
            decision: body.decision,
            // The schema defaults both. `shortenedToDays` was hard-coded to
            // null here while the contract has always carried it, so an
            // approver shortening a grant was silently granting the full term.
            comment: body.comment,
            shortenedToDays: body.shortenedToDays,
            sourceIp: request.ip,
          },
          { asAdministrator: true, scheduler: scheduler(), publicUrl: options.publicUrl },
        );
        return reply.status(200).send(result);
      } catch (cause) {
        if (cause instanceof DecisionRefusedError) {
          const status = cause.code === 'self-approval' ? 403 : 409;
          throw new ProblemError(status, cause.code, 'Cannot be decided', cause.message);
        }
        throw cause;
      }
    },
  );

  app.get(
    '/automate/sweeps',
    { preHandler: requirePermission(PERMISSIONS.AUTOMATE_READ) },
    async (request) => ({
      sweeps: await request.db((tx) =>
        tx.expirySweep.findMany({ orderBy: { startedAt: 'desc' }, take: 50 }),
      ),
    }),
  );

  app.get(
    '/automate/sweeps/:id',
    { preHandler: requirePermission(PERMISSIONS.AUTOMATE_READ) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const sweep = await request.db((tx) =>
        tx.expirySweep.findUnique({
          where: { id },
          include: { actions: true, exceptions: true },
        }),
      );
      if (sweep === null) throw new ProblemError(404, 'not-found', 'Not found');
      return sweep;
    },
  );

  app.post(
    '/automate/sweeps',
    { preHandler: requirePermission(PERMISSIONS.AUTOMATE_MANAGE) },
    async (request, reply) =>
      reply
        .status(201)
        .send(await previewExpirySweep(request.tenantId, { publicUrl: options.publicUrl })),
  );

  app.post(
    '/automate/sweeps/:id/apply',
    { preHandler: requirePermission(PERMISSIONS.AUTOMATE_MANAGE) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const body = sweepApplyBody.parse(request.body ?? {});
      return applyExpirySweep(request.tenantId, id, {
        confirm: body.confirm,
        confirmedByUserId: request.session.userId,
        ...(body.only === undefined ? {} : { only: body.only }),
        scheduler: scheduler(),
        publicUrl: options.publicUrl,
      });
    },
  );

  app.get(
    '/automate/settings',
    { preHandler: requirePermission(PERMISSIONS.AUTOMATE_READ) },
    async (request) => request.db((tx) => automateSettings(tx)),
  );

  app.put(
    '/automate/settings',
    { preHandler: requirePermission(PERMISSIONS.AUTOMATE_MANAGE) },
    async (request, reply) => {
      const body = settingsBody.parse(request.body);
      await updateAutomateSettings(request.tenantId, request.session.userId, body);
      return reply.status(204).send();
    },
  );

  app.put(
    '/automate/resource-owners',
    { preHandler: requirePermission(PERMISSIONS.AUTOMATE_MANAGE) },
    async (request, reply) => {
      const body = resourceOwnerBody.parse(request.body);
      await upsertResourceOwner(request.tenantId, request.session.userId, body);
      return reply.status(204).send();
    },
  );

  app.post(
    '/automate/resource-delegations',
    { preHandler: requirePermission(PERMISSIONS.AUTOMATE_MANAGE) },
    async (request, reply) => {
      const body = resourceDelegationBody.parse(request.body);
      try {
        const created = await upsertResourceDelegation(
          request.tenantId,
          request.session.userId,
          { ...body, audienceCondition: body.audienceCondition as never },
        );
        return reply.status(201).send(created);
      } catch (cause) {
        asProblem(cause);
      }
    },
  );

  app.post(
    '/automate/approval-delegations',
    { preHandler: requirePermission(PERMISSIONS.AUTOMATE_MANAGE) },
    async (request, reply) => {
      const body = approvalDelegationBody.parse(request.body);
      try {
        const created = await createApprovalDelegation(
          request.tenantId,
          request.session.userId,
          body,
          { publicUrl: options.publicUrl },
        );
        return reply.status(201).send(created);
      } catch (cause) {
        asProblem(cause);
      }
    },
  );

  app.delete(
    '/automate/approval-delegations/:id',
    { preHandler: requirePermission(PERMISSIONS.AUTOMATE_MANAGE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      await endApprovalDelegation(request.tenantId, request.session.userId, id, {
        publicUrl: options.publicUrl,
      });
      return reply.status(204).send();
    },
  );

  app.post(
    '/automate/grants/:id/revoke',
    { preHandler: requirePermission(PERMISSIONS.AUTOMATE_MANAGE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = revokeGrantBody.parse(request.body ?? {});
      await revokeGrant(
        request.tenantId,
        request.session.userId,
        id,
        body.reason,
        { scheduler: scheduler(), publicUrl: options.publicUrl },
      );
      return reply.status(204).send();
    },
  );
}
