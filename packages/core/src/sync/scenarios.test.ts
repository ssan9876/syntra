import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { localMasterKeyProvider } from '../vault/master-key.js';
import { DEFAULT_MAPPINGS } from './defaults.js';
import { createSource, setMappings } from './source-service.js';
import { applyRun, previewRun } from './run-service.js';
import { moveLdapEntry, withLdapEntry } from './test-support.js';

const provider = localMasterKeyProvider(Buffer.alloc(32, 7));
let tenantId: string;
let sourceId: string;

const config = {
  url: process.env.LDAP_URL ?? 'ldap://localhost:1389',
  bindDn: 'cn=admin,dc=acme,dc=test',
  userSearchBase: 'dc=acme,dc=test',
  groupSearchBase: 'dc=acme,dc=test',
  orgUnitSearchBase: 'dc=acme,dc=test',
  userFilter: '(objectClass=inetOrgPerson)',
  groupFilter: '(objectClass=groupOfNames)',
  anchorAttribute: 'entryUUID',
  pageSize: 2,
  rejectUnauthorized: true,
};

const preview = () => previewRun(tenantId, provider, sourceId);

const sync = async () => {
  const run = await previewRun(tenantId, provider, sourceId);
  return applyRun(tenantId, run.id);
};

const changesOf = (runId: string) =>
  withTenant(tenantId, (tx) => tx.syncChange.findMany({ where: { runId } }));

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  await withTenant(tenantId, async (tx) => {
    const source = await createSource(tx, provider, {
      name: 'Test LDAP',
      config,
      bindPassword: 'adminpassword',
      // The fixture directory has only a handful of objects, so a single
      // leaver is a large percentage of it (e.g. one of three is 33%). The
      // default 10% guard threshold is sized for real directories, not this
      // fixture; raised here so the leaver scenario below exercises normal
      // deactivation rather than tripping the guard. Still nowhere near the
      // 100% the guard test drives it to, so that test is unaffected.
      deactivationThresholdPercent: 50,
    });
    sourceId = source.id;
    await setMappings(tx, source.id, DEFAULT_MAPPINGS.openLdap);
  });
});

describe('an organizational unit move', () => {
  it('is an update, not a deactivation and a second account', async () => {
    await sync();
    const before = await withTenant(tenantId, (tx) =>
      tx.user.findFirst({ where: { login: 'jdoe' } }),
    );

    await moveLdapEntry(
      'uid=jdoe,ou=Care,dc=acme,dc=test',
      'uid=jdoe',
      'ou=Learning,dc=acme,dc=test',
    );

    try {
      const run = await preview();
      const changes = await changesOf(run.id);

      // The whole point of anchoring on entryUUID rather than the DN.
      expect(changes.filter((c) => c.changeType === 'deactivate_user')).toEqual([]);
      expect(changes.filter((c) => c.changeType === 'create_user')).toEqual([]);

      await applyRun(tenantId, run.id);
      const users = await withTenant(tenantId, (tx) =>
        tx.user.findMany({ where: { login: 'jdoe' } }),
      );
      expect(users).toHaveLength(1);
      expect(users[0]!.id).toBe(before!.id);
    } finally {
      await moveLdapEntry(
        'uid=jdoe,ou=Learning,dc=acme,dc=test',
        'uid=jdoe',
        'ou=Care,dc=acme,dc=test',
      );
    }
  });
});

describe('a joiner', () => {
  it('is created on the next run', async () => {
    await sync();

    await withLdapEntry(
      'uid=nhaddad,ou=Care,dc=acme,dc=test',
      {
        objectClass: ['inetOrgPerson'],
        uid: 'nhaddad',
        cn: 'Nadia Haddad',
        sn: 'Haddad',
        mail: 'nadia@acme.test',
      },
      async () => {
        await sync();
        const user = await withTenant(tenantId, (tx) =>
          tx.user.findFirst({ where: { login: 'nhaddad' } }),
        );
        expect(user?.email).toBe('nadia@acme.test');
      },
    );
  });
});

describe('a leaver', () => {
  it('is deactivated rather than deleted, and can be proposed for return', async () => {
    // tberg's entry is added once and lives for the whole test. "Leaving"
    // and "returning" are modelled by narrowing and widening the source's
    // userFilter, not by deleting and re-adding the LDAP entry: a genuine
    // delete/re-add would hand the recreated entry a brand new entryUUID,
    // which correlate() cannot resolve back to the old (inactive) row by
    // anchor -- that is a distinct, unresolved-identity scenario, not a
    // rehire. A real rehire is the same directory object reappearing, so
    // the anchor must stay the same throughout, exactly like a temporary
    // filter exclusion (e.g. an account disabled and later re-enabled).
    await withLdapEntry(
      'uid=tberg,ou=Care,dc=acme,dc=test',
      {
        objectClass: ['inetOrgPerson'],
        uid: 'tberg',
        cn: 'Tomas Berg',
        sn: 'Berg',
        mail: 'tomas@acme.test',
      },
      async () => {
        await sync();

        // Narrow the filter so this run's read no longer includes tberg,
        // the way a disabled-account filter or an OU exclusion would.
        await withTenant(tenantId, (tx) =>
          tx.directorySource.update({
            where: { id: sourceId },
            data: {
              config: {
                ...config,
                userFilter: '(&(objectClass=inetOrgPerson)(!(uid=tberg)))',
              } as never,
            },
          }),
        );

        await sync();
        const gone = await withTenant(tenantId, (tx) =>
          tx.user.findFirst({ where: { login: 'tberg' } }),
        );
        expect(gone).not.toBeNull();
        expect(gone!.status).toBe('inactive');
        expect(gone!.statusReason).toMatch(/absent from directory source/i);

        // Widen the filter back: the same entry, same anchor, reappears.
        // A rehire is proposed, never applied silently.
        await withTenant(tenantId, (tx) =>
          tx.directorySource.update({
            where: { id: sourceId },
            data: { config: { ...config } as never },
          }),
        );

        const run = await preview();
        const changes = await changesOf(run.id);
        expect(
          changes.some((c) => c.changeType === 'reactivate_user'),
        ).toBe(true);

        const stillInactive = await withTenant(tenantId, (tx) =>
          tx.user.findFirst({ where: { login: 'tberg' } }),
        );
        expect(stillInactive!.status).toBe('inactive');
      },
    );
  });
});

describe('a membership change', () => {
  it('adds and removes members to match the source', async () => {
    await sync();

    await withLdapEntry(
      'cn=Trainers,dc=acme,dc=test',
      {
        objectClass: ['groupOfNames'],
        cn: 'Trainers',
        member: ['uid=sroe,ou=Care,dc=acme,dc=test'],
      },
      async () => {
        await sync();
        const memberships = await withTenant(tenantId, (tx) =>
          tx.groupMembership.findMany({
            include: { group: true, user: true },
          }),
        );
        const trainers = memberships.filter(
          (m) => m.group.name === 'Trainers',
        );
        expect(trainers).toHaveLength(1);
        expect(trainers[0]!.user.login).toBe('sroe');
      },
    );
  });
});

describe('the guard', () => {
  it('blocks a run that would deactivate everyone', async () => {
    await sync();

    // Point the source at a filter that matches no users: the read succeeds
    // (groups and org units still resolve, so recordsRead is nonzero) but
    // every user this source owns would be deactivated -- indistinguishable
    // from an outage from the users' point of view, and the guard blocks it
    // unconditionally on the deactivation share rather than on record count.
    await withTenant(tenantId, (tx) =>
      tx.directorySource.update({
        where: { id: sourceId },
        data: {
          config: { ...config, userFilter: '(objectClass=nothingAtAll)' } as never,
        },
      }),
    );

    const run = await preview();
    expect(run.status).toBe('blocked');
    expect(run.blockedReason).toMatch(/would deactivate/i);

    await expect(applyRun(tenantId, run.id)).rejects.toThrow(/blocked/i);

    const users = await withTenant(tenantId, (tx) =>
      tx.user.findMany({ where: { status: 'active' } }),
    );
    expect(users.length).toBeGreaterThan(0);
  });
});
