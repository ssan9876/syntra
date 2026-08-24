import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { createUser } from '../directory/user-service.js';
import { createSession, resolveSession } from './session-service.js';
import { hashPassword, setPasswordHash, verifyPassword } from './password.js';
import { changeOwnPassword } from './password-change.js';

let tenantId: string;
let userId: string;

const PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'a completely different passphrase';

// Hashed once for the file, outside every transaction: Argon2id is
// deliberately expensive and has no business inside Prisma's 5000 ms budget.
const PASSWORD_HASH = await hashPassword(PASSWORD);

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  userId = await withTenant(tenantId, async (tx) => {
    const u = await createUser(tx, {
      login: 'jdoe',
      email: 'jo.doe@acme.test',
      displayName: 'J Doe',
    });
    await setPasswordHash(tx, u.id, PASSWORD_HASH);
    return u.id;
  });
});

/** A session for this user, returned as the raw token and its row id. */
async function signIn() {
  return withTenant(tenantId, async (tx) => {
    const created = await createSession(tx, {
      status: 'allow',
      userId,
      scope: 'portal',
      satisfiedFactor: null,
      mayElevate: false,
      applicationId: null,
    });
    const resolved = await resolveSession(tx, created.token);
    return { token: created.token, sessionId: resolved!.sessionId };
  });
}

const change = async (
  sessionId: string,
  currentPassword = PASSWORD,
  newPassword = NEW_PASSWORD,
) =>
  changeOwnPassword(tenantId, {
    userId,
    currentPassword,
    newPassword,
    sessionId,
    sourceIp: '10.1.2.3',
  });

const storedHash = () =>
  withTenant(tenantId, (tx) =>
    tx.passwordCredential.findUniqueOrThrow({ where: { userId } }),
  );

describe('changeOwnPassword', () => {
  it('replaces the password when the current one is right', async () => {
    const { sessionId } = await signIn();
    const outcome = await change(sessionId);

    expect(outcome.ok).toBe(true);
    const credential = await storedHash();
    expect(await verifyPassword(credential.hash, NEW_PASSWORD)).toBe(true);
    expect(await verifyPassword(credential.hash, PASSWORD)).toBe(false);
  });

  it('refuses a wrong current password and changes nothing', async () => {
    const { sessionId } = await signIn();
    const before = await storedHash();

    const outcome = await change(sessionId, 'not the password');

    expect(outcome).toEqual({ ok: false, reason: 'wrong_password' });
    // Not merely "it said no": the stored hash is byte-identical, so nothing
    // was written on the refusal path.
    expect((await storedHash()).hash).toBe(before.hash);
  });

  /**
   * The session in the caller's hand is the evidence the request rests on.
   * Revoking it would sign them out of the tab they are looking at, at the
   * moment they are told it worked.
   */
  it('keeps the session that made the change', async () => {
    const { token, sessionId } = await signIn();
    await change(sessionId);

    const still = await withTenant(tenantId, (tx) => resolveSession(tx, token));
    expect(still?.userId).toBe(userId);
  });

  /**
   * ...and every other one goes. This is the entire point of changing a
   * password after somebody else has learned it; leaving them alive would
   * make the change cosmetic.
   */
  it('revokes every other session', async () => {
    const elsewhere = await signIn();
    const alsoElsewhere = await signIn();
    const mine = await signIn();

    const outcome = await change(mine.sessionId);

    expect(outcome).toMatchObject({ ok: true, otherSessionsRevoked: 2 });
    for (const other of [elsewhere, alsoElsewhere]) {
      const resolved = await withTenant(tenantId, (tx) =>
        resolveSession(tx, other.token),
      );
      expect(resolved).toBeNull();
    }
  });

  it('revokes refresh tokens, which outlive sessions', async () => {
    const { sessionId } = await signIn();
    await withTenant(tenantId, (tx) =>
      tx.refreshToken.create({
        data: {
          tenantId,
          userId,
          tokenHash: 'a'.repeat(64),
          absoluteExpiresAt: new Date(Date.now() + 86_400_000),
        },
      }),
    );

    await change(sessionId);

    const live = await withTenant(tenantId, (tx) =>
      tx.refreshToken.count({ where: { userId, revokedAt: null } }),
    );
    expect(live).toBe(0);
  });

  it('refuses a password below the tenant minimum', async () => {
    const { sessionId } = await signIn();
    expect(await change(sessionId, PASSWORD, 'short')).toEqual({
      ok: false,
      reason: 'weak_password',
      detail: 'too_short',
    });
  });

  /**
   * Long enough to clear the length check, so this reaches the predictability
   * branch rather than stopping at the first one — `validateNewPassword`
   * tests length first, and a short obvious password would prove only that
   * it was short.
   */
  it('refuses a long but predictable password', async () => {
    const { sessionId } = await signIn();
    expect(await change(sessionId, PASSWORD, 'a'.repeat(20))).toEqual({
      ok: false,
      reason: 'weak_password',
      detail: 'too_obvious',
    });
  });

  /**
   * Re-typing the same password reads as success and changes nothing, which
   * is the worst possible outcome for somebody changing it BECAUSE it leaked.
   */
  it('refuses a new password identical to the current one', async () => {
    const { sessionId } = await signIn();
    const outcome = await change(sessionId, PASSWORD, PASSWORD);
    expect(outcome).toEqual({ ok: false, reason: 'unchanged' });
  });

  /**
   * The schema is explicit that an upstream account's password lives with the
   * provider. Writing a local hash for one would create a second, divergent
   * password that authenticates nowhere the user expects.
   */
  it('sends an upstream account to its provider, with the hint', async () => {
    await withTenant(tenantId, (tx) =>
      tx.user.update({
        where: { id: userId },
        data: { passwordSource: 'upstream', passwordSourceHint: 'Contoso ID' },
      }),
    );
    const { sessionId } = await signIn();

    const outcome = await change(sessionId);

    expect(outcome).toEqual({
      ok: false,
      reason: 'upstream',
      hint: 'Contoso ID',
    });
    // The local hash is untouched, not replaced and not cleared.
    expect(await verifyPassword((await storedHash()).hash, PASSWORD)).toBe(true);
  });

  it('refuses when the account has no password to change', async () => {
    await withTenant(tenantId, (tx) =>
      tx.passwordCredential.delete({ where: { userId } }),
    );
    const { sessionId } = await signIn();

    // Not 'wrong_password': a passkey-only account has nothing to verify
    // against, and setting one from here would be an enrolment by whoever
    // holds the session rather than a change by whoever knows the password.
    expect(await change(sessionId)).toEqual({ ok: false, reason: 'no_password' });
  });

  it('audits the change without recording the password', async () => {
    const { sessionId } = await signIn();
    await change(sessionId);

    const events = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'auth.password_changed' } }),
    );
    expect(events).toHaveLength(1);
    const serialised = JSON.stringify(events[0]);
    expect(serialised).not.toContain(NEW_PASSWORD);
    expect(serialised).not.toContain(PASSWORD);
  });

  it('audits a failed attempt, so a guessing run is visible', async () => {
    const { sessionId } = await signIn();
    await change(sessionId, 'wrong');
    await change(sessionId, 'wrong again');

    const events = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'auth.password_change_failed' } }),
    );
    expect(events).toHaveLength(2);
  });
});
