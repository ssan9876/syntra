import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Attribute, Change, Client } from 'ldapts';
import { connectAsSambaAdmin, purgeSubtree, sambaConnection } from './samba-connection.js';

const connection = sambaConnection();

/**
 * Every object this file creates lives under one OU it owns and empties
 * before each test.
 *
 * The earlier draft added five fixed DNs under `CN=Users` and two OUs at the
 * base, with no cleanup: it passed exactly once per fresh container and failed
 * with `AlreadyExists` on every run after. A suite that only passes against a
 * container nobody has touched is a suite nobody can run twice.
 */
const usersDn = `OU=Smoke,${connection.baseDn}`;

/**
 * `replace` on a single attribute, spelled the way `ldapts` actually requires.
 *
 * `Client.modify` takes `Change` instances, and `ModifyRequest.writeMessage`
 * calls `change.write(writer)` on each one -- so an object literal of the
 * right *shape* throws `TypeError: change.write is not a function` at send
 * time. `Change.write` then calls `this.modification.write(writer)`, so the
 * modification has to be a real `Attribute` too. Neither is caught by the
 * compiler if the argument is cast, which is exactly why this helper exists
 * instead of a cast at each call site.
 */
function replace(type: string, value: string | Buffer): Change {
  return new Change({
    operation: 'replace',
    modification: new Attribute({ type, values: [value] as string[] | Buffer[] }),
  });
}

let client: Client;

beforeAll(async () => {
  client = await connectAsSambaAdmin();
  await client.add(usersDn, { objectClass: ['top', 'organizationalUnit'] }).catch(() => undefined);
}, 120_000);

beforeEach(async () => {
  await purgeSubtree(client, usersDn);
});

afterAll(async () => {
  await purgeSubtree(client, usersDn).catch(() => undefined);
  await client?.del(usersDn).catch(() => undefined);
  await client?.unbind().catch(() => undefined);
});

describe('the Samba AD container', () => {
  it('refuses a simple bind over plain LDAP', async () => {
    // Stricter than OpenLDAP, which serves plaintext happily. A fixture shared
    // between the two must default to encrypted rather than assume plain
    // works -- even for a read-only sanity check.
    //
    // 1390, not 1389: `openldap` in the same compose file owns 1389, and
    // pointing this at that port would have asked OpenLDAP whether Samba
    // requires encryption.
    const plain = new Client({
      url: process.env.SAMBA_LDAP_URL ?? 'ldap://localhost:1390',
      connectTimeout: 10_000,
    });
    await expect(plain.bind(connection.bindDn, connection.bindPassword)).rejects.toThrow(
      /Transport encryption required|StrongAuthRequired/i,
    );
    await plain.unbind().catch(() => undefined);
  });

  it('rejects a duplicate sAMAccountName at the server', async () => {
    const dn = `CN=smoke uniq one,${usersDn}`;
    const clash = `CN=smoke uniq two,${usersDn}`;
    await client.add(dn, {
      objectClass: ['top', 'person', 'organizationalPerson', 'user'],
      sAMAccountName: 'smokeuniq',
      userAccountControl: '514',
    });
    // 00002071: samldb: samAccountName 'smokeuniq' already in use! Code: 0x44
    await expect(
      client.add(clash, {
        objectClass: ['top', 'person', 'organizationalPerson', 'user'],
        sAMAccountName: 'smokeuniq',
        userAccountControl: '514',
      }),
    ).rejects.toThrow(/already in use|AlreadyExists/i);
  });

  it('round-trips userAccountControl from 514 to 512', async () => {
    const dn = `CN=smoke uac,${usersDn}`;
    await client.add(dn, {
      objectClass: ['top', 'person', 'organizationalPerson', 'user'],
      sAMAccountName: 'smokeuac',
      // 514 = normal account, disabled. Step 1 of creation always writes this:
      // an account that exists and is enabled before its password is set is a
      // window nobody asked for.
      userAccountControl: '514',
    });
    const before = await client.search(dn, {
      scope: 'base',
      filter: '(objectClass=*)',
      attributes: ['userAccountControl'],
    });
    expect(String(before.searchEntries[0]!.userAccountControl)).toBe('514');

    await client.modify(dn, replace('userAccountControl', '512'));

    const after = await client.search(dn, {
      scope: 'base',
      filter: '(objectClass=*)',
      attributes: ['userAccountControl'],
    });
    expect(String(after.searchEntries[0]!.userAccountControl)).toBe('512');
  });

  it('sets unicodePwd over LDAPS and the account can then bind with it', async () => {
    const dn = `CN=smoke pwd,${usersDn}`;
    const password = 'Smoke!Passw0rd42';
    await client.add(dn, {
      objectClass: ['top', 'person', 'organizationalPerson', 'user'],
      sAMAccountName: 'smokepwd',
      userPrincipalName: `smokepwd@${connection.baseDn.replace(/DC=/g, '').replace(/,/g, '.')}`,
      userAccountControl: '514',
    });

    // AD requires the value UTF-16LE encoded and wrapped in literal double
    // quotes. This is also why the transport must be encrypted: AD refuses a
    // password write over an unencrypted connection.
    await client.modify(dn, replace('unicodePwd', Buffer.from(`"${password}"`, 'utf16le')));
    await client.modify(dn, replace('userAccountControl', '512'));

    // Proved by binding, not by "the write did not throw".
    const asUser = new Client({
      url: connection.url,
      tlsOptions: { rejectUnauthorized: false },
      connectTimeout: 10_000,
    });
    await asUser.bind(dn, password);
    await asUser.unbind();
  });

  it('moves an account between organizational units with modifyDN', async () => {
    // Under the OU this file owns, so beforeEach can empty them.
    const fromOu = `OU=SmokeFrom,${usersDn}`;
    const toOu = `OU=SmokeTo,${usersDn}`;
    for (const ou of [fromOu, toOu]) {
      await client.add(ou, { objectClass: ['top', 'organizationalUnit'] }).catch(() => undefined);
    }
    const dn = `CN=smoke move,${fromOu}`;
    const moved = `CN=smoke move,${toOu}`;
    await client.add(dn, {
      objectClass: ['top', 'person', 'organizationalPerson', 'user'],
      sAMAccountName: 'smokemove',
      userAccountControl: '514',
    });

    // ldapts's modifyDN(dn, fullNewDn) takes THE COMPLETE NEW DN as its second
    // argument -- NOT (dn, newRdn, newSuperior). The three-argument call
    // throws `TypeError: control.write is not a function`, because the third
    // positional argument is treated as an LDAP control, which reads as a
    // library bug rather than a signature mistake and costs an afternoon.
    // Confirmed by hitting it during the spike.
    await client.modifyDN(dn, moved);

    const atNew = await client.search(moved, {
      scope: 'base',
      filter: '(objectClass=*)',
      attributes: ['dn'],
    });
    expect(atNew.searchEntries).toHaveLength(1);
    await expect(
      client.search(dn, { scope: 'base', filter: '(objectClass=*)', attributes: ['dn'] }),
    ).rejects.toThrow();
  });
});
