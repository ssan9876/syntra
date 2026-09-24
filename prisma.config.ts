import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'packages/db/prisma/schema.prisma',
  migrations: {
    path: 'packages/db/prisma/migrations',
    seed: 'node --env-file-if-exists=.env --import tsx packages/db/src/seed.ts',
  },
  datasource: {
    url: env('DATABASE_URL'),
    // The application role deliberately lacks CREATEDB. Development uses the
    // separately provisioned shadow database when one is configured.
    ...(process.env['SHADOW_DATABASE_URL']
      ? { shadowDatabaseUrl: process.env['SHADOW_DATABASE_URL'] }
      : {}),
  },
});
