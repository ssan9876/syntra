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
import type { LdapConfig } from './config.js';

type Config = LdapConfig & { bindPassword: string };

interface Search {
  base: string;
  filter: string;
  objectType: ObjectType;
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

export const ldapConnector: Connector<Config> = {
  async test(config): Promise<ConnectionResult> {
    let client: Client | undefined;
    try {
      client = await connect(config);
      const counts = { user: 0, group: 0, orgUnit: 0 } as Record<ObjectType, number>;

      for (const search of searches(config)) {
        const { searchEntries } = await client.search(search.base, {
          filter: search.filter,
          scope: 'sub',
          attributes: ['dn'],
        });
        counts[search.objectType] = searchEntries.length;
      }

      return {
        ok: true,
        message: `Connected to ${config.url}`,
        sampleCounts: counts,
      };
    } catch (cause) {
      return {
        ok: false,
        message: cause instanceof Error ? cause.message : 'Connection failed',
      };
    } finally {
      await client?.unbind().catch(() => undefined);
    }
  },

  async discoverSchema(config): Promise<SchemaDescriptor> {
    const client = await connect(config);
    try {
      const objectClasses = new Set<string>();
      const attributes = new Set<string>();

      for (const search of searches(config)) {
        const { searchEntries } = await client.search(search.base, {
          filter: search.filter,
          scope: 'sub',
          sizeLimit: 20,
        });
        for (const entry of searchEntries) {
          for (const cls of toArray(entry.objectClass)) objectClasses.add(cls);
          for (const key of Object.keys(entry)) {
            if (key !== 'dn') attributes.add(key);
          }
        }
      }

      return {
        objectClasses: [...objectClasses].sort(),
        attributes: [...attributes].sort(),
      };
    } finally {
      await client.unbind().catch(() => undefined);
    }
  },

  async *read(config): AsyncIterable<SourceRecord> {
    const client = await connect(config);
    try {
      for (const search of searches(config)) {
        // Paged, and yielded as they arrive: a large directory must not
        // become a large heap.
        const { searchEntries } = await client.search(search.base, {
          filter: search.filter,
          scope: 'sub',
          paged: { pageSize: config.pageSize, pagePause: false },
          attributes: ['*', config.anchorAttribute],
        });

        console.error('DEBUG search', search.objectType, searchEntries.length, searchEntries.map((e: any) => e.dn));
        for (const entry of searchEntries) {
          yield toRecord(
            entry as unknown as Record<string, unknown>,
            search.objectType,
            config.anchorAttribute,
          );
        }
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
