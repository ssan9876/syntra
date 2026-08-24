import type { FastifyInstance, FastifyRequest } from 'fastify';
import { prisma, withTenant, type TenantClient } from '@syntra/db';
import { ProblemError } from './problem-json.js';

declare module 'fastify' {
  interface FastifyRequest {
    tenantId: string;
    db<T>(fn: (tx: TenantClient) => Promise<T>): Promise<T>;
  }
}

/**
 * Routes that answer before a tenant is known.
 *
 * `/health/ready` is here for a reason worth writing down: it is what the
 * updater's automatic rollback hangs on, and it is polled with whatever Host
 * header curl happens to send on localhost. Left tenant-scoped it would 404
 * on an unrecognised host -- and a rollback gate that fails for the WRONG
 * reason rolls back every update, including the good ones.
 */
const UNSCOPED_PATHS = new Set(['/health', '/health/ready']);

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

export interface TenantContextOptions {
  /**
   * The page a BROWSER is shown when no tenant answers for the hostname it
   * arrived on. Only set where this process also serves the application.
   *
   * The refusal itself does not change — an unrecognised host is a 404 either
   * way. What changes is who is being answered. `{"title":"Not Found"}` in the
   * address bar is true and useless, and the moment somebody sees it is
   * usually the moment after they pointed a DNS record here and before they
   * listed the name on the tenant. The page says that.
   */
  unknownHostPage?: (hostname: string) => string;
}

export function registerTenantContext(
  app: FastifyInstance,
  options: TenantContextOptions = {},
): void {
  app.decorateRequest('tenantId', '');
  // Declared here so the property exists on every request; the real
  // implementation is bound per request in the hook below.
  app.decorateRequest('db', function () {
    throw new Error('request.db used before the tenant hook ran');
  } as FastifyRequest['db']);

  app.addHook('onRequest', async (request: FastifyRequest, reply) => {
    if (UNSCOPED_PATHS.has(request.url.split('?')[0]!)) return;

    const tenantId = await resolveTenantId(request.headers.host);
    if (!tenantId) {
      // A document request from a browser gets the explanation; everything
      // else gets the machine-readable refusal it can act on. `Accept` must
      // name text/html explicitly — `fetch` defaults to `*/*`, and answering
      // an API call with a page would turn a clear 404 into a parse error.
      const wantsPage =
        options.unknownHostPage &&
        request.method === 'GET' &&
        (request.headers.accept ?? '').includes('text/html');
      if (wantsPage) {
        const host = request.headers.host ?? '';
        return reply
          .status(404)
          .type('text/html; charset=utf-8')
          .send(options.unknownHostPage!(host.split(':')[0] ?? host));
      }
      throw new ProblemError(404, 'unknown-tenant', 'Unknown tenant');
    }

    request.tenantId = tenantId;
    request.db = <T>(fn: (tx: TenantClient) => Promise<T>) =>
      withTenant(tenantId, fn);
  });
}
