import { z } from 'zod';
import {
  adoptAccountRequest,
  containerListResponse,
  createTargetRequestSchema,
  idParam,
  movePlacementRequest,
  orgUnitMirrorPreviewQuery,
  placementResponse,
  testTargetRequestSchema,
  updateTargetRequestSchema,
} from '@syntra/contracts';
import {
  adapterReasonRequest,
  adapterSelectionRequest,
  deprecationOverrideRequest,
  entitlementSearchQuery,
  nativeEntraMigrationRequest,
  placementParams,
  targetHealthQuery,
  writeResumeRequest,
  writeStopRequest,
} from './targets.js';
import { confirmQuery } from './list-query.js';
import { describeAdminRoutes } from '../../openapi/describe.js';

const WRITE_STOP =
  'While a stop is active no connector write is attempted; reads, previews and evidence stay available. `expiresAt` may be at most 30 days away.';
const FOUR_EYES_RESUME =
  'Four-eyes: the administrator who paused writes cannot resume them (403 `four-eyes-required`). A recorded reason is required.';

/** The OpenAPI description of the routes in `targets.ts`. See openapi/describe.ts. */
export const targetsOpenApi = describeAdminRoutes('Target systems', {
  'GET /targets': { summary: 'List target systems' },
  'GET /targets/connector-documents': {
    summary: 'List the built-in HTTP connector documents',
    description: 'Constants shipped with the product; placeholders in them such as `{clientId}` are for the administrator to replace.',
  },
  'GET /targets/:id/containers': {
    summary: 'List the containers a target system holds',
    description: 'A live read through the connector; an unreachable target answers 502 `target-unreachable`.',
    params: idParam,
    response: containerListResponse,
  },
  'GET /targets/:id/org-unit-mirror': {
    summary: 'Preview the org-unit tree as this target would mirror it',
    description:
      'Every org unit with the DN mirroring derives for it, the container row that exists and which one wins, and why a unit cannot be mirrored (a name over 64 characters, two units deriving one DN). Local: the directory is not read. `rootDn` previews an unsaved root.',
    params: idParam,
    query: orgUnitMirrorPreviewQuery,
  },
  'GET /targets/:id/placements/:personId': {
    summary: "Read a person's manual account placement on a target system",
    description: '`placement` is null when the person follows the placement rule.',
    params: placementParams,
    response: z.object({ placement: placementResponse.nullable() }),
  },
  'PUT /targets/:id/placements/:personId': {
    summary: "Move a person's account to a container and keep it there",
    description:
      'Records a placement that overrides the placement rule, then moves the account. A failed directory write still answers 200 with `moved: false`: the placement stands and the next run retries. An active write stop answers 409 `external-writes-paused` after the placement is recorded.',
    body: movePlacementRequest,
    params: placementParams,
  },
  'GET /targets/:id/accounts/:personId/adoption-candidate': {
    summary: 'Find the existing target object a conflicted account would adopt',
    description: 'Opens a connection to the target, which is why it needs the manage permission despite being a read.',
    params: placementParams,
  },
  'POST /targets/:id/accounts/:personId/adopt': {
    summary: 'Adopt an existing target object for a conflicted account',
    description: 'Binds the account that collided on create to the object that caused the collision. A recorded reason is required.',
    body: adoptAccountRequest,
    params: placementParams,
  },
  'DELETE /targets/:id/placements/:personId': {
    summary: "Clear a person's manual account placement",
    description: 'No account is moved here; the next run proposes the move back to the rule-computed container.',
    params: placementParams,
    status: 204,
  },
  'GET /targets/:id': { summary: 'Read a target system', params: idParam },
  'POST /targets': { summary: 'Create a target system', body: createTargetRequestSchema, status: 201 },
  'PATCH /targets/:id': {
    summary: 'Update a target system',
    body: updateTargetRequestSchema,
    params: idParam,
    status: 204,
  },
  'GET /targets/:id/capabilities': {
    summary: "Read a target system's capabilities and connector lifecycle metadata",
    params: idParam,
  },
  'GET /targets/:id/migrations/native-entra/preview': {
    summary: 'Preview migrating a document-driven Entra target to the native connector',
    description: 'Nothing is written. The preview carries the `revision` the apply must quote.',
    params: idParam,
  },
  'POST /targets/:id/migrations/native-entra/apply': {
    summary: 'Migrate a document-driven Entra target to the native connector',
    description:
      'Applies the migration the preview described. A target changed since the preview answers 409 `preview-stale`; one that cannot migrate answers 409 `migration-not-available`.',
    body: nativeEntraMigrationRequest,
    params: idParam,
  },
  'GET /targets/:id/entitlements/search': {
    summary: "Search a target system's entitlements",
    description:
      'Live against Microsoft Graph for an Entra target (`source: "live"`), against the stored catalog otherwise (`source: "catalog"`).',
    query: entitlementSearchQuery,
    params: idParam,
  },
  'DELETE /targets/:id': {
    summary: 'Delete a target system',
    description:
      'A target that still holds accounts answers 409 `target-not-empty` with the counts unless `?confirm=true` is sent. Only Syntra\'s records are removed; the accounts in the target are never touched.',
    query: confirmQuery,
    params: idParam,
    status: 204,
  },
  'POST /targets/test': {
    summary: 'Test a target system configuration before saving it',
    description:
      'Opens a connection to the named host; a failed connection is reported in the response, not as an error. Rate limited per tenant and address (`AUTH_RATE_LIMIT_MAX` per minute, default 10).',
    body: testTargetRequestSchema,
  },
  'GET /targets/:id/readiness': { summary: "Read a target system's current readiness evidence", params: idParam },
  'GET /targets/:id/health-series': {
    summary: "Read a target system's daily connector health history",
    query: targetHealthQuery,
    params: idParam,
  },
  'POST /targets/:id/external-write-stop': {
    summary: 'Pause all external writes to one target system',
    description: WRITE_STOP,
    body: writeStopRequest,
    params: idParam,
  },
  'POST /targets/:id/external-write-resume': {
    summary: 'Resume external writes to one target system',
    description: FOUR_EYES_RESUME,
    body: writeResumeRequest,
    params: idParam,
  },
  'GET /provision/external-write-stop': { summary: 'Read the tenant-wide external-write stop' },
  'POST /provision/external-write-stop': {
    summary: 'Pause external writes to every target system',
    description: WRITE_STOP,
    body: writeStopRequest,
  },
  'POST /provision/external-write-resume': {
    summary: 'Resume external writes tenant-wide',
    description: FOUR_EYES_RESUME,
    body: writeResumeRequest,
  },
  'GET /targets/:id/adapter': {
    summary: 'Read the adapter release a target system runs',
    description: 'The selected channel or pinned release, what that release is certified for, which writes the configuration refuses, and any deprecation or certification warning.',
    params: idParam,
  },
  'PUT /targets/:id/adapter': {
    summary: 'Move a target system between rollout channels or pin a certified release',
    description: 'Refuses an unknown or uncertified release. The release left behind is recorded as the rollback point, and a run previewed under it refuses to apply (409 `adapter-version-changed`).',
    body: adapterSelectionRequest,
    params: idParam,
  },
  'POST /targets/:id/adapter/rollback': {
    summary: 'Roll a target system back to its last certified adapter release',
    description: 'Changes only the release selection; configuration, profile, rules, placements and accounts are untouched.',
    body: adapterReasonRequest,
    params: idParam,
  },
  'POST /targets/:id/adapter/deprecation-override': {
    summary: 'Allow writes through a deprecated adapter release for a bounded time',
    description: 'Bound to one release, with a reason, for at most 30 days.',
    body: deprecationOverrideRequest,
    params: idParam,
  },
  'POST /targets/:id/adapter/deprecation-override/clear': {
    summary: 'End a deprecation override early',
    body: adapterReasonRequest,
    params: idParam,
  },
  'POST /targets/:id/entitlements/refresh': {
    summary: "Refresh a target system's stored entitlement catalog",
    description: 'Reads the entitlements from the target and replaces the stored catalog.',
    params: idParam,
  },
  'GET /targets/:id/entitlements': { summary: "List a target system's stored entitlements", params: idParam },
});
