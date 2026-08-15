import type { FastifyInstance } from 'fastify';
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
  ) {
    super(detail ?? title);
    this.name = 'ProblemError';
  }
}

export function registerProblemJson(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ProblemError) {
      return reply
        .status(error.status)
        .type('application/problem+json')
        .send({
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

    // Fastify's own errors (rate limit, malformed body) carry a usable status.
    const status = error.statusCode ?? 500;
    if (status < 500) {
      return reply.status(status).type('application/problem+json').send({
        type: `${BASE}bad-request`,
        title: error.message,
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

  app.setNotFoundHandler((_request, reply) =>
    reply.status(404).type('application/problem+json').send({
      type: `${BASE}not-found`,
      title: 'Not Found',
      status: 404,
    }),
  );
}
