import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { localMasterKeyProvider } from '../vault/master-key.js';
import { getSecret } from '../vault/vault-service.js';
import {
  PersonSourceOwnsPersonsError,
  UnassignableFieldError,
  createPersonSource,
  deletePersonSource,
  personMappingsFor,
  personSourceWithCredential,
  setPersonMappings,
  updatePersonSource,
} from './source-service.js';

const provider = localMasterKeyProvider(Buffer.alloc(32, 7));

const config = {
  host: 'hr.example.test',
  username: 'syntra',
  remotePath: '/export/people.csv',
};

let tenantId: string;

beforeEach(async () => {
  await resetDatabase();
  const tenant = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = tenant.id;
});

function makeSource(over: Record<string, unknown> = {}) {
  return withTenant(tenantId, (tx) =>
    createPersonSource(tx, provider, {
      name: 'HR nightly',
      type: 'sftpDelimited',
      feedMode: 'snapshot',
      config,
      credential: 'hunter2',
      ...over,
    }),
  );
}

describe('createPersonSource', () => {
  it('seals the credential in the vault and names the secret after the row', async () => {
    const source = await makeSource();

    expect(source.secretName).toBe(`personSource.${source.id}.credential`);
    const secret = await withTenant(tenantId, (tx) =>
      getSecret(tx, provider, source.secretName),
    );
    expect(secret).toBe('hunter2');
    // Never in the config JSON.
    expect(JSON.stringify(source.config)).not.toContain('hunter2');
  });

  it('applies the connector config schema, filling its defaults', async () => {
    const source = await makeSource();
    expect(source.config).toMatchObject({ port: 22, delimiter: ',', hasHeaderRow: true });
  });

  it('refuses an unknown source type', async () => {
    await expect(makeSource({ type: 'workday' })).rejects.toThrow(
      /no person source connector implements type "workday"/,
    );
  });

  /**
   * feedMode has no default anywhere in the stack, and the service is the
   * last place it could acquire one.
   */
  it('refuses a feed mode it does not know', async () => {
    await expect(makeSource({ feedMode: 'incremental' })).rejects.toThrow(/feed mode/i);
  });

  it('defaults to enabled with no schedule and no auto-apply', async () => {
    const source = await makeSource();
    expect(source.enabled).toBe(true);
    expect(source.schedule).toBeNull();
    expect(source.autoApply).toBe(false);
    expect(source.deactivationThresholdPercent).toBe(10);
  });
});

describe('updatePersonSource', () => {
  it('re-seals the credential under the same secret name', async () => {
    const source = await makeSource();
    await withTenant(tenantId, (tx) =>
      updatePersonSource(tx, provider, source.id, { credential: 'newsecret' }),
    );
    const secret = await withTenant(tenantId, (tx) =>
      getSecret(tx, provider, source.secretName),
    );
    expect(secret).toBe('newsecret');
  });

  it('clears the schedule when given null, leaving the source manual-only', async () => {
    const source = await makeSource({ schedule: '0 2 * * *' });
    const updated = await withTenant(tenantId, (tx) =>
      updatePersonSource(tx, provider, source.id, { schedule: null }),
    );
    expect(updated?.schedule).toBeNull();
  });

  it('refuses a feed mode it does not know', async () => {
    const source = await makeSource();
    await expect(
      withTenant(tenantId, (tx) =>
        updatePersonSource(tx, provider, source.id, {
          feedMode: 'incremental' as never,
        }),
      ),
    ).rejects.toThrow(/feed mode/i);
  });
});

describe('setPersonMappings', () => {
  const correlation = {
    recordType: 'person' as const,
    sourceColumn: 'employeeId',
    targetField: 'externalId',
    transform: 'trim' as const,
    isCorrelation: true,
  };

  it('refuses a mapping onto a field a source may not write', async () => {
    const source = await makeSource();
    await expect(
      withTenant(tenantId, (tx) =>
        setPersonMappings(tx, source.id, [
          correlation,
          {
            recordType: 'person',
            sourceColumn: 'active',
            targetField: 'status',
            transform: 'none',
            isCorrelation: false,
          },
        ]),
      ),
    ).rejects.toThrow(UnassignableFieldError);
  });

  it('refuses a mapping onto the departure override', async () => {
    const source = await makeSource();
    await expect(
      withTenant(tenantId, (tx) =>
        setPersonMappings(tx, source.id, [
          correlation,
          {
            recordType: 'person',
            sourceColumn: 'leftOn',
            targetField: 'departureOverride',
            transform: 'none',
            isCorrelation: false,
          },
        ]),
      ),
    ).rejects.toThrow(UnassignableFieldError);
  });

  it('requires exactly one correlation rule', async () => {
    const source = await makeSource();
    await expect(
      withTenant(tenantId, (tx) =>
        setPersonMappings(tx, source.id, [
          {
            recordType: 'person',
            sourceColumn: 'a',
            targetField: 'givenName',
            transform: 'none',
            isCorrelation: false,
          },
        ]),
      ),
    ).rejects.toThrow(/exactly one correlation/);
  });

  it('refuses a correlation rule on a contract field', async () => {
    const source = await makeSource();
    await expect(
      withTenant(tenantId, (tx) =>
        setPersonMappings(tx, source.id, [
          {
            recordType: 'contract',
            sourceColumn: 'contractId',
            targetField: 'externalId',
            transform: 'none',
            isCorrelation: true,
          },
        ]),
      ),
    ).rejects.toThrow(/must map a person field/);
  });

  it('round-trips the rules it stored', async () => {
    const source = await makeSource();
    const rules = [
      correlation,
      {
        recordType: 'contract' as const,
        sourceColumn: 'hireDate',
        targetField: 'startDate',
        transform: 'none' as const,
        isCorrelation: false,
      },
    ];
    await withTenant(tenantId, (tx) => setPersonMappings(tx, source.id, rules));
    const read = await withTenant(tenantId, (tx) => personMappingsFor(tx, source.id));
    expect(read).toHaveLength(2);
    expect(read.find((r) => r.isCorrelation)?.targetField).toBe('externalId');
  });

  /**
   * Wholesale replacement, not a merge: a rule removed from the set is gone
   * after the save, and does not linger to write a field nobody mapped.
   */
  it('replaces the previous set rather than adding to it', async () => {
    const source = await makeSource();
    await withTenant(tenantId, (tx) =>
      setPersonMappings(tx, source.id, [
        correlation,
        {
          recordType: 'person',
          sourceColumn: 'firstName',
          targetField: 'givenName',
          transform: 'none',
          isCorrelation: false,
        },
      ]),
    );
    await withTenant(tenantId, (tx) => setPersonMappings(tx, source.id, [correlation]));
    const read = await withTenant(tenantId, (tx) => personMappingsFor(tx, source.id));
    expect(read).toHaveLength(1);
  });
});

describe('deletePersonSource', () => {
  it('refuses without confirmation while it owns persons, then releases them', async () => {
    const source = await makeSource();
    await withTenant(tenantId, (tx) =>
      tx.person.create({
        data: {
          tenantId,
          givenName: 'Ada',
          familyName: 'Lovelace',
          externalId: '1',
          sourceId: source.id,
        },
      }),
    );

    await expect(
      withTenant(tenantId, (tx) => deletePersonSource(tx, source.id)),
    ).rejects.toThrow(PersonSourceOwnsPersonsError);

    await withTenant(tenantId, (tx) =>
      deletePersonSource(tx, source.id, { confirm: true }),
    );

    const person = await withTenant(tenantId, (tx) =>
      tx.person.findFirst({ where: { externalId: '1' } }),
    );
    // Deactivated and detached, never deleted.
    expect(person).not.toBeNull();
    expect(person?.sourceId).toBeNull();
    expect(person?.status).toBe('inactive');
    expect(person?.statusReason).toMatch(/was removed/);
  });

  it('needs no confirmation when it owns nobody', async () => {
    const source = await makeSource();
    await expect(
      withTenant(tenantId, (tx) => deletePersonSource(tx, source.id)),
    ).resolves.toEqual({ persons: 0 });
  });

  it('removes the vault secret with the source', async () => {
    const source = await makeSource();
    await withTenant(tenantId, (tx) => deletePersonSource(tx, source.id));
    const secret = await withTenant(tenantId, (tx) =>
      getSecret(tx, provider, source.secretName),
    );
    expect(secret).toBeNull();
  });

  it('returns null for a source that is not there', async () => {
    await expect(
      withTenant(tenantId, (tx) =>
        deletePersonSource(tx, '00000000-0000-0000-0000-000000000000'),
      ),
    ).resolves.toBeNull();
  });
});

describe('personSourceWithCredential', () => {
  it('merges the stored config with a sealed password', async () => {
    const source = await makeSource();
    const merged = await withTenant(tenantId, (tx) =>
      personSourceWithCredential(tx, provider, source.id),
    );
    expect(merged?.host).toBe('hr.example.test');
    expect(merged?.password).toBe('hunter2');
    expect(merged?.privateKey).toBeUndefined();
  });

  /**
   * One vault entry holds whichever credential the source has. A PEM banner
   * is what tells the two apart.
   */
  it('presents a PEM credential as a private key', async () => {
    const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----';
    const source = await makeSource({ credential: key });
    const merged = await withTenant(tenantId, (tx) =>
      personSourceWithCredential(tx, provider, source.id),
    );
    expect(merged?.privateKey).toBe(key);
    expect(merged?.password).toBeUndefined();
  });

  it('returns null for a source that is not there', async () => {
    const merged = await withTenant(tenantId, (tx) =>
      personSourceWithCredential(tx, provider, '00000000-0000-0000-0000-000000000000'),
    );
    expect(merged).toBeNull();
  });
});
