/**
 * Whether this invocation may empty the database it is pointed at.
 *
 * Separated from `reset.ts` so it can be tested without a process that
 * exits, and inverted from what it replaced.
 *
 * The old guard refused when `NODE_ENV === 'production'` -- a variable
 * NOTHING in the lab deployment sets. Not the systemd unit, not
 * `.env.example`, not `packages/db/.env.example`. It therefore passed on
 * the one machine holding real data, where `e2e/README.md` tells operators
 * to run `pnpm db:reset && pnpm seed` as a habit and the checkout sits at
 * the same path it does on a developer's machine.
 *
 * It cannot be fixed by naming safe databases either: the development
 * database and the lab database are BOTH called `syntra`. Nothing about the
 * connection string separates them.
 *
 * So the answer is no, unless the operator names the database they mean. A
 * new environment is then safe by default rather than dangerous by default,
 * which is the direction a `TRUNCATE ... CASCADE` should fail in.
 */

/**
 * The per-worker databases the suite provisions for itself
 * (`syntra_test_<hash>_w<n>`, see `test-database.ts`). Emptying one is their
 * entire purpose, and demanding a ceremony for them would put the ceremony
 * in CI instead of in front of the person who needs it.
 */
export const SCRATCH_DATABASE = /^syntra_test_/;

export type ResetDecision =
  | { allow: true; database: string }
  | { allow: false; reason: string };

function databaseName(databaseUrl: string | undefined): string | null {
  if (databaseUrl === undefined || databaseUrl === '') return null;
  try {
    const name = new URL(databaseUrl).pathname.slice(1);
    return name === '' ? null : name;
  } catch {
    return null;
  }
}

export function resetDecision(input: {
  databaseUrl: string | undefined;
  allowVar: string | undefined;
}): ResetDecision {
  const database = databaseName(input.databaseUrl);

  if (database === null) {
    return {
      allow: false,
      reason:
        'DATABASE_URL is unset or names no database, so there is nothing this could safely empty.',
    };
  }

  if (SCRATCH_DATABASE.test(database)) {
    return { allow: true, database };
  }

  // THE EXACT NAME, not a truthy flag. `SYNTRA_ALLOW_RESET=1` is the shape
  // that gets copied between checkouts and pasted into a shell on the wrong
  // machine; typing the database out is the part that makes somebody look at
  // which one they are pointed at.
  if (input.allowVar === database) {
    return { allow: true, database };
  }

  return {
    allow: false,
    reason:
      `Refusing to empty "${database}": it is not a scratch test database, and nothing ` +
      `said to empty this one.\n` +
      `The development database and the lab database are both named "syntra", so the name ` +
      `alone cannot tell them apart -- check which host this DATABASE_URL points at.\n` +
      `If you are certain, re-run with SYNTRA_ALLOW_RESET=${database}`,
  };
}
