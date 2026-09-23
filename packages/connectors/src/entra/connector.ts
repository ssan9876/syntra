import { createHash } from 'node:crypto';
import type {
  ConnectionResult,
  ConnectorRight,
  DiscoveredEntitlement,
  SchemaDescriptor,
  SourceRecord,
  TargetConnector,
  TargetReadBack,
  WriteOperation,
  WriteResult,
} from '../types.js';
import {
  ENTRA_ATTRIBUTE_MAP,
  correlationFilterPath,
  correlationSelect,
  resolveEntraConfig,
  tenantIsDomain,
  type EntraConnection,
  type EntraCorrelationField,
  type EntraManagedAttribute,
  type EntraTargetConfig,
} from './config.js';
import {
  GRAPH_BATCH_LIMIT,
  GraphTokenError,
  classifyGraph,
  graphAccessToken,
  graphBatch,
  graphErrorMessage,
  graphFailureMessage,
  graphPaginate,
  graphRequest,
  graphRetryAfterMs,
  odataLiteral,
  type GraphResponse,
} from './graph.js';

/**
 * Microsoft Entra ID, natively, through Microsoft Graph v1.0.
 *
 * The successor to the shipped `entra-id` document for the `httpJson`
 * connector, which keeps working. The document could not express the four
 * things this connector exists for: an idempotent create that finds the
 * object a previous attempt made; a membership read per user that is
 * complete or marked as not; a refusal to touch a dynamic group; and a
 * read-back after every write that says when it could not finish.
 *
 * Every target connector is handed its vault value as `bindPassword` by core.
 * For this connector that value is the application's client SECRET.
 */
type Config = EntraTargetConfig & { bindPassword: string };

/** The advanced-query headers Graph wants for `$search` and extension filters. */
const EVENTUAL = { consistencylevel: 'eventual' } as const;

const GRAPH_PROPERTY: Record<EntraManagedAttribute, string> = ENTRA_ATTRIBUTE_MAP;
const SYNTRA_NAME = new Map<string, EntraManagedAttribute>(
  (Object.entries(ENTRA_ATTRIBUTE_MAP) as [EntraManagedAttribute, string][]).map(
    ([syntra, graph]) => [graph, syntra],
  ),
);

/** The `$select` for a user read: identity, state, marker, managed fields. */
function userSelect(connection: EntraConnection): string {
  return [
    'id',
    'userPrincipalName',
    'accountEnabled',
    correlationSelect(connection.correlationField),
    ...connection.managedAttributes.map((name) => GRAPH_PROPERTY[name]),
  ].join(',');
}

const GROUP_SELECT =
  'id,displayName,description,securityEnabled,mailEnabled,groupTypes,membershipRule';

function asString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function markerOf(item: Record<string, unknown>, field: EntraCorrelationField): string | undefined {
  if (field === 'employeeId') return asString(item.employeeId);
  const bag = item.onPremisesExtensionAttributes;
  if (bag === null || typeof bag !== 'object') return undefined;
  return asString((bag as Record<string, unknown>)[field]);
}

/** Where the marker goes in a create body. */
/**
 * `employeeId` is limited to 16 characters by Microsoft Graph. Provision
 * action ids are UUIDs, so retain a short test id as-is but use the first 96
 * bits of SHA-256 for normal action ids. This is deterministic (a retry finds
 * the first write) and has an astronomically lower collision chance than a
 * 16-character truncation of a UUID.
 */
function markerForAction(field: EntraCorrelationField, actionId: string): string {
  if (field !== 'employeeId' || actionId.length <= 16) return actionId;
  return createHash('sha256').update(actionId).digest('base64url').slice(0, 16);
}

function markerBody(field: EntraCorrelationField, marker: string): Record<string, unknown> {
  return field === 'employeeId'
    ? { employeeId: marker }
    : { onPremisesExtensionAttributes: { [field]: marker } };
}

/**
 * A Graph user as a `SourceRecord`.
 *
 * Attributes carry the Syntra names, plus `userPrincipalName` (the
 * correlation key), `accountEnabled` and `enabled` as `'true'`/`'false'`
 * (which `observedEnabled` and the run both read), and the provenance marker
 * under `correlationMarker` so `resolveInFlightActions` can adopt a landed
 * create. `memberOf` holds DIRECT group ids; `dn` is the UPN because Entra has
 * no tree and the run keys everything on a dn.
 */
function toRecord(
  connection: EntraConnection,
  item: Record<string, unknown>,
  memberOf: string[] | undefined,
  readFailure: string | undefined,
): SourceRecord | null {
  const anchor = asString(item.id);
  if (anchor === undefined) return null;
  const upn = asString(item.userPrincipalName) ?? anchor;
  const attributes: Record<string, string[]> = { userPrincipalName: [upn] };
  const enabled = item.accountEnabled;
  if (typeof enabled === 'boolean') {
    attributes.accountEnabled = [String(enabled)];
    attributes.enabled = [String(enabled)];
  }
  for (const [graph, value] of Object.entries(item)) {
    const syntra = SYNTRA_NAME.get(graph);
    const text = asString(value);
    if (syntra !== undefined && text !== undefined) attributes[syntra] = [text];
  }
  const marker = markerOf(item, connection.correlationField);
  if (marker !== undefined) attributes.correlationMarker = [marker];
  if (memberOf !== undefined) attributes.memberOf = memberOf;
  return {
    anchor,
    objectType: 'user',
    dn: upn,
    attributes,
    ...(readFailure === undefined ? {} : { readFailure }),
  };
}

function failed(response: GraphResponse): WriteResult {
  const failure = classifyGraph(response.status, response.body);
  const after = graphRetryAfterMs(response.headers);
  return {
    ok: false,
    message: graphFailureMessage(response.status, response.body),
    failure,
    ...(failure === 'throttled' && after !== undefined ? { retryAfterMs: after } : {}),
  };
}

/** A thrown transport error, as the run's retryable classification. */
function thrown(cause: unknown): WriteResult {
  if (cause instanceof GraphTokenError) {
    return {
      ok: false,
      message: cause.message,
      failure: cause.status === 401 || cause.status === 403 || cause.status === 400 ? 'unauthorized' : 'transient',
    };
  }
  return {
    ok: false,
    message: cause instanceof Error ? cause.message : String(cause),
    failure: 'transient',
  };
}

interface GroupFacts {
  id: string;
  displayName: string;
  description?: string;
  securityEnabled: boolean;
  mailEnabled: boolean;
  dynamic: boolean;
  membershipRule?: string;
}

function groupFacts(item: Record<string, unknown>): GroupFacts | null {
  const id = asString(item.id);
  const displayName = asString(item.displayName);
  if (id === undefined || displayName === undefined) return null;
  const types = Array.isArray(item.groupTypes) ? item.groupTypes.map(String) : [];
  const description = asString(item.description);
  const membershipRule = asString(item.membershipRule);
  return {
    id,
    displayName,
    ...(description === undefined ? {} : { description }),
    securityEnabled: item.securityEnabled === true,
    mailEnabled: item.mailEnabled === true,
    dynamic: types.includes('DynamicMembership'),
    ...(membershipRule === undefined ? {} : { membershipRule }),
  };
}

/** Why a group is out of scope, or undefined when it is manageable. */
function unmanageableReason(
  connection: EntraConnection,
  group: GroupFacts,
): string | undefined {
  if (group.dynamic) {
    return 'dynamic membership: Entra computes the members from a rule, so a grant or revoke would be undone on the next evaluation';
  }
  if (connection.groupScope.securityEnabledOnly && !group.securityEnabled) {
    return 'not a security group: groupScope.securityEnabledOnly is set';
  }
  if (!connection.groupScope.includeMailEnabled && group.mailEnabled) {
    return 'mail-enabled: groupScope.includeMailEnabled is not set';
  }
  return undefined;
}

function toEntitlement(
  group: GroupFacts,
  reason: string | undefined,
): DiscoveredEntitlement {
  return {
    externalId: group.id,
    // No tree here. Memberships come back as ids, so the id is what a
    // membership resolves against.
    dn: group.id,
    type: 'group',
    displayName: group.displayName,
    ...(group.description === undefined ? {} : { description: group.description }),
    manageable: reason === undefined,
    ...(reason === undefined ? {} : { unmanageableReason: reason }),
    membershipKind: group.dynamic ? 'dynamic' : 'assigned',
  };
}

/** Reads the whole direct membership of one user, or throws. */
async function directGroupIds(connection: EntraConnection, anchor: string): Promise<string[]> {
  const ids: string[] = [];
  for await (const group of graphPaginate(
    connection,
    `/users/${encodeURIComponent(anchor)}/memberOf/microsoft.graph.group`,
    { $select: 'id', $top: '999' },
  )) {
    const id = asString(group.id);
    if (id !== undefined) ids.push(id);
  }
  return ids;
}

/**
 * The direct memberships of up to twenty users, through one `$batch`.
 *
 * A sub-request that failed, or whose own page walk could not be finished,
 * yields an error string for that user and a list for every other -- the
 * caller turns the string into `readFailure` on that one record. Nothing
 * here throws for a single user's sake, because dropping the batch would
 * drop nineteen users who read cleanly.
 */
async function membershipsFor(
  connection: EntraConnection,
  anchors: string[],
): Promise<Map<string, string[] | { error: string }>> {
  const out = new Map<string, string[] | { error: string }>();
  let answers;
  try {
    answers = await graphBatch(
      connection,
      anchors.map((anchor, index) => ({
        id: String(index + 1),
        method: 'GET' as const,
        url: `/users/${encodeURIComponent(anchor)}/memberOf/microsoft.graph.group?$select=id&$top=999`,
      })),
    );
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    for (const anchor of anchors) out.set(anchor, { error });
    return out;
  }

  for (const [index, anchor] of anchors.entries()) {
    const answer = answers.get(String(index + 1));
    if (answer === undefined || answer.status >= 400) {
      out.set(anchor, {
        error: `the membership read ${
          answer === undefined ? 'was not answered' : graphFailureMessage(answer.status, answer.body)
        }`,
      });
      continue;
    }
    const body = answer.body as { value?: unknown; '@odata.nextLink'?: unknown } | null;
    if (!Array.isArray(body?.value)) {
      out.set(anchor, { error: 'the membership read did not answer with a "value" array' });
      continue;
    }
    if (typeof body['@odata.nextLink'] === 'string' && body['@odata.nextLink'] !== '') {
      // More than one page of groups. Finish the walk outside the batch --
      // all or nothing, as `graphPaginate` guarantees.
      try {
        out.set(anchor, await directGroupIds(connection, anchor));
      } catch (cause) {
        out.set(anchor, {
          error: `the membership read could not be completed: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        });
      }
      continue;
    }
    const ids: string[] = [];
    for (const group of body.value) {
      const id = asString((group as { id?: unknown } | null)?.id);
      if (id !== undefined) ids.push(id);
    }
    out.set(anchor, ids);
  }
  return out;
}

/** `GET /groups/{id}`, for the facts a grant or a revoke needs. */
async function readGroup(
  connection: EntraConnection,
  id: string,
): Promise<{ group: GroupFacts } | { response: GraphResponse }> {
  const response = await graphRequest(connection, {
    method: 'GET',
    path: `/groups/${encodeURIComponent(id)}`,
    query: { $select: GROUP_SELECT },
  });
  if (response.status >= 400) return { response };
  const group = groupFacts((response.body ?? {}) as Record<string, unknown>);
  if (group === null) {
    return { response: { ...response, status: 502, body: null } };
  }
  return { group };
}

async function revokeMembership(
  connection: EntraConnection,
  groupId: string,
  anchor: string,
): Promise<WriteResult> {
  const response = await graphRequest(connection, {
    method: 'DELETE',
    path: `/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(anchor)}/$ref`,
  });
  if (response.status < 400) return { ok: true, message: 'membership removed' };
  if (response.status !== 404) return failed(response);
  // 404 is ambiguous: the membership edge, the user, or the group. Only the
  // last of those is a failure -- an absent membership is the state a revoke
  // asks for, and revoking it twice must succeed twice.
  const group = await readGroup(connection, groupId);
  if ('response' in group) {
    return group.response.status === 404
      ? {
          ok: false,
          message: `the group no longer exists: ${graphFailureMessage(404, response.body)}`,
          failure: 'not_found',
        }
      : failed(group.response);
  }
  return { ok: true, message: 'membership already absent' };
}

async function grantMembership(
  connection: EntraConnection,
  groupId: string,
  anchor: string,
  cache: Map<string, GroupFacts>,
): Promise<WriteResult> {
  let group = cache.get(groupId);
  if (group === undefined) {
    const read = await readGroup(connection, groupId);
    if ('response' in read) return failed(read.response);
    group = read.group;
    cache.set(groupId, group);
  }
  if (group.dynamic) {
    // Refused before any request is made. Graph would refuse it too, but
    // with a 400 whose classification is `rejected` either way; saying why
    // is the difference between an administrator fixing the rule and
    // wondering what was wrong with the request.
    return {
      ok: false,
      message: `${group.displayName} is a dynamic group; Entra computes its membership from a rule and this connector does not manage dynamic groups`,
      failure: 'rejected',
    };
  }
  const response = await graphRequest(connection, {
    method: 'POST',
    path: `/groups/${encodeURIComponent(groupId)}/members/$ref`,
    body: {
      '@odata.id': `${connection.graphBaseUrl.replace(/\/$/, '')}/directoryObjects/${encodeURIComponent(anchor)}`,
    },
  });
  if (response.status < 400) return { ok: true, message: 'membership added' };
  if (
    response.status === 400 &&
    /already exist/i.test(graphErrorMessage(response.body))
  ) {
    // Idempotent: the state the grant asked for is the state there is.
    return { ok: true, message: 'membership already present' };
  }
  return failed(response);
}

/**
 * Finds the object a previous attempt at this action created, by its marker.
 *
 * `$filter` on `employeeId` is an ordinary query; on an extension attribute
 * it is an advanced one and needs `ConsistencyLevel: eventual` and `$count`.
 * A query that fails is reported as such rather than read as "not found",
 * because "not found" is what leads to a second create.
 */
async function findByMarker(
  connection: EntraConnection,
  actionId: string,
): Promise<{ anchor: string | null } | { response: GraphResponse }> {
  const advanced = connection.correlationField !== 'employeeId';
  const response = await graphRequest(connection, {
    method: 'GET',
    path: '/users',
    query: {
      $filter: `${correlationFilterPath(connection.correlationField)} eq ${odataLiteral(actionId)}`,
      $select: 'id',
      $top: '2',
      ...(advanced ? { $count: 'true' } : {}),
    },
    ...(advanced ? { headers: EVENTUAL } : {}),
  });
  if (response.status >= 400) return { response };
  const value = (response.body as { value?: unknown } | null)?.value;
  if (!Array.isArray(value)) return { response: { ...response, status: 502 } };
  const anchor = asString((value[0] as { id?: unknown } | undefined)?.id);
  return { anchor: anchor ?? null };
}

/**
 * Graph can accept a POST before its marker filter sees the new object. On a
 * duplicate-UPN response, resolve the UPN and insist on the expected marker
 * before adopting it; an unrelated pre-existing account is never adopted.
 */
async function findConflictCreate(
  connection: EntraConnection,
  upn: string,
  marker: string,
): Promise<string | null> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await graphRequest(connection, {
      method: 'GET', path: '/users',
      query: { $filter: `userPrincipalName eq ${odataLiteral(upn)}`, $select: `id,${correlationSelect(connection.correlationField)}`, $top: '2' },
    });
    if (response.status < 400) {
      const item = (response.body as { value?: unknown } | null)?.value;
      if (Array.isArray(item)) {
        const found = item[0];
        if (found && typeof found === 'object' && markerOf(found as Record<string, unknown>, connection.correlationField) === marker) {
          return asString((found as Record<string, unknown>).id) ?? null;
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return null;
}

/** `userPrincipalName` from the correlation key, or why it cannot be. */
function principalName(
  connection: EntraConnection,
  correlationKey: string,
): { upn: string } | { message: string } {
  const key = correlationKey.trim();
  if (key === '') return { message: 'the correlation key is blank' };
  if (key.includes('@')) return { upn: key };
  if (tenantIsDomain(connection.tenantId)) return { upn: `${key}@${connection.tenantId}` };
  return {
    message:
      `the correlation key "${key}" has no domain and tenantId is a directory id, not a domain; ` +
      'either make the correlation key template produce a full userPrincipalName or set tenantId to a verified domain',
  };
}

function managedBody(
  connection: EntraConnection,
  attributes: Record<string, string[]>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const name of connection.managedAttributes) {
    const values = attributes[name];
    if (values === undefined) continue;
    // `null` clears the property; an empty list is how "no value" arrives.
    body[GRAPH_PROPERTY[name]] = values[0] ?? null;
  }
  return body;
}

async function patchUser(
  connection: EntraConnection,
  anchor: string,
  body: Record<string, unknown>,
  what: string,
): Promise<WriteResult> {
  const response = await graphRequest(connection, {
    method: 'PATCH',
    path: `/users/${encodeURIComponent(anchor)}`,
    body,
  });
  if (response.status >= 400) return failed(response);
  return { ok: true, message: what };
}

export interface EntraTargetConnector extends TargetConnector<Config> {
  /**
   * The state of one account after a write: identity, managed fields,
   * enabled state and DIRECT memberships. `complete` is false when the
   * membership read failed; `account` is null when Graph does not (yet) show
   * the object, which is an honest "not observed" and never a verification.
   */
  readBack(config: Config, anchor: string): Promise<TargetReadBack>;
  /**
   * Server-side search of the group catalog, for a picker. Groups outside
   * `groupScope` and dynamic groups are returned marked `manageable: false`
   * with the reason, rather than dropped, so a rule author can see why the
   * group they were looking for cannot be named.
   */
  searchEntitlements(
    config: Config,
    input: { query: string; top?: number },
  ): Promise<DiscoveredEntitlement[]>;
}

const UNVERIFIED_DETAIL =
  'Graph does not publish effective application permissions; record admin consent in the readiness check';

const unverifiedRights = (): ConnectorRight[] =>
  (['createUser', 'modifyUser', 'moveUser', 'modifyMembership'] as const).map((right) => ({
    right,
    status: 'unverified',
    detail: UNVERIFIED_DETAIL,
  }));

export const entraTargetConnector: EntraTargetConnector = {
  async test(raw): Promise<ConnectionResult> {
    const connection = resolveEntraConfig(raw);
    try {
      await graphAccessToken(connection);
    } catch (cause) {
      return {
        ok: false,
        message:
          cause instanceof GraphTokenError
            ? `credential refused: ${cause.message}`
            : `the token endpoint could not be reached: ${cause instanceof Error ? cause.message : String(cause)}`,
      };
    }
    try {
      const probe = async (path: string): Promise<{ count: number } | { message: string }> => {
        const response = await graphRequest(connection, {
          method: 'GET',
          path,
          query: { $top: '1', $select: 'id' },
        });
        if (response.status === 401) {
          return { message: `credential refused on ${path}: ${graphFailureMessage(401, response.body)}` };
        }
        if (response.status === 403) {
          return {
            message: `consent missing on ${path}: ${graphFailureMessage(403, response.body)}; grant admin consent for User.ReadWrite.All, GroupMember.ReadWrite.All and Group.Read.All`,
          };
        }
        if (response.status >= 400) {
          return { message: `${path}: ${graphFailureMessage(response.status, response.body)}` };
        }
        const value = (response.body as { value?: unknown } | null)?.value;
        return { count: Array.isArray(value) ? value.length : 0 };
      };
      const users = await probe('/users');
      if ('message' in users) return { ok: false, message: users.message };
      const groups = await probe('/groups');
      if ('message' in groups) return { ok: false, message: groups.message };
      return {
        ok: true,
        message: `reachable: Microsoft Graph at ${connection.graphBaseUrl} for tenant ${connection.tenantId}`,
        sampleCounts: { user: users.count, group: groups.count, orgUnit: 0 },
        rights: unverifiedRights(),
      };
    } catch (cause) {
      return { ok: false, message: cause instanceof Error ? cause.message : String(cause) };
    }
  },

  async discoverSchema(raw): Promise<SchemaDescriptor> {
    const connection = resolveEntraConfig(raw);
    return {
      objectClasses: ['user', 'group'],
      attributes: ['userPrincipalName', 'accountEnabled', ...connection.managedAttributes].sort(),
    };
  },

  async *read(raw): AsyncIterable<SourceRecord> {
    const connection = resolveEntraConfig(raw);
    let buffer: Record<string, unknown>[] = [];

    const flush = async function* (): AsyncIterable<SourceRecord> {
      if (buffer.length === 0) return;
      const items = buffer;
      buffer = [];
      const anchors = items.map((item) => asString(item.id)).filter((id): id is string => id !== undefined);
      const memberships = await membershipsFor(connection, anchors);
      for (const item of items) {
        const anchor = asString(item.id);
        if (anchor === undefined) continue;
        const membership = memberships.get(anchor);
        const record = Array.isArray(membership)
          ? toRecord(connection, item, membership, undefined)
          : toRecord(
              connection,
              item,
              undefined,
              membership === undefined ? 'the membership read was not answered' : membership.error,
            );
        if (record) yield record;
      }
    };

    for await (const item of graphPaginate(connection, '/users', {
      $select: userSelect(connection),
      $top: '999',
    })) {
      buffer.push(item);
      if (buffer.length >= GRAPH_BATCH_LIMIT) yield* flush();
    }
    yield* flush();
  },

  async *listEntitlements(raw): AsyncIterable<DiscoveredEntitlement> {
    const connection = resolveEntraConfig(raw);
    for await (const item of graphPaginate(connection, '/groups', {
      $select: GROUP_SELECT,
      $top: '999',
    })) {
      const group = groupFacts(item);
      if (group === null) continue;
      const reason = unmanageableReason(connection, group);
      // Out-of-scope kinds are left out of the catalog. A dynamic group that
      // is otherwise in scope is kept, marked unmanageable, so the catalog
      // says what it is rather than pretending it is not there.
      if (reason !== undefined && !group.dynamic) continue;
      yield toEntitlement(group, reason);
    }
  },

  // Entra has no organizational units. An empty set from a reachable target
  // is the honest answer, and it is how `httpJson` spells the same thing.
  async *listContainers(): AsyncIterable<{ dn: string }> {},

  async readEntitlementMembers(raw, entitlementDn): Promise<string[]> {
    const connection = resolveEntraConfig(raw);
    const members: string[] = [];
    // `graphPaginate` throws rather than returning what it managed to fetch,
    // which is what makes this all-or-nothing rather than "as much as we got".
    for await (const member of graphPaginate(
      connection,
      `/groups/${encodeURIComponent(entitlementDn)}/members`,
      { $select: 'id', $top: '999' },
    )) {
      const id = asString(member.id);
      if (id !== undefined) members.push(id);
    }
    return members;
  },

  async readBack(raw, anchor): Promise<TargetReadBack> {
    const connection = resolveEntraConfig(raw);
    const response = await graphRequest(connection, {
      method: 'GET',
      path: `/users/${encodeURIComponent(anchor)}`,
      query: { $select: userSelect(connection) },
    });
    if (response.status === 404) {
      return { account: null, entitlementIds: [], enabled: null, complete: true };
    }
    if (response.status >= 400) {
      throw new Error(graphFailureMessage(response.status, response.body));
    }
    const item = (response.body ?? {}) as Record<string, unknown>;
    const enabled = typeof item.accountEnabled === 'boolean' ? item.accountEnabled : null;
    try {
      const groups = await directGroupIds(connection, anchor);
      const account = toRecord(connection, item, groups, undefined);
      return { account, entitlementIds: [...groups].sort(), enabled, complete: enabled !== null };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const account = toRecord(connection, item, undefined, message);
      return { account, entitlementIds: [], enabled, complete: false };
    }
  },

  async searchEntitlements(raw, input): Promise<DiscoveredEntitlement[]> {
    const connection = resolveEntraConfig(raw);
    const query = input.query.trim();
    const top = String(Math.max(1, Math.min(100, input.top ?? 25)));
    if (query === '') return [];

    let response = await graphRequest(connection, {
      method: 'GET',
      path: '/groups',
      query: {
        $search: `"displayName:${query.replace(/"/g, '')}"`,
        $count: 'true',
        $top: top,
        $select: GROUP_SELECT,
      },
      headers: EVENTUAL,
    });
    if (response.status === 400) {
      // Advanced queries can be refused (a tenant on a sovereign cloud, a
      // proxy that strips the header). `startswith` is the ordinary query.
      response = await graphRequest(connection, {
        method: 'GET',
        path: '/groups',
        query: {
          $filter: `startswith(displayName,${odataLiteral(query)})`,
          $top: top,
          $select: GROUP_SELECT,
        },
      });
    }
    if (response.status >= 400) {
      throw new Error(graphFailureMessage(response.status, response.body));
    }
    const value = (response.body as { value?: unknown } | null)?.value;
    if (!Array.isArray(value)) throw new Error('Graph did not answer with a "value" array');
    const out: DiscoveredEntitlement[] = [];
    for (const item of value) {
      if (item === null || typeof item !== 'object') continue;
      const group = groupFacts(item as Record<string, unknown>);
      if (group === null) continue;
      out.push(toEntitlement(group, unmanageableReason(connection, group)));
    }
    return out;
  },

  async write(raw, op: WriteOperation): Promise<WriteResult> {
    const connection = resolveEntraConfig(raw);
    try {
      // `await`, not a bare `return`: a rejected promise returned from inside
      // a try block is not caught by it.
      return await performWrite(connection, op);
    } catch (cause) {
      return thrown(cause);
    }
  },
};

async function performWrite(connection: EntraConnection, op: WriteOperation): Promise<WriteResult> {
      switch (op.op) {
        case 'create_container':
          return {
            ok: false,
            message:
              'Microsoft Entra ID has no organizational units or containers: accounts are not placed anywhere, so there is nothing for a container to be materialised at',
            failure: 'rejected',
          };

        case 'create_account': {
          // FIRST, look for the object a previous attempt made. A create is
          // the one non-idempotent write, and the marker is what makes a
          // retry safe.
          const marker = markerForAction(connection.correlationField, op.actionId);
          const existing = await findByMarker(connection, marker);
          if ('response' in existing) return failed(existing.response);
          if (existing.anchor !== null) {
            return {
              ok: true,
              message: 'an account carrying this action\'s correlation marker already exists and was adopted',
              anchor: existing.anchor,
            };
          }
          const named = principalName(connection, op.correlationKey);
          if ('message' in named) return { ok: false, message: named.message, failure: 'rejected' };
          const local = named.upn.slice(0, named.upn.indexOf('@'));
          const managed = managedBody(connection, op.attributes);
          const response = await graphRequest(connection, {
            method: 'POST',
            path: '/users',
            body: {
              accountEnabled: op.enabled,
              userPrincipalName: named.upn,
              // Graph requires both; the local part is the honest default.
              mailNickname: local.replace(/[^A-Za-z0-9._-]/g, ''),
              displayName: managed.displayName ?? op.attributes.displayName?.[0] ?? local,
              passwordProfile: {
                password: op.initialPassword,
                forceChangePasswordNextSignIn: true,
              },
              ...managed,
              ...markerBody(connection.correlationField, marker),
            },
          });
          if (response.status >= 400) {
            const result = failed(response);
            if (
              response.status === 409 ||
              (response.status === 400 &&
                /userPrincipalName|already exists|ObjectConflict/i.test(graphErrorMessage(response.body)))
            ) {
              const adopted = await findConflictCreate(connection, named.upn, marker);
              if (adopted !== null) {
                return { ok: true, message: 'an account carrying this action\'s correlation marker became visible and was adopted', anchor: adopted };
              }
              return { ...result, failure: 'conflict', message: `${result.message}: userPrincipalName ${named.upn} is taken` };
            }
            return result;
          }
          const anchor = asString((response.body as { id?: unknown } | null)?.id);
          return {
            ok: true,
            message: 'account created',
            ...(anchor === undefined ? {} : { anchor }),
          };
        }

        case 'update_account': {
          // The intersection of what was asked and what is managed. Never
          // the UPN, never accountEnabled, never the marker: `managedBody`
          // can only name a property in `ENTRA_ATTRIBUTE_MAP`.
          const body = managedBody(connection, op.attributes);
          if (Object.keys(body).length === 0) {
            return { ok: true, message: 'nothing among the managed attributes to update' };
          }
          return patchUser(connection, op.anchor, body, 'account updated');
        }

        case 'enable_account':
          return patchUser(connection, op.anchor, { accountEnabled: true }, 'account enabled');

        case 'disable_account':
          return patchUser(connection, op.anchor, { accountEnabled: false }, 'account disabled');

        case 'archive_account': {
          // The entitlements come off FIRST, and a failure to remove one stops
          // the archive: an archived account still holding what Provision
          // manages is access left in place behind an object nobody looks at.
          for (const groupId of op.entitlementDns) {
            const revoked = await revokeMembership(connection, groupId, op.anchor);
            if (!revoked.ok) return revoked;
          }
          // Then disable. There is no container to move to and nothing is
          // deleted -- the matrix says `deleteAccount: never`, and this is
          // the code that makes it true.
          return patchUser(connection, op.anchor, { accountEnabled: false }, 'account archived: managed memberships removed and account disabled');
        }

        case 'rename_account': {
          const named = principalName(connection, op.correlationKey);
          if ('message' in named) return { ok: false, message: named.message, failure: 'rejected' };
          const local = named.upn.slice(0, named.upn.indexOf('@'));
          return patchUser(
            connection,
            op.anchor,
            { userPrincipalName: named.upn, mailNickname: local.replace(/[^A-Za-z0-9._-]/g, '') },
            'account renamed',
          );
        }

        case 'grant_entitlement':
          return grantMembership(connection, op.entitlementId, op.anchor, new Map());

        case 'revoke_entitlement':
          return revokeMembership(connection, op.entitlementId, op.anchor);
      }
}
