import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

/**
 * Builds the client on first use rather than at import.
 *
 * Prisma 6 read `DATABASE_URL` when it first connected, so importing
 * `@syntra/db` never needed one. Several things rely on that: the OpenAPI
 * generator builds the whole application without a database, and the image
 * build imports modules long before any configuration exists. Throwing at
 * import turned each of them into a crash. Failing on first query keeps the
 * same clear message for the case that matters -- a process that actually
 * talks to the database with no URL configured.
 */
function createClient(): PrismaClient {
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

  return new PrismaClient({ adapter });
}

let client: PrismaClient | undefined;
const real = (): PrismaClient => (client ??= createClient());

/**
 * The shared client. A proxy so every existing `prisma.x` call site is
 * unchanged: the first access builds the real client, and methods are bound
 * to it so `this` inside Prisma is the client, not the proxy.
 *
 * Writes go to the real client too. Tests swap a method by assignment
 * (`prisma.$queryRawUnsafe = …` to simulate an outage, a wrapped
 * `$transaction` to count transactions) and restore it the same way; stored
 * on the proxy's placeholder instead, the swap would silently do nothing.
 */
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, property) {
    const target = real();
    const value: unknown = Reflect.get(target, property, target);
    return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
  },
  set(_target, property, value) {
    return Reflect.set(real(), property, value);
  },
  has(_target, property) {
    return Reflect.has(real(), property);
  },
  deleteProperty(_target, property) {
    return Reflect.deleteProperty(real(), property);
  },
});

export type { Prisma } from '@prisma/client';
