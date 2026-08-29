import { prisma } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { loadConfig, memoryTransport } from '@syntra/core';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';

const TEST_HOST = 'acme.syntra.test';

let app: Awaited<ReturnType<typeof buildApp>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/**
 * `/health` and `/health/ready` are polled every few seconds by a container
 * orchestrator (and, mid-update, by the updater's own readiness poll), which
 * at `info` level buried one real request under a page of liveness noise.
 * This asserts the fix directly against Fastify's own request-logging
 * lines, not against a mock — a hook that merely stubbed `request.log`
 * would pass whether or not the real `incoming request` / `request
 * completed` lines were actually suppressed.
 */
describe('request logging', () => {
  it('is silent for /health and /health/ready, but logs everything else', async () => {
    await resetDatabase();
    await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });

    const config = loadConfig({
      DATABASE_URL:
        process.env.DATABASE_URL ??
        'postgresql://syntra_app:syntra_app@localhost:5432/syntra',
      PORT: '3000',
      PUBLIC_URL: `http://${TEST_HOST}`,
      SESSION_SECRET: 'x'.repeat(32),
      MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
      SMTP_URL: 'smtp://localhost:1025',
      OUTBOUND_ALLOW_PRIVATE: 'true',
      GOVERN_CHECKPOINT_KEY: Buffer.alloc(32, 11).toString('base64'),
    });

    const lines: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    // The default pino logger this app builds with (`options.logger`
    // unset) writes NDJSON straight to stdout with no seam of its own to
    // intercept, so this is the only way to see what it actually emitted.
    process.stdout.write = ((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      app = await buildApp(config, { transport: memoryTransport() });
      await app.ready();

      await app.inject({ method: 'GET', url: '/health' });
      await app.inject({ method: 'GET', url: '/health/ready' });
      // An unscoped route that isn't a health check, so this line proves
      // the suppression is specific to /health rather than the logger
      // having been turned off altogether.
      await app.inject({
        method: 'GET',
        url: '/api/branding',
        headers: { host: TEST_HOST },
      });
    } finally {
      process.stdout.write = originalWrite;
    }

    const records = lines
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { msg?: string; req?: { url?: string }; res?: unknown });

    const healthLines = records.filter((r) => r.req?.url?.startsWith('/health'));
    expect(healthLines).toHaveLength(0);

    const brandingLines = records.filter(
      (r) => r.msg === 'incoming request' || r.msg === 'request completed',
    );
    expect(brandingLines.length).toBeGreaterThan(0);
  });
});
