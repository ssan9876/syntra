import { acceptHostKeyRequest, applyImportRunRequest, cancelRunRequest, createPersonSourceRequest, idParam, resolveDuplicateReviewRequest, setPersonMappingsRequest, unlinkPersonSourceRequest, updatePersonSourceRequest } from '@syntra/contracts';
import { confirmQuery, sourceIdQuery } from './list-query.js';
import {
  createReferenceValueRequest,
  duplicateReviewListQuery,
  referenceValueListQuery,
  setReferenceValueActiveRequest,
  sourceLinkListQuery,
} from './person-sources.js';
import { describeAdminRoutes } from '../../openapi/describe.js';

/** The OpenAPI description of the routes in `person-sources.ts`. See openapi/describe.ts. */
export const personSourcesOpenApi = describeAdminRoutes('HR sources', {
  'GET /identity-reference-values': {
    summary: 'List governed department and location values',
    query: referenceValueListQuery,
  },
  'POST /identity-reference-values': {
    summary: 'Add a governed department or location value',
    description:
      'Once a kind has at least one active value, HR import rows naming a value outside the list are withheld for review rather than applied.',
    body: createReferenceValueRequest,
    status: 201,
  },
  'PATCH /identity-reference-values/:id': {
    summary: 'Enable or disable a governed reference value',
    body: setReferenceValueActiveRequest,
    params: idParam,
  },
  'GET /person-duplicate-reviews': {
    summary: 'List duplicate-person reviews raised by HR imports',
    query: duplicateReviewListQuery,
  },
  'POST /person-duplicate-reviews/:id/resolve': {
    summary: 'Resolve a duplicate-person review',
    description:
      'Keep the records separate, skip the incoming source record, or link it to the existing person. No resolution merges or deletes a person.',
    body: resolveDuplicateReviewRequest,
    params: idParam,
  },
  'GET /person-source-links': {
    summary: 'List links between persons and HR source records',
    query: sourceLinkListQuery,
  },
  'DELETE /person-source-links/:id': {
    summary: 'Remove a link between a person and an HR source record',
    description: 'Requires a recorded reason in the body. Both the person and their contracts are kept.',
    body: unlinkPersonSourceRequest,
    params: idParam,
  },
  'GET /person-sources': { summary: 'List HR sources' },
  'GET /person-sources/mapping-defaults': {
    summary: 'Read the person and contract fields an HR mapping may write',
  },
  'GET /person-sources/:id': { summary: 'Read an HR source and how many persons it owns', params: idParam },
  'POST /person-sources': { summary: 'Create an HR source', body: createPersonSourceRequest, status: 201 },
  'PATCH /person-sources/:id': { summary: 'Update an HR source', body: updatePersonSourceRequest, params: idParam },
  'DELETE /person-sources/:id': {
    summary: 'Delete an HR source',
    description:
      'A source that still owns persons answers 409 `source-owns-people` unless `?confirm=true` is sent, which releases them. Answers with what was released.',
    query: confirmQuery,
    params: idParam,
  },
  'POST /person-sources/:id/test': {
    summary: 'Test the connection of a saved HR source',
    description:
      'Uses the saved configuration only. For an SFTP source the answer includes the host key the server presented, for pinning with the host-key operation.',
    params: idParam,
  },
  'POST /person-sources/:id/host-key': {
    summary: "Pin the SFTP host key an HR source's server presented",
    description:
      'Send back the fingerprint the connection test reported, so the key pinned is the one that was shown. Replacing an already pinned, different key is refused; clear the pin by editing the source instead.',
    body: acceptHostKeyRequest,
    params: idParam,
  },
  'GET /person-sources/:id/mappings': { summary: "Read an HR source's field mappings", params: idParam },
  'PUT /person-sources/:id/mappings': {
    summary: "Replace an HR source's field mappings",
    body: setPersonMappingsRequest,
    params: idParam,
  },
  'POST /person-sources/:id/run': {
    summary: 'Start an HR import run now',
    description:
      'Queues a background run and answers 202 with the run record; follow it with `GET /api/admin/person-import-runs/{id}`. Answers 503 when the job scheduler is not running.',
    params: idParam,
    status: 202,
  },
  'GET /person-import-runs': { summary: 'List HR import runs, optionally for one source', query: sourceIdQuery },
  'GET /person-import-runs/:id': { summary: 'Read an HR import run and its proposed changes', params: idParam },
  'POST /person-import-runs/:id/apply': {
    summary: 'Apply the proposed changes of an HR import run',
    description:
      'Applies every proposed change, or only those named in `only`. A run whose change volume tripped the safety threshold answers 409 `run-blocked` until it is applied with `confirm: true`.',
    body: applyImportRunRequest,
    params: idParam,
  },
  'POST /person-import-runs/:id/cancel': {
    summary: 'Cancel an HR import run',
    description:
      'A queued or review-pending run is cancelled at once and its open duplicate reviews closed. A run reading the file or applying changes stops at its next checkpoint, between two changes, so the answer may be `requested`.',
    body: cancelRunRequest,
    params: idParam,
  },
  'POST /person-import-runs/:runId/changes/:id/skip': {
    summary: 'Skip one proposed change of an HR import run',
  },
});
