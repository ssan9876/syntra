import { prisma } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { loadConfig } from '@syntra/core';
import { buildApp } from './app.js';

export const TEST_HOST = 'acme.syntra.test';

/**
 * A fresh app against an empty database with one tenant. Logging is off so a
 * deliberately provoked 500 does not print a stack trace into the test output.
 */
export async function buildTestApp() {
  await resetDatabase();
  const tenant = await prisma.tenant.create({
    data: { name: 'Acme', slug: 'acme' },
  });

  const config = loadConfig({
    DATABASE_URL:
      process.env.DATABASE_URL ??
      'postgresql://syntra_app:syntra_app@localhost:5432/syntra',
    PORT: '3000',
    PUBLIC_URL: `http://${TEST_HOST}`,
    SESSION_SECRET: 'x'.repeat(32),
    MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
    SMTP_URL: 'smtp://localhost:1025',
  });

  const app = await buildApp(config, { logger: false });
  return { app, tenantId: tenant.id, host: TEST_HOST };
}
