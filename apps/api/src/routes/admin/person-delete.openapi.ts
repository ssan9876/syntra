import { deletePersonRequest, idParam } from '@syntra/contracts';
import { describeAdminRoutes } from '../../openapi/describe.js';

/** The OpenAPI description of the route in `person-delete.ts`. See openapi/describe.ts. */
export const personDeleteOpenApi = describeAdminRoutes('Persons', {
  'DELETE /persons/:id': {
    summary: 'Delete a person permanently',
    description: [
      'Requires `person.purge`, held only through the built-in Data deletion role.',
      'Deletes the person with their contracts, placements, provision receipts, source links, lifecycle operations, duplicate reviews, closed privacy cases, provision exceptions and target account records.',
      'Accounts in target systems are not touched. Linked user accounts are unlinked and deactivated, not deleted.',
      "`confirm` must be the person's full name (`400 confirm-mismatch` otherwise); `reason` needs at least 10 characters.",
      'Answers `409 person-active` for an active person and `409 open-privacy-case` while a privacy case is open.',
      'Needs a console session elevated within the step-up window (`403 step-up-required` otherwise); API tokens are refused.',
    ].join(' '),
    body: deletePersonRequest,
    params: idParam,
    status: 204,
  },
});
