/**
 * The closed catalogue of permissions. Stored as a string array on Role rather
 * than a join table: these are code-defined constants, not user data, so a
 * join table would cost a query without buying any integrity.
 */
export const PERMISSIONS = {
  DIRECTORY_READ: 'directory.read',
  DIRECTORY_WRITE: 'directory.write',
  IDENTITY_READ: 'identity.read',
  IDENTITY_WRITE: 'identity.write',
  AUDIT_READ: 'audit.read',
  SECRETS_WRITE: 'secrets.write',
  RBAC_MANAGE: 'rbac.manage',
  TENANT_MANAGE: 'tenant.manage',
  SYNC_READ: 'sync.read',
  SYNC_MANAGE: 'sync.manage',
  ACCESS_READ: 'access.read',
  ACCESS_MANAGE: 'access.manage',
  POLICY_READ: 'policy.read',
  POLICY_MANAGE: 'policy.manage',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: Permission[] = Object.values(PERMISSIONS);

export function isPermission(value: string): value is Permission {
  return (ALL_PERMISSIONS as string[]).includes(value);
}
