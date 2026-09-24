import { defineConfig } from 'prisma/config';

// What `dotenv/config` did -- the working directory's `.env`, never overriding
// a variable already set -- with Node's own loader. `dotenv` is not a
// dependency of this package, so the pruned image's `prisma` binary, run
// directly by the Helm migrate job, could not resolve the import and failed
// before reading anything.
try {
  process.loadEnvFile('.env');
} catch {
  // No `.env` here: production passes the environment in.
}

// HERE, in `packages/db`, and not at the repository root, on purpose.
//
// Prisma 7 takes the datasource URL from this file instead of from
// `schema.prisma`, and the CLI discovers the file only in its working
// directory. Every production caller runs the CLI from `packages/db`:
// `pnpm --filter @syntra/db exec prisma …` in `ops/syntra-update`, the Helm
// migrate job (`workingDir: /app/packages/db`), and the image's
// `pnpm --filter @syntra/db migrate`. With the file at the root, each of them
// found no URL and every migration failed -- and the updater that runs an
// upgrade is the one ALREADY INSTALLED, so fixing the command line in the new
// release could never have reached it. Next to the schema it is found without
// a `--config` flag by old callers and new alike.
//
// Paths are relative to this file.
//
// The datasource URL is read from the environment only when present:
// `prisma/config`'s `env()` throws when the variable is unset, and
// `prisma generate` -- run in the image build, where no database exists --
// needs no connection at all. Commands that do connect (`migrate deploy`,
// `migrate dev`) still fail with Prisma's own "datasource url" error when it
// is missing.
const url = process.env['DATABASE_URL'];

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'node --env-file-if-exists=../../.env --env-file-if-exists=.env --import tsx src/seed.ts',
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
