import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { addMember, createGroup } from '../directory/group-service.js';
import { createUser, deactivateUser } from '../directory/user-service.js';
import { createContract } from '../identity/contract-service.js';
import { createPerson, linkUserToPerson } from '../identity/person-service.js';
import { generateRecoveryCodes } from '../auth/mfa/recovery-codes.js';
import { previewRuleImpact } from './impact.js';

let tenantId: string;

const NOW = new Date('2026-08-12T09:00:00Z');
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

async function user(login: string) {
  return withTenant(tenantId, (tx) =>
    createUser(tx, {
      login,
      email: `${login}@acme.test`,
      displayName: login,
    }),
  );
}

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
});

const preview = (rule: Parameters<typeof previewRuleImpact>[1]) =>
  withTenant(tenantId, (tx) => previewRuleImpact(tx, rule, NOW));

describe('previewRuleImpact', () => {
  it('counts everyone for an unconstrained rule', async () => {
    await user('a');
    await user('b');
    const impact = await preview({ name: 'All', outcome: 'require_mfa' });
    expect(impact).toMatchObject({
      totalActiveUsers: 2,
      matchedUsers: 2,
      usersNeedingEnrolment: 2,
    });
  });

  it('leaves out inactive users', async () => {
    const a = await user('a');
    await user('b');
    await withTenant(tenantId, (tx) => deactivateUser(tx, a.id, 'left'));
    const impact = await preview({ name: 'All', outcome: 'require_mfa' });
    expect(impact.totalActiveUsers).toBe(1);
  });

  it('counts only the matching group', async () => {
    const a = await user('a');
    await user('b');
    const groupId = await withTenant(tenantId, async (tx) => {
      const g = await createGroup(tx, 'Finance');
      await addMember(tx, g.id, a.id);
      return g.id;
    });
    const impact = await preview({
      name: 'Finance',
      outcome: 'require_mfa',
      groupIds: [groupId],
    });
    expect(impact).toMatchObject({ totalActiveUsers: 2, matchedUsers: 1 });
  });

  it('counts a contract condition against every active contract', async () => {
    const a = await user('a');
    await user('b');
    await withTenant(tenantId, async (tx) => {
      const person = await createPerson(tx, { givenName: 'A', familyName: 'A' });
      await linkUserToPerson(tx, a.id, person.id);
      await createContract(tx, person.id, {
        sequence: 1,
        startDate: day('2026-01-01'),
        department: 'Care',
      });
      await createContract(tx, person.id, {
        sequence: 2,
        startDate: day('2026-01-01'),
        department: 'Finance',
      });
    });
    const impact = await preview({
      name: 'Finance',
      outcome: 'require_mfa',
      contractField: 'department',
      contractValues: ['Finance'],
    });
    expect(impact.matchedUsers).toBe(1);
  });

  it('does not count someone who already holds a factor as needing enrolment', async () => {
    const a = await user('a');
    await user('b');
    await withTenant(tenantId, (tx) => generateRecoveryCodes(tx, a.id));
    const impact = await preview({ name: 'All', outcome: 'require_mfa' });
    // Recovery codes satisfy require_mfa, so `a` is already covered.
    expect(impact).toMatchObject({ matchedUsers: 2, usersNeedingEnrolment: 1 });
  });

  it('does not let recovery codes cover a rule that names a factor', async () => {
    const a = await user('a');
    await withTenant(tenantId, (tx) => generateRecoveryCodes(tx, a.id));
    const impact = await preview({
      name: 'Keys',
      outcome: 'require_factor',
      factorType: 'webauthn',
    });
    expect(impact.usersNeedingEnrolment).toBe(1);
  });

  it('counts nobody as needing enrolment for an allow rule', async () => {
    await user('a');
    const impact = await preview({ name: 'Allow', outcome: 'allow' });
    expect(impact.usersNeedingEnrolment).toBe(0);
  });

  it('names the conditions it could not evaluate', async () => {
    await user('a');
    const impact = await preview({
      name: 'Offsite nights',
      outcome: 'deny',
      ipRanges: ['203.0.113.0/24'],
      startMinute: 0,
      endMinute: 60,
    });
    // A preview has no request behind it, so there is no address and no moment
    // to test. Saying so is better than quietly counting as if there were.
    expect(impact.unevaluatedConditions).toEqual(['source address', 'time window']);
    expect(impact.matchedUsers).toBe(1);
  });

  it('answers from counts, and says so, when the directory is too large to walk', async () => {
    // Not a real 25,000-user fixture: the cap is lowered for the test, which is
    // what makes the partial-answer branch reachable at all. Without this the
    // branch would first run on a customer's directory.
    await user('a');
    await user('b');
    const impact = await withTenant(tenantId, (tx) =>
      previewRuleImpact(
        tx,
        {
          name: 'Finance',
          outcome: 'require_mfa',
          contractField: 'department',
          contractValues: ['Finance'],
        },
        NOW,
        { userCap: 1, membershipCap: 1 },
      ),
    );

    expect(impact.totalActiveUsers).toBe(2);
    // No group condition, so SQL matches everyone; the contract condition it
    // could not apply is named rather than silently ignored.
    expect(impact.matchedUsers).toBe(2);
    expect(impact.unevaluatedConditions).toContain('contract attributes');
  });

  it('assumes the user is entering the application a rule names', async () => {
    await user('a');
    const appId = await withTenant(tenantId, async (tx) => {
      const row = await tx.application.create({
        data: { tenantId, name: 'CRM', slug: 'crm', launchUrl: 'https://crm.acme.test/' },
      });
      return row.id;
    });
    const impact = await preview({
      name: 'CRM',
      outcome: 'require_mfa',
      applicationIds: [appId],
    });
    expect(impact.matchedUsers).toBe(1);
  });
});
