import { claimMappingRequest, claimMappingSetRequest, idParam, oidcClientRequest, samlConfigRequest, spMetadataImportRequest } from '@syntra/contracts';
import { applyClaimSetRequest, claimParams } from './protocol-apps.js';
import { describeAdminRoutes } from '../../openapi/describe.js';

/** The OpenAPI description of the routes in `protocol-apps.ts`. See openapi/describe.ts. */
export const protocolAppsOpenApi = describeAdminRoutes('Protocol applications', {
  'PUT /applications/:id/saml': {
    summary: 'Configure an application as a SAML service provider',
    description: 'Establishes the tenant\'s SAML signing key if it has none. An entity ID another application already holds is refused.',
    body: samlConfigRequest,
    params: idParam,
  },
  'GET /applications/:id/saml': { summary: 'Get an application\'s SAML configuration', params: idParam },
  'POST /applications/:id/saml/import': {
    summary: 'Configure SAML from the service provider\'s metadata',
    description: 'Metadata that would weaken the tenant\'s signing posture is refused unless the request explicitly accepts it.',
    body: spMetadataImportRequest,
    params: idParam,
  },
  'PUT /applications/:id/oidc': {
    summary: 'Configure an application as an OpenID Connect client',
    body: oidcClientRequest,
    params: idParam,
  },
  'GET /applications/:id/oidc': { summary: 'Get an application\'s OpenID Connect configuration', params: idParam },
  'GET /claim-sets': { summary: 'List reusable claim mapping sets' },
  'POST /claim-sets': { summary: 'Create a claim mapping set', body: claimMappingSetRequest, status: 201 },
  'DELETE /claim-sets/:id': { summary: 'Delete a claim mapping set', params: idParam, status: 204 },
  'POST /applications/:id/claims/apply-set': {
    summary: 'Apply a claim mapping set to an application',
    description: 'Answers with the mappings it added and those that were already present.',
    body: applyClaimSetRequest,
    params: idParam,
  },
  'GET /applications/:id/claims': { summary: 'List an application\'s claim mappings', params: idParam },
  'POST /applications/:id/claims': {
    summary: 'Add a claim mapping to an application',
    body: claimMappingRequest,
    params: idParam,
    status: 201,
  },
  'DELETE /applications/:id/claims/:claimId': {
    summary: 'Remove a claim mapping from an application',
    params: claimParams,
    status: 204,
  },
});
