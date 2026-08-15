import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import type { Config, Scheduler } from '@syntra/core';
import { registerProblemJson } from './plugins/problem-json.js';
import { registerTenantContext } from './plugins/tenant-context.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerAdminUserRoutes } from './routes/admin/users.js';
import { registerAdminGroupRoutes } from './routes/admin/groups.js';
import { registerAdminOrgUnitRoutes } from './routes/admin/org-units.js';
import { registerAdminPersonRoutes } from './routes/admin/persons.js';
import { registerAdminAuditRoutes } from './routes/admin/audit.js';
import { registerAdminSourceRoutes } from './routes/admin/sources.js';
import { registerAdminSyncRunRoutes } from './routes/admin/sync-runs.js';

export interface AppOptions {
  logger?: boolean;
  /**
   * How the source routes reach the job scheduler, so a source created,
   * changed or deleted is rescheduled there and then rather than at the next
   * restart.
   *
   * A function, not a `Scheduler`, because the scheduler is started after the
   * app is built — it needs the app's logger, and it is allowed to fail to
   * start without keeping the API down. Omitted, source mutations simply do
   * not touch any scheduler, which is what the tests that do not care want.
   */
  scheduler?: () => Scheduler | null;
}

export async function buildApp(
  config: Config,
  options: AppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger === false ? false : { level: process.env.LOG_LEVEL ?? 'info' },
  });

  await app.register(cookie, { secret: config.sessionSecret });
  // Off by default; applied per route, since a blanket limit would throttle
  // ordinary reads as hard as password attempts.
  await app.register(rateLimit, { global: false });

  registerProblemJson(app);
  registerTenantContext(app);

  app.get('/health', async () => ({ status: 'ok' }));

  await app.register(registerAuthRoutes, {
    prefix: '/api/auth',
    authRateLimitMax: config.authRateLimitMax,
    publicUrl: config.publicUrl,
  });

  // Every route below requires an administrative session; the guard is
  // applied inside each plugin so a new admin route cannot forget it.
  await app.register(registerAdminUserRoutes, { prefix: '/api/admin' });
  await app.register(registerAdminGroupRoutes, { prefix: '/api/admin' });
  await app.register(registerAdminOrgUnitRoutes, { prefix: '/api/admin' });
  await app.register(registerAdminPersonRoutes, { prefix: '/api/admin' });
  await app.register(registerAdminAuditRoutes, { prefix: '/api/admin' });
  await app.register(registerAdminSourceRoutes, {
    prefix: '/api/admin',
    masterKey: config.masterKey,
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
  });
  await app.register(registerAdminSyncRunRoutes, { prefix: '/api/admin' });

  return app;
}
