/**
 * Empties every application table.
 *
 * The integration tests truncate between cases and leave whatever the last
 * one created behind -- often a tenant named `acme` holding an `admin` user.
 * That is enough to fool the seed's idempotence guard into reporting the
 * tenant as already seeded and doing nothing, which leaves the browser tests
 * looking at a directory with no people in it.
 *
 * `reset-guard.ts` decides whether this is allowed to run at all, and says
 * why it is shaped the way it is.
 */
import { prisma } from './client.js';
import { resetDecision } from './reset-guard.js';
import { resetDatabase } from './test-support.js';

const decision = resetDecision({
  databaseUrl: process.env.DATABASE_URL,
  allowVar: process.env.SYNTRA_ALLOW_RESET,
});

if (!decision.allow) {
  console.error(decision.reason);
  process.exit(1);
}

// What is about to go, counted before it goes. An operator who has pointed
// this at the wrong host is not helped by the database's NAME -- both are
// `syntra` -- but is stopped in their tracks by a four-figure audit count
// where they expected a seed.
const [tenants, users, auditEvents] = await Promise.all([
  prisma.tenant.count(),
  prisma.user.count(),
  prisma.auditEvent.count(),
]);

console.log(
  `Emptying "${decision.database}": ${tenants} tenant(s), ${users} user(s), ` +
    `${auditEvents} audit event(s).`,
);

await resetDatabase();
console.log('Database emptied. Run `pnpm seed` next.');
await prisma.$disconnect();
