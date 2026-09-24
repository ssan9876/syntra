import {
  breakGlassAccountBody,
  breakGlassActivationParams,
  breakGlassReviewBody,
  breakGlassSettingsBody,
  breakGlassUserParams,
} from './break-glass.js';
import { describeAdminRoutes } from '../../openapi/describe.js';

/**
 * The OpenAPI description of the routes in `break-glass.ts`. Published
 * session-only (`TOKEN_DENIED_ROUTES`). Requesting an activation is not an
 * administration route: it is `POST /api/auth/break-glass/activate`,
 * unauthenticated by nature.
 */
export const breakGlassOpenApi = describeAdminRoutes('Break-glass', {
  'GET /break-glass/status': {
    summary: 'Get the break-glass state every console banner shows',
    description: 'Pending and active emergency activations and the number of post-event reviews outstanding. Open to every administrative session.',
  },
  'GET /break-glass': { summary: 'Get emergency accounts, recent activations and the activation delay' },
  'PUT /break-glass/settings': {
    summary: 'Set how long an emergency activation waits before taking effect',
    description: 'Fifteen minutes to 24 hours. Needs a console session stepped up in the last ten minutes.',
    body: breakGlassSettingsBody,
  },
  'POST /break-glass/accounts': {
    summary: 'Designate an emergency (break-glass) account',
    description: 'Never your own account, and only one that signs in with a local password. The response carries the sealed recovery credential, returned once and stored only as a digest: keep it offline. Needs a stepped-up session.',
    body: breakGlassAccountBody,
    status: 201,
  },
  'POST /break-glass/accounts/:userId/rotate': {
    summary: 'Issue a new sealed credential for an emergency account',
    description: 'The previous credential stops working at once. Refused while an activation is open, and for your own account.',
    params: breakGlassUserParams,
  },
  'DELETE /break-glass/accounts/:userId': {
    summary: 'Stop an account being an emergency account',
    params: breakGlassUserParams,
    status: 204,
  },
  'POST /break-glass/activations/:id/approve': {
    summary: 'Approve a pending emergency activation early',
    description: 'Four-eyes: never the emergency account itself, from a stepped-up session. Takes effect at once and mails every tenant.manage holder.',
    params: breakGlassActivationParams,
  },
  'POST /break-glass/activations/:id/end': {
    summary: 'Cancel a pending emergency activation, or end an active one',
    description: 'Ending an active one ends its sessions at their next request and makes the post-event review due.',
    params: breakGlassActivationParams,
  },
  'POST /break-glass/activations/:id/review': {
    summary: 'Complete the post-event review of an emergency activation',
    description: 'Never by the emergency account itself, with written findings, from a stepped-up session.',
    params: breakGlassActivationParams,
    body: breakGlassReviewBody,
  },
});
