import { businessRuleRequestSchema, idParam, ruleParams } from '@syntra/contracts';
import { describeAdminRoutes } from '../../openapi/describe.js';

/** The OpenAPI description of the routes in `rules.ts`. See openapi/describe.ts. */
export const rulesOpenApi = describeAdminRoutes('Provisioning rules', {
  'GET /targets/:id/rules': { summary: "List a target system's business rules", params: idParam },
  'PUT /targets/:id/rules': {
    summary: 'Create or update a business rule on a target system',
    description:
      'An upsert: a body naming an existing rule replaces it. The condition is checked against the closed, depth- and size-bounded condition grammar, so a malformed leaf is a 400 rather than a rule that silently grants nothing.',
    body: businessRuleRequestSchema,
    params: idParam,
  },
  'DELETE /rules/:ruleId': { summary: 'Delete a business rule', params: ruleParams, status: 204 },
  'POST /targets/:id/rules/impact': {
    summary: 'Preview which persons a business rule would match',
    description: 'Evaluates the rule without saving it; nothing is written.',
    body: businessRuleRequestSchema,
    params: idParam,
  },
});
