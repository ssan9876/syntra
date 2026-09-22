import type { FastifyRequest } from 'fastify';

/** Authentication callbacks and reset links carry credentials in the query.
 * Keep the path for diagnostics, but never persist queries, headers or bodies. */
export function serializeRequest(request: FastifyRequest) {
  return {
    method: request.method,
    url: request.url.split('?')[0] ?? '',
    host: request.host,
    remoteAddress: request.ip,
    ...(request.socket?.remotePort === undefined ? {} : { remotePort: request.socket.remotePort }),
  };
}
