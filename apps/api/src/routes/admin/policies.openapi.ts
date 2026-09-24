import { policyDefaultRequest, policyRuleRequest, reorderRulesRequest, ruleImpactResponse, ruleParams } from '@syntra/contracts';
import { describeAdminRoutes } from '../../openapi/describe.js';

/** The OpenAPI description of the routes in `policies.ts`. See openapi/describe.ts. */
export const policiesOpenApi = describeAdminRoutes('Access policies', {
  'GET /policy': { summary: 'Get the access policy: its default and ordered rules' },
  'PUT /policy/default': { summary: 'Replace the default access policy', body: policyDefaultRequest },
  'POST /policy/rules/impact': {
    summary: 'Preview how many people a policy rule would affect',
    description: 'Stores nothing. Rate-limited per address like a credential route, because it can count every user and membership in the tenant.',
    body: policyRuleRequest,
    response: ruleImpactResponse,
  },
  'POST /policy/rules': { summary: 'Create an access policy rule', body: policyRuleRequest, status: 201 },
  'PUT /policy/rules/order': { summary: 'Reorder the access policy rules', body: reorderRulesRequest },
  'PUT /policy/rules/:ruleId': {
    summary: 'Replace an access policy rule',
    body: policyRuleRequest,
    params: ruleParams,
  },
  'DELETE /policy/rules/:ruleId': { summary: 'Delete an access policy rule', params: ruleParams, status: 204 },
});
