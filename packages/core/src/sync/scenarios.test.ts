import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { localMasterKeyProvider } from '../vault/master-key.js';
import { DEFAULT_MAPPINGS } from './defaults.js';
import { createSource, setMappings } from './source-service.js';
import { applyRun, previewRun } from './run-service.js';
import { moveLdapEntry, replaceLdapAttribute, withLdapEntry } from './test-support.js';

/**
 * THE ONLY FILE THAT WRITES TO THE DIRECTORY, and the only one scoped to
 * `ou=Scenarios`.
 *
 * Everything below moves entries between organizational units, replaces group
 * member lists and adds and removes whole objects. Every one of those was
 * visible to the five other files that read this container until the fixture
 * grew a subtree per owner — see `infra/ldap/seed.ldif`. A test that mutates
 * shared state under eight parallel workers is not a test, it is a coin toss
 * for whoever reads next.
 */
const provider = localMasterKeyProvider(Buffer.alloc(32, 7));
let tenantId: string;
let sourceId: string;

const config = {
  url: process.env.LDAP_URL ?? 'ldap://localhost:1389',
  bindDn: 'cn=admin,dc=acme,dc=test',
  userSearchBase: 'ou=Scenarios,dc=acme,dc=test',
  groupSearchBase: 'ou=Scenarios,dc=acme,dc=test',
  orgUnitSearchBase: 'ou=Scenarios,dc=acme,dc=test',
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
      'uid=jdoe,ou=Care,ou=Scenarios,dc=acme,dc=test',
      'uid=jdoe',
      'ou=Learning,ou=Scenarios,dc=acme,dc=test',
    );

    try {
      const run = await preview();
      const changes = await changesOf(run.id);

      // The whole point of anchoring on entryUUID rather than the DN.
      expect(changes.filter((c) => c.changeType === 'deactivate_user')).toEqual([]);
      expect(changes.filter((c) => c.changeType === 'create_user')).toEqual([]);

      // AND NOT A REVOCATION EITHER. `cn=Nurses` names its only member by DN,
      // and OpenLDAP's referential-integrity overlay rewrites that DN AFTER
      // the move commits — so a read taken in the window between the two sees
      // a member DN that resolves to nothing. Dropping it made `desired` empty
      // and the diff read "remove the only membership in this directory",
      // which the guard then blocked at 100%. This assertion is why that
      // window no longer matters: an unresolvable member is a gap in the read,
      // never an absence.
      expect(changes.filter((c) => c.changeType === 'remove_member')).toEqual([]);

      await applyRun(tenantId, run.id);
      const users = await withTenant(tenantId, (tx) =>
        tx.user.findMany({ where: { login: 'jdoe' } }),
      );
      expect(users).toHaveLength(1);
      expect(users[0]!.id).toBe(before!.id);
    } finally {
      await moveLdapEntry(
        'uid=jdoe,ou=Learning,ou=Scenarios,dc=acme,dc=test',
        'uid=jdoe',
        'ou=Care,ou=Scenarios,dc=acme,dc=test',
      );
    }
  });
});

describe('a joiner', () => {
  it('is created on the next run', async () => {
    await sync();

    await withLdapEntry(
      'uid=nhaddad,ou=Care,ou=Scenarios,dc=acme,dc=test',
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
      'uid=tberg,ou=Care,ou=Scenarios,dc=acme,dc=test',
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

describe('organizational placement', () => {
  const unitNamed = async (name: string) =>
    withTenant(tenantId, (tx) => tx.orgUnit.findFirstOrThrow({ where: { name } }));
  const jdoe = async () =>
    withTenant(tenantId, (tx) => tx.user.findFirstOrThrow({ where: { login: 'jdoe' } }));

  it('records the directory hierarchy rather than a flat list of units', async () => {
    await sync();

    const scenarios = await unitNamed('Scenarios');
    const care = await unitNamed('Care');
    const learning = await unitNamed('Learning');

    // The search base itself is read as a unit and has no parent inside the
    // scope the source was given. Its children point at it — which is also
    // the proof that `applyRun` ordered the parent's create before theirs:
    // reversed, `resolveUnit` would have found nothing and both would sit at
    // the top of the tree.
    expect(scenarios.parentId).toBeNull();
    expect(care.parentId).toBe(scenarios.id);
    expect(learning.parentId).toBe(scenarios.id);
  });

  it('puts a person in the unit that contains them', async () => {
    await sync();
    expect((await jdoe()).orgUnitId).toBe((await unitNamed('Care')).id);
  });

  it('makes a move between units A PLAIN UPDATE OF ONE FIELD', async () => {
    // The spec's words, and its sixth success criterion. Anchoring on
    // entryUUID is what stops this being a deactivation and a second account;
    // recording the new unit is what stops it being a no-op that leaves Syntra
    // permanently stale about where people work.
    await sync();
    const before = await jdoe();
    expect(before.orgUnitId).toBe((await unitNamed('Care')).id);

    await moveLdapEntry(
      'uid=jdoe,ou=Care,ou=Scenarios,dc=acme,dc=test',
      'uid=jdoe',
      'ou=Learning,ou=Scenarios,dc=acme,dc=test',
    );
    try {
      const run = await preview();
      const changes = await changesOf(run.id);
      const updates = changes.filter((c) => c.changeType === 'update_user');
      expect(updates).toHaveLength(1);
      // Reviewable as a move, in before-and-after, like every other change.
      expect((updates[0]!.before as Record<string, unknown>).parentAnchor).toBeTruthy();

      await applyRun(tenantId, run.id);
      const after = await jdoe();
      expect(after.id).toBe(before.id);
      expect(after.status).toBe('active');
      expect(after.orgUnitId).toBe((await unitNamed('Learning')).id);
    } finally {
      await moveLdapEntry(
        'uid=jdoe,ou=Learning,ou=Scenarios,dc=acme,dc=test',
        'uid=jdoe',
        'ou=Care,ou=Scenarios,dc=acme,dc=test',
      );
    }
  });

  it('leaves a person where they are when the units could not be read', async () => {
    // A gap in the read is not an absence — the same rule the memberships
    // follow. Detaching everybody from their department because one search
    // came back empty is a silent, tenant-wide narrowing of every scoped
    // administrative role, from a run that reported success.
    await sync();
    const care = await unitNamed('Care');
    expect((await jdoe()).orgUnitId).toBe(care.id);

    await withTenant(tenantId, (tx) =>
      tx.directorySource.update({
        where: { id: sourceId },
        data: { config: { ...config, orgUnitFilter: '(objectClass=nothingAtAll)' } as never },
      }),
    );

    const run = await preview();
    const changes = await changesOf(run.id);
    expect(changes.filter((c) => c.changeType === 'update_user')).toEqual([]);

    await applyRun(tenantId, run.id);
    expect((await jdoe()).orgUnitId).toBe(care.id);
  });
});

describe('a member DN that resolves to nothing', () => {
  it('freezes that group rather than revoking the members it CAN read', async () => {
    await sync();

    // Two real members, so the damage this test measures lands on somebody
    // other than the unreadable member. That is the whole point: a dangling
    // DN does not cost the person it names — they were already invisible —
    // it costs whoever else is in the group.
    await withLdapEntry(
      'cn=Ward,ou=Scenarios,dc=acme,dc=test',
      {
        objectClass: ['groupOfNames'],
        cn: 'Ward',
        member: [
          'uid=jdoe,ou=Care,ou=Scenarios,dc=acme,dc=test',
          'uid=sroe,ou=Care,ou=Scenarios,dc=acme,dc=test',
        ],
      },
      async () => {
        await sync();
        const held = async () =>
          (
            await withTenant(tenantId, (tx) =>
              tx.groupMembership.findMany({ include: { group: true, user: true } }),
            )
          )
            .filter((m) => m.group.name === 'Ward')
            .map((m) => m.user.login)
            .sort();
        expect(await held()).toEqual(['jdoe', 'sroe']);

        // `uid=ghost` names no entry at all. A groupOfNames does not require
        // its members to exist, which is exactly why a real directory can
        // present one: an entry deleted between our user read and our group
        // read, or a member who moved organizational unit a moment ago and
        // whose old DN the server has not rewritten yet.
        await replaceLdapAttribute('cn=Ward,ou=Scenarios,dc=acme,dc=test', 'member', [
          'uid=jdoe,ou=Care,ou=Scenarios,dc=acme,dc=test',
          'uid=ghost,ou=Care,ou=Scenarios,dc=acme,dc=test',
        ]);

        const run = await preview();
        const changes = await changesOf(run.id);

        // WITHOUT the incomplete-read guard, `desired` for Ward is [jdoe]:
        // ghost drops out, and the difference against what Syntra holds reads
        // "remove sroe". Sam Roe loses access because somebody else's DN went
        // stale, and at any real scale one dangling member in three thousand
        // is far under the guard's threshold, so nothing stops it.
        expect(changes.filter((c) => c.changeType === 'remove_member')).toEqual([]);

        await applyRun(tenantId, run.id);
        expect(await held()).toEqual(['jdoe', 'sroe']);

        // Counted and surfaced, not silently swallowed. The run says the read
        // was partial; the console prints it above the changes.
        const finished = await withTenant(tenantId, (tx) =>
          tx.syncRun.findUniqueOrThrow({ where: { id: run.id } }),
        );
        expect(finished.unresolvedMembers).toBeGreaterThan(0);
      },
    );
  });
});

describe('a membership change', () => {
  it('adds and removes members to match the source', async () => {
    await sync();

    // Two members at creation: groupOfNames requires at least one member at
    // all times, so proving removal means starting with two and dropping to
    // one, never emptying the group outright.
    await withLdapEntry(
      'cn=Trainers,ou=Scenarios,dc=acme,dc=test',
      {
        objectClass: ['groupOfNames'],
        cn: 'Trainers',
        member: [
          'uid=jdoe,ou=Care,ou=Scenarios,dc=acme,dc=test',
          'uid=sroe,ou=Care,ou=Scenarios,dc=acme,dc=test',
        ],
      },
      async () => {
        await sync();
        const afterAdd = await withTenant(tenantId, (tx) =>
          tx.groupMembership.findMany({
            include: { group: true, user: true },
          }),
        );
        const trainersAfterAdd = afterAdd
          .filter((m) => m.group.name === 'Trainers')
          .map((m) => m.user.login)
          .sort();
        expect(trainersAfterAdd).toEqual(['jdoe', 'sroe']);

        // Drop jdoe from the group in the directory; a broken remove_member
        // path would leave this membership row in place.
        await replaceLdapAttribute('cn=Trainers,ou=Scenarios,dc=acme,dc=test', 'member', [
          'uid=sroe,ou=Care,ou=Scenarios,dc=acme,dc=test',
        ]);

        await sync();
        const afterRemove = await withTenant(tenantId, (tx) =>
          tx.groupMembership.findMany({
            include: { group: true, user: true },
          }),
        );
        const trainersAfterRemove = afterRemove.filter(
          (m) => m.group.name === 'Trainers',
        );
        expect(trainersAfterRemove).toHaveLength(1);
        expect(trainersAfterRemove[0]!.user.login).toBe('sroe');
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

    // Exactly the two users from the initial sync, none of them touched --
    // not merely "some survived", which a partially-broken guard could also
    // produce.
    const users = await withTenant(tenantId, (tx) =>
      tx.user.findMany({ where: { status: 'active' } }),
    );
    expect(users).toHaveLength(2);
  });

  it('blocks a run where the source returns no records at all', async () => {
    await sync();

    // A nonexistent search base was tried first (e.g. ou=Nowhere,dc=acme,
    // dc=test) and rejected: against the live server it makes ldapts throw
    // NoSuchObjectError, which fails the whole run rather than blocking it,
    // so it cannot exercise this branch. Filters that match nothing across
    // all three object types do exercise it: each search still succeeds
    // against a valid base, every one of them returns zero entries, and
    // recordsRead ends up genuinely 0 -- distinct from "every user was
    // filtered out but groups and org units still came back", which is the
    // scenario the test above covers.
    await withTenant(tenantId, (tx) =>
      tx.directorySource.update({
        where: { id: sourceId },
        data: {
          config: {
            ...config,
            userFilter: '(objectClass=nothingAtAll)',
            groupFilter: '(objectClass=nothingAtAll)',
            orgUnitFilter: '(objectClass=nothingAtAll)',
          } as never,
        },
      }),
    );

    const run = await preview();
    expect(run.recordsRead).toBe(0);
    expect(run.status).toBe('blocked');
    expect(run.blockedReason).toMatch(/no records/i);

    await expect(applyRun(tenantId, run.id)).rejects.toThrow(/blocked/i);

    const users = await withTenant(tenantId, (tx) =>
      tx.user.findMany({ where: { status: 'active' } }),
    );
    expect(users).toHaveLength(2);
  });
});
