import {
  completeReadBack,
  observedEnabled,
  readBackByEnumeration,
  type AccountPreview,
  type DiscoveredEntitlement,
  type SchemaDescriptor,
  type SourceRecord,
  type TargetConnector,
  type TargetReadBack,
  type WriteOperation,
  type WriteResult,
} from '../types.js';
import {
  bodyFailure,
  errorFailure,
  firstPageQuery,
  FormBodyError,
  httpRequest,
  pageItems,
  paginate,
  readPath,
  readRequest,
  retryAfterMs,
} from './client.js';
import {
  httpTargetConfigSchema,
  type FieldEquals,
  type HttpTargetConfig,
  type ResolvedHttpConnectorDocument,
  type ResolvedHttpTargetConfig,
  type WriteSpec,
} from './document.js';
import { MISSING, renderBody, renderParams, renderPath, type TemplateVars } from './template.js';

// Every target connector is handed its vault value as `bindPassword` by core.
// HTTP targets do not bind to a directory, but keeping the shared input name
// here is essential: treating it as a connector-private `credential` field
// meant OAuth serialised `undefined` as the client_secret.
type Config = HttpTargetConfig & { bindPassword: string };
type Resolved = ResolvedHttpTargetConfig & { credential: string };

function normalise(config: Config): Resolved {
  const { bindPassword, ...rest } = config;
  return { ...httpTargetConfigSchema.parse(rest), credential: bindPassword };
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
  const enabledWhen = document.account.enabledWhen;
  if (enabledWhen) {
    const actual = asValues(readPath(item, enabledWhen.at))?.[0];
    if (actual !== undefined) attributes.enabled = [String(actual === enabledWhen.equals)];
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

const PREVIEW_ACCOUNTS = 5;

/**
 * The first page as the connector will read it, for the connection test: the
 * mapped accounts, how many were skipped, and the fields it leaves unread.
 * Field NAMES only for the unread ones; their values stay at the target.
 */
function accountPreview(document: ResolvedHttpConnectorDocument, items: unknown[]): AccountPreview {
  const accounts: AccountPreview['accounts'] = [];
  let skipped = 0;
  for (const item of items) {
    const record = excluded(document.account.exclude, item) ? null : toRecord(document, item);
    if (record === null) {
      skipped += 1;
      continue;
    }
    if (accounts.length < PREVIEW_ACCOUNTS) {
      accounts.push({
        anchor: record.anchor,
        name: record.dn,
        enabled: observedEnabled(record),
        attributes: record.attributes,
      });
    }
  }

  const account = document.account;
  const read = new Set(
    [
      account.anchorAt,
      account.correlationAt,
      account.enabledWhen?.at,
      account.provenance?.path,
      ...Object.keys(account.fields),
      ...account.exclude.map((rule) => rule.at),
    ]
      .filter((path): path is string => path !== undefined)
      .flatMap((path) => [path, path.split('.')[0]]),
  );
  const first = items.find((item) => item !== null && typeof item === 'object' && !Array.isArray(item));
  const unreadFields = first
    ? Object.keys(first).filter((key) => !read.has(key)).sort()
    : [];
  return { accounts, skipped, unreadFields };
}

/** Whether the item matches one of `account.exclude`. */
function excluded(rules: readonly FieldEquals[], item: unknown): boolean {
  return rules.some((rule) => asValues(readPath(item, rule.at))?.[0] === rule.equals);
}

function provenanceValues(
  item: unknown,
  selector: NonNullable<ResolvedHttpConnectorDocument['account']['provenance']>,
): string[] {
  if (selector.kind === 'scalar') return asValues(readPath(item, selector.path)) ?? [];
  const collection = readPath(item, selector.path);
  if (!Array.isArray(collection)) return [];
  return collection.flatMap((entry) => {
    if (selector.whereAt !== undefined) {
      const actual = asValues(readPath(entry, selector.whereAt))?.[0];
      if (actual !== selector.whereEquals) return [];
    }
    return asValues(readPath(entry, selector.valueAt)) ?? [];
  });
}

async function findCreateCollision(
  config: Resolved,
  correlationKey: string,
): Promise<unknown | undefined> {
  const { document, credential } = config;
  const correlationAt = document.account.correlationAt;
  if (correlationAt === undefined) return undefined;
  const wanted = correlationKey.toLocaleLowerCase();
  const candidates = document.account.find
    ? findCandidates(config, correlationKey)
    : paginate(document, credential, document.account.list);
  for await (const item of candidates) {
    const correlation = asValues(readPath(item, correlationAt))?.[0];
    if (correlation?.toLocaleLowerCase() === wanted) return item;
  }
  return undefined;
}

/**
 * What `account.find` answers for one correlation key: a list, or with no
 * paging a single object, and nothing for a not-found status.
 */
async function* findCandidates(config: Resolved, correlationKey: string): AsyncIterable<unknown> {
  const { document, credential } = config;
  const spec = document.account.find;
  if (spec === undefined) return;
  const vars = { correlationKey };
  const path = renderPath(spec.path, vars);
  if (spec.paging.style !== 'none') {
    yield* paginate(document, credential, { ...spec, path }, vars);
    return;
  }
  const response = await readRequest(document, credential, {
    path,
    query: firstPageQuery(spec, vars),
  });
  if (response.status >= 400) {
    const failed = errorFailure(document, response, [credential]);
    if (failed.failure === 'not_found') return;
    throw new Error(`Looking up ${correlationKey} failed: ${failed.message}`);
  }
  const refused = bodyFailure(document, response.body, [credential]);
  if (refused) {
    if (refused.failure === 'not_found') return;
    throw new Error(`Looking up ${correlationKey} failed: ${refused.message}`);
  }
  const found = spec.itemsAt ? readPath(response.body, spec.itemsAt) : response.body;
  if (Array.isArray(found)) yield* found;
  else if (found !== null && typeof found === 'object') yield found;
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
  let response;
  try {
    response = await httpRequest(document, credential, {
      method: spec.method,
      path,
      query: renderParams(spec.query, vars),
      headers: renderParams(spec.headers, vars),
      bodyFormat: spec.bodyFormat,
      ...(body === undefined || body === MISSING ? {} : { body }),
    });
  } catch (cause) {
    if (cause instanceof FormBodyError) return { ok: false, message: cause.message, failure: 'rejected' };
    throw cause;
  }

  if (response.status >= 400) {
    // The status, and the target's own message only where `failures.error`
    // names it, redacted: a target's error text can quote back what was
    // sent, and what was sent may include an initial password.
    const { failure, message } = errorFailure(document, response, [credential, vars.initialPassword]);
    const after = retryAfterMs(response.headers);
    return {
      ok: false,
      message,
      failure,
      ...(failure === 'throttled' && after !== undefined ? { retryAfterMs: after } : {}),
    };
  }

  // A 2xx is not yet a success for a target that reports refusals in the
  // body. Its explanation is the target's own words, redacted, and never the
  // request that provoked them.
  const refused = bodyFailure(document, response.body, [credential, vars.initialPassword]);
  if (refused) return { ok: false, message: refused.message, failure: refused.failure };

  const anchor = spec.anchorAt
    ? asValues(readPath(response.body, spec.anchorAt))?.[0]
    : undefined;
  return { ok: true, message: what, ...(anchor === undefined ? {} : { anchor }) };
}

/** Whether `attributes` carries a non-empty value for `name`. */
function hasValue(attributes: Record<string, string[]> | undefined, name: string): boolean {
  if (attributes === undefined || !Object.hasOwn(attributes, name)) return false;
  return (attributes[name] ?? []).some((value) => value.trim() !== '');
}

/** An account's follow-up writes, in order, stopping at the first that fails. */
async function runFollowUps(
  config: Resolved,
  specs: (WriteSpec & { when: string })[],
  vars: TemplateVars,
): Promise<WriteResult> {
  for (const [index, spec] of specs.entries()) {
    const result = await runWrite(config, spec, vars, `run follow-up ${index + 1} (${spec.when})`);
    if (!result.ok) return { ...result, message: `follow-up ${spec.method} ${spec.path} failed: ${result.message}` };
  }
  return { ok: true, message: 'follow-ups' };
}

/**
 * A target connector driven entirely by a JSON document.
 *
 * See `document.ts` for why this exists instead of a script host, and for the
 * two structural rules it enforces: no `DELETE` on an account operation, and
 * no expression language anywhere.
 */
export const httpTargetConnector: TargetConnector<Config> & {
  readBack(config: Config, anchor: string): Promise<TargetReadBack>;
} = {
  async test(raw) {
    const config = normalise(raw);
    const { document, credential } = config;
    const list = document.account.list;
    try {
      const response = await readRequest(document, credential, {
        path: list.path,
        query: firstPageQuery(list),
      });
      if (response.status === 401 || response.status === 403) {
        return { ok: false, message: 'the credential was refused' };
      }
      if (response.status >= 400) {
        return { ok: false, message: errorFailure(document, response, [credential]).message };
      }
      const refused = bodyFailure(document, response.body, [credential]);
      if (refused) return { ok: false, message: refused.message };
      const items = pageItems(list, response.body);
      return {
        ok: true,
        message: `Connected to ${document.name}`,
        sampleCounts: { user: items.length, group: 0, orgUnit: 0 },
        preview: accountPreview(document, items),
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
      attributes: [
        ...new Set([
          ...Object.values(document.account.fields),
          ...(document.account.enabledWhen ? ['enabled'] : []),
        ]),
      ].sort(),
    };
  },

  async *read(raw): AsyncIterable<SourceRecord> {
    const config = normalise(raw);
    for await (const item of paginate(
      config.document,
      config.credential,
      config.document.account.list,
    )) {
      if (excluded(config.document.account.exclude, item)) continue;
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

  // Only a document that describes containers places accounts in them. One
  // that does not is a flat target, and the run skips the container check.
  placesAccountsInContainers(raw): boolean {
    return normalise(raw).document.container !== undefined;
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

  /**
   * One account, observed after a write.
   *
   * A single GET when the document declares `account.read`; otherwise the
   * shared enumeration. Either way the entitlement half is the shared,
   * all-or-incomplete walk — this only makes FINDING the account cheaper.
   */
  async readBack(raw, anchor): Promise<TargetReadBack> {
    const config = normalise(raw);
    const { document, credential } = config;
    const spec = document.account.read;
    if (spec === undefined) return readBackByEnumeration(httpTargetConnector, raw, anchor);

    const response = await readRequest(document, credential, {
      path: renderPath(spec.path, { anchor }),
      query: renderParams(spec.query, { anchor }),
    });
    const absent = { account: null, entitlementIds: [], enabled: null, complete: true };
    if (response.status >= 400) {
      const failed = errorFailure(document, response, [credential]);
      if (failed.failure === 'not_found') return absent;
      throw new Error(`reading the account back failed: ${failed.message}`);
    }
    const refused = bodyFailure(document, response.body, [credential]);
    if (refused) {
      if (refused.failure === 'not_found') return absent;
      throw new Error(`reading the account back failed: ${refused.message}`);
    }
    const item = spec.itemAt ? readPath(response.body, spec.itemAt) : response.body;
    const account = toRecord(document, item);
    if (account === null) {
      throw new Error('reading the account back answered with no anchor');
    }
    if (account.anchor !== anchor) {
      // Never a different account's state reported as this one's.
      throw new Error('reading the account back answered with a different account');
    }
    return completeReadBack(httpTargetConnector, raw, account);
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
      throw new Error('The connector document does not describe how to read memberships.');
    }

    const members: string[] = [];
    // `paginate` throws rather than returning what it managed to fetch, which
    // is what makes this all-or-nothing rather than "as much as we got".
    const vars = { entitlementId: entitlementDn, anchor: entitlementDn };
    for await (const item of paginate(
      config.document,
      config.credential,
      { ...spec, path: renderPath(spec.path, vars) },
      vars,
    )) {
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
      // Moved exactly as it is created: not at all, there being no containers.
      case 'move_container':
      case 'create_container':
        // A document-driven HTTP target describes account and entitlement
        // operations only. There is no container document to POST, and
        // inventing one from the account document would write an account
        // shape to an endpoint that expects none.
        return {
          ok: false,
          message:
            'This target has no containers. Nothing to create.',
          failure: 'rejected',
        };

      case 'create_account': {
        if (
          account.create === undefined ||
          account.correlationAt === undefined ||
          account.provenance === undefined
        ) {
          return {
            ok: false,
            message:
              'Cannot create accounts: the connector document must declare create, correlationAt and provenance read-back.',
            failure: 'rejected',
          };
        }
        const followWithDisable = !op.enabled && account.createsEnabled;
        if (followWithDisable && account.disable === undefined) {
          return {
            ok: false,
            message: `Not created: ${op.correlationKey} is to start disabled, and the connector document declares no disable.`,
            failure: 'rejected',
          };
        }
        // A target whose create always enables gets the disable straight
        // after, and again on an adopting retry: the first attempt may have
        // created the account and never got as far as disabling it.
        const settle = async (created: WriteResult): Promise<WriteResult> => {
          if (!created.ok) return created;
          const followUps = account.followUps.filter((spec) => hasValue(op.attributes, spec.when));
          if (!followWithDisable && followUps.length === 0) return created;
          if (created.anchor === undefined) {
            return { ok: false, message: `Created ${op.correlationKey}, but the target returned no id to write to.`, failure: 'rejected' };
          }
          const followed = await runFollowUps(config, followUps, {
            actionId: op.actionId,
            anchor: created.anchor,
            attributes: op.attributes,
          });
          if (!followed.ok) {
            return { ...followed, message: `Created ${op.correlationKey}, but ${followed.message}` };
          }
          if (!followWithDisable) return created;
          const disabled = await runWrite(
            config,
            account.disable,
            { actionId: op.actionId, anchor: created.anchor, enabled: false },
            'disable an account',
          );
          return disabled.ok
            ? created
            : { ...disabled, message: `Created ${op.correlationKey}, but disabling it failed: ${disabled.message}` };
        };

        const existing = await findCreateCollision(config, op.correlationKey);
        if (existing !== undefined) {
          const anchor = asValues(readPath(existing, account.anchorAt))?.[0];
          if (anchor !== undefined && provenanceValues(existing, account.provenance).includes(op.actionId)) {
            return settle({
              ok: true,
              message: 'adopted the account this action already created',
              anchor,
            });
          }
          return {
            ok: false,
            message: `Account ${op.correlationKey} already exists and was not created by Syntra.`,
            failure: 'conflict',
          };
        }
        return settle(
          await runWrite(
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
          ),
        );
      }

      case 'update_account': {
        const vars = { actionId: op.actionId, anchor: op.anchor, attributes: op.attributes };
        const updated = await runWrite(config, account.update, vars, 'update an account');
        if (!updated.ok) return updated;
        const followed = await runFollowUps(
          config,
          account.followUps.filter((spec) => hasValue(op.attributes, spec.when)),
          vars,
        );
        return followed.ok ? updated : { ...followed, message: `Updated the account, but ${followed.message}` };
      }

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

      case 'delete_account':
        // A document declares no delete, so there is nothing to run.
        return {
          ok: false,
          message: 'Not deleted: document-driven HTTP targets do not delete accounts.',
          failure: 'rejected',
        };

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
