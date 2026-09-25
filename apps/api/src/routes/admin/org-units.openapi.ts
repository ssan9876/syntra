import { createOrgUnitRequest, deactivateOrgUnitRequest, idParam, materialiseOrgUnitRequest, patchOrgUnitRequest } from '@syntra/contracts';
import { targetParam } from './org-units.js';
import { describeAdminRoutes } from '../../openapi/describe.js';

/** The OpenAPI description of the routes in `org-units.ts`. See openapi/describe.ts. */
export const orgUnitsOpenApi = describeAdminRoutes('Organizational units', {
  'GET /org-units': { summary: 'List organizational units' },
  'GET /org-units/:id': { summary: 'Get an organizational unit and its contents', params: idParam },
  'POST /org-units': { summary: 'Create an organizational unit', body: createOrgUnitRequest, status: 201 },
  'POST /org-units/:id/deactivate': {
    summary: 'Deactivate an organizational unit',
    description: 'Deactivation records the reason and can be reversed with reactivate.',
    body: deactivateOrgUnitRequest,
    params: idParam,
  },
  'GET /org-units/:id/containers': {
    summary: "List a unit's containers on target systems",
    params: idParam,
  },
  'POST /org-units/:id/containers': {
    summary: 'Bind a unit to a container on a target system',
    description:
      'Records the binding only. The container itself is created by the next provisioning run, where it can be previewed first.',
    body: materialiseOrgUnitRequest,
    params: idParam,
    status: 201,
  },
  'POST /org-units/:id/containers/:targetSystemId/switch-to-mirrored': {
    summary: "Hand a unit's manually typed container over to the target's org-unit mirror",
    description:
      'Rewrites the binding to the DN derived from the org-unit tree. Nothing is written to the directory: when the target had confirmed the typed DN, the next provisioning run proposes moving that OU, with the accounts in it, and a person confirms it. 409 when the target does not mirror, the unit cannot be derived, or another unit holds the DN.',
    params: idParam.merge(targetParam),
  },
  'DELETE /org-units/:id/containers/:targetSystemId': {
    summary: "Stop tracking a unit's container on a target system",
    description: 'Removes the tracking record only; the container in the target directory is left in place.',
    params: idParam.merge(targetParam),
    status: 204,
  },
  'DELETE /org-units/:id': {
    summary: 'Delete an empty organizational unit',
    description:
      'Refused with 409 while the unit still holds users or child units. Removes the unit from bound directories first.',
    params: idParam,
    status: 204,
  },
  'POST /org-units/:id/reactivate': { summary: 'Reactivate a deactivated organizational unit', params: idParam },
  'PATCH /org-units/:id': {
    summary: 'Rename or move an organizational unit',
    body: patchOrgUnitRequest,
    params: idParam,
  },
});
