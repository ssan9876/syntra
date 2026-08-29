import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { createUser } from '../directory/user-service.js';
import { hashPassword, setPasswordHash } from './password.js';
import { authenticate } from './login-service.js';
import { recordFailure } from './login-lockout.js';

/**
 * Lockout is the control that protects the *account*; the API's rate limit
 * protects the *service*. They are not the same thing and neither substitutes
 * for the other: a rate limit keyed on the caller's address is spent by one
 * attacker and refills, while a password guessed on the thousandth try is
 * guessed forever.
 */

let tenantId: string;
let userId: string;

const PASSWORD = 'correct horse battery staple';
const PASSWORD_HASH = await hashPassword(PASSWORD);

/** Every test here sets its own policy, so the tenant is created bare. */
async function seedTenant(policy: {
  lockoutThreshold?: number;
  lockoutWindowMinutes?: number;
  lockoutDurationMinutes?: number;
}): Promise<void> {
  const t = await prisma.tenant.create({
    data: { name: 'Acme', slug: 'acme', ...policy },
  });
  tenantId = t.id;
  await withTenant(tenantId, async (tx) => {
    const user = await createUser(tx, {
      login: 'jdoe',
      email: 'j@acme.test',
      displayName: 'J Doe',
    });
    userId = user.id;
    await setPasswordHash(tx, user.id, PASSWORD_HASH);
  });
}

const wrong = (now?: Date) =>
  authenticate(tenantId, {
    login: 'jdoe',
    password: 'not the password',
    sourceIp: null,
    ...(now ? { now } : {}),
  });

const right = (now?: Date) =>
  authenticate(tenantId, {
    login: 'jdoe',
    password: PASSWORD,
    sourceIp: null,
    ...(now ? { now } : {}),
  });

beforeEach(async () => {
  await resetDatabase();
});

describe('account lockout', () => {
  it('refuses the correct password once the threshold is reached', async () => {
    await seedTenant({ lockoutThreshold: 3 });

    await wrong();
    await wrong();
    await wrong();

    expect(await right()).toEqual({ ok: false, reason: 'account_locked' });
  });

  it('is off by default, so an existing tenant behaves as it did', async () => {
    await seedTenant({});

    for (let i = 0; i < 8; i += 1) await wrong();

    expect(await right()).toEqual({ ok: true, userId, mayElevate: false });
  });

  it('tells a locked-out account apart from a wrong password only when the password is right', async () => {
    // The refusal is only ever shown to somebody who proved they know the
    // password. Anybody else gets the same answer a wrong password gets, or
    // the lock becomes a way to ask whether a login exists.
    await seedTenant({ lockoutThreshold: 2 });

    await wrong();
    await wrong();

    expect(await wrong()).toEqual({ ok: false, reason: 'invalid_credentials' });
    expect(await right()).toEqual({ ok: false, reason: 'account_locked' });
  });

  it('forgets failures that fall outside the window', async () => {
    await seedTenant({ lockoutThreshold: 3, lockoutWindowMinutes: 15 });
    const t0 = new Date('2026-08-26T09:00:00Z');

    await wrong(t0);
    await wrong(new Date('2026-08-26T09:05:00Z'));
    // Sixteen minutes after the first: the run has expired, so this failure
    // starts a new one rather than being the third of the old.
    await wrong(new Date('2026-08-26T09:16:00Z'));

    expect(await right(new Date('2026-08-26T09:17:00Z'))).toEqual({
      ok: true,
      userId,
      mayElevate: false,
    });
  });

  it('lifts the lock once its duration has passed', async () => {
    await seedTenant({ lockoutThreshold: 2, lockoutDurationMinutes: 15 });
    const t0 = new Date('2026-08-26T09:00:00Z');

    await wrong(t0);
    await wrong(t0);
    expect(await right(t0)).toEqual({ ok: false, reason: 'account_locked' });

    expect(await right(new Date('2026-08-26T09:15:01Z'))).toEqual({
      ok: true,
      userId,
      mayElevate: false,
    });
  });

  it('holds a lock indefinitely when the duration is zero', async () => {
    await seedTenant({ lockoutThreshold: 2, lockoutDurationMinutes: 0 });
    const t0 = new Date('2026-08-26T09:00:00Z');

    await wrong(t0);
    await wrong(t0);

    const muchLater = new Date('2027-08-26T09:00:00Z');
    expect(await right(muchLater)).toEqual({ ok: false, reason: 'account_locked' });
  });

  it('clears the count when the password is accepted', async () => {
    await seedTenant({ lockoutThreshold: 3 });

    await wrong();
    await wrong();
    expect(await right()).toEqual({ ok: true, userId, mayElevate: false });

    // Two more failures would reach three only if the first two still counted.
    await wrong();
    await wrong();
    expect(await right()).toEqual({ ok: true, userId, mayElevate: false });
  });

  it('counts nothing for a login that does not exist', async () => {
    // A row per invented name is both an oracle for which logins exist and an
    // unbounded table anybody can grow.
    await seedTenant({ lockoutThreshold: 2 });

    await authenticate(tenantId, {
      login: 'nobody',
      password: 'wrong',
      sourceIp: null,
    });

    // Through withTenant, or row-level security hides everything and the
    // assertion holds no matter what this function does.
    expect(await withTenant(tenantId, (tx) => tx.loginLockout.count())).toBe(0);
  });

  it('records the lock in the audit log', async () => {
    await seedTenant({ lockoutThreshold: 2 });

    await wrong();
    await wrong();

    const locked = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findFirst({ where: { action: 'auth.lockout' } }),
    );
    expect(locked).toMatchObject({ outcome: 'failure', targetId: userId });
  });

  it('counts every one of N concurrent failures exactly once', async () => {
    // A read-then-upsert done without any synchronisation loses updates:
    // two concurrent calls can both read failedCount 0 and both write 1.
    // This drives enough concurrent callers at the same user that a
    // non-atomic increment would reliably drop at least one.
    await seedTenant({ lockoutThreshold: 1000 });
    const N = 20;

    await Promise.all(
      Array.from({ length: N }, () =>
        withTenant(tenantId, (tx) =>
          recordFailure(tx, {
            tenantId,
            userId,
            login: 'jdoe',
            sourceIp: null,
            policy: { threshold: 1000, windowMinutes: 15, durationMinutes: 15 },
            now: new Date('2026-08-26T09:00:00Z'),
          }),
        ),
      ),
    );

    const state = await withTenant(tenantId, (tx) => tx.loginLockout.findUnique({
      where: { userId },
    }));
    expect(state!.failedCount).toBe(N);
  });

  it('keeps one tenant’s lockout out of another’s', async () => {
    await seedTenant({ lockoutThreshold: 2 });
    const other = await prisma.tenant.create({
      data: { name: 'Beta', slug: 'beta', lockoutThreshold: 2 },
    });
    await withTenant(other.id, async (tx) => {
      const user = await createUser(tx, {
        login: 'jdoe',
        email: 'j@beta.test',
        displayName: 'J Doe',
      });
      await setPasswordHash(tx, user.id, PASSWORD_HASH);
    });

    await wrong();
    await wrong();

    const stillFine = await authenticate(other.id, {
      login: 'jdoe',
      password: PASSWORD,
      sourceIp: null,
    });
    expect(stillFine.ok).toBe(true);
  });
});
