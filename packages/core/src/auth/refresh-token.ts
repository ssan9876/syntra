import type { TenantClient } from '@syntra/db';

/**
 * Revokes every live refresh token for a user.
 *
 * Access I issues none — the OIDC provider in Access II does. It exists here
 * because a password reset must invalidate every credential derived from the
 * old password, and "we will remember to add refresh tokens to that list later"
 * is how a revoked session ends up still refreshable.
 */
export async function revokeAllRefreshTokensForUser(
  tx: TenantClient,
  userId: string,
): Promise<void> {
  await tx.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
