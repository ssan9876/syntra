import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactValue } from '@syntra/connectors';
import { buildInfo } from '@syntra/core';
import { createAgent } from './agent.js';
import { loadAgentConfig } from './config.js';
import { agentServer } from './http.js';
import { offsiteConfigFrom, s3Offsite } from './offsite.js';
import { pgTargetFrom, pgTools } from './postgres.js';
import { backupStore } from './store.js';

/**
 * The backup agent: restore points on a schedule, and backups, downloads,
 * uploads and restores on the API's request. It holds the one credential the
 * API must not -- a role that bypasses row-level security -- and the backup
 * volume. See docs/operate.md, "Backups".
 */

/** One JSON line per event, scrubbed the way the API's own log is. */
const line = (level: 'info' | 'warn' | 'error', fields: object, msg: string) =>
  process.stdout.write(
    `${JSON.stringify({ level, time: new Date().toISOString(), component: 'backup-agent', ...(redactValue(fields) as object), msg })}\n`,
  );
const log = {
  info: (fields: object, msg: string) => line('info', fields, msg),
  warn: (fields: object, msg: string) => line('warn', fields, msg),
  error: (fields: object, msg: string) => line('error', fields, msg),
};
const config = loadAgentConfig(process.env);
const superTarget = pgTargetFrom(config.superuserUrl);
const appTarget = pgTargetFrom(config.databaseUrl);
const pg = pgTools(superTarget, { container: config.pgContainer });
const store = backupStore(config.dir, pg);
const offsiteConfig = offsiteConfigFrom(process.env);
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

/**
 * `prisma migrate deploy` as the application role, from this release. The
 * binary itself, as the Helm migration Job runs it: `pnpm` wants a writable
 * home and store, and the chart's root filesystem is read-only.
 */
function migrate(): Promise<void> {
  const shadow = process.env['SHADOW_DATABASE_URL']?.trim();
  const dbPackage = join(repoRoot, 'packages', 'db');
  const prisma = join(dbPackage, 'node_modules', '.bin', process.platform === 'win32' ? 'prisma.cmd' : 'prisma');
  return new Promise((resolve, reject) => {
    const child = spawn(prisma, ['migrate', 'deploy'], {
      cwd: dbPackage,
      env: { ...process.env, DATABASE_URL: config.databaseUrl, ...(shadow ? { SHADOW_DATABASE_URL: shadow } : {}) },
      stdio: ['ignore', 'ignore', 'pipe'],
      shell: process.platform === 'win32',
    });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-4096);
    });
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`migrations failed: ${stderr.trim().split('\n').at(-1) ?? `exit ${code}`}`)),
    );
  });
}

const agent = createAgent({
  config,
  store,
  pg,
  version: buildInfo().version,
  database: superTarget.database,
  appRole: appTarget.user,
  superRole: superTarget.user,
  migrate,
  log,
  settleMs: config.settleMs,
  toolsFor: (database) => pgTools({ ...superTarget, database }, { container: config.pgContainer }),
  offsite: offsiteConfig ? s3Offsite(offsiteConfig) : null,
});
await agent.ready;

const server = agentServer(agent, store, config.token);
server.listen(config.port, config.host, () => {
  log.info(
    { host: config.host, port: config.port, dir: config.dir, intervalHours: config.intervalHours },
    'backup agent listening',
  );
});

// On the hour: a restore point every `intervalHours` hours, then a restore
// test when one is due. The test waits for the next hour if the backup is
// still running.
const tick = () => {
  const at = new Date();
  if (config.intervalHours > 0 && at.getUTCHours() % config.intervalHours === 0) agent.scheduled();
  agent.verifyIfDue();
};
const msToNextHour = 3_600_000 - (Date.now() % 3_600_000);
setTimeout(() => {
  tick();
  setInterval(tick, 3_600_000).unref();
}, msToNextHour).unref();

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    log.info({ signal }, 'backup agent stopping');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}
