import { describeAdminRoutes } from '../../openapi/describe.js';
import { emailDomainRequest } from './email-domains.js';

/** The OpenAPI description of the routes in `email-domains.ts`. See openapi/describe.ts. */
export const emailDomainsOpenApi = describeAdminRoutes('Email domains', {
  'GET /email-domains': {
    summary: 'List email domains',
    description:
      'Every domain added to the tenant, verified or not, with the exact TXT `record` to publish at its apex. Only a verified domain, or a subdomain of one, may appear in an address Syntra writes: a business email entered by hand, an account name or `mail` a profile generates, an Entra ID userPrincipalName.',
  },
  'POST /email-domains': {
    summary: 'Add an email domain',
    description:
      'Adds the domain unverified and returns the TXT record that proves control of it. An internationalised name is stored as punycode. `400 invalid-domain` for something that is not a domain name, `409 duplicate-domain` when it is already added. Audited as `tenant.email_domain.added`.',
    body: emailDomainRequest,
    status: 201,
  },
  'POST /email-domains/:id/verify': {
    summary: 'Check an email domain for its verification record',
    description:
      'Looks up the TXT records at the domain\'s apex. With the record present the domain is verified from now on; without it, `lastCheckError` says what was found. A domain already verified is returned unchanged. Audited as `tenant.email_domain.verified` or `tenant.email_domain.verification_failed`.',
  },
  'DELETE /email-domains/:id': {
    summary: 'Remove an email domain',
    description:
      'Addresses in the domain are refused from then on, and provisioning makes people whose addresses are in it unprocessable on the targets that would write them. Audited as `tenant.email_domain.removed`.',
    status: 204,
  },
});
