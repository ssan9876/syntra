import { withTenant } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import { validateNewPassword } from './password-policy.js';
import { hashPassword, setPasswordHash, verifyPassword } from './password.js';
import { revokeAllForUserExcept } from './session-service.js';
import { revokeAllRefreshTokensForUser } from './refresh-token.js';

export interface ChangeOwnPasswordInput {
  userId: string;
  /** Re-entered, never taken from the session. */
  currentPassword: string;
  newPassword: string;
  /** The session making the request. It survives; every other one does not. */
  sessionId: string;
  sourceIp: string | null;
  now?: Date | undefined;
}

/**
 * `upstream` carries the hint so the caller can say WHERE, rather than leaving
 * somebody to guess which of their systems owns the password.
 */
export type ChangeOwnPasswordOutcome =
  | { ok: true; otherSessionsRevoked: number }
  | { ok: false; reason: 'upstream'; hint: string | null }
  | { ok: false; reason: 'no_password' }
  | { ok: false; reason: 'wrong_password' }
  | { ok: false; reason: 'weak_password'; detail: string }
  | { ok: false; reason: 'unchanged' };

/**
 * Self-service password change, for somebody already signed in.
 *
 * Deliberately NOT the reset flow with a shortcut. A reset starts from an
 * unauthenticated stranger holding a mailbox link, so it spends a token,
 * demands a second factor and revokes everything. A change starts from a
 * person who is already authenticated and re-types the password they hold,
 * which is a different and stronger claim, and it should not cost them a trip
 * through their inbox.
 *
 * What the two share is the ending: the new hash, the revocation of everything
 * derived from the old password, and the audit record all commit together. A
 * password change whose old sessions outlive it is not a password change.
 *
 * No second factor is demanded here. The request already carries two
 * independent things — a live session and the current password — and an
 * attacker holding a stolen session still cannot pass the second. Requiring a
 * factor as well would mean a user who has enrolled one can never change their
 * password from a device that cannot present it, in exchange for a margin the
 * current-password check already covers.
 */
export async function changeOwnPassword(
  tenantId: string,
  input: ChangeOwnPasswordInput,
): Promise<ChangeOwnPasswordOutcome> {
  const now = input.now ?? new Date();

  const context = await withTenant(tenantId, async (tx) => {
    const user = await tx.user.findUnique({ where: { id: input.userId } });
    if (!user) return null;
    const credential = await tx.passwordCredential.findUnique({
      where: { userId: input.userId },
    });
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    return { user, credential, minLength: tenant.passwordMinLength };
  });

  // No user under this tenant for a session that resolved: the session is
  // being torn down elsewhere. Nothing useful to say, and nothing to change.
  if (!context) return { ok: false, reason: 'wrong_password' };

  // The schema is explicit that an upstream account's password lives with the
  // provider and self-service must send the user there. Writing a local hash
  // for one would produce a second, divergent password that authenticates
  // nowhere the user expects -- worse than refusing.
  if (context.user.passwordSource !== 'local') {
    return {
      ok: false,
      reason: 'upstream',
      hint: context.user.passwordSourceHint,
    };
  }

  // A passkey-only account has nothing to change. Letting them SET one from
  // here would be an enrolment, not a change, and enrolment has to answer a
  // different question: whoever holds the session would gain a password
  // without proving they knew one.
  if (!context.credential) return { ok: false, reason: 'no_password' };

  const correct = await verifyPassword(
    context.credential.hash,
    input.currentPassword,
  );
  if (!correct) {
    await withTenant(tenantId, (tx) =>
      recordEvent(tx, {
        actorUserId: context.user.id,
        action: 'auth.password_change_failed',
        targetType: 'User',
        targetId: context.user.id,
        outcome: 'failure',
        sourceIp: input.sourceIp,
        payload: { reason: 'wrong_password' },
      }),
    );
    return { ok: false, reason: 'wrong_password' };
  }

  const check = validateNewPassword(input.newPassword, {
    minLength: context.minLength,
    login: context.user.login,
    email: context.user.email,
  });
  if (!check.ok) return { ok: false, reason: 'weak_password', detail: check.reason };

  // Re-typing the same password reads as success and changes nothing, which
  // is the worst outcome for somebody changing it BECAUSE it was exposed.
  // Compared against the stored hash rather than the string, so it holds even
  // if the two differ in some way the hash does not.
  if (await verifyPassword(context.credential.hash, input.newPassword)) {
    return { ok: false, reason: 'unchanged' };
  }

  // Argon2id is deliberately expensive; it has no business inside Prisma's
  // 5000 ms interactive-transaction budget.
  const hash = await hashPassword(input.newPassword);

  const otherSessionsRevoked = await withTenant(tenantId, async (tx) => {
    await setPasswordHash(tx, context.user.id, hash);
    const revoked = await revokeAllForUserExcept(
      tx,
      context.user.id,
      input.sessionId,
    );
    // Refresh tokens are not sessions and do not survive: one outliving a
    // change would hand back exactly the access the change existed to end.
    await revokeAllRefreshTokensForUser(tx, context.user.id);
    await recordEvent(tx, {
      actorUserId: context.user.id,
      action: 'auth.password_changed',
      targetType: 'User',
      targetId: context.user.id,
      outcome: 'success',
      sourceIp: input.sourceIp,
      // The plaintext appears nowhere, and neither does the hash.
      payload: { at: now.toISOString(), otherSessionsRevoked: revoked },
    });
    return revoked;
  });

  return { ok: true, otherSessionsRevoked };
}
