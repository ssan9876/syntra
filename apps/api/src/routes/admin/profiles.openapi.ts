import { accountProfileRequestSchema, idParam } from '@syntra/contracts';
import { containerPreviewRequest, previewRequest } from './profiles.js';
import { describeAdminRoutes } from '../../openapi/describe.js';

/** The OpenAPI description of the routes in `profiles.ts`. See openapi/describe.ts. */
export const profilesOpenApi = describeAdminRoutes('Account profiles', {
  'GET /targets/:id/profile': {
    summary: "Read a target system's account profile",
    description: 'Answers 404 when the target has no account profile yet.',
    params: idParam,
  },
  'PUT /targets/:id/profile': {
    summary: "Create or replace a target system's account profile",
    description:
      'Templates that reference sensitive person data (such as `person.personalEmail`) are refused unless the request carries a substantive purpose for the disclosure.',
    body: accountProfileRequestSchema,
    params: idParam,
    status: 204,
  },
  'POST /targets/:id/profile/preview': {
    summary: 'Preview the account a profile would render for a person',
    description: 'Renders an unsaved profile against an existing person; nothing is written.',
    body: previewRequest,
    params: idParam,
  },
  'POST /targets/:id/profile/preview-container': {
    summary: 'Preview the container an account would be placed in',
    description:
      'Renders the saved container template against facts typed into a form rather than an existing person. Answers 404 when the target has no account profile.',
    body: containerPreviewRequest,
    params: idParam,
  },
});
