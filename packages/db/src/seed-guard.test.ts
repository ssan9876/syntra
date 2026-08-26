import { describe, expect, it } from 'vitest';
import { seedMarkerFound } from './seed-guard.js';

/**
 * What "already seeded" means.
 *
 * It used to mean `findFirst({ where: { login: 'admin' } })`, which the
 * integration suite satisfies constantly: several of its fixtures create a
 * user called `admin`. So `pnpm seed` reported "already seeded", did nothing,
 * and the browser tests then looked at a directory with no people in it --
 * which is why `e2e/README.md` tells operators to run `db:reset` first, a
 * habit that exists to work around this.
 */
describe('seedMarkerFound', () => {
  /**
   * BOTH markers, and the built-in role is the one that does the work: only
   * the seed writes `builtIn: true`. Every test fixture in the repository
   * creates roles with `createRole(tx, name, perms)` and no options, so
   * `builtIn` is false on all of them.
   */
  it('is true only when both the seed own markers are present', () => {
    expect(seedMarkerFound({ adminUser: true, builtInRole: true })).toBe(true);
  });

  it('is false for a leftover fixture user with no built-in role', () => {
    expect(seedMarkerFound({ adminUser: true, builtInRole: false })).toBe(false);
  });

  it('is false for a half-seeded tenant', () => {
    expect(seedMarkerFound({ adminUser: false, builtInRole: true })).toBe(false);
    expect(seedMarkerFound({ adminUser: false, builtInRole: false })).toBe(false);
  });
});
