import type { FastifyRequest } from 'fastify';

/**
 * Paths whose segments ARE credentials, with the segment that is.
 *
 * A one-time credential link carries its token in the path, not the query --
 * `/api/credential-pickup/<token>` -- because the page it serves is a
 * `/credential/<token>` URL a person clicks in an email. Dropping the query is
 * therefore not enough for it, and a request log that kept the path would be
 * a log of live links to people's initial passwords.
 */
const CREDENTIAL_PATHS = [
  /^(\/api\/credential-pickup\/)[^/]+/,
  // The page itself, when this process also serves the console (WEB_ROOT).
  /^(\/credential\/)[^/]+/,
];

/** Authentication callbacks and reset links carry credentials in the query.
 * Keep the path for diagnostics, but never persist queries, headers or bodies,
 * and never a path segment that is itself a token. */
export function serializeRequest(request: FastifyRequest) {
  return {
    method: request.method,
    url: redactPath(request.url.split('?')[0] ?? ''),
    host: request.host,
    remoteAddress: request.ip,
    ...(request.socket?.remotePort === undefined ? {} : { remotePort: request.socket.remotePort }),
  };
}

export function redactPath(path: string): string {
  return CREDENTIAL_PATHS.reduce((acc, pattern) => acc.replace(pattern, '$1[redacted]'), path);
}
