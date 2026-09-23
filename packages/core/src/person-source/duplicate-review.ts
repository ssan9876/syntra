import { withTenant } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';

export type DuplicateResolution = 'keep_separate' | 'link_existing' | 'skip_source_record';

export class DuplicateReviewNotFoundError extends Error {
  constructor(readonly reviewId: string) {
    super(`no open duplicate review ${reviewId}`);
    this.name = 'DuplicateReviewNotFoundError';
  }
}

export class PersonSourceLinkNotFoundError extends Error {
  constructor(readonly linkId: string) {
    super(`no such person source link ${linkId}`);
    this.name = 'PersonSourceLinkNotFoundError';
  }
}

export function listPersonSourceLinks(tenantId: string, personId?: string) {
  return withTenant(tenantId, (tx) => tx.personSourceLink.findMany({
    where: personId === undefined ? {} : { personId },
    include: { source: { select: { id: true, name: true } }, person: { select: { id: true, givenName: true, familyName: true } } },
    orderBy: { linkedAt: 'desc' },
    take: 500,
  }));
}

export function unlinkPersonSourceIdentity(tenantId: string, linkId: string, actorUserId: string, reason: string) {
  return withTenant(tenantId, async (tx) => {
    const link = await tx.personSourceLink.findUnique({ where: { id: linkId } });
    if (!link) throw new PersonSourceLinkNotFoundError(linkId);
    await tx.personSourceLink.delete({ where: { id: linkId } });
    await recordEvent(tx, {
      actorUserId,
      action: 'person_source.link.remove',
      targetType: 'Person',
      targetId: link.personId,
      outcome: 'success',
      sourceIp: null,
      payload: { linkId, sourceId: link.sourceId, externalId: link.externalId, reason },
    });
    return { personId: link.personId, sourceId: link.sourceId, externalId: link.externalId };
  });
}

export function listDuplicateReviews(tenantId: string, status: 'open' | 'resolved' = 'open') {
  return withTenant(tenantId, async (tx) => {
    const reviews = await tx.personDuplicateReview.findMany({
    where: { status },
    include: {
      candidatePerson: { select: { id: true, givenName: true, familyName: true, businessEmail: true, externalId: true, sourceId: true } },
      change: { select: { id: true, externalId: true, after: true, status: true } },
      run: { select: { id: true, sourceId: true, startedAt: true } },
    },
    orderBy: { createdAt: 'asc' },
    take: 200,
    });
    const runIds = [...new Set(reviews.map((review) => review.runId))];
    const changes = runIds.length === 0 ? [] : await tx.personImportChange.findMany({
      where: { runId: { in: runIds } },
      select: { id: true, runId: true, externalId: true, changeType: true, recordType: true, before: true, after: true, status: true },
    });
    return reviews.map((review) => ({
      ...review,
      affectedChanges: changes.filter((change) => change.runId === review.runId && change.externalId === review.change.externalId),
    }));
  });
}

/** Resolves the incoming source record against every candidate as one decision; no records are merged. */
export function resolveDuplicateReview(
  tenantId: string,
  reviewId: string,
  actorUserId: string,
  resolution: DuplicateResolution,
  note: string,
) {
  return withTenant(tenantId, async (tx) => {
    const review = await tx.personDuplicateReview.findFirst({
      where: { id: reviewId, status: 'open' },
      include: { change: { select: { externalId: true } } },
    });
    if (!review) throw new DuplicateReviewNotFoundError(reviewId);
    const reviewedAt = new Date();
    await tx.personDuplicateReview.updateMany({
      where: { changeId: review.changeId, status: 'open' },
      data: { status: 'resolved', resolution, note, reviewedByUserId: actorUserId, reviewedAt },
    });
    if (resolution === 'keep_separate') {
      await tx.personImportChange.update({
        where: { id: review.changeId },
        data: { status: 'proposed', message: 'Reviewed as a distinct person despite matching an existing business email' },
      });
    } else if (resolution === 'link_existing') {
      if (review.change.externalId === null) {
        throw new Error('a source identity with no external id cannot be linked');
      }
      await tx.personSourceLink.create({
        data: {
          tenantId,
          sourceId: (await tx.personImportRun.findUniqueOrThrow({ where: { id: review.runId }, select: { sourceId: true } })).sourceId,
          personId: review.candidatePersonId,
          externalId: review.change.externalId,
          linkedByUserId: actorUserId,
        },
      });
      await tx.personImportChange.update({
        where: { id: review.changeId },
        data: { status: 'skipped', message: 'Incoming source identity linked to the selected existing person' },
      });
    } else {
      // A person's contract changes carry the same external id. Skipping only
      // the create would leave them proposed and guarantee an apply failure
      // because the person they belong to was deliberately not created.
      await tx.personImportChange.updateMany({
        where: { runId: review.runId, externalId: review.change.externalId, status: { in: ['proposed', 'needs_review'] } },
        data: { status: 'skipped', message: 'Source record skipped after duplicate review' },
      });
    }
    const remaining = await tx.personDuplicateReview.count({ where: { runId: review.runId, status: 'open' } });
    if (remaining === 0) {
      await tx.personImportRun.update({
        where: { id: review.runId },
        data: {
          status: review.restoreStatus,
          blockedReason: review.restoreBlockedReason,
          requiresConfirmation: review.restoreRequiresConfirmation,
        },
      });
    }
    await recordEvent(tx, {
      actorUserId,
      action: 'person_import.duplicate_review.resolve',
      targetType: 'PersonImportChange',
      targetId: review.changeId,
      outcome: 'success',
      sourceIp: null,
      payload: { reviewId, runId: review.runId, resolution, note },
    });
    return { runId: review.runId, changeId: review.changeId, resolution, remaining };
  });
}
