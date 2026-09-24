/**
 * `pnpm openapi:generate` — writes `docs/api/openapi.json`.
 *
 * Builds the real application and asks it for the document, rather than
 * assembling one from the descriptions alone: the permission, token and
 * rate-limit facts in the document come from the route table the application
 * registers, and there is no route table without an application.
 *
 * Nothing here reaches a database or the network. `buildApp` connects
 * lazily, the document is built from registration-time facts only, and the
 * request goes through `inject` — so this runs in CI with no Postgres, which
 * is what lets the freshness check be a cheap job of its own. The
 * configuration below is placeholder: none of it can appear in the output,
 * because nothing in the output is read from configuration.
 *
 * `--check` compares instead of writing and exits 1 on a difference, for a
 * local pre-push check; CI uses `git diff --exit-code` after generating, which
 * also catches a document nobody committed at all.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, memoryTransport } from '@syntra/core';
import { buildApp } from '../app.js';
import { OPENAPI_PATH } from './route.js';

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, '../../../../docs/api/openapi.json');

const config = loadConfig({
  DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/unused',
  PORT: '3000',
  PUBLIC_URL: 'https://syntra.example.com',
  SESSION_SECRET: 'x'.repeat(32),
  MASTER_KEY: Buffer.alloc(32, 0).toString('base64'),
  SMTP_URL: 'smtp://127.0.0.1:1',
  // The document route is rate-limited, and the default store counts in
  // Postgres. There is no Postgres here, and the limiter fails closed, so a
  // database-backed count would turn the one request this makes into a 500.
  RATE_LIMIT_STORE: 'memory',
});

const app = await buildApp(config, { logger: false, transport: memoryTransport() });
try {
  await app.ready();
  const response = await app.inject({ method: 'GET', url: OPENAPI_PATH });
  if (response.statusCode !== 200) {
    throw new Error(`${OPENAPI_PATH} answered ${response.statusCode}: ${response.body}`);
  }

  if (process.argv.includes('--check')) {
    const committed = await readFile(target, 'utf8').catch(() => '');
    if (committed.replace(/\r\n/g, '\n') !== response.body) {
      console.error(`${target} is out of date. Run \`pnpm openapi:generate\` and commit the result.`);
      process.exitCode = 1;
    } else {
      console.log(`${target} is up to date.`);
    }
  } else {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, response.body);
    const operations = Object.values(
      (JSON.parse(response.body) as { paths: Record<string, object> }).paths,
    ).reduce((count, methods) => count + Object.keys(methods).length, 0);
    console.log(`Wrote ${target} (${operations} operations).`);
  }
} finally {
  await app.close();
}
