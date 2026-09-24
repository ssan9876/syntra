import { describeAdminRoutes } from '../../openapi/describe.js';
import {
  closePrivacyCaseRequest,
  openPrivacyCaseRequest,
  privacyAccessBundleRequest,
  privacyCaseListQuery,
  privacyCaseParams,
} from './privacy.js';

/**
 * The OpenAPI description of the routes in `privacy.ts`. See openapi/describe.ts.
 *
 * Every route needs `privacy.manage`. The erasure routes are published
 * session-only: a token is refused at every one of them
 * (`TOKEN_DENIED_ROUTES`), and approval also needs a freshly stepped-up
 * session, which a token can never be.
 */
export const privacyOpenApi = describeAdminRoutes('Privacy', {
  'GET /privacy/cases': {
    summary: 'List data-subject request cases',
    description: 'Open cases first, soonest due first; each carries the person\'s current (possibly pseudonymised) name and whether it is overdue.',
    query: privacyCaseListQuery,
  },
  'POST /privacy/cases': {
    summary: 'Open a data-subject request case',
    description:
      'For one person: what they asked for (access, rectification, restriction, erasure), the reason, how the requester\'s identity was verified, and when it was received. Due 30 days after receipt unless `dueInDays` says otherwise (at most 90). Allocates a reference such as DSAR-2026-0007. Audited as `privacy.case.open`.',
    body: openPrivacyCaseRequest,
    status: 201,
  },
  'GET /privacy/cases/:id': {
    summary: 'Read a case, its timeline and what the tenant holds about the person',
    description:
      'The timeline is the audit log: every event whose target is the case, plus the export service\'s events for the access bundles it queued. `holdings` counts rows per table the data inventory links to the person; `erasureBlockers` lists what would refuse an erasure now.',
    params: privacyCaseParams,
  },
  'GET /privacy/cases/:id/subject-data': {
    summary: 'Search everything linked to the person',
    description:
      'Every table the data inventory links to people, found through the columns it names: the person, contracts, accounts, credentials (metadata only), sessions, target accounts, entitlements, requests and approvals, lifecycle work, run history and audit events by or about them. Returns a page of rows per table with the full count. Credential material is never returned. Audited as `privacy.case.search`.',
    params: privacyCaseParams,
  },
  'POST /privacy/cases/:id/access-bundle': {
    summary: 'Queue the person\'s access bundle',
    description:
      'Answers 202 with the queued export (kind `dsar_bundle`). A background job builds one JSON document from the data inventory -- each table\'s rows with its purpose, source, retention and legal basis -- watermarks it with the export, case, requester and time, seals it at rest and hands it only to the requester through `GET /exports/:id/download`.',
    params: privacyCaseParams,
    body: privacyAccessBundleRequest,
    status: 202,
  },
  'POST /privacy/cases/:id/restriction': {
    summary: 'Restrict processing of the person',
    description:
      'While restricted, provisioning withholds every action that writes the person\'s data or widens their access (visible on the plan as refused, naming the case), and HR imports and directory sync skip such changes. Disable, archive, revoke and deactivate still run.',
    params: privacyCaseParams,
  },
  'POST /privacy/cases/:id/restriction/lift': {
    summary: 'Lift the restriction',
    description: 'Refused for an erased person, who stays restricted so a source that still holds them cannot write them back.',
    params: privacyCaseParams,
  },
  'POST /privacy/cases/:id/erasure/request': {
    summary: 'Request erasure of the person',
    description:
      'Refused while a legal hold covers the person or their lifecycle work, while lifecycle work or provisioning is unresolved, while the person is active, or while any account or access grant is live; the refusal lists each blocker. One erasure awaiting approval per person.',
    params: privacyCaseParams,
  },
  'POST /privacy/cases/:id/erasure/approve': {
    summary: 'Approve and perform the erasure',
    description:
      'Four-eyes: a different administrator than the requester, from a recently stepped-up session. Every blocker is re-checked in the transaction that erases. Personal fields are pseudonymised in place, credential material deleted and the audit log retained, exactly as the data inventory says; the response and the case carry the receipt.',
    params: privacyCaseParams,
  },
  'POST /privacy/cases/:id/erasure/cancel': {
    summary: 'Cancel a pending erasure',
    params: privacyCaseParams,
  },
  'POST /privacy/cases/:id/close': {
    summary: 'Close a case',
    description: 'Refused while an erasure awaits approval.',
    params: privacyCaseParams,
    body: closePrivacyCaseRequest,
  },
});
