import { z } from 'zod';
import { applicationIconRequest, applicationIconView, assignApplicationRequest, assignmentParams, catalogCreateRequest, catalogCreateResponse, createApplicationRequest, deleteApplicationRequest, deleteApplicationResponse, idParam, updateApplicationRequest } from '@syntra/contracts';
import { describeAdminRoutes } from '../../openapi/describe.js';

/** The OpenAPI description of the routes in `applications.ts`. See openapi/describe.ts. */
export const applicationsOpenApi = describeAdminRoutes('Applications', {
  'GET /applications': {
    summary: 'List applications',
    description:
      'Each application carries `icon`: its logo as a same-origin URL (a built-in mark, or an uploaded image served by the API), or null.',
  },
  'GET /catalog': {
    summary: 'List the application catalog',
    description: 'The applications Syntra knows how to configure. Identical for every tenant.',
  },
  'POST /applications/from-catalog': {
    summary: 'Create an application from a catalog entry',
    description: 'Establishes the tenant\'s SAML signing key first when the entry needs one.',
    body: catalogCreateRequest,
    response: catalogCreateResponse,
    status: 201,
  },
  'POST /applications': { summary: 'Create an application', body: createApplicationRequest, status: 201 },
  'PUT /applications/:id': { summary: 'Replace an application', body: updateApplicationRequest, params: idParam },
  'DELETE /applications/:id': {
    summary: 'Delete an application',
    description: [
      'Permanent. Removes the application with its SAML and OIDC configuration (freeing the entity ID, client_id and slug for reuse), claim mappings, assignments and logo,',
      'and revokes what was issued to it: OIDC access and refresh tokens, codes and grants, single-logout sessions and sign-ins in flight. Users lose single sign-on to it immediately.',
      "The tenant's signing keys, users and groups are not touched. `confirm` must be the application's name (`400 confirm-mismatch` otherwise).",
      'Needs a console session elevated within the step-up window (`403 step-up-required` otherwise); API tokens are refused.',
      'Answers `409 application-in-use` while a catalog product grants it or a live access grant holds it. A second delete is `404`.',
      'Setting `status: inactive` (retire) is the reversible alternative.',
    ].join(' '),
    body: deleteApplicationRequest,
    params: idParam,
    response: deleteApplicationResponse,
  },
  'PUT /applications/:id/icon': {
    summary: 'Set or clear the logo of an application',
    description: [
      'A built-in mark by key, an uploaded PNG, JPEG or WebP as a base64 data URI (at most 64 KB decoded), or `null` to clear it.',
      'SVG is refused, and an image whose content does not match its declared type is refused.',
      'Any change also clears the legacy `iconUrl`. The uploaded image is served, to any signed-in session, at `/api/portal/applications/{id}/icon`.',
    ].join(' '),
    body: applicationIconRequest,
    params: idParam,
    response: z.object({ icon: applicationIconView }),
  },
  'GET /applications/:id/assignments': { summary: 'List who is assigned an application', params: idParam },
  'POST /applications/:id/assignments': {
    summary: 'Assign an application to a user or group',
    body: assignApplicationRequest,
    params: idParam,
    status: 201,
  },
  'DELETE /applications/:id/assignments/:assignmentId': {
    summary: 'Remove an application assignment',
    params: assignmentParams,
    status: 204,
  },
});
