import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ScimError, SCIM_ERROR_SCHEMA, protocolBase } from '@syntra/core';
import { resolveBearerPrincipal } from '../../plugins/bearer-token.js';
import { perTenantRateLimit } from '../../plugins/rate-limit.js';
import { registerScimDiscovery } from './discovery.js';
import { registerScimUserRoutes } from './users.js';
import { registerScimGroupRoutes } from './groups.js';

/** How many resources a list may return, whatever a client asks for. */
export const SCIM_MAX_RESULTS = 200;

/**
 * How many SCIM requests a minute a tenant may make, as a multiple of the
 * password allowance -- and of the tenant-wide password ceiling for the
 * second dimension.
 *
 * A multiple rather than its own setting so that the two ceilings move
 * together: an operator who raised `AUTH_RATE_LIMIT_MAX` for a busy site has
 * a busy site, and the SCIM client serving it is busier for the same reason.
 *
 * Sixty, because a full provisioning sync is the load to size against, not a
 * person. Entra and Okta walk every user and every group of a tenant one
 * request at a time when they first connect and whenever they reconcile, at
 * a few requests a second. With the default password allowance of ten a
 * minute this is six hundred a minute per address, ten a second, which is
 * above the rate either of them sustains and low enough that a leaked token
 * cannot enumerate a directory faster than the audit log notices.
 */
export const SCIM_RATE_LIMIT_FACTOR = 60;

export interface ScimRouteOptions {
  /**
   * What `meta.location` and the `Location` header are built from. Never the
   * request's own Host or X-Forwarded-Proto: `trustProxy` decides which
   * proxies may be believed about a request, and reading the headers raw
   * would bypass that decision for every link the IdP stores.
   */
  publicUrl: string;
  authRateLimitMax: number;
  authRateLimitTenantMax: number;
}

/**
 * The base for each request, resolved once in the plugin's own hook. A
 * WeakMap rather than a request decorator: the value is private to this
 * plugin, and a decorator would put a SCIM-only field on every request in
 * the process.
 */
const baseByRequest = new WeakMap<FastifyRequest, string>();

/** The absolute base a `meta.location` is built from. */
export function scimBaseUrl(request: FastifyRequest): string {
  const base = baseByRequest.get(request);
  if (base === undefined) {
    throw new Error('scimBaseUrl read before the SCIM plugin resolved the tenant');
  }
  return base;
}

/**
 * A SCIM 2.0 target.
 *
 * Two things about this plugin are deliberate departures from the rest of the
 * API, and both are bounded to it.
 *
 * IT ANSWERS IN SCIM'S ERROR SHAPE, not RFC 9457 problem+json. Every SCIM
 * client parses `urn:ietf:params:scim:api:messages:2.0:Error` and nothing
 * else, and a client that cannot parse the error cannot tell a conflict from a
 * crash — the integrator debugging a failed provisioning run is reading their
 * IdP's log, not ours. The exception lives in this plugin's own error handler
 * rather than weakening the shared one.
 *
 * IT ACCEPTS ONLY A MACHINE TOKEN. A cookie session is refused: a browser has
 * no business here, and every SCIM client in the world sends a bearer token.
 * That also means the C1 scope intersection applies, so a token scoped
 * `directory.read` can list and read and nothing else — which is a genuinely
 * useful way to prove a connection before trusting it to write.
 */
export async function registerScimRoutes(
  app: FastifyInstance,
  options: ScimRouteOptions,
): Promise<void> {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ScimError) {
      return reply.code(error.status).type('application/scim+json').send({
        schemas: [SCIM_ERROR_SCHEMA],
        // A STRING, which the RFC requires and clients check. A numeric status
        // works against one client and fails against another for reasons
        // nobody enjoys finding.
        status: String(error.status),
        ...(error.scimType === null ? {} : { scimType: error.scimType }),
        detail: error.detail,
      });
    }

    // Anything else is ours, translated rather than swallowed.
    //
    // BOTH shapes of status. Fastify's own errors carry `statusCode`;
    // `ProblemError` -- which is what `requirePermission` throws -- carries
    // `status`. Reading only the first turned every authorization refusal on
    // these routes into a 500, so a read-only token was told the server had
    // broken rather than that it lacked a permission.
    const carried = error as { statusCode?: unknown; status?: unknown; message?: unknown };
    const status =
      typeof carried.status === 'number'
        ? carried.status
        : typeof carried.statusCode === 'number'
          ? carried.statusCode
          : 500;
    return reply.code(status).type('application/scim+json').send({
      schemas: [SCIM_ERROR_SCHEMA],
      status: String(status),
      detail:
        status >= 500
          ? 'The server could not complete the request'
          : typeof carried.message === 'string'
            ? carried.message
            : 'The request could not be completed',
    });
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).type('application/scim+json').send({
      schemas: [SCIM_ERROR_SCHEMA],
      status: '404',
      detail: 'No such SCIM endpoint',
    }),
  );

  // Both dimensions, as every other credential-presenting route carries
  // them: a machine token is a credential, and a route that takes one and
  // answers as fast as it is asked is a directory-enumeration primitive for
  // whoever holds a leaked token. Plugin-wide hooks rather than per-route
  // config so that a route added later cannot forget.
  app.addHook(
    'onRequest',
    app.rateLimit({
      max: options.authRateLimitMax * SCIM_RATE_LIMIT_FACTOR,
      timeWindow: '1 minute',
    }),
  );
  app.addHook(
    'onRequest',
    perTenantRateLimit(app, options.authRateLimitTenantMax * SCIM_RATE_LIMIT_FACTOR),
  );

  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = await resolveBearerPrincipal(request);
    if (principal === null) {
      // `WWW-Authenticate`, because a client that gets a bare 401 cannot tell
      // "no credential" from "wrong credential" and some will not retry.
      return reply
        .code(401)
        .header('www-authenticate', 'Bearer realm="SCIM"')
        .type('application/scim+json')
        .send({
          schemas: [SCIM_ERROR_SCHEMA],
          status: '401',
          detail: 'A machine token is required. Present it as Authorization: Bearer.',
        });
    }
    request.session = principal;

    // The same formula every protocol identifier uses, so a location here and
    // an issuer over there never disagree by a scheme or a port.
    const tenant = await request.db((tx) =>
      tx.tenant.findUniqueOrThrow({
        where: { id: request.tenantId },
        select: { primaryDomain: true },
      }),
    );
    baseByRequest.set(request, `${protocolBase(tenant, options.publicUrl)}/scim/v2`);
    return undefined;
  });

  await registerScimDiscovery(app);
  await registerScimUserRoutes(app);
  await registerScimGroupRoutes(app);
}
