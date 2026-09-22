import { createHash } from 'node:crypto';
import { guardedFetch } from '../net/guarded-fetch.js';
import type { WriteFailure } from '../types.js';
import type { EntraConnection } from './config.js';

/**
 * A Microsoft Graph client for exactly the requests the Entra connector
 * makes, on top of `guardedFetch` and never the global `fetch`.
 *
 * The reason is the one every administrator-supplied URL in this codebase
 * shares: `graphBaseUrl` and `tokenUrl` are typed into a form and the request
 * is made by the SERVER, from inside a network the administrator may not be
 * able to reach. The guard resolves the name, classifies every address it
 * answers with, and pins the socket to the address it classified.
 */

export interface GraphResponse {
  status: number;
  body: unknown;
  headers: Headers;
  /** Present when the body was not JSON. Never shown to a user verbatim. */
  raw?: string;
}

export interface GraphRequestInput {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** A path under `graphBaseUrl`, or an absolute `@odata.nextLink`. */
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: unknown;
}

/**
 * Access tokens, keyed by the exchange that produced them.
 *
 * In memory and process-wide, for the reason `http/client.ts` gives: a
 * bearer token with an hour's life is cheaper to fetch again than to protect.
 * The key includes a digest of the SECRET, not just the client id, so that a
 * rotated secret can never be served a token the old one obtained -- and a
 * wrong secret can never be masked by a token a right one left behind.
 */
const tokens = new Map<
  string,
  { clientId: string; value: string; expiresAt: number }
>();

/** Refreshed this far before expiry, so a token never expires mid-run. */
const TOKEN_SKEW_MS = 60_000;

function tokenKey(connection: EntraConnection): string {
  const digest = createHash('sha256').update(connection.clientSecret).digest('hex');
  return `${connection.tokenUrl}|${connection.clientId}|${digest}`;
}

/**
 * Forgets cached tokens: every one, or every one obtained for `clientId`.
 *
 * Called on credential rotation. The digest in the key already stops the new
 * secret reusing the old token; this is what stops the OLD secret's token
 * being used for the rest of its hour by a run that still holds it.
 */
export function forgetEntraTokens(clientId?: string): void {
  if (clientId === undefined) {
    tokens.clear();
    return;
  }
  for (const [key, entry] of tokens) {
    if (entry.clientId === clientId) tokens.delete(key);
  }
}

/** The one stable thing in a Microsoft token error: its AADSTS code. */
const AADSTS = /\bAADSTS\d{5,8}\b/;

export class GraphTokenError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super(
      `the token endpoint answered HTTP ${status}` + (code ? ` (${code})` : ''),
    );
    this.name = 'GraphTokenError';
  }
}

export async function graphAccessToken(connection: EntraConnection): Promise<string> {
  const key = tokenKey(connection);
  const cached = tokens.get(key);
  if (cached && cached.expiresAt - TOKEN_SKEW_MS > Date.now()) return cached.value;

  const form = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: connection.clientId,
    client_secret: connection.clientSecret,
    scope: `${new URL(connection.graphBaseUrl).origin}/.default`,
  });
  const fetcher = guardedFetch({
    allowPrivateAddresses: connection.allowPrivateAddresses,
    timeoutMs: connection.timeoutMs,
  });
  const response = await fetcher(connection.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const text = await response.text();
  if (response.status >= 400) {
    // Never the body. A token response can echo the request, including the
    // client secret; the AADSTS code alone is what an administrator needs.
    throw new GraphTokenError(response.status, AADSTS.exec(text)?.[0]);
  }
  let body: { access_token?: unknown; expires_in?: unknown };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    throw new GraphTokenError(response.status, undefined);
  }
  if (typeof body.access_token !== 'string') {
    throw new Error('the token endpoint did not return an access token');
  }
  const lifetime = typeof body.expires_in === 'number' ? body.expires_in : 3600;
  tokens.set(key, {
    clientId: connection.clientId,
    value: body.access_token,
    expiresAt: Date.now() + lifetime * 1000,
  });
  return body.access_token;
}

/**
 * One request against Graph.
 *
 * An absolute URL only ever comes from an `@odata.nextLink` Graph itself
 * returned, and it is pinned to `graphBaseUrl`'s origin rather than trusted:
 * a response that pointed at somebody else's host would otherwise get this
 * connector's bearer token sent there.
 */
export async function graphRequest(
  connection: EntraConnection,
  input: GraphRequestInput,
): Promise<GraphResponse> {
  const base = new URL(`${connection.graphBaseUrl.replace(/\/$/, '')}/`);
  const url = /^https?:\/\//i.test(input.path)
    ? new URL(input.path)
    : new URL(`${connection.graphBaseUrl.replace(/\/$/, '')}${input.path}`);
  if (url.origin !== base.origin) {
    throw new Error(
      `Graph answered with a page pointer at ${url.origin}, which is not ${base.origin}`,
    );
  }
  for (const [key, value] of Object.entries(input.query ?? {})) {
    url.searchParams.set(key, value);
  }

  const token = await graphAccessToken(connection);
  const fetcher = guardedFetch({
    allowPrivateAddresses: connection.allowPrivateAddresses,
    timeoutMs: connection.timeoutMs,
  });
  const response = await fetcher(url.toString(), {
    method: input.method,
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      ...(input.headers ?? {}),
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
    return { status, headers, body: null, raw: text.slice(0, 500) };
  }
}

/**
 * Graph's `error.code`: a stable enum string (`Request_ResourceNotFound`,
 * `Authorization_RequestDenied`) that is safe to show. `error.message` is
 * free text that can quote the request back, and is never surfaced.
 */
export function graphErrorCode(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object') return undefined;
  const error = (body as { error?: unknown }).error;
  if (error === null || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^[A-Za-z0-9_.]{1,80}$/.test(code) ? code : undefined;
}

/** `error.message`, for the connector to TEST against. Never for a message. */
export function graphErrorMessage(body: unknown): string {
  if (body === null || typeof body !== 'object') return '';
  const error = (body as { error?: unknown }).error;
  if (error === null || typeof error !== 'object') return '';
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' ? message : '';
}

/**
 * The closed classification the run retries on.
 *
 * 401 and 403 are a credential or a consent problem, and neither becomes true
 * on the fourth attempt. 429 is Graph asking for patience and carries
 * `Retry-After`. 5xx is transient by definition. Everything else is a request
 * Graph understood and refused, and the run should stop proposing it.
 */
export function classifyGraph(status: number, _body?: unknown): WriteFailure {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'throttled';
  if (status >= 500) return 'transient';
  return 'rejected';
}

/** The HTTP status and the stable code, and nothing else. */
export function graphFailureMessage(status: number, body: unknown): string {
  const code = graphErrorCode(body);
  return `Microsoft Graph answered HTTP ${status}` + (code ? ` (${code})` : '');
}

/** `Retry-After` in seconds, where Graph sent one. */
export function graphRetryAfterMs(headers: Headers): number | undefined {
  const value = headers.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

export class GraphPagingError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'GraphPagingError';
  }
}

/**
 * A guard against a `nextLink` that never terminates. Hitting it is an error,
 * not a stopping condition: stopping quietly is the partial return the
 * contract below forbids.
 */
const MAX_PAGES = 1000;

/**
 * Walks every page of a collection, or throws.
 *
 * **There is no partial return.** A page that fails mid-walk throws rather
 * than yielding what was already collected; `readEntitlementMembers` above
 * all depends on that, because a group of 4,000 members read as 1,500 makes
 * the diff propose granting it to 2,500 people or revoking it from them.
 *
 * **Page boundaries.** The `@odata.nextLink` is followed VERBATIM: Graph
 * encodes the cursor and every original query option into it, and re-adding
 * `$select` or `$top` to a pointer that already carries them is how a walk
 * restarts from page one. Within one walk each `id` is yielded at most once,
 * so a boundary that Graph itself repeats (which eventual consistency can
 * do) is not counted twice; an id that never appears cannot be detected here
 * and is why the contract is "everything Graph returned" and not "everything
 * that exists".
 */
export async function* graphPaginate(
  connection: EntraConnection,
  path: string,
  query: Record<string, string> = {},
  headers: Record<string, string> = {},
): AsyncIterable<Record<string, unknown>> {
  let next: string | undefined = path;
  let first = true;
  const seen = new Set<string>();

  for (let page = 0; next !== undefined; page += 1) {
    if (page >= MAX_PAGES) {
      throw new GraphPagingError(
        `${path} did not stop paging after ${MAX_PAGES} pages; refusing to return a partial list`,
      );
    }
    const response: GraphResponse = await graphRequest(connection, {
      method: 'GET',
      path: next,
      ...(first ? { query } : {}),
      headers,
    });
    first = false;
    if (response.status >= 400) {
      throw new GraphPagingError(
        `${path}: ${graphFailureMessage(response.status, response.body)}`,
        response.status,
      );
    }
    const body = response.body as { value?: unknown; '@odata.nextLink'?: unknown } | null;
    const items = body?.value;
    if (!Array.isArray(items)) {
      throw new GraphPagingError(`${path} did not answer with a "value" array`);
    }
    for (const item of items) {
      if (item === null || typeof item !== 'object') continue;
      const id = (item as { id?: unknown }).id;
      if (typeof id === 'string') {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      yield item as Record<string, unknown>;
    }
    const pointer = body?.['@odata.nextLink'];
    if (pointer === undefined || pointer === null || pointer === '') {
      next = undefined;
    } else if (typeof pointer !== 'string') {
      throw new GraphPagingError('"@odata.nextLink" is not a page pointer');
    } else {
      next = pointer;
    }
  }
}

export interface GraphBatchRequest {
  id: string;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Relative to the API version, e.g. `/users/{id}/memberOf`. */
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface GraphBatchResponse {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

/** Graph's own limit on sub-requests per `$batch`. */
export const GRAPH_BATCH_LIMIT = 20;
const MAX_BATCH_ROUNDS = 4;

/**
 * One `$batch` call, with the throttled items retried and nothing else.
 *
 * Graph answers each sub-request with its own status, and 429 on one item
 * says nothing about the others. The throttled ones are collected, the
 * largest `Retry-After` among them waited for, and only those are sent
 * again -- a bounded number of times, after which they are returned as they
 * last answered. A sub-request with no answer at all (Graph omits none, but
 * a fake or a proxy might) is reported as a 502 so the caller sees a failure
 * rather than a hole.
 */
export async function graphBatch(
  connection: EntraConnection,
  requests: GraphBatchRequest[],
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<Map<string, GraphBatchResponse>> {
  if (requests.length > GRAPH_BATCH_LIMIT) {
    throw new Error(`a Graph $batch holds at most ${GRAPH_BATCH_LIMIT} requests`);
  }
  const results = new Map<string, GraphBatchResponse>();
  let pending = requests;

  for (let round = 0; pending.length > 0 && round < MAX_BATCH_ROUNDS; round += 1) {
    const response = await graphRequest(connection, {
      method: 'POST',
      path: '/$batch',
      body: { requests: pending },
    });
    if (response.status >= 400) {
      // The envelope itself failed; every item inherits that answer.
      for (const request of pending) {
        results.set(request.id, { status: response.status, body: response.body, headers: {} });
      }
      return results;
    }
    const answers = (response.body as { responses?: unknown } | null)?.responses;
    const byId = new Map<string, GraphBatchResponse>();
    if (Array.isArray(answers)) {
      for (const answer of answers) {
        if (answer === null || typeof answer !== 'object') continue;
        const { id, status, body, headers } = answer as {
          id?: unknown;
          status?: unknown;
          body?: unknown;
          headers?: unknown;
        };
        if (typeof id !== 'string' || typeof status !== 'number') continue;
        const lowered: Record<string, string> = {};
        if (headers !== null && typeof headers === 'object') {
          for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
            if (typeof v === 'string') lowered[k.toLowerCase()] = v;
          }
        }
        byId.set(id, { status, body: body ?? null, headers: lowered });
      }
    }

    const retry: GraphBatchRequest[] = [];
    let waitMs = 0;
    for (const request of pending) {
      const answer = byId.get(request.id) ?? {
        status: 502,
        body: null,
        headers: {},
      };
      results.set(request.id, answer);
      if (answer.status === 429 && round + 1 < MAX_BATCH_ROUNDS) {
        retry.push(request);
        const seconds = Number(answer.headers['retry-after'] ?? '1');
        waitMs = Math.max(waitMs, Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 1000);
      }
    }
    pending = retry;
    if (pending.length > 0) await sleep(Math.min(waitMs, 60_000));
  }
  return results;
}

/** Escapes a value for an OData string literal. */
export function odataLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
