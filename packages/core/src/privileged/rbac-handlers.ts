import type { TenantClient } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import { issueApiToken } from '../auth/api-token-service.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { RoleRefusedError, assignRole, countHoldersOf, updateRole } from '../rbac/rbac-service.js';
import { privilegedPermissionsIn, revisionOf, type PrivilegedChangeHandler } from './change-control.js';

/**
 * The change classes whose proposals core can apply on its own: privileged
 * role grants and admin-scoped machine tokens. Each apply performs the write
 * and the audit event the direct route would, plus the id of the change
 * request that authorised it.
 */

export const ROLE_ASSIGN_OPERATION = 'rbac.role_assign';
export const ROLE_UPDATE_OPERATION = 'rbac.role_update';
export const TOKEN_ISSUE_OPERATION = 'api_token.issue';

export interface RoleAssignProposal { roleId: string; userId: string; scopeOrgUnitId: string | null }
export interface RoleUpdateProposal {
  roleId: string;
  patch: { name?: string | undefined; description?: string | null | undefined; permissions?: string[] | undefined };
}
export interface TokenIssueProposal { userId: string; name: string; scopes: string[]; expiresAt: string | null }

/** The role a grant would confer, the account receiving it, and what it already holds of that role. */
export async function roleAssignRevision(tx: TenantClient, proposed: RoleAssignProposal): Promise<string> {
  const role = await tx.role.findUnique({ where: { id: proposed.roleId }, select: { id: true, name: true, permissions: true } });
  const user = await tx.user.findUnique({ where: { id: proposed.userId }, select: { id: true, status: true } });
  const held = await tx.roleAssignment.findMany({
    where: { roleId: proposed.roleId, userId: proposed.userId },
    select: { scopeOrgUnitId: true },
  });
  return revisionOf({
    role: role ? { ...role, permissions: [...role.permissions].sort() } : null,
    user,
    held: held.map((row) => row.scopeOrgUnitId ?? '').sort(),
  });
}

export async function roleUpdateRevision(tx: TenantClient, proposed: RoleUpdateProposal): Promise<string> {
  const role = await tx.role.findUnique({
    where: { id: proposed.roleId },
    select: { id: true, name: true, description: true, permissions: true },
  });
  return revisionOf(role ? { ...role, permissions: [...role.permissions].sort() } : null);
}

/**
 * The account a token would act as, and every role it holds -- a token's
 * authority is its scopes intersected with these, so a grant or revocation on
 * the account since the request changes what was reviewed.
 */
export async function tokenIssueRevision(tx: TenantClient, proposed: TokenIssueProposal): Promise<string> {
  const user = await tx.user.findUnique({ where: { id: proposed.userId }, select: { id: true, status: true } });
  const assignments = await tx.roleAssignment.findMany({
    where: { userId: proposed.userId },
    include: { role: { select: { permissions: true } } },
  });
  return revisionOf({
    user,
    roles: assignments
      .map((row) => ({ roleId: row.roleId, scope: row.scopeOrgUnitId ?? '', permissions: [...row.role.permissions].sort() }))
      .sort((a, b) => `${a.roleId}/${a.scope}`.localeCompare(`${b.roleId}/${b.scope}`)),
  });
}

/** Whether granting this role is privileged: it carries a privileged permission. */
export async function roleIsPrivileged(tx: TenantClient, roleId: string): Promise<boolean> {
  const role = await tx.role.findUnique({ where: { id: roleId }, select: { permissions: true } });
  return role !== null && privilegedPermissionsIn(role.permissions).length > 0;
}

/**
 * Whether a token with these scopes, for this account, could exercise a
 * privileged permission. An empty scope list means the account's full
 * authority, so it is privileged whenever the account is.
 */
export async function tokenIsAdminScoped(tx: TenantClient, userId: string, scopes: readonly string[]): Promise<boolean> {
  if (scopes.length > 0) return privilegedPermissionsIn(scopes).length > 0;
  const assignments = await tx.roleAssignment.findMany({ where: { userId }, include: { role: { select: { permissions: true } } } });
  return assignments.some((row) => privilegedPermissionsIn(row.role.permissions).length > 0);
}

const guardRbac = async (tx: TenantClient) => {
  if ((await countHoldersOf(tx, PERMISSIONS.RBAC_MANAGE)) > 0) return;
  throw new RoleRefusedError(
    'would-strand-rbac',
    'That would leave nobody able to administer roles, and there is no way back from it but a database client. Give somebody else rbac.manage first.',
  );
};

export const roleAssignHandler: PrivilegedChangeHandler = {
  operation: ROLE_ASSIGN_OPERATION,
  changeClass: 'role_grant',
  revision: (tx, proposed) => roleAssignRevision(tx, proposed as RoleAssignProposal),
  async apply(tx, raw, context) {
    const proposed = raw as RoleAssignProposal;
    await assignRole(tx, proposed.userId, proposed.roleId, proposed.scopeOrgUnitId ?? undefined);
    await recordEvent(tx, {
      actorUserId: context.actorUserId,
      action: 'rbac.role_assigned',
      targetType: 'User',
      targetId: proposed.userId,
      outcome: 'success',
      sourceIp: context.sourceIp,
      payload: { roleId: proposed.roleId, scopeOrgUnitId: proposed.scopeOrgUnitId, changeRequestId: context.requestId },
    });
    return { roleId: proposed.roleId, userId: proposed.userId };
  },
  record: (result) => result as Record<string, unknown>,
};

export const roleUpdateHandler: PrivilegedChangeHandler = {
  operation: ROLE_UPDATE_OPERATION,
  changeClass: 'role_grant',
  revision: (tx, proposed) => roleUpdateRevision(tx, proposed as RoleUpdateProposal),
  async apply(tx, raw, context) {
    const proposed = raw as RoleUpdateProposal;
    await updateRole(tx, proposed.roleId, proposed.patch);
    await guardRbac(tx);
    await recordEvent(tx, {
      actorUserId: context.actorUserId,
      action: 'rbac.role_updated',
      targetType: 'Role',
      targetId: proposed.roleId,
      outcome: 'success',
      sourceIp: context.sourceIp,
      payload: { changed: Object.keys(proposed.patch), ...proposed.patch, changeRequestId: context.requestId },
    });
    return { roleId: proposed.roleId };
  },
  record: (result) => result as Record<string, unknown>,
};

/**
 * Minting the token under approval. The plaintext is returned to the
 * APPROVER, once, exactly as the direct route returns it to its caller; it is
 * never written to the request.
 */
export const tokenIssueHandler: PrivilegedChangeHandler = {
  operation: TOKEN_ISSUE_OPERATION,
  changeClass: 'admin_token',
  revision: (tx, proposed) => tokenIssueRevision(tx, proposed as TokenIssueProposal),
  async apply(tx, raw, context) {
    const proposed = raw as TokenIssueProposal;
    const issued = await issueApiToken(tx, {
      userId: proposed.userId,
      name: proposed.name,
      scopes: proposed.scopes,
      expiresAt: proposed.expiresAt === null ? null : new Date(proposed.expiresAt),
      createdBy: context.actorUserId,
    });
    await recordEvent(tx, {
      actorUserId: context.actorUserId,
      action: 'api_token.issued',
      targetType: 'User',
      targetId: proposed.userId,
      outcome: 'success',
      sourceIp: context.sourceIp,
      payload: {
        tokenId: issued.id, name: proposed.name, scopes: proposed.scopes, expiresAt: proposed.expiresAt,
        changeRequestId: context.requestId,
      },
    });
    return { id: issued.id, token: issued.token, expiresAt: issued.expiresAt?.toISOString() ?? null };
  },
  record: (result) => ({ tokenId: (result as { id: string }).id }),
};
