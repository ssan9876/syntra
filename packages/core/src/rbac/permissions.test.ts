import { describe, expect, it } from 'vitest';
import {
  ALL_PERMISSIONS,
  OWNER_PERMISSIONS,
  PERMISSIONS,
  RESTRICTED_PERMISSIONS,
  isRestrictedPermission,
} from './permissions.js';
import { ROLE_PRESETS } from './presets.js';
import { DATA_DELETION_ROLE, RoleRefusedError, assertRolePermissionChange } from './rbac-service.js';
import { NOTIFIABLE_PRIVILEGED_PERMISSIONS } from '../notify/security-policy.js';
import { PRIVILEGED_PERMISSIONS } from '../privileged/change-control.js';

/** No database: the catalogue and the rules that need no rows. */
describe('restricted permissions', () => {
  it('person.purge is in the catalogue and restricted', () => {
    expect(ALL_PERMISSIONS).toContain(PERMISSIONS.PERSON_PURGE);
    expect(isRestrictedPermission(PERMISSIONS.PERSON_PURGE)).toBe(true);
  });

  it('Owner holds everything but the restricted permissions', () => {
    expect(OWNER_PERMISSIONS).not.toContain(PERMISSIONS.PERSON_PURGE);
    expect(OWNER_PERMISSIONS.length).toBe(ALL_PERMISSIONS.length - RESTRICTED_PERMISSIONS.length);
  });

  it('no preset carries a restricted permission', () => {
    for (const preset of ROLE_PRESETS) {
      expect(preset.permissions.filter(isRestrictedPermission), preset.key).toEqual([]);
    }
  });

  it('the Data deletion role carries person.purge and nothing else', () => {
    expect(DATA_DELETION_ROLE.permissions).toEqual([PERMISSIONS.PERSON_PURGE]);
  });

  it('granting it is privileged, and worth a notification', () => {
    expect(PRIVILEGED_PERMISSIONS).toContain(PERMISSIONS.PERSON_PURGE);
    expect(NOTIFIABLE_PRIVILEGED_PERMISSIONS).toContain(PERMISSIONS.PERSON_PURGE);
  });
});

describe('assertRolePermissionChange', () => {
  const custom = { name: 'Helpdesk', systemKey: null, permissions: ['directory.read'] };
  const dataDeletion = { name: 'Data deletion', systemKey: 'data-deletion', permissions: ['person.purge'] };

  const code = (fn: () => unknown) => {
    try {
      fn();
      return null;
    } catch (cause) {
      return cause instanceof RoleRefusedError ? cause.code : 'other';
    }
  };

  it('refuses person.purge on any other role, the Owner included', () => {
    expect(code(() => assertRolePermissionChange(custom, ['directory.read', 'person.purge']))).toBe(
      'restricted-permission',
    );
    expect(
      code(() => assertRolePermissionChange({ ...custom, name: 'Owner', systemKey: 'owner' }, [...ALL_PERMISSIONS])),
    ).toBe('restricted-permission');
  });

  it('refuses any change to the Data deletion role, and allows the same set back', () => {
    expect(code(() => assertRolePermissionChange(dataDeletion, ['person.purge', 'rbac.manage']))).toBe(
      'system-role-permissions',
    );
    expect(code(() => assertRolePermissionChange(dataDeletion, []))).toBe('system-role-permissions');
    expect(code(() => assertRolePermissionChange(dataDeletion, ['person.purge']))).toBeNull();
  });

  it('allows an ordinary change to an ordinary role', () => {
    expect(code(() => assertRolePermissionChange(custom, [...OWNER_PERMISSIONS]))).toBeNull();
  });
});
