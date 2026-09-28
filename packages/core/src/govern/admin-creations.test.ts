import { describe, expect, it } from 'vitest';
import { adminCreations, type AdminEvent } from './collect.js';

const AT = new Date('2026-05-02T10:00:00Z');
const users = [
  { id: 'user-anna', login: 'Anna.Novak' },
  { id: 'user-jan', login: 'jan' },
];

let sequence = 0;
const event = (action: string, targetId: string | null, payload: unknown): AdminEvent => ({
  id: `audit-${++sequence}`,
  sequence,
  action,
  actorUserId: 'user-admin',
  targetId,
  occurredAt: AT,
  payload,
});

describe('adminCreations', () => {
  it('records the event that created each login', () => {
    const create = event('user.create', 'user-anna', { login: 'Anna.Novak' });
    const scim = event('scim.user_created', 'user-jan', {});
    const made = adminCreations([create, scim], users);
    expect(made.logins.get('user-anna')).toBe(create);
    expect(made.logins.get('user-jan')).toBe(scim);
  });

  it('matches a membership named by login case-insensitively, and by userId when present', () => {
    const byLogin = event('group.addMember', 'group-1', { group: 'Finance', login: 'anna.novak' });
    const byId = event('group.addMember', 'group-2', { group: 'IT', login: 'renamed', userId: 'user-jan' });
    const made = adminCreations([byLogin, byId], users);
    expect(made.memberships.get('group-1|user-anna')).toBe(byLogin);
    expect(made.memberships.get('group-2|user-jan')).toBe(byId);
  });

  it('keeps the latest add, after a remove and a re-add', () => {
    const first = event('group.addMember', 'group-1', { userId: 'user-anna' });
    const again = event('group.addMember', 'group-1', { userId: 'user-anna' });
    expect(adminCreations([first, again], users).memberships.get('group-1|user-anna')).toBe(again);
  });

  it('keys a role assignment by user, role and scope', () => {
    const tenantWide = event('rbac.role_assigned', 'user-anna', { roleId: 'role-1' });
    const scoped = event('rbac.role_assigned', 'user-anna', { roleId: 'role-1', scopeOrgUnitId: 'unit-1' });
    const made = adminCreations([tenantWide, scoped], users);
    expect(made.roles.get('user-anna|role-1|')).toBe(tenantWide);
    expect(made.roles.get('user-anna|role-1|unit-1')).toBe(scoped);
  });

  it('records nothing for a member it cannot name', () => {
    const made = adminCreations([event('group.addMember', 'group-1', { login: 'nobody' })], users);
    expect(made.memberships.size).toBe(0);
  });
});
