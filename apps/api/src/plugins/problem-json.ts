import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

const BASE = 'https://syntra.dev/problems/';

/**
 * An expected failure with a stable, machine-readable type. Anything thrown
 * that is not one of these is treated as a bug and reported as a bare 500.
 */
export class ProblemError extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    readonly title: string,
    readonly detail?: string,
    /**
     * Extension members, per RFC 9457 section 3.2 — problem-specific data a
     * client can act on rather than parse out of the prose. Rendered
     * alongside the standard members, and never over them.
     */
    readonly extensions?: Record<string, unknown>,
  ) {
    super(detail ?? title);
    this.name = 'ProblemError';
  }
}

export interface ProblemJsonOptions {
  /**
   * What answers a request no route claimed.
   *
   * Fastify allows ONE not-found handler per encapsulation context, and this
   * plugin owns it. A deployment that also serves the single-page application
   * needs that handler to send the application for a path the router owns, so
   * it is passed in here rather than set a second time somewhere else — which
   * Fastify would refuse at startup.
   */
  notFound?: (request: FastifyRequest, reply: FastifyReply) => unknown;
}

export function registerProblemJson(
  app: FastifyInstance,
  options: ProblemJsonOptions = {},
): void {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ProblemError) {
      return reply
        .status(error.status)
        .type('application/problem+json')
        .send({
          // Extensions first, so a stray `status` or `type` among them cannot
          // misreport what actually happened.
          ...(error.extensions ?? {}),
          type: `${BASE}${error.type}`,
          title: error.title,
          status: error.status,
          ...(error.detail ? { detail: error.detail } : {}),
        });
    }

    if (error instanceof ZodError) {
      return reply.status(400).type('application/problem+json').send({
        type: `${BASE}validation-failed`,
        title: 'Validation failed',
        status: 400,
        errors: error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }

    /**
     * A transaction that ran out of budget is the database being saturated,
     * not a fault in this server.
     *
     * `P2028` is Prisma's interactive-transaction timeout. Every request to a
     * tenant-scoped route opens one before the handler runs — tenant
     * resolution, then the permission check — so under contention a request
     * dies there, carrying an error that is neither a ProblemError nor a
     * ZodError, and lands in the bare 500 below. That is how a contended
     * database came to look identical to an application crash in the logs, and
     * how a malformed-uuid request that should answer 400 answered 500: it
     * never reached the handler that would have parsed the id.
     *
     * 503 says the thing a client, a proxy or a dashboard can act on: try
     * again. 500 says "this server has a bug", and conflating the two costs
     * the 500 its meaning.
     *
     * Keyed on P2028 ALONE, deliberately. Widening this to
     * PrismaClientKnownRequestError would relabel a unique-constraint
     * violation — a real bug in the caller — as "the service is busy", which
     * is a worse lie than the one being fixed.
     */
    if ((error as { code?: string }).code === 'P2028') {
      request.log.error({ err: error }, 'database transaction timed out');
      return reply.status(503).type('application/problem+json').send({
        type: `${BASE}unavailable`,
        title: 'Service Unavailable',
        status: 503,
        // No timings and no query text: the message carries both, and neither
        // is the client's business.
        detail: 'the database did not answer within the transaction budget',
      });
    }

    // Fastify's own errors (rate limit, malformed body) carry a usable status.
    const fastifyError = error as { statusCode?: number; message?: string };
    const status = fastifyError.statusCode ?? 500;
    if (status < 500) {
      return reply.status(status).type('application/problem+json').send({
        type: `${BASE}bad-request`,
        title: fastifyError.message ?? 'Bad Request',
        status,
      });
    }

    // Anything else may carry connection strings or stack detail. Log it
    // server-side; tell the client nothing beyond the status.
    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).type('application/problem+json').send({
      type: `${BASE}internal-error`,
      title: 'Internal Server Error',
      status: 500,
    });
  });

  const notFound =
    options.notFound ??
    ((_request: FastifyRequest, reply: FastifyReply) =>
      reply.status(404).type('application/problem+json').send({
        type: `${BASE}not-found`,
        title: 'Not Found',
        status: 404,
      }));
  app.setNotFoundHandler(notFound);
}
