import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { trimTrailingSlashes } from './url.js';
import {
  ERROR_CODES,
  HEADERS,
  PROTOCOL_VERSION,
  REQUEST_SCHEMAS,
  RESPONSE_SCHEMAS,
  SUPPORTED_PROTOCOL_VERSIONS,
  WRITE_OPERATIONS,
  firstIssue,
  isMethod,
  type AccountsListResponse,
  type AccountsReadRequest,
  type AccountsReadResponse,
  type ContainersListResponse,
  type DescribeResponse,
  type EntitlementMembersRequest,
  type EntitlementMembersResponse,
  type EntitlementsListResponse,
  type ErrorCode,
  type ListRequest,
  type Method,
  type TestResponse,
  type WriteFailure,
  type WriteOperationName,
  type WriteOperationOf,
  type WriteResultBody,
} from './protocol.js';
import {
  DEFAULT_TOLERANCE_SECONDS,
  MIN_SECRET_LENGTH,
  MemoryNonceStore,
  verifyRequest,
  type NonceStore,
} from './signing.js';

/**
 * Thrown by a handler to report a failure Syntra should classify.
 *
 * From a write handler it becomes `{ ok: false, failure, message }`. From a
 * read it becomes an HTTP error: `throttled` is 429, `transient` 503, anything
 * else 500. The message reaches the administrator, so name the object and the
 * cause: `Account 4711 not found.`
 */
export class ConnectorError extends Error {
  readonly retryAfterMs: number | undefined;

  constructor(
    readonly failure: WriteFailure,
    message: string,
    options: { retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = 'ConnectorError';
    this.retryAfterMs = options.retryAfterMs;
  }
}

/** What every handler is given besides its request. */
export interface RequestContext {
  method: Method;
  /** The nonce Syntra signed the request with: unique per request, for logs. */
  requestId: string;
  /** When Syntra stops waiting, as a signal. Abandon the work when it fires. */
  signal: AbortSignal;
}

export type WriteHandlers = {
  [K in WriteOperationName]?: (operation: WriteOperationOf<K>, context: RequestContext) => Promise<WriteResultBody>;
};

/**
 * A connector: the target-specific half. Everything about the protocol
 * (signatures, versions, validation, error mapping) is the server's.
 */
export interface ConnectorDefinition {
  name: string;
  version: string;
  schema: { objectClasses: string[]; attributes: string[] };
  /** Whether accounts are placed in containers. Default false. */
  placesAccountsInContainers?: boolean;
  /** Check the target is reachable with the connector's own credentials. Default: ok, no message. */
  test?(context: RequestContext): Promise<TestResponse>;
  accounts: {
    list(request: ListRequest, context: RequestContext): Promise<AccountsListResponse>;
    read(request: AccountsReadRequest, context: RequestContext): Promise<AccountsReadResponse>;
  };
  entitlements?: {
    list(request: ListRequest, context: RequestContext): Promise<EntitlementsListResponse>;
    /** Every member, or throw. Never a partial list. */
    members(request: EntitlementMembersRequest, context: RequestContext): Promise<EntitlementMembersResponse>;
  };
  /** Required when `placesAccountsInContainers` is true. */
  containers?: {
    list(request: ListRequest, context: RequestContext): Promise<ContainersListResponse>;
  };
  /**
   * One handler per write the target supports. A write without a handler is
   * answered `rejected` without calling anything.
   *
   * Every handler must be idempotent by `operation.actionId`: Syntra repeats a
   * write after a timeout, and a repeated `create_account` must return the
   * anchor of the account the first attempt created. Record the action id on
   * the account where the target has room for it.
   */
  write: WriteHandlers;
}

export interface ConnectorServerOptions {
  connector: ConnectorDefinition;
  /**
   * The shared secret entered on the Syntra target, at least 32 characters.
   * Pass two during a rotation: the new one first, then the old.
   */
  secrets: string | readonly string[];
  /** Allowed clock difference. Default 300 s. */
  toleranceSeconds?: number;
  /** Largest request body accepted. Default 1 MiB. */
  maxBodyBytes?: number;
  /** Where seen nonces are kept. Default: in this process's memory. */
  nonces?: NonceStore;
  /** Path the methods sit under, e.g. `/syntra`. Default: the root. */
  basePath?: string;
  /**
   * Called with every handler error that is not a `ConnectorError`, and every
   * answer that failed validation. Default: one line on stderr. Request
   * bodies are never passed: a `create_account` carries a password.
   */
  onError?: (error: unknown, context: { method: Method; requestId: string }) => void;
  now?: () => number;
}

class ProtocolFailure extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly extra: { supportedVersions?: readonly number[]; retryAfterMs?: number } = {},
  ) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    [HEADERS.version]: String(PROTOCOL_VERSION),
    ...headers,
  });
  res.end(payload);
}

function sendFailure(res: ServerResponse, failure: ProtocolFailure): void {
  const retryAfter = failure.extra.retryAfterMs;
  send(
    res,
    ERROR_CODES[failure.code],
    {
      error: {
        code: failure.code,
        message: failure.message,
        ...(failure.extra.supportedVersions ? { supportedVersions: [...failure.extra.supportedVersions] } : {}),
        ...(retryAfter !== undefined ? { retryAfterMs: retryAfter } : {}),
      },
    },
    retryAfter !== undefined ? { 'retry-after': String(Math.ceil(retryAfter / 1000)) } : {},
  );
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? '0');
    if (declared > limit) {
      reject(new ProtocolFailure('payload_too_large', `Request body is larger than ${limit} bytes.`));
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      total += chunk.length;
      if (total > limit) {
        done = true;
        reject(new ProtocolFailure('payload_too_large', `Request body is larger than ${limit} bytes.`));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!done) resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** The `describe` answer a definition produces. Exported for tests and docs. */
export function describeConnector(connector: ConnectorDefinition): DescribeResponse {
  return {
    protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
    connector: { name: connector.name, version: connector.version },
    capabilities: {
      placesAccountsInContainers: connector.placesAccountsInContainers ?? false,
      entitlements: connector.entitlements !== undefined,
      operations: WRITE_OPERATIONS.filter((op) => connector.write[op] !== undefined),
    },
    schema: connector.schema,
  };
}

/**
 * A `node:http` request listener that serves one connector. Mount it on any
 * server: `http.createServer(listener)`, `https.createServer(tls, listener)`,
 * or behind a TLS-terminating proxy. Syntra stores only `https://` service
 * URLs, so something in front of it must speak TLS.
 */
export function createConnectorRequestListener(
  options: ConnectorServerOptions,
): (req: IncomingMessage, res: ServerResponse) => void {
  const secrets = typeof options.secrets === 'string' ? [options.secrets] : [...options.secrets];
  if (secrets.length === 0) throw new Error('No shared secret is set.');
  for (const secret of secrets) {
    if (secret.length < MIN_SECRET_LENGTH) {
      throw new Error(`Shared secret is shorter than ${MIN_SECRET_LENGTH} characters.`);
    }
  }
  const connector = options.connector;
  if (connector.placesAccountsInContainers && !connector.containers) {
    throw new Error(`Connector "${connector.name}" places accounts in containers but has no containers.list.`);
  }
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const maxBodyBytes = options.maxBodyBytes ?? 1_048_576;
  const nonces = options.nonces ?? new MemoryNonceStore();
  const now = options.now ?? Date.now;
  const basePath = trimTrailingSlashes(options.basePath ?? '');
  const onError =
    options.onError ??
    ((error: unknown, context: { method: Method; requestId: string }) => {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`Connector ${context.method} failed: ${reason} (request ${context.requestId})`);
    });
  const described = describeConnector(connector);

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    if (req.method !== 'POST') {
      throw new ProtocolFailure('invalid_request', `Method ${req.method ?? ''} is not allowed. Use POST.`);
    }
    if (basePath !== '' && !path.startsWith(`${basePath}/`)) {
      throw new ProtocolFailure('unknown_method', `No method at ${path}.`);
    }
    const name = path.slice(basePath.length + 1);
    const body = await readBody(req, maxBodyBytes);

    // Authentication first: an unsigned caller learns nothing, not even
    // which methods exist. The path segment is what is signed, so a request
    // for an unknown method still has to be signed to be told so.
    const nonce = header(req, HEADERS.nonce);
    const verified = await verifyRequest({
      secrets,
      method: name,
      body,
      timestamp: header(req, HEADERS.timestamp),
      nonce,
      signature: header(req, HEADERS.signature),
      nonces,
      toleranceSeconds: tolerance,
      now: now(),
    });
    if (!verified.ok) throw new ProtocolFailure('unauthenticated', verified.message);
    if (!isMethod(name)) throw new ProtocolFailure('unknown_method', `No method "${name}".`);
    const requestId = nonce ?? '';

    // `describe` is the handshake and is answered in any version: its shape
    // is the one thing no version may change.
    const version = Number(header(req, HEADERS.version));
    if (name !== 'describe' && !SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
      throw new ProtocolFailure(
        'unsupported_version',
        `Protocol version ${header(req, HEADERS.version) ?? '(none)'} is not supported.`,
        { supportedVersions: SUPPORTED_PROTOCOL_VERSIONS },
      );
    }

    let json: unknown;
    try {
      json = body.length === 0 ? {} : JSON.parse(body.toString('utf8'));
    } catch {
      throw new ProtocolFailure('invalid_request', 'Request body is not JSON.');
    }
    const parsed = REQUEST_SCHEMAS[name].safeParse(json);
    if (!parsed.success) {
      throw new ProtocolFailure('invalid_request', `Invalid ${name} request: ${firstIssue(parsed.error)}`);
    }

    const timeoutMs = Number(header(req, HEADERS.timeout));
    const signal =
      Number.isFinite(timeoutMs) && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : new AbortController().signal;
    const context: RequestContext = { method: name, requestId, signal };

    const answer = await dispatch(name, parsed.data, context);
    const valid = RESPONSE_SCHEMAS[name].safeParse(answer);
    if (!valid.success) {
      const problem = `Connector returned an invalid ${name} answer: ${firstIssue(valid.error)}`;
      onError(new Error(problem), { method: name, requestId });
      throw new ProtocolFailure('internal', problem);
    }
    send(res, 200, valid.data);
  }

  async function dispatch(method: Method, request: unknown, context: RequestContext): Promise<unknown> {
    switch (method) {
      case 'describe':
        return described;
      case 'test':
        return connector.test ? read(() => connector.test!(context), context) : { ok: true, message: '' };
      case 'accounts.list':
        return read(() => connector.accounts.list(request as ListRequest, context), context);
      case 'accounts.read':
        return read(() => connector.accounts.read(request as AccountsReadRequest, context), context);
      case 'entitlements.list':
        return connector.entitlements
          ? read(() => connector.entitlements!.list(request as ListRequest, context), context)
          : { entitlements: [], nextCursor: null };
      case 'entitlements.members':
        if (!connector.entitlements) {
          throw new ProtocolFailure('not_implemented', `Connector "${connector.name}" has no entitlements.`);
        }
        return read(() => connector.entitlements!.members(request as EntitlementMembersRequest, context), context);
      case 'containers.list':
        return connector.containers
          ? read(() => connector.containers!.list(request as ListRequest, context), context)
          : { containers: [], nextCursor: null };
      case 'write':
        return write((request as { operation: WriteOperationOf<WriteOperationName> }).operation, context);
    }
  }

  async function read<T>(run: () => Promise<T>, context: RequestContext): Promise<T> {
    try {
      return await run();
    } catch (cause) {
      if (cause instanceof ConnectorError) {
        const code: ErrorCode =
          cause.failure === 'throttled' ? 'throttled' : cause.failure === 'transient' ? 'unavailable' : 'internal';
        throw new ProtocolFailure(code, cause.message, cause.retryAfterMs === undefined ? {} : { retryAfterMs: cause.retryAfterMs });
      }
      onError(cause, { method: context.method, requestId: context.requestId });
      throw new ProtocolFailure('internal', `Connector "${connector.name}" failed on ${context.method}.`);
    }
  }

  async function write(
    operation: WriteOperationOf<WriteOperationName>,
    context: RequestContext,
  ): Promise<WriteResultBody> {
    const handler = connector.write[operation.op] as
      | ((operation: WriteOperationOf<WriteOperationName>, context: RequestContext) => Promise<WriteResultBody>)
      | undefined;
    if (!handler) {
      return { ok: false, failure: 'rejected', message: `Connector "${connector.name}" does not support ${operation.op}.` };
    }
    try {
      return await handler(operation, context);
    } catch (cause) {
      if (cause instanceof ConnectorError) {
        return {
          ok: false,
          failure: cause.failure,
          message: cause.message,
          ...(cause.retryAfterMs === undefined ? {} : { retryAfterMs: cause.retryAfterMs }),
        };
      }
      onError(cause, { method: 'write', requestId: context.requestId });
      return { ok: false, failure: 'transient', message: `Connector "${connector.name}" failed on ${operation.op}.` };
    }
  }

  return (req, res) => {
    handle(req, res).catch((cause: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (cause instanceof ProtocolFailure) {
        sendFailure(res, cause);
        return;
      }
      onError(cause, { method: 'describe', requestId: '' });
      sendFailure(res, new ProtocolFailure('internal', 'Connector service failed.'));
    });
  };
}

/** A plain HTTP server for the connector. Put TLS in front of it, or use `createConnectorRequestListener` with `https`. */
export function createConnectorServer(options: ConnectorServerOptions): Server {
  return createServer(createConnectorRequestListener(options));
}
