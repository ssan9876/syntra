import type { TenantClient } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';
import { SYSTEM_ROLE_KEYS } from '../rbac/rbac-service.js';

/** An active account holding a role, with neither an authenticator app nor a security key. */
export interface AdminWithoutSecondFactor {
  userId: string;
  login: string;
  displayName: string;
  /** Holds the built-in Owner role tenant-wide. */
  owner: boolean;
}

/**
 * The sign-in checks the console's Overview shows. Each is the fact; the
 * console decides which ones fail and says so.
 */
export interface SignInSecurity {
  /** Ordered by login. Empty when every administrator has a second factor. */
  adminsWithoutSecondFactor: AdminWithoutSecondFactor[];
  /** The console demands a second factor: `adminMfaRequired` or `adminWebauthnRequired`. */
  adminMfaRequired: boolean;
  /** `lockoutThreshold` above zero. */
  lockoutEnabled: boolean;
  /** At least one break-glass account is designated. */
  breakGlassDesignated: boolean;
}

/**
 * Reads the tenant's sign-in posture: who can reach the console on a password
 * alone, and which of the tenant-wide controls are off.
 *
 * An administrator is anybody holding a role, scoped or not -- the same test
 * `isAdministrator` makes for elevation. Only active accounts count: a
 * disabled one cannot sign in. A TOTP enrolment counts once it is confirmed;
 * an unconfirmed one has never produced a code.
 */
export async function readSignInSecurity(tx: TenantClient): Promise<SignInSecurity> {
  const tenantId = await currentTenant(tx);
  const [tenant, assignments, breakGlass] = await Promise.all([
    tx.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { adminMfaRequired: true, adminWebauthnRequired: true, lockoutThreshold: true },
    }),
    tx.roleAssignment.findMany({
      select: { userId: true, scopeOrgUnitId: true, role: { select: { systemKey: true } } },
    }),
    tx.breakGlassAccount.count(),
  ]);

  const adminIds = [...new Set(assignments.map((a) => a.userId))];
  const owners = new Set(
    assignments
      .filter((a) => a.scopeOrgUnitId === null && a.role.systemKey === SYSTEM_ROLE_KEYS.OWNER)
      .map((a) => a.userId),
  );

  const [users, totp, webauthn] = adminIds.length === 0 ? [[], [], []] : await Promise.all([
    tx.user.findMany({
      where: { id: { in: adminIds }, status: 'active' },
      select: { id: true, login: true, displayName: true },
      orderBy: { login: 'asc' },
    }),
    tx.totpCredential.findMany({
      where: { userId: { in: adminIds }, confirmedAt: { not: null } },
      select: { userId: true },
    }),
    tx.webAuthnCredential.findMany({
      where: { userId: { in: adminIds } },
      select: { userId: true },
      distinct: ['userId'],
    }),
  ]);
  const enrolled = new Set([...totp, ...webauthn].map((row) => row.userId));
  const adminsWithoutSecondFactor = users
    .filter((u) => !enrolled.has(u.id))
    .map((u) => ({ userId: u.id, login: u.login, displayName: u.displayName, owner: owners.has(u.id) }));

  return {
    adminsWithoutSecondFactor,
    adminMfaRequired: tenant.adminMfaRequired || tenant.adminWebauthnRequired,
    lockoutEnabled: tenant.lockoutThreshold > 0,
    breakGlassDesignated: breakGlass > 0,
  };
}
