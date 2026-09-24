import { contractParams, createContractRequest, createPersonRequest, deactivatePersonRequest, idParam, importRequest, linkUserRequest, patchContractRequest, patchPersonRequest } from '@syntra/contracts';
import { statusPageQuery } from './list-query.js';
import { describeAdminRoutes } from '../../openapi/describe.js';

/** The OpenAPI description of the routes in `persons.ts`. See openapi/describe.ts. */
export const personsOpenApi = describeAdminRoutes('Persons', {
  'POST /persons/:id/deactivate': {
    summary: 'Deactivate a person',
    description:
      "Deactivates the person record only; the person's user accounts are left alone and are deactivated separately.",
    body: deactivatePersonRequest,
    params: idParam,
  },
  'POST /persons/:id/reactivate': { summary: 'Reactivate a deactivated person', params: idParam },
  'GET /persons': {
    summary: 'List persons',
    description: 'The private `personalEmail` field is omitted unless the caller also holds `identity.sensitive.read`.',
    query: statusPageQuery,
  },
  'GET /persons/:id': {
    summary: 'Get a person',
    description: 'The private `personalEmail` field is omitted unless the caller also holds `identity.sensitive.read`.',
    params: idParam,
  },
  'GET /persons/:id/access': {
    summary: "Explain a person's access in every target system",
    params: idParam,
  },
  'POST /persons': { summary: 'Create a person', body: createPersonRequest, status: 201 },
  'POST /persons/:id/contracts': {
    summary: 'Add a contract to a person',
    body: createContractRequest,
    params: idParam,
    status: 201,
  },
  'POST /persons/:id/link-user': {
    summary: 'Link a user account to a person',
    body: linkUserRequest,
    params: idParam,
    status: 204,
  },
  'POST /persons/import': {
    summary: 'Import persons from CSV',
    description:
      'The CSV travels as a string in the JSON body. A file with no usable rows is refused with a `csv-invalid` problem listing the row errors; rows naming a person owned by an HR source are refused rather than applied.',
    body: importRequest,
  },
  'PATCH /persons/:id': {
    summary: 'Update a person',
    description:
      'For a source-owned person, fields the source maps are refused, because the next import would revert them.',
    body: patchPersonRequest,
    params: idParam,
  },
  'PATCH /persons/:id/contracts/:sequence': {
    summary: "Update one of a person's contracts",
    body: patchContractRequest,
    params: contractParams,
  },
});
