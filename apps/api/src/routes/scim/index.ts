import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ScimError, SCIM_ERROR_SCHEMA } from '@syntra/core';
import { resolveBearerPrincipal } from '../../plugins/bearer-token.js';
import { registerScimDiscovery } from './discovery.js';
import { registerScimUserRoutes } from './users.js';
import { registerScimGroupRoutes } from './groups.js';

/** How many resources a list may return, whatever a client asks for. */
export const SCIM_MAX_RESULTS = 200;

/** The absolute base a `meta.location` is built from. */
export function scimBaseUrl(request: FastifyRequest): string {
  const proto = (request.headers['x-forwarded-proto'] as string | undefined) ?? request.protocol;
  return `${proto}://${request.headers.host ?? ''}/scim/v2`;
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
export async function registerScimRoutes(app: FastifyInstance): Promise<void> {
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
    return undefined;
  });

  await registerScimDiscovery(app);
  await registerScimUserRoutes(app);
  await registerScimGroupRoutes(app);
}
