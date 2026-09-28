import { describe, expect, it } from 'vitest';
import { explainingSequence, gainExplanations, type GainLookups } from './gain-explain.js';

const lookups: GainLookups = {
  users: new Map([
    ['user-anna', { personId: 'person-anna', login: 'Anna.Novak' }],
    ['user-svc', { personId: null, login: 'svc-payments' }],
  ]),
  groupSystemIds: new Map([
    ['group-local', 'syntra'],
    ['group-synced', 'source-ad'],
  ]),
  provisionActions: new Map([
    ['action-create', { actionType: 'create_account', personId: 'person-anna', accountId: 'account-ad', entitlementId: null }],
    ['action-grant', { actionType: 'grant_entitlement', personId: 'person-anna', accountId: 'account-ad', entitlementId: 'ent-1' }],
    ['action-disable', { actionType: 'disable_account', personId: 'person-anna', accountId: 'account-ad', entitlementId: null }],
  ]),
  accounts: new Map([
    ['account-ad', { personId: 'person-anna', targetSystemId: 'target-ad', resourceId: 'guid-anna' }],
  ]),
};

const gain = (subjectKey: string, systemId: string, resourceKind: string, resourceId: string) => ({
  subjectKey,
  personId: subjectKey.startsWith('person:') ? subjectKey.slice('person:'.length) : null,
  systemId,
  resourceKind,
  resourceId,
});

const explain = (events: { action: string; targetId: string | null; payload: unknown }[]) =>
  gainExplanations(events.map((e, i) => ({ sequence: i + 1, ...e })), lookups);

describe('the gains Syntra made', () => {
  it('explains a new login by its user.create event', () => {
    const map = explain([{ action: 'user.create', targetId: 'user-anna', payload: { login: 'Anna.Novak' } }]);
    expect(explainingSequence(map, gain('person:person-anna', 'syntra', 'syntraUser', 'user-anna'))).toBe(1);
  });

  it('explains a login SCIM created', () => {
    const map = explain([{ action: 'scim.user_created', targetId: 'user-anna', payload: {} }]);
    expect(explainingSequence(map, gain('person:person-anna', 'syntra', 'syntraUser', 'user-anna'))).toBe(1);
  });

  it('explains an account Provision created, keyed by its anchor at its target', () => {
    const map = explain([
      { action: 'provision.action.result', targetId: 'action-create', payload: { actionType: 'create_account', status: 'applied' } },
    ]);
    expect(explainingSequence(map, gain('person:person-anna', 'target-ad', 'targetAccount', 'guid-anna'))).toBe(1);
    // The same person and key at another target is a different account.
    expect(explainingSequence(map, gain('person:person-anna', 'target-snipe', 'targetAccount', 'guid-anna'))).toBeUndefined();
  });

  it('explains an entitlement Provision granted', () => {
    const map = explain([
      { action: 'provision.action.result', targetId: 'action-grant', payload: { actionType: 'grant_entitlement', status: 'applied' } },
    ]);
    expect(explainingSequence(map, gain('person:person-anna', 'target-ad', 'targetEntitlement', 'ent-1'))).toBe(1);
  });

  it('does not explain from a create that did not apply, or from another action type', () => {
    const map = explain([
      { action: 'provision.action.result', targetId: 'action-create', payload: { actionType: 'create_account', status: 'failed' } },
      { action: 'provision.action.result', targetId: 'action-disable', payload: { actionType: 'disable_account', status: 'applied' } },
    ]);
    expect(map.size).toBe(0);
  });

  it('explains a role assigned to a login, resolved to its person', () => {
    const map = explain([{ action: 'rbac.role_assigned', targetId: 'user-anna', payload: { roleId: 'role-auditor' } }]);
    expect(explainingSequence(map, gain('person:person-anna', 'syntra', 'syntraRole', 'role-auditor'))).toBe(1);
  });

  it('explains a role assigned to a login with no person, under its account subject', () => {
    const map = explain([{ action: 'rbac.role_assigned', targetId: 'user-svc', payload: { roleId: 'role-owner' } }]);
    expect(explainingSequence(map, gain('account:syntra:user-svc', 'syntra', 'syntraRole', 'role-owner'))).toBe(1);
  });

  it('explains a membership named by login, case-insensitively, at the group’s own system', () => {
    const map = explain([
      { action: 'group.addMember', targetId: 'group-local', payload: { group: 'Finance', login: 'anna.novak' } },
      { action: 'group.addMember', targetId: 'group-synced', payload: { group: 'AD', userId: 'user-anna' } },
    ]);
    expect(explainingSequence(map, gain('person:person-anna', 'syntra', 'syntraGroup', 'group-local'))).toBe(1);
    expect(explainingSequence(map, gain('person:person-anna', 'source-ad', 'syntraGroup', 'group-synced'))).toBe(2);
  });

  it('explains a direct application assignment to a user', () => {
    const map = explain([
      { action: 'application.assign', targetId: 'app-1', payload: { subjectType: 'user', subjectId: 'user-anna' } },
      { action: 'application.assign', targetId: 'app-2', payload: { subjectType: 'group', subjectId: 'group-local' } },
    ]);
    expect(explainingSequence(map, gain('person:person-anna', 'syntra', 'application', 'app-1'))).toBe(1);
    expect(map.size).toBe(1);
  });

  it('still matches the payload-keyed events on person and resource', () => {
    const map = explain([
      { action: 'automate.grant.create', targetId: 'grant-1', payload: { subjectPersonId: 'person-anna', resourceId: 'ent-9' } },
    ]);
    expect(explainingSequence(map, gain('person:person-anna', 'target-ad', 'targetEntitlement', 'ent-9'))).toBe(1);
  });
});

describe('the gains Syntra did not make', () => {
  it('leaves a login nobody recorded creating unexplained', () => {
    const map = explain([{ action: 'user.create', targetId: 'user-other', payload: {} }]);
    expect(explainingSequence(map, gain('person:person-anna', 'syntra', 'syntraUser', 'user-anna'))).toBeUndefined();
  });

  it('does not let a role event for one role explain another', () => {
    const map = explain([{ action: 'rbac.role_assigned', targetId: 'user-anna', payload: { roleId: 'role-auditor' } }]);
    expect(explainingSequence(map, gain('person:person-anna', 'syntra', 'syntraRole', 'role-owner'))).toBeUndefined();
  });

  it('leaves an account at a target Provision never created unexplained', () => {
    const map = explain([]);
    expect(explainingSequence(map, gain('person:person-anna', 'target-ad', 'targetAccount', 'guid-anna'))).toBeUndefined();
  });

  it('keeps the latest event when two explain the same holding', () => {
    const map = explain([
      { action: 'group.addMember', targetId: 'group-local', payload: { userId: 'user-anna' } },
      { action: 'group.addMember', targetId: 'group-local', payload: { userId: 'user-anna' } },
    ]);
    expect(explainingSequence(map, gain('person:person-anna', 'syntra', 'syntraGroup', 'group-local'))).toBe(2);
  });
});
