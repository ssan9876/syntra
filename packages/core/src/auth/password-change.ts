import { ldapWriteback } from '@syntra/connectors';
import { withTenant } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import { sourceWithPassword } from '../sync/source-service.js';
import type { MasterKeyProvider } from '../vault/master-key.js';
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
  | { ok: false; reason: 'unchanged' }
  /** The DIRECTORY refused the new password: its complexity, history or age. */
  | { ok: false; reason: 'directory_policy' }
  /** The directory could not be reached, or refused the change outright. */
  | { ok: false; reason: 'directory_unavailable' };

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
  provider: MasterKeyProvider,
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
    const source =
      user.sourceId === null
        ? null
        : await tx.directorySource.findUnique({
            where: { id: user.sourceId },
            select: { id: true, writebackEnabled: true, writebackPassword: true },
          });
    return {
      user,
      credential,
      minLength: tenant.passwordMinLength,
      // The source owns this password only if somebody deliberately said so.
      // Off, the change stays local and behaves exactly as it did before.
      writesPassword: Boolean(source?.writebackEnabled && source.writebackPassword),
      sourceId: source?.id ?? null,
    };
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

  const auditFailure = (reason: string) =>
    withTenant(tenantId, (tx) =>
      recordEvent(tx, {
        actorUserId: context.user.id,
        action: 'auth.password_change_failed',
        targetType: 'User',
        targetId: context.user.id,
        outcome: 'failure',
        sourceIp: input.sourceIp,
        payload: { reason },
      }),
    );

  const commit = async (): Promise<number> => {
    // Argon2id is deliberately expensive; it has no business inside Prisma's
    // 5000 ms interactive-transaction budget.
    const hash = await hashPassword(input.newPassword);
    return withTenant(tenantId, async (tx) => {
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
        payload: {
          at: now.toISOString(),
          otherSessionsRevoked: revoked,
          viaDirectory: context.writesPassword,
        },
      });
      return revoked;
    });
  };

  /**
   * The account's password lives in the directory, so the directory decides.
   *
   * The local hash is NOT checked on this path, and that is the point. Syntra's
   * hash and the domain's password can already have diverged -- the lab sat in
   * exactly that state -- and verifying locally would accept a password the
   * domain rejects and reject one it accepts. The directory verifies the
   * current password by bind, applies its own complexity, history and minimum
   * age, and its answer is the answer.
   *
   * The directory is written FIRST. If it refuses, nothing has changed
   * anywhere. If it accepts and the local write then fails, the two diverge --
   * but they diverge with the DIRECTORY holding the password the user just
   * chose and expects, which is the recoverable direction and the one that
   * makes their Windows login work at eight the next morning. The other
   * ordering leaves Syntra accepting a password the domain refuses, and the
   * support call that follows has no visible cause.
   */
  if (context.writesPassword) {
    // Checked before the round trip: a local rejection is free, and it spends
    // neither a request nor an attempt against the domain's lockout counter.
    const policy = validateNewPassword(input.newPassword, {
      minLength: context.minLength,
      login: context.user.login,
      email: context.user.email,
    });
    if (!policy.ok) {
      return { ok: false, reason: 'weak_password', detail: policy.reason };
    }

    const config = await withTenant(tenantId, (tx) =>
      sourceWithPassword(tx, provider, context.sourceId!),
    );
    if (config === null) {
      await auditFailure('directory_no_credential');
      return { ok: false, reason: 'directory_unavailable' };
    }

    const written = await ldapWriteback.changePassword(config, {
      anchor: context.user.sourceAnchor ?? '',
      currentPassword: input.currentPassword,
      newPassword: input.newPassword,
    });

    if (!written.ok) {
      await auditFailure(`directory_${written.failure ?? 'transient'}`);
      switch (written.failure) {
        case 'wrong_password':
          // Counts against the domain's own lockout policy, and should. A
          // portal that let somebody grind a domain password without ever
          // tripping lockout would be a hole, not a convenience.
          return { ok: false, reason: 'wrong_password' };
        case 'policy':
          return { ok: false, reason: 'directory_policy' };
        default:
          // Never a quiet fall back to a local-only change: that is precisely
          // the divergence this path exists to remove, and it would be
          // invisible to the person doing it.
          return { ok: false, reason: 'directory_unavailable' };
      }
    }

    // The directory has the new password. Syntra's hash follows so the portal
    // keeps working with the same string the workstation now wants.
    return { ok: true, otherSessionsRevoked: await commit() };
  }

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

  return { ok: true, otherSessionsRevoked: await commit() };
}
