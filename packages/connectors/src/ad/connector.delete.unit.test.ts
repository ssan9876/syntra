import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `delete_account` against an in-memory stand-in for `ldapts`'s Client, so the
 * refusals are pinned without a domain controller. The Samba suite
 * (`connector.integration.test.ts`) covers the same cases for real.
 */
interface Entry {
  dn: string;
  entryUUID: string;
  userAccountControl?: string;
}

const directory: { entries: Entry[]; deleted: string[]; searchBases: string[]; delError?: Error } = {
  entries: [],
  deleted: [],
  searchBases: [],
};

const within = (dn: string, base: string) => dn.toLowerCase().endsWith(`,${base.toLowerCase()}`);

vi.mock('ldapts', async (importOriginal) => {
  const original = await importOriginal<typeof import('ldapts')>();
  class Client {
    async startTLS() {}
    async bind() {}
    async unbind() {}
    async search(base: string) {
      directory.searchBases.push(base);
      return { searchEntries: directory.entries.filter((e) => within(e.dn, base)) };
    }
    async del(dn: string) {
      if (directory.delError) throw directory.delError;
      directory.deleted.push(dn);
      directory.entries = directory.entries.filter((e) => e.dn !== dn);
    }
  }
  return { ...original, Client };
});

const { adTargetConnector, dnWithin, domainRootOf } = await import('./connector.js');

const config = {
  url: 'ldaps://dc.acme.test',
  tlsMode: 'ldaps' as const,
  bindDn: 'CN=svc,DC=acme,DC=test',
  bindPassword: 'x',
  baseDn: 'OU=Staff,DC=acme,DC=test',
  entitlementSearchBase: 'OU=Groups,DC=acme,DC=test',
  archiveContainer: 'OU=Archive,DC=acme,DC=test',
  anchorAttribute: 'entryUUID',
};

const del = (anchor: string) =>
  adTargetConnector.write(config, { op: 'delete_account', actionId: 'act-1', anchor });

beforeEach(() => {
  directory.entries = [];
  directory.deleted = [];
  directory.searchBases = [];
  delete directory.delError;
});

describe('dnWithin and domainRootOf', () => {
  it('finds a DN below a container, folding case and spaces', () => {
    expect(dnWithin('CN=a,OU=Staff,DC=acme,DC=test', 'ou=staff, dc=acme, dc=test')).toBe(true);
    expect(dnWithin('CN=a,OU=Sub,OU=Staff,DC=acme,DC=test', 'OU=Staff,DC=acme,DC=test')).toBe(true);
    expect(dnWithin('CN=a,OU=Other,DC=acme,DC=test', 'OU=Staff,DC=acme,DC=test')).toBe(false);
    expect(dnWithin('CN=Novak\\, Anna,OU=Staff,DC=acme,DC=test', 'OU=Staff,DC=acme,DC=test')).toBe(true);
    expect(dnWithin('OU=Staff,DC=acme,DC=test', 'OU=Staff,DC=acme,DC=test')).toBe(false);
  });

  it('takes the DC= suffix as the domain root', () => {
    expect(domainRootOf('OU=Staff,OU=HQ,DC=acme,DC=test')).toBe('DC=acme,DC=test');
    expect(domainRootOf('O=acme')).toBe('O=acme');
  });
});

describe('dnWithin on untidy input', () => {
  it('ignores spaces around commas and equals signs', () => {
    expect(dnWithin('CN=a , OU = Staff ,DC=acme,DC=test', ' OU=Staff,  DC = acme,DC=test ')).toBe(true);
  });

  it('stays fast on a long run of spaces', () => {
    const started = Date.now();
    expect(dnWithin(`CN=a,OU=${' '.repeat(50_000)}x,DC=acme,DC=test`, 'OU=Staff,DC=acme,DC=test')).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe('adTargetConnector delete_account', () => {
  it('deletes a disabled account inside the base DN', async () => {
    directory.entries.push({ dn: 'CN=ann,OU=Staff,DC=acme,DC=test', entryUUID: 'u-1', userAccountControl: '514' });
    expect(await del('u-1')).toMatchObject({ ok: true, message: 'deleted' });
    expect(directory.deleted).toEqual(['CN=ann,OU=Staff,DC=acme,DC=test']);
    // Resolved from the domain root, not the base DN.
    expect(directory.searchBases).toEqual(['DC=acme,DC=test']);
  });

  it('deletes a disabled account in the archive container', async () => {
    directory.entries.push({ dn: 'CN=bo,OU=Archive,DC=acme,DC=test', entryUUID: 'u-2', userAccountControl: '66050' });
    expect(await del('u-2')).toMatchObject({ ok: true });
    expect(directory.deleted).toEqual(['CN=bo,OU=Archive,DC=acme,DC=test']);
  });

  it('refuses an enabled account', async () => {
    directory.entries.push({ dn: 'CN=cy,OU=Staff,DC=acme,DC=test', entryUUID: 'u-3', userAccountControl: '512' });
    const result = await del('u-3');
    expect(result).toMatchObject({ ok: false, failure: 'rejected' });
    expect(result.message).toBe('Not deleted: CN=cy,OU=Staff,DC=acme,DC=test is enabled. Disable it first.');
    expect(directory.deleted).toEqual([]);
  });

  it('refuses an account with no userAccountControl', async () => {
    directory.entries.push({ dn: 'CN=dee,OU=Staff,DC=acme,DC=test', entryUUID: 'u-4' });
    expect(await del('u-4')).toMatchObject({ ok: false, failure: 'rejected' });
    expect(directory.deleted).toEqual([]);
  });

  it('refuses a disabled account outside the base DN and the archive container', async () => {
    directory.entries.push({ dn: 'CN=di,OU=Elsewhere,DC=acme,DC=test', entryUUID: 'u-5', userAccountControl: '514' });
    const result = await del('u-5');
    expect(result).toMatchObject({ ok: false, failure: 'rejected' });
    expect(result.message).toContain('outside the base DN and the archive container');
    expect(directory.deleted).toEqual([]);
  });

  it('treats an account the domain no longer returns as deleted', async () => {
    expect(await del('u-6')).toMatchObject({ ok: true, message: 'account already deleted' });
  });

  it('treats noSuchObject on the delete itself as deleted', async () => {
    directory.entries.push({ dn: 'CN=ed,OU=Staff,DC=acme,DC=test', entryUUID: 'u-7', userAccountControl: '514' });
    directory.delError = Object.assign(new Error('gone'), { name: 'NoSuchObjectError' });
    expect(await del('u-7')).toMatchObject({ ok: true, message: 'account already deleted' });
  });

  it('refuses an account with child objects rather than tree-deleting it', async () => {
    directory.entries.push({ dn: 'CN=fay,OU=Staff,DC=acme,DC=test', entryUUID: 'u-8', userAccountControl: '514' });
    directory.delError = Object.assign(new Error('non-leaf'), { name: 'NotAllowedOnNonLeafError' });
    const result = await del('u-8');
    expect(result).toMatchObject({ ok: false, failure: 'rejected' });
    expect(result.message).toContain('has child objects');
  });
});
