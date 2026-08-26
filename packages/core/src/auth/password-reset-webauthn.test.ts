import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { createUser } from '../directory/user-service.js';
import { memoryTransport } from '../notify/notification-service.js';
import { hashPassword, setPasswordHash } from './password.js';
import { requestPasswordReset, userForResetToken } from './password-reset.js';

let tenantId: string;
let userId: string;
let mail: ReturnType<typeof memoryTransport>;

// Hashed once for the file, outside every transaction: Argon2id is
// deliberately expensive and has no business inside Prisma's 5000 ms budget.
const PASSWORD_HASH = await hashPassword('correct horse battery staple');

/**
 * The raw token, which `requestPasswordReset` deliberately never returns: it
 * goes to the account owner's inbox and nowhere else. The memory transport is
 * where a test reads it from, exactly as a person reads it from their mail
 * client.
 */
const tokenFromMail = (): string => {
  const body = mail.sent.at(-1)!.text;
  return new URL(body.match(/https?:\/\/\S+/)![0]).searchParams.get('token')!;
};

const issue = async () => {
  mail = memoryTransport();
  await requestPasswordReset(tenantId, mail, 'https://acme.test', {
    login: 'jdoe',
    sourceIp: null,
    // Nothing here is about timing, and the 250 ms floor is a quarter of a
    // second per case for no benefit.
    floorMs: 0,
  });
  return tokenFromMail();
};

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
  userId = await withTenant(tenantId, async (tx) => {
    const user = await createUser(tx, {
      login: 'jdoe',
      email: 'j@acme.test',
      displayName: 'J Doe',
    });
    await setPasswordHash(tx, user.id, PASSWORD_HASH);
    return user.id;
  });
});

/**
 * The lookup a reset-scoped WebAuthn challenge is built on.
 *
 * A passkey-only user could not complete a reset at all: `completePasswordReset`
 * verifies the assertion against a stored challenge, and the only endpoint that
 * minted one required a live `AuthAttempt`. The reset flow holds a
 * `PasswordResetToken`, so the lookup always missed and the route answered 401
 * -- a hard lockout for anybody whose only factor is a passkey and whose
 * recovery codes are spent.
 */
describe('userForResetToken', () => {
  it('names the user a live token belongs to', async () => {
    expect(await userForResetToken(tenantId, await issue())).toBe(userId);
  });

  it('refuses an unknown token', async () => {
    expect(await userForResetToken(tenantId, 'not-a-token')).toBeNull();
  });

  /**
   * A CONSUMED token must not mint a challenge either. It is spent the moment
   * a reset completes, and a challenge issued after that is a credential
   * outliving the thing that authorised it.
   */
  it('refuses a token that has already been spent', async () => {
    const token = await issue();
    await withTenant(tenantId, (tx) =>
      tx.passwordResetToken.updateMany({
        where: { userId },
        data: { consumedAt: new Date() },
      }),
    );
    expect(await userForResetToken(tenantId, token)).toBeNull();
  });

  it('refuses an expired token', async () => {
    const token = await issue();
    const anHourOn = new Date(Date.now() + 60 * 60 * 1000);
    expect(await userForResetToken(tenantId, token, anHourOn)).toBeNull();
  });
});
