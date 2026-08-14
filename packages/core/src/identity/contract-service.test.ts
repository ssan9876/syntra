import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { createPerson } from './person-service.js';
import {
  activeContracts,
  createContract,
  primaryContract,
  resolveContractForMapping,
} from './contract-service.js';

let tenantId: string;
let personId: string;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  const person = await withTenant(tenantId, (tx) =>
    createPerson(tx, { givenName: 'Jo', familyName: 'Doe' }),
  );
  personId = person.id;
});

const d = (s: string) => new Date(`${s}T00:00:00Z`);

describe('concurrent contracts', () => {
  it('returns both contracts a person holds at once', async () => {
    await withTenant(tenantId, async (tx) => {
      await createContract(tx, personId, {
        sequence: 1,
        isPrimary: true,
        startDate: d('2026-01-01'),
        jobTitle: 'Nurse',
      });
      await createContract(tx, personId, {
        sequence: 2,
        startDate: d('2026-03-01'),
        jobTitle: 'Trainer',
      });
    });

    const active = await withTenant(tenantId, (tx) =>
      activeContracts(tx, personId, d('2026-06-01')),
    );
    expect(active.map((c) => c.jobTitle).sort()).toEqual(['Nurse', 'Trainer']);
  });

  it('excludes a contract that has ended while another continues', async () => {
    await withTenant(tenantId, async (tx) => {
      await createContract(tx, personId, {
        sequence: 1,
        isPrimary: true,
        startDate: d('2026-01-01'),
        jobTitle: 'Nurse',
      });
      await createContract(tx, personId, {
        sequence: 2,
        startDate: d('2026-01-01'),
        endDate: d('2026-04-30'),
        jobTitle: 'Trainer',
      });
    });

    const active = await withTenant(tenantId, (tx) =>
      activeContracts(tx, personId, d('2026-06-01')),
    );
    expect(active.map((c) => c.jobTitle)).toEqual(['Nurse']);
  });

  it('returns nothing for a person with no active contract', async () => {
    await withTenant(tenantId, (tx) =>
      createContract(tx, personId, {
        sequence: 1,
        startDate: d('2020-01-01'),
        endDate: d('2021-01-01'),
      }),
    );
    const active = await withTenant(tenantId, (tx) =>
      activeContracts(tx, personId, d('2026-06-01')),
    );
    expect(active).toEqual([]);
  });

  it('excludes a contract that has not started yet', async () => {
    await withTenant(tenantId, (tx) =>
      createContract(tx, personId, { sequence: 1, startDate: d('2027-01-01') }),
    );
    const active = await withTenant(tenantId, (tx) =>
      activeContracts(tx, personId, d('2026-06-01')),
    );
    expect(active).toEqual([]);
  });

  it('includes a contract on its exact start and end dates', async () => {
    await withTenant(tenantId, (tx) =>
      createContract(tx, personId, {
        sequence: 1,
        startDate: d('2026-01-01'),
        endDate: d('2026-12-31'),
        jobTitle: 'Nurse',
      }),
    );

    const onStart = await withTenant(tenantId, (tx) =>
      activeContracts(tx, personId, d('2026-01-01')),
    );
    const onEnd = await withTenant(tenantId, (tx) =>
      activeContracts(tx, personId, d('2026-12-31')),
    );
    expect(onStart).toHaveLength(1);
    expect(onEnd).toHaveLength(1);
  });
});

describe('primary contract', () => {
  it('refuses a second primary contract for the same person', async () => {
    await withTenant(tenantId, (tx) =>
      createContract(tx, personId, {
        sequence: 1,
        isPrimary: true,
        startDate: d('2026-01-01'),
      }),
    );
    await expect(
      withTenant(tenantId, (tx) =>
        createContract(tx, personId, {
          sequence: 2,
          isPrimary: true,
          startDate: d('2026-01-01'),
        }),
      ),
    ).rejects.toThrow();
  });

  it('allows a primary contract for each of two different people', async () => {
    const other = await withTenant(tenantId, (tx) =>
      createPerson(tx, { givenName: 'Sam', familyName: 'Roe' }),
    );
    await withTenant(tenantId, (tx) =>
      createContract(tx, personId, {
        sequence: 1,
        isPrimary: true,
        startDate: d('2026-01-01'),
      }),
    );
    const second = await withTenant(tenantId, (tx) =>
      createContract(tx, other.id, {
        sequence: 1,
        isPrimary: true,
        startDate: d('2026-01-01'),
      }),
    );
    expect(second.isPrimary).toBe(true);
  });

  it('finds the primary contract even when it has ended', async () => {
    await withTenant(tenantId, (tx) =>
      createContract(tx, personId, {
        sequence: 1,
        isPrimary: true,
        startDate: d('2020-01-01'),
        endDate: d('2021-01-01'),
      }),
    );
    const found = await withTenant(tenantId, (tx) =>
      primaryContract(tx, personId),
    );
    expect(found).not.toBeNull();
  });
});

describe('resolveContractForMapping', () => {
  it('prefers the primary contract', async () => {
    await withTenant(tenantId, async (tx) => {
      await createContract(tx, personId, {
        sequence: 1,
        startDate: d('2026-01-01'),
        department: 'Ops',
      });
      await createContract(tx, personId, {
        sequence: 2,
        isPrimary: true,
        startDate: d('2026-01-01'),
        department: 'Finance',
      });
    });

    const c = await withTenant(tenantId, (tx) =>
      resolveContractForMapping(tx, personId, 'primary', d('2026-06-01')),
    );
    expect(c?.department).toBe('Finance');
  });

  it('falls back to the lowest active sequence when asked', async () => {
    await withTenant(tenantId, async (tx) => {
      await createContract(tx, personId, {
        sequence: 5,
        startDate: d('2026-01-01'),
        department: 'Ops',
      });
      await createContract(tx, personId, {
        sequence: 2,
        startDate: d('2026-01-01'),
        department: 'Finance',
      });
    });

    const c = await withTenant(tenantId, (tx) =>
      resolveContractForMapping(tx, personId, 'lowestSequence', d('2026-06-01')),
    );
    expect(c?.department).toBe('Finance');
  });

  it('returns null when the primary contract is not currently active', async () => {
    await withTenant(tenantId, (tx) =>
      createContract(tx, personId, {
        sequence: 1,
        isPrimary: true,
        startDate: d('2020-01-01'),
        endDate: d('2021-01-01'),
      }),
    );
    const c = await withTenant(tenantId, (tx) =>
      resolveContractForMapping(tx, personId, 'primary', d('2026-06-01')),
    );
    expect(c).toBeNull();
  });

  it('returns null under the primary strategy when no contract is primary', async () => {
    await withTenant(tenantId, (tx) =>
      createContract(tx, personId, {
        sequence: 1,
        startDate: d('2026-01-01'),
        department: 'Ops',
      }),
    );
    const c = await withTenant(tenantId, (tx) =>
      resolveContractForMapping(tx, personId, 'primary', d('2026-06-01')),
    );
    expect(c).toBeNull();
  });
});
