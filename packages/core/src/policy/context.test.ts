import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { addMember, createGroup } from '../directory/group-service.js';
import { createUser } from '../directory/user-service.js';
import { createContract } from '../identity/contract-service.js';
import { createPerson, linkUserToPerson } from '../identity/person-service.js';
import { buildAuthContext } from './context.js';

let tenantId: string;
let userId: string;

const NOW = new Date('2026-08-12T09:00:00Z');
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  userId = await withTenant(tenantId, async (tx) => {
    const u = await createUser(tx, {
      login: 'jdoe',
      email: 'j@acme.test',
      displayName: 'J Doe',
    });
    return u.id;
  });
});

const build = (over: { applicationId?: string | null; sourceIp?: string | null } = {}) =>
  withTenant(tenantId, (tx) =>
    buildAuthContext(tx, {
      userId,
      applicationId: over.applicationId ?? null,
      sourceIp: over.sourceIp ?? '10.1.2.3',
      now: NOW,
    }),
  );

describe('buildAuthContext', () => {
  it('carries the request facts through unchanged', async () => {
    const context = await build({ applicationId: null, sourceIp: '10.1.2.3' });
    expect(context).toMatchObject({
      userId,
      applicationId: null,
      sourceIp: '10.1.2.3',
      now: NOW,
    });
  });

  it('lists the groups the user belongs to', async () => {
    const groupId = await withTenant(tenantId, async (tx) => {
      const g = await createGroup(tx, 'Finance');
      await addMember(tx, g.id, userId);
      return g.id;
    });
    const context = await build();
    expect(context.groupIds).toEqual([groupId]);
  });

  it('gives a user with no person an empty contract list', async () => {
    const context = await build();
    expect(context.contracts).toEqual([]);
  });

  it('carries every contract in force right now', async () => {
    await withTenant(tenantId, async (tx) => {
      const person = await createPerson(tx, { givenName: 'J', familyName: 'Doe' });
      await linkUserToPerson(tx, userId, person.id);
      await createContract(tx, person.id, {
        sequence: 1,
        isPrimary: true,
        startDate: day('2026-01-01'),
        department: 'Care',
        jobTitle: 'Nurse',
      });
      await createContract(tx, person.id, {
        sequence: 2,
        startDate: day('2026-06-01'),
        department: 'Finance',
        jobTitle: 'Controller',
      });
    });

    const context = await build();
    expect(context.contracts).toHaveLength(2);
    expect(context.contracts.map((c) => c.department).sort()).toEqual(['Care', 'Finance']);
  });

  it('leaves out a contract that has already ended', async () => {
    await withTenant(tenantId, async (tx) => {
      const person = await createPerson(tx, { givenName: 'J', familyName: 'Doe' });
      await linkUserToPerson(tx, userId, person.id);
      await createContract(tx, person.id, {
        sequence: 1,
        startDate: day('2025-01-01'),
        endDate: day('2026-01-31'),
        department: 'Finance',
      });
      await createContract(tx, person.id, {
        sequence: 2,
        startDate: day('2026-02-01'),
        department: 'Care',
      });
    });

    const context = await build();
    expect(context.contracts.map((c) => c.department)).toEqual(['Care']);
  });

  it('gives an empty list when every contract has ended', async () => {
    await withTenant(tenantId, async (tx) => {
      const person = await createPerson(tx, { givenName: 'J', familyName: 'Doe' });
      await linkUserToPerson(tx, userId, person.id);
      await createContract(tx, person.id, {
        sequence: 1,
        startDate: day('2025-01-01'),
        endDate: day('2026-01-31'),
        department: 'Finance',
      });
    });

    const context = await build();
    expect(context.contracts).toEqual([]);
  });

  it('leaves out a contract that has not started yet', async () => {
    await withTenant(tenantId, async (tx) => {
      const person = await createPerson(tx, { givenName: 'J', familyName: 'Doe' });
      await linkUserToPerson(tx, userId, person.id);
      await createContract(tx, person.id, {
        sequence: 1,
        startDate: day('2026-12-01'),
        department: 'Finance',
      });
    });

    const context = await build();
    expect(context.contracts).toEqual([]);
  });

  it('carries only the four fields a rule may read', async () => {
    await withTenant(tenantId, async (tx) => {
      const person = await createPerson(tx, { givenName: 'J', familyName: 'Doe' });
      await linkUserToPerson(tx, userId, person.id);
      await createContract(tx, person.id, {
        sequence: 1,
        startDate: day('2026-01-01'),
        department: 'Care',
        jobTitle: 'Nurse',
        employer: 'Acme Care',
        location: 'Utrecht',
        costCentre: 'CC-9',
      });
    });

    const context = await build();
    expect(Object.keys(context.contracts[0]!).sort()).toEqual([
      'department',
      'employer',
      'jobTitle',
      'location',
    ]);
  });
});
