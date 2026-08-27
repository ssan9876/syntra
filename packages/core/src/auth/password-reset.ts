import { createHash, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { withTenant, type TenantClient } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import { queueMessage } from '../notify/delivery.js';
import { renderMessage, type Transport } from '../notify/notification-service.js';
import { currentTenant } from '../tenant-context.js';
import { hashPassword, setPasswordHash } from './password.js';
import { passwordWasUsedBefore } from './password-ageing.js';
import { validateNewPassword } from './password-policy.js';
import { revokeAllForUser } from './session-service.js';
import { revokeAllRefreshTokensForUser } from './refresh-token.js';
import { enrolledFactorTypes, hasRecoveryCodes, verifyFactor } from './mfa/registry.js';
import type { RelyingParty } from './mfa/relying-party.js';
import type { FactorPresentation } from './mfa/types.js';

export const RESET_TOKEN_LIFETIME_MS = 30 * 60 * 1000;

/**
 * The floor every reset request is padded out to.
 *
 * Section 11 of the spec asks for a uniform response *and timing*, and the
 * body alone does not give it. The unknown-login branch does one read and one
 * audit write; the known-local branch also consumes any previous token, writes
 * a new one and renders a message. That difference is small, but it is
 * systematic and an attacker gets to average over as many samples as they
 * like, which is exactly how an account-existence oracle is built. The mail
 * itself is queued rather than awaited, so the unbounded part — an SMTP round
 * trip that happens in one branch and not the others — is off the measured
 * path entirely.
 *
 * A floor, not a ceiling: database work that overruns it is still visible. The
 * same is true of the dummy Argon2 verification in `authenticate()`, which is
 * the house precedent this follows.
 */
export const RESET_REQUEST_FLOOR_MS = 250;

/**
 * How long an admin-minted setup link lives.
 *
 * Deliberately not `RESET_TOKEN_LIFETIME_MS`. The two flows have genuinely
 * different shapes: a reset is requested by somebody sitting at the form and
 * used within minutes, while a setup link is routed to a joiner through a
 * manager, a ticket or a first-day handover. Thirty minutes turns onboarding
 * into a support call; a day bounds a leaked link without making the common
 * case fail.
 */
export const SETUP_TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000;

const hashToken = (token: string) =>
  createHash('sha256').update(token).digest('hex');

export interface RequestResetInput {
  login: string;
  sourceIp: string | null;
  now?: Date | undefined;
  /**
   * Overrides `RESET_REQUEST_FLOOR_MS`. Tests that are not about timing set it
   * low so the suite does not spend a quarter of a second per case; nothing in
   * the application passes it.
   */
  floorMs?: number | undefined;
}

/**
 * Step 1 and 2 of spec section 9.
 *
 * Always resolves, and always the same way. The caller's HTTP response does not
 * depend on whether the account exists, whether it is active, or whether its
 * password is held here at all — every one of those distinctions would turn the
 * form into an account-existence oracle. What actually happened goes to the
 * audit log and, for a real user, to their inbox.
 *
 * That includes the upstream-managed user, who is told by mail rather than by a
 * different status code: "your password lives at Entra ID" in the browser
 * announces both that the account exists and that it is federated, to anyone
 * who can type a login name into the form.
 *
 * No SMTP happens inside a transaction. `withTenant` is `prisma.$transaction`,
 * whose default timeout is 5000 ms; a mail server that takes six seconds to
 * answer would abort the transaction and roll back the token that was just
 * written, leaving the user holding a link that does not work.
 */
export async function requestPasswordReset(
  tenantId: string,
  transport: Transport,
  publicUrl: string,
  input: RequestResetInput,
): Promise<void> {
  const startedAt = performance.now();
  const floorMs = input.floorMs ?? RESET_REQUEST_FLOOR_MS;
  try {
    await attemptPasswordReset(tenantId, transport, publicUrl, input);
  } finally {
    // In a `finally`, so an unexpected fault takes the same time as a success.
    const remaining = floorMs - (performance.now() - startedAt);
    if (remaining > 0) await sleep(remaining);
  }
}

async function attemptPasswordReset(
  tenantId: string,
  transport: Transport,
  publicUrl: string,
  input: RequestResetInput,
): Promise<void> {
  const now = input.now ?? new Date();
  const needle = input.login.trim();

  // One read, two facts. The tenant name is needed to render either message,
  // and pulling it out here is what lets every send below happen outside a
  // transaction.
  const { user, tenantName } = await withTenant(tenantId, async (tx) => ({
    user: await tx.user.findFirst({
      where: { OR: [{ login: needle }, { email: needle }] },
    }),
    tenantName: (await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } })).name,
  }));

  if (!user || user.status !== 'active') {
    await withTenant(tenantId, (tx) =>
      recordEvent(tx, {
        actorUserId: user?.id ?? null,
        action: 'auth.password_reset_requested',
        targetType: 'User',
        targetId: user?.id ?? null,
        outcome: 'failure',
        sourceIp: input.sourceIp,
        payload: { login: needle, reason: user ? 'user_inactive' : 'unknown_login' },
      }),
    );
    return;
  }

  if (user.passwordSource !== 'local') {
    await withTenant(tenantId, (tx) =>
      recordEvent(tx, {
        actorUserId: user.id,
        action: 'auth.password_reset_requested',
        targetType: 'User',
        targetId: user.id,
        outcome: 'failure',
        sourceIp: input.sourceIp,
        payload: { login: needle, reason: 'password_is_upstream' },
      }),
    );
    // Rendered and queued with no transaction open. `sendMessage` takes no
    // `TenantClient` precisely so this cannot regress.
    queueMessage(
      transport,
      renderMessage(tenantName, 'password-reset-upstream', user.email, {
        displayName: user.displayName,
        provider: user.passwordSourceHint ?? 'your organization identity provider',
      }),
      { tenantId, userId: user.id, purpose: 'password-reset-upstream' },
    );
    return;
  }

  const token = randomBytes(32).toString('base64url');

  try {
    await withTenant(tenantId, async (tx) => {
      // A partial unique index allows one live token per user, so the previous
      // one is consumed rather than left valid alongside the new one.
      await tx.passwordResetToken.updateMany({
        where: { userId: user.id, consumedAt: null },
        data: { consumedAt: now },
      });
      await tx.passwordResetToken.create({
        data: {
          tenantId: await currentTenant(tx),
          userId: user.id,
          tokenHash: hashToken(token),
          expiresAt: new Date(now.getTime() + RESET_TOKEN_LIFETIME_MS),
        },
      });
      await recordEvent(tx, {
        actorUserId: user.id,
        action: 'auth.password_reset_requested',
        targetType: 'User',
        targetId: user.id,
        outcome: 'success',
        sourceIp: input.sourceIp,
        payload: { login: needle },
      });
    });
  } catch (cause) {
    // Two requests for the same account at once: one wins the partial unique
    // index and the other violates it. Letting that escape would turn into a
    // 500 where an unknown login gets a 202, which is an account-existence
    // oracle built out of an error page. The loser sends nothing; the winner's
    // mail is already on its way.
    const code = (cause as { code?: string }).code;
    if (code === 'P2002') return;
    throw cause;
  }

  const resetUrl = `${publicUrl.replace(/\/$/, '')}/reset-password?token=${token}`;
  queueMessage(
    transport,
    renderMessage(tenantName, 'password-reset', user.email, {
      displayName: user.displayName,
      resetUrl,
    }),
    { tenantId, userId: user.id, purpose: 'password-reset' },
  );
}

export type IssueSetupOutcome =
  | { ok: true; token: string; expiresAt: Date }
  | { ok: false; reason: 'unknown_user' | 'not_local' };

export interface IssuePasswordSetupInput {
  userId: string;
  /** The administrator, who is the actor on the audit event. */
  actorUserId: string;
  sourceIp: string | null;
  now?: Date | undefined;
  lifetimeMs?: number | undefined;
}

/**
 * Mints a password-setup link for a named user.
 *
 * The counterpart to `requestPasswordReset` for the case that function cannot
 * serve: somebody who has no password yet and no mailbox Syntra can reach.
 * `authenticate()` verifies against a local Argon2id hash and nothing else, so
 * a user with no `PasswordCredential` cannot sign in — and the two routes to
 * one both presuppose something a joiner lacks. Self-service change wants the
 * password they do not have; the reset form wants an inbox that may not exist
 * on their first day.
 *
 * Every property that makes `requestPasswordReset` an oracle-avoider is
 * deliberately absent here — no constant-time floor, no uniform void return,
 * no telling-by-mail. The caller holds `directory.write` and can already list
 * every user in the tenant, so there is no existence fact left to protect, and
 * hiding the outcome would only stop an administrator distinguishing a typo
 * from a federated account.
 *
 * Takes a transaction rather than a tenantId, unlike its neighbour above: that
 * one opens its own so an SMTP round trip cannot happen inside one. This sends
 * no mail and does two indexed writes.
 *
 * The raw token is returned once and never stored, logged or audited. What
 * lands in the audit payload is the token row's id, which is enough to tie a
 * later abuse back to the administrator who minted it and useless for
 * redeeming anything.
 */
export async function issuePasswordSetup(
  tx: TenantClient,
  input: IssuePasswordSetupInput,
): Promise<IssueSetupOutcome> {
  const now = input.now ?? new Date();
  const user = await tx.user.findUnique({ where: { id: input.userId } });
  if (!user) return { ok: false, reason: 'unknown_user' };
  if (user.passwordSource !== 'local') return { ok: false, reason: 'not_local' };

  // One live token per user is enforced by the partial unique index
  // `password_reset_token_one_live`, so the previous one is consumed rather
  // than left valid beside the new one. Skipping this does not merely leave a
  // stale link usable -- it violates the index, and the create below throws.
  await tx.passwordResetToken.updateMany({
    where: { userId: user.id, consumedAt: null },
    data: { consumedAt: now },
  });

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(
    now.getTime() + (input.lifetimeMs ?? SETUP_TOKEN_LIFETIME_MS),
  );
  const row = await tx.passwordResetToken.create({
    data: {
      tenantId: await currentTenant(tx),
      userId: user.id,
      tokenHash: hashToken(token),
      expiresAt,
    },
  });

  await recordEvent(tx, {
    actorUserId: input.actorUserId,
    action: 'auth.password_setup_issued',
    targetType: 'User',
    targetId: user.id,
    outcome: 'success',
    sourceIp: input.sourceIp,
    payload: {
      login: user.login,
      tokenId: row.id,
      expiresAt: expiresAt.toISOString(),
    },
  });

  return { ok: true, token, expiresAt };
}

type TokenRow = { id: string; userId: string };

async function liveToken(
  tx: TenantClient,
  token: string,
  now: Date,
): Promise<TokenRow | null> {
  const row = await tx.passwordResetToken.findFirst({
    where: { tokenHash: hashToken(token) },
  });
  if (!row || row.consumedAt || row.expiresAt.getTime() <= now.getTime()) return null;
  return { id: row.id, userId: row.userId };
}

/**
 * Which factors, if any, this user must present alongside a new password.
 *
 * Recovery codes are appended to whatever real factors are enrolled, and only
 * when some exist, because `hasRecoveryCodes` reports false for a user with
 * none. A user with no second factor at all gets an empty list, which is what
 * makes `requiresFactor` false for them.
 */
async function acceptableFactorsFor(
  tx: TenantClient,
  userId: string,
): Promise<FactorPresentation['type'][]> {
  const acceptable: FactorPresentation['type'][] = [
    ...(await enrolledFactorTypes(tx, userId)),
  ];
  if (await hasRecoveryCodes(tx, userId)) acceptable.push('recovery_code');
  return acceptable;
}

export type ResetPreflight =
  | { valid: false }
  | {
      valid: true;
      requiresFactor: boolean;
      acceptableFactors: FactorPresentation['type'][];
    };

/**
 * What the reset screen needs to know: whether the link still works, and
 * whether a second factor must be presented alongside the new password.
 *
 * This discloses nothing an attacker does not already have, because it is
 * gated on holding a valid token — which only arrives in the account owner's
 * inbox.
 */
export async function preflightPasswordReset(
  tenantId: string,
  token: string,
  now: Date = new Date(),
): Promise<ResetPreflight> {
  return withTenant(tenantId, async (tx) => {
    const row = await liveToken(tx, token, now);
    if (!row) return { valid: false };

    const acceptable = await acceptableFactorsFor(tx, row.userId);
    return {
      valid: true,
      requiresFactor: acceptable.length > 0,
      acceptableFactors: acceptable,
    };
  });
}

/**
 * The user a live reset token belongs to, or null.
 *
 * Exists for exactly one caller: the reset-scoped WebAuthn challenge endpoint.
 * A passkey-only user could not complete a reset at all, because
 * `completePasswordReset` verifies the assertion against a stored challenge and
 * the only endpoint that minted one demanded a live `AuthAttempt` -- which
 * exists after a password has been accepted, not after a link has been opened.
 * `findAttempt` always missed, the route answered 401, and somebody whose only
 * factor is a passkey and whose recovery codes were spent had no way back into
 * their account that did not go through an administrator.
 *
 * Liveness is `liveToken`'s definition and not a second one: unknown, consumed
 * and expired all answer null, so a challenge cannot outlive the link that
 * authorised it. The caller learns a user id and nothing else -- not whether
 * the login exists, not whether it is federated, not what it has enrolled.
 */
export async function userForResetToken(
  tenantId: string,
  token: string,
  now: Date = new Date(),
): Promise<string | null> {
  return withTenant(tenantId, async (tx) => {
    const row = await liveToken(tx, token, now);
    return row?.userId ?? null;
  });
}

export interface CompleteResetInput {
  token: string;
  newPassword: string;
  factor?: FactorPresentation | undefined;
  /**
   * Required even when no factor is presented. A WebAuthn assertion cannot be
   * verified without it, and making it conditional would mean the one call
   * that needs it is the one a caller forgets.
   */
  relyingParty: RelyingParty;
  sourceIp: string | null;
  now?: Date | undefined;
}

export type ResetOutcome =
  | { ok: true }
  | {
      ok: false;
      reason: 'invalid_token' | 'factor_required' | 'factor_invalid' | 'weak_password';
      detail?: string;
    }
  /**
   * One of the last `depth` passwords this user retired.
   *
   * Checked here as well as on the change path, because a reuse rule with a
   * way around it is not a rule — and a mailed reset link is the obvious way
   * around one that only guards the change form.
   */
  | { ok: false; reason: 'reused'; depth: number };

/**
 * Steps 3 and 4 of spec section 9.
 *
 * A user who has registered a second factor must present it. Without that, a
 * mailbox compromise would be enough to take an account that its owner
 * deliberately protected with a hardware key — password reset would be the way
 * around MFA rather than a path through it.
 *
 * Completion revokes every session and every refresh token. A password change
 * that leaves the attacker's existing session alive has changed nothing.
 */
export async function completePasswordReset(
  tenantId: string,
  transport: Transport,
  input: CompleteResetInput,
): Promise<ResetOutcome> {
  const now = input.now ?? new Date();

  const context = await withTenant(tenantId, async (tx) => {
    const row = await liveToken(tx, input.token, now);
    if (!row) return null;
    const user = await tx.user.findUnique({ where: { id: row.userId } });
    if (!user || user.status !== 'active' || user.passwordSource !== 'local') return null;
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });

    return {
      tokenId: row.id,
      user,
      minLength: tenant.passwordMinLength,
      historyDepth: tenant.passwordHistoryDepth,
      // Carried out of the transaction so the confirmation mail can be
      // rendered without opening another one.
      tenantName: tenant.name,
      acceptable: await acceptableFactorsFor(tx, row.userId),
    };
  });

  if (!context) return { ok: false, reason: 'invalid_token' };

  // Checked before anything is spent: a weak password is a typo, and costing
  // the user their link for it would send them back to their inbox.
  const check = validateNewPassword(input.newPassword, {
    minLength: context.minLength,
    login: context.user.login,
    email: context.user.email,
  });
  if (!check.ok) return { ok: false, reason: 'weak_password', detail: check.reason };

  // Also before the token is spent, and for the same reason: choosing a
  // password you used two years ago is a mistake to correct, not one that
  // should cost you your link.
  const reused = await withTenant(tenantId, (tx) =>
    passwordWasUsedBefore(tx, context.user.id, input.newPassword, {
      passwordMaxAgeDays: 0,
      passwordHistoryDepth: context.historyDepth,
    }),
  );
  if (reused) return { ok: false, reason: 'reused', depth: context.historyDepth };

  if (context.acceptable.length > 0) {
    if (!input.factor) return { ok: false, reason: 'factor_required' };
    const presented = input.factor;
    if (!context.acceptable.includes(presented.type)) {
      return { ok: false, reason: 'factor_invalid' };
    }
    // Outside a transaction: signature and hash work, possibly a network read.
    const verified = await verifyFactor(tenantId, context.user.id, presented, {
      now,
      relyingParty: input.relyingParty,
    });
    if (!verified.ok) {
      await withTenant(tenantId, (tx) =>
        recordEvent(tx, {
          actorUserId: context.user.id,
          action: 'auth.password_reset_factor_failed',
          targetType: 'User',
          targetId: context.user.id,
          outcome: 'failure',
          sourceIp: input.sourceIp,
          payload: { reason: verified.reason, factor: presented.type },
        }),
      );
      return { ok: false, reason: 'factor_invalid' };
    }
  }

  // Argon2 hashing is deliberately expensive, so it happens here, before any
  // transaction opens, rather than inside one.
  const hash = await hashPassword(input.newPassword);

  // Spending the token, changing the password and revoking everything derived
  // from the old one are one transaction. Consuming first, in the same
  // statement that checks the token is still live, is what makes a double
  // submission safe: PostgreSQL serialises the two updates on the row and the
  // loser sees zero rows changed, so it returns before writing anything.
  const applied = await withTenant(tenantId, async (tx) => {
    const consumed = await tx.passwordResetToken.updateMany({
      where: { id: context.tokenId, consumedAt: null },
      data: { consumedAt: now },
    });
    if (consumed.count !== 1) return false;

    await setPasswordHash(tx, context.user.id, hash, { now });
    await revokeAllForUser(tx, context.user.id);
    await revokeAllRefreshTokensForUser(tx, context.user.id);
    await recordEvent(tx, {
      actorUserId: context.user.id,
      action: 'auth.password_reset_completed',
      targetType: 'User',
      targetId: context.user.id,
      outcome: 'success',
      sourceIp: input.sourceIp,
      payload: { factorPresented: input.factor?.type ?? null },
    });
    return true;
  });

  if (!applied) return { ok: false, reason: 'invalid_token' };

  // Queued, not awaited: the reset has committed, and a mail server that is
  // down must not turn a completed password change into a 500 for the user who
  // just made it. A failed delivery is logged and audited by `queueMessage`.
  queueMessage(
    transport,
    renderMessage(context.tenantName, 'password-changed', context.user.email, {
      displayName: context.user.displayName,
    }),
    { tenantId, userId: context.user.id, purpose: 'password-changed' },
  );

  return { ok: true };
}
