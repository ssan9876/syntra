import { describeAdminRoutes } from '../../openapi/describe.js';

/** The OpenAPI description of the routes in `incidents.ts`. See openapi/describe.ts. */
export const incidentsOpenApi = describeAdminRoutes('Incidents', {
  'GET /incidents': {
    summary: 'List current operational incidents',
    description:
      'Derived on each request from the tenant\'s failing work. Each incident carries up to ten `items` -- the run, delivery, target or credential behind it, with its stored error scrubbed of credentials, addresses and DNs -- whether it is `resolvable`, and its current `acknowledged` state (null once something newer has happened).',
  },
  'POST /incidents/:kind/acknowledge': {
    summary: 'Acknowledge an incident',
    description:
      'Marks the incident kind as being handled, with an optional `note` (up to 500 characters). Hides nothing: the incident stays listed, and the acknowledgement lapses when something newer happens. Needs `audit.read`. Audited as `incident.acknowledged`.',
    status: 204,
  },
  'POST /incidents/:kind/resolve': {
    summary: 'Resolve an event incident',
    description:
      'For event kinds only (failed provisioning or sync runs, undelivered webhooks or mail, failed delegated tasks): what happened up to now is dealt with, and only newer events are counted. A condition kind answers `409 incident-not-resolvable`. Needs the management permission of the area (`provision.manage`, `sync.manage`, `tenant.manage` or `automate.manage`). Audited as `incident.resolved`.',
    status: 204,
  },
  'GET /attention/summary': {
    summary: 'Summarise work waiting for a person',
    description:
      'Counts and the oldest items of work that needs a decision: provisioning runs held for review (`previewed` or `blocked`, with the target, the run and the guard\'s reason), held actions per target (changes in the target\'s latest finished run that need a confirmation and have no standing approval), lifecycle operations that failed or are waiting on read-back verification, and pending privileged change requests. ' +
      'Any signed-in administrator may call it; each section is read only when the caller may read what it lists (`provision.read` for runs, held actions and lifecycle work; `tenant.manage`, `rbac.manage` or `token.manage` for change requests) and is `null` otherwise. ' +
      'Items are capped at 10 per section; counts are totals. Nothing is stored or acknowledged: an item disappears when the work behind it is done.',
  },
});
