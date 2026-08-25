import type {
  ConnectionResult,
  DiscoveredEntitlement,
  SchemaDescriptor,
  SourceRecord,
  TargetConnector,
  WriteOperation,
  WriteResult,
} from '../types.js';
import { withProvenanceMarker } from '../ad/provenance.js';
import { scim2TargetConfigSchema, type ResolvedScim2TargetConfig, type Scim2TargetConfig } from './config.js';
import { scimRequest } from './client.js';

type Config = Scim2TargetConfig & { bearerToken: string };
type Resolved = ResolvedScim2TargetConfig & { bearerToken: string };

function normalise(config: Config): Resolved {
  const { bearerToken, ...rest } = config;
  return { ...scim2TargetConfigSchema.parse(rest), bearerToken };
}

interface ScimUserResource {
  id: string;
  userName: string;
  externalId?: string | null;
  active?: boolean;
  name?: { givenName?: string; familyName?: string };
  emails?: { value: string }[];
  title?: string;
}

interface ScimGroupResource {
  id: string;
  displayName: string;
  members?: { value: string }[];
}

function attributesToScim(attributes: Record<string, string[]>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const name: Record<string, string> = {};
  for (const [key, values] of Object.entries(attributes)) {
    const value = values[0];
    if (value === undefined) continue;
    if (key === 'name.givenName') {
      name.givenName = value;
      continue;
    }
    if (key === 'name.familyName') {
      name.familyName = value;
      continue;
    }
    if (key === 'emails') {
      out.emails = [{ value, primary: true }];
      continue;
    }
    out[key] = value;
  }
  if (Object.keys(name).length > 0) out.name = name;
  return out;
}

function attributesToPatchOps(
  attributes: Record<string, string[]>,
): { op: 'replace'; path: string; value: unknown }[] {
  const scim = attributesToScim(attributes);
  return Object.entries(scim).map(([path, value]) => ({ op: 'replace' as const, path, value }));
}

function scimErrorMessage(result: { status: number; json: unknown }): string {
  const detail = (result.json as { detail?: string } | null)?.detail;
  return detail ?? `the server answered HTTP ${result.status}`;
}

function classifyFailure(status: number): 'unauthorized' | 'conflict' | 'rejected' | 'transient' {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 409) return 'conflict';
  if (status >= 500) return 'transient';
  return 'rejected';
}

async function patchUser(
  config: Resolved,
  anchor: string,
  operations: { op: string; path?: string; value?: unknown }[],
): Promise<WriteResult> {
  const result = await scimRequest(
    config,
    'PATCH',
    `${config.userResourcePath}/${anchor}`,
    { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: operations },
  );
  if (result.status === 404) return { ok: false, message: 'no such account', failure: 'not_found' };
  if (result.status >= 400) {
    return { ok: false, message: scimErrorMessage(result), failure: classifyFailure(result.status) };
  }
  return { ok: true, message: 'updated' };
}

async function patchGroupMembers(
  config: Resolved,
  groupId: string,
  op: 'add' | 'remove',
  memberId: string,
): Promise<WriteResult> {
  const operation =
    op === 'add'
      ? { op: 'add' as const, path: 'members', value: [{ value: memberId }] }
      : { op: 'remove' as const, path: `members[value eq "${memberId}"]` };
  const result = await scimRequest(
    config,
    'PATCH',
    `${config.groupResourcePath}/${groupId}`,
    { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [operation] },
  );
  if (result.status === 404) return { ok: false, message: 'no such group', failure: 'not_found' };
  if (result.status >= 400) {
    return { ok: false, message: scimErrorMessage(result), failure: classifyFailure(result.status) };
  }
  return { ok: true, message: op === 'add' ? 'granted' : 'revoked' };
}

/**
 * A SCIM 2.0 (RFC 7644) target connector — the same standard HelloID itself
 * relies on for most of its integration count. Talks to `Users`/`Groups`
 * collections over bearer-authenticated HTTPS, through `guardedFetch` so the
 * same SSRF protection every other outbound-fetching connector gets applies
 * here too.
 *
 * `archive_account` never issues `DELETE /Users/{id}` — it disables and strips
 * the managed group memberships, mirroring the Active Directory connector's
 * no-delete rule (spec §9, §15) exactly.
 */
export const scimTargetConnector: TargetConnector<Config> = {
  async test(rawConfig): Promise<ConnectionResult> {
    const config = normalise(rawConfig);
    try {
      const usersResult = await scimRequest(
        config,
        'GET',
        `${config.userResourcePath}?startIndex=1&count=1`,
      );
      if (usersResult.status === 401 || usersResult.status === 403) {
        return { ok: false, message: `the server refused the bearer token (HTTP ${usersResult.status})` };
      }
      if (usersResult.status >= 400) {
        return { ok: false, message: `${config.userResourcePath} answered HTTP ${usersResult.status}` };
      }
      const groupsResult = await scimRequest(
        config,
        'GET',
        `${config.groupResourcePath}?startIndex=1&count=1`,
      );
      return {
        ok: groupsResult.status < 400,
        message:
          groupsResult.status < 400
            ? 'connected; users and groups are both reachable'
            : `${config.groupResourcePath} answered HTTP ${groupsResult.status}`,
      };
    } catch (cause) {
      return { ok: false, message: cause instanceof Error ? cause.message : String(cause) };
    }
  },

  async discoverSchema(rawConfig): Promise<SchemaDescriptor> {
    const config = normalise(rawConfig);
    // RFC 7643 §7 defines a `/Schemas` endpoint, but it is optional and many
    // real deployments do not implement it. Rather than fail discovery
    // outright on a server that omits it, this reports the fixed core-schema
    // attribute set every SCIM 2.0 User/Group resource is required to carry.
    const result = await scimRequest(config, 'GET', '/Schemas');
    if (result.status < 400 && Array.isArray((result.json as { Resources?: unknown[] } | null)?.Resources)) {
      const resources = (result.json as { Resources: { attributes?: { name: string }[] }[] }).Resources;
      const attributes = resources.flatMap((r) => (r.attributes ?? []).map((a) => a.name));
      return { objectClasses: ['User', 'Group'], attributes: [...new Set(attributes)] };
    }
    return {
      objectClasses: ['User', 'Group'],
      attributes: ['userName', 'externalId', 'active', 'name.givenName', 'name.familyName', 'emails', 'title'],
    };
  },

  async *read(rawConfig): AsyncIterable<SourceRecord> {
    const config = normalise(rawConfig);
    let startIndex = 1;
    for (;;) {
      const result = await scimRequest(
        config,
        'GET',
        `${config.userResourcePath}?startIndex=${startIndex}&count=${config.pageSize}`,
      );
      if (result.status >= 400) {
        throw new Error(`${config.userResourcePath} answered HTTP ${result.status} while reading`);
      }
      const page = result.json as { Resources: ScimUserResource[]; totalResults: number };
      for (const resource of page.Resources) {
        yield {
          anchor: resource.id,
          objectType: 'user' as const,
          // SCIM has no distinguished-name concept; `id` is the address, so it
          // is the honest value here rather than a placeholder.
          dn: resource.id,
          attributes: {
            userName: [resource.userName],
            ...(resource.externalId ? { externalId: [resource.externalId] } : {}),
            active: [String(resource.active ?? true)],
            ...(resource.name?.givenName ? { 'name.givenName': [resource.name.givenName] } : {}),
            ...(resource.name?.familyName ? { 'name.familyName': [resource.name.familyName] } : {}),
            ...(resource.emails?.[0]?.value ? { emails: [resource.emails[0].value] } : {}),
            ...(resource.title ? { title: [resource.title] } : {}),
          },
        };
      }
      if (page.Resources.length < config.pageSize || startIndex + page.Resources.length > page.totalResults) {
        return;
      }
      startIndex += page.Resources.length;
    }
  },

  async write(rawConfig, op: WriteOperation): Promise<WriteResult> {
    const config = normalise(rawConfig);
    try {
      switch (op.op) {
        case 'create_account': {
          const body: Record<string, unknown> = {
            schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
            userName: op.correlationKey,
            // RFC 7643 §3.1's `externalId`: the field the spec designates for a
            // provisioning client's own correlation marker, so SCIM needs no
            // `provenanceAttribute`-style configuration the way Active
            // Directory does.
            externalId: withProvenanceMarker(undefined, op.actionId),
            active: op.enabled,
            password: op.initialPassword,
            ...attributesToScim(op.attributes),
          };
          const result = await scimRequest(config, 'POST', config.userResourcePath, body);
          if (result.status >= 400) {
            return { ok: false, message: scimErrorMessage(result), failure: classifyFailure(result.status) };
          }
          const created = result.json as { id: string };
          return { ok: true, message: 'created', anchor: created.id };
        }
        case 'update_account':
          return await patchUser(config, op.anchor, attributesToPatchOps(op.attributes));
        case 'enable_account':
        case 'disable_account':
          return await patchUser(config, op.anchor, [
            { op: 'replace', path: 'active', value: op.op === 'enable_account' },
          ]);
        case 'rename_account':
          return await patchUser(config, op.anchor, [
            { op: 'replace', path: 'userName', value: op.correlationKey },
          ]);
        case 'archive_account': {
          const disabled = await patchUser(config, op.anchor, [
            { op: 'replace', path: 'active', value: false },
          ]);
          if (!disabled.ok) return disabled;
          for (const groupId of op.entitlementDns) {
            const revoked = await patchGroupMembers(config, groupId, 'remove', op.anchor);
            if (!revoked.ok && revoked.failure !== 'not_found') return revoked;
          }
          return { ok: true, message: 'archived' };
        }
        case 'grant_entitlement':
          return await patchGroupMembers(config, op.entitlementId, 'add', op.anchor);
        case 'revoke_entitlement':
          return await patchGroupMembers(config, op.entitlementId, 'remove', op.anchor);
        default:
          op satisfies never;
          throw new Error(`unsupported operation for the SCIM connector: ${(op as { op: string }).op}`);
      }
    } catch (cause) {
      return {
        ok: false,
        message: cause instanceof Error ? cause.message : String(cause),
        failure: 'transient',
      };
    }
  },

  async *listEntitlements(rawConfig): AsyncIterable<DiscoveredEntitlement> {
    const config = normalise(rawConfig);
    let startIndex = 1;
    for (;;) {
      const result = await scimRequest(
        config,
        'GET',
        `${config.groupResourcePath}?startIndex=${startIndex}&count=${config.pageSize}`,
      );
      if (result.status >= 400) {
        throw new Error(`${config.groupResourcePath} answered HTTP ${result.status} while listing entitlements`);
      }
      const page = result.json as { Resources: ScimGroupResource[]; totalResults: number };
      for (const resource of page.Resources) {
        yield {
          externalId: resource.id,
          dn: resource.id,
          type: 'group' as const,
          displayName: resource.displayName,
        };
      }
      if (page.Resources.length < config.pageSize || startIndex + page.Resources.length > page.totalResults) {
        return;
      }
      startIndex += page.Resources.length;
    }
  },

  // eslint-disable-next-line @typescript-eslint/require-await -- interface requires an async iterable
  async *listContainers(): AsyncIterable<{ dn: string }> {
    // SCIM has no organizational-unit concept: there is nowhere for an
    // account to be placed other than the flat `Users` collection.
    return;
  },

  async readEntitlementMembers(rawConfig, entitlementDn): Promise<string[]> {
    const config = normalise(rawConfig);
    const result = await scimRequest(config, 'GET', `${config.groupResourcePath}/${entitlementDn}`);
    if (result.status >= 400) {
      throw new Error(
        `${config.groupResourcePath}/${entitlementDn} answered HTTP ${result.status} while reading membership`,
      );
    }
    const group = result.json as ScimGroupResource;
    return (group.members ?? []).map((m) => m.value);
  },
};
