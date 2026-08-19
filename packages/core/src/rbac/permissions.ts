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
   * The request queue, the catalog as an administrator sees it, the grants and
   * the sweeps.
   */
  AUTOMATE_READ: 'automate.read',
  /**
   * Creating and editing products, workflows, resource owners and delegations;
   * confirming a sweep; deciding a `blocked_no_approver` request.
   */
  AUTOMATE_MANAGE: 'automate.manage',
  /** Submitting for somebody who is neither you nor your report. */
  AUTOMATE_REQUEST_ON_BEHALF: 'automate.request_on_behalf',
  /*
   * There is deliberately no `automate.approve`. Approval authority comes from
   * RESOLUTION -- being the manager, the owner, the named person, a delegate --
   * and never from a permission. A permission that conferred it would be a
   * tenant-wide right to approve anything, held by whoever holds the admin
   * role, which is the opposite of what an approval chain is for.
   *
   * Requesting for YOURSELF needs no permission either. Every portal user may
   * open the catalog; what they see there is the audience decision. A
   * permission in front of it would make an unconfigured tenant's catalog
   * empty for a second, unrelated reason, and nobody would know which.
   */
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
  /** Snapshots, reports, findings, campaigns, violations. SCOPEABLE to an org unit. */
  GOVERN_READ: 'govern.read',
  /**
   * Build snapshots, create and close campaigns, confirm a revocation batch,
   * define functions and rules, assign findings, change a setting.
   */
  GOVERN_MANAGE: 'govern.manage',
  /**
   * Approve an SoD exception where its rule names no workflow. DELIBERATELY
   * distinct from `govern.manage`: administering the governance module and
   * accepting the organization's risk are different jobs, and a product that
   * conflates them hands risk acceptance to whoever configures the software.
   */
  GOVERN_ACCEPT_RISK: 'govern.accept_risk',
  /**
   * Produce a CSV or an evidence bundle. Distinct from `govern.read` because
   * reading a screen and walking out with a file are different acts with
   * different consequences, and only one of them is a copy.
   */
  GOVERN_EXPORT: 'govern.export',
  /*
   * There is deliberately no `govern.review`. Review authority comes from
   * resolution, as approval authority does in Automate. A tenant-wide "may
   * certify anything" permission is not a thing anybody should hold.
   */
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: Permission[] = Object.values(PERMISSIONS);

export function isPermission(value: string): value is Permission {
  return (ALL_PERMISSIONS as string[]).includes(value);
}
