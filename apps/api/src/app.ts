import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import type { Config } from '@syntra/core';
import { registerProblemJson } from './plugins/problem-json.js';
import { registerTenantContext } from './plugins/tenant-context.js';
import { registerAuthRoutes } from './routes/auth.js';

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

  return app;
}
