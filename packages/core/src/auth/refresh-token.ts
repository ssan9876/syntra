import type { TenantClient } from '@syntra/db';
import { revokeArtifactsForUser } from '../access/oidc-store.js';

/**
 * Revokes every live refresh token for a user, wherever it lives.
 *
 * Two stores, because there are two issuers. Access I's `RefreshToken` table
 * is Syntra's own and is currently empty; the OIDC provider added in Access II
 * keeps its refresh tokens — and the grants, sessions and access tokens they
 * hang off — in `OidcArtifact`. Both are refresh tokens as far as spec section
 * 9.4 point 4 is concerned, and the version of this function that revoked only
 * the empty one satisfied the letter of every caller and none of the point:
 * a phished password already exchanged for a refresh token survived the reset
 * for fourteen days, rotating on each use, with token revocation documented as
 * non-functional and account deactivation the only remedy.
 *
 * Callers hold the transaction. A reset that changed the password and then
 * failed to revoke is worse than either half on its own.
 */
export async function revokeAllRefreshTokensForUser(
  tx: TenantClient,
  userId: string,
): Promise<void> {
  await tx.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  await revokeArtifactsForUser(tx, userId);
}
