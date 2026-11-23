import {
  HEADERS,
  PROTOCOL_VERSION,
  REQUEST_SCHEMAS,
  RESPONSE_SCHEMAS,
  errorResponseSchema,
  firstIssue,
  type Account,
  type DescribeResponse,
  type Entitlement,
  type Method,
  type RequestOf,
  type ResponseOf,
  type WriteFailure,
  type WriteOperation,
  type WriteResultBody,
} from './protocol.js';
import { MIN_SECRET_LENGTH, signRequest } from './signing.js';
import { trimTrailingSlashes } from './url.js';

/**
 * The calling side of the protocol: what Syntra uses to talk to a connector
 * service, and what the certification runner uses to test one.
 *
 * `fetch` is injectable so Syntra can pass its outbound-guarded fetch (address
 * checks, no redirects, a size cap). The default is the global `fetch`.
 */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ConnectorClientOptions {
  /** The service's base URL; methods are posted to `{baseUrl}/{method}`. */
  baseUrl: string;
  /** The shared secret, at least 32 characters. */
  secret: string;
  /** Per request. Default 30 000. */
  timeoutMs?: number;
  fetch?: FetchLike;
  /** Injectable for tests. */
  now?: () => number;
  nonce?: () => string;
}

export type ConnectorServiceErrorCode =
  | 'unauthenticated'
  | 'unsupported_version'
  | 'invalid_request'
  | 'unknown_method'
  | 'payload_too_large'
  | 'throttled'
  | 'internal'
  | 'not_implemented'
  | 'unavailable'
  /** No answer within `timeoutMs`. */
  | 'timeout'
  /** No answer at all: DNS, refused connection, TLS, an address the guard refused. */
  | 'network'
  /** An answer that is not the protocol: not JSON, or not the method's schema. */
  | 'malformed';

/** A call that did not produce the method's answer. Its message is safe to show. */
export class ConnectorServiceError extends Error {
  constructor(
    readonly code: ConnectorServiceErrorCode,
    readonly method: Method,
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
    readonly supportedVersions?: readonly number[],
  ) {
    super(message);
    this.name = 'ConnectorServiceError';
  }
}

export interface ReadBack {
  account: Account | null;
  entitlementIds: string[];
  enabled: boolean | null;
  /** False when enabled state or any membership could not be read. */
  complete: boolean;
}

const MAX_MESSAGE = 500;

function clip(message: string): string {
  return message.length > MAX_MESSAGE ? `${message.slice(0, MAX_MESSAGE - 1)}…` : message;
}

function retryAfterHeader(response: Response): number | undefined {
  const raw = response.headers.get('retry-after');
  if (raw === null) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 86_400_000);
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

const KNOWN_CODES = new Set<string>([
  'unauthenticated',
  'unsupported_version',
  'invalid_request',
  'unknown_method',
  'payload_too_large',
  'throttled',
  'internal',
  'not_implemented',
  'unavailable',
]);

function codeForStatus(status: number): ConnectorServiceErrorCode {
  if (status === 401 || status === 403) return 'unauthenticated';
  if (status === 404) return 'unknown_method';
  if (status === 413) return 'payload_too_large';
  if (status === 429) return 'throttled';
  if (status === 501) return 'not_implemented';
  if (status === 502 || status === 503 || status === 504) return 'unavailable';
  if (status >= 500) return 'internal';
  return 'invalid_request';
}

export class ConnectorClient {
  readonly baseUrl: string;
  private readonly secret: string;
  private readonly timeoutMs: number;
  private readonly fetcher: FetchLike;
  private readonly now: () => number;
  private readonly nonce: (() => string) | undefined;

  constructor(options: ConnectorClientOptions) {
    if (options.secret.length < MIN_SECRET_LENGTH) {
      throw new Error(`Shared secret is shorter than ${MIN_SECRET_LENGTH} characters.`);
    }
    this.baseUrl = trimTrailingSlashes(options.baseUrl);
    this.secret = options.secret;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetcher = options.fetch ?? ((url, init) => fetch(url, init));
    this.now = options.now ?? Date.now;
    this.nonce = options.nonce;
  }

  /**
   * One call. Resolves with the validated answer or throws
   * `ConnectorServiceError`; never anything else.
   */
  async call<M extends Method>(method: M, request: RequestOf<M>): Promise<ResponseOf<M>> {
    // Validated on the way out as well as on the way in: a request this end
    // built wrongly is a bug here, and the service should never be the one to
    // find it.
    const outgoing = REQUEST_SCHEMAS[method].safeParse(request);
    if (!outgoing.success) {
      throw new ConnectorServiceError('invalid_request', method, `Request for ${method} is invalid: ${firstIssue(outgoing.error)}`);
    }
    const body = JSON.stringify(outgoing.data);
    const signed = signRequest(this.secret, method, body, {
      now: this.now(),
      ...(this.nonce ? { nonce: this.nonce() } : {}),
    });
    const url = `${this.baseUrl}/${method}`;
    const signal = AbortSignal.timeout(this.timeoutMs);

    let response: Response;
    let text: string;
    try {
      response = await this.fetcher(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          [HEADERS.version]: String(PROTOCOL_VERSION),
          [HEADERS.timestamp]: signed.timestamp,
          [HEADERS.nonce]: signed.nonce,
          [HEADERS.signature]: signed.signature,
          [HEADERS.timeout]: String(this.timeoutMs),
        },
        body,
        signal,
      });
      text = await response.text();
    } catch (cause) {
      if (signal.aborted) {
        throw new ConnectorServiceError('timeout', method, `No answer to ${method} from ${this.baseUrl} within ${this.timeoutMs} ms.`);
      }
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new ConnectorServiceError('network', method, clip(`${method} to ${this.baseUrl} failed: ${reason}`));
    }

    let json: unknown;
    try {
      json = text === '' ? null : JSON.parse(text);
    } catch {
      if (response.status >= 400) throw this.statusError(method, response, undefined);
      throw new ConnectorServiceError('malformed', method, `Answer to ${method} is not JSON (HTTP ${response.status}).`, response.status);
    }

    if (response.status < 200 || response.status >= 300) {
      throw this.statusError(method, response, json);
    }

    const parsed = RESPONSE_SCHEMAS[method].safeParse(json);
    if (!parsed.success) {
      throw new ConnectorServiceError(
        'malformed',
        method,
        clip(`Answer to ${method} does not match protocol ${PROTOCOL_VERSION}: ${firstIssue(parsed.error)}`),
        response.status,
      );
    }
    return parsed.data as ResponseOf<M>;
  }

  private statusError(method: Method, response: Response, json: unknown): ConnectorServiceError {
    const parsed = errorResponseSchema.safeParse(json);
    const body = parsed.success ? parsed.data.error : undefined;
    const code =
      body && KNOWN_CODES.has(body.code)
        ? (body.code as ConnectorServiceErrorCode)
        : codeForStatus(response.status);
    const retryAfterMs = body?.retryAfterMs ?? retryAfterHeader(response);
    const detail = body?.message ? `: ${body.message}` : '';
    let message: string;
    switch (code) {
      case 'unauthenticated':
        message = `Connector service refused Syntra's signature on ${method} (HTTP ${response.status})${detail || '.'} Check the shared secret.`;
        break;
      case 'unsupported_version':
        message = `Connector service does not speak protocol ${PROTOCOL_VERSION}${
          body?.supportedVersions ? ` (it speaks ${body.supportedVersions.join(', ')})` : ''
        }. Update the connector service or Syntra.`;
        break;
      default:
        message = `${method} failed with HTTP ${response.status}${detail}`;
    }
    return new ConnectorServiceError(code, method, clip(message), response.status, retryAfterMs, body?.supportedVersions);
  }

  describe(): Promise<DescribeResponse> {
    return this.call('describe', {});
  }

  /**
   * Null when this build can talk to the service, otherwise why not. Run on
   * every connection test, so an incompatible service never gets a write.
   */
  static incompatibility(described: DescribeResponse): string | null {
    if (!described.protocolVersions.includes(PROTOCOL_VERSION)) {
      return `Connector service "${described.connector.name}" speaks protocol ${described.protocolVersions.join(', ')}. Syntra speaks ${PROTOCOL_VERSION}. Update the connector service or Syntra.`;
    }
    return null;
  }

  test(): Promise<ResponseOf<'test'>> {
    return this.call('test', {});
  }

  async *accounts(pageSize: number): AsyncIterable<Account> {
    for await (const page of this.pages('accounts.list', pageSize)) yield* page.accounts;
  }

  async *entitlements(pageSize: number): AsyncIterable<Entitlement> {
    for await (const page of this.pages('entitlements.list', pageSize)) yield* page.entitlements;
  }

  async *containers(pageSize: number): AsyncIterable<{ dn: string }> {
    for await (const page of this.pages('containers.list', pageSize)) yield* page.containers;
  }

  private async *pages<M extends 'accounts.list' | 'entitlements.list' | 'containers.list'>(
    method: M,
    pageSize: number,
  ): AsyncIterable<ResponseOf<M>> {
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (;;) {
      const page = (await this.call(method, { cursor, pageSize } as RequestOf<M>)) as ResponseOf<M>;
      yield page;
      const next = page.nextCursor;
      if (next === null) return;
      // A service that hands back a cursor it already gave would be read
      // forever. Thrown rather than stopped: stopping is a partial read.
      if (seen.has(next)) {
        throw new ConnectorServiceError('malformed', method, `${method} returned cursor "${clip(next)}" twice.`);
      }
      seen.add(next);
      cursor = next;
    }
  }

  async entitlementMembers(entitlementId: string): Promise<string[]> {
    return (await this.call('entitlements.members', { entitlementId })).members;
  }

  /**
   * The account and what it holds, as one observation. Complete only when the
   * service could say both whether it is enabled and every entitlement it
   * holds.
   */
  async readBack(anchor: string): Promise<ReadBack> {
    const read = await this.call('accounts.read', { anchor });
    if (!read.account) return { account: null, entitlementIds: [], enabled: null, complete: true };
    return {
      account: read.account,
      entitlementIds: [...read.entitlementIds].sort(),
      enabled: read.account.enabled,
      complete: read.entitlementsComplete && read.account.enabled !== null,
    };
  }

  /**
   * One write. Never throws: every failure is a `WriteResult` with a
   * classification, because only this end knows how an HTTP or network
   * failure maps onto Syntra's retry rules.
   */
  async write(operation: WriteOperation): Promise<WriteResultBody> {
    let result: WriteResultBody;
    try {
      result = await this.call('write', { operation });
    } catch (cause) {
      return writeFailureFrom(cause, operation);
    }
    if (result.ok && operation.op === 'create_account' && result.anchor === undefined) {
      return {
        ok: false,
        failure: 'rejected',
        message: `Connector service created ${operation.correlationKey} without returning an anchor.`,
      };
    }
    return { ...result, message: clip(result.message) };
  }
}

/**
 * How a call that did not complete maps onto Syntra's retry rules.
 *
 * A timeout, a dropped connection and a 5xx are `transient`: the write may or
 * may not have happened, and retrying is safe only because every write is
 * idempotent by `actionId`. A malformed answer is `transient` for the same
 * reason; the attempt limit on the target bounds it.
 */
export function writeFailureFrom(cause: unknown, operation: WriteOperation): WriteResultBody {
  if (!(cause instanceof ConnectorServiceError)) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, failure: 'transient', message: clip(`${operation.op} failed: ${reason}`) };
  }
  const failure: WriteFailure = (() => {
    switch (cause.code) {
      case 'unauthenticated':
        return 'unauthorized';
      case 'throttled':
        return 'throttled';
      case 'unsupported_version':
      case 'invalid_request':
      case 'unknown_method':
      case 'payload_too_large':
      case 'not_implemented':
        return 'rejected';
      case 'internal':
      case 'unavailable':
      case 'timeout':
      case 'network':
      case 'malformed':
        return 'transient';
    }
  })();
  return {
    ok: false,
    failure,
    message: cause.message,
    ...(failure === 'throttled' && cause.retryAfterMs !== undefined ? { retryAfterMs: cause.retryAfterMs } : {}),
  };
}

export function createConnectorClient(options: ConnectorClientOptions): ConnectorClient {
  return new ConnectorClient(options);
}
