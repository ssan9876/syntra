import type { TenantClient } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import { isAdministrator } from '../rbac/rbac-service.js';
import { hashPassword, verifyPassword } from './password.js';

export interface AuthenticateInput {
  login: string;
  password: string;
  sourceIp: string | null;
}

export type AuthFailure = 'invalid_credentials' | 'user_inactive';

export type AuthResult =
  | { ok: true; userId: string; mayElevate: boolean }
  | { ok: false; reason: AuthFailure };

/**
 * A hash of a value nobody knows, verified against when the login is unknown
 * or has no credential, so that a missing user costs the same time as a wrong
 * password. Without it, response timing alone discloses which logins exist.
 *
 * Computed once at module load rather than per request.
 */
const DUMMY_HASH_PROMISE = hashPassword(
  `absent-user-${Math.random()}-${Date.now()}`,
);

/**
 * The single authentication chokepoint.
 *
 * Every path that establishes who the caller is goes through here, and every
 * outcome is audited from one place. The Access module extends this function
 * with policy evaluation and second factors; it does not add a parallel route,
 * because a second entry point is where a policy bypass would hide.
 */
export async function authenticate(
  tx: TenantClient,
  input: AuthenticateInput,
): Promise<AuthResult> {
  const user = await tx.user.findFirst({ where: { login: input.login } });

  if (!user) {
    await verifyPassword(await DUMMY_HASH_PROMISE, input.password);
    await audit(tx, null, input, 'failure', 'invalid_credentials');
    return { ok: false, reason: 'invalid_credentials' };
  }

  const credential = await tx.passwordCredential.findUnique({
    where: { userId: user.id },
  });
  const passwordOk = credential
    ? await verifyPassword(credential.hash, input.password)
    : await verifyPassword(await DUMMY_HASH_PROMISE, input.password);

  if (!passwordOk) {
    await audit(tx, user.id, input, 'failure', 'invalid_credentials');
    return { ok: false, reason: 'invalid_credentials' };
  }

  // Checked after the password, so a disabled account cannot be probed
  // without also knowing its password.
  if (user.status !== 'active') {
    await audit(tx, user.id, input, 'failure', 'user_inactive');
    return { ok: false, reason: 'user_inactive' };
  }

  const mayElevate = await isAdministrator(tx, user.id);
  await audit(tx, user.id, input, 'success', null);
  return { ok: true, userId: user.id, mayElevate };
}

async function audit(
  tx: TenantClient,
  userId: string | null,
  input: AuthenticateInput,
  outcome: 'success' | 'failure',
  reason: AuthFailure | null,
): Promise<void> {
  await recordEvent(tx, {
    actorUserId: userId,
    action: 'auth.login',
    targetType: 'User',
    targetId: userId,
    outcome,
    sourceIp: input.sourceIp,
    // The login is recorded; the password never is, not even hashed.
    payload: reason
      ? { login: input.login, reason }
      : { login: input.login },
  });
}
