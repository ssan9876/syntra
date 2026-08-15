import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { localMasterKeyProvider } from '../vault/master-key.js';
import { DEFAULT_MAPPINGS } from './defaults.js';
import {
  createSource,
  listSources,
  mappingsFor,
  setMappings,
  sourceWithPassword,
} from './source-service.js';

const provider = localMasterKeyProvider(Buffer.alloc(32, 3));
let tenantId: string;

const input = {
  name: 'Head office AD',
  config: {
    url: 'ldap://localhost:1389',
    bindDn: 'cn=admin,dc=acme,dc=test',
    userSearchBase: 'dc=acme,dc=test',
    groupSearchBase: 'dc=acme,dc=test',
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
