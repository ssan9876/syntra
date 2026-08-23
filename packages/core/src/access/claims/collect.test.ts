import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { createUser } from '../../directory/user-service.js';
import { createGroup, addMember, deactivateGroup } from '../../directory/group-service.js';
import { createPerson } from '../../identity/person-service.js';
import { createContract } from '../../identity/contract-service.js';
import { collectSubjectFacts } from './collect.js';

let tenantId: string;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
});

describe('collectSubjectFacts', () => {
  it('selects a different contract for each strategy when they disagree', async () => {
    const facts = await withTenant(tenantId, async (tx) => {
      const person = await createPerson(tx, { givenName: 'J', familyName: 'Doe' });
      // Sequence 1 is Care and is not primary; sequence 2 is Finance and is.
      await createContract(tx, person.id, {
        sequence: 1, startDate: new Date('2020-01-01'), department: 'Care',
      });
      await createContract(tx, person.id, {
        sequence: 2, isPrimary: true, startDate: new Date('2021-01-01'), department: 'Finance',
      });
      const user = await createUser(tx, {
        login: 'jdoe', email: 'j@acme.test', displayName: 'J Doe',
      });
      await tx.user.update({ where: { id: user.id }, data: { personId: person.id } });
      return collectSubjectFacts(tx, user.id, new Date('2024-06-01'));
    });

    expect(facts.contract.primary?.department).toBe('Finance');
    expect(facts.contract.lowestSequence?.department).toBe('Care');
  });

  it('leaves both contract slots null when every contract has ended', async () => {
    const facts = await withTenant(tenantId, async (tx) => {
      const person = await createPerson(tx, { givenName: 'J', familyName: 'Doe' });
      await createContract(tx, person.id, {
        sequence: 1, isPrimary: true,
        startDate: new Date('2020-01-01'), endDate: new Date('2021-01-01'),
        department: 'Care',
      });
      const user = await createUser(tx, {
        login: 'jdoe', email: 'j@acme.test', displayName: 'J Doe',
      });
      await tx.user.update({ where: { id: user.id }, data: { personId: person.id } });
      return collectSubjectFacts(tx, user.id, new Date('2024-06-01'));
    });

    expect(facts.contract.primary).toBeNull();
    expect(facts.contract.lowestSequence).toBeNull();
  });

  it('leaves the primary slot null when the primary contract has ended but another has not', async () => {
    const facts = await withTenant(tenantId, async (tx) => {
      const person = await createPerson(tx, { givenName: 'J', familyName: 'Doe' });
      await createContract(tx, person.id, {
        sequence: 1, isPrimary: true,
        startDate: new Date('2020-01-01'), endDate: new Date('2021-01-01'),
        department: 'Care',
      });
      await createContract(tx, person.id, {
        sequence: 2, startDate: new Date('2021-01-01'), department: 'Finance',
      });
      const user = await createUser(tx, {
        login: 'jdoe', email: 'j@acme.test', displayName: 'J Doe',
      });
      await tx.user.update({ where: { id: user.id }, data: { personId: person.id } });
      return collectSubjectFacts(tx, user.id, new Date('2024-06-01'));
    });

    // resolveContractForMapping('primary') looks for isPrimary among the
    // ACTIVE contracts. The ended primary is not among them, so this is null
    // and every claim mapped to the primary contract is omitted — which is
    // the behaviour spec section 6 asks for, not a fallback to the other one.
    expect(facts.contract.primary).toBeNull();
    expect(facts.contract.lowestSequence?.department).toBe('Finance');
  });

  it('collects a user with no person at all', async () => {
    const facts = await withTenant(tenantId, async (tx) => {
      const user = await createUser(tx, {
        login: 'svc', email: 's@acme.test', displayName: 'Service',
      });
      return collectSubjectFacts(tx, user.id);
    });
    expect(facts.person).toBeNull();
    expect(facts.contract).toEqual({ primary: null, lowestSequence: null });
    expect(facts.user.login).toBe('svc');
  });

  it('collects group names and user attributes', async () => {
    const facts = await withTenant(tenantId, async (tx) => {
      const user = await createUser(tx, {
        login: 'jdoe', email: 'j@acme.test', displayName: 'J Doe',
      });
      const group = await createGroup(tx, 'Finance');
      await addMember(tx, group.id, user.id);
      await tx.userAttribute.create({
        data: { tenantId, userId: user.id, key: 'cost_centre', type: 'string', value: 'CC-1' },
      });
      return collectSubjectFacts(tx, user.id);
    });
    expect(facts.groups).toEqual(['Finance']);
    expect(facts.attributes.cost_centre).toBe('CC-1');
  });

  it('LEAVES OUT a deactivated group, which is asserted access it no longer has', async () => {
    // These names go into SAML assertions and OIDC tokens, and the receiving
    // application grants on them. A deactivated group named here is access
    // Syntra reports as revoked and the other side is still honouring —
    // revocation that succeeds on the screen and nowhere else.
    const facts = await withTenant(tenantId, async (tx) => {
      const user = await createUser(tx, {
        login: 'jdoe', email: 'j@acme.test', displayName: 'J Doe',
      });
      const kept = await createGroup(tx, 'Finance');
      const gone = await createGroup(tx, 'Contractors');
      await addMember(tx, kept.id, user.id);
      await addMember(tx, gone.id, user.id);
      await deactivateGroup(tx, gone.id, 'engagement ended');
      return collectSubjectFacts(tx, user.id);
    });
    expect(facts.groups).toEqual(['Finance']);
  });
});
