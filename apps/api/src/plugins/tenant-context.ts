import type { FastifyInstance, FastifyRequest } from 'fastify';
import { prisma, withTenant, type TenantClient } from '@syntra/db';
import { ProblemError } from './problem-json.js';

declare module 'fastify' {
  interface FastifyRequest {
    tenantId: string;
    db<T>(fn: (tx: TenantClient) => Promise<T>): Promise<T>;
  }
}

/** Routes that answer before a tenant is known. */
const UNSCOPED_PATHS = new Set(['/health']);

/**
 * Resolves a tenant from the Host header: an exact primary domain first, then
 * the leftmost label as a slug. There is deliberately no default tenant — an
 * unrecognised host is a 404, not a silent fallback that would let a request
 * land in someone else's data.
 */
async function resolveTenantId(host: string | undefined): Promise<string | null> {
  if (!host) return null;
  const hostname = host.split(':')[0]!.toLowerCase();

  const byDomain = await prisma.tenant.findFirst({
    where: { primaryDomain: hostname, status: 'active' },
  });
  if (byDomain) return byDomain.id;

  const slug = hostname.split('.')[0]!;
  const bySlug = await prisma.tenant.findFirst({
    where: { slug, status: 'active' },
  });
  return bySlug?.id ?? null;
}

export function registerTenantContext(app: FastifyInstance): void {
  app.decorateRequest('tenantId', '');
  app.decorateRequest('db', null);

  app.addHook('onRequest', async (request: FastifyRequest) => {
    if (UNSCOPED_PATHS.has(request.url.split('?')[0]!)) return;

    const tenantId = await resolveTenantId(request.headers.host);
    if (!tenantId) {
      throw new ProblemError(404, 'unknown-tenant', 'Unknown tenant');
    }

    request.tenantId = tenantId;
    request.db = <T>(fn: (tx: TenantClient) => Promise<T>) =>
      withTenant(tenantId, fn);
  });
}
