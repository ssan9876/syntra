import type { FastifyInstance, FastifyRequest } from 'fastify';
import { bulkCertifyBody, decideItemBody, idParam, reviewListQuery } from '@syntra/contracts';
import {
  CampaignDecisionRefusedError,
  bulkCertify,
  openItem,
  recordCampaignDecision,
} from '@syntra/core';
import { ProblemError } from '../plugins/problem-json.js';
import { requireSession } from '../plugins/require-session.js';

/**
 * The reviewer surface is the PORTAL, and it needs no permission.
 *
 * Reviewing is something managers do twice a year from a link in an email.
 * Requiring an administrative session with step-up MFA for it would mean either
 * nobody reviews or everybody gets an administrative session, and the second is
 * worse — the same reason Automate's delegated administration is a portal
 * surface.
 *
 * Review authority comes from RESOLUTION, exactly as approval authority does in
 * Automate: every handler here reads `CampaignItemReviewer` rows naming the
 * caller's own person. There is deliberately no `govern.review` permission,
 * because a tenant-wide right to certify anything is not a thing anybody should
 * hold.
 */
export async function registerGovernPortalRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireSession('portal'));

  /** The person behind the signed-in account. A certification names a human. */
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
        'This account is not linked to a person record, and reviewing is done as a person because a certification names a human.',
      );
    }
    return user.personId;
  };

  app.get('/govern/reviews', async (request) => {
    const personId = await personFor(request);
    const query = reviewListQuery.parse(request.query ?? {});
    return request.db(async (tx) => ({
      items: await tx.campaignItem.findMany({
        where: {
          status: 'pending',
          // `unassignedAt: null` is the whole filter. A reviewer who was
          // reassigned keeps their row — the record of who it was with, on the
          // Tuesday it was sitting there — and must not keep the work.
          reviewers: { some: { personId, unassignedAt: null } },
          campaign: {
            status: { in: ['open', 'executing'] },
            ...(query.campaignId === undefined ? {} : { id: query.campaignId }),
          },
        },
        include: {
          campaign: {
            select: { id: true, name: true, dueAt: true, allowBulkCertify: true },
          },
        },
        orderBy: [{ resourceName: 'asc' }],
        take: query.limit,
      }),
    }));
  });

  app.get('/govern/reviews/:id', async (request) => {
    const personId = await personFor(request);
    const { id } = idParam.parse(request.params);
    const item = await request.db((tx) =>
      tx.campaignItem.findFirst({
        where: { id, reviewers: { some: { personId, unassignedAt: null } } },
        include: { campaign: true },
      }),
    );
    // 404, NOT 403. A 403 confirms the item exists, and the existence of a
    // holding is itself information about somebody's access.
    if (item === null) throw new ProblemError(404, 'not-found', 'Not found');

    // The server-side interval starts HERE, not from a client-reported dwell
    // time, which is worth nothing: the number this feeds is a quality signal
    // and a signal a client can set is a signal a client can flatter.
    await openItem(request.tenantId, personId, id);
    return item;
  });

  app.post('/govern/reviews/:id/decide', async (request) => {
    const personId = await personFor(request);
    const { id } = idParam.parse(request.params);
    const body = decideItemBody.parse(request.body);
    try {
      return await recordCampaignDecision(request.tenantId, {
        itemId: id,
        deciderPersonId: personId,
        deciderUserId: request.session.userId,
        decision: body.decision,
        comment: body.comment,
      });
    } catch (cause) {
      if (cause instanceof CampaignDecisionRefusedError) {
        // 409 carrying the CODE, so the screen can say which rule refused it
        // rather than "something went wrong". A mandatory comment on a
        // privileged holding is a decision this endpoint made, not a fault.
        throw new ProblemError(409, cause.code, 'This decision was refused', cause.message);
      }
      throw cause;
    }
  });

  app.post('/govern/reviews/bulk-certify', async (request) => {
    const personId = await personFor(request);
    const body = bulkCertifyBody.parse(request.body);
    try {
      return await bulkCertify(request.tenantId, {
        campaignId: body.campaignId,
        itemIds: body.itemIds,
        deciderPersonId: personId,
        deciderUserId: request.session.userId,
      });
    } catch (cause) {
      if (cause instanceof CampaignDecisionRefusedError) {
        throw new ProblemError(409, cause.code, 'This bulk certify was refused', cause.message);
      }
      throw cause;
    }
  });
}
