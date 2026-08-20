import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { localMasterKeyProvider } from '../vault/master-key.js';
import { DEFAULT_MAPPINGS } from './defaults.js';
import {
  SourceOwnsObjectsError,
  createSource,
  deleteSource,
  listSources,
  mappingsFor,
  setMappings,
  sourceWithPassword,
  updateSource,
} from './source-service.js';

const provider = localMasterKeyProvider(Buffer.alloc(32, 3));
let tenantId: string;

const input = {
  name: 'Head office AD',
  config: {
    url: 'ldap://localhost:1389',
    bindDn: 'cn=admin,dc=acme,dc=test',
    userSearchBase: 'ou=Shared,dc=acme,dc=test',
    groupSearchBase: 'ou=Shared,dc=acme,dc=test',
    anchorAttribute: 'entryUUID',
  },
  bindPassword: 'adminpassword',
};

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
});

describe('createSource', () => {
  it('stores the password in the vault, not on the row', async () => {
    const source = await withTenant(tenantId, (tx) =>
      createSource(tx, provider, input),
    );

    const row = await withTenant(tenantId, (tx) =>
      tx.directorySource.findUnique({ where: { id: source.id } }),
    );
    expect(JSON.stringify(row)).not.toContain('adminpassword');
    expect(row!.secretName).toMatch(/^source\./);
  });

  it('reads the password back only through the vault', async () => {
    const source = await withTenant(tenantId, (tx) =>
      createSource(tx, provider, input),
    );
    const resolved = await withTenant(tenantId, (tx) =>
      sourceWithPassword(tx, provider, source.id),
    );
    expect(resolved?.bindPassword).toBe('adminpassword');
    expect(resolved?.url).toBe('ldap://localhost:1389');
  });

  it('rejects a config that is not a valid LDAP configuration', async () => {
    await expect(
      withTenant(tenantId, (tx) =>
        createSource(tx, provider, { ...input, config: { url: '' } }),
      ),
    ).rejects.toThrow();
  });

  it('defaults to no schedule, no auto-apply, and a 10% threshold', async () => {
    const source = await withTenant(tenantId, (tx) =>
      createSource(tx, provider, input),
    );
    expect(source.schedule).toBeNull();
    expect(source.autoApply).toBe(false);
    expect(source.deactivationThresholdPercent).toBe(10);
  });

  it('returns null for a source in another tenant', async () => {
    const other = await prisma.tenant.create({
      data: { name: 'Other', slug: 'other' },
    });
    const source = await withTenant(tenantId, (tx) =>
      createSource(tx, provider, input),
    );
    const resolved = await withTenant(other.id, (tx) =>
      sourceWithPassword(tx, provider, source.id),
    );
    expect(resolved).toBeNull();
  });
});

describe('mappings', () => {
  it('round-trips a mapping set', async () => {
    const source = await withTenant(tenantId, (tx) =>
      createSource(tx, provider, input),
    );
    await withTenant(tenantId, (tx) =>
      setMappings(tx, source.id, DEFAULT_MAPPINGS.openLdap),
    );

    const rules = await withTenant(tenantId, (tx) =>
      mappingsFor(tx, source.id),
    );
    expect(rules.length).toBe(DEFAULT_MAPPINGS.openLdap.length);
    expect(rules.filter((r) => r.isCorrelation && r.objectType === 'user')).toHaveLength(1);
  });

  it('replaces the previous set rather than appending to it', async () => {
    const source = await withTenant(tenantId, (tx) =>
      createSource(tx, provider, input),
    );
    await withTenant(tenantId, (tx) =>
      setMappings(tx, source.id, DEFAULT_MAPPINGS.openLdap),
    );
    await withTenant(tenantId, (tx) =>
      setMappings(tx, source.id, [
        {
          objectType: 'user',
          sourceAttribute: 'uid',
          targetField: 'login',
          transform: 'lowercase',
          isCorrelation: true,
        },
      ]),
    );

    const rules = await withTenant(tenantId, (tx) => mappingsFor(tx, source.id));
    expect(rules).toHaveLength(1);
  });

  it('refuses a set with no correlation rule for users', async () => {
    // Without one, no user record can ever be matched.
    const source = await withTenant(tenantId, (tx) =>
      createSource(tx, provider, input),
    );
    await expect(
      withTenant(tenantId, (tx) =>
        setMappings(tx, source.id, [
          {
            objectType: 'user',
            sourceAttribute: 'mail',
            targetField: 'email',
            transform: 'lowercase',
            isCorrelation: false,
          },
        ]),
      ),
    ).rejects.toThrow(/correlation/i);
  });

  it('refuses a mapping that would let the source write a user status', async () => {
    // update_user is not a change type the guard counts, so a mapping onto
    // `status` deactivates accounts straight past the mass-deactivation
    // protection.
    const source = await withTenant(tenantId, (tx) =>
      createSource(tx, provider, input),
    );
    await expect(
      withTenant(tenantId, (tx) =>
        setMappings(tx, source.id, [
          ...DEFAULT_MAPPINGS.openLdap,
          {
            objectType: 'user',
            sourceAttribute: 'employeeType',
            targetField: 'status',
            transform: 'lowercase',
            isCorrelation: false,
          },
        ]),
      ),
    ).rejects.toThrow(/status/);
  });

  it('refuses a mapping onto the ownership and link columns', async () => {
    const source = await withTenant(tenantId, (tx) =>
      createSource(tx, provider, input),
    );

    for (const targetField of [
      'sourceId',
      'sourceAnchor',
      'personId',
      'orgUnitId',
      'id',
      'tenantId',
    ]) {
      await expect(
        withTenant(tenantId, (tx) =>
          setMappings(tx, source.id, [
            ...DEFAULT_MAPPINGS.openLdap,
            {
              objectType: 'user',
              sourceAttribute: 'description',
              targetField,
              transform: 'none',
              isCorrelation: false,
            },
          ]),
        ),
      ).rejects.toThrow(new RegExp(targetField));
    }
  });

  it('accepts the shipped defaults, which write only mapped fields', async () => {
    const source = await withTenant(tenantId, (tx) =>
      createSource(tx, provider, input),
    );
    await expect(
      withTenant(tenantId, (tx) =>
        setMappings(tx, source.id, DEFAULT_MAPPINGS.activeDirectory),
      ),
    ).resolves.toBeUndefined();
  });
});

describe('updateSource', () => {
  it('reports a source that does not exist rather than throwing', async () => {
    const missing = await withTenant(tenantId, (tx) =>
      updateSource(tx, provider, '00000000-0000-0000-0000-000000000000', {
        autoApply: true,
      }),
    );
    expect(missing).toBeNull();
  });

  it('replaces the config whole rather than merging a fragment over it', async () => {
    // A merge would let a half-configuration through with the schema's checks
    // having passed on the fragment alone.
    const source = await withTenant(tenantId, (tx) =>
      createSource(tx, provider, input),
    );

    await expect(
      withTenant(tenantId, (tx) =>
        updateSource(tx, provider, source.id, {
          config: { url: 'ldap://elsewhere:389' },
        }),
      ),
    ).rejects.toThrow();
  });

  it('keeps the same vault entry, so a rotation replaces the credential', async () => {
    const source = await withTenant(tenantId, (tx) =>
      createSource(tx, provider, input),
    );

    await withTenant(tenantId, (tx) =>
      updateSource(tx, provider, source.id, { bindPassword: 'rotated' }),
    );

    const resolved = await withTenant(tenantId, (tx) =>
      sourceWithPassword(tx, provider, source.id),
    );
    expect(resolved?.bindPassword).toBe('rotated');

    const secrets = await withTenant(tenantId, (tx) => tx.secret.findMany());
    expect(secrets).toHaveLength(1);
  });
});

describe('deleteSource', () => {
  /** A user this source owns, as a run would have created it. */
  const withOwnedUser = async (sourceId: string) =>
    withTenant(tenantId, (tx) =>
      tx.user.create({
        data: {
          tenantId,
          login: 'jdoe',
          email: 'jo@acme.test',
          displayName: 'Jo Doe',
          sourceId,
          sourceAnchor: 'anchor-1',
        },
      }),
    );

  it('refuses a source that still owns directory rows, and names how many', async () => {
    const source = await withTenant(tenantId, (tx) =>
      createSource(tx, provider, input),
    );
    await withOwnedUser(source.id);

    await expect(
      withTenant(tenantId, (tx) => deleteSource(tx, source.id)),
    ).rejects.toBeInstanceOf(SourceOwnsObjectsError);

    // And nothing was half-done on the way to refusing.
    const still = await withTenant(tenantId, (tx) => tx.user.findMany());
    expect(still[0]!.status).toBe('active');
    expect(still[0]!.sourceId).toBe(source.id);
  });

  it('deactivates and detaches what it owned, and takes the credential with it', async () => {
    const source = await withTenant(tenantId, (tx) =>
      createSource(tx, provider, input),
    );
    await withOwnedUser(source.id);

    const released = await withTenant(tenantId, (tx) =>
      deleteSource(tx, source.id, { confirm: true }),
    );

    expect(released).toEqual({ users: 1, groups: 0, orgUnits: 0 });
    const user = await withTenant(tenantId, (tx) => tx.user.findFirstOrThrow());
    expect(user.status).toBe('inactive');
    expect(user.sourceId).toBeNull();
    expect(user.sourceAnchor).toBeNull();
    // A credential nothing can reach is a credential nobody is watching.
    expect(await withTenant(tenantId, (tx) => tx.secret.count())).toBe(0);
  });

  it('clears the pairing of every target that named it', async () => {
    // The pointer this function did not release. A target paired to a deleted
    // source kept its id, and `claimSyntraUsers` gates on that column being
    // non-null -- so the gate that exists to fail closed passed on a value
    // naming nothing, the claim matched no users, and no leaver on that target
    // ever lost their Syntra login again, with the console still rendering the
    // pairing as intact.
    //
    // Two targets, and only one of them paired to the source being deleted: a
    // statement missing its `where` clears both, and with one target that is
    // indistinguishable from the right answer.
    //
    // Stated plainly, because the name would otherwise overclaim: the outcome
    // asserted here is produced by the `updateMany` in `deleteSource` AND by
    // the `ON DELETE SET NULL` behind it, and this test cannot tell which one
    // did it. That is deliberate -- the point of having both is that the end
    // state does not depend on which is present -- so what this pins is the
    // end state, not the mechanism.
    const source = await withTenant(tenantId, (tx) =>
      createSource(tx, provider, input),
    );
    const other = await withTenant(tenantId, (tx) =>
      createSource(tx, provider, { ...input, name: 'Branch AD' }),
    );
    const targets = await withTenant(tenantId, async (tx) => [
      await tx.targetSystem.create({
        data: {
          tenantId,
          name: 'Acme AD',
          // `target_system_encrypted_transport` refuses a config that says
          // nothing about its transport, so the fixture says it.
          config: { tlsMode: 'ldaps' },
          secretName: 'target/a/bind',
          pairedDirectorySourceId: source.id,
        },
      }),
      await tx.targetSystem.create({
        data: {
          tenantId,
          name: 'Branch AD target',
          config: { tlsMode: 'ldaps' },
          secretName: 'target/b/bind',
          pairedDirectorySourceId: other.id,
        },
      }),
    ]);

    await withTenant(tenantId, (tx) => deleteSource(tx, source.id, { confirm: true }));

    const rows = await withTenant(tenantId, (tx) => tx.targetSystem.findMany());
    const byId = new Map(rows.map((r) => [r.id, r.pairedDirectorySourceId]));
    expect(byId.get(targets[0]!.id)).toBeNull();
    expect(byId.get(targets[1]!.id)).toBe(other.id);
  });

  it('reports a source that does not exist rather than throwing', async () => {
    const missing = await withTenant(tenantId, (tx) =>
      deleteSource(tx, '00000000-0000-0000-0000-000000000000'),
    );
    expect(missing).toBeNull();
  });
});

describe('DEFAULT_MAPPINGS', () => {
  it('maps Active Directory to sAMAccountName as the correlation key', () => {
    const rule = DEFAULT_MAPPINGS.activeDirectory.find(
      (r) => r.objectType === 'user' && r.isCorrelation,
    );
    expect(rule?.sourceAttribute).toBe('sAMAccountName');
  });

  it('maps OpenLDAP to uid as the correlation key', () => {
    const rule = DEFAULT_MAPPINGS.openLdap.find(
      (r) => r.objectType === 'user' && r.isCorrelation,
    );
    expect(rule?.sourceAttribute).toBe('uid');
  });
});

describe('a mapping may not aim at the hierarchy', () => {
  it('refuses a rule targeting parentAnchor', async () => {
    // Placement comes from the directory's own DN tree, never from an
    // attribute. A rule that could write `parentAnchor` could move a person —
    // and every scoped administrative role that reaches them — by setting a
    // string on their record. It is not in `ASSIGNABLE_FIELDS`, and this is
    // the check that turns that omission into a refusal an operator can read.
    await expect(
      withTenant(tenantId, async (tx) => {
        const source = await createSource(tx, provider, {
          ...input,
          name: 'Hierarchy LDAP',
        });
        await setMappings(tx, source.id, [
          // A valid rule set in every other respect, so the refusal below is
          // about the target field and not about a missing correlation key.
          {
            objectType: 'user',
            sourceAttribute: 'uid',
            targetField: 'login',
            transform: 'none',
            isCorrelation: true,
          },
          {
            objectType: 'user',
            sourceAttribute: 'departmentNumber',
            targetField: 'parentAnchor',
            transform: 'none',
            isCorrelation: false,
          },
        ]);
      }),
    ).rejects.toThrow(/parentAnchor/);
  });
});
