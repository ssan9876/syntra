import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { withTenant, type TenantClient } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import { PERMISSIONS } from '../rbac/permissions.js';
import { currentTenant } from '../tenant-context.js';

/**
 * Break-glass: sanctioned emergency access to the console.
 *
 * THE PROBLEM. With `adminWebauthnRequired` on, the console accepts only a
 * security key. If every administrator's key is lost, broken, or on the wrong
 * side of an incident, nobody can reach the console -- by design, because any
 * path that skips the key is the path an attacker uses. This module is that
 * path, made deliberate: narrow, slow, loud, time-bound and reviewed.
 *
 * THE DESIGN.
 *
 *  - An account is DESIGNATED in advance by a different administrator (never
 *    itself), from a stepped-up session. Designation mints a SEALED RECOVERY
 *    CREDENTIAL: 256 random bits, shown once, stored only as a SHA-256
 *    digest. It is meant to be printed and kept offline -- in a safe, ideally
 *    split between two custodians -- not in a password manager an attacker
 *    with a workstation can read.
 *  - Outside an activation a designated account CANNOT reach the console at
 *    all: `authorize()` denies it administrative scope. Its standing
 *    privileges are inert.
 *  - ACTIVATION is requested without a session (keys are lost; there may be
 *    no session to have) by presenting the login, the sealed credential, a
 *    mandatory reason and a duration. It does not take effect immediately:
 *      * every holder of `tenant.manage` is emailed, and a security event goes
 *        to every webhook subscribed to the Privileged access group, at once;
 *      * it waits out the tenant's activation delay (15 minutes to 24 hours,
 *        default 60), during which any administrator can cancel it;
 *      * a different administrator with a working console may approve it
 *        early (four-eyes, step-up) -- the fast path when only SOME keys are
 *        lost.
 *  - Once active, and only then, the account may elevate: through
 *    `authorize()` like everybody else -- password, the tenant's policy and
 *    admin-MFA floor all still apply -- with the security-key requirement
 *    lifted for that account alone. The session records the activation, and
 *    is live only while the activation is.
 *  - It ENDS automatically at its expiry (15 minutes to 4 hours), or earlier
 *    when anyone ends it. Its sessions stop at their next request.
 *  - A POST-EVENT REVIEW is then owed, and only a different administrator
 *    can complete it, from a stepped-up session, with written findings. The
 *    console shows a banner to every administrator while an activation is
 *    pending or active, and while a review is outstanding.
 *
 * THE THREAT MODEL, in short (docs/configure.md has the long form):
 *
 *  - The password alone buys nothing: no activation, no console.
 *  - The sealed credential alone buys an announced, delayed activation that
 *    still needs the password (and whatever the tenant's policy demands) to
 *    use.
 *  - Both together buy, at worst, a console session that everybody with
 *    `tenant.manage` was told about the moment it was asked for, that could
 *    have been cancelled for the whole delay, that ends on its own, and that
 *    somebody else must review.
 *  - An insider cannot designate themselves, approve their own activation,
 *    or review their own use; the database refuses each.
 */

export const BREAK_GLASS_CREDENTIAL_PREFIX = 'syntra_bg_';
export const BREAK_GLASS_REASON_MIN_LENGTH = 20;
export const BREAK_GLASS_REVIEW_MIN_LENGTH = 20;
export const BREAK_GLASS_DURATION_BOUNDS = { min: 15, max: 240, default: 60 } as const;
export const BREAK_GLASS_DELAY_BOUNDS = { min: 15, max: 1440, default: 60 } as const;
/**
 * The same ten minutes as `STEP_UP_MAX_AGE_MS`, spelled out rather than
 * imported: session-service imports this module (a session's liveness asks
 * whether its activation still is), and a constant read across that cycle at
 * load time is a TDZ error. A test holds the two equal.
 */
export const BREAK_GLASS_STEP_UP_MAX_AGE_MS = 10 * 60 * 1000;

export type BreakGlassRefusalCode =
  | 'invalid-credentials'
  | 'activation-open'
  | 'reason-required'
  | 'invalid-duration'
  | 'invalid-delay'
  | 'not-found'
  | 'not-pending'
  | 'not-reviewable'
  | 'self-not-allowed'
  | 'step-up-required'
  | 'already-designated'
  | 'not-designated'
  | 'account-unusable';

export class BreakGlassRefusedError extends Error {
  constructor(readonly code: BreakGlassRefusalCode, message: string) {
    super(message);
    this.name = 'BreakGlassRefusedError';
  }
}

const refuse = (code: BreakGlassRefusalCode, message: string): never => {
  throw new BreakGlassRefusedError(code, message);
};

const MINUTE_MS = 60_000;

export function hashBreakGlassCredential(credential: string): string {
  return createHash('sha256').update(credential.trim()).digest('hex');
}

function mintCredential(): { credential: string; hash: string } {
  const credential = `${BREAK_GLASS_CREDENTIAL_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { credential, hash: hashBreakGlassCredential(credential) };
}

function sameDigest(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

function assertFreshStepUp(stepUpAt: Date, now: Date, what: string): void {
  const age = now.getTime() - stepUpAt.getTime();
  if (!(age >= 0 && age <= BREAK_GLASS_STEP_UP_MAX_AGE_MS)) {
    refuse('step-up-required', `${what} needs a console session started in the last ${BREAK_GLASS_STEP_UP_MAX_AGE_MS / MINUTE_MS} minutes. Elevate again, then retry.`);
  }
}

type ActivationRow = Awaited<ReturnType<TenantClient['breakGlassActivation']['findFirstOrThrow']>>;
export type BreakGlassActivationRow = ActivationRow;

// ---- Transitions ------------------------------------------------------------

/**
 * Applies whatever the clock has made true: a pending activation whose delay
 * has passed becomes active, and an active one past its expiry expires. Each
 * is a conditional update keyed on the status that was read, so a sweep, a
 * sign-in and a manual action racing move an activation at most once.
 *
 * Returns the activations this call made active, so the caller can mail.
 */
async function advance(tx: TenantClient, where: { userId?: string }, now: Date): Promise<ActivationRow[]> {
  const activated: ActivationRow[] = [];
  const due = await tx.breakGlassActivation.findMany({
    where: { ...where, status: 'pending', activatesAt: { lte: now } },
  });
  for (const row of due) {
    const expiresAt = new Date(row.activatesAt.getTime() + row.durationMinutes * MINUTE_MS);
    const { count } = await tx.breakGlassActivation.updateMany({
      where: { id: row.id, status: 'pending' },
      data: { status: 'active', activatedAt: row.activatesAt, activatedBy: 'delay', expiresAt },
    });
    if (count === 1) {
      await recordEvent(tx, {
        actorUserId: null,
        action: 'break_glass.activated',
        targetType: 'User',
        targetId: row.userId,
        outcome: 'success',
        sourceIp: null,
        payload: { activationId: row.id, activatedBy: 'delay', activatedAt: row.activatesAt.toISOString(), expiresAt: expiresAt.toISOString() },
      });
      activated.push(await tx.breakGlassActivation.findUniqueOrThrow({ where: { id: row.id } }));
    }
  }

  const lapsed = await tx.breakGlassActivation.findMany({
    where: { ...where, status: 'active', expiresAt: { lte: now } },
  });
  for (const row of lapsed) {
    const { count } = await tx.breakGlassActivation.updateMany({
      where: { id: row.id, status: 'active' },
      data: { status: 'expired', endedAt: row.expiresAt, reviewStatus: 'pending' },
    });
    if (count === 1) {
      await tx.session.updateMany({ where: { breakGlassActivationId: row.id, revokedAt: null }, data: { revokedAt: now } });
      await recordEvent(tx, {
        actorUserId: null,
        action: 'break_glass.expired',
        targetType: 'User',
        targetId: row.userId,
        outcome: 'success',
        sourceIp: null,
        payload: { activationId: row.id, expiredAt: row.expiresAt?.toISOString() ?? null },
      });
    }
  }
  return activated;
}

/** The minute sweep. Returns activations it made active (to mail about). */
export async function sweepBreakGlass(tenantId: string, now: Date = new Date()): Promise<ActivationRow[]> {
  return withTenant(tenantId, (tx) => advance(tx, {}, now));
}

/**
 * What `authorize()` needs to know about a user asking for an
 * administrative session. Advances that user's activations first, so a delay
 * that has just passed counts without waiting for the sweep.
 */
export async function breakGlassStanding(
  tx: TenantClient,
  userId: string,
  now: Date,
): Promise<{ designated: boolean; activationId: string | null }> {
  const account = await tx.breakGlassAccount.findFirst({ where: { userId }, select: { id: true } });
  if (!account) return { designated: false, activationId: null };
  await advance(tx, { userId }, now);
  const active = await tx.breakGlassActivation.findFirst({
    where: { userId, status: 'active', expiresAt: { gt: now } },
    select: { id: true },
  });
  return { designated: true, activationId: active?.id ?? null };
}

/** Whether a session minted under an activation may still be used. */
export async function breakGlassActivationLive(tx: TenantClient, activationId: string, now: Date): Promise<boolean> {
  const row = await tx.breakGlassActivation.findUnique({ where: { id: activationId }, select: { status: true, expiresAt: true } });
  return row !== null && row.status === 'active' && row.expiresAt !== null && row.expiresAt > now;
}

// ---- Designation --------------------------------------------------------------

export interface AdminActor { actorUserId: string; stepUpAt: Date; sourceIp: string | null }

async function usableAccount(tx: TenantClient, userId: string) {
  const user = await tx.user.findUnique({ where: { id: userId } });
  if (!user) return refuse('not-found', 'Account not found');
  if (user.status !== 'active') refuse('account-unusable', 'Only an active account can be an emergency account');
  if (user.passwordSource !== 'local') {
    refuse('account-unusable', 'An emergency account must sign in with a password Syntra holds; an upstream provider may be the thing that is down');
  }
  return user;
}

async function openActivation(tx: TenantClient, userId: string) {
  return tx.breakGlassActivation.findFirst({ where: { userId, status: { in: ['pending', 'active'] } } });
}

export async function designateBreakGlassAccount(
  tenantId: string,
  userId: string,
  actor: AdminActor,
  now: Date = new Date(),
): Promise<{ credential: string; userId: string }> {
  return withTenant(tenantId, async (tx) => {
    if (userId === actor.actorUserId) refuse('self-not-allowed', 'A different administrator must designate your account for emergency access');
    assertFreshStepUp(actor.stepUpAt, now, 'Designating an emergency account');
    await usableAccount(tx, userId);
    if (await tx.breakGlassAccount.findFirst({ where: { userId } })) {
      refuse('already-designated', 'That account is already an emergency account; rotate its credential instead');
    }
    const { credential, hash } = mintCredential();
    await tx.breakGlassAccount.create({
      data: { tenantId, userId, credentialHash: hash, designatedByUserId: actor.actorUserId, designatedAt: now, credentialIssuedAt: now },
    });
    await recordEvent(tx, {
      actorUserId: actor.actorUserId, action: 'break_glass.account_designated', targetType: 'User', targetId: userId,
      outcome: 'success', sourceIp: actor.sourceIp, payload: { stepUpAt: actor.stepUpAt.toISOString() },
    });
    return { credential, userId };
  });
}

export async function rotateBreakGlassCredential(
  tenantId: string,
  userId: string,
  actor: AdminActor,
  now: Date = new Date(),
): Promise<{ credential: string; userId: string }> {
  return withTenant(tenantId, async (tx) => {
    if (userId === actor.actorUserId) refuse('self-not-allowed', 'A different administrator must rotate your emergency credential');
    assertFreshStepUp(actor.stepUpAt, now, 'Rotating an emergency credential');
    const account = await tx.breakGlassAccount.findFirst({ where: { userId } });
    if (!account) return refuse('not-designated', 'That account is not an emergency account');
    if (await openActivation(tx, userId)) refuse('activation-open', 'End or cancel the open activation first');
    const { credential, hash } = mintCredential();
    await tx.breakGlassAccount.update({ where: { id: account.id }, data: { credentialHash: hash, credentialIssuedAt: now } });
    await recordEvent(tx, {
      actorUserId: actor.actorUserId, action: 'break_glass.credential_rotated', targetType: 'User', targetId: userId,
      outcome: 'success', sourceIp: actor.sourceIp, payload: {},
    });
    return { credential, userId };
  });
}

export async function revokeBreakGlassAccount(
  tenantId: string,
  userId: string,
  actor: AdminActor,
  now: Date = new Date(),
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    assertFreshStepUp(actor.stepUpAt, now, 'Removing an emergency account');
    const account = await tx.breakGlassAccount.findFirst({ where: { userId } });
    if (!account) return refuse('not-designated', 'That account is not an emergency account');
    if (await openActivation(tx, userId)) refuse('activation-open', 'End or cancel the open activation first');
    await tx.breakGlassAccount.delete({ where: { id: account.id } });
    await recordEvent(tx, {
      actorUserId: actor.actorUserId, action: 'break_glass.account_revoked', targetType: 'User', targetId: userId,
      outcome: 'success', sourceIp: actor.sourceIp, payload: {},
    });
  });
}

export async function setBreakGlassActivationDelay(
  tx: TenantClient,
  minutes: number,
  actor: AdminActor,
  now: Date = new Date(),
): Promise<number> {
  if (!Number.isInteger(minutes) || minutes < BREAK_GLASS_DELAY_BOUNDS.min || minutes > BREAK_GLASS_DELAY_BOUNDS.max) {
    refuse('invalid-delay', `The activation delay must be ${BREAK_GLASS_DELAY_BOUNDS.min}–${BREAK_GLASS_DELAY_BOUNDS.max} minutes`);
  }
  assertFreshStepUp(actor.stepUpAt, now, 'Changing the activation delay');
  const tenantId = await currentTenant(tx);
  const before = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { breakGlassActivationDelayMinutes: true } });
  await tx.tenant.update({ where: { id: tenantId }, data: { breakGlassActivationDelayMinutes: minutes } });
  await recordEvent(tx, {
    actorUserId: actor.actorUserId, action: 'break_glass.delay_updated', targetType: 'Tenant', targetId: tenantId,
    outcome: 'success', sourceIp: actor.sourceIp,
    payload: { before: before.breakGlassActivationDelayMinutes, after: minutes },
  });
  return minutes;
}

// ---- Activation ---------------------------------------------------------------

export interface ActivationNotice {
  tenantName: string;
  account: { login: string; displayName: string };
  activation: ActivationRow;
  recipients: { userId: string; email: string; displayName: string }[];
}

/** Every active person holding `tenant.manage` tenant-wide: who is told. */
export async function breakGlassRecipients(tx: TenantClient, excludeUserId?: string) {
  const assignments = await tx.roleAssignment.findMany({
    where: { scopeOrgUnitId: null, role: { permissions: { has: PERMISSIONS.TENANT_MANAGE } } },
    select: { userId: true },
  });
  const ids = [...new Set(assignments.map((row) => row.userId))].filter((id) => id !== excludeUserId);
  if (ids.length === 0) return [];
  const users = await tx.user.findMany({ where: { id: { in: ids }, status: 'active' }, select: { id: true, email: true, displayName: true } });
  return users.map((user) => ({ userId: user.id, email: user.email, displayName: user.displayName }));
}

async function notice(tx: TenantClient, activation: ActivationRow): Promise<ActivationNotice> {
  const tenantId = await currentTenant(tx);
  const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true } });
  const user = await tx.user.findUnique({ where: { id: activation.userId }, select: { login: true, displayName: true } });
  return {
    tenantName: tenant.name,
    account: { login: user?.login ?? '(deleted)', displayName: user?.displayName ?? '(deleted)' },
    activation,
    recipients: await breakGlassRecipients(tx),
  };
}

export async function activationNotices(tenantId: string, activations: ActivationRow[]): Promise<ActivationNotice[]> {
  if (activations.length === 0) return [];
  return withTenant(tenantId, async (tx) => Promise.all(activations.map((row) => notice(tx, row))));
}

export interface ActivationRequestInput {
  login: string;
  credential: string;
  reason: string;
  durationMinutes: number;
  sourceIp: string | null;
}

/**
 * Asks for an activation with the sealed credential. No session is involved.
 *
 * Every failure to identify -- unknown login, an account that is not an
 * emergency account, a wrong credential, an inactive account -- is ONE answer,
 * `invalid-credentials`, so the endpoint is not an oracle for which accounts
 * are designated. The audit log records which it was.
 */
export async function requestBreakGlassActivation(
  tenantId: string,
  input: ActivationRequestInput,
  now: Date = new Date(),
): Promise<ActivationNotice> {
  const reason = input.reason.trim();
  if (reason.length < BREAK_GLASS_REASON_MIN_LENGTH) {
    refuse('reason-required', `Give a reason of at least ${BREAK_GLASS_REASON_MIN_LENGTH} characters`);
  }
  if (!Number.isInteger(input.durationMinutes) ||
      input.durationMinutes < BREAK_GLASS_DURATION_BOUNDS.min || input.durationMinutes > BREAK_GLASS_DURATION_BOUNDS.max) {
    refuse('invalid-duration', `An activation lasts ${BREAK_GLASS_DURATION_BOUNDS.min}–${BREAK_GLASS_DURATION_BOUNDS.max} minutes`);
  }

  const denied = async (userId: string | null, why: string) => {
    await withTenant(tenantId, (tx) => recordEvent(tx, {
      actorUserId: userId, action: 'break_glass.activation_refused', targetType: 'User', targetId: userId,
      outcome: 'failure', sourceIp: input.sourceIp, payload: { reason: why },
    }));
    return refuse('invalid-credentials', 'Those emergency credentials were not accepted');
  };

  const identified = await withTenant(tenantId, async (tx) => {
    const user = await tx.user.findFirst({ where: { login: { equals: input.login.trim(), mode: 'insensitive' } } });
    if (!user) return { ok: false as const, userId: null, why: 'unknown_login' };
    const account = await tx.breakGlassAccount.findFirst({ where: { userId: user.id } });
    if (!account) return { ok: false as const, userId: user.id, why: 'not_designated' };
    if (!sameDigest(account.credentialHash, hashBreakGlassCredential(input.credential))) {
      return { ok: false as const, userId: user.id, why: 'wrong_credential' };
    }
    if (user.status !== 'active') return { ok: false as const, userId: user.id, why: 'user_inactive' };
    return { ok: true as const, userId: user.id, why: '' };
  });
  if (!identified.ok) return denied(identified.userId, identified.why);

  return withTenant(tenantId, async (tx) => {
    await advance(tx, { userId: identified.userId }, now);
    if (await openActivation(tx, identified.userId)) {
      refuse('activation-open', 'An activation for this account is already pending or active');
    }
    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { id: tenantId }, select: { breakGlassActivationDelayMinutes: true },
    });
    const activatesAt = new Date(now.getTime() + tenant.breakGlassActivationDelayMinutes * MINUTE_MS);
    const created = await tx.breakGlassActivation.create({
      data: {
        tenantId, userId: identified.userId, reason, durationMinutes: input.durationMinutes,
        requestedAt: now, requestedFromIp: input.sourceIp, activatesAt,
      },
    });
    await recordEvent(tx, {
      actorUserId: identified.userId, action: 'break_glass.activation_requested', targetType: 'User', targetId: identified.userId,
      outcome: 'success', sourceIp: input.sourceIp,
      payload: { activationId: created.id, reason, durationMinutes: input.durationMinutes, activatesAt: activatesAt.toISOString() },
    });
    return notice(tx, created);
  });
}

async function findActivation(tx: TenantClient, id: string) {
  const row = await tx.breakGlassActivation.findFirst({ where: { id } });
  if (!row) return refuse('not-found', 'Activation not found');
  return row;
}

/** A second administrator makes a pending activation effective now. */
export async function approveBreakGlassActivation(
  tenantId: string,
  activationId: string,
  actor: AdminActor,
  now: Date = new Date(),
): Promise<ActivationNotice> {
  return withTenant(tenantId, async (tx) => {
    await advance(tx, {}, now);
    const row = await findActivation(tx, activationId);
    if (row.userId === actor.actorUserId) refuse('self-not-allowed', 'A different administrator must approve an emergency activation');
    if (row.status !== 'pending') refuse('not-pending', `This activation is ${row.status}, not pending`);
    assertFreshStepUp(actor.stepUpAt, now, 'Approving an emergency activation');
    const expiresAt = new Date(now.getTime() + row.durationMinutes * MINUTE_MS);
    const { count } = await tx.breakGlassActivation.updateMany({
      where: { id: activationId, status: 'pending' },
      data: {
        status: 'active', activatedAt: now, activatedBy: 'approval', expiresAt,
        approvedByUserId: actor.actorUserId, approverStepUpAt: actor.stepUpAt,
      },
    });
    if (count !== 1) refuse('not-pending', 'This activation is no longer pending');
    await recordEvent(tx, {
      actorUserId: actor.actorUserId, action: 'break_glass.activated', targetType: 'User', targetId: row.userId,
      outcome: 'success', sourceIp: actor.sourceIp,
      payload: { activationId, activatedBy: 'approval', stepUpAt: actor.stepUpAt.toISOString(), expiresAt: expiresAt.toISOString() },
    });
    return notice(tx, await tx.breakGlassActivation.findUniqueOrThrow({ where: { id: activationId } }));
  });
}

/**
 * Cancels a pending activation (a veto -- anyone may, the account included:
 * stopping emergency access needs no second pair of eyes) or ends an active
 * one early, which ends its sessions and makes the review due.
 */
export async function endBreakGlassActivation(
  tenantId: string,
  activationId: string,
  actor: { actorUserId: string; sourceIp: string | null },
  now: Date = new Date(),
): Promise<ActivationRow> {
  return withTenant(tenantId, async (tx) => {
    await advance(tx, {}, now);
    const row = await findActivation(tx, activationId);
    if (row.status === 'pending') {
      const { count } = await tx.breakGlassActivation.updateMany({
        where: { id: activationId, status: 'pending' },
        data: { status: 'cancelled', endedAt: now, endedByUserId: actor.actorUserId },
      });
      if (count !== 1) refuse('not-pending', 'This activation changed while you were looking at it');
      await recordEvent(tx, {
        actorUserId: actor.actorUserId, action: 'break_glass.activation_cancelled', targetType: 'User', targetId: row.userId,
        outcome: 'success', sourceIp: actor.sourceIp, payload: { activationId },
      });
    } else if (row.status === 'active') {
      const { count } = await tx.breakGlassActivation.updateMany({
        where: { id: activationId, status: 'active' },
        data: { status: 'ended', endedAt: now, endedByUserId: actor.actorUserId, reviewStatus: 'pending' },
      });
      if (count !== 1) refuse('not-pending', 'This activation changed while you were looking at it');
      await tx.session.updateMany({ where: { breakGlassActivationId: activationId, revokedAt: null }, data: { revokedAt: now } });
      await recordEvent(tx, {
        actorUserId: actor.actorUserId, action: 'break_glass.ended', targetType: 'User', targetId: row.userId,
        outcome: 'success', sourceIp: actor.sourceIp, payload: { activationId },
      });
    } else {
      refuse('not-pending', `This activation is already ${row.status}`);
    }
    return tx.breakGlassActivation.findUniqueOrThrow({ where: { id: activationId } });
  });
}

/**
 * The post-event review. A different administrator, freshly stepped up,
 * records what they found. The event carries how much the account did in
 * the window, counted from the audit log, so the review is anchored to it.
 */
export async function reviewBreakGlassActivation(
  tenantId: string,
  activationId: string,
  input: AdminActor & { notes: string },
  now: Date = new Date(),
): Promise<ActivationRow> {
  return withTenant(tenantId, async (tx) => {
    await advance(tx, {}, now);
    const row = await findActivation(tx, activationId);
    if (row.userId === input.actorUserId) refuse('self-not-allowed', 'A different administrator must review an emergency activation');
    if (row.reviewStatus !== 'pending') refuse('not-reviewable', 'This activation has no review outstanding');
    const notes = input.notes.trim();
    if (notes.length < BREAK_GLASS_REVIEW_MIN_LENGTH) {
      refuse('reason-required', `Record findings of at least ${BREAK_GLASS_REVIEW_MIN_LENGTH} characters`);
    }
    assertFreshStepUp(input.stepUpAt, now, 'Completing a break-glass review');
    const windowEnd = row.endedAt ?? row.expiresAt ?? now;
    const actions = await tx.auditEvent.count({
      where: { actorUserId: row.userId, occurredAt: { gte: row.activatedAt ?? row.requestedAt, lte: windowEnd } },
    });
    const { count } = await tx.breakGlassActivation.updateMany({
      where: { id: activationId, reviewStatus: 'pending' },
      data: { reviewStatus: 'completed', reviewedByUserId: input.actorUserId, reviewedAt: now, reviewerStepUpAt: input.stepUpAt, reviewNotes: notes },
    });
    if (count !== 1) refuse('not-reviewable', 'This review was completed by somebody else');
    await recordEvent(tx, {
      actorUserId: input.actorUserId, action: 'break_glass.reviewed', targetType: 'User', targetId: row.userId,
      outcome: 'success', sourceIp: input.sourceIp,
      payload: { activationId, actionsInWindow: actions, notes, stepUpAt: input.stepUpAt.toISOString() },
    });
    return tx.breakGlassActivation.findUniqueOrThrow({ where: { id: activationId } });
  });
}

// ---- Reading ----------------------------------------------------------------------

export async function breakGlassOverview(tenantId: string, now: Date = new Date()) {
  await sweepBreakGlass(tenantId, now);
  return withTenant(tenantId, async (tx) => {
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { breakGlassActivationDelayMinutes: true } });
    const accounts = await tx.breakGlassAccount.findMany({ orderBy: { designatedAt: 'asc' } });
    const activations = await tx.breakGlassActivation.findMany({ orderBy: { requestedAt: 'desc' }, take: 50 });
    const ids = [...new Set([...accounts.map((row) => row.userId), ...activations.map((row) => row.userId)])];
    const users = ids.length === 0 ? [] : await tx.user.findMany({
      where: { id: { in: ids } }, select: { id: true, login: true, displayName: true, status: true },
    });
    const byId = new Map(users.map((user) => [user.id, user]));
    return {
      activationDelayMinutes: tenant.breakGlassActivationDelayMinutes,
      accounts: accounts.map((row) => ({
        userId: row.userId,
        login: byId.get(row.userId)?.login ?? null,
        displayName: byId.get(row.userId)?.displayName ?? null,
        status: byId.get(row.userId)?.status ?? 'deleted',
        designatedByUserId: row.designatedByUserId,
        designatedAt: row.designatedAt,
        credentialIssuedAt: row.credentialIssuedAt,
      })),
      activations: activations.map((row) => ({
        ...row,
        login: byId.get(row.userId)?.login ?? null,
        displayName: byId.get(row.userId)?.displayName ?? null,
      })),
    };
  });
}

/** What every administrator's console banner shows. */
export async function breakGlassBanner(tenantId: string, now: Date = new Date()) {
  await sweepBreakGlass(tenantId, now);
  return withTenant(tenantId, async (tx) => {
    const open = await tx.breakGlassActivation.findMany({
      where: { status: { in: ['pending', 'active'] } },
      orderBy: { requestedAt: 'asc' },
      select: { id: true, userId: true, status: true, reason: true, activatesAt: true, expiresAt: true },
    });
    const reviewsDue = await tx.breakGlassActivation.count({ where: { reviewStatus: 'pending' } });
    const users = open.length === 0 ? [] : await tx.user.findMany({
      where: { id: { in: open.map((row) => row.userId) } }, select: { id: true, displayName: true },
    });
    const names = new Map(users.map((user) => [user.id, user.displayName]));
    return {
      activations: open.map((row) => ({ ...row, displayName: names.get(row.userId) ?? null })),
      reviewsDue,
    };
  });
}
