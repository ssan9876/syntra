import { Client } from 'ldapts';
import type {
  Connector,
  ConnectionResult,
  ObjectType,
  SchemaDescriptor,
  SourceRecord,
  WriteResult,
} from '../types.js';
import { normaliseAnchor } from './anchor.js';
import { ldapConfigSchema, type LdapConfig } from './config.js';

type Config = LdapConfig & { bindPassword: string };

interface Search {
  base: string;
  filter: string;
  objectType: ObjectType;
}

/**
 * Re-applies the config schema's defaults (filters, page size, anchor
 * attribute, TLS posture) to whatever the caller passed in.
 *
 * `LdapConfig` is the schema's *output* type, which makes fields like
 * `orgUnitFilter` look mandatory to the type checker even though the schema
 * declares a `.default(...)` for them. A config assembled by hand — as in a
 * saved connection record, or a literal built for a test — can still omit
 * such fields at runtime. Without this, an unset `orgUnitFilter` reaches
 * ldapts as `undefined`, which it silently treats as `(objectClass=*)`: an
 * unfiltered subtree scan standing in for what looked like a scoped search.
 */
function normalise(config: Config): Config {
  const { bindPassword, ...rest } = config;
  return { ...ldapConfigSchema.parse(rest), bindPassword };
}

function searches(config: Config): Search[] {
  const list: Search[] = [
    { base: config.userSearchBase, filter: config.userFilter, objectType: 'user' },
    { base: config.groupSearchBase, filter: config.groupFilter, objectType: 'group' },
  ];
  if (config.orgUnitSearchBase) {
    list.push({
      base: config.orgUnitSearchBase,
      filter: config.orgUnitFilter,
      objectType: 'orgUnit',
    });
  }
  return list;
}

async function connect(config: Config): Promise<Client> {
  // ldapts treats the mere presence of `tlsOptions` (any defined key) as a
  // request for an implicit-TLS connection, independent of the URL scheme.
  // Only pass it for ldaps:// URLs; otherwise a plain ldap:// connection gets
  // a TLS ClientHello thrown at a plaintext listener and the socket drops.
  const isSecure = config.url.toLowerCase().startsWith('ldaps:');
  const client = new Client({
    url: config.url,
    ...(isSecure
      ? { tlsOptions: { rejectUnauthorized: config.rejectUnauthorized } }
      : {}),
  });
  await client.bind(config.bindDn, config.bindPassword);
  return client;
}

/** Every LDAP value arrives as a string or a Buffer; normalise to string[]. */
function toArray(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.map((v) => (Buffer.isBuffer(v) ? v.toString('utf8') : String(v)));
}

function toRecord(
  entry: Record<string, unknown>,
  objectType: ObjectType,
  anchorAttribute: string,
): SourceRecord {
  const raw = entry[anchorAttribute];
  const anchorSource = Array.isArray(raw) ? raw[0] : raw;

  const attributes: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (key === 'dn' || key === anchorAttribute) continue;
    attributes[key] = toArray(value);
  }

  const record: SourceRecord = {
    anchor: normaliseAnchor(
      anchorAttribute,
      Buffer.isBuffer(anchorSource) ? anchorSource : String(anchorSource ?? ''),
    ),
    objectType,
    dn: String(entry.dn ?? ''),
    attributes,
  };

  if (objectType === 'group') {
    record.memberDns = toArray(entry.member ?? entry.uniqueMember);
  }
  return record;
}

async function runSearch<T>(
  client: Client,
  search: Search,
  options: Parameters<Client['search']>[1],
  handler: (searchEntries: Record<string, unknown>[]) => T,
): Promise<T> {
  const { searchEntries } = await client.search(search.base, {
    filter: search.filter,
    scope: 'sub',
    ...options,
  });
  return handler(searchEntries as unknown as Record<string, unknown>[]);
}

/** ldapts's ResultCodeError can carry an empty message when the server sends
 * no diagnostic text (OpenLDAP does this for a bad bind); the error's name
 * (e.g. "InvalidCredentialsError") is where the real signal lives then. */
function describeError(cause: unknown): string {
  if (!(cause instanceof Error)) return 'Connection failed';
  if (cause.name && cause.name !== 'Error' && !cause.message.includes(cause.name)) {
    return `${cause.name}: ${cause.message}`.trim();
  }
  return cause.message;
}

export const ldapConnector: Connector<Config> = {
  async test(rawConfig): Promise<ConnectionResult> {
    const config = normalise(rawConfig);
    let client: Client | undefined;
    try {
      client = await connect(config);
      const counts = { user: 0, group: 0, orgUnit: 0 } as Record<ObjectType, number>;

      for (const search of searches(config)) {
        counts[search.objectType] = await runSearch(
          client,
          search,
          { attributes: ['dn'] },
          (searchEntries) => searchEntries.length,
        );
      }

      return {
        ok: true,
        message: `Connected to ${config.url}`,
        sampleCounts: counts,
      };
    } catch (cause) {
      return {
        ok: false,
        message: describeError(cause),
      };
    } finally {
      await client?.unbind().catch(() => undefined);
    }
  },

  async discoverSchema(rawConfig): Promise<SchemaDescriptor> {
    const config = normalise(rawConfig);
    const client = await connect(config);
    try {
      const objectClasses = new Set<string>();
      const attributes = new Set<string>();

      for (const search of searches(config)) {
        await runSearch(client, search, { sizeLimit: 20 }, (searchEntries) => {
          for (const entry of searchEntries) {
            for (const cls of toArray(entry.objectClass)) objectClasses.add(cls);
            for (const key of Object.keys(entry)) {
              if (key !== 'dn') attributes.add(key);
            }
          }
        });
      }

      return {
        objectClasses: [...objectClasses].sort(),
        attributes: [...attributes].sort(),
      };
    } finally {
      await client.unbind().catch(() => undefined);
    }
  },

  async *read(rawConfig): AsyncIterable<SourceRecord> {
    const config = normalise(rawConfig);
    const client = await connect(config);
    try {
      for (const search of searches(config)) {
        // Paged, and yielded as they arrive: a large directory must not
        // become a large heap.
        const records = await runSearch(
          client,
          search,
          {
            // `search()` always drains every page itself (unlike the separate
            // `searchPaginated()` generator); no extra option is needed to
            // make it continue past the first page.
            paged: { pageSize: config.pageSize },
            attributes: ['*', config.anchorAttribute],
          },
          (searchEntries) =>
            searchEntries.map((entry) =>
              toRecord(entry, search.objectType, config.anchorAttribute),
            ),
        );
        yield* records;
      }
    } finally {
      await client.unbind().catch(() => undefined);
    }
  },

  async write(): Promise<WriteResult> {
    return {
      ok: false,
      message:
        'Writing back to LDAP is not implemented in this slice; the method exists for Provision',
    };
  },
};
