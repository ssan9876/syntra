import type { FastifyInstance } from 'fastify';
import { readBrand } from '@syntra/core';

/**
 * The tenant's name, logo and colours, read WITHOUT a session.
 *
 * Unauthenticated on purpose: the sign-in page is the first thing anybody
 * sees, and a brand that only appeared after signing in would appear exactly
 * where it no longer matters. The tenant is resolved from the Host header, the
 * same way every other request is.
 *
 * Nothing here is a secret. A name, a logo and two hex colours are what every
 * visitor to that hostname is about to be shown anyway, and there is no
 * enumeration to worry about: a caller who reached this route already knows
 * the hostname, which is the only thing the answer identifies.
 *
 * Answers an unbranded tenant with four nulls rather than a 404. The client
 * renders Syntra's own identity from that, and a 404 would leave the page
 * choosing between an error state and a silent fallback for what is simply the
 * default.
 */
export async function registerBrandingRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (request, reply) => {
    const brand = await request.db((tx) => readBrand(tx));
    // NOT awaited. Awaiting a FastifyReply signals that the handler is taking
    // the response over itself, and Fastify then waits for a send that never
    // comes while this returns a payload it will no longer look at — the
    // request simply hangs. `reply.header()` is synchronous and returns the
    // reply for chaining, which is exactly the shape that invites the mistake.
    //
    // Cached briefly and privately: a logo is a quarter of a megabyte on the
    // one page that must load on a bad connection, and it changes about once a
    // year — but `public` would let a shared proxy serve one tenant's brand on
    // another tenant's hostname.
    reply.header('cache-control', 'private, max-age=300');
    return brand;
  });
}
