import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ldapWriteback } from '@syntra/connectors';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { createUser } from '../directory/user-service.js';
import { createSource } from '../sync/source-service.js';
import { createSession, resolveSession } from './session-service.js';
import { hashPassword, setPasswordHash, verifyPassword } from './password.js';
import { changeOwnPassword } from './password-change.js';
import { localMasterKeyProvider } from '../vault/master-key.js';

const provider = localMasterKeyProvider(Buffer.alloc(32, 13));

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
  changeOwnPassword(tenantId, provider, {
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

/**
 * The account's password lives in Active Directory, so the directory decides.
 *
 * The local hash is deliberately NOT consulted on this path: Syntra's hash and
 * the domain's password can already have diverged, and checking locally would
 * accept a password the domain rejects and reject one it accepts.
 *
 * The connector is stubbed here. What it does against a real directory is
 * proved by `writeback.integration.test.ts` against live Samba; what this file
 * is about is the ORDER of the two writes and what survives a failure of
 * either, which no directory can demonstrate.
 */
describe('changeOwnPassword writing through to a directory', () => {
  const changePassword = vi.spyOn(ldapWriteback, 'changePassword');

  beforeEach(async () => {
    changePassword.mockReset();
    changePassword.mockResolvedValue({ ok: true, message: 'changed' });
    await withTenant(tenantId, async (tx) => {
      const source = await createSource(tx, provider, {
        name: 'Head office AD',
        config: {
          url: 'ldaps://ad.acme.test',
          bindDn: 'cn=svc,dc=acme,dc=test',
          userSearchBase: 'ou=People,dc=acme,dc=test',
          groupSearchBase: 'ou=Groups,dc=acme,dc=test',
          anchorAttribute: 'objectGUID',
        },
        bindPassword: 'bind-secret',
        writebackEnabled: true,
        writebackPassword: true,
      });
      await tx.user.update({
        where: { id: userId },
        data: { sourceId: source.id, sourceAnchor: 'anchor-guid' },
      });
    });
  });

  afterEach(() => changePassword.mockReset());

  it('sends the change to the directory and then stores the hash', async () => {
    const { sessionId } = await signIn();
    const outcome = await change(sessionId);

    expect(outcome.ok).toBe(true);
    expect(changePassword).toHaveBeenCalledWith(
      expect.objectContaining({ bindPassword: 'bind-secret' }),
      {
        anchor: 'anchor-guid',
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
      },
    );
    expect(await verifyPassword((await storedHash()).hash, NEW_PASSWORD)).toBe(true);
  });

  /**
   * Directory first. If it refuses, the local hash must be untouched -- the
   * other ordering leaves Syntra accepting a password the domain rejects, and
   * the support call that follows has no visible cause.
   */
  it('leaves the local hash alone when the directory refuses', async () => {
    changePassword.mockResolvedValue({
      ok: false,
      failure: 'policy',
      message: 'refused',
    });
    const { sessionId } = await signIn();
    const before = await storedHash();

    const outcome = await change(sessionId);

    expect(outcome).toEqual({ ok: false, reason: 'directory_policy' });
    expect((await storedHash()).hash).toBe(before.hash);
  });

  it('reports a wrong current password from the directory, not from the hash', async () => {
    changePassword.mockResolvedValue({
      ok: false,
      failure: 'wrong_password',
      message: 'no',
    });
    const { sessionId } = await signIn();
    expect(await change(sessionId)).toEqual({ ok: false, reason: 'wrong_password' });
  });

  /**
   * Never a quiet fall back to a local-only change. That is exactly the
   * divergence this path exists to remove, and it would be invisible to the
   * person doing it.
   */
  it('refuses rather than changing locally when the directory is unreachable', async () => {
    changePassword.mockResolvedValue({
      ok: false,
      failure: 'transient',
      message: 'unreachable',
    });
    const { sessionId } = await signIn();
    const before = await storedHash();

    expect(await change(sessionId)).toEqual({
      ok: false,
      reason: 'directory_unavailable',
    });
    expect((await storedHash()).hash).toBe(before.hash);
  });

  /**
   * The local check runs FIRST and short-circuits: a password the tenant
   * policy already refuses must not spend a round trip, and above all must not
   * spend an attempt against the domain's lockout counter.
   */
  it('refuses a weak password without asking the directory', async () => {
    const { sessionId } = await signIn();
    expect(await change(sessionId, PASSWORD, 'short')).toMatchObject({
      reason: 'weak_password',
    });
    expect(changePassword).not.toHaveBeenCalled();
  });

  it('stays local when the source does not have password write-back', async () => {
    await withTenant(tenantId, (tx) =>
      tx.directorySource.updateMany({ data: { writebackPassword: false } }),
    );
    const { sessionId } = await signIn();

    expect((await change(sessionId)).ok).toBe(true);
    expect(changePassword).not.toHaveBeenCalled();
    expect(await verifyPassword((await storedHash()).hash, NEW_PASSWORD)).toBe(true);
  });

  it('still revokes the other sessions on the write-back path', async () => {
    const elsewhere = await signIn();
    const mine = await signIn();

    expect(await change(mine.sessionId)).toMatchObject({ otherSessionsRevoked: 1 });
    const resolved = await withTenant(tenantId, (tx) =>
      resolveSession(tx, elsewhere.token),
    );
    expect(resolved).toBeNull();
  });

  it('records neither password nor the bind credential in the audit trail', async () => {
    const { sessionId } = await signIn();
    await change(sessionId);

    const events = await withTenant(tenantId, (tx) => tx.auditEvent.findMany());
    const serialised = JSON.stringify(events);
    expect(serialised).not.toContain(PASSWORD);
    expect(serialised).not.toContain(NEW_PASSWORD);
    expect(serialised).not.toContain('bind-secret');
  });
});
