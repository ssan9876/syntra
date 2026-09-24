import { acceptFindingBody, approvalReportQuery, assignFindingBody, buildSnapshotBody, businessFunctionBody, campaignListQuery, changeReportQuery, classificationBody, confirmBatchBody, createCampaignBody, decideExceptionBody, denyOrphanBody, evidencePackBody, exportCsvBody, extendCampaignBody, findingQuery, governSettingsBody, governSnapshotQuery, graphQuery, idParam, personParam, personReportQuery, previewReviewersBody, previewScopeBody, rebaseCampaignBody, refreshSourceParams, requestExceptionBody, resolveRemediationBody, revokeExceptionBody, ruleMiningQuery, skipDispatchBody, sodRuleBody, sodRulePreviewBody, systemReportQuery, violationQuery } from '@syntra/contracts';
import { describeAdminRoutes } from '../../openapi/describe.js';

/**
 * The OpenAPI description of the routes in `govern.ts`. See openapi/describe.ts.
 *
 * `govern.read` may be held scoped to organizational units. The routes that
 * `GOVERN_READ_ROUTES` marks `scoped: true` filter what they return to the
 * caller's scope, and say so below, because an integrator seeing fewer rows
 * than a tenant-wide count suggests needs to know it is a boundary, not a bug.
 */
const SCOPED =
  "Filtered to the caller's organizational-unit scope when `govern.read` is held scoped; a tenant-wide holder sees everything.";

export const governOpenApi = describeAdminRoutes('Govern', {
  // ---- snapshots and coverage ----
  'GET /govern/snapshots': { summary: 'List access snapshots', query: governSnapshotQuery },
  'POST /govern/snapshots': {
    summary: 'Build an access snapshot',
    description: 'Builds the snapshot synchronously and returns it.',
    body: buildSnapshotBody,
  },
  'GET /govern/snapshots/:id': { summary: 'Get an access snapshot', params: idParam },
  'GET /govern/snapshots/:id/rule-candidates': {
    summary: "Mine candidate access rules from a snapshot's data",
    description: SCOPED,
    query: ruleMiningQuery,
    params: idParam,
  },
  'GET /govern/snapshots/:id/coverage': { summary: "List a snapshot's coverage gaps", params: idParam },
  'POST /govern/sources/:kind/:id/refresh': {
    summary: 'Enqueue a refresh of a directory source or target system',
    description:
      "Enqueues the owning subsystem's own sync or provisioning job and names it in the response. Answers 503 `scheduler-unavailable` when no job scheduler is running.",
    params: refreshSourceParams,
  },
  // ---- the four reports ----
  'GET /govern/reports/system': {
    summary: 'Report who has access to a system',
    description: SCOPED,
    query: systemReportQuery,
  },
  'GET /govern/reports/person/:personId': {
    summary: 'Report what a person has access to',
    description: `${SCOPED} A person outside the scope answers 404.`,
    query: personReportQuery,
    params: personParam,
  },
  'GET /govern/reports/changes': {
    summary: 'Report what access changed over a period',
    description: SCOPED,
    query: changeReportQuery,
  },
  'GET /govern/reports/approval': {
    summary: 'Report who approved a grant',
    description: SCOPED,
    query: approvalReportQuery,
  },
  // ---- export ----
  'POST /govern/exports/csv': {
    summary: 'Export the system access report as CSV',
    description: `Downloads \`govern-access.csv\` as an attachment; the export is audited with its row count and scope. ${SCOPED}`,
    body: exportCsvBody,
    produces: 'text/csv',
  },
  'POST /govern/evidence': {
    summary: 'Create a signed evidence pack',
    body: evidencePackBody,
  },
  'GET /govern/evidence/:id': {
    summary: 'Fetch a signed evidence pack',
    description:
      'Returns the whole bundle and `digestMatches`, which is false when the stored bundle no longer matches its recorded digest.',
    params: idParam,
  },
  // ---- findings and remediation ----
  'GET /govern/findings': { summary: 'List governance findings', description: SCOPED, query: findingQuery },
  'POST /govern/findings/:id/assign': {
    summary: 'Assign a finding to an owner',
    body: assignFindingBody,
    params: idParam,
    status: 204,
  },
  'POST /govern/findings/:id/accept': {
    summary: 'Accept a finding as a known risk',
    body: acceptFindingBody,
    params: idParam,
    status: 204,
  },
  'GET /govern/remediation': {
    summary: 'List open remediation items',
    description: `At most 200 items, soonest due first. ${SCOPED}`,
  },
  'POST /govern/remediation/:id/resolve': {
    summary: 'Resolve a remediation item',
    body: resolveRemediationBody,
    params: idParam,
    status: 204,
  },
  // ---- orphan accounts ----
  'GET /govern/orphans': { summary: 'List orphan accounts and their link proposals' },
  'POST /govern/orphans/:id/deny': {
    summary: 'Deny an orphan-account link proposal',
    body: denyOrphanBody,
    params: idParam,
    status: 204,
  },
  // ---- audit integrity ----
  'GET /govern/integrity': { summary: 'Get the audit-chain integrity status' },
  'POST /govern/integrity/verify': {
    summary: 'Verify the audit chain from the last checkpoint',
    description: 'Runs the incremental verification inside the request and returns its result.',
  },
  'POST /govern/integrity/verify-full': {
    summary: 'Verify the whole audit chain from genesis',
    description:
      'For investigations: walks the entire chain inside the request, records the check, and writes no checkpoint. Slow on a large tenant.',
  },
  // ---- settings and classification ----
  'GET /govern/settings': { summary: 'Get governance settings' },
  'PATCH /govern/settings': { summary: 'Update governance settings', body: governSettingsBody, status: 204 },
  'POST /govern/classifications': {
    summary: 'Classify a target resource as privileged or not',
    body: classificationBody,
    status: 204,
  },
  // ---- campaigns ----
  'GET /govern/campaigns': { summary: 'List access-review campaigns', query: campaignListQuery },
  'POST /govern/campaigns': { summary: 'Create an access-review campaign', body: createCampaignBody, status: 201 },
  'GET /govern/campaigns/:id': { summary: 'Get an access-review campaign', description: SCOPED, params: idParam },
  // ---- previews ----
  'POST /govern/campaigns/preview-scope': {
    summary: 'Preview the items a campaign scope would include',
    description: 'Writes nothing.',
    body: previewScopeBody,
  },
  'POST /govern/campaigns/preview-reviewers': {
    summary: 'Preview how campaign reviewers would resolve',
    description: 'Shows which items resolve to a reviewer, fall to the fallback, or resolve to nobody. Writes nothing.',
    body: previewReviewersBody,
  },
  'POST /govern/campaigns/:id/start': {
    summary: 'Start an access-review campaign',
    description:
      'Resolves reviewers and emails each of them a link. A refusal (a stale source, an empty scope) is a 409 carrying its code.',
    params: idParam,
  },
  'POST /govern/campaigns/:id/extend': {
    summary: "Extend a campaign's due date",
    body: extendCampaignBody,
    params: idParam,
    status: 204,
  },
  'POST /govern/campaigns/:id/rebase': {
    summary: 'Rebase a campaign onto a newer snapshot',
    body: rebaseCampaignBody,
    params: idParam,
  },
  // ---- revocation ----
  'POST /govern/campaigns/:id/revocations': {
    summary: "Compute the revocation batch for a campaign's rejected items",
    description: 'Computes the batch only; nothing is revoked until the batch is confirmed.',
    params: idParam,
  },
  'GET /govern/batches/:id': {
    summary: 'Get a revocation batch and its dispatches',
    description: `${SCOPED} \`withheldOutOfScope\` counts the dispatches left out.`,
    params: idParam,
  },
  'POST /govern/batches/:id/confirm': {
    summary: 'Confirm a revocation batch for dispatch',
    description:
      'Confirmation is explicit and per batch; `confirmed` is required rather than defaulted. A refusal is a 409 carrying its code.',
    body: confirmBatchBody,
    params: idParam,
  },
  'POST /govern/dispatches/:id/skip': {
    summary: 'Skip one revocation dispatch',
    body: skipDispatchBody,
    params: idParam,
    status: 204,
  },
  // ---- segregation of duties ----
  'GET /govern/sod/functions': { summary: 'List business functions' },
  'POST /govern/sod/functions': { summary: 'Create a business function', body: businessFunctionBody, status: 201 },
  'GET /govern/sod/rules': { summary: 'List segregation-of-duties rules' },
  'POST /govern/sod/rules': { summary: 'Create a segregation-of-duties rule', body: sodRuleBody, status: 201 },
  'POST /govern/sod/rules/preview': {
    summary: 'Preview the impact of a segregation-of-duties rule',
    description: 'Writes nothing.',
    body: sodRulePreviewBody,
  },
  'GET /govern/sod/violations': {
    summary: 'List segregation-of-duties violations',
    description: SCOPED,
    query: violationQuery,
  },
  'POST /govern/sod/violations/:id/except': {
    summary: 'Request an exception for a violation',
    description: `Opens a request only; deciding it needs \`govern.accept_risk\`. ${SCOPED}`,
    body: requestExceptionBody,
    params: idParam,
    status: 201,
  },
  'POST /govern/sod/exceptions/:id/decide': {
    summary: 'Approve or reject an exception request',
    body: decideExceptionBody,
    params: idParam,
    status: 204,
  },
  'POST /govern/sod/exceptions/:id/revoke': {
    summary: 'Revoke a granted exception',
    description:
      'The gate admits any `govern.read` holder; the service then refuses anyone who is not a risk acceptor, the approver, or the rule owner.',
    body: revokeExceptionBody,
    params: idParam,
    status: 204,
  },
  'GET /govern/sod/graph': {
    summary: 'Get the approval-reciprocity and laundering graph',
    description: `Reads what the nightly detection found; it never runs detection. ${SCOPED}`,
    query: graphQuery,
  },
});
