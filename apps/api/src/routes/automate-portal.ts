import type { FastifyInstance, FastifyRequest } from 'fastify';
import { idParam } from '@syntra/contracts';
import {
  approvalDelegationBody,
  catalogSearchQuery,
  decideRequestBody,
  delegatedGrantBody,
  resourceParam,
  submitRequestBody,
} from '@syntra/contracts';
import {
  DecisionRefusedError,
  DelegationRefusedError,
  PERMISSIONS,
  cancelRequest,
  createApprovalDelegation,
  delegatedGrant,
  delegatedRevoke,
  endApprovalDelegation,
  findVisibleProduct,
  handBackGrant,
  hasPermission,
  recordDecision,
  resourcesManagedBy,
  searchVisibleProducts,
  submitRequest,
  visibleProducts,
  type Scheduler,
} from '@syntra/core';
import { ProblemError } from '../plugins/problem-json.js';
import { requireSession } from '../plugins/require-session.js';

export interface AutomatePortalRouteOptions {
  publicUrl: string;
  /**
   * How a decision or a hand-back reaches the job scheduler.
   *
   * A function, not a `Scheduler`, because the scheduler is started after the
   * app is built — the same shape `registerAdminSourceRoutes` already uses,
   * and `buildApp` already carries it on its own options.
   *
   * Spec section 5's latency mitigation is that "an approval that produces
   * target grants **enqueues a run of the affected target system**". Passing
   * `scheduler: null` on the only path a real user takes turns that off: the
   * request waits for the tick job's reflection pass to notice
   * `actionId === null` and re-enqueue, up to five minutes later. Defensible
   * as a fallback; not defensible as the primary path.
   */
  scheduler?: () => Scheduler | null;
}

export async function registerAutomatePortalRoutes(
  app: FastifyInstance,
  options: AutomatePortalRouteOptions,
): Promise<void> {
  /** Resolved per request: the scheduler exists only after the app is built. */
  const scheduler = (): Scheduler | null => options.scheduler?.() ?? null;

  // A portal session is enough for everything here. Delegated administration
  // is a PORTAL surface by design: no /api/admin, no administrative scope, no
  // step-up MFA. That is the entire point of the feature.
  app.addHook('preHandler', requireSession('portal'));

  /** The person behind the signed-in account, which every route below needs. */
  const personFor = async (request: FastifyRequest): Promise<string> => {
    const user = await request.db((tx) =>
      tx.user.findUnique({
        where: { id: request.session.userId },
        select: { personId: true },
      }),
    );
    if (user?.personId == null) {
      throw new ProblemError(
        403,
        'no-person',
        'Not available to you',
        'This account is not linked to a person record, so it cannot ask for anything or hold anything.',
      );
    }
    return user.personId;
  };

  /**
   * Whose catalog this is.
   *
   * The catalog shown to a submitter acting for somebody else is the
   * SUBJECT's, not the submitter's. Anybody but the subject's own manager
   * needs `automate.request_on_behalf`.
   */
  const subjectFor = async (
    request: FastifyRequest,
    requested: string | undefined,
  ): Promise<string> => {
    const self = await personFor(request);
    if (requested === undefined || requested === self) return self;

    const allowed = await request.db(async (tx) => {
      const contracts = await tx.contract.findMany({
        where: { personId: requested },
        select: { managerPersonId: true },
      });
      if (contracts.some((c) => c.managerPersonId === self)) return true;
      return hasPermission(tx, request.session.userId, PERMISSIONS.AUTOMATE_REQUEST_ON_BEHALF);
    });
    if (!allowed) {
      throw new ProblemError(
        403,
        'forbidden',
        'Forbidden',
        'You can ask for things for yourself and for the people who report to you.',
      );
    }
    return requested;
  };

  app.get('/automate/catalog', async (request) => {
    const query = request.query as { subjectPersonId?: string; category?: string };
    const subjectPersonId = await subjectFor(request, query.subjectPersonId);
    const products = await request.db((tx) => visibleProducts(tx, subjectPersonId));
    const filtered =
      query.category === undefined
        ? products
        : products.filter((p) => p.category === query.category);
    // Whether the product's workflow has any stages at all. Task 17's
    // CatalogPage renders `needsApproval` and nothing produced it: the
    // catalog is supposed to say "granted immediately" BEFORE somebody asks,
    // which is what spec section 8 requires of a zero-stage workflow.
    const stageCounts = await request.db((tx) =>
      tx.approvalStage.groupBy({ by: ['workflowId'], _count: { _all: true } }),
    );
    const hasStages = new Set(stageCounts.map((c) => c.workflowId));
    return {
      products: filtered.map((p) => ({
        id: p.id,
        name: p.name,
        slug: p.slug,
        description: p.description,
        category: p.category,
        iconUrl: p.iconUrl,
        kind: p.kind,
        durationMode: p.durationMode,
        maxDurationDays: p.maxDurationDays,
        needsApproval: hasStages.has(p.workflowId),
      })),
    };
  });

  // Static path, registered before the parametric one. find-my-way prefers a
  // static segment regardless of order, but the reading order should not
  // depend on knowing that.
  app.get('/automate/catalog/search', async (request) => {
    const query = request.query as { subjectPersonId?: string; q?: string };
    const { q } = catalogSearchQuery.parse(request.query);
    const subjectPersonId = await subjectFor(request, query.subjectPersonId);
    const products = await request.db((tx) => searchVisibleProducts(tx, subjectPersonId, q));
    return { products: products.map((p) => ({ id: p.id, name: p.name, slug: p.slug })) };
  });

  app.get('/automate/catalog/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    const subjectPersonId = await subjectFor(
      request,
      (request.query as { subjectPersonId?: string }).subjectPersonId,
    );
    const product = await request.db((tx) => findVisibleProduct(tx, subjectPersonId, id));
    // 404, never 403. A 403 confirms the thing exists, and the existence of a
    // product name is itself information about the organization.
    if (product === null) throw new ProblemError(404, 'not-found', 'Not found');
    return product;
  });

  app.get('/automate/catalog/:id/form', async (request) => {
    const { id } = idParam.parse(request.params);
    const subjectPersonId = await subjectFor(
      request,
      (request.query as { subjectPersonId?: string }).subjectPersonId,
    );
    const product = await request.db((tx) => findVisibleProduct(tx, subjectPersonId, id));
    if (product === null) throw new ProblemError(404, 'not-found', 'Not found');
    const grants = await request.db((tx) =>
      tx.productGrant.findMany({ where: { productId: id } }),
    );
    return {
      name: product.name,
      requestInstructions: product.requestInstructions,
      formSchema: product.formSchema,
      durationMode: product.durationMode,
      defaultDurationDays: product.defaultDurationDays,
      maxDurationDays: product.maxDurationDays,
      resources: grants.map((g) => ({
        id: g.id,
        resourceType: g.resourceType,
        resourceId: g.resourceId,
        optional: g.optional,
      })),
    };
  });

  app.post('/automate/requests', async (request, reply) => {
    const body = submitRequestBody.parse(request.body);
    const subjectPersonId = await subjectFor(request, body.subjectPersonId);
    const outcome = await submitRequest(
      request.tenantId,
      {
        productId: body.productId,
        subjectPersonId,
        requestedByUserId: request.session.userId,
        justification: body.justification,
        formValues: body.formValues,
        requestedDurationDays: body.requestedDurationDays,
        replacesGrantId: body.replacesGrantId,
      },
      { scheduler: scheduler(), publicUrl: options.publicUrl },
    );
    if (!outcome.ok) {
      // 422, not 400: the request was well-formed and was refused on its
      // merits, and the reason is the thing the requester needs.
      throw new ProblemError(422, outcome.reason, 'Cannot be requested', outcome.message);
    }
    return reply.status(201).send(outcome);
  });

  app.get('/automate/requests', async (request) => {
    const personId = await personFor(request);
    const requests = await request.db((tx) =>
      tx.accessRequest.findMany({
        where: {
          OR: [{ subjectPersonId: personId }, { requestedByPersonId: personId }],
        },
        include: { product: { select: { name: true } }, items: true },
        orderBy: { submittedAt: 'desc' },
      }),
    );
    return { requests };
  });

  app.get('/automate/requests/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    const personId = await personFor(request);
    const found = await request.db((tx) =>
      tx.accessRequest.findFirst({
        where: {
          id,
          OR: [{ subjectPersonId: personId }, { requestedByPersonId: personId }],
        },
        include: {
          product: { select: { name: true } },
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
      tx.notificationOutbox.findMany({
        where: { requestId: id },
        select: { template: true, to: true, sentAt: true, attempts: true, lastError: true },
        orderBy: { createdAt: 'asc' },
      }),
    );
    // The timeline is assembled from the same rows the audit log records, so
    // what the requester reads and what an auditor reads cannot disagree.
    return { ...found, notifications };
  });

  app.post('/automate/requests/:id/cancel', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    try {
      await cancelRequest(request.tenantId, id, request.session.userId, {
        publicUrl: options.publicUrl,
      });
    } catch (cause) {
      if (cause instanceof DecisionRefusedError) {
        throw new ProblemError(409, cause.code, 'Cannot be withdrawn', cause.message);
      }
      throw cause;
    }
    return reply.status(204).send();
  });

  app.get('/automate/approvals', async (request) => {
    const personId = await personFor(request);
    const steps = await request.db((tx) =>
      tx.approvalStep.findMany({
        where: { status: 'open', approvers: { some: { personId } } },
        include: {
          request: { include: { product: { select: { name: true } }, items: true } },
        },
        orderBy: { openedAt: 'asc' },
      }),
    );
    // An approver sees the product name and description for requests routed to
    // them whether or not their own audience admits the product: being routed
    // the decision IS the authorisation. It is not a general catalog read.
    return { approvals: steps };
  });

  app.post('/automate/approvals/:id/decide', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = decideRequestBody.parse(request.body);
    const personId = await personFor(request);
    try {
      const result = await recordDecision(
        request.tenantId,
        {
          requestId: id,
          deciderPersonId: personId,
          deciderUserId: request.session.userId,
          decision: body.decision,
          comment: body.comment,
          shortenedToDays: body.shortenedToDays,
          sourceIp: request.ip,
        },
        { scheduler: scheduler(), publicUrl: options.publicUrl },
      );
      return reply.status(200).send(result);
    } catch (cause) {
      if (cause instanceof DecisionRefusedError) {
        // 403 for the invariant, 409 for everything else: one is "you may
        // not", the other is "not now".
        const status = cause.code === 'self-approval' || cause.code === 'not-an-approver' ? 403 : 409;
        throw new ProblemError(status, cause.code, 'Cannot be decided', cause.message);
      }
      throw cause;
    }
  });

  app.get('/automate/grants', async (request) => {
    const personId = await personFor(request);
    const grants = await request.db((tx) =>
      tx.accessGrant.findMany({
        where: { subjectPersonId: personId },
        orderBy: { createdAt: 'desc' },
      }),
    );
    return { grants };
  });

  app.post('/automate/grants/:id/hand-back', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const personId = await personFor(request);
    const grant = await request.db((tx) =>
      tx.accessGrant.findFirst({ where: { id, subjectPersonId: personId } }),
    );
    if (grant === null) throw new ProblemError(404, 'not-found', 'Not found');
    await handBackGrant(request.tenantId, request.session.userId, id, {
      scheduler: scheduler(),
      publicUrl: options.publicUrl,
    });
    return reply.status(204).send();
  });

  app.get('/automate/managed-resources', async (request) => {
    const personId = await personFor(request);
    const managed = await request.db((tx) => resourcesManagedBy(tx, personId, new Date()));
    return { resources: managed };
  });

  app.get('/automate/managed-resources/:type/:id/members', async (request) => {
    const { type, id } = resourceParam.parse(request.params);
    const personId = await personFor(request);
    const managed = await request.db((tx) => resourcesManagedBy(tx, personId, new Date()));
    const delegation = managed.find((m) => m.resourceType === type && m.resourceId === id);
    if (delegation === undefined || !delegation.capabilities.includes('view_members')) {
      throw new ProblemError(404, 'not-found', 'Not found');
    }
    const grants = await request.db((tx) =>
      tx.accessGrant.findMany({
        where: {
          resourceType: type,
          resourceId: id,
          status: { in: ['scheduled', 'pending', 'active'] },
        },
      }),
    );
    return { members: grants, capabilities: delegation.capabilities };
  });

  app.post('/automate/managed-resources/:type/:id/grant', async (request, reply) => {
    const { type, id } = resourceParam.parse(request.params);
    const body = delegatedGrantBody.parse(request.body);
    const personId = await personFor(request);
    try {
      const result = await delegatedGrant(
        request.tenantId,
        {
          actingPersonId: personId,
          actingUserId: request.session.userId,
          resourceType: type,
          resourceId: id,
          subjectPersonIds: body.subjectPersonIds,
          justification: body.justification,
          durationDays: body.durationDays,
        },
        { scheduler: scheduler(), publicUrl: options.publicUrl },
      );
      return reply.status(201).send(result);
    } catch (cause) {
      if (cause instanceof DelegationRefusedError) {
        const status = cause.code === 'not-permitted' ? 404 : 422;
        throw new ProblemError(status, cause.code, 'Cannot be granted', cause.message);
      }
      throw cause;
    }
  });

  app.post('/automate/managed-resources/:type/:id/revoke', async (request, reply) => {
    const { type, id } = resourceParam.parse(request.params);
    const body = delegatedGrantBody.parse(request.body);
    const personId = await personFor(request);
    try {
      const result = await delegatedRevoke(
        request.tenantId,
        {
          actingPersonId: personId,
          actingUserId: request.session.userId,
          resourceType: type,
          resourceId: id,
          subjectPersonIds: body.subjectPersonIds,
        },
        { scheduler: scheduler(), publicUrl: options.publicUrl },
      );
      return reply.status(200).send(result);
    } catch (cause) {
      if (cause instanceof DelegationRefusedError) {
        const status = cause.code === 'not-permitted' ? 404 : 422;
        throw new ProblemError(status, cause.code, 'Cannot be removed', cause.message);
      }
      throw cause;
    }
  });

  app.get('/automate/delegations', async (request) => {
    const personId = await personFor(request);
    const delegations = await request.db((tx) =>
      tx.approvalDelegation.findMany({
        where: {
          revokedAt: null,
          OR: [{ delegatorPersonId: personId }, { delegatePersonId: personId }],
        },
        orderBy: { startsAt: 'desc' },
      }),
    );
    return { delegations };
  });

  /**
   * Record an absence.
   *
   * Spec section 17 lists "My delegations — record an absence, see
   * delegations made to me" as an END-USER surface. With only the GET, a
   * manager going on leave has to ask an administrator, which is the opposite
   * of what the feature is for.
   *
   * `delegatorPersonId` is FORCED to the signed-in person and never read from
   * the body: this is a portal session with no administrative scope, and a
   * body-supplied delegator would let anybody route somebody else's approvals
   * to a person of their choosing. `createApprovalDelegation` enforces the
   * same rule again in the service (spec section 8), so neither layer is the
   * only one.
   */
  app.post('/automate/delegations', async (request, reply) => {
    const personId = await personFor(request);
    const body = approvalDelegationBody.parse(request.body);
    try {
      const created = await createApprovalDelegation(
        request.tenantId,
        request.session.userId,
        {
          delegatorPersonId: personId,
          delegatePersonId: body.delegatePersonId,
          category: body.category,
          startsAt: body.startsAt,
          endsAt: body.endsAt,
        },
        { publicUrl: options.publicUrl },
      );
      reply.code(201);
      return created;
    } catch (cause) {
      if (cause instanceof DelegationRefusedError) {
        throw new ProblemError(422, cause.code, 'Cannot be recorded', cause.message);
      }
      throw cause;
    }
  });

  app.post('/automate/delegations/:id/end', async (request) => {
    const { id } = idParam.parse(request.params);
    const personId = await personFor(request);
    const delegation = await request.db((tx) =>
      tx.approvalDelegation.findUnique({ where: { id } }),
    );
    // 404, not 403: a delegation that is not yours is not yours to know about.
    if (delegation === null || delegation.delegatorPersonId !== personId) {
      throw new ProblemError(404, 'not-found', 'Not found', 'No such delegation.');
    }
    await endApprovalDelegation(request.tenantId, request.session.userId, id, {
      publicUrl: options.publicUrl,
    });
    return { ended: true };
  });
}
