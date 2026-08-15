export type PasswordCheck =
  | { ok: true }
  | { ok: false; reason: 'too_short' | 'too_long' | 'too_obvious' };

export interface PasswordPolicyOptions {
  minLength: number;
  login: string;
  email: string;
}

/**
 * The tenant password policy, such as it is: a length floor, a length ceiling
 * and three refusals that catch the passwords people actually pick when told to
 * pick one.
 *
 * The ceiling is not arbitrary. Argon2id's cost is proportional to input, and
 * an unbounded password field is a way to spend a server's memory on demand.
 */
export function validateNewPassword(
  password: string,
  opts: PasswordPolicyOptions,
): PasswordCheck {
  // Code points, not UTF-16 units: a password of twelve emoji is twelve
  // characters to the person who typed it.
  const length = [...password].length;
  if (length < opts.minLength) return { ok: false, reason: 'too_short' };
  if (password.length > 1024) return { ok: false, reason: 'too_long' };

  const lowered = password.toLowerCase();
  const localPart = opts.email.split('@')[0] ?? '';
  if (lowered === opts.login.toLowerCase()) return { ok: false, reason: 'too_obvious' };
  if (localPart && lowered === localPart.toLowerCase()) {
    return { ok: false, reason: 'too_obvious' };
  }
  if (new Set([...password]).size === 1) return { ok: false, reason: 'too_obvious' };

  return { ok: true };
}
