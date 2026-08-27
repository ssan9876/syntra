import { guardedFetch } from '../net/guarded-fetch.js';
import type { WriteFailure } from '../types.js';
import type { ListSpec, ResolvedHttpConnectorDocument } from './document.js';

/**
 * Reads a dotted property path out of a parsed JSON body.
 *
 * Own properties only, one segment at a time, and `undefined` the moment a
 * segment is absent or the value is not an object. `constructor` and
 * `__proto__` are refused by `document.ts`'s pattern before they reach here;
 * the `hasOwnProperty` check is the second lock on the same door.
 */
export function readPath(body: unknown, path: string): unknown {
  if (body === null || typeof body !== 'object') return undefined;
  const own = (key: string) => Object.prototype.hasOwnProperty.call(body, key);

  // THE WHOLE PATH AS ONE KEY FIRST, and this is not an optimisation.
  // Microsoft Graph's page pointer is literally called `@odata.nextLink` -- one
  // key, with a dot in it -- and a reader that split on every dot would look
  // for a `nextLink` property inside an `@odata` object that does not exist,
  // find nothing, and page exactly once through a directory of forty thousand
  // people. Trying the literal key first makes such a key expressible without
  // inventing an escaping syntax nobody would remember.
  if (own(path)) return (body as Record<string, unknown>)[path];

  const dot = path.indexOf('.');
  if (dot === -1) return undefined;
  const head = path.slice(0, dot);
  if (!own(head)) return undefined;
  return readPath((body as Record<string, unknown>)[head], path.slice(dot + 1));
}

export interface HttpResponse {
  status: number;
  body: unknown;
  /**
   * The response headers, carried because `Retry-After` is the difference
   * between honouring a target's own throttle and hammering it on our
   * schedule until it stops answering at all.
   */
  headers: Headers;
  /** Present when the body was not JSON. Never shown to a user verbatim. */
  raw?: string;
}

export type Credential = string;

/**
 * Access tokens obtained through `oauth2`, keyed by the exchange that produced
 * them.
 *
 * Process-wide and in memory only. A token is a bearer credential with an
 * hour's life; writing it to the database would make it a stored credential
 * with all the handling that implies, for something that is cheaper to fetch
 * again than to protect. The key includes the client id and the scope, so two
 * targets against the same tenant with different scopes do not share one.
 */
const tokens = new Map<string, { value: string; expiresAt: number }>();

/** Refreshed this far before expiry, so a token never expires mid-run. */
const TOKEN_SKEW_MS = 60_000;

async function accessToken(
  auth: { tokenUrl: string; clientId: string; scope?: string | undefined },
  clientSecret: string,
  allowPrivateAddresses: boolean,
): Promise<string> {
  const key = `${auth.tokenUrl}|${auth.clientId}|${auth.scope ?? ''}`;
  const cached = tokens.get(key);
  if (cached && cached.expiresAt - TOKEN_SKEW_MS > Date.now()) return cached.value;

  const form = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: auth.clientId,
    client_secret: clientSecret,
    ...(auth.scope ? { scope: auth.scope } : {}),
  });
  const fetcher = guardedFetch({ allowPrivateAddresses, timeoutMs: 30_000 });
  const response = await fetcher(auth.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const text = await response.text();
  if (response.status >= 400) {
    // The status, not the body. A token endpoint's error body echoes the
    // request it was sent, and the request contained the client secret.
    throw new Error(`the token endpoint answered HTTP ${response.status}`);
  }

  const body = JSON.parse(text) as { access_token?: string; expires_in?: number };
  if (typeof body.access_token !== 'string') {
    throw new Error('the token endpoint did not return an access token');
  }
  const lifetime = typeof body.expires_in === 'number' ? body.expires_in : 3600;
  tokens.set(key, {
    value: body.access_token,
    expiresAt: Date.now() + lifetime * 1000,
  });
  return body.access_token;
}

/** Forgets every cached token. For tests, and for a credential rotation. */
export function forgetAccessTokens(): void {
  tokens.clear();
}

async function authHeaders(
  document: ResolvedHttpConnectorDocument,
  credential: Credential,
): Promise<Record<string, string>> {
  switch (document.auth.type) {
    case 'bearer':
      return { authorization: `Bearer ${credential}` };
    case 'basic':
      return {
        authorization: `Basic ${Buffer.from(`${document.auth.username}:${credential}`).toString('base64')}`,
      };
    case 'header':
      return { [document.auth.header]: `${document.auth.prefix}${credential}` };
    case 'oauth2':
      return {
        authorization: `Bearer ${await accessToken(
          document.auth,
          credential,
          document.allowPrivateAddresses,
        )}`,
      };
  }
}

/**
 * One request against the target.
 *
 * `guardedFetch`, not the global `fetch`, for the reason every
 * administrator-supplied URL in this codebase goes through it: the URL is
 * typed by a tenant administrator and the request is made by the SERVER, from
 * inside a network that administrator may not be able to reach. The guard
 * resolves the name, classifies every address it answers with, and pins the
 * socket to the address it classified.
 */
export async function httpRequest(
  document: ResolvedHttpConnectorDocument,
  credential: Credential,
  input: {
    method: string;
    /** Either a path under `baseUrl`, or an absolute URL a page pointer gave. */
    path: string;
    query?: Record<string, string>;
    body?: unknown;
  },
): Promise<HttpResponse> {
  const fetcher = guardedFetch({
    allowPrivateAddresses: document.allowPrivateAddresses,
    timeoutMs: document.timeoutMs,
  });

  // An absolute URL only ever comes from a `nextLink` the target itself
  // returned, and it is resolved against `baseUrl` rather than trusted: a
  // target that answered with a pointer at somebody else's host would
  // otherwise get this connector's credential sent there.
  const base = new URL(`${document.baseUrl.replace(/\/$/, '')}/`);
  const url = input.path.startsWith('http') ? new URL(input.path) : new URL(
    `${document.baseUrl.replace(/\/$/, '')}${input.path}`,
  );
  if (url.origin !== base.origin) {
    throw new Error(
      `the target answered with a page pointer at ${url.origin}, which is not ${base.origin}`,
    );
  }
  for (const [key, value] of Object.entries(input.query ?? {})) {
    url.searchParams.set(key, value);
  }

  const response = await fetcher(url.toString(), {
    method: input.method,
    headers: {
      accept: 'application/json',
      ...document.headers,
      ...(await authHeaders(document, credential)),
      ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  });

  const text = await response.text();
  const { status, headers } = response;
  if (text === '') return { status, headers, body: null };
  try {
    return { status, headers, body: JSON.parse(text) };
  } catch {
    // Kept, because a diagnostic is worth having; never returned to a user
    // and never put in a `WriteResult.message`, which the console shows.
    return { status, headers, body: null, raw: text.slice(0, 500) };
  }
}

/**
 * Turns a status into the closed classification the run retries on.
 *
 * `throttled` and `transient` are retried and nothing else is, so this is what
 * decides whether a failed write is tried again. The document may move the
 * boundaries; it may not invent a category.
 */
export function classify(
  document: ResolvedHttpConnectorDocument,
  status: number,
): WriteFailure {
  const { failures } = document;
  if (failures.unauthorized.includes(status)) return 'unauthorized';
  if (failures.notFound.includes(status)) return 'not_found';
  if (failures.conflict.includes(status)) return 'conflict';
  if (failures.throttled.includes(status)) return 'throttled';
  // 5xx is transient by definition and not by configuration: a document that
  // could declare 500 permanent would be a document that could switch off
  // retry for an outage.
  if (status >= 500) return 'transient';
  return 'rejected';
}

/** `Retry-After` in seconds, where the target sent one. */
export function retryAfterMs(headers: Headers): number | undefined {
  const value = headers.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

export class PagingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PagingError';
  }
}

/**
 * Walks every page of a collection, or throws.
 *
 * **There is no partial return.** A page that fails mid-walk throws rather
 * than yielding what was already collected, and callers that cannot tolerate
 * an incomplete list — `readEntitlementMembers` above all — depend on that.
 * A group of 4,000 members read as 1,500 makes the diff propose granting it
 * to 2,500 people or revoking it from them, and nothing downstream can tell
 * the two situations apart.
 *
 * The page cap is a guard against a target whose cursor never terminates,
 * which is a real failure mode and one that otherwise spins for ever holding
 * a run open. Hitting it is an error, not a stopping condition — stopping
 * quietly is the partial return this contract forbids.
 */
const MAX_PAGES = 1000;

export async function* paginate(
  document: ResolvedHttpConnectorDocument,
  credential: Credential,
  spec: ListSpec,
): AsyncIterable<unknown> {
  let path = spec.path;
  let query: Record<string, string> = { ...spec.query };
  let offset = 0;

  for (let page = 0; ; page += 1) {
    if (page >= MAX_PAGES) {
      throw new PagingError(
        `${spec.path} did not stop paging after ${MAX_PAGES} pages; refusing to return a partial list`,
      );
    }

    if (spec.paging.style === 'offset') {
      query = {
        ...query,
        [spec.paging.limitParam]: String(spec.paging.pageSize),
        [spec.paging.offsetParam]: String(offset),
      };
    }

    const response = await httpRequest(document, credential, {
      method: 'GET',
      path,
      query,
    });
    if (response.status >= 400) {
      throw new PagingError(`${spec.path} answered HTTP ${response.status}`);
    }

    const items = spec.itemsAt ? readPath(response.body, spec.itemsAt) : response.body;
    if (!Array.isArray(items)) {
      throw new PagingError(
        spec.itemsAt
          ? `${spec.path} has no array at "${spec.itemsAt}"`
          : `${spec.path} did not answer with an array`,
      );
    }
    for (const item of items) yield item;

    if (spec.paging.style === 'none') return;

    if (spec.paging.style === 'offset') {
      // A short page is the end. A full one might be, and asking once more is
      // the only way to find out — an offset API has no other terminator.
      if (items.length < spec.paging.pageSize) return;
      offset += items.length;
      continue;
    }

    const next = readPath(response.body, spec.paging.nextAt);
    if (next === undefined || next === null || next === '') return;
    if (typeof next !== 'string') {
      throw new PagingError(`"${spec.paging.nextAt}" is not a page pointer`);
    }
    if (spec.paging.kind === 'url') {
      path = next;
      query = {};
    } else {
      query = { ...spec.query, [spec.paging.tokenParam]: next };
    }
  }
}
