import type { TenantClient } from '@syntra/db';
import { PERMISSIONS, type Permission } from './permissions.js';
import { createRole } from './rbac-service.js';

/**
 * The operational roles a pilot is staffed with, as permission bundles an
 * administrator creates on purpose rather than roles the product installs
 * for them. Each names the least the job needs; a tenant that wants more
 * edits the role afterwards, and the audit event says who did.
 *
 * `builtIn` stays false: a preset is a starting point, not a system role the
 * console refuses to change.
 */
export interface RolePreset {
  key: string;
  name: string;
  description: string;
  permissions: Permission[];
}

const READ_ONLY: Permission[] = [
  PERMISSIONS.DIRECTORY_READ,
  PERMISSIONS.IDENTITY_READ,
  PERMISSIONS.SYNC_READ,
  PERMISSIONS.ACCESS_READ,
  PERMISSIONS.POLICY_READ,
  PERMISSIONS.AUTOMATE_READ,
  PERMISSIONS.PROVISION_READ,
  PERMISSIONS.GOVERN_READ,
];

export const ROLE_PRESETS: readonly RolePreset[] = [
  {
    key: 'platform-operator',
    name: 'Platform operator',
    description:
      'Runs the installation: updates, tenant settings, incidents and the audit log. Does not change people or targets.',
    permissions: [
      PERMISSIONS.DEPLOYMENT_MANAGE,
      PERMISSIONS.TENANT_MANAGE,
      PERMISSIONS.AUDIT_READ,
      PERMISSIONS.SYNC_READ,
      PERMISSIONS.PROVISION_READ,
      PERMISSIONS.DIRECTORY_READ,
      PERMISSIONS.IDENTITY_READ,
    ],
  },
  {
    key: 'lifecycle-owner',
    name: 'Lifecycle owner',
    description:
      'Owns joiners, movers and leavers: creates people and contracts, blocks sign-in, runs and approves lifecycle operations, and reads the evidence.',
    permissions: [
      PERMISSIONS.IDENTITY_READ,
      PERMISSIONS.IDENTITY_WRITE,
      PERMISSIONS.DIRECTORY_READ,
      PERMISSIONS.DIRECTORY_WRITE,
      PERMISSIONS.PROVISION_READ,
      PERMISSIONS.PROVISION_MANAGE,
      PERMISSIONS.SYNC_READ,
      PERMISSIONS.ACCESS_READ,
      PERMISSIONS.AUDIT_READ,
    ],
  },
  {
    key: 'target-administrator',
    name: 'Target administrator',
    description:
      'Connects and configures target systems and sources, rotates their credentials, and reviews runs. Does not create people.',
    permissions: [
      PERMISSIONS.PROVISION_READ,
      PERMISSIONS.PROVISION_MANAGE,
      PERMISSIONS.SYNC_READ,
      PERMISSIONS.SYNC_MANAGE,
      PERMISSIONS.SECRETS_WRITE,
      PERMISSIONS.DIRECTORY_READ,
      PERMISSIONS.IDENTITY_READ,
      PERMISSIONS.AUDIT_READ,
    ],
  },
  {
    key: 'auditor',
    name: 'Auditor',
    description:
      'Reads everything, including the audit log and governance evidence, and can export it. Changes nothing.',
    permissions: [...READ_ONLY, PERMISSIONS.AUDIT_READ, PERMISSIONS.GOVERN_EXPORT],
  },
  {
    key: 'read-only-reviewer',
    name: 'Read-only reviewer',
    description: 'Sees people, access, targets and lifecycle work. Cannot read the audit log and changes nothing.',
    permissions: READ_ONLY,
  },
];

export function rolePreset(key: string): RolePreset | undefined {
  return ROLE_PRESETS.find((preset) => preset.key === key);
}

/** Creates the role the preset describes. Refuses if a role with that name already exists. */
export async function createRoleFromPreset(tx: TenantClient, key: string) {
  const preset = rolePreset(key);
  if (!preset) throw new Error(`unknown role preset: ${key}`);
  return createRole(tx, preset.name, preset.permissions, { description: preset.description });
}
