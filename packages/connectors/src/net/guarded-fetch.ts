import { lookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { classifyAddress } from './outbound.js';

export interface GuardedFetchOptions {
  /** Lifts the private-address refusal. From `OUTBOUND_ALLOW_PRIVATE`. */
  allowPrivateAddresses?: boolean | undefined;
  maxBytes?: number | undefined;
  timeoutMs?: number | undefined;
}

/**
 * The subset of the Fetch API a library needs from us, and no more.
 *
 * Deliberately not `typeof fetch`: this implementation follows no redirects,
 * streams no request body and reads the whole response into memory, and a
 * signature that promised all of `fetch` would be a claim a caller could
 * reasonably rely on.
 */
export type GuardedFetch = (
  url: string | URL,
  init?: RequestInit | undefined,
) => Promise<Response>;

const DEFAULT_MAX_BYTES = 1_048_576;
const DEFAULT_TIMEOUT_MS = 10_000;

/** Statuses the `Response` constructor refuses to attach a body to. */
const NULL_BODY_STATUS = new Set([204, 205, 304]);

/**
 * Headers that describe how the bytes arrived rather than what they are. The
 * `Response` built below carries its own framing, and forwarding the wire's
 * would describe a body that no longer exists in that form.
 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-length',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
]);

/**
 * A `fetch` for a URL an administrator supplied, with the outbound guard
 * applied to every request it makes.
 *
 * This is `fetchExternalDocument`'s sibling and it makes exactly the same four
 * decisions, through the same classifier:
 *
 * 1. Every address the hostname resolves to is checked, not the literal string
 *    that was typed. `https://metadata.acme.test/` is a public-looking name
 *    that can answer `169.254.169.254`, and a check against the string sees
 *    nothing wrong with it.
 * 2. The check is `classifyAddress`, which uses `ipaddr.process` — `parse`
 *    answers `ipv4Mapped` for `::ffff:169.254.169.254`, so a block list
 *    written against it lets every wrapped address through.
 * 3. The connection is then **pinned to the address that was checked**, by way
 *    of a `lookup` that answers with it and nothing else. Checking a name and
 *    then handing the name to the socket leaves a DNS-rebinding window, and
 *    that is the usual way this is exploited rather than an exotic one. The
 *    `Host` header and the TLS `servername` still carry the original hostname,
 *    so certificate validation is unaffected.
 * 4. Redirects are refused rather than followed. A public hostname that
 *    redirects inward defeats the check just as thoroughly as a rebinding one,
 *    and neither a discovery document nor a token response needs a redirect.
 *
 * `fetchExternalDocument` cannot serve this purpose itself: it is a GET that
 * returns a string, and a token exchange is a POST whose `Response` the
 * calling library parses. This is the same control in the shape a
 * `fetch`-taking library can consume — not a second opinion about which
 * addresses may be reached, which is why `classifyAddress` is imported rather
 * than reimplemented.
 *
 * Network I/O. Never called inside a transaction: Global Constraint 1.
 */
export function guardedFetch(options: GuardedFetchOptions = {}): GuardedFetch {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async (input, init) => {
    // Normalising through `Request` means a string body, a `URLSearchParams`,
    // a `Uint8Array` and a stream all arrive here as bytes, and header casing
    // is settled once.
    const request = new Request(String(input), init as RequestInit);
    const url = new URL(request.url);

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(
        `only http and https addresses may be fetched, not ${url.protocol}`,
      );
    }

    const resolved = await lookup(url.hostname, { all: true });
    if (resolved.length === 0) {
      throw new Error(`${url.hostname} resolves to no address`);
    }
    if (!options.allowPrivateAddresses) {
      for (const entry of resolved) {
        if (classifyAddress(entry.address) === 'blocked') {
          throw new Error(
            `${url.hostname} resolves to ${entry.address}, which is inside this deployment's own network. ` +
              'Set OUTBOUND_ALLOW_PRIVATE=true if that is intended.',
          );
        }
      }
    }

    const pinned = resolved[0]!;
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    const body = hasBody ? Buffer.from(await request.arrayBuffer()) : undefined;

    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      if (!HOP_BY_HOP.has(key)) headers[key] = value;
    });
    headers.host = url.host;
    if (body) headers['content-length'] = String(body.byteLength);

    const secure = url.protocol === 'https:';
    const send = secure ? httpsRequest : httpRequest;

    return new Promise<Response>((resolve, reject) => {
      const req = send(
        {
          host: url.hostname,
          ...(secure ? { servername: url.hostname } : {}),
          port: url.port !== '' ? Number(url.port) : secure ? 443 : 80,
          path: `${url.pathname}${url.search}`,
          method: request.method,
          headers,
          timeout: timeoutMs,
          // The pin. The socket connects to the address the guard just
          // classified, and to no address a second lookup might produce.
          lookup: (_hostname, lookupOptions, callback) => {
            if (lookupOptions.all) {
              callback(null, [{ address: pinned.address, family: pinned.family }]);
              return;
            }
            callback(null, pinned.address, pinned.family);
          },
        },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            res.destroy();
            reject(
              new Error(`${url.href} answered with a redirect, which is not followed`),
            );
            return;
          }
          if (status < 200) {
            res.destroy();
            reject(new Error(`${url.href} answered ${status}`));
            return;
          }

          const chunks: Buffer[] = [];
          let total = 0;
          res.on('data', (chunk: Buffer) => {
            total += chunk.length;
            if (total > maxBytes) {
              res.destroy();
              reject(new Error(`${url.href} returned a document that is too large`));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            const payload = Buffer.concat(chunks);
            resolve(
              new Response(NULL_BODY_STATUS.has(status) ? null : payload, {
                status,
                statusText: res.statusMessage ?? '',
                headers: responseHeaders(res.headers),
              }),
            );
          });
          res.on('error', reject);
        },
      );

      // The caller's deadline, honoured. `openid-client` passes one derived
      // from its own timeout, and a request that ignored it would outlive the
      // call that made it.
      const abort = () => req.destroy(new Error(`${url.href} was aborted`));
      if (request.signal.aborted) {
        abort();
      } else {
        request.signal.addEventListener('abort', abort, { once: true });
      }

      req.on('timeout', () => {
        req.destroy(new Error(`${url.href} did not answer in time`));
      });
      req.on('error', reject);
      req.end(body);
    });
  };
}

function responseHeaders(raw: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined || HOP_BY_HOP.has(name)) continue;
    if (Array.isArray(value)) {
      for (const one of value) headers.append(name, one);
    } else {
      headers.append(name, value);
    }
  }
  return headers;
}
