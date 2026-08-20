import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from 'ldapts';
import { ldapConnector, rangedMembershipFailure } from './connector.js';
import { RANGE_STEP } from './range.js';
import type { LdapConfig } from './config.js';

const config: LdapConfig & { bindPassword: string } = {
  // `ou=Shared`, like every other file that only READS this container. The
  // directory is one server for up to eight parallel workers, and
  // `scenarios.test.ts` mutates `ou=Scenarios` throughout its run — see
  // `infra/ldap/seed.ldif`. Scoped to the root, the counts below see both
  // subtrees and the group DNs are in the wrong place.
  url: process.env.LDAP_URL ?? 'ldap://localhost:1389',
  bindDn: 'cn=admin,dc=acme,dc=test',
  bindPassword: 'adminpassword',
  userSearchBase: 'ou=Shared,dc=acme,dc=test',
  groupSearchBase: 'ou=Shared,dc=acme,dc=test',
  orgUnitSearchBase: 'ou=Shared,dc=acme,dc=test',
  userFilter: '(objectClass=inetOrgPerson)',
  groupFilter: '(objectClass=groupOfNames)',
  anchorAttribute: 'entryUUID',
  pageSize: 2,
  rejectUnauthorized: true,
};

const readAll = async () => {
  const records = [];
  for await (const record of ldapConnector.read(config)) records.push(record);
  return records;
};

/**
 * The same server, reached over TLS. The container generates a self-signed
 * certificate, so both of these have to disable verification explicitly --
 * which is the point: with `rejectUnauthorized` left at its default, they
 * refuse to connect at all, and there is a test below that says so.
 */
const startTlsConfig: LdapConfig & { bindPassword: string } = {
  ...config,
  tlsMode: 'starttls',
  rejectUnauthorized: false,
};

const ldapsConfig: LdapConfig & { bindPassword: string } = {
  ...config,
  url: process.env.LDAPS_URL ?? 'ldaps://localhost:1636',
  tlsMode: 'ldaps',
  rejectUnauthorized: false,
};

/**
 * Records the order in which the client secures and authenticates the
 * connection, calling through to the real methods so the exchange with the
 * server is genuine.
 */
function recordHandshake(): string[] {
  const order: string[] = [];
  const realStartTls = Client.prototype.startTLS;
  const realBind = Client.prototype.bind;

  vi.spyOn(Client.prototype, 'startTLS').mockImplementation(function (
    this: Client,
    ...args: Parameters<Client['startTLS']>
  ) {
    order.push('startTLS');
    return realStartTls.apply(this, args);
  });
  vi.spyOn(Client.prototype, 'bind').mockImplementation(function (
    this: Client,
    ...args: Parameters<Client['bind']>
  ) {
    order.push('bind');
    return realBind.apply(this, args);
  });

  return order;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ldapConnector.test', () => {
  it('reports success and what it found', async () => {
    const result = await ldapConnector.test(config);
    expect(result.ok).toBe(true);
    expect(result.sampleCounts?.user).toBe(2);
    expect(result.sampleCounts?.group).toBe(1);
  });

  it('reports a bad password as a failure rather than throwing', async () => {
    const result = await ldapConnector.test({
      ...config,
      bindPassword: 'wrong',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/credential|invalid|bind/i);
  });

  it('reports an unreachable host as a failure', async () => {
    const result = await ldapConnector.test({
      ...config,
      url: 'ldap://127.0.0.1:1',
    });
    expect(result.ok).toBe(false);
  });
});

describe('transport security', () => {
  it('upgrades an ldap:// connection with StartTLS and reads through it', async () => {
    const result = await ldapConnector.test(startTlsConfig);
    expect(result.ok).toBe(true);
    expect(result.sampleCounts?.user).toBe(2);
  });

  it('completes StartTLS before the bind, so the password never crosses in the clear', async () => {
    // The whole point of the mode. Bind first and StartTLS second secures
    // everything except the one thing worth securing.
    const order = recordHandshake();

    const result = await ldapConnector.test(startTlsConfig);

    expect(result.ok).toBe(true);
    expect(order).toEqual(['startTLS', 'bind']);
  });

  it('upgrades before the bind on a read as well as a test', async () => {
    // read() and test() each call connect() -- this fails the moment one of
    // them grows its own connection path that binds first.
    const order = recordHandshake();

    for await (const _record of ldapConnector.read(startTlsConfig)) break;

    expect(order).toEqual(['startTLS', 'bind']);
  });

  it('never starts TLS on a plain source, since ldapts reads tlsOptions as implicit TLS', async () => {
    // The regression this guards: passing tlsOptions to the constructor makes
    // ldapts open an implicit-TLS connection whatever the URL says, so a
    // plain ldap:// bind throws a ClientHello at a plaintext listener and the
    // socket drops. A plain source must do neither that nor StartTLS.
    const order = recordHandshake();

    const result = await ldapConnector.test(config);

    expect(result.ok).toBe(true);
    expect(order).toEqual(['bind']);
  });

  it('refuses a StartTLS connection whose certificate does not verify, by default', async () => {
    // Certificate verification is on unless a source turns it off. The
    // container's certificate is self-signed, so the default must refuse it.
    const result = await ldapConnector.test({
      ...startTlsConfig,
      rejectUnauthorized: true,
    });
    expect(result.ok).toBe(false);
  });

  it('connects over LDAPS', async () => {
    const result = await ldapConnector.test(ldapsConfig);
    expect(result.ok).toBe(true);
    expect(result.sampleCounts?.user).toBe(2);
  });

  it('refuses an LDAPS connection whose certificate does not verify, by default', async () => {
    const result = await ldapConnector.test({
      ...ldapsConfig,
      rejectUnauthorized: true,
    });
    expect(result.ok).toBe(false);
  });

  it('does not call startTLS on an LDAPS connection, which is already TLS', async () => {
    const order = recordHandshake();

    const result = await ldapConnector.test(ldapsConfig);

    expect(result.ok).toBe(true);
    expect(order).toEqual(['bind']);
  });
});

describe('ldapConnector.read', () => {
  it('reads users, groups and organizational units', async () => {
    const records = await readAll();
    const byType = (t: string) => records.filter((r) => r.objectType === t);

    expect(byType('user').map((r) => r.dn).sort()).toEqual([
      'uid=jdoe,ou=Care,ou=Shared,dc=acme,dc=test',
      'uid=sroe,ou=Care,ou=Shared,dc=acme,dc=test',
    ]);
    expect(byType('group')).toHaveLength(1);
    expect(byType('orgUnit').length).toBeGreaterThanOrEqual(2);
  });

  it('gives every record a non-empty anchor', async () => {
    const records = await readAll();
    expect(records.every((r) => r.anchor.length > 0)).toBe(true);
    expect(new Set(records.map((r) => r.anchor)).size).toBe(records.length);
  });

  it('crosses the page boundary, since pageSize is 2', async () => {
    // Paging is where a naive implementation silently truncates. There are
    // more than two objects in total, so a single page cannot cover them.
    const records = await readAll();
    expect(records.length).toBeGreaterThan(2);
  });

  it('carries group members as DNs', async () => {
    const records = await readAll();
    const nurses = records.find((r) => r.dn.startsWith('cn=Nurses'));
    expect(nurses?.memberDns).toEqual(['uid=jdoe,ou=Care,ou=Shared,dc=acme,dc=test']);
  });

  it('returns attributes as arrays', async () => {
    const records = await readAll();
    const jo = records.find((r) => r.dn.startsWith('uid=jdoe'));
    expect(Array.isArray(jo?.attributes.mail)).toBe(true);
  });
});

describe('ldapConnector.discoverSchema', () => {
  it('reports the attributes actually seen on sampled entries', async () => {
    const schema = await ldapConnector.discoverSchema(config);
    expect(schema.attributes).toContain('mail');
    expect(schema.objectClasses).toContain('inetOrgPerson');
  });

  it('includes the operational attributes, which is where the anchor lives', async () => {
    // entryUUID is operational on OpenLDAP and is not returned by an ordinary
    // search. A discovery report that omits it lists every attribute except
    // the one an administrator opened it to find.
    const schema = await ldapConnector.discoverSchema(config);
    expect(schema.attributes).toContain('entryUUID');
  });

  it('does not report the selectors it asked with as attributes', async () => {
    // ldapts echoes `*` and `+` back as keys on the entry. Listed, they read
    // as two attributes the directory holds.
    const schema = await ldapConnector.discoverSchema(config);
    expect(schema.attributes).not.toContain('*');
    expect(schema.attributes).not.toContain('+');
  });
});

describe('a peer that never answers', () => {
  /**
   * A socket that accepts the connection and then says nothing at all —
   * the shape a black-holed port has from the client's side, and the one that
   * a connect timeout alone does not cover, since the connection itself
   * succeeds.
   */
  async function silentServer(): Promise<{ port: number; close(): void }> {
    const { createServer } = await import('node:net');
    const sockets: import('node:net').Socket[] = [];
    const server = createServer((socket) => {
      sockets.push(socket);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    return {
      port,
      close: () => {
        for (const socket of sockets) socket.destroy();
        server.close();
      },
    };
  }

  it('gives up on the bind rather than waiting forever', async () => {
    // Left to itself ldapts waits indefinitely: the caller of a connection
    // test would pin a request handler for as long as the peer stays silent.
    const server = await silentServer();
    try {
      const started = Date.now();
      const result = await ldapConnector.test({
        ...config,
        url: `ldap://127.0.0.1:${server.port}`,
        timeoutMs: 300,
        connectTimeoutMs: 300,
      });

      expect(result.ok).toBe(false);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      server.close();
    }
  }, 10_000);
});

describe('ldapConnector.write', () => {
  it('refuses, since writing back is not in this slice', async () => {
    // A real member of the tagged union. The directory-source connector is a
    // reader: it satisfies the widened signature and refuses every operation,
    // which is what keeps `write` on `Connector<C>` rather than only on
    // `TargetConnector<C>` honest.
    const result = await ldapConnector.write(config, {
      op: 'disable_account',
      actionId: 'action-1',
      anchor: 'a1',
      reason: 'unused',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not implemented/i);
  });
});

/**
 * Serves an Active Directory-shaped ranged membership for one group.
 *
 * OpenLDAP never returns a ranged attribute, so the truncation is injected at
 * the wire boundary rather than seeded into the container: the subtree
 * search's entry for `groupDn` comes back carrying `windows[0]`'s ranged key
 * instead of a plain `member`, which is exactly what a domain controller
 * sends for a group above `MaxValRange`. The base-scope follow-ups the walk
 * then issues are answered from `windows` in order -- starting again at
 * `windows[0]`, because the walk re-asks for the plain attribute first and a
 * real server answers that with the first window too.
 *
 * A `windows` entry of `undefined` is a server that stopped answering partway
 * through: an entry with neither a plain `member` nor a ranged one.
 *
 * Each window is passed through `asLdaptsReturns`, because a `windows` entry
 * describes what the SERVER sent and `readRangedAttribute` is handed what
 * LDAPTS produces. Those differ by exactly the key this whole finding turns
 * on: ldapts writes an empty array into every requested attribute the server
 * answered under some other name, so a real `member;range=0-1499` response
 * arrives carrying `member: []` beside it.
 *
 * The subtree branch below needs no such treatment: `read` asks it for
 * `['*', anchorAttribute]`, never for `member` by name, so ldapts injects
 * nothing for a group whose membership came back ranged.
 *
 * Returns the attribute specs actually requested, so a test can say the walk
 * happened rather than only that the answer looked right.
 */
function asLdaptsReturns(
  entry: Record<string, unknown>,
  requested: readonly string[],
): Record<string, unknown> {
  const result = { ...entry };
  const returned = new Set(Object.keys(result).map((key) => key.toLowerCase()));
  for (const attribute of requested) {
    if (!returned.has(attribute.toLowerCase())) result[attribute] = [];
  }
  return result;
}

function serveRangedMembership(
  groupDn: string,
  windows: (Record<string, string[]> | undefined)[],
): { specs: string[] } {
  const realSearch = Client.prototype.search;
  const specs: string[] = [];
  let served = 0;

  vi.spyOn(Client.prototype, 'search').mockImplementation(async function (
    this: Client,
    ...args: Parameters<Client['search']>
  ) {
    const [base, options] = args;

    if (options?.scope === 'base' && base === groupDn) {
      specs.push(String(options.attributes?.[0] ?? ''));
      const window = windows[served];
      served += 1;
      return {
        searchEntries: [
          asLdaptsReturns({ dn: groupDn, ...(window ?? {}) }, options.attributes ?? []),
        ],
        searchReferences: [],
      } as unknown as Awaited<ReturnType<Client['search']>>;
    }

    const result = await realSearch.apply(this, args);
    for (const entry of result.searchEntries as unknown as Record<string, unknown>[]) {
      if (entry.dn === groupDn) {
        delete entry.member;
        delete entry.uniqueMember;
        Object.assign(entry, windows[0] ?? {});
      }
    }
    return result;
  });

  return { specs };
}

describe('ldapConnector.read: Active Directory range retrieval', () => {
  const nursesDn = 'cn=Nurses,ou=Shared,dc=acme,dc=test';
  const jdoe = 'uid=jdoe,ou=Care,ou=Shared,dc=acme,dc=test';
  const sroe = 'uid=sroe,ou=Care,ou=Shared,dc=acme,dc=test';

  it('walks the windows and yields the whole membership, not the first window', async () => {
    // The truncated first window holds one member. The group has three. A
    // reader that stops at the window it was handed reports one, and the diff
    // then proposes revoking the group from the other two.
    const { specs } = serveRangedMembership(nursesDn, [
      { 'member;range=0-0': [jdoe] },
      { 'member;range=1-*': [sroe, 'uid=third,ou=Care,ou=Shared,dc=acme,dc=test'] },
    ]);

    const records = await readAll();
    const nurses = records.find((r) => r.dn === nursesDn);

    expect(nurses?.memberDns).toEqual([jdoe, sroe, 'uid=third,ou=Care,ou=Shared,dc=acme,dc=test']);
    expect(nurses?.readFailure).toBeUndefined();
    // Two round trips, and the second asks for the window after the one the
    // server returned. Without this the assertion above would also pass on a
    // reader that never walked and got the whole list in one response.
    expect(specs).toEqual(['member', `member;range=1-${RANGE_STEP}`]);
  });

  it('marks the group a read failure rather than yielding what it collected', async () => {
    // The walk starts -- the first response is ranged -- and then the server
    // stops answering. One member of three is in hand. Handing that back as
    // the membership is the failure this whole task exists to prevent, so the
    // record carries a readFailure and no memberDns at all: the difference
    // between "we could not read this group" and "this group has one member".
    serveRangedMembership(nursesDn, [{ 'member;range=0-0': [jdoe] }, undefined]);

    const records = await readAll();
    const nurses = records.find((r) => r.dn === nursesDn);

    expect(nurses).toBeDefined();
    expect(nurses?.memberDns).toBeUndefined();
    expect(nurses?.readFailure).toMatch(/partway through a ranged read/);
  });
});

describe('rangedMembershipFailure', () => {
  it('detects the ranged member attribute Active Directory returns', () => {
    const reason = rangedMembershipFailure({
      dn: 'cn=Everyone,dc=acme,dc=test',
      'member;range=0-1499': ['cn=a,dc=acme,dc=test'],
    });
    expect(reason).toMatch(/range/i);
    expect(reason).toContain('member;range=0-1499');
  });

  it('detects it whatever case the server used', () => {
    expect(
      rangedMembershipFailure({ 'Member;Range=0-1499': [] }),
    ).toMatch(/range/i);
    expect(
      rangedMembershipFailure({ 'uniqueMember;range=1500-*': [] }),
    ).toMatch(/range/i);
  });

  it('says nothing about an ordinary group', () => {
    expect(
      rangedMembershipFailure({
        dn: 'cn=Nurses,dc=acme,dc=test',
        member: ['uid=jdoe,dc=acme,dc=test'],
      }),
    ).toBeUndefined();
  });

  it('says nothing about an attribute that merely mentions member', () => {
    expect(rangedMembershipFailure({ memberOf: [], memberUid: [] })).toBeUndefined();
  });
});
