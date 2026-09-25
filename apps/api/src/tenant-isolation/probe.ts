import type { CatalogRoute } from '../openapi/route-catalog.js';
import type { Kind } from './world.js';

/**
 * THE CLASSIFICATION OF EVERY ROUTE THE TENANT-ISOLATION PROBE COVERS.
 *
 * Nothing in here lists routes one by one where it can be avoided. The probe
 * reads the running route table (`app.routeCatalog`) and decides, per route,
 * what to call it with:
 *
 *  - a route with path parameters is an ID probe. Each parameter is resolved
 *    to a kind of tenant object through `PARAM_KINDS`, by the literal segment
 *    in front of it. A parameter this table cannot resolve fails the
 *    structural test, naming the route -- so a new route whose ids the probe
 *    does not understand cannot be added without somebody deciding what they
 *    mean.
 *  - a GET with no path parameters is a LIST probe: it is called as tenant A
 *    and must not return a byte of tenant B.
 *  - any other route (a create, a bulk action) is a BODY probe when its
 *    published request schema has an id-shaped field to point at B, and must
 *    otherwise appear in `NO_ID_INPUT` with a reason -- the explicit allow-list
 *    of routes that take no reference to tenant data at all.
 *
 * `COVERED_PREFIXES` is the scope: the administration API, the end-user
 * portal and SCIM. Protocol endpoints (SAML, OIDC, WS-Fed) are covered where
 * they take an object id -- `/saml/.../:applicationId` -- and otherwise by
 * their own suites, which own the far more specific question of whose keys
 * and whose sessions a protocol message may name.
 */
export const COVERED_PREFIXES = ['/api/admin/', '/api/portal/', '/scim/v2/'] as const;

/** A route outside `COVERED_PREFIXES` that still takes an object id is probed too. */
export function isCovered(route: CatalogRoute): boolean {
  return COVERED_PREFIXES.some((prefix) => route.url.startsWith(prefix)) || route.url.includes('/:');
}

/**
 * A path parameter that is not a tenant object at all: an enumerated word, a
 * position inside an object the route's OTHER parameter names. It is filled
 * with a valid value, never with anything from tenant B -- there is nothing
 * of B's to put there.
 */
export interface StaticParam {
  static: string;
  why: string;
}

/**
 * A path parameter that EMBEDS an object's id rather than being one: a
 * credential key is `<kind>.<subject id>`. The probe fills it with B's (or
 * A's) object of `kind`, run through `format`; the ghost call's id swap
 * reaches the embedded uuid like any other.
 */
export interface DerivedParam {
  kind: Kind;
  format: (id: string) => string;
}

/**
 * PATH PARAMETER → WHAT IT NAMES.
 *
 * Keyed by the parameter and the literal segment(s) in front of it:
 * `groups/:id` is a group, `members/:userId` is a user. A two-segment key
 * wins over a one-segment key, which is how `policy/rules/:ruleId` (an
 * authentication-policy rule) and `rules/:ruleId` (a provisioning business
 * rule) are told apart, and how `deletion/requests/:id` is kept away from
 * Automate's `requests/:id`.
 *
 * When a parameter follows another parameter (`sources/:kind/:id`), the key
 * includes both, because the first decides what the second means.
 */
export const PARAM_KINDS: ReadonlyMap<string, Kind | StaticParam | DerivedParam> = new Map<
  string,
  Kind | StaticParam | DerivedParam
>([
  // ---- directory --------------------------------------------------------------
  ['users/:id', 'user'],
  ['Users/:id', 'user'],
  ['groups/:id', 'group'],
  ['Groups/:id', 'group'],
  ['members/:userId', 'user'],
  ['org-units/:id', 'orgUnit'],
  ['containers/:targetSystemId', 'target'],
  ['persons/:id', 'person'],
  ['person/:personId', 'person'],
  ['placements/:personId', 'person'],
  ['accounts/:personId', 'person'],
  ['credential-pickup/:token', {
    static: 'A'.repeat(43),
    why: 'A one-time link token, not a row id: only its hash is stored, it is looked up inside the tenant the hostname names, and one from another tenant matches nothing.',
  }],
  ['contracts/:sequence', {
    static: '1',
    why: 'A contract is addressed by its position inside the person the route\'s :id names; that :id is the tenant boundary.',
  }],
  ['sessions/:sessionId', 'session'],
  ['portal/sessions/:id', 'session'],
  ['tokens/:tokenId', 'token'],
  ['factors/:type', {
    static: 'totp',
    why: 'A factor TYPE (totp, webauthn, recovery_code), not a row; the user in :id is the tenant boundary.',
  }],
  ['webauthn/:credentialId', 'webauthnCredential'],
  // ---- RBAC ----------------------------------------------------------------------
  ['roles/:id', 'role'],
  ['assignments/:userId', 'user'],
  ['presets/:key', {
    static: 'helpdesk',
    why: 'A built-in role preset key, the same list in every tenant and compiled into the product.',
  }],
  // ---- tenant administration ---------------------------------------------------
  ['deletion/requests/:id', 'deletionRequest'],
  ['webhooks/:id', 'webhook'],
  ['deliveries/:deliveryId', 'webhookDelivery'],
  ['views/:id', 'auditView'],
  ['exports/:id', 'export'],
  // ---- sync and HR import --------------------------------------------------------
  ['sources/:id', 'source'],
  ['sync-runs/:id', 'syncRun'],
  ['sync-changes/:id', 'syncChange'],
  ['person-sources/:id', 'personSource'],
  ['person-import-runs/:id', 'personImportRun'],
  ['person-import-runs/:runId', 'personImportRun'],
  ['changes/:id', 'personImportChange'],
  ['person-source-links/:id', 'personSourceLink'],
  ['identity-reference-values/:id', 'identityReferenceValue'],
  ['person-duplicate-reviews/:id', 'duplicateReview'],
  // ---- access --------------------------------------------------------------------
  ['applications/:id', 'application'],
  ['oidc-start/:id', 'application'],
  ['metadata/:applicationId', 'application'],
  ['start/:applicationId', 'application'],
  ['assignments/:assignmentId', 'appAssignment'],
  ['claims/:claimId', 'claim'],
  ['claim-sets/:id', 'claimSet'],
  ['policy/rules/:ruleId', 'policyRule'],
  // ---- provision -----------------------------------------------------------------
  ['targets/:id', 'target'],
  ['runs/:runId', 'provisionRun'],
  ['drift/:id', 'drift'],
  ['rules/:ruleId', 'businessRule'],
  ['provision-receipts/:receiptId', 'receipt'],
  // ---- lifecycle -----------------------------------------------------------------
  ['lifecycle-operations/:id', 'lifecycleOperation'],
  ['lifecycle-legal-holds/:id', 'legalHold'],
  ['lifecycle-simulations/:id', 'lifecycleSimulation'],
  // ---- govern --------------------------------------------------------------------
  ['snapshots/:id', 'snapshot'],
  ['sources/:kind', {
    static: 'targetSystem',
    why: 'Which Govern source table the :id that follows is in. The test for this route also probes `directorySource`.',
  }],
  ['sources/:kind/:id', 'target'],
  ['evidence/:id', 'evidencePack'],
  ['findings/:id', 'finding'],
  ['remediation/:id', 'remediation'],
  ['orphans/:id', 'orphan'],
  ['campaigns/:id', 'campaign'],
  ['batches/:id', 'revocationBatch'],
  ['dispatches/:id', 'revocationDispatch'],
  ['violations/:id', 'sodViolation'],
  ['exceptions/:id', 'sodException'],
  ['reviews/:id', 'campaignItem'],
  // ---- automate ------------------------------------------------------------------
  ['tasks/:id', 'task'],
  ['products/:id', 'product'],
  ['catalog/:id', 'product'],
  ['workflows/:id', 'workflow'],
  ['requests/:id', 'accessRequest'],
  ['approvals/:id', 'accessRequest'],
  ['sweeps/:id', 'sweep'],
  ['approval-delegations/:id', 'approvalDelegation'],
  ['delegations/:id', 'approvalDelegation'],
  ['grants/:id', 'grant'],
  ['managed-resources/:type', {
    static: 'group',
    why: 'Which kind of resource (application or group) the :id that follows is.',
  }],
  ['managed-resources/:type/:id', 'group'],
  // ---- privileged access (change control, break-glass) ------------------------
  ['change-control/requests/:id', 'privilegedChange'],
  // Keyed by the emergency account's USER id.
  ['accounts/:userId', 'breakGlassUser'],
  ['activations/:id', 'breakGlassActivation'],
  // ---- credentials ---------------------------------------------------------------
  ['rotations/:id', 'credentialRotation'],
  // `target_secret.<target id>`: a credential key names its subject inside it.
  ['credentials/:key', { kind: 'target', format: (id) => `target_secret.${id}` }],
  // ---- privacy -------------------------------------------------------------------
  ['cases/:id', 'privacyCase'],
]);

/**
 * PARAMETERISED ROUTES THE PROBE DELIBERATELY DOES NOT CALL, each with why.
 *
 * Reviewed like the exclusion list in `openapi.test.ts`: "not yet" is not a
 * reason. The structural test fails on an entry that no longer names a
 * registered route.
 */
export const UNPROBED_ROUTES: ReadonlyMap<string, string> = new Map<string, string>([
  [
    'GET /oidc/interaction/:uid',
    'An oidc-provider interaction uid, held in `OidcArtifact` under the tenant-bound provider instance; ' +
      'oidc-boundary.test.ts and oidc-authorize.test.ts own whose interaction a browser may resume.',
  ],
]);

/**
 * ROUTES THAT ANSWER A FOREIGN ID EXACTLY AS THEY ANSWER A MISSING ONE -- WITH
 * SUCCESS.
 *
 * A sub-collection read (`GET /users/:id/sessions`) that returns an empty list
 * for B's user, and an idempotent removal (`DELETE /groups/:id/members/:userId`)
 * that answers 204 whether or not the membership was there. Neither is a
 * refusal, and neither leaks: the probe's ghost call proves the answer for
 * B's id is the same as for an id that never existed, and the fingerprint
 * proves nothing of B's changed. They are listed rather than accepted in
 * bulk so that a NEW route answering 2xx to B's id is a failure somebody has
 * to look at.
 */
const EMPTY_LIST = 'A sub-collection read: a parent this tenant does not have has no children, the same empty list as an id nobody holds.';
const IDEMPOTENT = 'An idempotent removal or revocation: nothing matched under RLS, so nothing was removed, and the answer is the same as for an id nobody holds.';
export const ABSENT_IS_EMPTY: ReadonlyMap<string, string> = new Map<string, string>([
  ['GET /api/admin/webhooks/:id/deliveries', EMPTY_LIST],
  ['GET /api/admin/users/:id/sessions', EMPTY_LIST],
  ['GET /api/admin/users/:id/tokens', EMPTY_LIST],
  ['GET /api/admin/groups/:id/members', EMPTY_LIST],
  ['GET /api/admin/org-units/:id/containers', EMPTY_LIST],
  ['GET /api/admin/persons/:id/provision-receipts', EMPTY_LIST],
  ['GET /api/admin/lifecycle-operations/:id/notifications', EMPTY_LIST],
  ['GET /api/admin/applications/:id/assignments', EMPTY_LIST],
  ['GET /api/admin/applications/:id/claims', EMPTY_LIST],
  ['GET /api/admin/targets/:id/entitlements', EMPTY_LIST],
  ['GET /api/admin/targets/:id/rules', EMPTY_LIST],
  ['GET /api/admin/targets/:id/runs', EMPTY_LIST],
  ['GET /api/admin/targets/:id/drift', EMPTY_LIST],
  ['GET /api/admin/automate/tasks/:id/runs', EMPTY_LIST],
  [
    'GET /api/admin/targets/:id/placements/:personId',
    '`{ placement: null }` is the ordinary answer ("this person follows the rule"), by design; see the route.',
  ],
  ['DELETE /api/admin/roles/:id/assignments/:userId', IDEMPOTENT],
  ['DELETE /api/admin/groups/:id/members/:userId', IDEMPOTENT],
  ['DELETE /api/admin/applications/:id/assignments/:assignmentId', IDEMPOTENT],
  ['DELETE /api/admin/applications/:id/claims/:claimId', IDEMPOTENT],
  ['DELETE /api/admin/policy/rules/:ruleId', IDEMPOTENT],
  ['DELETE /api/admin/claim-sets/:id', IDEMPOTENT],
  ['DELETE /api/admin/targets/:id/placements/:personId', IDEMPOTENT],
]);

/**
 * WRITE ROUTES WITH NO PATH PARAMETER AND NO ID-SHAPED INPUT.
 *
 * The explicit allow-list: a route here takes nothing that could name another
 * tenant's object, so there is no foreign id to hand it. A route whose
 * published request schema gains a uuid field stops needing its entry, and the
 * structural test says so, so the list cannot outlive its reasons.
 *
 * Routes under `/api/portal` and `/scim/v2` have no published request schema,
 * so every one of their parameterless writes is decided here or in
 * `BODY_OVERRIDES`.
 */
export const NO_ID_INPUT: ReadonlyMap<string, string> = new Map<string, string>([
  ['PUT /api/admin/tenant', 'The tenant\'s own settings; addressed by the Host header, which is the boundary.'],
  ['PUT /api/admin/tenant/brand', 'The tenant\'s own branding.'],
  ['POST /api/admin/tenant/offboarding/assess', 'Assesses the calling tenant; takes no object id.'],
  ['POST /api/admin/tenant/offboarding/export', 'Exports the calling tenant; takes no object id.'],
  ['POST /api/admin/tenant/deletion/requests', 'Requests erasure of the calling tenant; carries digests, not ids.'],
  ['POST /api/admin/webhooks', 'Creates an endpoint from a name, URL and event groups.'],
  ['POST /api/admin/roles', 'Creates a role from a name and permission keys.'],
  ['POST /api/admin/sessions/revoke', 'Revokes every session of the calling tenant; takes no id (and would end the probe\'s own).'],
  ['PUT /api/admin/audit/views', 'Saves the caller\'s own filter; the filter\'s ids are search terms matched under RLS.'],
  ['POST /api/admin/update', 'Deployment update; installation-wide, no tenant data.'],
  ['POST /api/admin/update/rollback', 'Deployment rollback; installation-wide, no tenant data.'],
  ['POST /api/admin/sources/test', 'Tests an unsaved connection description; references no saved object.'],
  ['POST /api/admin/targets/test', 'Tests an unsaved connection description; references no saved object.'],
  ['PATCH /api/admin/lifecycle-policy', 'The tenant\'s own lifecycle policy settings.'],
  ['PUT /api/admin/policy/default', 'The tenant\'s default authentication policy outcome.'],
  ['POST /api/admin/provision/external-write-stop', 'Tenant-wide write stop; takes a reason, not an id.'],
  ['POST /api/admin/provision/external-write-resume', 'Tenant-wide write resume; takes a reason, not an id.'],
  ['POST /api/admin/govern/integrity/verify', 'Verifies the calling tenant\'s audit chain.'],
  ['POST /api/admin/govern/integrity/verify-full', 'Verifies the calling tenant\'s audit chain.'],
  ['PATCH /api/admin/govern/settings', 'The tenant\'s own Govern settings.'],
  ['PUT /api/admin/automate/settings', 'The tenant\'s own Automate settings.'],
  ['POST /api/admin/claim-sets', 'Creates a reusable claim set from names and source kinds.'],
  ['POST /api/admin/upstreams', 'Creates an upstream identity provider from its protocol configuration.'],
  ['POST /api/admin/persons/import', 'A CSV body of new people; it names no existing object.'],
  ['POST /api/admin/automate/workflows', 'Creates an approval workflow; stage selectors are words, not ids.'],
  ['POST /api/admin/automate/tasks', 'Creates a delegated task from an action key.'],
  ['PUT /api/admin/change-control/policy', 'Which change classes this tenant holds for a second administrator; class names, not ids.'],
  ['PUT /api/admin/break-glass/settings', "This tenant's activation delay, in minutes."],
  ['POST /api/admin/credentials/scan', "Scans the calling tenant's own credential inventory; takes only a flag."],
  ['PUT /api/admin/security-notifications', 'Which security categories this tenant mails, and its alert thresholds.'],
  ['POST /api/admin/groups', 'Creates a group from a name and description.'],
  ['POST /api/admin/lifecycle-operations/simulate', 'A pure what-if over the state described in the body; it reads no saved object.'],
  ['POST /api/admin/sources', 'Creates a directory source from a connection description.'],
  ['POST /api/admin/identity-reference-values', 'Adds a department or location name.'],
  ['POST /api/admin/person-sources', 'Creates an HR source from a connection description.'],
  ['POST /api/admin/applications/from-catalog', 'Installs a catalog template by its product-wide key.'],
  ['POST /api/admin/applications', 'Creates an application from a name, slug and launch details.'],
  ['POST /api/admin/govern/snapshots', 'Builds a snapshot of the calling tenant; takes only a kind.'],
  ['POST /api/admin/automate/sweeps', 'Previews an expiry sweep of the calling tenant; takes no body.'],
  ['POST /api/admin/automate/workflows/resolution-preview', 'Previews selector resolution; its ids are probed as a body probe when published.'],
  ['POST /scim/v2/Users', 'A SCIM create: a new user from attributes. Group membership is written through PATCH /Groups/:id, which is probed.'],
  ['POST /scim/v2/Groups', 'A SCIM create. `members` naming another tenant\'s user is covered by BODY_OVERRIDES on PATCH /Groups/:id.'],
  ['POST /api/portal/automate/delegations', 'Probed by BODY_OVERRIDES.'],
  ['POST /api/portal/automate/requests', 'Probed by BODY_OVERRIDES.'],
  ['POST /api/portal/govern/reviews/bulk-certify', 'Probed by BODY_OVERRIDES.'],
]);

/**
 * Hand-written bodies, where the published schema is missing (portal, SCIM)
 * or too loose to point at tenant B by itself. `(b)` returns tenant B's id of
 * a kind; `(a)` tenant A's. Keyed `METHOD /url` exactly as registered.
 */
export type IdOf = (kind: Kind) => string;
export const BODY_OVERRIDES: ReadonlyMap<string, (b: IdOf, a: IdOf) => unknown> = new Map<
  string,
  (b: IdOf, a: IdOf) => unknown
>([
  [
    'PATCH /scim/v2/Groups/:id',
    (b) => ({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'add', path: 'members', value: [{ value: b('user') }] }],
    }),
  ],
  [
    'PATCH /scim/v2/Users/:id',
    () => ({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'replace', path: 'displayName', value: 'probe' }],
    }),
  ],
  [
    'PUT /scim/v2/Users/:id',
    () => ({ schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: 'probe-put' }),
  ],
  [
    'POST /api/portal/automate/requests',
    (b) => ({ subjectPersonId: b('person'), items: [{ productId: b('product') }], justification: 'probe' }),
  ],
  [
    'POST /api/portal/automate/delegations',
    (b) => ({
      delegatePersonId: b('person'),
      startsAt: new Date().toISOString(),
      endsAt: new Date(Date.now() + 86_400_000).toISOString(),
    }),
  ],
  ['POST /api/portal/govern/reviews/bulk-certify', (b) => ({ itemIds: [b('campaignItem')] })],
  ['POST /api/portal/automate/approvals/:id/decide', () => ({ decision: 'approve' })],
  ['POST /api/portal/govern/reviews/:id/decide', () => ({ decision: 'certify' })],
  ['POST /api/portal/automate/managed-resources/:type/:id/grant', (b) => ({ subjectPersonIds: [b('person')], justification: 'probe' })],
  ['POST /api/portal/automate/managed-resources/:type/:id/revoke', (b) => ({ subjectPersonIds: [b('person')], justification: 'probe' })],
  // `systemId` and `resourceId` are free text in the schema (a system can be
  // Syntra itself), so the sampler would not know to point them at B.
  [
    'POST /api/admin/govern/classifications',
    (b) => ({ systemId: b('target'), resourceKind: 'targetEntitlement', resourceId: b('group'), privileged: true }),
  ],
  // Exactly one delegate is allowed, and the sampler would fill both.
  [
    'POST /api/admin/automate/resource-delegations',
    (b) => ({
      resourceType: 'group',
      resourceId: b('group'),
      delegatePersonId: b('person'),
      delegateGroupId: null,
      capabilities: ['approve'],
      audienceCondition: null,
      startsAt: new Date().toISOString(),
      endsAt: null,
    }),
  ],
  // Exactly one owner is allowed, and the sampler would fill both.
  [
    'PUT /api/admin/automate/resource-owners',
    (b) => ({ resourceType: 'group', resourceId: b('group'), ownerPersonId: b('person'), ownerGroupId: null }),
  ],
  // An audience is opaque JSON in the schema; a group-membership condition is
  // the one that names a row.
  [
    'POST /api/admin/automate/products/audience-preview',
    (b) => ({ audienceCondition: { field: 'user.memberOfGroup', op: 'contains', value: b('group') } }),
  ],
]);

/**
 * A body or query field → which of tenant B's objects to put in it.
 *
 * By field name, since that is how the API names its references
 * (`userId`, `scopeOrgUnitId`, `subjectPersonId`). A uuid field whose name
 * matches none of these still gets one of B's ids -- B's person, the kind
 * most references point at -- so a new id field is probed with SOMETHING of
 * B's from the day it is added rather than skipped.
 */
const FIELD_KINDS: readonly [RegExp, Kind][] = [
  [/orgunit/i, 'orgUnit'],
  [/^(actor|userid|.*userid|user)$/i, 'user'],
  [/group/i, 'group'],
  [/person|subject|owner|delegat|reviewer|approver|candidate/i, 'person'],
  [/role/i, 'role'],
  [/application|app$/i, 'application'],
  [/claimset/i, 'claimSet'],
  [/targetsystem|target$|systemid/i, 'target'],
  [/directorysource|sourceid|source$/i, 'source'],
  [/snapshot/i, 'snapshot'],
  [/campaign/i, 'campaign'],
  [/itemid/i, 'campaignItem'],
  [/product/i, 'product'],
  [/workflow/i, 'workflow'],
  [/functionb/i, 'otherBusinessFunction'],
  [/function/i, 'businessFunction'],
  [/operation/i, 'lifecycleOperation'],
  [/grant/i, 'grant'],
  [/entitlement|resource/i, 'group'],
];

export function kindOfField(name: string): Kind {
  for (const [pattern, kind] of FIELD_KINDS) if (pattern.test(name)) return kind;
  return 'person';
}

/** The path segments of a Fastify URL pattern. */
function segments(url: string): string[] {
  return url.split('/').filter((part) => part.length > 0);
}

/** Every `:param` of a route, with the key `PARAM_KINDS` is looked up by. */
export function paramsOf(url: string): { name: string; keys: string[] }[] {
  const parts = segments(url);
  const out: { name: string; keys: string[] }[] = [];
  parts.forEach((part, index) => {
    if (!part.startsWith(':')) return;
    const name = part.slice(1);
    const prev = parts[index - 1] ?? '';
    const prevPrev = parts[index - 2] ?? '';
    // Most specific first: two segments of context, then one.
    out.push({ name, keys: [`${prevPrev}/${prev}/:${name}`, `${prev}/:${name}`] });
  });
  return out;
}

export type Resolution =
  | { name: string; kind: Kind; format?: (id: string) => string }
  | { name: string; fixed: string };

/**
 * What each path parameter of `url` is, or the parameters nobody has
 * classified. Never guesses: an unknown parameter is reported, not filled.
 */
export function resolveParams(url: string): { resolved: Resolution[]; unknown: string[] } {
  const resolved: Resolution[] = [];
  const unknown: string[] = [];
  for (const param of paramsOf(url)) {
    const hit = param.keys.map((key) => PARAM_KINDS.get(key)).find((value) => value !== undefined);
    if (hit === undefined) unknown.push(param.keys[1]!);
    else if (typeof hit === 'string') resolved.push({ name: param.name, kind: hit });
    else if ('format' in hit) resolved.push({ name: param.name, kind: hit.kind, format: hit.format });
    else resolved.push({ name: param.name, fixed: hit.static });
  }
  return { resolved, unknown };
}

export function fillUrl(url: string, values: Record<string, string>): string {
  return url.replace(/:(\w+)/g, (_, name: string) => encodeURIComponent(values[name] ?? name));
}

// ---- a sample value for a published JSON Schema --------------------------------

type Schema = Record<string, unknown>;

/**
 * A value the schema accepts, with every uuid-shaped field -- required or not
 * -- set to one of tenant B's ids.
 *
 * The point is to get PAST validation, so the route's own lookup is what
 * refuses the foreign id. A body that fails validation proves only that the
 * validator works; the probe records those separately (`validationFirst`).
 *
 * Optional fields are left out unless they are uuid-shaped, because an
 * optional field is where a reference most often hides (`scopeOrgUnitId`).
 * `optionalIds: false` leaves those out too: an optional `id` usually turns a
 * create into an update, and the create path -- where a foreign reference is
 * written into a NEW row -- is then never reached. The probe sends both.
 */
export function sample(
  schema: Schema,
  idFor: (field: string) => string,
  root: Schema = schema,
  field = '',
  depth = 0,
  optionalIds = true,
): unknown {
  if (depth > 6) return undefined;
  if (typeof schema.$ref === 'string') {
    const name = schema.$ref.replace('#/$defs/', '');
    const defs = (root.$defs ?? {}) as Record<string, Schema>;
    const target = defs[name];
    return target ? sample(target, idFor, root, field, depth + 1, optionalIds) : undefined;
  }
  if ('const' in schema) return schema.const;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  const union = (schema.anyOf ?? schema.oneOf) as Schema[] | undefined;
  if (union) {
    const preferred = union.find((option) => option.type !== 'null') ?? union[0]!;
    // Opaque JSON-or-null (`{}` beside `null`): null is the value that
    // validates without knowing the shape the handler expects.
    if (Object.keys(preferred).length === 0 && union.some((option) => option.type === 'null')) return null;
    return sample(preferred, idFor, root, field, depth + 1, optionalIds);
  }
  const type = Array.isArray(schema.type) ? (schema.type as string[]).find((t) => t !== 'null') : schema.type;
  // A coerced date publishes as an unconstrained schema; its NAME says what it is.
  if (type === undefined && DATE_FIELD.test(field)) return future();
  switch (type) {
    case 'object': {
      const properties = (schema.properties ?? {}) as Record<string, Schema>;
      const required = new Set((schema.required ?? []) as string[]);
      const out: Record<string, unknown> = {};
      for (const [name, property] of Object.entries(properties)) {
        if (!required.has(name) && !(optionalIds && hasUuid(property, root))) continue;
        const value = sample(property, idFor, root, name, depth + 1, optionalIds);
        if (value !== undefined) out[name] = value;
      }
      // A PATCH whose fields are all optional refuses `{}` as "nothing to
      // change" before it looks the object up, which proves only that the
      // validator works. One field is enough to reach the lookup.
      if (Object.keys(out).length === 0) {
        for (const [name, property] of Object.entries(properties)) {
          const value = sample(property, idFor, root, name, depth + 1, optionalIds);
          if (value !== undefined) {
            out[name] = value;
            break;
          }
        }
      }
      return out;
    }
    case 'array': {
      const items = (schema.items ?? {}) as Schema;
      const count = Math.max(1, Number(schema.minItems ?? 1));
      return Array.from({ length: count }, () => sample(items, idFor, root, field, depth + 1, optionalIds));
    }
    case 'integer':
    case 'number': {
      const minimum = Number(schema.minimum ?? schema.exclusiveMinimum ?? 0);
      return Number.isFinite(minimum) ? Math.max(1, Math.ceil(minimum)) : 1;
    }
    case 'boolean':
      return false;
    case 'string':
      return sampleString(schema, field, idFor);
    default:
      return undefined;
  }
}

const DATE_FIELD = /(At|Date|Until|until|expires)$/;
const future = () => new Date(Date.now() + 86_400_000).toISOString();

function sampleString(schema: Schema, field: string, idFor: (field: string) => string): string {
  if (schema.format === undefined && DATE_FIELD.test(field) && schema.pattern === undefined) return future();
  switch (schema.format) {
    case 'uuid':
      return idFor(field);
    case 'email':
      return 'probe@probe.example.test';
    case 'uri':
    case 'url':
      return 'https://probe.example.test/probe';
    case 'date-time':
      return new Date(Date.now() + 86_400_000).toISOString();
    case 'date':
      return new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    default: {
      const min = Number(schema.minLength ?? 1);
      const base = 'probe';
      return base.length >= min ? base : base.padEnd(min, 'x');
    }
  }
}

/** Whether any uuid field is reachable from `schema`. */
export function hasUuid(schema: Schema, root: Schema = schema, depth = 0): boolean {
  if (depth > 6 || schema === null || typeof schema !== 'object') return false;
  if (typeof schema.$ref === 'string') {
    const defs = (root.$defs ?? {}) as Record<string, Schema>;
    const target = defs[schema.$ref.replace('#/$defs/', '')];
    return target ? hasUuid(target, root, depth + 1) : false;
  }
  if (schema.format === 'uuid') return true;
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const list = schema[key] as Schema[] | undefined;
    if (list?.some((option) => hasUuid(option, root, depth + 1))) return true;
  }
  if (schema.items && hasUuid(schema.items as Schema, root, depth + 1)) return true;
  const properties = (schema.properties ?? {}) as Record<string, Schema>;
  return Object.values(properties).some((property) => hasUuid(property, root, depth + 1));
}
