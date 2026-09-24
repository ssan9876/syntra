# Prisma 7 and TypeScript 6 runtime notes

Syntra uses Prisma ORM 7 with the PostgreSQL driver adapter and TypeScript 6.

- Prisma CLI settings live in `prisma.config.ts`; package scripts pass that
  path explicitly because pnpm runs database scripts from `packages/db`.
- Runtime connections use `@prisma/adapter-pg`. The legacy
  `connection_limit` URL option is translated to node-postgres's `max` pool
  option before the connection string reaches PostgreSQL.
- Idle pool and connection errors are observed so a failed idle socket cannot
  terminate the API process. A query using a failed connection still rejects.
- The application and test runners must provide `DATABASE_URL` before importing
  `@syntra/db`.

The full migration verification covered 306 test files and 5,480 tests. The
suite currently emits node-postgres's deprecation warning when a few existing
interactive transaction callbacks start concurrent queries on one client.
That behavior remains supported by pg 8, but must be made sequential before a
future pg 9 upgrade.
