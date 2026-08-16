import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import ipaddr from 'ipaddr.js';

/** Ranges nothing an administrator types may resolve to, unless allowed. */
const BLOCKED_RANGES = new Set([
  'unspecified',
  'broadcast',
  'loopback',
  'linkLocal',
  'private',
  'uniqueLocal',
  'carrierGradeNat',
  'multicast',
  'ipv4Mapped',
  'rfc6145',
  'rfc6052',
  '6to4',
  'teredo',
]);

/**
 * Whether an address is one an outbound fetch may connect to.
 *
 * `ipaddr.process` unwraps an IPv4-mapped IPv6 address to its IPv4 form before
 * classifying. `ipaddr.parse` would answer `ipv4Mapped` for
 * `::ffff:169.254.169.254` and for every other wrapped address alike, so a
 * block-list written against `parse` and naming the ranges an operator thinks
 * of — loopback, linkLocal, private — lets all of them through. `ipv4Mapped`
 * is in the set below as well, so the control holds either way.
 *
 * Anything that will not parse is blocked, not allowed. A classifier that
 * fails open is not a control.
 */
export function classifyAddress(address: string): 'allowed' | 'blocked' {
  let parsed: ReturnType<typeof ipaddr.process>;
  try {
    parsed = ipaddr.process(address);
  } catch {
    return 'blocked';
  }
  return BLOCKED_RANGES.has(parsed.range()) ? 'blocked' : 'allowed';
}

export interface OutboundOptions {
  /** Lifts the private-address refusal. From `OUTBOUND_ALLOW_PRIVATE`. */
  allowPrivateAddresses?: boolean | undefined;
  maxBytes?: number | undefined;
  timeoutMs?: number | undefined;
}

const DEFAULT_MAX_BYTES = 1_048_576;
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Fetches a document from an address an administrator supplied.
 *
 * **Every resolved address is checked, and the connection is then pinned to
 * the one that was checked.** Resolving, checking, and then handing the
 * hostname to a fetch would leave a DNS-rebinding window: a name that answered
 * with a public address for the check can answer with `169.254.169.254` for
 * the connection microseconds later, and that is the usual way this is
 * exploited rather than an exotic one. Connecting to the literal address, with
 * the `Host` header and TLS `servername` still set to the original hostname,
 * closes it — certificate validation is unaffected because `servername` drives
 * both SNI and the name check.
 *
 * Redirects are refused rather than followed: a public hostname that redirects
 * inward defeats the check just as thoroughly as a rebinding one, and no
 * legitimate metadata document needs a redirect.
 *
 * Never called inside a transaction — this is network I/O and Global
 * Constraint 1 applies.
 */
export async function fetchExternalDocument(
  rawUrl: string,
  options: OutboundOptions,
): Promise<string> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`not a usable address: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`only http and https addresses may be fetched, not ${url.protocol}`);
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

  // The first resolved address, and the connection is pinned to it.
  const address = resolved[0]!.address;
  const secure = url.protocol === 'https:';
  const send = secure ? httpsRequest : httpRequest;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  return new Promise<string>((resolve, reject) => {
    const req = send(
      {
        host: address,
        servername: secure ? url.hostname : undefined,
        port: url.port !== '' ? Number(url.port) : secure ? 443 : 80,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: { host: url.host, accept: 'application/xml, text/xml, application/json' },
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.destroy();
          reject(new Error(`${url.href} answered with a redirect, which is not followed`));
          return;
        }
        if (status < 200 || status >= 300) {
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
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error(`${url.href} did not answer in time`));
    });
    req.on('error', reject);
    req.end();
  });
}
