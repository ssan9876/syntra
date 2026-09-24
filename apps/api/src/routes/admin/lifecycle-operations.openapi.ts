import { assignmentRequest, bulkLifecycleRequest, caseNoteRequest, caseReopenRequest, caseResolutionRequest, decisionRequest, idParams, legalHoldQuery, legalHoldRequest, listQuery, moverApplyRequest, moverPreviewRequest, observationRequest, onboardingRequest, plannedSimulationRequest, simulationRequest } from './lifecycle-operations.js';
import { lifecyclePolicyUpdateSchema } from '@syntra/core';
import { describeAdminRoutes } from '../../openapi/describe.js';

/**
 * The OpenAPI description of the routes in `lifecycle-operations.ts`.
 *
 * A lifecycle operation is the durable record of one joiner, mover or leaver
 * change and the case built around it. Several of these routes are the
 * approval and verification gates of that record, so their refusals are
 * spelled out: `409 approval-required`, `409 verification-required`,
 * `403 approval-four-eyes` (the requester may not approve their own work).
 */
export const lifecycleOperationsOpenApi = describeAdminRoutes('Lifecycle operations', {
  'GET /lifecycle-operations/metrics': { summary: 'Read lifecycle operation counts and SLO health' },
  'GET /lifecycle-operations': {
    summary: 'List lifecycle operations',
    query: listQuery,
  },
  'GET /lifecycle-policy': { summary: "Read the tenant's lifecycle policy" },
  'PATCH /lifecycle-policy': {
    summary: "Update the tenant's lifecycle policy",
    description: 'Approval thresholds, SLOs, escalation owner and idempotency retention. Send only the fields to change.',
    body: lifecyclePolicyUpdateSchema,
  },
  'GET /lifecycle-operations/:id': {
    summary: 'Read a lifecycle operation with its steps and case history',
    params: idParams,
  },
  'GET /lifecycle-operations/:id/notifications': {
    summary: 'List the notifications sent for a lifecycle operation',
    params: idParams,
  },
  'POST /lifecycle-operations/:id/acknowledge': {
    summary: 'Acknowledge a lifecycle operation',
    params: idParams,
  },
  'POST /lifecycle-operations/:id/retry': {
    summary: 'Retry the failed steps of a lifecycle operation',
    description:
      'For a target write whose outcome was ambiguous, record an observation first and use `retry-after-verification` instead.',
    params: idParams,
  },
  'POST /lifecycle-operations/:id/case-notes': {
    summary: 'Add a note to a lifecycle case',
    body: caseNoteRequest,
    params: idParams,
    status: 201,
  },
  'POST /lifecycle-operations/:id/resolve': {
    summary: 'Resolve a lifecycle case with a resolution code',
    body: caseResolutionRequest,
    params: idParams,
  },
  'POST /lifecycle-operations/:id/reopen': {
    summary: 'Reopen a resolved lifecycle case',
    body: caseReopenRequest,
    params: idParams,
  },
  'GET /lifecycle-legal-holds': {
    summary: 'List legal holds on lifecycle records',
    description: 'Active holds by default; `active=false` lists released ones. `subjectId` needs `subjectType`.',
    query: legalHoldQuery,
  },
  'POST /lifecycle-legal-holds': {
    summary: 'Place a legal hold on a lifecycle operation or simulation',
    description: 'A held record and its linked evidence are exempt from retention deletion until the hold is released.',
    body: legalHoldRequest,
    status: 201,
  },
  'POST /lifecycle-legal-holds/:id/release': {
    summary: 'Release a legal hold',
    params: idParams,
  },
  'POST /lifecycle-operations/:id/retry-after-verification': {
    summary: 'Retry a lifecycle operation once an unknown outcome has been verified',
    description: 'Refused with `409 verification-required` unless the latest recorded observation is complete and shows the target does not match what was expected.',
    params: idParams,
  },
  'POST /lifecycle-operations/:id/approve': {
    summary: 'Approve a lifecycle operation awaiting approval',
    description: 'Four-eyes: the person who requested the operation cannot approve it (`403 approval-four-eyes`).',
    params: idParams,
  },
  'POST /lifecycle-operations/:id/reject': {
    summary: 'Reject a lifecycle operation awaiting approval',
    body: decisionRequest,
    params: idParams,
  },
  'POST /lifecycle-operations/:id/cancel': {
    summary: 'Cancel a lifecycle operation',
    body: decisionRequest,
    params: idParams,
  },
  'POST /lifecycle-operations/bulk': {
    summary: 'Acknowledge or retry up to 100 lifecycle operations',
    description:
      'Answers with a result per operation; one refusal does not hide the others. When policy requires approval for a bulk retry, nothing is retried: the answer is `202` with `approvalRequired: true` and the id of a new `bulk_retry` operation that a second person approves. The same caller submitting the same set within the same UTC minute gets that same operation back.',
    body: bulkLifecycleRequest,
  },
  'POST /lifecycle-operations/:id/observations': {
    summary: 'Record the observed target state for a lifecycle step',
    description: 'How an unknown or unverified target outcome is settled, including by an operator confirming it by hand.',
    body: observationRequest,
    params: idParams,
  },
  'PATCH /lifecycle-operations/:id/assignment': {
    summary: 'Assign an owner, priority and due date to a lifecycle case',
    body: assignmentRequest,
    params: idParams,
  },
  'POST /persons/:id/mover/preview': {
    summary: "Preview a change to a person's contract and its access consequences",
    description: 'Changes nothing. The answer carries the `revision` the apply request must echo.',
    body: moverPreviewRequest,
    params: idParams,
  },
  'POST /persons/:id/mover/apply': {
    summary: 'Apply a previewed mover change',
    description:
      'Send the preview back. The server recomputes the plan from persisted state and refuses with `409 stale-preview` if the person changed since; presentation fields in the preview are ignored.',
    body: moverApplyRequest,
    params: idParams,
  },
  'POST /lifecycle-operations/simulate': {
    summary: 'Simulate the target actions for a hypothetical account state',
    description: 'Pure computation; nothing is stored or written.',
    body: simulationRequest,
  },
  'POST /lifecycle-simulations': {
    summary: 'Run and store a joiner, mover or leaver simulation for a person or department',
    description: 'Name exactly one of `personId` or `department`. No target is written.',
    body: plannedSimulationRequest,
    status: 201,
  },
  'GET /lifecycle-simulations': { summary: 'List stored lifecycle simulations' },
  'GET /lifecycle-simulations/:id': {
    summary: 'Read a stored lifecycle simulation',
    params: idParams,
  },
  'POST /lifecycle-operations/onboard': {
    summary: 'Onboard a person: create the person, contract, optional login and target work',
    description:
      'IDEMPOTENT on `idempotencyKey`: the first request answers `201`; a repeat with the same key and the same input answers `200` with what the first one created. A key is released only when lifecycle retention deletes its operation.',
    body: onboardingRequest,
    status: 201,
  },
});
