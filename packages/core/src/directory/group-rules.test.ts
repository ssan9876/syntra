import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { createUser } from './user-service.js';
import { addMember, createGroup, listMembers } from './group-service.js';
import {
  applyAllGroupRules,
  applyGroupRule,
  GroupRuleSourceOwnedError,
  previewGroupRule,
  setGroupMembershipRule,
} from './group-rules.js';

const ON = new Date('2026-10-01T12:00:00Z');
const FINANCE = { field: 'contract.department', op: 'equals', value: 'Finance' };

let tenantId: string;
let groupId: string;

async function personWithLogin(
  login: string,
  contract: { department?: string; jobTitle?: string; startDate?: string; endDate?: string } | null,
  person: { status?: string; restricted?: boolean } = {},
): Promise<string> {
  return withTenant(tenantId, async (tx) => {
    const p = await tx.person.create({
      data: {
        tenantId,
        givenName: login,
        familyName: 'Test',
        status: person.status ?? 'active',
        ...(person.restricted
          ? { processingRestrictedAt: new Date(), processingRestrictedCaseId: '00000000-0000-4000-8000-000000000001' }
          : {}),
      },
    });
    if (contract) {
      await tx.contract.create({
        data: {
          tenantId,
          personId: p.id,
          isPrimary: true,
          startDate: new Date(contract.startDate ?? '2020-01-01'),
          endDate: contract.endDate ? new Date(contract.endDate) : null,
          department: contract.department ?? null,
          jobTitle: contract.jobTitle ?? null,
        },
      });
    }
    const user = await createUser(tx, { login, email: `${login}@acme.test`, displayName: login });
    await tx.user.update({ where: { id: user.id }, data: { personId: p.id } });
    return user.id;
  });
}

async function memberLogins(): Promise<string[]> {
  const members = await withTenant(tenantId, (tx) => listMembers(tx, groupId));
  return members.map((m) => `${m.login}:${m.membershipOrigin}`).sort();
}

beforeEach(async () => {
  await resetDatabase();
  tenantId = (await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } })).id;
  groupId = (await withTenant(tenantId, (tx) => createGroup(tx, 'Finance'))).id;
});

describe('setGroupMembershipRule', () => {
  it('adds the people whose contract in force matches', async () => {
    await personWithLogin('ann', { department: 'finance ' });
    await personWithLogin('bob', { department: 'Sales' });
    await personWithLogin('cat', { department: 'Finance', endDate: '2026-09-01' });
    await personWithLogin('dan', { department: 'Finance', startDate: '2027-01-01' });

    const changes = await withTenant(tenantId, (tx) => setGroupMembershipRule(tx, groupId, FINANCE));

    expect(changes?.add).toHaveLength(1);
    expect(await memberLogins()).toEqual(['ann:rule']);
  });

  it('refuses a rule naming a field outside the closed set', async () => {
    await expect(
      withTenant(tenantId, (tx) =>
        setGroupMembershipRule(tx, groupId, { field: 'contract.salary', op: 'equals', value: 'x' }),
      ),
    ).rejects.toThrow();
  });

  it('refuses a rule on a source-owned group', async () => {
    await withTenant(tenantId, async (tx) => {
      const source = await tx.directorySource.create({
        data: { tenantId, name: 'AD', type: 'ldap', config: {}, secretName: 'ad' },
      });
      await tx.group.update({ where: { id: groupId }, data: { sourceId: source.id, sourceAnchor: 'g1' } });
    });
    await expect(
      withTenant(tenantId, (tx) => setGroupMembershipRule(tx, groupId, FINANCE)),
    ).rejects.toBeInstanceOf(GroupRuleSourceOwnedError);
  });

  it('clearing the rule removes rule members and keeps direct ones', async () => {
    await personWithLogin('ann', { department: 'Finance' });
    const bob = await personWithLogin('bob', { department: 'Sales' });
    await withTenant(tenantId, (tx) => addMember(tx, groupId, bob));
    await withTenant(tenantId, (tx) => setGroupMembershipRule(tx, groupId, FINANCE));
    expect(await memberLogins()).toEqual(['ann:rule', 'bob:direct']);

    await withTenant(tenantId, (tx) => setGroupMembershipRule(tx, groupId, null));
    expect(await memberLogins()).toEqual(['bob:direct']);
  });

  it('records the change in the audit trail', async () => {
    await personWithLogin('ann', { department: 'Finance' });
    await withTenant(tenantId, (tx) => setGroupMembershipRule(tx, groupId, FINANCE));
    const actions = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({ orderBy: { sequence: 'asc' }, select: { action: true } }),
    );
    expect(actions.map((a) => a.action)).toEqual(['group.ruleUpdate', 'group.ruleApply']);
  });
});

describe('applyGroupRule', () => {
  it('removes a rule member who stops matching, never a direct member', async () => {
    const ann = await personWithLogin('ann', { department: 'Finance' });
    const bob = await personWithLogin('bob', { department: 'Finance' });
    await withTenant(tenantId, (tx) => setGroupMembershipRule(tx, groupId, FINANCE));
    // An explicit add makes bob direct.
    await withTenant(tenantId, (tx) => addMember(tx, groupId, bob));

    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({ data: { department: 'Sales' } }),
    );
    const changes = await withTenant(tenantId, (tx) => applyGroupRule(tx, groupId, { on: ON }));

    expect(changes?.remove).toEqual([ann]);
    expect(await memberLogins()).toEqual(['bob:direct']);
  });

  it('matches person.status for a person with no contract in force', async () => {
    await personWithLogin('ann', { department: 'Finance', endDate: '2026-01-31' }, { status: 'inactive' });
    await personWithLogin('bob', { department: 'Finance' });
    await withTenant(tenantId, (tx) =>
      setGroupMembershipRule(tx, groupId, { field: 'person.status', op: 'equals', value: 'inactive' }),
    );
    expect(await memberLogins()).toEqual(['ann:rule']);
  });

  it('combines department and job title', async () => {
    await personWithLogin('ann', { department: 'Finance', jobTitle: 'Senior Accountant' });
    await personWithLogin('bob', { department: 'Finance', jobTitle: 'Clerk' });
    await withTenant(tenantId, (tx) =>
      setGroupMembershipRule(tx, groupId, {
        all: [FINANCE, { field: 'contract.jobTitle', op: 'contains', value: 'accountant' }],
      }),
    );
    expect(await memberLogins()).toEqual(['ann:rule']);
  });

  it('does not add a person under a processing restriction', async () => {
    await personWithLogin('ann', { department: 'Finance' }, { restricted: true });
    await withTenant(tenantId, (tx) => setGroupMembershipRule(tx, groupId, FINANCE));
    expect(await memberLogins()).toEqual([]);
  });

  it('leaves an inactive group as it is', async () => {
    await withTenant(tenantId, (tx) =>
      tx.group.update({
        where: { id: groupId },
        data: { status: 'inactive', membershipRule: FINANCE },
      }),
    );
    await personWithLogin('ann', { department: 'Finance' });
    expect(await withTenant(tenantId, (tx) => applyGroupRule(tx, groupId))).toBeNull();
    expect(await memberLogins()).toEqual([]);
  });
});

describe('the removal hold', () => {
  async function financeGroupOf(size: number) {
    for (let i = 0; i < size; i += 1) await personWithLogin(`p${i}`, { department: 'Finance' });
    await withTenant(tenantId, (tx) => setGroupMembershipRule(tx, groupId, FINANCE));
  }

  it('holds an unattended pass that removes more than a quarter of the rule members', async () => {
    await financeGroupOf(20);
    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({ where: { person: { givenName: { in: ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'] } } }, data: { department: 'Sales' } }),
    );

    const result = await applyAllGroupRules(tenantId, ON);

    expect(result).toMatchObject({ added: 0, removed: 0, held: 1 });
    expect(await memberLogins()).toHaveLength(20);
    const group = await withTenant(tenantId, (tx) => tx.group.findUniqueOrThrow({ where: { id: groupId } }));
    expect(group.ruleHeldRemoveCount).toBe(6);
    const held = await withTenant(tenantId, (tx) => tx.auditEvent.findFirst({ where: { action: 'group.ruleHeld' } }));
    expect(held?.outcome).toBe('failure');
  });

  it('applies the same pass when confirmed, and clears the hold', async () => {
    await financeGroupOf(20);
    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({ where: { person: { givenName: { in: ['p0', 'p1', 'p2', 'p3', 'p4', 'p5'] } } }, data: { department: 'Sales' } }),
    );
    await applyAllGroupRules(tenantId, ON);

    const result = await withTenant(tenantId, (tx) => applyGroupRule(tx, groupId, { on: ON, confirm: true }));

    expect(result).toMatchObject({ held: false });
    expect(await memberLogins()).toHaveLength(14);
    const group = await withTenant(tenantId, (tx) => tx.group.findUniqueOrThrow({ where: { id: groupId } }));
    expect(group.ruleHeldRemoveCount).toBeNull();
  });

  it('lets a small removal through whatever the share', async () => {
    await financeGroupOf(6);
    await withTenant(tenantId, (tx) =>
      tx.contract.updateMany({ where: { person: { givenName: { in: ['p0', 'p1', 'p2', 'p3', 'p4'] } } }, data: { department: 'Sales' } }),
    );
    const result = await applyAllGroupRules(tenantId, ON);
    expect(result).toMatchObject({ removed: 5, held: 0 });
  });
});

describe('previewGroupRule', () => {
  it('reports changes without writing them', async () => {
    await personWithLogin('ann', { department: 'Finance' });
    const preview = await withTenant(tenantId, (tx) => previewGroupRule(tx, groupId, FINANCE as never, ON));
    expect(preview.add).toHaveLength(1);
    expect(await memberLogins()).toEqual([]);
  });
});

describe('applyAllGroupRules', () => {
  it('applies every group with a rule and skips one whose rule does not parse', async () => {
    await personWithLogin('ann', { department: 'Finance' });
    await withTenant(tenantId, async (tx) => {
      await tx.group.update({ where: { id: groupId }, data: { membershipRule: FINANCE } });
      await tx.group.create({
        data: { tenantId, name: 'Broken', membershipRule: { field: 'contract.salary', op: 'equals', value: 'x' } },
      });
      await tx.group.create({ data: { tenantId, name: 'Manual' } });
    });

    const result = await applyAllGroupRules(tenantId, ON);

    expect(result).toEqual({ groups: 2, added: 1, removed: 0, failed: 1, held: 0 });
    expect(await memberLogins()).toEqual(['ann:rule']);
  });
});
