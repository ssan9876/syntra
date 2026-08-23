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
 * Resolves a tenant from the Host header, in three passes: the exact primary
 * domain, then any additional domain, then the leftmost label as a slug.
 *
 * There is deliberately no default tenant — an unrecognised host is a 404, not
 * a silent fallback that would let a request land in someone else's data.
 *
 * The middle pass exists because one hostname is not enough for a real
 * deployment. An instance is reached by IP while it is being set up and by a
 * DNS name once somebody points one at it, and both have to work across the
 * change — otherwise pointing a record at the server is a cutover with an
 * outage in the middle. `primaryDomain` cannot cover it: it is unique, and it
 * is the WebAuthn relying party, so there can only be one.
 *
 * Security keys still only work on the primary domain. That is not this
 * function's doing — a credential is bound to the relying party it was created
 * against, and arriving by another name means the browser will not offer it.
 */
async function resolveTenantId(host: string | undefined): Promise<string | null> {
  if (!host) return null;
  const hostname = host.split(':')[0]!.toLowerCase();

  const byDomain = await prisma.tenant.findFirst({
    where: { primaryDomain: hostname, status: 'active' },
  });
  if (byDomain) return byDomain.id;

  const byAdditional = await prisma.tenant.findFirst({
    where: { additionalDomains: { has: hostname }, status: 'active' },
  });
  if (byAdditional) return byAdditional.id;

  const slug = hostname.split('.')[0]!;
  const bySlug = await prisma.tenant.findFirst({
    where: { slug, status: 'active' },
  });
  return bySlug?.id ?? null;
}

export function registerTenantContext(app: FastifyInstance): void {
  app.decorateRequest('tenantId', '');
  // Declared here so the property exists on every request; the real
  // implementation is bound per request in the hook below.
  app.decorateRequest('db', function () {
    throw new Error('request.db used before the tenant hook ran');
  } as FastifyRequest['db']);

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
