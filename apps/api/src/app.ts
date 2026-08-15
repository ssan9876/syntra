import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import type { Config } from '@syntra/core';
import { registerProblemJson } from './plugins/problem-json.js';
import { registerTenantContext } from './plugins/tenant-context.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerAdminUserRoutes } from './routes/admin/users.js';
import { registerAdminGroupRoutes } from './routes/admin/groups.js';
import { registerAdminOrgUnitRoutes } from './routes/admin/org-units.js';

export interface AppOptions {
  logger?: boolean;
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

  await app.register(registerAuthRoutes, { prefix: '/api/auth' });

  // Every route below requires an administrative session; the guard is
  // applied inside each plugin so a new admin route cannot forget it.
  await app.register(registerAdminUserRoutes, { prefix: '/api/admin' });
  await app.register(registerAdminGroupRoutes, { prefix: '/api/admin' });
  await app.register(registerAdminOrgUnitRoutes, { prefix: '/api/admin' });

  return app;
}
