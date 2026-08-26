/**
 * Whether this tenant carries the seed's own markers.
 *
 * Extracted so it can be tested without running a seed, and narrowed from what
 * it replaced.
 *
 * The old guard was `findFirst({ where: { login: 'admin' } })`. The
 * integration suite creates a user called `admin` in several fixtures and
 * truncates between cases rather than after them, so one is very often sitting
 * there when somebody runs `pnpm seed` -- which then reported the tenant
 * already seeded, did nothing, and left the browser tests looking at a
 * directory with no people in it. `e2e/README.md` tells operators to run
 * `db:reset` first, and that habit exists to work around exactly this.
 *
 * `builtInRole` is what makes the answer honest. `Role.builtIn` is written by
 * the seed and by nothing else: every fixture in the repository calls
 * `createRole(tx, name, permissions)` with no options, and `builtIn` defaults
 * to false. Requiring BOTH markers means a half-seeded tenant reads as not
 * seeded, which is the safe direction -- the create path is idempotent per row
 * and a leftover fragment is better re-created than skipped.
 */
export function seedMarkerFound(markers: {
  adminUser: boolean;
  builtInRole: boolean;
}): boolean {
  return markers.adminUser && markers.builtInRole;
}
