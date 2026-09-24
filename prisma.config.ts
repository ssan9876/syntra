import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// The datasource URL is read from the environment only when present.
// `prisma/config`'s `env()` throws when the variable is unset, and
// `prisma generate` -- run in the image build, where no database exists --
// needs no connection at all. Commands that do connect (`migrate deploy`,
// `migrate dev`) still fail with Prisma's own "datasource url" error when it
// is missing.
const url = process.env['DATABASE_URL'];

export default defineConfig({
  schema: 'packages/db/prisma/schema.prisma',
  migrations: {
    path: 'packages/db/prisma/migrations',
    seed: 'node --env-file-if-exists=.env --import tsx packages/db/src/seed.ts',
  },
  datasource: {
    ...(url ? { url } : {}),
    // The application role deliberately lacks CREATEDB. Development uses the
    // separately provisioned shadow database when one is configured.
    ...(process.env['SHADOW_DATABASE_URL']
      ? { shadowDatabaseUrl: process.env['SHADOW_DATABASE_URL'] }
      : {}),
  },
});
