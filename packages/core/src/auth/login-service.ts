import { withTenant, type TenantClient } from '@syntra/db';
import { recordEvent } from '../audit/audit-service.js';
import { isAdministrator } from '../rbac/rbac-service.js';
import { hashPassword, verifyPassword } from './password.js';
import {
  clearLockout,
  isLocked,
  readLockout,
  recordFailure,
} from './login-lockout.js';

export interface AuthenticateInput {
  login: string;
  password: string;
  sourceIp: string | null;
  /** Injectable for tests; the lockout window and duration are read against it. */
  now?: Date;
}

export type AuthFailure =
  | 'invalid_credentials'
  | 'user_inactive'
  | 'account_locked';

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
 *
 * It takes a tenantId rather than a caller's transaction, and opens one per
 * phase, for the same reason `authorize()` does: Argon2id is deliberately
 * expensive — tens of milliseconds by design, and far more on a loaded box —
 * and Prisma's interactive transactions abort at 5000 ms. Hashing inside one
 * turns a slow moment into a rolled-back transaction rather than a slow login,
 * and it holds a connection from the pool for the whole of it on the hottest
 * path there is. The dummy verification below costs exactly as much, so an
 * unknown login would hold one just as long.
 */
export async function authenticate(
  tenantId: string,
  input: AuthenticateInput,
): Promise<AuthResult> {
  // Phase 1 — read the user and their stored hash. A transaction, and a short
  // one: two indexed reads and nothing else.
  const now = input.now ?? new Date();
  const found = await withTenant(tenantId, async (tx) => {
    const user = await tx.user.findFirst({ where: { login: input.login } });
    if (!user) return null;
    const credential = await tx.passwordCredential.findUnique({
      where: { userId: user.id },
    });
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    return {
      user,
      hash: credential?.hash ?? null,
      lockout: await readLockout(tx, user.id),
      policy: {
        threshold: tenant.lockoutThreshold,
        windowMinutes: tenant.lockoutWindowMinutes,
        durationMinutes: tenant.lockoutDurationMinutes,
      },
    };
  });

  // Phase 2 — Argon2id, outside every transaction.
  //
  // An unknown login and a user with no credential both verify against the
  // dummy hash, so all three paths cost the same. `verified` is deliberately
  // not trusted on its own: a dummy verification that somehow returned true
  // must not authenticate anybody, so the presence of a real stored hash is a
  // separate condition rather than an assumption about what Argon2 returns.
  const verified = await verifyPassword(
    found?.hash ?? (await DUMMY_HASH_PROMISE),
    input.password,
  );
  const passwordOk = Boolean(found?.hash) && verified;

  // Phase 3 — record the outcome, and for a success read the administrator
  // flag alongside it.
  if (!found) {
    await withTenant(tenantId, (tx) =>
      audit(tx, null, input, 'failure', 'invalid_credentials'),
    );
    return { ok: false, reason: 'invalid_credentials' };
  }

  if (!passwordOk) {
    await withTenant(tenantId, async (tx) => {
      await recordFailure(tx, {
        tenantId,
        userId: found.user.id,
        login: input.login,
        sourceIp: input.sourceIp,
        policy: found.policy,
        now,
      });
      await audit(tx, found.user.id, input, 'failure', 'invalid_credentials');
    });
    return { ok: false, reason: 'invalid_credentials' };
  }

  // Checked after the password, for the same reason the inactive check below
  // is: told to anyone who asks, a lock is a way to find out that a login
  // exists. Somebody who supplied the right password has already proved they
  // know it, and is owed the real reason they are not getting in.
  //
  // The Argon2 verification above ran either way, so a locked account costs
  // exactly what an unlocked one costs and the refusal leaks no timing.
  if (isLocked(found.lockout, now)) {
    await withTenant(tenantId, (tx) =>
      audit(tx, found.user.id, input, 'failure', 'account_locked'),
    );
    return { ok: false, reason: 'account_locked' };
  }

  // Checked after the password, so a disabled account cannot be probed
  // without also knowing its password.
  if (found.user.status !== 'active') {
    await withTenant(tenantId, (tx) =>
      audit(tx, found.user.id, input, 'failure', 'user_inactive'),
    );
    return { ok: false, reason: 'user_inactive' };
  }

  const mayElevate = await withTenant(tenantId, async (tx) => {
    const admin = await isAdministrator(tx, found.user.id);
    // The run of failures ends here. Anything less — decrementing, ageing the
    // count out — leaves an account one bad morning away from a lock it did
    // not earn.
    await clearLockout(tx, found.user.id);
    await audit(tx, found.user.id, input, 'success', null);
    return admin;
  });
  return { ok: true, userId: found.user.id, mayElevate };
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
