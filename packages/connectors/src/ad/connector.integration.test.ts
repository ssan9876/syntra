import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Attribute, Change, Client } from 'ldapts';
import { normaliseAnchor } from '../ldap/anchor.js';
import { adTargetConnector } from './connector.js';
import { objectSidRid } from './sid.js';
// A plain module. Importing `samba.smoke.test.js` would register its hooks and
// its five tests inside THIS file's collection and run them again -- and they
// are not idempotent.
import {
  connectAsSambaAdmin,
  purgeSubtree,
  sambaConnection,
} from './samba-connection.js';
import type { AdTargetConfig } from './config.js';

const samba = sambaConnection();
const testOu = `OU=ProvisionTest,${samba.baseDn}`;
const archiveOu = `OU=ProvisionArchive,${samba.baseDn}`;
const groupsOu = `OU=ProvisionGroups,${samba.baseDn}`;

const config: AdTargetConfig & { bindPassword: string } = {
  url: samba.url,
  tlsMode: 'ldaps',
  rejectUnauthorized: false,
  bindDn: samba.bindDn,
  bindPassword: samba.bindPassword,
  baseDn: testOu,
  entitlementSearchBase: groupsOu,
  archiveContainer: archiveOu,
  provenanceAttribute: 'info',
};

let admin: Client;

/** Removes every object under the test OUs so each test starts clean. */
async function purge(): Promise<void> {
  for (const base of [testOu, groupsOu, archiveOu]) {
    await purgeSubtree(admin, base);
  }
}

beforeAll(async () => {
  admin = await connectAsSambaAdmin();
  for (const ou of [testOu, archiveOu, groupsOu]) {
    await admin
      .add(ou, { objectClass: ['top', 'organizationalUnit'] })
      .catch(() => undefined);
  }
}, 120_000);

beforeEach(purge);

afterAll(async () => {
  await purge();
  await admin?.unbind().catch(() => undefined);
});

const INITIAL_PASSWORD = 'Provision!Initial0';

const createOp = (actionId: string, correlationKey: string, enabled = true) => ({
  op: 'create_account' as const,
  actionId,
  correlationKey,
  attributes: {
    displayName: ['Anna Novak'],
    givenName: ['Anna'],
    sn: ['Novak'],
    userPrincipalName: [`${correlationKey}@syntra.test`],
    mail: [`${correlationKey}@syntra.test`],
    distinguishedName: [`CN=${correlationKey},${testOu}`],
  },
  enabled,
  // Supplied, never invented here. The connector writes exactly this value,
  // which is what lets Task 14 seal it into the vault and deliver it.
  initialPassword: INITIAL_PASSWORD,
});

async function readUac(dn: string): Promise<number> {
  const { searchEntries } = await admin.search(dn, {
    scope: 'base',
    filter: '(objectClass=*)',
    attributes: ['userAccountControl'],
  });
  return Number(searchEntries[0]!.userAccountControl);
}

async function readAttribute(dn: string, attribute: string): Promise<string> {
  const { searchEntries } = await admin.search(dn, {
    scope: 'base',
    filter: '(objectClass=*)',
    attributes: [attribute],
  });
  return String(searchEntries[0]?.[attribute] ?? '');
}

async function addGroup(cn: string, sam: string): Promise<string> {
  const dn = `CN=${cn},${groupsOu}`;
  await admin.add(dn, { objectClass: ['top', 'group'], sAMAccountName: sam });
  return dn;
}

describe('adTargetConnector — test and discovery', () => {
  it('connects and reports what it found', async () => {
    const result = await adTargetConnector.test(config);
    expect(result.ok).toBe(true);
    expect(result.message).toContain(samba.url);
  });

  it('refuses to connect with certificate verification left on', async () => {
    // The container's certificate is self-signed. Turning verification off is
    // a deliberate, explicit decision, never a default.
    const result = await adTargetConnector.test({ ...config, rejectUnauthorized: true });
    expect(result.ok).toBe(false);
  });

  it('reports the counts it read as a SAMPLE from the same searches', async () => {
    // Ruling P25 in miniature: these two numbers come from the two searches
    // reported alongside them, and from nowhere else. They are unpaged and the
    // server caps them, so they are an "is anything there" signal for a
    // connection test and never a denominator for the guard.
    //
    // One account and TWO groups, deliberately: with one of each the two
    // numbers are interchangeable and a connector that swapped them would be
    // indistinguishable from one that did not. The mutation pass found exactly
    // that against the symmetric fixture.
    await adTargetConnector.write(config, createOp('count-1', 'sam.count'));
    await addGroup('CountedOne', 'CountedOne');
    await addGroup('CountedTwo', 'CountedTwo');
    const result = await adTargetConnector.test(config);
    expect(result.sampleCounts).toEqual({ user: 1, group: 2, orgUnit: 0 });
  });

  it('enumerates groups as entitlements keyed on objectGUID', async () => {
    await addGroup('Finance', 'Finance');
    const found = [];
    for await (const entitlement of adTargetConnector.listEntitlements(config)) {
      found.push(entitlement);
    }
    expect(found).toHaveLength(1);
    expect(found[0]!.displayName).toBe('Finance');
    expect(found[0]!.type).toBe('group');
    // The group's objectGUID, not its name or DN. Renaming a group must not
    // read as "revoke this from all 400 holders and grant a new thing".
    expect(found[0]!.externalId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('reports the group distinguished name alongside its objectGUID', async () => {
    // Both, and for different reasons. `externalId` is the identity, so a
    // rename is not a mass revoke-and-regrant. `dn` is what a user's
    // `memberOf` actually contains, so without it there is no way to map a
    // membership list back onto entitlements -- and every lookup misses
    // silently, which reads as "this account holds nothing".
    await addGroup('Payroll', 'Payroll');
    const found = [];
    for await (const entitlement of adTargetConnector.listEntitlements(config)) {
      found.push(entitlement);
    }
    expect(found[0]!.dn.toLowerCase()).toBe(`cn=payroll,${groupsOu}`.toLowerCase());
    expect(found[0]!.dn).not.toBe(found[0]!.externalId);
  });

  it('carries a group description through when the directory holds one', async () => {
    await admin.add(`CN=Described,${groupsOu}`, {
      objectClass: ['top', 'group'],
      sAMAccountName: 'Described',
      description: 'the people who approve payments',
    });
    const found = [];
    for await (const e of adTargetConnector.listEntitlements(config)) found.push(e);
    expect(found[0]!.description).toBe('the people who approve payments');
  });

  it('omits description entirely rather than reporting an empty one', async () => {
    await addGroup('Undescribed', 'Undescribed');
    const found = [];
    for await (const e of adTargetConnector.listEntitlements(config)) found.push(e);
    expect(found[0]).not.toHaveProperty('description');
  });

  it('lists containers that hold no accounts at all', async () => {
    // The whole reason containers are read rather than inferred from the DNs
    // of the accounts returned: an empty OU is a real, configured place to put
    // people, and on a first run against an empty target EVERY OU is empty.
    await admin.add(`OU=Empty,${testOu}`, {
      objectClass: ['top', 'organizationalUnit'],
    });
    const containers = [];
    for await (const container of adTargetConnector.listContainers(config)) {
      containers.push(container.dn.toLowerCase());
    }
    expect(containers).toContain(`ou=empty,${testOu}`.toLowerCase());
    expect(containers).toContain(testOu.toLowerCase());
  });

  it('yields the search base exactly once, however the directory spells it', async () => {
    // The base is yielded explicitly, because a domain object is not returned
    // by a subtree search for those two object classes. When it IS returned --
    // as here, where the base is an OU -- the de-duplication has to fold case,
    // or an administrator is offered the same container twice and a
    // container-exists check can match the wrong spelling of the right place.
    const containers = [];
    for await (const container of adTargetConnector.listContainers({
      ...config,
      baseDn: testOu.toLowerCase(),
    })) {
      containers.push(container.dn.toLowerCase());
    }
    expect(containers.filter((dn) => dn === testOu.toLowerCase())).toHaveLength(1);
  });

  it('names the rights it could not exercise rather than reporting a bare success', async () => {
    // Spec section 18: the bind should hold only the rights it needs, and
    // `test` reports which of those it could not exercise, so an
    // over-privileged bind is a visible choice rather than a default. Read
    // through Active Directory's effective-rights attributes -- it never
    // writes a probe object, because there would then be a probe object to
    // delete and this connector has no delete.
    const result = await adTargetConnector.test(config);
    expect(result.ok).toBe(true);
    const rights = result.rights!;
    expect(rights.map((r) => r.right).sort()).toEqual([
      'createUser',
      'modifyMembership',
      'modifyUser',
      'moveUser',
    ]);
    // Every right is accounted for. A server that does not publish effective
    // rights yields `unverified`, which is not the same as `granted` and must
    // never be reported as one.
    for (const right of rights) {
      expect(['granted', 'denied', 'unverified']).toContain(right.status);
    }
  });

  it('confirms all four rights when the bind genuinely holds them', async () => {
    // Bound as Administrator against a target holding an account and a group,
    // Samba publishes `allowedChildClassesEffective` and
    // `allowedAttributesEffective` and every one of the four is in them. This
    // is the `granted` half of the distinction the next test pins the other
    // half of.
    await adTargetConnector.write(config, createOp('rights-1', 'ray.hoek'));
    await addGroup('RightsGroup', 'RightsGroup');
    const result = await adTargetConnector.test(config);
    expect(result.rights!.map((r) => `${r.right}:${r.status}`).sort()).toEqual([
      'createUser:granted',
      'modifyMembership:granted',
      'modifyUser:granted',
      'moveUser:granted',
    ]);
    expect(result.message).toContain('all four write rights confirmed');
  });

  it('reports unverified, not granted, for a right it could not read', async () => {
    // The whole reason `unverified` is a third state. A server that does not
    // answer cannot be read as having said yes, and the console renders the
    // three differently on the strength of that. Here the archive container
    // does not exist, so the read for `moveUser` fails outright while the
    // other three are unaffected.
    await adTargetConnector.write(config, createOp('rights-2', 'una.berg'));
    await addGroup('RightsGroupTwo', 'RightsGroupTwo');
    const result = await adTargetConnector.test({
      ...config,
      archiveContainer: `OU=NoSuchArchive,${samba.baseDn}`,
    });
    const move = result.rights!.find((r) => r.right === 'moveUser')!;
    expect(move.status).toBe('unverified');
    expect(move.status).not.toBe('granted');
    expect(move.detail).toContain('NoSuchArchive');
    expect(result.rights!.find((r) => r.right === 'createUser')!.status).toBe('granted');
    // Still ok, and still says so out loud. A connection test that failed here
    // would stop an administrator configuring a target they can legitimately
    // read but not yet fully write.
    expect(result.ok).toBe(true);
    expect(result.message).toContain('1 of 4 write rights not confirmed');
    expect(result.message).toContain('moveUser (unverified)');
  });

  it('reports unverified when the target holds nothing to read a right from', async () => {
    // An empty target: no account and no group to read effective rights from.
    // Reporting `granted` here would mean a brand-new target always claims
    // every right it has never exercised.
    const result = await adTargetConnector.test(config);
    const byRight = new Map(result.rights!.map((r) => [r.right, r]));
    expect(byRight.get('modifyUser')!.status).toBe('unverified');
    expect(byRight.get('modifyUser')!.detail).toContain('holds no account yet');
    expect(byRight.get('modifyMembership')!.status).toBe('unverified');
    expect(byRight.get('modifyMembership')!.detail).toContain('offers no group yet');
  });

  it('excludes a configured primary group from the catalog', async () => {
    await addGroup('Domain Users Clone', 'DomainUsersClone');
    const first = [];
    for await (const e of adTargetConnector.listEntitlements(config)) first.push(e);
    const excluded = [];
    for await (const e of adTargetConnector.listEntitlements({
      ...config,
      primaryGroupExternalIds: [first[0]!.externalId],
    })) {
      excluded.push(e);
    }
    expect(excluded).toHaveLength(0);
  });

  it('excludes the primary group by exact identifier, not by case', async () => {
    // The opposite rule from the container comparison above, and for the
    // opposite reason: an external id is an opaque objectGUID, not a DN.
    // Every id this system produces is lowercase, so one arriving in another
    // case names nothing here -- and quietly folding it would let a
    // mis-transcribed configuration value hide a real group from the catalog.
    await addGroup('Case Sensitive', 'CaseSensitive');
    const found = [];
    for await (const e of adTargetConnector.listEntitlements(config)) found.push(e);
    const upper = found[0]!.externalId.toUpperCase();
    expect(upper).not.toBe(found[0]!.externalId);
    const stillListed = [];
    for await (const e of adTargetConnector.listEntitlements({
      ...config,
      primaryGroupExternalIds: [upper],
    })) {
      stillListed.push(e);
    }
    expect(stillListed).toHaveLength(1);
  });

  it('reports denied, not granted, for a right the bind genuinely lacks', async () => {
    // The whole point of section 18. Bound as an ordinary account rather than
    // as Administrator, Samba answers `allowedChildClassesEffective` and
    // `allowedAttributesEffective` with ZERO values while the schema twins
    // still hold 69 and 391 -- so the server has spoken, and what it said is
    // no. Against the admin bind every right is granted, which is why nothing
    // else in this file can tell `denied` apart from `granted`.
    const lowDn = `CN=low.priv,${testOu}`;
    await adTargetConnector.write(config, {
      ...createOp('rights-3', 'low.priv'),
      attributes: {
        ...createOp('rights-3', 'low.priv').attributes,
        distinguishedName: [lowDn],
      },
    });
    await addGroup('LowPrivGroup', 'LowPrivGroup');
    const result = await adTargetConnector.test({
      ...config,
      bindDn: lowDn,
      bindPassword: INITIAL_PASSWORD,
    });
    expect(result.ok).toBe(true);
    // All FOUR, not merely one of them. This bind can read its own account and
    // may write a handful of its own attributes, so `modifyUser` reaches
    // `denied` by a different route from the other three -- and a mutation
    // that turned the other three into `unverified` was invisible to an
    // assertion that only asked for one `denied` somewhere.
    expect(result.rights!.map((r) => `${r.right}:${r.status}`).sort()).toEqual([
      'createUser:denied',
      'modifyMembership:denied',
      'modifyUser:denied',
      'moveUser:denied',
    ]);
    expect(result.rights![0]!.detail).toContain('this bind cannot perform this operation');
    expect(result.message).toContain('4 of 4 write rights not confirmed');
  });

  it('reports unverified against a server that does not publish effective rights', async () => {
    // OpenLDAP, which implements neither constructed attribute. It answers the
    // request with an empty key all the same -- ldapts echoes every REQUESTED
    // attribute name back whether the server holds it or not, confirmed by
    // asking both containers for `notARealAttributeAtAll` and getting the key
    // back -- so "the key is missing" is NOT the signal, and reading it that
    // way reports all four rights `denied`: "this bind cannot perform this
    // operation and the first apply that needs it will fail", which is false.
    // The schema twin `allowedChildClasses` is the discriminator: 69 values on
    // Samba for any bind, zero on OpenLDAP.
    const result = await adTargetConnector.test({
      url: process.env.LDAPS_URL ?? 'ldaps://localhost:1636',
      tlsMode: 'ldaps',
      rejectUnauthorized: false,
      bindDn: 'cn=admin,dc=acme,dc=test',
      bindPassword: 'adminpassword',
      baseDn: 'dc=acme,dc=test',
      entitlementSearchBase: 'dc=acme,dc=test',
      archiveContainer: 'dc=acme,dc=test',
      accountFilter: '(objectClass=person)',
    });
    expect(result.ok).toBe(true);
    expect(result.rights!.map((r) => r.status)).toEqual([
      'unverified',
      'unverified',
      'unverified',
      'unverified',
    ]);
    expect(result.rights![0]!.detail).toContain('does not publish effective rights');
    expect(result.message).toContain('4 of 4 write rights not confirmed');
  });

  it('describes the schema from what the target actually holds', async () => {
    await adTargetConnector.write(config, createOp('schema-1', 'sky.demir'));
    const schema = await adTargetConnector.discoverSchema(config);
    expect(schema.objectClasses).toContain('user');
    expect(schema.attributes).toContain('sAMAccountName');
    expect(schema.attributes).toContain('userAccountControl');
    // `*` and `+` are the request's wildcards echoed back, not attributes any
    // mapping could ever be written against.
    expect(schema.attributes).not.toContain('*');
    expect(schema.attributes).not.toContain('+');
    expect([...schema.attributes]).toEqual([...schema.attributes].sort());
  });
});

describe('adTargetConnector — create_account, which is three writes', () => {
  it('creates a disabled object, sets the password, then enables it', async () => {
    const result = await adTargetConnector.write(config, createOp('action-1', 'anna.novak'));
    expect(result.ok).toBe(true);
    // objectGUID, rendered the way Microsoft tooling does, so it can be
    // pasted into AD and find the same object.
    expect(result.anchor).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(await readUac(`CN=anna.novak,${testOu}`)).toBe(512);
  });

  it('writes the attributes it was given', async () => {
    await adTargetConnector.write(config, createOp('attr-1', 'ada.vos'));
    const dn = `CN=ada.vos,${testOu}`;
    expect(await readAttribute(dn, 'displayName')).toBe('Anna Novak');
    expect(await readAttribute(dn, 'userPrincipalName')).toBe('ada.vos@syntra.test');
    expect(await readAttribute(dn, 'sAMAccountName')).toBe('ada.vos');
  });

  it('sets the password the CALLER supplied, and the account can bind with it', async () => {
    // The connector generates no password. If it invented one, this bind would
    // fail with the value Task 14 sealed into the vault and delivered -- and
    // no account Provision creates would be usable by the person it was
    // created for. Proved by binding, not by "the write did not throw".
    await adTargetConnector.write(config, createOp('pwd-1', 'pia.lund'));
    const asUser = new Client({
      url: samba.url,
      tlsOptions: { rejectUnauthorized: false },
      connectTimeout: 10_000,
    });
    await asUser.bind(`CN=pia.lund,${testOu}`, INITIAL_PASSWORD);
    await asUser.unbind();
  });

  it('places the account under the base when it is given no distinguished name', async () => {
    const op = createOp('dn-1', 'ned.blok');
    const { distinguishedName: _dropped, ...attributes } = op.attributes;
    const result = await adTargetConnector.write(config, { ...op, attributes });
    expect(result.ok).toBe(true);
    expect(await readUac(`CN=ned.blok,${testOu}`)).toBe(512);
  });

  it('honours the distinguished name it was given, over the fallback', async () => {
    // Into a sub-OU, so the supplied DN and the `CN=<key>,<baseDn>` fallback
    // are DIFFERENT strings. Every other create in this file supplies a DN
    // that happens to equal the fallback exactly, which makes a connector that
    // ignores the parameter indistinguishable from one that honours it -- the
    // mutation pass found it, and it is the same shape as the Task 2 fixture
    // that agreed with its own bug.
    const subOu = `OU=Placed,${testOu}`;
    await admin.add(subOu, { objectClass: ['top', 'organizationalUnit'] });
    const op = createOp('dn-2', 'placed.person');
    const result = await adTargetConnector.write(config, {
      ...op,
      attributes: { ...op.attributes, distinguishedName: [`CN=placed.person,${subOu}`] },
    });
    expect(result.ok).toBe(true);
    const { searchEntries } = await admin.search(testOu, {
      scope: 'sub',
      filter: '(sAMAccountName=placed.person)',
      attributes: ['distinguishedName'],
    });
    expect(String(searchEntries[0]!.distinguishedName)).toBe(`CN=placed.person,${subOu}`);
  });

  it('adopts an account that has since been moved into a sub-container', async () => {
    // The correlation-key lookup is a SUBTREE search. Scoped to one level it
    // finds nothing here, the create is issued again, and the server refuses it
    // with `already in use` -- so a person an administrator tidied into a
    // sub-OU becomes a permanent conflict that no retry can clear.
    const subOu = `OU=Moved,${testOu}`;
    await admin.add(subOu, { objectClass: ['top', 'organizationalUnit'] });
    const created = await adTargetConnector.write(config, createOp('dn-3', 'moved.person'));
    await admin.modifyDN(`CN=moved.person,${testOu}`, `CN=moved.person,${subOu}`);
    const retry = await adTargetConnector.write(config, createOp('dn-3', 'moved.person'));
    expect(retry.ok).toBe(true);
    expect(retry.message).toContain('adopted');
    expect(retry.anchor).toBe(created.anchor);
  });

  it('escapes the correlation key it puts in a filter, so a wildcard matches nothing', async () => {
    // `ab*` is refused by Active Directory as a sAMAccountName -- but the
    // LOOKUP runs first, and unescaped it becomes `(sAMAccountName=ab*)`, a
    // substring match that finds the unrelated `abc` and answers `conflict`.
    // Escaped, nothing matches, the add is issued, and the server refuses the
    // character itself: `rejected`, which is the truthful answer.
    await adTargetConnector.write(config, createOp('esc-1', 'abc'));
    const clash = await adTargetConnector.write(config, {
      ...createOp('esc-2', 'ab*'),
      attributes: {
        ...createOp('esc-2', 'ab*').attributes,
        distinguishedName: [`CN=abstar,${testOu}`],
      },
    });
    expect(clash.ok).toBe(false);
    expect(clash.failure).toBe('rejected');
    expect(clash.message).toMatch(/invalid|character/i);
  });

  it('leaves a pre-hire created and disabled', async () => {
    // A pre-hire stops after the password. Only the account object exists
    // early, disabled and empty; access itself is granted on the day.
    await adTargetConnector.write(config, createOp('action-2', 'bo.lind', false));
    expect(await readUac(`CN=bo.lind,${testOu}`)).toBe(514);
  });

  it('writes the provenance marker so a retry can adopt', async () => {
    await adTargetConnector.write(config, createOp('action-3', 'cy.marsh'));
    const { searchEntries } = await admin.search(`CN=cy.marsh,${testOu}`, {
      scope: 'base',
      filter: '(objectClass=*)',
      attributes: ['info'],
    });
    expect(String(searchEntries[0]!.info)).toContain('action-3');
  });

  it('keeps the marker when an attribute template writes to the same attribute', async () => {
    // `op.attributes` used to be spread LAST into `client.add`, so a profile
    // whose template writes `info` overwrote the marker outright. One failed
    // password write afterwards then made the create a permanent `conflict`,
    // because nothing could recognise the object as ours -- and this is the
    // adoption path proving it can.
    const op = createOp('action-3b', 'ida.roos');
    const templated = {
      ...op,
      attributes: { ...op.attributes, info: ['Contractor, ends 2027-01-01'] },
    };
    expect((await adTargetConnector.write(config, templated)).ok).toBe(true);

    const { searchEntries } = await admin.search(`CN=ida.roos,${testOu}`, {
      scope: 'base',
      filter: '(objectClass=*)',
      attributes: ['info'],
    });
    const info = String(searchEntries[0]!.info);
    // Both. Neither side wins: the marker is machine-readable inside the
    // administrator's own text, which is why it is parsed at a token boundary.
    expect(info).toContain('action-3b');
    expect(info).toContain('Contractor, ends 2027-01-01');

    const retry = await adTargetConnector.write(config, templated);
    expect(retry.ok).toBe(true);
    expect(retry.message).toContain('adopted');
  });

  it('adopts its own account on retry rather than creating a second', async () => {
    await adTargetConnector.write(config, createOp('action-4', 'dee.olsen'));
    const retry = await adTargetConnector.write(config, createOp('action-4', 'dee.olsen'));
    expect(retry.ok).toBe(true);
    expect(retry.message).toContain('adopted');
    const { searchEntries } = await admin.search(testOu, {
      scope: 'sub',
      filter: '(sAMAccountName=dee.olsen)',
      attributes: ['dn'],
    });
    expect(searchEntries).toHaveLength(1);
  });

  it('returns the same anchor when it adopts as when it created', async () => {
    // The anchor is the whole product of a create. An adopt that answered
    // `ok` without one leaves the caller with a successful action and no
    // identifier, and every later operation on that person resolves nothing.
    const created = await adTargetConnector.write(config, createOp('action-4b', 'des.olsen'));
    const adopted = await adTargetConnector.write(config, createOp('action-4b', 'des.olsen'));
    expect(adopted.anchor).toBe(created.anchor);
    expect(adopted.anchor).toBeDefined();
  });

  it('conflicts rather than adopting an account it did not create', async () => {
    await adTargetConnector.write(config, createOp('action-5', 'eve.stern'));
    const other = await adTargetConnector.write(
      config,
      createOp('a-different-action', 'eve.stern'),
    );
    expect(other.ok).toBe(false);
    expect(other.failure).toBe('conflict');
  });

  it('never treats a GROUP of the same name as an account it could adopt', async () => {
    // Active Directory enforces sAMAccountName uniqueness across every
    // security principal, so a group can hold the name an account wants. The
    // correlation lookup is conjoined with `accountFilter` precisely so the
    // adoption path cannot reach a non-account: the add is still issued and
    // the SERVER refuses it, which is a different sentence from this
    // connector claiming an account is already there.
    await admin.add(`CN=GhostGroup,${testOu}`, {
      objectClass: ['top', 'group'],
      sAMAccountName: 'ghost.acct',
    });
    const result = await adTargetConnector.write(config, createOp('ghost-1', 'ghost.acct'));
    expect(result.ok).toBe(false);
    expect(result.failure).toBe('conflict');
    expect(result.message).toMatch(/already in use/i);
    expect(result.message).not.toContain('provenance marker');
  });

  it('conflicts when the recorded action id merely STARTS WITH this one', async () => {
    // `marker.includes(op.actionId)` adopts here, which is the one outcome the
    // provenance marker exists to prevent: action `act-1` walking off with the
    // account action `act-10` created for somebody else.
    await adTargetConnector.write(config, createOp('act-10', 'fen.doorn'));
    const prefix = await adTargetConnector.write(config, createOp('act-1', 'fen.doorn'));
    expect(prefix.ok).toBe(false);
    expect(prefix.failure).toBe('conflict');
  });

  it('classifies a duplicate sAMAccountName as a conflict, not a transient failure', async () => {
    await adTargetConnector.write(config, createOp('action-6', 'fay.brandt'));
    const clash = await adTargetConnector.write(config, {
      ...createOp('action-7', 'fay.brandt'),
      attributes: {
        ...createOp('action-7', 'fay.brandt').attributes,
        distinguishedName: [`CN=fay brandt two,${testOu}`],
      },
    });
    // A duplicate name does not become true on the fourth attempt.
    expect(clash.failure).toBe('conflict');
  });
});

describe('adTargetConnector — the account lifecycle', () => {
  const anchorFor = async (actionId: string, key: string) => {
    const result = await adTargetConnector.write(config, createOp(actionId, key));
    return result.anchor!;
  };

  it('disables and writes the reason into info, preserving other flags', async () => {
    const anchor = await anchorFor('life-1', 'gil.hart');
    const result = await adTargetConnector.write(config, {
      op: 'disable_account',
      actionId: 'life-1-d',
      anchor,
      reason: 'contract ended 2026-06-15',
    });
    expect(result.ok).toBe(true);
    expect(await readUac(`CN=gil.hart,${testOu}`)).toBe(514);
    const { searchEntries } = await admin.search(`CN=gil.hart,${testOu}`, {
      scope: 'base',
      filter: '(objectClass=*)',
      attributes: ['info'],
    });
    const info = String(searchEntries[0]!.info);
    expect(info).toContain('contract ended 2026-06-15');
    // The disable used to `replace` the literal `info` with the reason alone,
    // which destroyed whatever an administrator had in Notes and, by default,
    // destroyed the provenance marker with it -- on exactly the accounts a
    // later run may still need to recognise as Syntra's.
    expect(info).toContain('life-1');
  });

  it('sets the disable bit without resetting the flags an administrator set', async () => {
    // 66048 = NORMAL_ACCOUNT | DONT_EXPIRE_PASSWORD, an entirely ordinary
    // service or executive account. Writing a bare 514 would silently turn
    // password expiry back on for that person, which is a change nobody asked
    // for on the day they leave.
    const anchor = await anchorFor('life-1b', 'tom.dijk');
    const dn = `CN=tom.dijk,${testOu}`;
    await admin.modify(
      dn,
      new Change({
        operation: 'replace',
        modification: new Attribute({ type: 'userAccountControl', values: ['66048'] }),
      }),
    );
    await adTargetConnector.write(config, {
      op: 'disable_account',
      actionId: 'life-1b-d',
      anchor,
      reason: 'left',
    });
    expect(await readUac(dn)).toBe(66_050);
    await adTargetConnector.write(config, {
      op: 'enable_account',
      actionId: 'life-1b-e',
      anchor,
    });
    expect(await readUac(dn)).toBe(66_048);
  });

  it('is idempotent: disabling twice leaves the same state', async () => {
    const anchor = await anchorFor('life-2', 'hal.reyes');
    const op = {
      op: 'disable_account' as const,
      actionId: 'life-2-d',
      anchor,
      reason: 'left',
    };
    await adTargetConnector.write(config, op);
    const second = await adTargetConnector.write(config, op);
    expect(second.ok).toBe(true);
    expect(await readUac(`CN=hal.reyes,${testOu}`)).toBe(514);
  });

  it('enables a disabled account', async () => {
    const anchor = await anchorFor('life-3', 'ida.wolf');
    await adTargetConnector.write(config, {
      op: 'disable_account',
      actionId: 'life-3-d',
      anchor,
      reason: 'left',
    });
    await adTargetConnector.write(config, {
      op: 'enable_account',
      actionId: 'life-3-e',
      anchor,
    });
    expect(await readUac(`CN=ida.wolf,${testOu}`)).toBe(512);
  });

  it('answers not_found for an anchor no object carries', async () => {
    const missing = await adTargetConnector.write(config, {
      op: 'enable_account',
      actionId: 'life-3-x',
      anchor: '00000000-0000-0000-0000-000000000000',
    });
    expect(missing.ok).toBe(false);
    expect(missing.failure).toBe('not_found');
  });

  it('resolves an anchor exactly, never case-insensitively', async () => {
    // An anchor is an opaque objectGUID and not a DN. `normaliseAnchor`
    // renders every one lowercase, so an anchor in another case did not come
    // out of this system: resolving it anyway would mean a mis-transcribed or
    // externally-supplied identifier silently addresses a real person's
    // account. Folding this comparison survives every other test in the file.
    const anchor = await anchorFor('life-3c', 'zoe.kappe');
    const upper = anchor.toUpperCase();
    expect(upper).not.toBe(anchor);
    const result = await adTargetConnector.write(config, {
      op: 'disable_account',
      actionId: 'life-3c-d',
      anchor: upper,
      reason: 'left',
    });
    expect(result.ok).toBe(false);
    expect(result.failure).toBe('not_found');
    expect(await readUac(`CN=zoe.kappe,${testOu}`)).toBe(512);
  });

  it('will not resolve an anchor that belongs to a group rather than an account', async () => {
    // The scoped objectGUID filter is conjoined with `accountFilter`. Without
    // that, a group's objectGUID handed in as an anchor resolves to the GROUP,
    // and `disable_account` then writes `userAccountControl` onto it -- an
    // operation aimed at a person landing on an object that is not one.
    const groupDn = `CN=AnchorGroup,${testOu}`;
    await admin.add(groupDn, {
      objectClass: ['top', 'group'],
      sAMAccountName: 'AnchorGroup',
    });
    const { searchEntries } = await admin.search(groupDn, {
      scope: 'base',
      filter: '(objectClass=*)',
      attributes: ['objectGUID'],
    });
    const groupAnchor = normaliseAnchor(
      'objectGUID',
      searchEntries[0]!.objectGUID as unknown as Buffer,
    );
    const result = await adTargetConnector.write(config, {
      op: 'disable_account',
      actionId: 'anchor-group',
      anchor: groupAnchor,
      reason: 'left',
    });
    expect(result.ok).toBe(false);
    expect(result.failure).toBe('not_found');
    // The MESSAGE, not only the failure. Without the conjunction the group
    // resolves, the disable is attempted on it, and Samba answers
    // `NoSuchAttribute` because a group has no userAccountControl -- which
    // this connector also classifies `not_found`. The two are one code away
    // from each other and the status alone cannot tell them apart.
    expect(result.message).toContain('no object at anchor');
  });

  it('resolves an anchor with ONE search rather than reading every account', async () => {
    // The objectGUID fast path, proven to fire rather than assumed to. It is
    // an optimisation whose fall-through is correct, so nothing else in this
    // file can tell a working one from an inert one -- and the plan's escaped
    // `\8a\74…` filter was inert against ldapts, which made "a 500-action
    // apply performs 500 full directory reads" the only behaviour there was.
    const anchor = await anchorFor('life-3e', 'one.search');
    const original = Client.prototype.search;
    const bases: string[] = [];
    try {
      Client.prototype.search = async function counted(
        this: Client,
        ...args: Parameters<Client['search']>
      ) {
        bases.push(String(args[0]));
        return original.apply(this, args);
      } as Client['search'];
      const result = await adTargetConnector.write(config, {
        op: 'enable_account',
        actionId: 'life-3e-e',
        anchor,
      });
      expect(result.ok).toBe(true);
    } finally {
      Client.prototype.search = original;
    }
    // Exactly one: the scoped filter found the object, so the subtree scan
    // never ran. Two means the fast path missed and the fallback carried it.
    expect(bases).toEqual([testOu]);
  });

  it('does not move an account whose target DN differs only in case', async () => {
    // Samba ACCEPTS a modifyDN that only re-cases the RDN and rewrites the
    // stored DN, so an exact comparison here renames the object on every run,
    // forever, over a difference that means nothing in a directory that folds
    // case. Measured against the container, not assumed.
    const anchor = await anchorFor('life-3d', 'cas.eson');
    const result = await adTargetConnector.write(config, {
      op: 'update_account',
      actionId: 'life-3d-u',
      anchor,
      attributes: { distinguishedName: [`cn=CAS.ESON,${testOu.toLowerCase()}`] },
    });
    expect(result.ok).toBe(true);
    const { searchEntries } = await admin.search(testOu, {
      scope: 'sub',
      filter: '(sAMAccountName=cas.eson)',
      attributes: ['distinguishedName'],
    });
    expect(String(searchEntries[0]!.distinguishedName)).toBe(`CN=cas.eson,${testOu}`);
  });

  it('updates the managed attributes in place', async () => {
    const anchor = await anchorFor('life-3b', 'ola.rys');
    const result = await adTargetConnector.write(config, {
      op: 'update_account',
      actionId: 'life-3b-u',
      anchor,
      attributes: { displayName: ['Ola Rys-Bakker'], title: ['Head of Payments'] },
    });
    expect(result.ok).toBe(true);
    const dn = `CN=ola.rys,${testOu}`;
    expect(await readAttribute(dn, 'displayName')).toBe('Ola Rys-Bakker');
    expect(await readAttribute(dn, 'title')).toBe('Head of Payments');
    // Desired state, written as `replace`: the same update applied twice
    // leaves the same result, which is what makes retry free.
    const again = await adTargetConnector.write(config, {
      op: 'update_account',
      actionId: 'life-3b-u',
      anchor,
      attributes: { displayName: ['Ola Rys-Bakker'], title: ['Head of Payments'] },
    });
    expect(again.ok).toBe(true);
    expect(await readAttribute(dn, 'displayName')).toBe('Ola Rys-Bakker');
  });

  it('moves the account between containers without changing the anchor', async () => {
    const anchor = await anchorFor('life-4', 'jan.kovac');
    const subOu = `OU=Facilities,${testOu}`;
    await admin.add(subOu, { objectClass: ['top', 'organizationalUnit'] });

    const result = await adTargetConnector.write(config, {
      op: 'update_account',
      actionId: 'life-4-u',
      anchor,
      attributes: {
        displayName: ['Jan Kovac'],
        distinguishedName: [`CN=jan.kovac,${subOu}`],
      },
    });
    expect(result.ok).toBe(true);

    const { searchEntries } = await admin.search(testOu, {
      scope: 'sub',
      filter: '(sAMAccountName=jan.kovac)',
      attributes: ['objectGUID', 'distinguishedName'],
    });
    expect(String(searchEntries[0]!.distinguishedName)).toBe(`CN=jan.kovac,${subOu}`);
    // The anchor is unchanged, which is the whole point of anchoring on
    // objectGUID rather than the DN.
    const found = [];
    for await (const record of adTargetConnector.read(config)) found.push(record);
    expect(found.some((r) => r.anchor === anchor)).toBe(true);
  });

  it('renames the account and its own distinguished name together', async () => {
    const anchor = await anchorFor('life-4b', 'old.name');
    const result = await adTargetConnector.write(config, {
      op: 'rename_account',
      actionId: 'life-4b-r',
      anchor,
      correlationKey: 'new.name',
    });
    expect(result.ok).toBe(true);
    // Both, or the account's login and its place in the tree disagree
    // forever: the reconciler compares on sAMAccountName and would propose the
    // rename again on every run.
    expect(await readAttribute(`CN=new.name,${testOu}`, 'sAMAccountName')).toBe('new.name');
  });

  it('renames without relocating the account', async () => {
    // The container is taken from the account's CURRENT DN, so a rename of
    // somebody who was moved out of the base's top level stays where they are.
    // Composing the new DN from `config.baseDn` instead would silently drag
    // every renamed person back to the top.
    const subOu = `OU=Legal,${testOu}`;
    await admin.add(subOu, { objectClass: ['top', 'organizationalUnit'] });
    const anchor = await anchorFor('life-4c', 'sub.name');
    await adTargetConnector.write(config, {
      op: 'update_account',
      actionId: 'life-4c-u',
      anchor,
      attributes: { distinguishedName: [`CN=sub.name,${subOu}`] },
    });
    const result = await adTargetConnector.write(config, {
      op: 'rename_account',
      actionId: 'life-4c-r',
      anchor,
      correlationKey: 'sub.renamed',
    });
    expect(result.ok).toBe(true);
    const { searchEntries } = await admin.search(testOu, {
      scope: 'sub',
      filter: '(sAMAccountName=sub.renamed)',
      attributes: ['distinguishedName'],
    });
    expect(String(searchEntries[0]!.distinguishedName)).toBe(`CN=sub.renamed,${subOu}`);
  });

  it('archives by moving to the archive container and stripping only the managed groups', async () => {
    const anchor = await anchorFor('life-5', 'kit.oduya');
    for (const [cn, sam] of [
      ['Finance', 'FinanceArch'],
      ['Sports Club', 'SportsClubArch'],
    ] as const) {
      await addGroup(cn, sam);
    }
    const groups = [];
    for await (const e of adTargetConnector.listEntitlements(config)) groups.push(e);
    const managed = groups.find((g) => g.displayName === 'Finance')!;
    const unmanaged = groups.find((g) => g.displayName === 'Sports Club')!;

    for (const group of [managed, unmanaged]) {
      await adTargetConnector.write(config, {
        op: 'grant_entitlement',
        actionId: `life-5-g-${group.displayName}`,
        anchor,
        entitlementId: group.externalId,
      });
    }

    const result = await adTargetConnector.write(config, {
      op: 'archive_account',
      actionId: 'life-5-a',
      anchor,
      // ONLY the entitlements Provision manages for this account. Iterating
      // the object's own memberOf instead would strip every group it holds,
      // which asserts that Provision manages every group in the target --
      // never true (spec section 12) -- on the one step spec section 9 calls
      // the closest thing to destructive in the ladder.
      entitlementDns: [managed.dn],
    });
    expect(result.ok).toBe(true);

    const { searchEntries } = await admin.search(archiveOu, {
      scope: 'sub',
      filter: '(sAMAccountName=kit.oduya)',
      attributes: ['dn'],
    });
    // The object, its mailbox and its file ownership are intact -- it moved.
    expect(searchEntries).toHaveLength(1);

    const stripped = await admin.search(managed.dn, {
      scope: 'base',
      filter: '(objectClass=*)',
      attributes: ['member'],
    });
    expect(String(stripped.searchEntries[0]!.member ?? '')).not.toContain('kit.oduya');

    const untouched = await admin.search(unmanaged.dn, {
      scope: 'base',
      filter: '(objectClass=*)',
      attributes: ['member'],
    });
    expect(String(untouched.searchEntries[0]!.member ?? '')).toContain('kit.oduya');
  });

  it('disables the account it archives', async () => {
    // The move is not the security control; the disable is. An archived
    // account left enabled is a live credential sitting in a container nobody
    // looks at.
    const anchor = await anchorFor('life-5b', 'rob.stam');
    const result = await adTargetConnector.write(config, {
      op: 'archive_account',
      actionId: 'life-5b-a',
      anchor,
      entitlementDns: [],
    });
    expect(result.ok).toBe(true);
    expect(await readUac(`CN=rob.stam,${archiveOu}`)).toBe(514);
  });

  it('archives an account whose own RDN contains an escaped comma', async () => {
    // `CN=Stam\, Rob` is an entirely ordinary account, and Provision meets
    // them because it correlates accounts administrators created by hand.
    // Splitting the DN at `indexOf(',')` yields the RDN `CN=Stam\` and moves
    // the object to a DN nobody named -- with nothing that fails loudly.
    const dn = `CN=Stam\\, Rob,${testOu}`;
    await admin.add(dn, {
      objectClass: ['top', 'person', 'organizationalPerson', 'user'],
      sAMAccountName: 'rob.comma',
      userAccountControl: '512',
    });
    const records = [];
    for await (const record of adTargetConnector.read(config)) records.push(record);
    const anchor = records.find((r) => r.attributes.sAMAccountName?.[0] === 'rob.comma')!
      .anchor;

    const result = await adTargetConnector.write(config, {
      op: 'archive_account',
      actionId: 'life-5c-a',
      anchor,
      entitlementDns: [],
    });
    expect(result.ok).toBe(true);
    const { searchEntries } = await admin.search(archiveOu, {
      scope: 'sub',
      filter: '(sAMAccountName=rob.comma)',
      attributes: ['distinguishedName'],
    });
    expect(searchEntries).toHaveLength(1);
    expect(String(searchEntries[0]!.distinguishedName)).toBe(`CN=Stam\\, Rob,${archiveOu}`);
  });

  it('treats an archive of an account already out of a group as done', async () => {
    // A set operation. The removal that finds nothing to remove is the state
    // the archive was asking for, and refusing it would leave a leaver's
    // archive stuck forever on a group they had already been taken out of by
    // hand.
    const anchor = await anchorFor('life-5d', 'lia.groen');
    const groupDn = await addGroup('NeverJoined', 'NeverJoined');
    const result = await adTargetConnector.write(config, {
      op: 'archive_account',
      actionId: 'life-5d-a',
      anchor,
      entitlementDns: [groupDn],
    });
    expect(result.ok).toBe(true);
    const { searchEntries } = await admin.search(archiveOu, {
      scope: 'sub',
      filter: '(sAMAccountName=lia.groen)',
      attributes: ['dn'],
    });
    expect(searchEntries).toHaveLength(1);
  });

  it('fails an archive whose membership removal did not succeed, rather than reporting it done', async () => {
    // The removal is against a group that no longer exists, so the modify
    // fails. Swallowing it would report a successful archive over an account
    // that still holds the access the archive was supposed to strip -- and
    // nothing would ever retry, because the action is recorded as applied.
    const anchor = await anchorFor('life-6', 'lou.marek');
    const result = await adTargetConnector.write(config, {
      op: 'archive_account',
      actionId: 'life-6-a',
      anchor,
      entitlementDns: [`CN=Vanished,${groupsOu}`],
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/membership/i);

    // And it did NOT move: the archive is retried whole rather than half-done.
    const { searchEntries } = await admin.search(archiveOu, {
      scope: 'sub',
      filter: '(sAMAccountName=lou.marek)',
      attributes: ['dn'],
    });
    expect(searchEntries).toHaveLength(0);
  });

  it('stops at the first membership it cannot remove rather than moving on', async () => {
    // The account keeps the access the archive existed to strip, so the whole
    // archive is a failure and is retried whole. Continuing past the failure
    // and moving anyway is the shape that reports success over live access.
    const anchor = await anchorFor('life-6b', 'moe.frey');
    const real = await addGroup('RealGroup', 'RealGroup');
    const groups = [];
    for await (const e of adTargetConnector.listEntitlements(config)) groups.push(e);
    await adTargetConnector.write(config, {
      op: 'grant_entitlement',
      actionId: 'life-6b-g',
      anchor,
      entitlementId: groups[0]!.externalId,
    });
    const result = await adTargetConnector.write(config, {
      op: 'archive_account',
      actionId: 'life-6b-a',
      anchor,
      entitlementDns: [`CN=Vanished,${groupsOu}`, real],
    });
    expect(result.ok).toBe(false);
    const held = await admin.search(real, {
      scope: 'base',
      filter: '(objectClass=*)',
      attributes: ['member'],
    });
    expect(String(held.searchEntries[0]!.member ?? '')).toContain('moe.frey');
  });

  it('has no delete operation to call', async () => {
    // Not disabled, not configuration-gated: absent, so that no configuration
    // mistake can produce one.
    //
    // `await expect(...)`, not a bare `expect(promise)`: without the await the
    // assertion never runs, the loop creates three unhandled rejections, and
    // the test passes whatever the connector does.
    const ops = ['delete_account', 'purge_account', 'destroy_account'];
    for (const op of ops) {
      await expect(
        adTargetConnector.write(config, { op, actionId: 'x', anchor: 'a' } as never),
      ).resolves.toMatchObject({ ok: false, failure: 'rejected' });
    }
  });

  it('refuses an operation it does not implement BEFORE it binds', async () => {
    // Pointed at a host that does not exist. A connector that opened the
    // connection first would answer `transient` here -- and `transient` is
    // retried, so a delete this connector refuses would be attempted again and
    // again. The refusal has to precede the connection to be a refusal.
    const result = await adTargetConnector.write(
      { ...config, url: 'ldaps://127.0.0.1:1' },
      { op: 'delete_account', actionId: 'x', anchor: 'a' } as never,
    );
    expect(result.failure).toBe('rejected');
    expect(result.message).toContain('there is no delete of any kind');
  });
});

describe('adTargetConnector — entitlements', () => {
  const setup = async () => {
    const created = await adTargetConnector.write(config, createOp('ent-1', 'lee.tran'));
    await addGroup('Payments', 'Payments');
    const groups = [];
    for await (const e of adTargetConnector.listEntitlements(config)) groups.push(e);
    return { anchor: created.anchor!, entitlementId: groups[0]!.externalId };
  };

  it('grants and revokes a single value on member, never replacing the attribute', async () => {
    const { anchor, entitlementId } = await setup();
    expect(
      (
        await adTargetConnector.write(config, {
          op: 'grant_entitlement',
          actionId: 'g-1',
          anchor,
          entitlementId,
        })
      ).ok,
    ).toBe(true);

    const { searchEntries } = await admin.search(`CN=Payments,${groupsOu}`, {
      scope: 'base',
      filter: '(objectClass=*)',
      attributes: ['member'],
    });
    expect(String(searchEntries[0]!.member)).toContain('lee.tran');

    expect(
      (
        await adTargetConnector.write(config, {
          op: 'revoke_entitlement',
          actionId: 'r-1',
          anchor,
          entitlementId,
        })
      ).ok,
    ).toBe(true);
  });

  it('leaves every other member of the group in place', async () => {
    // A `replace` of `member` would write the one value and drop the rest:
    // one lost race, and four hundred people lose their access at once. This
    // is the test that tells `add`/`delete` apart from `replace`.
    const { anchor, entitlementId } = await setup();
    const otherDn = `CN=other.member,${testOu}`;
    await admin.add(otherDn, {
      objectClass: ['top', 'person', 'organizationalPerson', 'user'],
      sAMAccountName: 'other.member',
      userAccountControl: '512',
    });
    await admin.modify(
      `CN=Payments,${groupsOu}`,
      new Change({
        operation: 'add',
        modification: new Attribute({ type: 'member', values: [otherDn] }),
      }),
    );

    await adTargetConnector.write(config, {
      op: 'grant_entitlement',
      actionId: 'g-1b',
      anchor,
      entitlementId,
    });
    const afterGrant = await admin.search(`CN=Payments,${groupsOu}`, {
      scope: 'base',
      filter: '(objectClass=*)',
      attributes: ['member'],
    });
    const members = ([] as unknown[])
      .concat(afterGrant.searchEntries[0]!.member as unknown as unknown[])
      .map(String);
    expect(members).toHaveLength(2);

    await adTargetConnector.write(config, {
      op: 'revoke_entitlement',
      actionId: 'r-1b',
      anchor,
      entitlementId,
    });
    const afterRevoke = await admin.search(`CN=Payments,${groupsOu}`, {
      scope: 'base',
      filter: '(objectClass=*)',
      attributes: ['member'],
    });
    expect(String(afterRevoke.searchEntries[0]!.member)).toContain('other.member');
    expect(String(afterRevoke.searchEntries[0]!.member)).not.toContain('lee.tran');
  });

  it('treats a grant of a held entitlement as a success', async () => {
    const { anchor, entitlementId } = await setup();
    const op = {
      op: 'grant_entitlement' as const,
      actionId: 'g-2',
      anchor,
      entitlementId,
    };
    await adTargetConnector.write(config, op);
    const second = await adTargetConnector.write(config, op);
    expect(second.ok).toBe(true);
    expect(second.message).toBe('already in the requested state');
  });

  it('treats a revoke of an unheld entitlement as a success', async () => {
    const { anchor, entitlementId } = await setup();
    expect(
      (
        await adTargetConnector.write(config, {
          op: 'revoke_entitlement',
          actionId: 'r-2',
          anchor,
          entitlementId,
        })
      ).ok,
    ).toBe(true);
  });

  it('refuses a revoke against the account\'s own primary group rather than reporting it done', async () => {
    // The worst outcome available here, and the one this used to produce.
    //
    // A user's primary group does not hold them in `member`, so `delete
    // member` is refused with `noSuchAttribute` -- the same error the
    // directory gives for a person who was genuinely not in the group. Read
    // as "already in the requested state", Syntra records the revoke as done,
    // the person keeps the access, and reconcile never raises it because
    // Syntra believes it acted.
    //
    // `primaryGroupExternalIds` was meant to keep these out of the catalog,
    // but it defaults to [] and nothing ever derives it -- and it could not
    // work anyway, because which group is primary is a property of the USER
    // and not of the target.
    const { anchor, entitlementId } = await setup();
    const groupDn = `CN=Payments,${groupsOu}`;
    const userDn = `CN=lee.tran,${testOu}`;

    // Active Directory only accepts a primaryGroupID naming a group the
    // account is already in, and moves that membership OUT of `member` when
    // it takes it -- which is exactly why the revoke below answers
    // noSuchAttribute.
    await admin.modify(
      groupDn,
      new Change({
        operation: 'add',
        modification: new Attribute({ type: 'member', values: [userDn] }),
      }),
    );
    const { searchEntries } = await admin.search(groupDn, {
      scope: 'base',
      filter: '(objectClass=*)',
      attributes: ['objectSid'],
      explicitBufferAttributes: ['objectSid'],
    });
    const rid = objectSidRid(searchEntries[0]!.objectSid);
    expect(rid).toBeDefined();
    await admin.modify(
      userDn,
      new Change({
        operation: 'replace',
        modification: new Attribute({
          type: 'primaryGroupID',
          values: [String(rid)],
        }),
      }),
    );

    // Measured, and not what the review predicted. The directory answers this
    // with UnwillingToPerformError (0x35) "Attribute member already deleted",
    // NOT with noSuchAttribute -- it keeps 0x10 for the other case, a group
    // the account was never in, which the test above pins as a success. So
    // the false success the review described was not reachable: 0x35 is not
    // `isAlreadyInRequestedState`, and this already returned ok: false. What
    // it returned was the raw ldapts text, which names no cause an operator
    // could act on.
    //
    // The guarantee is asserted here rather than the error code, because the
    // code is this implementation's choice and the guarantee is not.
    const result = await adTargetConnector.write(config, {
      op: 'revoke_entitlement',
      actionId: 'r-primary',
      anchor,
      entitlementId,
    });

    expect(result.ok).toBe(false);
    expect(result.failure).toBe('rejected');
    expect(result.message).not.toMatch(/already in the requested state/i);
    expect(result.message).toMatch(/primary group/i);

    // And the access really did survive the write, which is what makes
    // reporting it done the worst outcome available here.
    expect(await readAttribute(userDn, 'primaryGroupID')).toBe(String(rid));
  });

  it('answers not_found for an entitlement the target does not offer', async () => {
    const { anchor } = await setup();
    const result = await adTargetConnector.write(config, {
      op: 'grant_entitlement',
      actionId: 'g-3',
      anchor,
      entitlementId: '00000000-0000-0000-0000-000000000000',
    });
    expect(result.ok).toBe(false);
    expect(result.failure).toBe('not_found');
  });

  it('rejects an attempt to revoke a configured primary group rather than trying it', async () => {
    const { anchor, entitlementId } = await setup();
    const result = await adTargetConnector.write(
      { ...config, primaryGroupExternalIds: [entitlementId] },
      { op: 'revoke_entitlement', actionId: 'r-3', anchor, entitlementId },
    );
    // Primary group membership is not in `member` and cannot be removed by
    // writing to it. Attempted, it would fail forever.
    expect(result.ok).toBe(false);
    expect(result.failure).toBe('rejected');
    expect(result.message).toContain('primary group');
  });

  it('resolves an entitlement id exactly, never case-insensitively', async () => {
    // Same rule as the account anchor and for the same reason: an opaque
    // objectGUID, not a DN. Folding it here would let a mis-transcribed
    // configuration value grant or revoke a real group.
    const { anchor, entitlementId } = await setup();
    const upper = entitlementId.toUpperCase();
    expect(upper).not.toBe(entitlementId);
    const result = await adTargetConnector.write(config, {
      op: 'grant_entitlement',
      actionId: 'g-6',
      anchor,
      entitlementId: upper,
    });
    expect(result.ok).toBe(false);
    expect(result.failure).toBe('not_found');
  });

  it('rejects a GRANT of a configured primary group too', async () => {
    // The same reason in the other direction: primary group membership is set
    // by writing `primaryGroupID` on the user, so a `member` add either fails
    // or produces a second, redundant membership that the next reconcile
    // reports as unmanaged.
    const { anchor, entitlementId } = await setup();
    const result = await adTargetConnector.write(
      { ...config, primaryGroupExternalIds: [entitlementId] },
      { op: 'grant_entitlement', actionId: 'g-4', anchor, entitlementId },
    );
    expect(result.ok).toBe(false);
    expect(result.failure).toBe('rejected');
  });

  it('reads a group membership in full through the connector interface', async () => {
    // Task 13 phase 4 calls this through whatever connector it was handed, and
    // the contract is all-or-throw: half a membership read as a whole one is
    // the single most dangerous value in this subsystem.
    const { anchor, entitlementId } = await setup();
    await adTargetConnector.write(config, {
      op: 'grant_entitlement',
      actionId: 'g-5',
      anchor,
      entitlementId,
    });
    const members = await adTargetConnector.readEntitlementMembers(
      config,
      `CN=Payments,${groupsOu}`,
    );
    expect(members.map((dn) => dn.toLowerCase())).toEqual([
      `CN=lee.tran,${testOu}`.toLowerCase(),
    ]);
  });

  it('reads an empty group as empty rather than as a failure', async () => {
    await setup();
    const members = await adTargetConnector.readEntitlementMembers(
      config,
      `CN=Payments,${groupsOu}`,
    );
    expect(members).toEqual([]);
  });
});

describe('adTargetConnector — read', () => {
  it('returns the account with its anchor, status and memberships', async () => {
    const created = await adTargetConnector.write(config, createOp('read-1', 'mia.reid'));
    const records = [];
    for await (const record of adTargetConnector.read(config)) records.push(record);
    const found = records.find((r) => r.anchor === created.anchor)!;
    expect(found.attributes.sAMAccountName).toEqual(['mia.reid']);
    expect(found.attributes.userAccountControl).toEqual(['512']);
  });

  it('does not report the request wildcards as attributes of the account', async () => {
    // ldapts echoes `*` back as an empty-valued key. Left in, reconciliation
    // sees an attribute named `*` that the target holds and Provision does not
    // manage: a phantom difference on every account, on every run, forever.
    await adTargetConnector.write(config, createOp('read-2', 'nel.roos'));
    const records = [];
    for await (const record of adTargetConnector.read(config)) records.push(record);
    expect(Object.keys(records[0]!.attributes)).not.toContain('*');
    expect(Object.keys(records[0]!.attributes)).not.toContain('+');
  });

  it('reports no read failure on an ordinary account', async () => {
    await adTargetConnector.write(config, createOp('read-3', 'ova.smit'));
    const records = [];
    for await (const record of adTargetConnector.read(config)) records.push(record);
    expect(records[0]!.readFailure).toBeUndefined();
    expect(records[0]!.objectType).toBe('user');
    expect(records[0]!.dn.toLowerCase()).toBe(`CN=ova.smit,${testOu}`.toLowerCase());
  });

  it('marks a range-truncated record a read failure rather than a short one', async () => {
    // A user in more groups than the server's MaxValRange comes back carrying
    // `memberOf;range=0-1499`, and read naively that is a SHORT membership
    // list presented as a complete one -- which makes reconciliation propose
    // revoking everything it cannot see. Samba never emits one at this size,
    // so the response is injected at the client boundary, exactly as Task 3
    // does for its own walk.
    await adTargetConnector.write(config, createOp('read-4', 'pim.aker'));
    const original = Client.prototype.search;
    try {
      Client.prototype.search = async function patched(
        this: Client,
        ...args: Parameters<Client['search']>
      ) {
        const result = await original.apply(this, args);
        for (const entry of result.searchEntries as unknown as Record<string, unknown>[]) {
          if (entry.sAMAccountName === 'pim.aker') {
            entry['memberOf;range=0-1499'] = [`CN=Group1,${groupsOu}`];
          }
        }
        return result;
      } as Client['search'];

      const records = [];
      for await (const record of adTargetConnector.read(config)) records.push(record);
      const found = records.find((r) => r.attributes.sAMAccountName?.[0] === 'pim.aker')!;
      expect(found.readFailure).toBeDefined();
      expect(found.readFailure).toContain('memberOf;range=0-1499');
      // Still returned, and still counted as read. The difference between
      // "this object is gone" and "we could not read this object" is the
      // difference between a correct deactivation and a catastrophic one.
      expect(found.anchor).toBeDefined();
    } finally {
      Client.prototype.search = original;
    }
  });
});
