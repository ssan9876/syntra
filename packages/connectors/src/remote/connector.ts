import {
  ConnectorClient,
  ConnectorServiceError,
  type Account,
  type WriteOperation as WireWriteOperation,
} from '@syntra/connector-sdk';
import { guardedFetch } from '../net/guarded-fetch.js';
import type {
  ConnectionResult,
  DiscoveredEntitlement,
  SchemaDescriptor,
  SourceRecord,
  TargetConnector,
  TargetReadBack,
  WriteOperation,
  WriteResult,
} from '../types.js';
import {
  remoteTargetConfigSchema,
  type RemoteTargetConfig,
  type ResolvedRemoteTargetConfig,
} from './config.js';

/**
 * A target served by the operator's own connector service.
 *
 * No third-party code runs in this process: the service is somebody else's
 * program on somebody else's host, reached over HTTPS through the same
 * outbound guard every other connector uses. The protocol, the signing and
 * the mapping of HTTP failures onto `WriteFailure` all live in
 * `@syntra/connector-sdk`, which the service is built with too, so the two
 * ends share one definition.
 */

/** The stored config plus the vault credential, under the name core gives it. */
type Config = RemoteTargetConfig & { bindPassword?: string; sharedSecret?: string };

/**
 * The largest answer accepted. A page of accounts with their attributes is
 * bigger than the 1 MiB the guard allows a discovery document; 8 MiB is a
 * thousand accounts with a few kilobytes each.
 */
const MAX_ANSWER_BYTES = 8 * 1_048_576;

function resolve(config: Config): { settings: ResolvedRemoteTargetConfig; client: ConnectorClient } {
  const { bindPassword, sharedSecret, ...rest } = config;
  const secret = sharedSecret ?? bindPassword;
  if (secret === undefined || secret === '') throw new Error('No shared secret is set.');
  const settings = remoteTargetConfigSchema.parse(rest);
  const client = new ConnectorClient({
    baseUrl: settings.baseUrl,
    secret,
    timeoutMs: settings.timeoutMs,
    // The guard's own socket timeout is the same budget; the client's abort
    // signal is what bounds the whole call.
    fetch: guardedFetch({
      allowPrivateAddresses: settings.allowPrivateAddresses,
      timeoutMs: settings.timeoutMs,
      maxBytes: MAX_ANSWER_BYTES,
    }),
  });
  return { settings, client };
}

/**
 * A wire account as Syntra reads accounts. Enabled state goes where
 * `observedEnabled` looks for it, and the login under `correlationKey`, the
 * attribute `observed-key.ts` reads for this type. The protocol reserves
 * both names, so neither can be overwritten by an attribute.
 */
export function remoteAccountRecord(account: Account): SourceRecord {
  return {
    anchor: account.anchor,
    objectType: 'user',
    dn: account.dn ?? account.anchor,
    attributes: {
      ...account.attributes,
      correlationKey: [account.correlationKey],
      ...(account.enabled === null ? {} : { enabled: [String(account.enabled)] }),
    },
    ...(account.readFailure === undefined ? {} : { readFailure: account.readFailure }),
  };
}

const messageOf = (cause: unknown) =>
  cause instanceof ConnectorServiceError || cause instanceof Error ? cause.message : String(cause);

/**
 * Syntra's `WriteOperation` is the protocol's: this line fails to compile the
 * day either gains an operation or a field the other lacks.
 */
const toWire = (operation: WriteOperation): WireWriteOperation => operation;
const fromWire = (operation: WireWriteOperation): WriteOperation => operation;
void fromWire;

export const remoteTargetConnector: TargetConnector<Config> & {
  readBack(config: Config, anchor: string): Promise<TargetReadBack>;
} = {
  async test(rawConfig): Promise<ConnectionResult> {
    let resolved;
    try {
      resolved = resolve(rawConfig);
    } catch (cause) {
      return { ok: false, message: messageOf(cause) };
    }
    const { settings, client } = resolved;
    try {
      const described = await client.describe();
      const incompatible = ConnectorClient.incompatibility(described);
      if (incompatible) return { ok: false, message: incompatible };
      const declared = described.capabilities.placesAccountsInContainers;
      if (declared !== settings.placesAccountsInContainers) {
        return {
          ok: false,
          message: declared
            ? `Connector service "${described.connector.name}" places accounts in containers. Turn on placesAccountsInContainers.`
            : `Connector service "${described.connector.name}" places accounts in no container. Turn off placesAccountsInContainers.`,
        };
      }
      const tested = await client.test();
      const name = `"${described.connector.name}" ${described.connector.version}`;
      return {
        ok: tested.ok,
        message: tested.ok
          ? `Connected to ${name}.${tested.message === '' ? '' : ` ${tested.message}`}`
          : `${name}: ${tested.message}`,
      };
    } catch (cause) {
      return { ok: false, message: messageOf(cause) };
    }
  },

  async discoverSchema(rawConfig): Promise<SchemaDescriptor> {
    const described = await resolve(rawConfig).client.describe();
    return {
      objectClasses: described.schema.objectClasses,
      attributes: described.schema.attributes,
    };
  },

  async *read(rawConfig): AsyncIterable<SourceRecord> {
    const { settings, client } = resolve(rawConfig);
    for await (const account of client.accounts(settings.pageSize)) yield remoteAccountRecord(account);
  },

  async write(rawConfig, operation): Promise<WriteResult> {
    let client;
    try {
      client = resolve(rawConfig).client;
    } catch (cause) {
      return { ok: false, failure: 'rejected', message: messageOf(cause) };
    }
    return client.write(toWire(operation));
  },

  async *listEntitlements(rawConfig): AsyncIterable<DiscoveredEntitlement> {
    const { settings, client } = resolve(rawConfig);
    for await (const entitlement of client.entitlements(settings.pageSize)) {
      const { id, ...rest } = entitlement;
      // The protocol has one id per entitlement; it is the dn as well, the
      // way SCIM's group id is.
      yield { externalId: id, dn: id, ...rest };
    }
  },

  async *listContainers(rawConfig): AsyncIterable<{ dn: string }> {
    const { settings, client } = resolve(rawConfig);
    if (!settings.placesAccountsInContainers) return;
    yield* client.containers(settings.pageSize);
  },

  placesAccountsInContainers(rawConfig): boolean {
    return rawConfig.placesAccountsInContainers === true;
  },

  async readEntitlementMembers(rawConfig, entitlementDn): Promise<string[]> {
    return resolve(rawConfig).client.entitlementMembers(entitlementDn);
  },

  /** One `accounts.read` instead of walking every account and group. */
  async readBack(rawConfig, anchor): Promise<TargetReadBack> {
    const observed = await resolve(rawConfig).client.readBack(anchor);
    return {
      account: observed.account ? remoteAccountRecord(observed.account) : null,
      entitlementIds: observed.entitlementIds,
      enabled: observed.enabled,
      complete: observed.complete,
    };
  },
};
