/**
 * The one set of rules for what may leave this process in a log line, a span
 * attribute or a span status -- and the functions that apply them.
 *
 * WHY HERE, in the connectors package: it is the lowest package every
 * server-side consumer already depends on (core imports it, the API imports
 * it), and the connectors are also the code most likely to put a credential
 * into an error. `guardedFetch` lives here for the same reason. A second copy
 * of these rules in core would be a second opinion about what a secret is, and
 * the two would drift -- the failure this module exists to prevent.
 *
 * THE THREAT, concretely. Nothing here is hypothetical:
 *
 *  - An HTTP client error that carries its request config: axios puts
 *    `config.headers.Authorization` on every error it throws, and a library
 *    that wraps `fetch` often attaches the `RequestInit` it was given. Pino's
 *    stock `err` serializer copies EVERY enumerable property, so one
 *    `log.error({ err })` writes the bearer token to disk.
 *  - An LDAP bind failure whose message or properties name the bind DN, and a
 *    wrapper that helpfully adds the password it tried.
 *  - A connection string in a Prisma or pg error: `postgres://user:pass@host`.
 *  - A SAML response or a PEM private key pasted into a message by a
 *    validation error that echoes its input.
 *  - Personal data: an email address, a display name or a DN in a message,
 *    or a whole person record handed to the logger as context.
 *
 * THE APPROACH is defence in depth rather than one clever filter:
 *
 *  1. Keys. A value under a key that names a secret is replaced, whatever it
 *     looks like; a value under a key that names personal data is replaced
 *     too. Matching is on the normalised key (case- and separator-blind), so
 *     `Authorization`, `client_secret` and `clientSecret` are one rule.
 *  2. Text. Strings are scrubbed for the shapes a secret or an identifier has
 *     even when nobody labelled it: `Bearer …`, JWTs, PEM blocks, URL
 *     credentials and query strings, `password=…` pairs, SAML XML, DNs and
 *     email addresses.
 *  3. Bounds. Depth, width and length are capped, so a log line cannot become
 *     a copy of an HR file because somebody logged the batch.
 *
 * What survives is what an operator needs to act: the error's type, code,
 * status, a scrubbed message, a scrubbed stack, the cause chain, the host that
 * failed and the tenant it failed for. Tenant ids and other opaque UUIDs are
 * not personal data and are deliberately kept -- without them no incident can
 * be scoped.
 */

export const REDACTED = '[redacted]';
export const REDACTED_PERSONAL = '[redacted:personal]';
export const OMITTED = '[omitted]';

/** How far into a nested object a log value is followed. */
const MAX_DEPTH = 6;
/** How many entries of one array or object are kept. */
const MAX_ENTRIES = 50;
/** How long one string may be. A stack is allowed more room than a value. */
const MAX_STRING = 1_000;
const MAX_STACK = 4_000;
/** How long a cause chain is followed before it stops being useful. */
const MAX_CAUSES = 5;

/**
 * Keys whose VALUE is a secret, compared after lower-casing and removing
 * `-`, `_` and spaces. A substring match: `bindPassword`, `x-api-key` and
 * `refresh_token` are all caught by one entry each.
 *
 * `key` alone is deliberately absent -- `tenantKey`, `primaryKey` and
 * `idempotencyKey` are ordinary diagnostics -- and the specific key-shaped
 * secrets are listed instead.
 */
const SECRET_KEY_FRAGMENTS = [
  'password',
  'passwd',
  'passphrase',
  'secret', // clientSecret, sessionSecret, totpSecret, webhook secrets
  'token', // accessToken, bearerToken, refreshToken, idToken, metricsToken
  'authorization',
  'cookie', // cookie, set-cookie
  'apikey',
  'privatekey',
  'masterkey',
  'signingkey',
  'credential',
  'assertion', // SAML assertions, client assertions
  'samlresponse',
  'samlrequest',
  'plaintext', // vault plaintext
  'ciphertext',
  'wrappeddek',
  'totp',
  'emailotp',
  'otpcode',
  'otpauth', // `otpauth://` enrolment URIs carry the TOTP seed
  'recoverycode',
  'codeverifier',
  'authcode',
  'authorizationcode',
  'sessionid',
  'bearer',
  'signature',
];

/** Exact keys (normalised) that are secrets but too short to match on. */
// `code` is deliberately NOT here: it is the error code on every Node, Prisma
// and pg error, and the one field an operator searches by. An OAuth
// authorization code travels in a query string, which `scrubText` removes.
// Substring matching is avoided for these because `otp` is inside `rootPath`
// and `ssn` inside `className`; exact keys only.
const SECRET_KEYS_EXACT = new Set(['pwd', 'pass', 'otp', 'pin', 'dek', 'iv', 'sid', 'jwt', 'pem']);

/**
 * Keys whose VALUE is personal data. Replaced rather than masked: a partial
 * email is still an email to a regulator, and the log never needed it.
 */
const PERSONAL_KEY_FRAGMENTS = [
  'email',
  'proxyaddress',
  'userprincipalname',
  'displayname',
  'givenname',
  'firstname',
  'lastname',
  'surname',
  'familyname',
  'fullname',
  'middlename',
  'nickname',
  'phone',
  'mobile',
  'telephone',
  'address', // street, postal, home -- `remoteAddress` is handled below
  'birth',
  'nationalid',
  'employeeid',
  'employeenumber',
  'samaccountname',
  'username',
  'loginname',
  'distinguishedname',
  'binddn',
  'manager',
];

/** Exact personal keys too short or too generic for a substring match. */
// `name` is deliberately absent: job, queue, target and source names are
// administrator-chosen labels an operator needs, and an Error's `name` is its
// type. A person's name arrives under `displayName`, `givenName` and friends.
const PERSONAL_KEYS_EXACT = new Set(['dn', 'cn', 'uid', 'sn', 'mail', 'upn', 'ssn', 'login', 'person', 'attributes', 'memberdns']);

/**
 * Keys that LOOK personal by the rules above but carry infrastructure, not a
 * human: the server a connector could not reach is an operator's first
 * question.
 *
 * The CLIENT address (`remoteAddress`, `sourceIp`) is kept in logs on
 * purpose, as it was before this module: it is the evidence a brute-force or
 * credential-stuffing investigation starts from, and the audit log records it
 * for the same reason. It is never put on a span or a metric label.
 */
const ALLOWED_KEYS = new Set([
  'remoteaddress',
  'sourceip',
  'serveraddress',
  'hostaddress',
  'host',
  'hostname',
  'tenantid',
  'tenantslug',
  'jobname',
  'queue',
]);

/**
 * Keys that hold a request or response body, or a whole request object. The
 * value is dropped rather than walked: a body is exactly where a password
 * travels, and its structure is not something an operator reads a log for.
 */
const BODY_KEYS = new Set(['body', 'rawbody', 'requestbody', 'responsebody', 'payload', 'form', 'formdata', 'rawheaders']);

/**
 * Keys on an ERROR whose value is the request that failed. Projected to the
 * three fields worth keeping -- method, a scrubbed URL, a status -- because
 * that is how axios, got and friends attach `Authorization`, and walking them
 * key by key would trust a rule list to know every header name.
 */
const REQUEST_CONTAINER_KEYS = new Set(['config', 'request', 'response', 'options', 'req', 'res', 'init']);

function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[-_\s.]/g, '');
}

/** Whether the value under `key` is a secret. */
export function isSecretKey(key: string): boolean {
  const k = normaliseKey(key);
  if (SECRET_KEYS_EXACT.has(k)) return true;
  return SECRET_KEY_FRAGMENTS.some((fragment) => k.includes(fragment));
}

/** Whether the value under `key` is personal data. */
export function isPersonalKey(key: string): boolean {
  const k = normaliseKey(key);
  if (ALLOWED_KEYS.has(k)) return false;
  if (PERSONAL_KEYS_EXACT.has(k)) return true;
  return PERSONAL_KEY_FRAGMENTS.some((fragment) => k.includes(fragment));
}

/**
 * Patterns applied to every string, in order. Each is a shape a secret or an
 * identifier has even when it arrives unlabelled inside a sentence.
 */
const TEXT_RULES: Array<[RegExp, string | ((...groups: string[]) => string)]> = [
  // PEM blocks: private keys, certificates. The whole block, headers and all.
  [/-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g, '[redacted:pem]'],
  // SAML/XML assertions and protocol messages.
  [/<(?:[\w-]+:)?(?:Assertion|Response|EncryptedAssertion|AuthnRequest|LogoutRequest)\b[\s\S]*?(?:<\/(?:[\w-]+:)?(?:Assertion|Response|EncryptedAssertion|AuthnRequest|LogoutRequest)>|$)/g, '[redacted:saml]'],
  // Authorization schemes followed by a credential.
  // Twelve characters or more, so that "Basic auth failed" stays a sentence.
  [/\b(Bearer|Basic|Digest|Negotiate|NTLM|SSWS)\s+[A-Za-z0-9._~+/=-]{12,}/gi, (_m, scheme: string) => `${scheme} ${REDACTED}`],
  // JWTs and JWT-shaped tokens (header.payload[.signature]).
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]*)?/g, '[redacted:jwt]'],
  // Credentials in a URL or connection string: scheme://user:pass@host.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]*@/gi, (_m, scheme: string) => `${scheme}${REDACTED}@`],
  // Query strings: authentication callbacks and reset links carry credentials
  // there, and `serializeRequest` drops them from request logs for the same
  // reason. Kept: the `?` so a reader knows there was one.
  [/(https?:\/\/[^\s?#"'<>]+)\?[^\s#"'<>]*/gi, (_m, base: string) => `${base}?${REDACTED}`],
  // key=value and key: value pairs whose key names a secret.
  [/\b([\w-]*(?:password|passwd|pwd|secret|token|api[_-]?key|authorization|cookie|totp|code_verifier|client_assertion)[\w-]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&"'}]+)/gi, (_m, key: string, sep: string) => `${key}${sep}${REDACTED}`],
  // Distinguished names: `CN=Jane Doe,OU=Staff,DC=acme,DC=test`. The RDN
  // values that name a person are replaced; the domain components are kept
  // because "which directory" is diagnostic and not personal.
  [/\b(CN|UID|OU|SN|GIVENNAME|MAIL|SAMACCOUNTNAME|USERPRINCIPALNAME)=((?:\\.|[^,+;"\n\\])+)/gi, (_m, attr: string) => `${attr}=${REDACTED_PERSONAL}`],
  // Email addresses and UPNs.
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[redacted:email]'],
  // Long opaque credential-looking runs: 32+ base64/base64url characters that
  // mix digits, upper and lower case -- an API key, a client secret. UUIDs
  // (lower-case hex) and file paths in a stack (rarely all three, and broken
  // by `.` and `@`) do not have that shape and are kept.
  [/(?<![A-Za-z0-9+/_-])(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[a-z])(?=[A-Za-z0-9+/_-]*[A-Z])[A-Za-z0-9+/_-]{32,}={0,2}/g, '[redacted:opaque]'],
];

/**
 * Scrub a free-text string (an error message, a stack, a span status) of
 * every shape above, and bound its length.
 */
export function scrubText(text: string, max = MAX_STRING): string {
  let out = text;
  for (const [pattern, replacement] of TEXT_RULES) {
    out = out.replace(pattern, replacement as never);
  }
  return out.length > max ? `${out.slice(0, max)}…[truncated ${out.length - max}]` : out;
}

/** A URL with its credentials and query removed, or `[redacted]` if unparseable. */
export function scrubUrl(url: unknown): string | undefined {
  if (url === undefined || url === null) return undefined;
  const text = url instanceof URL ? url.href : String(url);
  try {
    const parsed = new URL(text, 'http://relative.invalid');
    const base = parsed.host === 'relative.invalid' ? parsed.pathname : `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
    return scrubText(base);
  } catch {
    return scrubText(text.split('?')[0] ?? '');
  }
}

function projectRequestLike(value: unknown, depth: number): unknown {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'string' ? scrubText(value) : value;
  }
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const method = source.method;
  if (typeof method === 'string') out.method = method.slice(0, 16);
  const url = source.url ?? source.href ?? source.path ?? source.uri;
  if (url !== undefined) out.url = scrubUrl(url);
  const baseURL = source.baseURL;
  if (baseURL !== undefined) out.baseURL = scrubUrl(baseURL);
  const status = source.status ?? source.statusCode;
  if (typeof status === 'number') out.status = status;
  // Nested once: axios' `error.response.config` and `error.request.res`.
  if (depth < 2) {
    for (const key of ['response', 'res']) {
      if (source[key] && typeof source[key] === 'object') {
        out[key] = projectRequestLike(source[key], depth + 1);
      }
    }
  }
  out.omitted = 'headers, bodies and credentials of the failed request';
  return out;
}

/**
 * Deep-copy a value into something safe to log: secrets and personal data
 * replaced by key, every string scrubbed by shape, and the whole bounded.
 *
 * Errors met on the way are serialised by `serializeError`, so an error
 * nested in a context object gets the same treatment as one logged as `err`.
 */
export function redactValue(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return scrubText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  if (value instanceof URL) return scrubUrl(value);
  if (value instanceof Error) return serializeError(value, depth, seen);
  if (Buffer.isBuffer(value) || value instanceof Uint8Array || value instanceof ArrayBuffer) {
    // Bytes in a log are either a key, ciphertext or a file. None belongs there.
    return `[bytes:${(value as { byteLength: number }).byteLength}]`;
  }
  if (typeof value !== 'object') return REDACTED;
  if (seen.has(value)) return '[circular]';
  if (depth >= MAX_DEPTH) return '[depth limit]';
  seen.add(value);

  if (value instanceof Map) {
    return redactValue(Object.fromEntries([...value.entries()].slice(0, MAX_ENTRIES).map(([k, v]) => [String(k), v])), depth, seen);
  }
  if (value instanceof Set) {
    return redactValue([...value.values()], depth, seen);
  }
  if (Array.isArray(value)) {
    const kept = value.slice(0, MAX_ENTRIES).map((item) => redactValue(item, depth + 1, seen));
    if (value.length > MAX_ENTRIES) kept.push(`[${value.length - MAX_ENTRIES} more]`);
    return kept;
  }
  // A bare Fetch `Headers` logged on its own: treated as headers wherever it is.
  if (typeof Headers !== 'undefined' && value instanceof Headers) return redactHeaders(value);
  return redactObject(value as Record<string, unknown>, depth, seen);
}

function redactObject(source: Record<string, unknown>, depth: number, seen: WeakSet<object>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const keys = Object.keys(source);
  for (const key of keys.slice(0, MAX_ENTRIES)) {
    let child: unknown;
    try {
      child = source[key];
    } catch {
      continue; // a throwing getter is not a reason to lose the log line
    }
    out[key] = redactEntry(key, child, depth, seen);
  }
  if (keys.length > MAX_ENTRIES) out['[truncated]'] = `${keys.length - MAX_ENTRIES} more keys`;
  return out;
}

function redactEntry(key: string, child: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (child === undefined) return undefined;
  const k = normaliseKey(key);
  if (isSecretKey(key)) return REDACTED;
  if (BODY_KEYS.has(k)) return OMITTED;
  if (k === 'headers') return redactHeaders(child);
  if (isPersonalKey(key)) return REDACTED_PERSONAL;
  if (k === 'url' || k === 'href' || k === 'uri') return scrubUrl(child);
  return redactValue(child, depth + 1, seen);
}

/**
 * Headers are kept by NAME only, except for a short list whose values are
 * diagnostic and never credentials. An allow-list, because the deny-list
 * above cannot know every vendor's `X-Whatever-Auth`.
 */
const SAFE_HEADERS = new Set(['content-type', 'content-length', 'accept', 'retry-after', 'x-ms-request-id', 'request-id', 'client-request-id', 'x-request-id', 'user-agent']);

function redactHeaders(headers: unknown): unknown {
  if (headers === null || typeof headers !== 'object') return REDACTED;
  const entries: Array<[string, unknown]> = [];
  if (typeof (headers as { forEach?: unknown }).forEach === 'function' && !Array.isArray(headers)) {
    try {
      (headers as { forEach(cb: (v: unknown, k: string) => void): void }).forEach((v, k) => entries.push([k, v]));
    } catch {
      return REDACTED;
    }
  } else {
    entries.push(...Object.entries(headers as Record<string, unknown>));
  }
  const out: Record<string, unknown> = {};
  for (const [name, value] of entries.slice(0, MAX_ENTRIES)) {
    out[name] = SAFE_HEADERS.has(name.toLowerCase()) && typeof value !== 'object' ? scrubText(String(value), 200) : REDACTED;
  }
  return out;
}

export interface SerializedError {
  type: string;
  message: string;
  stack?: string;
  code?: string | number;
  [key: string]: unknown;
}

/** Own properties of an Error that are handled explicitly rather than walked. */
const ERROR_HANDLED = new Set(['name', 'message', 'stack', 'cause', 'errors', 'code']);

/**
 * The error serializer: what `log.error({ err })` writes, and what a span
 * status is built from.
 *
 * Keeps the type, a scrubbed message, a scrubbed stack, the code, any
 * numeric status, the cause chain and the members of an `AggregateError`.
 * Every other own property is walked with `redactValue` -- except the ones
 * that hold the failed request, which are projected to method, URL and status
 * so the headers that carried the credential never reach the walker at all.
 */
export function serializeError(error: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): SerializedError | unknown {
  if (!(error instanceof Error)) {
    // Something that is not an Error was thrown or logged as `err`. It still
    // goes through the same rules.
    if (error !== null && typeof error === 'object') {
      // Already serialised (the formatter ran first), or a plain object an
      // HTTP library rejected with. Walked like any other value -- but its
      // request containers are projected first, exactly as an Error's are.
      const source = error as Record<string, unknown>;
      const projected: Record<string, unknown> = {};
      for (const key of Object.keys(source)) {
        projected[key] = REQUEST_CONTAINER_KEYS.has(normaliseKey(key)) ? projectRequestLike(source[key], 0) : source[key];
      }
      return redactValue(projected, depth, seen);
    }
    return { type: typeof error, message: scrubText(String(error)) };
  }
  if (seen.has(error)) return { type: error.name, message: '[circular]' };
  seen.add(error);

  const out: SerializedError = {
    type: error.constructor?.name && error.constructor.name !== 'Error' ? error.constructor.name : error.name,
    message: scrubText(error.message ?? ''),
  };
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' || typeof code === 'number') out.code = typeof code === 'string' ? scrubText(code, 100) : code;
  if (typeof error.stack === 'string') out.stack = scrubText(error.stack, MAX_STACK);

  for (const key of Object.keys(error)) {
    if (ERROR_HANDLED.has(key)) continue;
    let child: unknown;
    try {
      child = (error as unknown as Record<string, unknown>)[key];
    } catch {
      continue;
    }
    if (REQUEST_CONTAINER_KEYS.has(normaliseKey(key))) {
      out[key] = projectRequestLike(child, 0);
      continue;
    }
    // `data` on an HTTP client error is the response body, and on a Prisma
    // error it can be the row. Neither is diagnostic enough to keep.
    if (normaliseKey(key) === 'data') {
      out[key] = OMITTED;
      continue;
    }
    out[key] = redactEntry(key, child, depth, seen);
  }

  const cause = (error as { cause?: unknown }).cause;
  if (cause !== undefined && depth < MAX_CAUSES) {
    out.cause = serializeError(cause, depth + 1, seen);
  }
  const errors = (error as { errors?: unknown }).errors;
  if (Array.isArray(errors) && depth < MAX_CAUSES) {
    out.errors = errors.slice(0, 10).map((inner) => serializeError(inner, depth + 1, seen));
  }
  return out;
}

/**
 * Paths for pino's own `redact` option. Belt to `redactValue`'s braces: pino
 * applies these at serialisation time with fast-redact, so they hold even for
 * a log call that somehow bypassed the formatter (a child logger built with
 * its own options, say). Written out rather than generated because
 * fast-redact takes literal paths with single-level wildcards only.
 */
export const LOG_REDACT_PATHS: string[] = (() => {
  const keys = [
    'password',
    'bindPassword',
    'newPassword',
    'currentPassword',
    'secret',
    'clientSecret',
    'client_secret',
    'token',
    'accessToken',
    'access_token',
    'refreshToken',
    'refresh_token',
    'idToken',
    'id_token',
    'bearerToken',
    'authorization',
    'Authorization',
    'cookie',
    'Cookie',
    'set-cookie',
    'privateKey',
    'SAMLResponse',
    'assertion',
    'plaintext',
    'totpSecret',
    'recoveryCodes',
  ];
  const paths: string[] = [];
  for (const key of keys) {
    const safe = /^[A-Za-z_$][\w$]*$/.test(key) ? key : `["${key}"]`;
    const dot = safe.startsWith('[') ? '' : '.';
    paths.push(safe, `*${dot}${safe}`);
  }
  for (const header of ['authorization', 'cookie', 'set-cookie', 'x-api-key', 'proxy-authorization']) {
    paths.push(`headers["${header}"]`, `*.headers["${header}"]`, `req.headers["${header}"]`, `res.headers["${header}"]`);
  }
  return paths;
})();
