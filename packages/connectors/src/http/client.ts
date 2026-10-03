import { guardedFetch } from '../net/guarded-fetch.js';
import { REDACTED, scrubText } from '../observability/redact.js';
import type { WriteFailure } from '../types.js';
import type { ListSpec, ResolvedHttpConnectorDocument } from './document.js';
import { renderParams, type TemplateVars } from './template.js';

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
  auth: {
    tokenUrl: string;
    clientId: string;
    scope?: string | undefined;
    clientAuth?: 'body' | 'basic' | undefined;
    tokenParams?: Record<string, string> | undefined;
  },
  clientSecret: string,
  allowPrivateAddresses: boolean,
): Promise<string> {
  const clientAuth = auth.clientAuth ?? 'body';
  const tokenParams = auth.tokenParams ?? {};
  const key = JSON.stringify([auth.tokenUrl, auth.clientId, auth.scope ?? '', clientAuth, tokenParams]);
  const cached = tokens.get(key);
  if (cached && cached.expiresAt - TOKEN_SKEW_MS > Date.now()) return cached.value;

  const form = new URLSearchParams({
    ...tokenParams,
    grant_type: 'client_credentials',
    ...(clientAuth === 'body' ? { client_id: auth.clientId, client_secret: clientSecret } : {}),
    ...(auth.scope ? { scope: auth.scope } : {}),
  });
  // RFC 6749 2.3.1: each half form-encoded before it is joined and base64'd.
  const basic = (value: string) => encodeURIComponent(value).replace(/%20/g, '+');
  const fetcher = guardedFetch({ allowPrivateAddresses, timeoutMs: 30_000 });
  const response = await fetcher(auth.tokenUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(clientAuth === 'basic'
        ? {
            authorization: `Basic ${Buffer.from(`${basic(auth.clientId)}:${basic(clientSecret)}`).toString('base64')}`,
          }
        : {}),
    },
    body: form.toString(),
  });
  const text = await response.text();
  if (response.status >= 400) {
    // Token responses can echo the request, including the client secret, so
    // never surface their body. Microsoft does include a stable `AADSTS` code
    // in its diagnostic text, however; extracting that code alone gives an
    // administrator an actionable cause without turning an error screen into
    // a credential disclosure.
    const microsoftCode = /\bAADSTS\d{5,8}\b/.exec(text)?.[0];
    throw new Error(
      `the token endpoint answered HTTP ${response.status}` +
        (microsoftCode ? ` (${microsoftCode})` : ''),
    );
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
    case 'query':
      // Added to the URL by `httpRequest`.
      return {};
  }
}

/**
 * A request's own headers, without any that would carry or replace the
 * credential. `Headers` joins two spellings of one name rather than letting
 * the later win, so a templated `Authorization` would be sent alongside the
 * real one.
 */
function requestHeaders(
  document: ResolvedHttpConnectorDocument,
  headers: Record<string, string> | undefined,
): Record<string, string> {
  const reserved = new Set(['authorization', 'content-type']);
  if (document.auth.type === 'header') reserved.add(document.auth.header.toLowerCase());
  return Object.fromEntries(
    Object.entries(headers ?? {}).filter(([name]) => !reserved.has(name.toLowerCase())),
  );
}

export class FormBodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FormBodyError';
  }
}

/** A flat object of scalars as `application/x-www-form-urlencoded`. */
function formBody(body: unknown): string {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new FormBodyError('A form body must be an object.');
  }
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (value === null) continue;
    if (Array.isArray(value)) {
      for (const entry of value) form.append(key, String(entry));
    } else if (typeof value === 'object') {
      throw new FormBodyError(`Form field "${key}" is an object. A form body is flat.`);
    } else {
      form.append(key, String(value));
    }
  }
  return form.toString();
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
    /** This request's own headers. Never override the credential. */
    headers?: Record<string, string>;
    body?: unknown;
    bodyFormat?: 'json' | 'form';
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
  if (document.auth.type === 'query') url.searchParams.set(document.auth.param, credential);

  const form = input.bodyFormat === 'form';
  const response = await fetcher(url.toString(), {
    method: input.method,
    headers: {
      accept: 'application/json',
      ...document.headers,
      ...requestHeaders(document, input.headers),
      ...(await authHeaders(document, credential)),
      ...(input.body === undefined
        ? {}
        : { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' }),
    },
    ...(input.body === undefined
      ? {}
      : { body: form ? formBody(input.body) : JSON.stringify(input.body) }),
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

/** The longest failure message a body rule surfaces, after redaction. */
const BODY_MESSAGE_MAX = 300;

/** Every string in a target's `messages` value, depth-first and bounded. */
function flattenMessages(value: unknown, out: string[], depth = 0): void {
  if (out.length >= 20 || depth > 4) return;
  if (typeof value === 'string') {
    const text = value.trim();
    if (text !== '') out.push(text);
    return;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    out.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) flattenMessages(entry, out, depth + 1);
    return;
  }
  if (value !== null && typeof value === 'object') {
    // Values only. The keys of a validation map are field names, and every
    // message this has been seen against already names its field.
    for (const entry of Object.values(value)) flattenMessages(entry, out, depth + 1);
  }
}

/**
 * The failure a `2xx` body declares, or undefined when it declares none.
 *
 * `secrets` are values this request carried that must never come back out —
 * the vault credential, an initial password — and are removed by literal
 * match before the shape-based scrub, because a password has no shape a
 * pattern can recognise. The request body itself is never read here.
 */
export function bodyFailure(
  document: ResolvedHttpConnectorDocument,
  body: unknown,
  secrets: readonly (string | undefined)[] = [],
): { failure: WriteFailure; message: string } | undefined {
  const rule = document.failures.body;
  if (rule === undefined) return undefined;
  const marker = readPath(body, rule.at);
  if (marker === undefined || marker === null || typeof marker === 'object') return undefined;
  if (String(marker) !== rule.equals) return undefined;

  const { failure, text } = explain(body, rule, secrets);
  const explained = text === '' ? '' : `: ${text}`;
  return { failure, message: `the target refused the request${explained}` };
}

/**
 * The target's own message at `messageAt`, redacted and bounded, and the
 * classification its fragments pick. `rejected` when none match.
 */
function explain(
  body: unknown,
  rule: { messageAt?: string | undefined; conflictWhen: readonly string[]; notFoundWhen: readonly string[] },
  secrets: readonly (string | undefined)[],
): { failure: WriteFailure; text: string } {
  const parts: string[] = [];
  if (rule.messageAt !== undefined) flattenMessages(readPath(body, rule.messageAt), parts);
  const raw = parts.join('; ');
  const lowered = raw.toLocaleLowerCase();
  const matches = (fragments: readonly string[]) =>
    fragments.some((fragment) => lowered.includes(fragment.toLocaleLowerCase()));
  const failure: WriteFailure = matches(rule.conflictWhen)
    ? 'conflict'
    : matches(rule.notFoundWhen)
      ? 'not_found'
      : 'rejected';

  let text = raw;
  for (const secret of secrets) {
    // Four characters or more: a shorter "secret" would redact ordinary words.
    if (secret !== undefined && secret.length >= 4) text = text.split(secret).join(REDACTED);
  }
  return { failure, text: text === '' ? '' : scrubText(text, BODY_MESSAGE_MAX) };
}

/**
 * A `4xx` or `5xx` answer, classified and explained.
 *
 * The status decides first. Only a status the document's lists leave as
 * `rejected` is refined by `failures.error`, and its message is shown only
 * when the document names where it is.
 */
export function errorFailure(
  document: ResolvedHttpConnectorDocument,
  response: HttpResponse,
  secrets: readonly (string | undefined)[] = [],
): { failure: WriteFailure; message: string } {
  const byStatus = classify(document, response.status);
  const rule = document.failures.error;
  const base = `the target answered HTTP ${response.status}`;
  if (rule === undefined) return { failure: byStatus, message: base };
  const { failure, text } = explain(response.body, rule, secrets);
  return {
    failure: byStatus === 'rejected' ? failure : byStatus,
    message: text === '' ? base : `${base}: ${text}`,
  };
}

/** `Retry-After` in seconds or as an HTTP date, where the target sent one. */
export function retryAfterMs(headers: Headers, now = Date.now()): number | undefined {
  const value = headers.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : undefined;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/**
 * How a read waits before it tries again. An object so a test can replace
 * `sleep`.
 *
 * Writes are not retried here: `apply` retries a throttled or transient write
 * itself, with its own count. A read has nobody above it to do that, and one
 * throttled page out of forty would otherwise fail the whole run.
 */
export const readRetry = {
  attempts: 4,
  maxWaitMs: 60_000,
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

/**
 * A GET, tried again while the target answers `throttled` or `transient`,
 * waiting as long as its `Retry-After` says (up to a minute) or 1, 2, 4
 * seconds. The last answer is returned as it is, failure or not.
 */
export async function readRequest(
  document: ResolvedHttpConnectorDocument,
  credential: Credential,
  input: { path: string; query?: Record<string, string> },
): Promise<HttpResponse> {
  for (let attempt = 1; ; attempt += 1) {
    const response = await httpRequest(document, credential, { method: 'GET', ...input });
    if (response.status < 400 || attempt >= readRetry.attempts) return response;
    const failure = classify(document, response.status);
    if (failure !== 'throttled' && failure !== 'transient') return response;
    const backoff = 1000 * 2 ** (attempt - 1);
    await readRetry.sleep(Math.min(retryAfterMs(response.headers) ?? backoff, readRetry.maxWaitMs));
  }
}

/** The `rel="next"` URL in a `Link` header (RFC 8288), as written. */
export function nextLink(headers: Headers): string | undefined {
  const value = headers.get('link');
  if (!value) return undefined;
  for (const match of value.matchAll(/<([^>]*)>([^<]*)/g)) {
    const rel = /;\s*rel\s*=\s*(?:"([^"]*)"|([^\s;,]+))/i.exec(match[2] ?? '');
    const names = (rel?.[1] ?? rel?.[2] ?? '').toLowerCase().split(/\s+/);
    if (names.includes('next') && match[1]) return match[1];
  }
  return undefined;
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

/** The query for one page, before any paging parameter is added. */
export function firstPageQuery(spec: ListSpec, vars: TemplateVars = {}): Record<string, string> {
  const query = renderParams(spec.query, vars);
  switch (spec.paging.style) {
    case 'offset':
      return {
        ...query,
        [spec.paging.limitParam]: String(spec.paging.pageSize),
        [spec.paging.offsetParam]: '0',
      };
    case 'page':
      return {
        ...query,
        [spec.paging.pageParam]: String(spec.paging.firstPage),
        [spec.paging.sizeParam]: String(spec.paging.pageSize),
      };
    default:
      return query;
  }
}

/** The array of items in one page, or a `PagingError`. */
export function pageItems(spec: ListSpec, body: unknown): unknown[] {
  const items = spec.itemsAt ? readPath(body, spec.itemsAt) : body;
  if (!Array.isArray(items)) {
    throw new PagingError(
      spec.itemsAt
        ? `${spec.path} has no array at "${spec.itemsAt}"`
        : `${spec.path} did not answer with an array`,
    );
  }
  return items;
}

/** The stated item count at `totalAt`, or a `PagingError`. */
function statedTotal(spec: ListSpec, totalAt: string, body: unknown): number {
  const stated = Number(readPath(body, totalAt));
  if (!Number.isInteger(stated) || stated < 0) {
    throw new PagingError(`${spec.path} has no item count at "${totalAt}"`);
  }
  return stated;
}

export async function* paginate(
  document: ResolvedHttpConnectorDocument,
  credential: Credential,
  spec: ListSpec,
  vars: TemplateVars = {},
): AsyncIterable<unknown> {
  const fixed = renderParams(spec.query, vars);
  let path = spec.path;
  let query: Record<string, string> = firstPageQuery(spec, vars);
  // Items seen so far: the next offset, or the count held against `totalAt`.
  let seen = 0;

  for (let page = 0; ; page += 1) {
    if (page >= MAX_PAGES) {
      throw new PagingError(
        `Incomplete read: ${spec.path} was still paging after ${MAX_PAGES} pages. No partial list was returned.`,
      );
    }

    const response = await readRequest(document, credential, { path, query });
    if (response.status >= 400) {
      throw new PagingError(`${spec.path}: ${errorFailure(document, response, [credential]).message}`);
    }
    const refused = bodyFailure(document, response.body, [credential]);
    if (refused) throw new PagingError(`${spec.path}: ${refused.message}`);

    const items = pageItems(spec, response.body);
    for (const item of items) yield item;
    seen += items.length;

    const paging = spec.paging;
    switch (paging.style) {
      case 'none':
        return;

      case 'offset':
      case 'page': {
        if (paging.totalAt !== undefined) {
          // Each page's own count: a collection that shrinks while it is
          // walked ends where it now ends, rather than failing on an empty
          // page it was told to expect.
          const total = statedTotal(spec, paging.totalAt, response.body);
          if (seen >= total) return;
          if (items.length === 0) {
            throw new PagingError(
              `Incomplete read: ${spec.path} stopped answering at ${seen} of ${total} items. No partial list was returned.`,
            );
          }
        } else if (paging.style === 'offset') {
          // A short page is the end. A full one might be, and asking once
          // more is the only way to find out — an offset API with no stated
          // total has no other terminator.
          if (items.length < paging.pageSize) return;
        } else if (items.length === 0) {
          // Numbered pages end at an empty one; see the `page` style.
          return;
        }
        query =
          paging.style === 'offset'
            ? { ...fixed, [paging.limitParam]: String(paging.pageSize), [paging.offsetParam]: String(seen) }
            : {
                ...fixed,
                [paging.pageParam]: String(paging.firstPage + page + 1),
                [paging.sizeParam]: String(paging.pageSize),
              };
        continue;
      }

      case 'link': {
        const next = nextLink(response.headers);
        if (next === undefined) return;
        // Resolved against `baseUrl`; `httpRequest` refuses another origin.
        path = new URL(next, `${document.baseUrl.replace(/\/$/, '')}/`).toString();
        query = {};
        continue;
      }

      case 'cursor': {
        const next = readPath(response.body, paging.nextAt);
        if (next === undefined || next === null || next === '') return;
        if (typeof next !== 'string') {
          throw new PagingError(`"${paging.nextAt}" is not a page pointer`);
        }
        if (paging.kind === 'url') {
          path = next;
          query = {};
        } else {
          query = { ...fixed, [paging.tokenParam]: next };
        }
        continue;
      }
    }
  }
}
