import { Client } from 'ldapts';
import { z } from 'zod';
import type {
  Connector,
  ConnectionResult,
  ObjectType,
  SchemaDescriptor,
  SourceRecord,
  WriteResult,
} from '../types.js';
import { normaliseAnchor } from './anchor.js';
import { RANGE_STEP, readRangedAttribute } from './range.js';
import { ldapConfigSchema, type LdapConfig } from './config.js';

// `LdapConfig` (see config.ts) is the schema's *input* type: defaulted
// fields (orgUnitFilter, pageSize, ...) are optional there, matching what a
// caller is actually allowed to omit. `ResolvedConfig` is the *output* type
// instead -- every defaulted field guaranteed present -- which is what
// `normalise()` below produces and everything past it operates on.
type Config = LdapConfig & { bindPassword: string };
type ResolvedConfig = z.output<typeof ldapConfigSchema> & { bindPassword: string };

interface Search {
  base: string;
  filter: string;
  objectType: ObjectType;
}

/**
 * Runs the config schema's `.parse()` over whatever the caller passed in,
 * turning the *input* type (`Config`, with defaulted fields optional) into
 * the fully-resolved *output* type (`ResolvedConfig`) that the rest of this
 * module relies on.
 *
 * This isn't optional plumbing: a config that skips this (a hand-built
 * literal, as in this module's own test fixture, or a saved connection
 * record deserialised without validation) can omit a field like
 * `orgUnitFilter` entirely. Left as `undefined`, ldapts treats a falsy
 * filter as `(objectClass=*)` -- an unfiltered subtree scan standing in for
 * what looked like a scoped search.
 */
function normalise(config: Config): ResolvedConfig {
  const { bindPassword, ...rest } = config;
  return { ...ldapConfigSchema.parse(rest), bindPassword };
}

function searches(config: ResolvedConfig): Search[] {
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

/**
 * Opens a connection, secures it as the source's `tlsMode` asks, and binds.
 *
 * **StartTLS runs before the bind, and that order is not negotiable.** The
 * bind carries the password; upgrading afterwards secures everything except
 * the one thing worth securing. There is a test asserting the order for that
 * reason.
 */
async function connect(config: ResolvedConfig): Promise<Client> {
  const tlsOptions = { rejectUnauthorized: config.rejectUnauthorized };

  // ldapts treats the mere presence of `tlsOptions` (any defined key) as a
  // request for an implicit-TLS connection, independent of the URL scheme.
  // Only pass it to the constructor for `ldaps`; a `starttls` connection
  // starts out as plaintext and takes its options from startTLS() below, and
  // a `plain` one would get a TLS ClientHello thrown at a plaintext listener
  // and the socket would drop.
  const client = new Client({
    url: config.url,
    // Without these ldapts waits forever, and "forever" is reachable from
    // outside: a host that black-holes packets, or one that accepts the
    // connection and never answers the bind, holds this call — and the
    // request handler that made it — open until something else gives up.
    connectTimeout: config.connectTimeoutMs,
    timeout: config.timeoutMs,
    ...(config.tlsMode === 'ldaps' ? { tlsOptions } : {}),
  });
  try {
    if (config.tlsMode === 'starttls') {
      await client.startTLS(tlsOptions);
    }
    await client.bind(config.bindDn, config.bindPassword);
  } catch (cause) {
    // A rejected bind (bad credentials) throws without ldapts destroying the
    // socket underneath it -- unlike a connection-level failure (refused,
    // timed out), which the library self-cleans. Left alone, this leaves a
    // live, authenticated-at-the-TCP-level-but-not-bound socket open to the
    // server on every failed bind. unbind() tears down the socket even though
    // the client was never successfully bound.
    await client.unbind().catch(() => undefined);
    throw cause;
  }
  return client;
}

/** Every LDAP value arrives as a string or a Buffer; normalise to string[]. */
function toArray(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.map((v) => (Buffer.isBuffer(v) ? v.toString('utf8') : String(v)));
}

/**
 * Active Directory truncates a large multi-valued attribute rather than
 * refusing it: a group with more members than `MaxValRange` (1500 by default)
 * comes back carrying `member;range=0-1499` instead of `member`, and the
 * caller is expected to ask for the next window. `ldapts` does not implement
 * range retrieval, so the plain `member` attribute is simply *absent* on
 * exactly the groups that matter most.
 *
 * Read naively that is a group with no members, and the diff proposes
 * removing every one of the five thousand people in it.
 *
 * Under Ruling P1 this is now the *trigger* for a ranged read rather than the
 * end of the story: `toRecord` uses it to decide that `member` cannot be
 * trusted as it stands, and `resolveMembership` then walks the windows via
 * `readRangedAttribute`. A walk that cannot finish still produces a read
 * failure, with a message describing the walk. The returned string is kept
 * for callers that want to explain the truncation itself; it is no longer
 * what a truncated group's `readFailure` says.
 */
export function rangedMembershipFailure(
  entry: Record<string, unknown>,
): string | undefined {
  const ranged = Object.keys(entry).find((key) =>
    /^(member|uniqueMember);range=/i.test(key),
  );
  if (!ranged) return undefined;

  return (
    `the directory returned this group's membership as the ranged attribute ` +
    `"${ranged}" because it exceeds the server's value-range limit; it has to ` +
    `be walked window by window before its membership can be read in full`
  );
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
    // Membership is resolved by resolveMembership() after the search, because
    // a ranged read needs further round trips and this function is sync.
    // Deliberately leaves memberDns unset rather than empty: an empty list
    // reads as "this group has no members" and proposes removing all of them.
    record.memberDns = toArray(entry.member ?? entry.uniqueMember);
    if (rangedMembershipFailure(entry)) delete record.memberDns;
  }
  return record;
}

/**
 * Completes a group record's membership, walking Active Directory's range
 * windows when the first response came back truncated.
 *
 * Ruling P1: until this existed, a group above the server's value-range limit
 * was marked a read failure and excluded from the diff, which is the correct
 * interim behaviour for a subsystem that only reads. Provision writes, and a
 * target whose largest groups always fail is a target it cannot manage.
 *
 * A walk that cannot finish still produces a read failure. That path did not
 * go away; it stopped being the only path.
 */
async function resolveMembership(
  client: Client,
  entry: Record<string, unknown>,
  record: SourceRecord,
): Promise<void> {
  if (record.objectType !== 'group') return;
  if (record.memberDns) return;

  const attribute = Object.keys(entry).some((k) => /^uniqueMember;range=/i.test(k))
    ? 'uniqueMember'
    : 'member';

  try {
    record.memberDns = await readRangedAttribute(client, record.dn, attribute, {
      pageStep: RANGE_STEP,
    });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    record.readFailure =
      `this group's membership exceeds the server's value-range limit and the ` +
      `ranged read could not be completed: ${detail}`;
  }
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
        // `*` is every ordinary attribute — what a search returns anyway — and
        // `+` is the operational ones. The second is the point: `entryUUID` is
        // operational on OpenLDAP, so without it the discovery report lists
        // every attribute except the one an administrator has come here to
        // find, since the anchor is the field this report exists to help them
        // fill in. A server that does not know `+` treats it as an attribute
        // name that matches nothing and returns the same set as before.
        await runSearch(
          client,
          search,
          { sizeLimit: 20, attributes: ['*', '+'] },
          (searchEntries) => {
            for (const entry of searchEntries) {
              for (const cls of toArray(entry.objectClass)) {
                objectClasses.add(cls);
              }
              for (const key of Object.keys(entry)) {
                // `dn` is not an attribute, and ldapts echoes the requested
                // selectors back as keys of their own, so `*` and `+` would
                // otherwise be reported to the administrator as two
                // attributes the directory holds.
                if (key !== 'dn' && key !== '*' && key !== '+') {
                  attributes.add(key);
                }
              }
            }
          },
        );
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
        // Paged on the wire, but NOT streamed into memory. `search()` drains
        // every page internally and hands back one complete array, which is
        // then mapped into a second complete array before any of it is
        // yielded — so one search base's worth of entries is resident at
        // once, and the async-generator shape below buys nothing but a
        // convenient interface.
        //
        // Real streaming means ldapts's separate `searchPaginated()`
        // generator, which is a change to how failures and page boundaries
        // are handled, not a swapped call. It is on the follow-up list.
        const records = await runSearch(
          client,
          search,
          {
            // No extra option is needed to make `search()` continue past the
            // first page; it already does.
            paged: { pageSize: config.pageSize },
            attributes: ['*', config.anchorAttribute],
          },
          (searchEntries) =>
            searchEntries.map((entry) => ({
              entry,
              record: toRecord(entry, search.objectType, config.anchorAttribute),
            })),
        );

        for (const { entry, record } of records) {
          // Sequential, not Promise.all: a domain with 300 oversized groups
          // would otherwise open 300 concurrent range walks on one connection.
          await resolveMembership(client, entry, record);
          yield record;
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
