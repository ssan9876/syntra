import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const connectionString = process.env['DATABASE_URL'];
if (!connectionString) {
  throw new Error('DATABASE_URL is required to initialize the database client.');
}

// Prisma 6 understood `connection_limit` itself. Prisma 7 delegates pooling to
// node-postgres, whose equivalent is `max` and which must not receive the old
// query parameter as a PostgreSQL startup option.
const databaseUrl = new URL(connectionString);
const configuredLimit = Number.parseInt(
  databaseUrl.searchParams.get('connection_limit') ?? '',
  10,
);
databaseUrl.searchParams.delete('connection_limit');

const adapter = new PrismaPg(
  {
    connectionString: databaseUrl.toString(),
    ...(Number.isInteger(configuredLimit) && configuredLimit > 0
      ? { max: configuredLimit }
      : {}),
  },
  {
    // node-postgres emits idle connection failures as EventEmitter errors.
    // Supplying callbacks prevents an unrelated idle socket from terminating
    // the process; requests using a failed connection still reject normally.
    onPoolError: (error) => {
      process.stderr.write(`PostgreSQL pool error: ${error.message}\n`);
    },
    onConnectionError: (error) => {
      process.stderr.write(`PostgreSQL connection error: ${error.message}\n`);
    },
  },
);

export const prisma = new PrismaClient({ adapter });
export type { Prisma } from '@prisma/client';
