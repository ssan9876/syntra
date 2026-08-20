import type { FastifyInstance, FastifyRequest } from 'fastify';
import { bulkCertifyBody, decideItemBody, idParam, reviewListQuery } from '@syntra/contracts';
import {
  CampaignDecisionRefusedError,
  bulkCertify,
  openItem,
  recordCampaignDecision,
  summariseAttributions,
  type AttributionDraft,
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
/**
 * A name from the two parts this route selects.
 *
 * NOT `personDisplayName`, which takes the whole `PersonFacts` — name
 * convention, both e-mail addresses, status — and selecting all of that to
 * render two words on a review screen reads more of a person's record than the
 * screen shows.
 */
const displayName = (person: { givenName: string; familyName: string }): string =>
  [person.givenName, person.familyName]
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .join(' ');

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
    return request.db(async (tx) => {
      const rows = await tx.campaignItem.findMany({
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
            select: {
              id: true,
              name: true,
              dueAt: true,
              allowBulkCertify: true,
              snapshotId: true,
            },
          },
        },
        orderBy: [{ resourceName: 'asc' }],
        take: query.limit,
      });

      // ---- everything the screen needs to be readable ---------------------
      //
      // §8: the reviewer is shown WHO, WHAT, HOW THEY GOT IT, WHEN IT WAS LAST
      // CONFIRMED TRUE and WHO LAST CERTIFIED IT — in words. A screen that
      // renders `business_rule` and a uuid is a screen whose answer is "keep",
      // every time, and the certification it produces means nothing. Four
      // GROUPED reads for the whole page, never one per row.
      const personIds = [...new Set(rows.map((r) => r.personId).filter((x): x is string => x !== null))];
      // `CampaignItem.systemId` is a plain String and carries `'syntra'` for
      // every internal resource, while `TargetSystem.id` is `@db.Uuid`. Passing
      // the whole set to `findMany` is a Postgres cast error that takes the
      // reviewer's entire queue down with a 500.
      const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const systemIds = [...new Set(rows.map((r) => r.systemId))].filter((id) => UUID.test(id));
      const snapshotIds = [...new Set(rows.map((r) => r.campaign.snapshotId))];

      const [persons, systems, certifications, sources] = await Promise.all([
        personIds.length === 0
          ? []
          : tx.person.findMany({
              where: { id: { in: personIds } },
              select: { id: true, givenName: true, familyName: true },
            }),
        systemIds.length === 0
          ? []
          : tx.targetSystem.findMany({
              where: { id: { in: systemIds } },
              select: { id: true, name: true },
            }),
        tx.holdingCertification.findMany({
          where: { subjectRefId: { in: rows.map((r) => r.subjectKey) } },
        }),
        tx.snapshotSource.findMany({ where: { snapshotId: { in: snapshotIds } } }),
      ]);

      const nameByPerson = new Map(persons.map((p) => [p.id, displayName(p)]));
      const nameBySystem = new Map(systems.map((sys) => [sys.id, sys.name]));
      const certifierIds = [
        ...new Set(certifications.map((c) => c.lastCertifiedByPersonId)),
      ];
      const certifiers = new Map(
        (certifierIds.length === 0
          ? []
          : await tx.person.findMany({
              where: { id: { in: certifierIds } },
              select: { id: true, givenName: true, familyName: true },
            })
        ).map((p) => [p.id, displayName(p)]),
      );
      const certByKey = new Map(
        certifications.map((c) => [
          `${c.subjectRefId}|${c.systemId}|${c.resourceKind}|${c.resourceId}`,
          c,
        ]),
      );
      const sourceByKey = new Map(sources.map((src) => [`${src.snapshotId}|${src.sourceId}`, src]));

      return {
        items: rows.map((row) => {
          const cert = certByKey.get(
            `${row.subjectKey}|${row.systemId}|${row.resourceKind}|${row.resourceId}`,
          );
          const source = sourceByKey.get(`${row.campaign.snapshotId}|${row.systemId}`);
          return {
            ...row,
            subjectName:
              row.personId === null
                ? // An account with no person behind it. Named by what it IS,
                  // never blank: an unattributed account is one of the more
                  // interesting things a review can put in front of somebody.
                  (row.accountRef ?? row.subjectKey)
                : (nameByPerson.get(row.personId) ?? row.subjectKey),
            systemName: nameBySystem.get(row.systemId) ?? 'Syntra',
            provenance: summariseAttributions(
              (row.attributions as AttributionDraft[] | null) ?? [],
            ),
            lastCertifiedAt: cert?.lastCertifiedAt ?? null,
            lastCertifiedBy:
              cert === undefined
                ? null
                : (certifiers.get(cert.lastCertifiedByPersonId) ?? 'somebody no longer here'),
            // §8 rule 5: the reviewer is told the AGE and the SLA before they
            // decide, on the item, and the decision records it.
            // Computed here rather than read: `ageHours` belongs to
            // `readableSnapshot`'s projection and `SnapshotSource` stores the
            // read time. Measured to NOW, deliberately — the reviewer is
            // deciding now, and the age that matters is the age at the moment
            // of the decision, not at the moment the snapshot was built.
            sourceAgeHours:
              source?.lastSuccessfulReadAt == null
                ? null
                : (Date.now() - source.lastSuccessfulReadAt.getTime()) / 3_600_000,
            sourceSlaHours: source?.freshnessSlaHours ?? 0,
          };
        }),
      };
    });
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
