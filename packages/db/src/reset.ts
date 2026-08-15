/**
 * Empties every application table.
 *
 * The integration tests truncate between cases and leave whatever the last
 * one created behind — often a tenant named `acme` holding an `admin` user.
 * That is enough to fool the seed's idempotence guard into reporting the
 * tenant as already seeded and doing nothing, which leaves the browser tests
 * looking at a directory with no people in it.
 *
 * Refuses to run when NODE_ENV is production.
 */
import { prisma } from './client.js';
import { resetDatabase } from './test-support.js';

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to reset a production database.');
  process.exit(1);
}

await resetDatabase();
console.log('Database emptied. Run `pnpm seed` next.');
await prisma.$disconnect();
