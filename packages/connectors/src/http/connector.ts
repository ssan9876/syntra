import type {
  ConnectionResult,
  DiscoveredEntitlement,
  SchemaDescriptor,
  SourceRecord,
  TargetConnector,
  WriteOperation,
  WriteResult,
} from '../types.js';
import {
  classify,
  httpRequest,
  paginate,
  readPath,
  retryAfterMs,
} from './client.js';
import {
  httpTargetConfigSchema,
  type HttpTargetConfig,
  type ResolvedHttpConnectorDocument,
  type ResolvedHttpTargetConfig,
  type WriteSpec,
} from './document.js';
import { MISSING, renderBody, renderPath, type TemplateVars } from './template.js';

type Config = HttpTargetConfig & { credential: string };
type Resolved = ResolvedHttpTargetConfig & { credential: string };

function normalise(config: Config): Resolved {
  const { credential, ...rest } = config;
  return { ...httpTargetConfigSchema.parse(rest), credential };
}

/** A JSON scalar as the single-valued attribute string Syntra stores. */
function asValues(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) {
    const flat = value.filter((v) => v !== null && typeof v !== 'object').map(String);
    return flat.length > 0 ? flat : undefined;
  }
  if (typeof value === 'object') return undefined;
  return [String(value)];
}

/**
 * One item from the target's collection, as a `SourceRecord`.
 *
 * Returns null when the item has no anchor. That is not a tolerable record: an
 * anchor is the identity, and a record without one cannot be correlated,
 * cannot be diffed and cannot be written back to — it would look like a new
 * account on every single run. Skipped and counted rather than invented.
 */
function toRecord(
  document: ResolvedHttpConnectorDocument,
  item: unknown,
): SourceRecord | null {
  const anchor = asValues(readPath(item, document.account.anchorAt))?.[0];
  if (anchor === undefined) return null;

  const attributes: Record<string, string[]> = {};
  for (const [targetField, syntraName] of Object.entries(document.account.fields)) {
    const values = asValues(readPath(item, targetField));
    if (values) attributes[syntraName] = values;
  }

  const correlation = document.account.correlationAt
    ? asValues(readPath(item, document.account.correlationAt))?.[0]
    : undefined;

  return {
    anchor,
    objectType: 'user',
    // These targets have no directory tree. The anchor stands in for the DN so
    // that everything downstream keyed on one keeps working, and correlation
    // is carried as an attribute rather than smuggled into a fake DN.
    dn: correlation ?? anchor,
    attributes,
  };
}

async function runWrite(
  config: Resolved,
  spec: WriteSpec | undefined,
  vars: TemplateVars,
  what: string,
): Promise<WriteResult> {
  if (spec === undefined) {
    // Not a failure to retry. The document does not describe this operation,
    // and it will not describe it on the third attempt either.
    return { ok: false, message: `this target cannot ${what}`, failure: 'rejected' };
  }

  const { document, credential } = config;
  let path: string;
  try {
    path = renderPath(spec.path, vars);
  } catch (cause) {
    return {
      ok: false,
      message: cause instanceof Error ? cause.message : String(cause),
      failure: 'rejected',
    };
  }

  const body = spec.body === undefined ? undefined : renderBody(spec.body, vars);
  const response = await httpRequest(document, credential, {
    method: spec.method,
    path,
    query: spec.query,
    ...(body === undefined || body === MISSING ? {} : { body }),
  });

  if (response.status >= 400) {
    const failure = classify(document, response.status);
    const after = retryAfterMs(response.headers);
    return {
      ok: false,
      // The STATUS, never the response body. A target's error text can quote
      // back what was sent, and what was sent may include an initial password.
      message: `the target answered HTTP ${response.status}`,
      failure,
      ...(failure === 'throttled' && after !== undefined ? { retryAfterMs: after } : {}),
    };
  }

  const anchor = spec.anchorAt
    ? asValues(readPath(response.body, spec.anchorAt))?.[0]
    : undefined;
  return { ok: true, message: what, ...(anchor === undefined ? {} : { anchor }) };
}

/**
 * A target connector driven entirely by a JSON document.
 *
 * See `document.ts` for why this exists instead of a script host, and for the
 * two structural rules it enforces: no `DELETE` on an account operation, and
 * no expression language anywhere.
 */
export const httpTargetConnector: TargetConnector<Config> = {
  async test(raw) {
    const config = normalise(raw);
    const { document, credential } = config;
    try {
      const response = await httpRequest(document, credential, {
        method: 'GET',
        path: document.account.list.path,
        query: document.account.list.query,
      });
      if (response.status === 401 || response.status === 403) {
        return { ok: false, message: 'the credential was refused' };
      }
      if (response.status >= 400) {
        return { ok: false, message: `the target answered HTTP ${response.status}` };
      }
      const items = document.account.list.itemsAt
        ? readPath(response.body, document.account.list.itemsAt)
        : response.body;
      if (!Array.isArray(items)) {
        return {
          ok: false,
          message: document.account.list.itemsAt
            ? `the response has no array at "${document.account.list.itemsAt}"`
            : 'the response was not an array',
        };
      }
      return {
        ok: true,
        message: `reached ${document.name}`,
        sampleCounts: { user: items.length, group: 0, orgUnit: 0 },
        // The rights this connector needs cannot be read from a REST API that
        // does not publish them, and `unverified` is deliberately not a polite
        // `granted` — see `ConnectorRight`.
        rights: [
          { right: 'createUser', status: 'unverified', detail: 'not published by this API' },
          { right: 'modifyUser', status: 'unverified', detail: 'not published by this API' },
          { right: 'moveUser', status: 'unverified', detail: 'not published by this API' },
          {
            right: 'modifyMembership',
            status: 'unverified',
            detail: 'not published by this API',
          },
        ],
      };
    } catch (cause) {
      return { ok: false, message: cause instanceof Error ? cause.message : String(cause) };
    }
  },

  async discoverSchema(raw): Promise<SchemaDescriptor> {
    const { document } = normalise(raw);
    // From the document, not from the wire. A REST API has no schema endpoint
    // to interrogate, and the mapped fields are exactly the ones this
    // connector can read or write — which is the question the caller is
    // asking.
    return {
      objectClasses: ['user'],
      attributes: [...new Set(Object.values(document.account.fields))].sort(),
    };
  },

  async *read(raw): AsyncIterable<SourceRecord> {
    const config = normalise(raw);
    for await (const item of paginate(
      config.document,
      config.credential,
      config.document.account.list,
    )) {
      const record = toRecord(config.document, item);
      if (record) yield record;
    }
  },

  async *listEntitlements(raw): AsyncIterable<DiscoveredEntitlement> {
    const config = normalise(raw);
    const spec = config.document.entitlement;
    if (!spec) return;
    for await (const item of paginate(config.document, config.credential, spec.list)) {
      const externalId = asValues(readPath(item, spec.anchorAt))?.[0];
      const displayName = asValues(readPath(item, spec.displayNameAt))?.[0];
      if (externalId === undefined || displayName === undefined) continue;
      const description = spec.descriptionAt
        ? asValues(readPath(item, spec.descriptionAt))?.[0]
        : undefined;
      yield {
        externalId,
        // No directory tree here either. Memberships come back as ids, so the
        // id is what a membership resolves against.
        dn: externalId,
        type: spec.type,
        displayName,
        ...(description === undefined ? {} : { description }),
      };
    }
  },

  async *listContainers(raw): AsyncIterable<{ dn: string }> {
    const config = normalise(raw);
    const spec = config.document.container;
    // Nothing, not everything. A target with no containers is one where an
    // account is not placed anywhere, and `listContainers` yielding nothing is
    // how that is already spelled.
    if (!spec) return;
    for await (const item of paginate(config.document, config.credential, spec.list)) {
      const dn = asValues(readPath(item, spec.dnAt))?.[0];
      if (dn !== undefined) yield { dn };
    }
  },

  async readEntitlementMembers(raw, entitlementDn): Promise<string[]> {
    const config = normalise(raw);
    const spec = config.document.entitlement?.members;
    if (!spec) {
      // Thrown, not returned empty. An empty list is indistinguishable from a
      // group with no members, and the run would propose revoking the
      // entitlement from everybody who holds it. Throwing marks the
      // entitlement `unreadable`, which makes every rule naming it
      // unresolvable rather than silently destructive.
      throw new Error('this target does not describe how to read a membership');
    }

    const members: string[] = [];
    // `paginate` throws rather than returning what it managed to fetch, which
    // is what makes this all-or-nothing rather than "as much as we got".
    for await (const item of paginate(config.document, config.credential, {
      ...spec,
      path: renderPath(spec.path, { entitlementId: entitlementDn, anchor: entitlementDn }),
    })) {
      const member = asValues(readPath(item, spec.memberAnchorAt))?.[0];
      if (member !== undefined) members.push(member);
    }
    return members;
  },

  async write(raw, op: WriteOperation): Promise<WriteResult> {
    const config = normalise(raw);
    const account = config.document.account;
    const entitlement = config.document.entitlement;

    switch (op.op) {
      case 'create_account':
        return runWrite(
          config,
          account.create,
          {
            actionId: op.actionId,
            correlationKey: op.correlationKey,
            attributes: op.attributes,
            enabled: op.enabled,
            initialPassword: op.initialPassword,
          },
          'create an account',
        );

      case 'update_account':
        return runWrite(
          config,
          account.update,
          { actionId: op.actionId, anchor: op.anchor, attributes: op.attributes },
          'update an account',
        );

      case 'enable_account':
        return runWrite(
          config,
          account.enable,
          { actionId: op.actionId, anchor: op.anchor, enabled: true },
          'enable an account',
        );

      case 'disable_account':
        return runWrite(
          config,
          account.disable,
          { actionId: op.actionId, anchor: op.anchor, enabled: false, reason: op.reason },
          'disable an account',
        );

      case 'archive_account': {
        // The entitlements come off FIRST, and a failure to remove one stops
        // the archive. Archiving an account while it still holds the
        // entitlements Provision manages leaves access in place behind an
        // object nobody looks at any more, which is the opposite of what
        // archiving is for.
        for (const entitlementId of op.entitlementDns) {
          const revoked = await runWrite(
            config,
            entitlement?.revoke,
            { actionId: op.actionId, anchor: op.anchor, entitlementId },
            'revoke an entitlement',
          );
          if (!revoked.ok) return revoked;
        }
        return runWrite(
          config,
          account.archive,
          { actionId: op.actionId, anchor: op.anchor, enabled: false },
          'archive an account',
        );
      }

      case 'rename_account':
        return runWrite(
          config,
          account.rename,
          { actionId: op.actionId, anchor: op.anchor, correlationKey: op.correlationKey },
          'rename an account',
        );

      case 'grant_entitlement':
        return runWrite(
          config,
          entitlement?.grant,
          { actionId: op.actionId, anchor: op.anchor, entitlementId: op.entitlementId },
          'grant an entitlement',
        );

      case 'revoke_entitlement':
        return runWrite(
          config,
          entitlement?.revoke,
          { actionId: op.actionId, anchor: op.anchor, entitlementId: op.entitlementId },
          'revoke an entitlement',
        );
    }
  },
};
