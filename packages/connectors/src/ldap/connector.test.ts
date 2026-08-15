import { describe, expect, it } from 'vitest';
import { ldapConnector } from './connector.js';
import type { LdapConfig } from './config.js';

const config: LdapConfig & { bindPassword: string } = {
  url: process.env.LDAP_URL ?? 'ldap://localhost:1389',
  bindDn: 'cn=admin,dc=acme,dc=test',
  bindPassword: 'adminpassword',
  userSearchBase: 'dc=acme,dc=test',
  groupSearchBase: 'dc=acme,dc=test',
  orgUnitSearchBase: 'dc=acme,dc=test',
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

describe('ldapConnector.read', () => {
  it('reads users, groups and organizational units', async () => {
    const records = await readAll();
    const byType = (t: string) => records.filter((r) => r.objectType === t);

    expect(byType('user').map((r) => r.dn).sort()).toEqual([
      'uid=jdoe,ou=Care,dc=acme,dc=test',
      'uid=sroe,ou=Care,dc=acme,dc=test',
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
    expect(nurses?.memberDns).toEqual(['uid=jdoe,ou=Care,dc=acme,dc=test']);
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
});

describe('ldapConnector.write', () => {
  it('refuses, since writing back is not in this slice', async () => {
    const result = await ldapConnector.write(config, {
      objectType: 'user',
      anchor: 'a1',
      attributes: {},
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/not implemented/i);
  });
});
