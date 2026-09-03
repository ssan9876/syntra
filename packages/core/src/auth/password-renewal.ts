import { withTenant } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import { validateNewPassword } from './password-policy.js';
import { passwordWasUsedBefore } from './password-ageing.js';
import { hashPassword, setPasswordHash, verifyPassword } from './password.js';
import { findAttempt } from './attempt-service.js';
import { endSessions } from './end-sessions.js';

export interface RenewExpiredPasswordInput {
  attemptToken: string;
  newPassword: string;
  sourceIp: string | null;
  now?: Date | undefined;
}

export type RenewOutcome =
  | { ok: true; userId: string }
  | { ok: false; reason: 'attempt_invalid' }
  | { ok: false; reason: 'user_inactive' }
  | { ok: false; reason: 'weak_password'; detail: string }
  | { ok: false; reason: 'unchanged' }
  | { ok: false; reason: 'reused'; depth: number };

/**
 * Sets a new password for somebody whose old one expired mid-sign-in.
 *
 * The current password is NOT re-entered, and that is deliberate rather than
 * an omission: the renew attempt exists only because `authorize()` already
 * accepted it and satisfied whatever factor the policy asked for. Asking again
 * would be friction bought with nothing — the same reasoning
 * `completePasswordReset` applies to a reset token.
 *
 * The attempt is deliberately NOT consumed here. It is spent by the
 * `kind: 'renewed'` call to `authorize()` that follows, so the sign-in is
 * re-decided against live policy rather than against what was true when the
 * password expired. Consuming it here would leave the caller holding a fresh
 * password and no way to finish signing in.
 */
export async function renewExpiredPassword(
  tenantId: string,
  input: RenewExpiredPasswordInput,
): Promise<RenewOutcome> {
  const now = input.now ?? new Date();

  const context = await withTenant(tenantId, async (tx) => {
    const attempt = await findAttempt(tx, input.attemptToken, now);
    if (!attempt || attempt.purpose !== 'renew') return null;

    const user = await tx.user.findUnique({ where: { id: attempt.userId } });
    if (!user) return null;

    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const credential = await tx.passwordCredential.findUnique({
      where: { userId: user.id },
    });
    return { user, tenant, credential };
  });

  if (!context) return { ok: false, reason: 'attempt_invalid' };
  if (context.user.status !== 'active') {
    return { ok: false, reason: 'user_inactive' };
  }

  const check = validateNewPassword(input.newPassword, {
    minLength: context.tenant.passwordMinLength,
    login: context.user.login,
    email: context.user.email,
  });
  if (!check.ok) return { ok: false, reason: 'weak_password', detail: check.reason };

  // Re-typing the expired password would otherwise "succeed" and leave it
  // expired, so the next sign-in asks again — an unbreakable loop for anybody
  // who did not read the screen carefully.
  if (
    context.credential &&
    (await verifyPassword(context.credential.hash, input.newPassword))
  ) {
    return { ok: false, reason: 'unchanged' };
  }

  const depth = context.tenant.passwordHistoryDepth;
  const reused = await withTenant(tenantId, (tx) =>
    passwordWasUsedBefore(tx, context.user.id, input.newPassword, {
      passwordMaxAgeDays: 0,
      passwordHistoryDepth: depth,
    }),
  );
  if (reused) return { ok: false, reason: 'reused', depth };

  // Argon2id outside every transaction, for the reason `authenticate` gives.
  const hash = await hashPassword(input.newPassword);

  await withTenant(tenantId, async (tx) => {
    await setPasswordHash(tx, context.user.id, hash, { now });
    // Every other session goes, exactly as a reset does. A password that had
    // to be changed is one whose old value should stop being useful anywhere,
    // and the sign-in in progress has no session yet to preserve.
    await endSessions(tx, context.user.id, {
      trigger: 'password_change',
      actorUserId: context.user.id,
    });
    await recordEvent(tx, {
      actorUserId: context.user.id,
      action: 'auth.password_renewed',
      targetType: 'User',
      targetId: context.user.id,
      outcome: 'success',
      sourceIp: input.sourceIp,
      payload: { reason: 'expired' },
    });
  });

  return { ok: true, userId: context.user.id };
}
