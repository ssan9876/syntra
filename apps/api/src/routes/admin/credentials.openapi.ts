import {
  credentialKeyParam,
  credentialMetadataRequest,
  credentialScanRequest,
  idParam,
  rotationListQuery,
  securityNotificationSettingsRequest,
  stageRotationRequest,
} from '@syntra/contracts';
import { describeAdminRoutes } from '../../openapi/describe.js';

/**
 * The OpenAPI description of the routes in `credentials.ts`. See
 * openapi/describe.ts.
 *
 * The rotation steps carry no route-level guard, so the document lists no
 * permission for them: a rotation needs `provision.manage` for a target and
 * `sync.manage` for a directory source or HR feed, which depends on the
 * system the rotation belongs to and is checked in the handler.
 */
const rotationAuthority =
  'Requires `provision.manage` for a target and `sync.manage` for a directory source or HR feed, checked against the system the rotation belongs to.';

export const credentialsOpenApi = describeAdminRoutes('Credentials', {
  'GET /credentials': {
    summary: 'List the credential inventory',
    description:
      'Every credential Syntra holds, issues or depends on: connector secrets, pinned SFTP host keys, upstream identity provider secrets and certificates, service-provider certificates, signing keys, API tokens, webhook signing secrets and OIDC client secrets. Each entry carries its expiry and where that came from (`certificate`, `issued`, `discovered`, `declared`, `none` or `unknown`), when it was last rotated, its owner, a status against the tenant\'s alert thresholds, and any open rotation. Never a secret.',
  },
  'PATCH /credentials/:key': {
    summary: 'Set a credential\'s owner, declared expiry or note',
    description:
      'A declared expiry is accepted only for connector and upstream client secrets, whose expiry the issuer does not publish to Syntra; a certificate, signing key or token carries its own. Audited as `credential.metadata_updated`.',
    params: credentialKeyParam,
    body: credentialMetadataRequest,
  },
  'POST /credentials/scan': {
    summary: 'Run the credential expiry scan now',
    description:
      'Discovers Entra client-secret expiry where the app registration may read itself (optional `Application.Read.All`; a refusal is remembered for a week unless `forceDiscovery`), then raises each advance alert or expiry alert not yet raised. The same scan runs daily.',
    body: credentialScanRequest,
  },
  'GET /credentials/rotations': {
    summary: 'List credential rotations',
    query: rotationListQuery,
  },
  'GET /credentials/rotations/:id': {
    summary: 'Read one credential rotation and its evidence',
    params: idParam,
  },
  'POST /credentials/rotations': {
    summary: 'Stage a new connector secret for rotation',
    description: `Seals the new secret beside the live one; nothing uses it until cut-over. One open rotation per system. ${rotationAuthority}`,
    body: stageRotationRequest,
    status: 201,
  },
  'POST /credentials/rotations/:id/verify': {
    summary: 'Test the staged secret against the saved configuration',
    description: `Runs the connector's own connection test with the staged secret. Pass or fail, the result is recorded as evidence. ${rotationAuthority}`,
    params: idParam,
  },
  'POST /credentials/rotations/:id/cutover': {
    summary: 'Make the staged secret live and keep the old one for rollback',
    description: `Refused unless the last test passed, is under a day old, and was made against the configuration as it is saved now. ${rotationAuthority}`,
    params: idParam,
  },
  'POST /credentials/rotations/:id/complete': {
    summary: 'Test the live secret again and erase the old one',
    description: `A failed check is recorded and answered 422, and the old secret is kept so the rotation can still be rolled back. ${rotationAuthority}`,
    params: idParam,
  },
  'POST /credentials/rotations/:id/rollback': {
    summary: 'Restore the previous secret after a cut-over',
    params: idParam,
    description: rotationAuthority,
  },
  'POST /credentials/rotations/:id/cancel': {
    summary: 'Abandon a rotation before cut-over',
    params: idParam,
    description: rotationAuthority,
  },
  'GET /security-notifications': {
    summary: 'Read the security notification policy',
    description:
      'The customer-visible security event categories, the audit actions in each, which ones also email `tenant.manage` holders, and the credential expiry alert thresholds.',
  },
  'PUT /security-notifications': {
    summary: 'Choose which security categories email administrators',
    description:
      'Also sets the credential expiry thresholds, in days. Audited as `tenant.security_notifications_updated`.',
    body: securityNotificationSettingsRequest,
  },
});
