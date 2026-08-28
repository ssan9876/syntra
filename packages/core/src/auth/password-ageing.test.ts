import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { createUser } from '../directory/user-service.js';
import { hashPassword, setPasswordHash } from './password.js';
import { authorize } from './authorize.js';
import { changeOwnPassword } from './password-change.js';
import { localMasterKeyProvider } from '../vault/master-key.js';

/**
 * Two halves of one setting, deliberately independent.
 *
 * Reuse prevention costs the user nothing until they try to retire a password
 * back into service. Scheduled expiry costs every user every period, and
 * current guidance is against it — it is here because auditors still ask for
 * it, and it is off unless somebody turns it on.
 */

let tenantId: string;
let userId: string;

const PASSWORD = 'correct horse battery staple';
const PASSWORD_HASH = await hashPassword(PASSWORD);

const DAY = 24 * 60 * 60 * 1000;
const RP = { id: 'acme.syntra.test', origin: 'http://acme.syntra.test' };
const CHOSEN = new Date('2026-01-01T00:00:00Z');

async function seed(policy: { passwordMaxAgeDays?: number } = {}): Promise<void> {
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
    await tx.passwordCredential.update({
      where: { userId: user.id },
      data: { changedAt: CHOSEN },
    });
  });
}

/** Seeds a tenant that remembers `depth` retired passwords. */
async function seedWithHistory(depth: number): Promise<void> {
  await seed();
  await prisma.tenant.update({
    where: { id: tenantId },
    data: { passwordHistoryDepth: depth },
  });
}

const signIn = (now: Date) =>
  authorize(tenantId, {
    kind: 'primary',
    principal: { kind: 'password', login: 'jdoe', password: PASSWORD },
    applicationId: null,
    sourceIp: null,
    relyingParty: RP,
    scope: 'portal',
    now,
  });

beforeEach(async () => {
  await resetDatabase();
});

describe('password expiry', () => {
  it('lets a fresh password straight through', async () => {
    await seed({ passwordMaxAgeDays: 90 });

    const result = await signIn(new Date(CHOSEN.getTime() + 89 * DAY));
    expect(result.status).toBe('allow');
  });

  it('asks for a new password once the old one is past its age', async () => {
    await seed({ passwordMaxAgeDays: 90 });

    const result = await signIn(new Date(CHOSEN.getTime() + 91 * DAY));
    expect(result).toMatchObject({ status: 'renew' });
    if (result.status !== 'renew') throw new Error('unreachable');
    expect(result.attemptToken).toEqual(expect.any(String));
    expect(result.expiresAt.getTime()).toBeGreaterThan(
      CHOSEN.getTime() + 91 * DAY,
    );
  });

  it('never expires anything when the tenant has not set an age', async () => {
    await seed();

    // Ten years on. Zero means never, not "a very long time".
    const result = await signIn(new Date(CHOSEN.getTime() + 3650 * DAY));
    expect(result.status).toBe('allow');
  });

  it('leaves an account whose password lives upstream alone', async () => {
    await seed({ passwordMaxAgeDays: 90 });
    await withTenant(tenantId, (tx) =>
      tx.user.update({
        where: { id: userId },
        data: { passwordSource: 'upstream', passwordSourceHint: 'Contoso' },
      }),
    );

    // Syntra does not own this password and cannot be the thing that ages it
    // out; expiring it would strand the user with a form that changes nothing.
    const result = await signIn(new Date(CHOSEN.getTime() + 3650 * DAY));
    expect(result.status).toBe('allow');
  });

  it('records the expiry in the audit log', async () => {
    await seed({ passwordMaxAgeDays: 90 });

    await signIn(new Date(CHOSEN.getTime() + 91 * DAY));

    const event = await withTenant(tenantId, (tx) =>
      tx.auditEvent.findFirst({ where: { action: 'auth.password_expired' } }),
    );
    expect(event).toMatchObject({ targetId: userId });
  });
});

describe('password reuse', () => {
  const provider = localMasterKeyProvider(Buffer.alloc(32, 7));

  /** Signs in so there is a session id the change can preserve. */
  async function sessionFor(): Promise<string> {
    return withTenant(tenantId, async (tx) => {
      const { id } = await tx.session.create({
        data: {
          tenantId,
          userId,
          tokenHash: `t-${Math.random()}`,
          scope: 'portal',
          absoluteExpiresAt: new Date(Date.now() + 3600_000),
        },
      });
      return id;
    });
  }

  const change = async (from: string, to: string) =>
    changeOwnPassword(tenantId, provider, {
      userId,
      currentPassword: from,
      newPassword: to,
      sessionId: await sessionFor(),
      sourceIp: null,
    });

  it('refuses a password the user has already retired', async () => {
    await seedWithHistory(2);

    expect((await change(PASSWORD, 'a first replacement 111')).ok).toBe(true);
    // Back to the original, which is now one of the last two retired.
    expect(await change('a first replacement 111', PASSWORD)).toEqual({
      ok: false,
      reason: 'reused',
      depth: 2,
    });
  });

  it('forgets a password that has fallen off the end of the history', async () => {
    await seedWithHistory(1);

    expect((await change(PASSWORD, 'a first replacement 111')).ok).toBe(true);
    // Depth 1 remembers only the immediately previous password, so the
    // original has been forgotten by the time a second change happens.
    expect((await change('a first replacement 111', 'a second one 222')).ok).toBe(true);
    expect((await change('a second one 222', PASSWORD)).ok).toBe(true);
  });

  it('allows any reuse when the tenant keeps no history', async () => {
    await seedWithHistory(0);

    expect((await change(PASSWORD, 'a first replacement 111')).ok).toBe(true);
    expect((await change('a first replacement 111', PASSWORD)).ok).toBe(true);
  });

  it('stamps the change time so expiry runs from the new password', async () => {
    await seedWithHistory(0);

    await change(PASSWORD, 'a first replacement 111');

    const credential = await withTenant(tenantId, (tx) =>
      tx.passwordCredential.findUniqueOrThrow({ where: { userId } }),
    );
    // Not the seeded date: a change that left `changedAt` behind would expire
    // a password the user chose a moment ago.
    expect(credential.changedAt.getTime()).toBeGreaterThan(CHOSEN.getTime());
  });
});

/**
 * The other half of "must choose a new password", set by an administrator
 * rather than derived from the clock.
 *
 * Driven through `authorize` like the expiry tests above, and for the same
 * reason: the flag is worth nothing unless the one gate every sign-in path
 * shares actually consults it.
 */
describe('must-change', () => {
  it('sends a flagged credential to renewal even with expiry switched off', async () => {
    // No `passwordMaxAgeDays`, which is the default and the recommended
    // setting. A flag that only fired where scheduled expiry was on would be
    // a control that silently did nothing almost everywhere.
    await seed();
    await withTenant(tenantId, (tx) =>
      tx.passwordCredential.update({
        where: { userId },
        data: { mustChange: true },
      }),
    );

    const result = await signIn(new Date(CHOSEN.getTime() + DAY));

    expect(result).toMatchObject({ status: 'renew' });
  });

  it('is cleared by the password the user then chooses', async () => {
    await seed();
    await withTenant(tenantId, (tx) =>
      tx.passwordCredential.update({
        where: { userId },
        data: { mustChange: true },
      }),
    );

    // `setPasswordHash` defaults the option to false, so every caller that
    // represents the user choosing for themselves clears the flag by
    // construction rather than by remembering to.
    const chosen = await hashPassword('a-password-they-picked-themselves');
    await withTenant(tenantId, (tx) => setPasswordHash(tx, userId, chosen));

    const credential = await withTenant(tenantId, (tx) =>
      tx.passwordCredential.findUnique({ where: { userId } }),
    );
    expect(credential!.mustChange).toBe(false);
  });

  it('leaves an account whose password lives upstream alone', async () => {
    await seed();
    await withTenant(tenantId, async (tx) => {
      await tx.passwordCredential.update({
        where: { userId },
        data: { mustChange: true },
      });
      await tx.user.update({
        where: { id: userId },
        data: { passwordSource: 'upstream', passwordSourceHint: 'Contoso' },
      });
    });

    // Same reason expiry leaves them alone: a renewal form here changes
    // nothing at their provider, so demanding one strands them.
    const result = await signIn(new Date(CHOSEN.getTime() + DAY));

    expect(result.status).toBe('allow');
  });

  it('does not demand a renewal from an unflagged credential', async () => {
    await seed();

    const result = await signIn(new Date(CHOSEN.getTime() + DAY));

    expect(result.status).toBe('allow');
  });
});
