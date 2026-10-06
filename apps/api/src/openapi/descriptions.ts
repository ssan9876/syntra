import type { DescribedRoute } from './describe.js';
import { applicationsOpenApi } from '../routes/admin/applications.openapi.js';
import { auditOpenApi } from '../routes/admin/audit.openapi.js';
import { breakGlassOpenApi } from '../routes/admin/break-glass.openapi.js';
import { changeControlOpenApi } from '../routes/admin/change-control.openapi.js';
import { exportsOpenApi } from '../routes/admin/exports.openapi.js';
import { credentialsOpenApi } from '../routes/admin/credentials.openapi.js';
import { credentialPickupsOpenApi } from '../routes/admin/credential-pickups.openapi.js';
import { credentialPickupOpenApi } from '../routes/credential-pickup.openapi.js';
import { setupOpenApi } from '../routes/setup.openapi.js';
import { automateOpenApi } from '../routes/admin/automate.openapi.js';
import { employeeLifecycleOpenApi } from '../routes/admin/employee-lifecycle.openapi.js';
import { governOpenApi } from '../routes/admin/govern.openapi.js';
import { groupsOpenApi } from '../routes/admin/groups.openapi.js';
import { incidentsOpenApi } from '../routes/admin/incidents.openapi.js';
import { emailDomainsOpenApi } from '../routes/admin/email-domains.openapi.js';
import { lifecycleOperationsOpenApi } from '../routes/admin/lifecycle-operations.openapi.js';
import { mailOpenApi } from '../routes/admin/mail.openapi.js';
import { operationsOpenApi } from '../routes/admin/operations.openapi.js';
import { orgUnitsOpenApi } from '../routes/admin/org-units.openapi.js';
import { personReceiptsOpenApi } from '../routes/admin/person-receipts.openapi.js';
import { personSourcesOpenApi } from '../routes/admin/person-sources.openapi.js';
import { personsOpenApi } from '../routes/admin/persons.openapi.js';
import { personDeleteOpenApi } from '../routes/admin/person-delete.openapi.js';
import { privacyOpenApi } from '../routes/admin/privacy.openapi.js';
import { policiesOpenApi } from '../routes/admin/policies.openapi.js';
import { profilesOpenApi } from '../routes/admin/profiles.openapi.js';
import { protocolAppsOpenApi } from '../routes/admin/protocol-apps.openapi.js';
import { provisionRunsOpenApi } from '../routes/admin/provision-runs.openapi.js';
import { restoreHoldOpenApi } from '../routes/admin/restore-hold.openapi.js';
import { rolesOpenApi } from '../routes/admin/roles.openapi.js';
import { rulesOpenApi } from '../routes/admin/rules.openapi.js';
import { sessionsOpenApi } from '../routes/admin/sessions.openapi.js';
import { sourcesOpenApi } from '../routes/admin/sources.openapi.js';
import { syncRunsOpenApi } from '../routes/admin/sync-runs.openapi.js';
import { targetsOpenApi } from '../routes/admin/targets.openapi.js';
import { tenantOpenApi } from '../routes/admin/tenant.openapi.js';
import { tokensOpenApi } from '../routes/admin/tokens.openapi.js';
import { updateOpenApi } from '../routes/admin/update.openapi.js';
import { upstreamsOpenApi } from '../routes/admin/upstreams.openapi.js';
import { usersOpenApi } from '../routes/admin/users.openapi.js';
import { webhooksOpenApi } from '../routes/admin/webhooks.openapi.js';

/**
 * Every route description, gathered.
 *
 * Each lives beside its route module (`routes/admin/<module>.openapi.ts`) so
 * the person adding a route sees the file they also have to touch — and if
 * they do not, `openapi.test.ts` names the route they missed. A new route
 * MODULE is the one case that needs an edit here as well; the same test
 * catches that, since none of its routes will be described.
 */
export const ADMIN_ROUTE_DESCRIPTIONS: readonly DescribedRoute[] = [
  ...applicationsOpenApi,
  ...auditOpenApi,
  ...breakGlassOpenApi,
  ...changeControlOpenApi,
  ...exportsOpenApi,
  ...credentialsOpenApi,
  ...credentialPickupsOpenApi,
  ...automateOpenApi,
  ...employeeLifecycleOpenApi,
  ...governOpenApi,
  ...groupsOpenApi,
  ...incidentsOpenApi,
  ...emailDomainsOpenApi,
  ...lifecycleOperationsOpenApi,
  ...mailOpenApi,
  ...operationsOpenApi,
  ...orgUnitsOpenApi,
  ...personReceiptsOpenApi,
  ...personSourcesOpenApi,
  ...personsOpenApi,
  ...personDeleteOpenApi,
  ...privacyOpenApi,
  ...policiesOpenApi,
  ...profilesOpenApi,
  ...protocolAppsOpenApi,
  ...provisionRunsOpenApi,
  ...rolesOpenApi,
  ...rulesOpenApi,
  ...sessionsOpenApi,
  ...sourcesOpenApi,
  ...syncRunsOpenApi,
  ...targetsOpenApi,
  ...tenantOpenApi,
  ...tokensOpenApi,
  ...updateOpenApi,
  ...restoreHoldOpenApi,
  ...upstreamsOpenApi,
  ...usersOpenApi,
  ...webhooksOpenApi,
];

/**
 * The unauthenticated routes that are part of the published contract: the
 * few a person reaches from a link in an email, or in the log at first run,
 * without signing in. Checked by `openapi.test.ts` like the administration
 * routes above.
 */
export const PUBLIC_ROUTE_DESCRIPTIONS: readonly DescribedRoute[] = [...credentialPickupOpenApi, ...setupOpenApi];

/** Everything the published document describes. */
export const ROUTE_DESCRIPTIONS: readonly DescribedRoute[] = [
  ...ADMIN_ROUTE_DESCRIPTIONS,
  ...PUBLIC_ROUTE_DESCRIPTIONS,
];
