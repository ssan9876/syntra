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
  /**
   * Reading who holds what, and why.
   *
   * Run history, drift, exceptions and the person-access view. Separate from
   * `provision.manage` because reading who holds what in the finance system is
   * a reasonable thing to grant an auditor, and changing a threshold is not --
   * lowering one is functionally the same as approving everything it would
   * have caught. Deliberately not inherited from `identity.read` either:
   * somebody who may read the person register is not thereby entitled to see
   * every entitlement that person holds in every target system.
   */
  PROVISION_READ: 'provision.read',
  /** Every configuration mutation, every apply and every confirmation. */
  PROVISION_MANAGE: 'provision.manage',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: Permission[] = Object.values(PERMISSIONS);

export function isPermission(value: string): value is Permission {
  return (ALL_PERMISSIONS as string[]).includes(value);
}
