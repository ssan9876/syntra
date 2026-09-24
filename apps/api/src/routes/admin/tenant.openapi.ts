import { deletionIdParam, deletionRequestBody } from './tenant.js';
import { brandRequest, tenantSettingsRequest } from '@syntra/contracts';
import { describeAdminRoutes } from '../../openapi/describe.js';

/**
 * The OpenAPI description of the routes in `tenant.ts`. See openapi/describe.ts.
 *
 * The deletion routes are published session-only: a token is refused at every
 * one of them (`TOKEN_DENIED_ROUTES`), and approval and execution also need a
 * freshly stepped-up session, which a token can never be.
 */
export const tenantOpenApi = describeAdminRoutes('Tenant', {
  'GET /tenant': { summary: 'Get the tenant\'s settings' },
  'POST /tenant/offboarding/assess': {
    summary: 'Assess whether the tenant is ready to be offboarded',
    description: 'Inventories the tenant\'s records and refuses readiness while a legal hold or unresolved lifecycle work exists. The assessment is bound to a SHA-256 digest and recorded as an audit receipt.',
  },
  'POST /tenant/offboarding/export': {
    summary: 'Download the tenant\'s portable data export',
    description: 'A versioned JSON document, served as an attachment. Its SHA-256 digest is repeated in the `X-Syntra-Export-Digest` header. Secrets, credentials and tokens are excluded by construction.',
  },
  'GET /tenant/deletion': {
    summary: 'Get the current tenant deletion request and the deletion policy',
  },
  'POST /tenant/deletion/requests': {
    summary: 'Request deletion of the tenant',
    description: 'Names a current offboarding assessment and a later export by digest; refused as stale if the tenant\'s data has changed since either.',
    body: deletionRequestBody,
  },
  'POST /tenant/deletion/requests/:id/approve': {
    summary: 'Approve a tenant deletion request',
    description: 'Four-eyes: the approver must be a different administrator, using a recently stepped-up session, within the approval window.',
    params: deletionIdParam,
  },
  'POST /tenant/deletion/requests/:id/cancel': {
    summary: 'Cancel a tenant deletion request',
    params: deletionIdParam,
  },
  'POST /tenant/deletion/requests/:id/execute': {
    summary: 'Execute an approved tenant deletion',
    description: 'Irreversible. Only after the cooling-off period and within the execution window, from a recently stepped-up session. The response carries the completion receipt, and is the only copy handed out.',
    params: deletionIdParam,
  },
  'GET /tenant/brand': { summary: 'Get the tenant\'s branding' },
  'PUT /tenant/brand': { summary: 'Replace the tenant\'s branding', body: brandRequest },
  'PUT /tenant': {
    summary: 'Replace the tenant\'s settings',
    description: 'Includes session lifetimes and whether console access demands a security key; enabling that is refused unless the caller\'s own session was established with one.',
    body: tenantSettingsRequest,
  },
});
