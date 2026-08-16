import { withTenant } from '@syntra/db';

/**
 * How long an authorization code lives, and therefore how long the decision
 * behind it lives.
 *
 * One constant with two consumers — `provider-factory.ts` passes it as
 * `ttl.AuthorizationCode`, and this module uses it as the decision's lifetime
 * — because if the decision outlived the code there would be a window in
 * which a code obtained some other way could spend a decision left over from a
 * legitimate authorization that was never exchanged. Making them one value
 * makes that window exactly zero rather than "small".
 */
export const AUTHORIZATION_CODE_TTL_SECONDS = 120;

/**
 * Records that `authorize()` returned an allow for this user and this client.
 *
 * Written by the OIDC interaction route and by nothing else, immediately after
 * the chokepoint allows and immediately before the interaction is resolved.
 * The token endpoint requires and spends one; see `consumeAuthorizationDecision`.
 */
export async function recordAuthorizationDecision(
  tenantId: string,
  input: {
    userId: string;
    clientId: string;
    interactionUid: string;
    satisfiedFactor: string | null;
  },
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx.authorizationDecision.create({
      data: {
        tenantId,
        userId: input.userId,
        clientId: input.clientId,
        interactionUid: input.interactionUid,
        satisfiedFactor: input.satisfiedFactor,
        expiresAt: new Date(Date.now() + AUTHORIZATION_CODE_TTL_SECONDS * 1000),
      },
    });
  });
}

/**
 * Spends one live decision for this user and client. False if there is none.
 *
 * Single-use, decided by the `updateMany` count rather than by a read followed
 * by a write, so two concurrent exchanges cannot both spend one decision.
 *
 * Two concurrent authorizations for the same user and client produce two
 * decisions and two codes, and the two exchanges take one each — they are
 * interchangeable, so which exchange gets which row does not matter.
 */
export async function consumeAuthorizationDecision(
  tenantId: string,
  userId: string,
  clientId: string,
  now: Date = new Date(),
): Promise<boolean> {
  return withTenant(tenantId, async (tx) => {
    const candidate = await tx.authorizationDecision.findFirst({
      where: { userId, clientId, consumedAt: null, expiresAt: { gt: now } },
      orderBy: { createdAt: 'asc' },
    });
    if (!candidate) return false;
    const claimed = await tx.authorizationDecision.updateMany({
      where: { id: candidate.id, consumedAt: null },
      data: { consumedAt: now },
    });
    return claimed.count === 1;
  });
}
