import { statusPageQuery } from './list-query.js';
import { adminFactorParams, createUserRequest, deactivateUserRequest, idParam, patchUserDetailsRequest, patchUserRequest, setUserPasswordRequest } from '@syntra/contracts';
import { describeAdminRoutes } from '../../openapi/describe.js';

/**
 * The OpenAPI description of the routes in `users.ts`. See openapi/describe.ts.
 *
 * The two password routes are published even though a token is refused at
 * both (`TOKEN_DENIED_ROUTES`): the document marks them session-only, which
 * tells an integrator the capability exists and that it is deliberately a
 * person's to exercise.
 */
export const usersOpenApi = describeAdminRoutes('Users', {
  'GET /users': { summary: 'List user accounts', query: statusPageQuery },
  'GET /directory/summary': {
    summary: 'Count people, accounts and groups for the directory overview',
    description: 'Counts are over the whole tenant, not one page. Needs both halves of the directory, hence both permissions.',
  },
  'GET /groups/summary': { summary: 'Count groups by origin and status' },
  'GET /users/unlinked': {
    summary: 'List active accounts linked to no person, with the likeliest match',
  },
  'GET /users/:id/person-candidates': {
    summary: 'Suggest the people an account might belong to',
    description: 'An account that already has a person answers with an empty list rather than a conflict.',
    params: idParam,
  },
  'GET /users/:id': { summary: 'Get a user account', params: idParam },
  'POST /users': {
    summary: 'Create a user account',
    description: 'Creating a second account for a person who already signs in is refused unless `allowSecondAccount` is set.',
    body: createUserRequest,
    status: 201,
  },
  'POST /users/:id/deactivate': {
    summary: 'Deactivate a user account',
    description: 'Revokes every session and refresh token the account holds.',
    body: deactivateUserRequest,
    params: idParam,
  },
  'POST /users/:id/reactivate': {
    summary: 'Reactivate a user account',
    description: 'Restores the ability to sign in; sessions ended by deactivation stay ended.',
    params: idParam,
  },
  'POST /users/:id/unlock': {
    summary: 'Lift an account lockout',
    description: 'Idempotent: unlocking an account that is not locked succeeds.',
    params: idParam,
  },
  'DELETE /users/:id': {
    summary: 'Delete a user account permanently',
    description: 'Irreversible, unlike deactivation. The linked person and the audit trail survive it.',
    params: idParam,
    status: 204,
  },
  'PATCH /users/:id': {
    summary: 'Set where a user account\'s password is held',
    body: patchUserRequest,
    params: idParam,
  },
  'POST /users/:id/password-setup': {
    summary: 'Issue a password-setup link for an account',
    description: 'The link is returned, not mailed, and expires after 24 hours. It is a bearer credential: hand it over through a trusted channel.',
    params: idParam,
  },
  'DELETE /users/:id/factors/:type': {
    summary: 'Remove an authentication factor from an account',
    description: "The response says whether the account's recovery codes were revoked with it, which happens when no factor remains to use them with.",
    params: adminFactorParams,
  },
  'PATCH /users/:id/details': {
    summary: 'Edit an account\'s name, email and organizational unit',
    description: 'Refused for an account a directory source owns, whose next sync would overwrite the change.',
    body: patchUserDetailsRequest,
    params: idParam,
  },
  'POST /users/:id/password': {
    summary: 'Set a user\'s password on their behalf',
    description: 'Ends the user\'s sessions and requires a change at next sign-in. Refused for an account whose password lives in a synced directory.',
    body: setUserPasswordRequest,
    params: idParam,
  },
});
