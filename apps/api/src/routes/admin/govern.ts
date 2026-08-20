import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  acceptFindingBody,
  approvalReportQuery,
  assignFindingBody,
  buildSnapshotBody,
  changeReportQuery,
  classificationBody,
  denyOrphanBody,
  evidencePackBody,
  exportCsvBody,
  findingQuery,
  governSettingsBody,
  governSnapshotQuery,
  businessFunctionBody,
  campaignListQuery,
  confirmBatchBody,
  createCampaignBody,
  decideExceptionBody,
  extendCampaignBody,
  graphQuery,
  idParam,
  previewReviewersBody,
  previewScopeBody,
  rebaseCampaignBody,
  requestExceptionBody,
  skipDispatchBody,
  sodRuleBody,
  sodRulePreviewBody,
  violationQuery,
  personReportQuery,
  refreshSourceParams,
  resolveRemediationBody,
  systemReportQuery,
} from '@syntra/contracts';
import {
  CampaignRefusedError,
  ExceptionRefusedError,
  PERMISSIONS,
  PROVISION_JOB,
  RevocationRefusedError,
  SYNC_JOB,
  acceptFinding,
  assignFinding,
  computeRevocationBatch,
  confirmRevocationBatch,
  createCampaign,
  decideSodException,
  extendCampaign,
  previewCampaignScope,
  previewReviewerResolution,
  previewSodRuleImpact,
  rebaseCampaign,
  requestSodException,
  skipDispatch,
  startCampaign,
  upsertBusinessFunction,
  upsertSodRule,
  buildSnapshot,
  confirmProposal,
  createEvidencePack,
  denyProposal,
  exportReportCsv,
  governReadScope,
  governSettings,
  holdsGovernPermission,
  integrityStatus,
  parseSubjectKey,
  personIdsInScope,
  provisionJobPayload,
  readableSnapshot,
  resolveRemediationItem,
  setResourceClassification,
  syncJobPayload,
  updateGovernSettings,
  verifyIncremental,
  whatChanged,
  whatDoesPersonHold,
  whoApprovedIt,
  whoHasAccessToSystem,
  type ChangeReport,
  type GovernScope,
  type Permission,
  type Scheduler,
} from '@syntra/core';
import { ProblemError } from '../../plugins/problem-json.js';
import { requirePermission } from '../../plugins/require-permission.js';
import { requireSession } from '../../plugins/require-session.js';

/**
 * `govern.read`, respecting an org-unit scope.
 *
 * `requirePermission(PERMISSIONS.GOVERN_READ)` cannot be used: it asks Core's
 * `hasPermission` with no scope, and Core deliberately refuses a scoped
 * assignment asked unscoped. A team lead with `govern.read` on their own
 * department would get 403 on every screen.
 *
 * This admits any holder — scoped or not — and stashes the resolved scope on
 * the request, so every handler can apply it. Section 21: the scope is
 * respected on EVERY READ PATH, not only on the list.
 */
function requireGovernRead(alsoRequire?: Permission) {
  return async function guard(request: FastifyRequest): Promise<void> {
    const scope = await request.db((tx) => governReadScope(tx, request.session.userId));
    if (scope.kind === 'none') {
      throw new ProblemError(403, 'forbidden', 'Forbidden', 'Requires govern.read');
    }
    // The export route needs `govern.export` AS WELL, and it still needs the
    // resolved scope — which is why it cannot use `requirePermission` alone.
    // That is exactly how the export ended up reading the whole tenant for a
    // department-scoped holder: a different guard on the same report.
    if (alsoRequire !== undefined) {
      // `holdsGovernPermission`, not Core's `hasPermission`: the same scoped
      // role that carries `govern.read` usually carries `govern.export` too,
      // and asking Core unscoped refuses it — which would leave a department
      // lead able to read their department on the screen and unable to export
      // the very same rows. The scope gates WHAT comes out, and the row filter
      // below is what enforces that.
      const held = await request.db((tx) =>
        holdsGovernPermission(tx, request.session.userId, alsoRequire),
      );
      if (!held) {
        throw new ProblemError(403, 'forbidden', 'Forbidden', `Requires ${alsoRequire}`);
      }
    }
    Reflect.set(request, 'governScope', scope);
  };
}

/**
 * Every Govern READ route, and whether it applies the org-unit scope.
 *
 * §21: "`govern.read` is scopeable to an organizational unit, and reporting
 * screens respect the scope on every read path, not only on the list." The
 * list is here so the structural test can enumerate it, and the EXEMPT entries
 * are named one at a time with a reason. Adding a read route and forgetting
 * the scope is then a test failure rather than a disclosure.
 */
export const GOVERN_READ_ROUTES: readonly { path: string; scoped: boolean; why?: string }[] = [
  {
    path: 'GET /govern/snapshots',
    scoped: false,
    why: 'a snapshot is tenant-wide metadata and names no person',
  },
  {
    path: 'GET /govern/snapshots/:id',
    scoped: false,
    why: 'counts and sources; no per-person rows',
  },
  {
    path: 'GET /govern/snapshots/:id/coverage',
    scoped: false,
    why: 'regions of the world, not people',
  },
  { path: 'GET /govern/reports/system', scoped: true },
  { path: 'GET /govern/reports/person/:personId', scoped: true },
  { path: 'GET /govern/reports/changes', scoped: true },
  { path: 'GET /govern/reports/approval', scoped: true },
  { path: 'POST /govern/exports/csv', scoped: true },
  { path: 'GET /govern/findings', scoped: true },
  { path: 'GET /govern/remediation', scoped: true },
  {
    path: 'GET /govern/orphans',
    scoped: false,
    why: 'an orphan account belongs to nobody, so it is in no org unit; §6 says a scoped reader must still see that they exist',
  },
  {
    path: 'GET /govern/integrity',
    scoped: false,
    why: 'the audit chain is tenant-wide and names no person',
  },
  {
    path: 'GET /govern/settings',
    scoped: false,
    why: 'the tenant’s thresholds and cadences; it names no person and a scoped reader still has to see what the guard is set to',
  },
  // ---- slice 2 -----------------------------------------------------------
  {
    path: 'GET /govern/campaigns',
    scoped: false,
    why: 'a campaign is a scope and a set of dates; the per-person rows are its items and those are not returned here',
  },
  { path: 'GET /govern/campaigns/:id', scoped: true },
  { path: 'GET /govern/batches/:id', scoped: true },
  {
    path: 'GET /govern/sod/functions',
    scoped: false,
    why: 'a business function is a set of resources and names no person but its owner',
  },
  {
    path: 'GET /govern/sod/rules',
    scoped: false,
    why: 'a rule relates two business functions; who violates it is the violations list below',
  },
  { path: 'GET /govern/sod/violations', scoped: true },
  { path: 'GET /govern/sod/graph', scoped: true },
];

/**
 * Is this finding about somebody the reader may see?
 *
 * Conservative in the safe direction: a finding whose subject is a person the
 * reader is not scoped to is withheld, and a finding about a SOURCE, a
 * SNAPSHOT or a CAMPAIGN — which name no person — is shown. A finding whose
 * subject cannot be resolved to a person is shown, because a scoped reader
 * withheld from `coverage_gap` would read the coverage figure as complete.
 */
function findingInScope(
  finding: { subjectRefType: string; subjectRefId: string; detail: unknown },
  admitted: ReadonlySet<string>,
): boolean {
  if (finding.subjectRefType === 'person') return admitted.has(finding.subjectRefId);
  const subjectKey = (finding.detail as { subjectKey?: unknown } | null)?.subjectKey;
  if (typeof subjectKey !== 'string') return true;
  const parsed = parseSubjectKey(subjectKey);
  return parsed === null || parsed.kind !== 'person' || admitted.has(parsed.personId);
}

/**
 * `whatChanged`'s body, filtered to the persons a scoped reader may see, with
 * the withheld count STATED rather than silently removed — §6's rule that
 * nobody reads a report as complete while part of it is not shown.
 */
function scopedChangeReport(
  body: ChangeReport,
  admitted: ReadonlySet<string> | 'all',
): ChangeReport & { withheldForScope: number } {
  if (admitted === 'all') return { ...body, withheldForScope: 0 };
  const visible = body.observedChanges.filter(
    (e) => e.personId !== null && admitted.has(e.personId),
  );
  return {
    ...body,
    observedChanges: visible,
    withheldForScope: body.observedChanges.length - visible.length,
  };
}

const scopeOf = (request: FastifyRequest): GovernScope =>
  Reflect.get(request, 'governScope') as GovernScope;

export async function registerAdminGovernRoutes(
  app: FastifyInstance,
  options: { scheduler?: () => Scheduler | null; publicUrl?: string } = {},
): Promise<void> {
  app.addHook('preHandler', requireSession('admin'));

  // ---- snapshots and coverage --------------------------------------------
  app.get('/govern/snapshots', { preHandler: requireGovernRead() }, async (request) => {
    const { limit } = governSnapshotQuery.parse(request.query);
    return request.db(async (tx) => ({
      snapshots: await tx.accessSnapshot.findMany({ orderBy: { asOf: 'desc' }, take: limit }),
    }));
  });

  app.post(
    '/govern/snapshots',
    { preHandler: requirePermission(PERMISSIONS.GOVERN_MANAGE) },
    async (request) => {
      const body = buildSnapshotBody.parse(request.body ?? {});
      // `buildSnapshot` opens its own short transactions; it is not called
      // inside `request.db`, which would nest one inside another.
      return buildSnapshot(request.tenantId, {
        kind: body.kind,
        actorUserId: request.session.userId,
      });
    },
  );

  app.get('/govern/snapshots/:id', { preHandler: requireGovernRead() }, async (request) => {
    const { id } = idParam.parse(request.params);
    return request.db(async (tx) => {
      const snapshot = await readableSnapshot(tx, id);
      const gapsByKind = await tx.coverageGap.groupBy({
        by: ['kind'],
        where: { snapshotId: id },
        _count: { _all: true },
      });
      return { snapshot, gapsByKind };
    });
  });

  app.get('/govern/snapshots/:id/coverage', { preHandler: requireGovernRead() }, async (request) => {
    const { id } = idParam.parse(request.params);
    return request.db(async (tx) => {
      await readableSnapshot(tx, id);
      return { gaps: await tx.coverageGap.findMany({ where: { snapshotId: id }, take: 500 }) };
    });
  });

  /**
   * Refresh now enqueues the OWNING SUBSYSTEM's existing job on the existing
   * queue, and says whose job it enqueued. Govern does not read the target and
   * does not hold the answer.
   */
  app.post(
    '/govern/sources/:kind/:id/refresh',
    { preHandler: requirePermission(PERMISSIONS.GOVERN_MANAGE) },
    async (request) => {
      const { kind, id } = refreshSourceParams.parse(request.params);
      const scheduler = options.scheduler?.() ?? null;
      if (scheduler === null) {
        throw new ProblemError(
          503,
          'scheduler-unavailable',
          'The job scheduler is not running',
          'Nothing was enqueued. Govern never reads a source itself, so there is no fallback.',
        );
      }
      if (kind === 'directorySource') {
        await scheduler.enqueue(SYNC_JOB, syncJobPayload(request.tenantId, id));
        return { enqueued: SYNC_JOB, owner: 'Directory Sync' };
      }
      await scheduler.enqueue(PROVISION_JOB, provisionJobPayload(request.tenantId, id));
      return { enqueued: PROVISION_JOB, owner: 'Provision' };
    },
  );

  // ---- the four reports ---------------------------------------------------
  app.get('/govern/reports/system', { preHandler: requireGovernRead() }, async (request) => {
    const query = systemReportQuery.parse(request.query);
    const report = await whoHasAccessToSystem(request.tenantId, query);
    const scope = scopeOf(request);
    if (scope.kind === 'tenant') return report;

    // The scope is applied to the ROWS, not only to the list of systems. A
    // report that filtered the index and not the detail would hand a
    // department lead the whole tenant one click in.
    const admitted = await request.db((tx) => personIdsInScope(tx, scope));
    if (admitted === 'all') return report;

    // AN UNATTRIBUTED ACCOUNT IS KEPT. It belongs to nobody, so it sits in no
    // org unit and no scope admits it — but §6 is explicit: "Nobody may read a
    // per-person report as complete while accounts belonging to nobody are in
    // the same systems." Dropping those rows while the header still carries the
    // tenant's `unattributedAccountCount` gives a scoped reader a report whose
    // header and body disagree, and the disagreement is invisible.
    const rows = report.body.rows.filter(
      (row) => row.personId === null || admitted.has(row.personId),
    );
    return {
      ...report,
      body: {
        ...report.body,
        rows,
        withheldForScope: report.body.rows.length - rows.length,
      },
    };
  });

  app.get(
    '/govern/reports/person/:personId',
    { preHandler: requireGovernRead() },
    async (request) => {
      const { personId } = request.params as { personId: string };
      const query = personReportQuery.parse(request.query);
      const scope = scopeOf(request);
      if (scope.kind !== 'tenant') {
        const admitted = await request.db((tx) => personIdsInScope(tx, scope));
        if (admitted !== 'all' && !admitted.has(personId)) {
          // 404, not 403. A 403 confirms the person exists, and the existence
          // of a person in another department is itself information.
          throw new ProblemError(404, 'not-found', 'Not found');
        }
      }
      return whatDoesPersonHold(request.tenantId, { ...query, personId });
    },
  );

  app.get('/govern/reports/changes', { preHandler: requireGovernRead() }, async (request) => {
    const report = await whatChanged(request.tenantId, changeReportQuery.parse(request.query));
    const scope = scopeOf(request);
    if (scope.kind === 'tenant') return report;

    // §21: the scope is respected on EVERY READ PATH, not only on the list.
    // `whatChanged` returns tenant-wide `HoldingEvent` rows, and a change
    // report is a per-person record of what somebody gained and lost.
    const admitted = await request.db((tx) => personIdsInScope(tx, scope));
    return { ...report, body: scopedChangeReport(report.body, admitted) };
  });

  app.get('/govern/reports/approval', { preHandler: requireGovernRead() }, async (request) => {
    const query = approvalReportQuery.parse(request.query);
    const scope = scopeOf(request);
    if (scope.kind !== 'tenant') {
      // This report is about one subject, so the scope check is the same
      // 404-not-403 as the person report: the existence of a person in another
      // department is itself information.
      const admitted = await request.db((tx) => personIdsInScope(tx, scope));
      const subject = parseSubjectKey(query.subjectKey);
      const personId = subject?.kind === 'person' ? subject.personId : null;
      if (admitted !== 'all' && (personId === null || !admitted.has(personId))) {
        throw new ProblemError(404, 'not-found', 'Not found');
      }
    }
    return whoApprovedIt(request.tenantId, query);
  });

  // ---- export -------------------------------------------------------------
  app.post(
    '/govern/exports/csv',
    { preHandler: requireGovernRead(PERMISSIONS.GOVERN_EXPORT) },
    async (request, reply) => {
      const query = exportCsvBody.parse(request.body ?? {});
      const report = await whoHasAccessToSystem(request.tenantId, query);

      // THE EXPORT IS THE WORST OF THE FOUR. §10 calls it "a copy of
      // everybody's access leaving the building" and §3 calls a cross-boundary
      // read of the holding table "the worst single disclosure this platform
      // could produce". Guarded only by `requirePermission(GOVERN_EXPORT)` and
      // with no scope filter at all — unlike the GET of the SAME report three
      // routes above — a department-scoped reader who also holds
      // `govern.export` walks out with the tenant.
      const scope = scopeOf(request);
      const admitted =
        scope.kind === 'tenant' ? 'all' : await request.db((tx) => personIdsInScope(tx, scope));
      const scoped =
        admitted === 'all'
          ? report
          : {
              ...report,
              body: {
                ...report.body,
                rows: report.body.rows.filter(
                  (row) => row.personId !== null && admitted.has(row.personId),
                ),
              },
            };

      const csv = await exportReportCsv(request.tenantId, request.session.userId, scoped, {
        ...query,
        // The scope travels onto the audit event, so the row count and the
        // scope agree in the record. An export of 40 rows against a scope of
        // 12,000 people and an export of 40 rows against a scope of 40 are
        // different acts, and the event has to be able to tell them apart.
        scopeOrgUnitId: scope.kind === 'orgUnits' ? scope.orgUnitIds : null,
        rowCount: scoped.body.rows.length,
      });
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', 'attachment; filename="govern-access.csv"')
        .send(csv);
    },
  );

  app.post(
    '/govern/evidence',
    { preHandler: requirePermission(PERMISSIONS.GOVERN_EXPORT) },
    async (request) => {
      const body = evidencePackBody.parse(request.body ?? {});
      return createEvidencePack(request.tenantId, request.session.userId, body);
    },
  );

  // ---- findings and remediation -------------------------------------------
  app.get('/govern/findings', { preHandler: requireGovernRead() }, async (request) => {
    const query = findingQuery.parse(request.query);
    const scope = scopeOf(request);
    return request.db(async (tx) => {
      // FINDINGS NAME PERSONS. `access_without_contract` has
      // `subjectRefType: 'person'` and `subjectRefId` is the person id;
      // `unattributable_holding` and `privileged_uncertified` carry a
      // `subjectKey` in `detail`. A tenant-wide list handed a department lead
      // the leavers of every other department.
      const admitted = scope.kind === 'tenant' ? 'all' : await personIdsInScope(tx, scope);
      const findings = await tx.governFinding.findMany({
        where: {
          ...(query.status ? { status: query.status } : {}),
          ...(query.kind ? { kind: query.kind } : {}),
          ...(query.severity ? { severity: query.severity } : {}),
        },
        // The dashboard leads with what is wrong, so the default order is by
        // severity descending and then by age, never alphabetical.
        orderBy: [{ severity: 'desc' }, { firstSeenAt: 'asc' }],
        take: query.limit,
      });
      return {
        findings:
          admitted === 'all' ? findings : findings.filter((f) => findingInScope(f, admitted)),
      };
    });
  });

  app.post(
    '/govern/findings/:id/assign',
    { preHandler: requirePermission(PERMISSIONS.GOVERN_MANAGE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = assignFindingBody.parse(request.body);
      await assignFinding(
        request.tenantId,
        request.session.userId,
        id,
        body.ownerPersonId,
        body.dueAt,
      );
      return reply.status(204).send();
    },
  );

  app.post(
    '/govern/findings/:id/accept',
    { preHandler: requirePermission(PERMISSIONS.GOVERN_MANAGE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = acceptFindingBody.parse(request.body);
      await acceptFinding(request.tenantId, request.session.userId, id, body.reason, body.until);
      return reply.status(204).send();
    },
  );

  app.get('/govern/remediation', { preHandler: requireGovernRead() }, async (request) => {
    const scope = scopeOf(request);
    return request.db(async (tx) => {
      const admitted = scope.kind === 'tenant' ? 'all' : await personIdsInScope(tx, scope);
      return {
        items: await tx.remediationItem.findMany({
          where: {
            status: { in: ['open', 'in_progress'] },
            // A remediation item is OWNED by a person, so the scope is over the
            // owner rather than over the subject: a department lead chases
            // their own department's queue.
            ...(admitted === 'all' ? {} : { ownerPersonId: { in: [...admitted] } }),
          },
          orderBy: { dueAt: 'asc' },
          take: 200,
        }),
      };
    });
  });

  app.post(
    '/govern/remediation/:id/resolve',
    { preHandler: requirePermission(PERMISSIONS.GOVERN_MANAGE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = resolveRemediationBody.parse(request.body);
      await resolveRemediationItem(
        request.tenantId,
        request.session.userId,
        id,
        body.status,
        body.comment,
      );
      return reply.status(204).send();
    },
  );

  // ---- orphan accounts ----------------------------------------------------
  app.get('/govern/orphans', { preHandler: requireGovernRead() }, async (request) =>
    request.db(async (tx) => ({
      proposals: await tx.accountAttribution.findMany({
        where: { status: 'proposed' },
        orderBy: [{ confidence: 'desc' }],
        take: 200,
      }),
    })),
  );

  app.post(
    '/govern/orphans/:id/confirm',
    { preHandler: requirePermission(PERMISSIONS.GOVERN_MANAGE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      // The linking function is injected rather than imported by the service,
      // so `boundaries.test.ts`'s no-access-bearing-write assertion stays true
      // of the Govern module. Provision owns the write.
      await confirmProposal(request.tenantId, request.session.userId, id, async () => {
        throw new ProblemError(
          501,
          'linking-not-wired',
          'Account linking is not wired yet',
          "Provision's account-linking entry point is supplied here once the two modules are joined.",
        );
      });
      return reply.status(204).send();
    },
  );

  app.post(
    '/govern/orphans/:id/deny',
    { preHandler: requirePermission(PERMISSIONS.GOVERN_MANAGE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = denyOrphanBody.parse(request.body);
      await denyProposal(request.tenantId, request.session.userId, id, body.reason);
      return reply.status(204).send();
    },
  );

  // ---- audit integrity ----------------------------------------------------
  app.get('/govern/integrity', { preHandler: requireGovernRead() }, async (request) =>
    request.db(async (tx) => {
      const anchors = await tx.auditAnchor.count({ where: { status: 'anchored' } });
      return integrityStatus(tx, anchors > 0);
    }),
  );

  app.post(
    '/govern/integrity/verify',
    { preHandler: requirePermission(PERMISSIONS.GOVERN_MANAGE) },
    async (request) => verifyIncremental(request.tenantId),
  );

  // ---- settings and classification ----------------------------------------
  app.get('/govern/settings', { preHandler: requireGovernRead() }, async (request) =>
    request.db((tx) => governSettings(tx)),
  );

  app.patch(
    '/govern/settings',
    { preHandler: requirePermission(PERMISSIONS.GOVERN_MANAGE) },
    async (request, reply) => {
      const body = governSettingsBody.parse(request.body ?? {});
      await updateGovernSettings(request.tenantId, request.session.userId, body);
      return reply.status(204).send();
    },
  );

  app.post(
    '/govern/classifications',
    { preHandler: requirePermission(PERMISSIONS.GOVERN_MANAGE) },
    async (request, reply) => {
      const body = classificationBody.parse(request.body);
      await setResourceClassification(request.tenantId, request.session.userId, body);
      return reply.status(204).send();
    },
  );

  // ---- campaigns ---------------------------------------------------------
  app.get('/govern/campaigns', { preHandler: requireGovernRead() }, async (request) => {
    const query = campaignListQuery.parse(request.query ?? {});
    return request.db(async (tx) => ({
      campaigns: await tx.campaign.findMany({
        where: { ...(query.status === undefined ? {} : { status: query.status }) },
        orderBy: [{ dueAt: 'asc' }],
        take: query.limit,
      }),
    }));
  });

  app.post(
    '/govern/campaigns',
    { preHandler: requirePermission(PERMISSIONS.GOVERN_MANAGE) },
    async (request, reply) => {
      const body = createCampaignBody.parse(request.body);
      const created = await createCampaign(request.tenantId, request.session.userId, body);
      return reply.status(201).send(created);
    },
  );

  app.get('/govern/campaigns/:id', { preHandler: requireGovernRead() }, async (request) => {
    const { id } = idParam.parse(request.params);
    const scope = scopeOf(request);
    return request.db(async (tx) => {
      const admitted = scope.kind === 'tenant' ? 'all' : await personIdsInScope(tx, scope);
      const campaign = await tx.campaign.findUniqueOrThrow({ where: { id } });
      // §12: a campaign report NEVER prints a percentage without the four
      // counts beside it, and every percentage names its denominator inline.
      // The shape is the enforcement — a caller cannot render the number
      // without having the denominator and the sentence in hand.
      return {
        campaign,
        counts: {
          total: campaign.totalItems,
          certified: campaign.certifiedItems,
          revoked: campaign.revokedItems,
          requiresChange: campaign.requiresChangeItems,
          moot: campaign.mootItems,
          undecided: campaign.undecidedItems,
          blocked: campaign.blockedItems,
        },
        coverage: {
          percent: campaign.coveragePercent,
          denominator: campaign.totalItems,
          statement: '(decided + moot) / total',
        },
        // A quality signal names a REVIEWER, and "who rubber-stamped" is at
        // least as sensitive as "who holds what". A scoped reader sees the
        // signals for the reviewers they are scoped to, and the campaign's own
        // counts above are tenant-wide facts about the campaign rather than
        // about any person.
        signals: await tx.reviewQualitySignal.findMany({
          where: {
            campaignId: id,
            ...(admitted === 'all' ? {} : { personId: { in: [...admitted] } }),
          },
        }),
      };
    });
  });

  app.post(
    '/govern/campaigns/preview-scope',
    { preHandler: requireGovernRead() },
    async (request) => {
      const body = previewScopeBody.parse(request.body);
      return previewCampaignScope(request.tenantId, body.scope, body.snapshotId);
    },
  );

  app.post(
    '/govern/campaigns/preview-reviewers',
    { preHandler: requireGovernRead() },
    async (request) => {
      // "Stage: manager; 1,102 items resolve, 61 fall to the fallback, 17
      // resolve to nobody — here they are." The screen that catches an
      // unreviewable campaign before 200 people are emailed, rather than at 3am
      // on the due date. It writes no `CampaignItem` and no
      // `CampaignItemReviewer` row.
      return previewReviewerResolution(request.tenantId, previewReviewersBody.parse(request.body));
    },
  );

  app.post(
    '/govern/campaigns/:id/start',
    { preHandler: requirePermission(PERMISSIONS.GOVERN_MANAGE) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      try {
        return await startCampaign(request.tenantId, request.session.userId, id, {
          // The link in every reviewer's email. Absent, the notification
          // renders a relative URL nobody can click from a mail client.
          publicUrl: options.publicUrl ?? '',
        });
      } catch (error) {
        // The refusals are 409s carrying their code, not 500s. A stale source
        // or an empty scope is a decision this endpoint made, and the console
        // renders the reason rather than "something went wrong".
        if (error instanceof CampaignRefusedError) {
          throw new ProblemError(409, error.code, 'Campaign refused', error.message);
        }
        throw error;
      }
    },
  );

  app.post(
    '/govern/campaigns/:id/extend',
    { preHandler: requirePermission(PERMISSIONS.GOVERN_MANAGE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = extendCampaignBody.parse(request.body);
      await extendCampaign(request.tenantId, request.session.userId, id, body.dueAt);
      return reply.status(204).send();
    },
  );

  app.post(
    '/govern/campaigns/:id/rebase',
    { preHandler: requirePermission(PERMISSIONS.GOVERN_MANAGE) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const body = rebaseCampaignBody.parse(request.body);
      return rebaseCampaign(request.tenantId, request.session.userId, id, body.snapshotId);
    },
  );

  // ---- revocation --------------------------------------------------------
  app.post(
    '/govern/campaigns/:id/revocations',
    { preHandler: requirePermission(PERMISSIONS.GOVERN_MANAGE) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      // WITHOUT THIS ROUTE nothing computes a batch, and §13's whole
      // "revocation is a run" machinery is unreachable from the product:
      // `POST /govern/batches/:id/confirm` would have nothing to confirm.
      return computeRevocationBatch(request.tenantId, request.session.userId, id);
    },
  );

  app.get('/govern/batches/:id', { preHandler: requireGovernRead() }, async (request) => {
    const { id } = idParam.parse(request.params);
    const scope = scopeOf(request);
    return request.db(async (tx) => {
      const admitted = scope.kind === 'tenant' ? 'all' : await personIdsInScope(tx, scope);
      const rows = await tx.revocationDispatch.findMany({
        where: { batchId: id },
        // An explicit ordinal: `createdAt` is transaction start time and every
        // row of the batch's `createMany` carries the same one.
        orderBy: { sequence: 'asc' },
      });
      // `RevocationDispatch.itemId` is a bare column with no relation, so the
      // subjects come from one grouped read rather than a join.
      const personByItem = new Map<string, string | null>(
        admitted === 'all'
          ? []
          : (
              await tx.campaignItem.findMany({
                where: {
                  id: { in: rows.map((r) => r.itemId).filter((x): x is string => x !== null) },
                },
                select: { id: true, personId: true },
              })
            ).map((item) => [item.id, item.personId]),
      );
      // EVERY DISPATCH ROW NAMES A PERSON, in `holdingDescriptor.subjectKey`
      // and on its campaign item. A tenant-wide list here would hand a
      // department lead the revocation list of every other department, which
      // is the same failure the findings list was fixed for.
      const visible =
        admitted === 'all'
          ? rows
          : rows.filter((row) => {
              const personId = row.itemId === null ? null : personByItem.get(row.itemId);
              // A row whose subject cannot be resolved is WITHHELD from a
              // scoped reader rather than shown: the safe direction here is
              // the opposite of the findings list's, because a dispatch row
              // always has a subject and a missing one means the item was
              // deleted, not that the row is about nobody.
              return personId != null && admitted.has(personId);
            });
      return {
        batch: await tx.revocationBatch.findUniqueOrThrow({ where: { id } }),
        dispatches: visible,
        // NAMED, not silently dropped. The batch's own counts are tenant-wide,
        // so a scoped reader seeing 40 rows under a header saying 342 would
        // read the difference as a bug rather than as a boundary.
        withheldOutOfScope: rows.length - visible.length,
      };
    });
  });

  app.post(
    '/govern/batches/:id/confirm',
    { preHandler: requirePermission(PERMISSIONS.GOVERN_MANAGE) },
    async (request) => {
      const { id } = idParam.parse(request.params);
      const body = confirmBatchBody.parse(request.body);
      // `autoApply` does not exist for a batch. Confirmation is per batch,
      // explicit, and the confirming user is recorded. `confirmed` is a
      // REQUIRED field of the body rather than a default, so a batch the guard
      // flagged cannot be waved through by a caller who did not read the reason.
      try {
        return await confirmRevocationBatch(request.tenantId, request.session.userId, id, {
          confirmed: body.confirmed,
        });
      } catch (error) {
        if (error instanceof RevocationRefusedError) {
          throw new ProblemError(409, error.code, 'Revocation refused', error.message);
        }
        throw error;
      }
    },
  );

  app.post(
    '/govern/dispatches/:id/skip',
    { preHandler: requirePermission(PERMISSIONS.GOVERN_MANAGE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = skipDispatchBody.parse(request.body);
      await skipDispatch(request.tenantId, request.session.userId, id, body.reason);
      return reply.status(204).send();
    },
  );

  // ---- segregation of duties ---------------------------------------------
  app.get('/govern/sod/functions', { preHandler: requireGovernRead() }, async (request) =>
    request.db(async (tx) => ({
      functions: await tx.businessFunction.findMany({
        include: { resources: true },
        orderBy: { name: 'asc' },
      }),
    })),
  );

  app.post(
    '/govern/sod/functions',
    { preHandler: requirePermission(PERMISSIONS.GOVERN_MANAGE) },
    async (request, reply) => {
      const body = businessFunctionBody.parse(request.body);
      const created = await upsertBusinessFunction(request.tenantId, request.session.userId, body);
      return reply.status(201).send(created);
    },
  );

  app.get('/govern/sod/rules', { preHandler: requireGovernRead() }, async (request) =>
    request.db(async (tx) => ({
      rules: await tx.sodRule.findMany({
        include: { functionA: true, functionB: true },
        orderBy: { name: 'asc' },
      }),
    })),
  );

  app.post(
    '/govern/sod/rules',
    { preHandler: requirePermission(PERMISSIONS.GOVERN_MANAGE) },
    async (request, reply) => {
      const body = sodRuleBody.parse(request.body);
      const created = await upsertSodRule(request.tenantId, request.session.userId, body);
      return reply.status(201).send(created);
    },
  );

  app.post(
    '/govern/sod/rules/preview',
    { preHandler: requireGovernRead() },
    // BEFORE it is saved. A rule that would fire against 400 people is a
    // configuration error, and the person with the console open is who should
    // see it, at that moment — not the 400 people, six hours later.
    async (request) =>
      previewSodRuleImpact(request.tenantId, sodRulePreviewBody.parse(request.body)),
  );

  app.get('/govern/sod/violations', { preHandler: requireGovernRead() }, async (request) => {
    const query = violationQuery.parse(request.query ?? {});
    const scope = scopeOf(request);
    return request.db(async (tx) => {
      // A violation names a person, so the org-unit scope applies here exactly
      // as it does to the findings list (§21).
      const admitted = scope.kind === 'tenant' ? 'all' : await personIdsInScope(tx, scope);
      return {
        violations: await tx.sodViolation.findMany({
          where: {
            status: query.status ?? 'open',
            ...(admitted === 'all' ? {} : { personId: { in: [...admitted] } }),
          },
          include: { rule: { select: { id: true, name: true, rationale: true } } },
          orderBy: [{ severity: 'desc' }, { firstSeenAt: 'asc' }],
          take: query.limit,
        }),
      };
    });
  });

  app.post(
    '/govern/sod/violations/:id/except',
    // Requesting an exception is not accepting one. This opens a request; the
    // decision below is a different permission entirely.
    { preHandler: requireGovernRead() },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = requestExceptionBody.parse(request.body);
      // The RULE and the PERSON come from the violation rather than from the
      // body. A caller who could name them would be able to raise an exception
      // against a rule for a person whose violation is somebody else's.
      const violation = await request.db((tx) =>
        tx.sodViolation.findUniqueOrThrow({
          where: { id },
          select: { ruleId: true, personId: true },
        }),
      );
      try {
        const created = await requestSodException(request.tenantId, request.session.userId, {
          ruleId: violation.ruleId,
          personId: violation.personId,
          violationId: id,
          ...body,
        });
        return reply.status(201).send(created);
      } catch (error) {
        if (error instanceof ExceptionRefusedError) {
          throw new ProblemError(409, error.code, 'Exception refused', error.message);
        }
        throw error;
      }
    },
  );

  app.post(
    '/govern/sod/exceptions/:id/decide',
    // NOT govern.manage. Administering the governance module and accepting the
    // organization's risk are different jobs, and a product that conflates them
    // hands risk acceptance to whoever configures the software.
    { preHandler: requirePermission(PERMISSIONS.GOVERN_ACCEPT_RISK) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = decideExceptionBody.parse(request.body);
      try {
        await decideSodException(
          request.tenantId,
          request.session.userId,
          id,
          body.decision,
          body.comment,
        );
      } catch (error) {
        if (error instanceof ExceptionRefusedError) {
          throw new ProblemError(409, error.code, 'Exception refused', error.message);
        }
        throw error;
      }
      return reply.status(204).send();
    },
  );

  app.get('/govern/sod/graph', { preHandler: requireGovernRead() }, async (request) => {
    const query = graphQuery.parse(request.query ?? {});
    const scope = scopeOf(request);
    // A READ of what the nightly job found, never a detection run. Detecting
    // from a GET would write findings as a side effect of somebody opening a
    // screen, and two people with the screen open would each write them.
    return request.db(async (tx) => {
      const admitted = scope.kind === 'tenant' ? 'all' : await personIdsInScope(tx, scope);
      const findings = await tx.governFinding.findMany({
        where: {
          kind: {
            in: [
              'approval_reciprocity',
              'sod_laundering',
              'no_human_decision',
              'unmergeable_actor',
            ],
          },
          status: { in: ['open', 'accepted'] },
        },
        orderBy: [{ severity: 'desc' }, { firstSeenAt: 'asc' }],
        take: query.limit,
      });
      // Every one of these four kinds names people — a pair, a cycle, a
      // beneficiary, an account — so the same subtraction applies as to the
      // findings list.
      return {
        findings:
          admitted === 'all' ? findings : findings.filter((f) => findingInScope(f, admitted)),
      };
    });
  });
}
