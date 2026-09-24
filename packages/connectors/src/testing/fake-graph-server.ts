import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';

/**
 * An in-process fake of the slice of Microsoft Graph v1.0 the Entra
 * connector talks to, plus the token endpoint.
 *
 * This stands in for Graph in tests the way `fake-scim-server.ts` stands in
 * for a SCIM service: it exercises the connector's protocol handling --
 * paging, `$batch`, `$ref` membership edges, error shapes, `Retry-After` --
 * and proves nothing about Graph's own semantics. The roadmap's evidence
 * requirement exists because of that gap, and `entra/validate.ts` is what
 * fills it.
 *
 * Failure injection is ordered: `throttleNext` and `failNext` queue answers
 * that are consumed by the next matching Graph request (never the token
 * endpoint); `revokeAuth` and `consentDenied` are modes that stay on until
 * cleared; `delayVisibility` makes what a write created invisible to the
 * next N reads, which is what Graph's eventual consistency looks like from
 * the outside.
 */

export interface FakeGraphUser {
  id: string;
  userPrincipalName: string;
  displayName: string;
  accountEnabled: boolean;
  mailNickname?: string;
  givenName?: string;
  surname?: string;
  mail?: string;
  jobTitle?: string;
  department?: string;
  officeLocation?: string;
  companyName?: string;
  employeeType?: string;
  usageLocation?: string;
  employeeId?: string | null;
  onPremisesExtensionAttributes?: Record<string, string | null>;
  /** Anything else Graph would carry; never selected unless asked for. */
  [extra: string]: unknown;
}

export interface FakeGraphGroup {
  id: string;
  displayName: string;
  description?: string | null;
  securityEnabled: boolean;
  mailEnabled: boolean;
  groupTypes: string[];
  membershipRule?: string | null;
  /** User ids. */
  members: string[];
}

export interface FakeGraphRequest {
  method: string;
  /** Path and query, as received (a `$batch` sub-request is logged too, flagged). */
  url: string;
  headers: Record<string, string>;
  body: unknown;
  inBatch?: boolean;
}

export interface FakeGraphServerOptions {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  users?: FakeGraphUser[];
  groups?: FakeGraphGroup[];
  /** The server's page cap, applied even when `$top` asks for more. */
  pageSize?: number;
  /**
   * App registrations readable at `/applications(appId='...')`. Absent means
   * the registration was never granted Application.Read.All, so the read is
   * refused with 403 -- the ordinary case, and the one credential expiry
   * discovery must survive.
   */
  applications?: FakeGraphApplication[];
}

export interface FakeGraphApplication {
  appId: string;
  passwordCredentials: { hint: string; displayName?: string; endDateTime: string; startDateTime?: string }[];
  keyCredentials?: { displayName?: string; endDateTime: string; startDateTime?: string }[];
}

export interface FakeGraphServer {
  /** `http://127.0.0.1:port/v1.0` -- what `graphBaseUrl` should be set to. */
  baseUrl: string;
  tokenUrl: string;
  users: Map<string, FakeGraphUser>;
  groups: Map<string, FakeGraphGroup>;
  requests: FakeGraphRequest[];
  /** Every token the server has issued, in order. */
  tokensIssued: string[];
  throttleNext(n: number, retryAfterSeconds: number, match?: RegExp): void;
  failNext(n: number, status: number, match?: RegExp): void;
  revokeAuth(on?: boolean): void;
  consentDenied(on?: boolean): void;
  delayVisibility(n: number): void;
  rotateSecret(newSecret: string): void;
  close(): Promise<void>;
}

interface Routed {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

interface Injection {
  kind: 'throttle' | 'fail';
  remaining: number;
  status: number;
  retryAfter?: number;
  match?: RegExp;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const graphError = (code: string, message: string) => ({
  error: { code, message, innerError: { date: new Date().toISOString(), 'request-id': randomUUID() } },
});

function selectProps(item: Record<string, unknown>, select: string | null): Record<string, unknown> {
  if (select === null || select.trim() === '') return { ...item };
  const out: Record<string, unknown> = { id: item.id };
  for (const raw of select.split(',')) {
    const key = raw.trim();
    if (key === '') continue;
    if (key in item) out[key] = item[key];
  }
  return out;
}

/** The handful of `$filter` shapes the connector emits. */
function matchesFilter(item: Record<string, unknown>, filter: string): boolean | 'unsupported' {
  const eq = /^([A-Za-z]+(?:\/[A-Za-z0-9]+)?)\s+eq\s+'((?:[^']|'')*)'$/.exec(filter.trim());
  if (eq) {
    const [, path, literal] = eq;
    const value = literal!.replace(/''/g, "'");
    const segments = path!.split('/');
    let cursor: unknown = item;
    for (const segment of segments) {
      if (cursor === null || typeof cursor !== 'object') return false;
      cursor = (cursor as Record<string, unknown>)[segment];
    }
    return typeof cursor === 'string' && cursor.toLowerCase() === value.toLowerCase();
  }
  const starts = /^startswith\(([A-Za-z]+),\s*'((?:[^']|'')*)'\)$/.exec(filter.trim());
  if (starts) {
    const [, property, literal] = starts;
    const value = literal!.replace(/''/g, "'");
    const current = item[property!];
    return typeof current === 'string' && current.toLowerCase().startsWith(value.toLowerCase());
  }
  return 'unsupported';
}

export async function startFakeGraphServer(
  options: FakeGraphServerOptions,
): Promise<FakeGraphServer> {
  const users = new Map<string, FakeGraphUser>((options.users ?? []).map((u) => [u.id, u]));
  const groups = new Map<string, FakeGraphGroup>((options.groups ?? []).map((g) => [g.id, g]));
  const pageSize = options.pageSize ?? 100;
  const requests: FakeGraphRequest[] = [];
  const tokensIssued: string[] = [];
  const validTokens = new Set<string>();
  const injections: Injection[] = [];
  let clientSecret = options.clientSecret;
  let authRevoked = false;
  let consentIsDenied = false;
  let visibilityDelay = 0;
  /** Things written that the next `reads` read requests must not show. */
  const invisible: { kind: 'user' | 'member'; userId: string; groupId?: string; reads: number }[] = [];

  function hiddenNow(): { users: Set<string>; members: Set<string> } {
    const hidden = { users: new Set<string>(), members: new Set<string>() };
    for (const entry of invisible) {
      if (entry.reads <= 0) continue;
      if (entry.kind === 'user') hidden.users.add(entry.userId);
      else hidden.members.add(`${entry.groupId}|${entry.userId}`);
    }
    return hidden;
  }

  function consumeRead(): { users: Set<string>; members: Set<string> } {
    const hidden = hiddenNow();
    for (const entry of invisible) entry.reads -= 1;
    return hidden;
  }

  function page(
    all: Record<string, unknown>[],
    url: URL,
    collectionPath: string,
  ): Routed {
    const select = url.searchParams.get('$select');
    const skip = Number(url.searchParams.get('$skiptoken') ?? '0');
    const top = Number(url.searchParams.get('$top') ?? String(pageSize));
    const size = Math.max(1, Math.min(Number.isFinite(top) ? top : pageSize, pageSize));
    const slice = all.slice(skip, skip + size).map((item) => selectProps(item, select));
    const body: Record<string, unknown> = { value: slice };
    if (skip + size < all.length) {
      const next = new URL(`${baseUrl}${collectionPath}`);
      url.searchParams.forEach((value, key) => next.searchParams.set(key, value));
      next.searchParams.set('$skiptoken', String(skip + size));
      body['@odata.nextLink'] = next.toString();
    }
    if (url.searchParams.get('$count') === 'true') body['@odata.count'] = all.length;
    return { status: 200, body };
  }

  function listUsers(url: URL, headers: Record<string, string>): Routed {
    const hidden = consumeRead();
    let all = [...users.values()].filter((u) => !hidden.users.has(u.id)) as Record<string, unknown>[];
    const filter = url.searchParams.get('$filter');
    if (filter !== null) {
      if (filter.includes('onPremisesExtensionAttributes/') && headers.consistencylevel !== 'eventual') {
        return {
          status: 400,
          body: graphError('Request_UnsupportedQuery', 'Unsupported or invalid query filter clause specified for property'),
        };
      }
      const kept: Record<string, unknown>[] = [];
      for (const item of all) {
        const verdict = matchesFilter(item, filter);
        if (verdict === 'unsupported') {
          return { status: 400, body: graphError('Request_UnsupportedQuery', 'Unsupported query') };
        }
        if (verdict) kept.push(item);
      }
      all = kept;
    }
    return page(all, url, '/users');
  }

  function listGroups(url: URL, headers: Record<string, string>): Routed {
    consumeRead();
    let all = [...groups.values()].map(({ members: _m, ...rest }) => rest) as Record<string, unknown>[];
    const search = url.searchParams.get('$search');
    if (search !== null) {
      if (headers.consistencylevel !== 'eventual') {
        return { status: 400, body: graphError('Request_UnsupportedQuery', 'Request with $search query parameter only works through MSGraph with a special request header: ConsistencyLevel: eventual') };
      }
      const m = /^"displayName:(.*)"$/.exec(search);
      if (!m) return { status: 400, body: graphError('Request_UnsupportedQuery', 'Unsupported $search') };
      const needle = m[1]!.toLowerCase();
      all = all.filter((g) => String(g.displayName).toLowerCase().includes(needle));
    }
    const filter = url.searchParams.get('$filter');
    if (filter !== null) {
      const kept: Record<string, unknown>[] = [];
      for (const item of all) {
        const verdict = matchesFilter(item, filter);
        if (verdict === 'unsupported') {
          return { status: 400, body: graphError('Request_UnsupportedQuery', 'Unsupported query') };
        }
        if (verdict) kept.push(item);
      }
      all = kept;
    }
    return page(all, url, '/groups');
  }

  function route(
    method: string,
    rawUrl: string,
    headers: Record<string, string>,
    body: unknown,
  ): Routed {
    const url = new URL(rawUrl, baseUrl);
    const path = url.pathname.replace(/^\/v1\.0/, '');
    const segments = path.split('/').filter(Boolean);

    if (authRevoked) {
      return { status: 401, body: graphError('InvalidAuthenticationToken', 'Access token has expired or is not yet valid.') };
    }
    if (consentIsDenied) {
      return { status: 403, body: graphError('Authorization_RequestDenied', 'Insufficient privileges to complete the operation.') };
    }
    for (const injection of injections) {
      if (injection.remaining <= 0) continue;
      if (injection.match && !injection.match.test(`${method} ${path}${url.search}`)) continue;
      injection.remaining -= 1;
      if (injection.kind === 'throttle') {
        return {
          status: 429,
          headers: { 'retry-after': String(injection.retryAfter ?? 1) },
          body: graphError('TooManyRequests', 'Too many requests.'),
        };
      }
      return {
        status: injection.status,
        body:
          injection.status === 404
            ? graphError('Request_ResourceNotFound', 'Resource does not exist or one of its queried reference-property objects are not present.')
            : injection.status === 403
              ? graphError('Authorization_RequestDenied', 'Insufficient privileges to complete the operation.')
              : injection.status === 401
                ? graphError('InvalidAuthenticationToken', 'Access token validation failure.')
                : graphError('ServiceUnavailable', 'The service is unavailable.'),
      };
    }

    // ---- applications (credential expiry discovery) --------------------
    const application = /^applications\(appId='([^']*)'\)$/.exec(decodeURIComponent(segments[0] ?? ''));
    if (application && segments.length === 1 && method === 'GET') {
      if (options.applications === undefined) {
        return { status: 403, body: graphError('Authorization_RequestDenied', 'Insufficient privileges to complete the operation.') };
      }
      const found = options.applications.find((a) => a.appId === application[1]);
      if (!found) {
        return { status: 404, body: graphError('Request_ResourceNotFound', `Resource '${application[1]}' does not exist.`) };
      }
      return {
        status: 200,
        body: { id: randomUUID(), passwordCredentials: found.passwordCredentials, keyCredentials: found.keyCredentials ?? [] },
      };
    }

    // ---- users --------------------------------------------------------
    if (segments[0] === 'users') {
      if (segments.length === 1) {
        if (method === 'GET') return listUsers(url, headers);
        if (method === 'POST') {
          const input = (body ?? {}) as Record<string, unknown>;
          for (const required of ['userPrincipalName', 'displayName', 'mailNickname', 'passwordProfile', 'accountEnabled']) {
            if (input[required] === undefined) {
              return { status: 400, body: graphError('Request_BadRequest', `Property ${required} is required.`) };
            }
          }
          const upn = String(input.userPrincipalName);
          for (const existing of users.values()) {
            if (existing.userPrincipalName.toLowerCase() === upn.toLowerCase()) {
              return {
                status: 400,
                body: graphError('Request_BadRequest', 'Another object with the same value for property userPrincipalName already exists.'),
              };
            }
          }
          const { passwordProfile: _pw, ...rest } = input;
          const created: FakeGraphUser = {
            ...(rest as Omit<FakeGraphUser, 'id'>),
            id: randomUUID(),
            userPrincipalName: upn,
            displayName: String(input.displayName),
            accountEnabled: input.accountEnabled === true,
          };
          users.set(created.id, created);
          if (visibilityDelay > 0) invisible.push({ kind: 'user', userId: created.id, reads: visibilityDelay });
          return { status: 201, body: selectProps(created as Record<string, unknown>, null) };
        }
        return { status: 405, body: graphError('Request_BadRequest', 'Method not allowed') };
      }
      const id = decodeURIComponent(segments[1]!);
      const user = users.get(id);
      if (segments.length === 2) {
        if (method === 'DELETE') {
          // Logged by the caller; refused here so a test that asserts "no
          // DELETE was issued" has the request in the log AND nothing gone.
          return { status: 403, body: graphError('Authorization_RequestDenied', 'This fake does not delete.') };
        }
        if (method === 'GET') {
          const hidden = consumeRead();
          if (!user || hidden.users.has(user.id)) {
            return { status: 404, body: graphError('Request_ResourceNotFound', `Resource '${id}' does not exist or one of its queried reference-property objects are not present.`) };
          }
          return { status: 200, body: selectProps(user as Record<string, unknown>, url.searchParams.get('$select')) };
        }
        if (method === 'PATCH') {
          if (!user) {
            return { status: 404, body: graphError('Request_ResourceNotFound', `Resource '${id}' does not exist.`) };
          }
          const patch = (body ?? {}) as Record<string, unknown>;
          if (typeof patch.userPrincipalName === 'string') {
            for (const other of users.values()) {
              if (other.id !== user.id && other.userPrincipalName.toLowerCase() === patch.userPrincipalName.toLowerCase()) {
                return { status: 400, body: graphError('Request_BadRequest', 'Another object with the same value for property userPrincipalName already exists.') };
              }
            }
          }
          const { onPremisesExtensionAttributes, ...flat } = patch;
          Object.assign(user, flat);
          if (onPremisesExtensionAttributes && typeof onPremisesExtensionAttributes === 'object') {
            user.onPremisesExtensionAttributes = {
              ...(user.onPremisesExtensionAttributes ?? {}),
              ...(onPremisesExtensionAttributes as Record<string, string | null>),
            };
          }
          return { status: 204 };
        }
        return { status: 405, body: graphError('Request_BadRequest', 'Method not allowed') };
      }
      if (segments[2] === 'memberOf' && method === 'GET') {
        const hidden = consumeRead();
        if (!user || hidden.users.has(user.id)) {
          return { status: 404, body: graphError('Request_ResourceNotFound', `Resource '${id}' does not exist.`) };
        }
        const onlyGroups = segments[3] === 'microsoft.graph.group';
        const all = [...groups.values()]
          .filter((g) => g.members.includes(user.id) && !hidden.members.has(`${g.id}|${user.id}`))
          .map(({ members: _m, ...rest }) => ({ '@odata.type': '#microsoft.graph.group', ...rest }));
        return page(all, url, `/users/${encodeURIComponent(id)}/memberOf${onlyGroups ? '/microsoft.graph.group' : ''}`);
      }
      return { status: 404, body: graphError('Request_ResourceNotFound', `No route for ${path}`) };
    }

    // ---- groups -------------------------------------------------------
    if (segments[0] === 'groups') {
      if (segments.length === 1) {
        if (method === 'GET') return listGroups(url, headers);
        return { status: 405, body: graphError('Request_BadRequest', 'Method not allowed') };
      }
      const id = decodeURIComponent(segments[1]!);
      const group = groups.get(id);
      if (segments.length === 2) {
        if (method === 'GET') {
          consumeRead();
          if (!group) {
            return { status: 404, body: graphError('Request_ResourceNotFound', `Resource '${id}' does not exist.`) };
          }
          const { members: _m, ...rest } = group;
          return { status: 200, body: selectProps(rest as Record<string, unknown>, url.searchParams.get('$select')) };
        }
        return { status: 405, body: graphError('Request_BadRequest', 'Method not allowed') };
      }
      if (segments[2] === 'members') {
        if (!group) {
          return { status: 404, body: graphError('Request_ResourceNotFound', `Resource '${id}' does not exist.`) };
        }
        if (segments.length === 3 && method === 'GET') {
          const hidden = consumeRead();
          const all = group.members
            .filter((uid) => !hidden.members.has(`${group.id}|${uid}`))
            .map((uid) => {
              const member = users.get(uid);
              return { '@odata.type': '#microsoft.graph.user', id: uid, ...(member ? { userPrincipalName: member.userPrincipalName } : {}) };
            });
          return page(all, url, `/groups/${encodeURIComponent(id)}/members`);
        }
        if (segments.length === 4 && segments[3] === '$ref' && method === 'POST') {
          const ref = String((body as { '@odata.id'?: unknown } | null)?.['@odata.id'] ?? '');
          const uid = decodeURIComponent(ref.split('/directoryObjects/')[1] ?? '');
          if (!users.has(uid)) {
            return { status: 404, body: graphError('Request_ResourceNotFound', `Resource '${uid}' does not exist.`) };
          }
          if (group.groupTypes.includes('DynamicMembership')) {
            return { status: 400, body: graphError('Request_BadRequest', 'Cannot Update a mail-enabled security groups and or distribution list.') };
          }
          if (group.members.includes(uid)) {
            return {
              status: 400,
              body: graphError('Request_BadRequest', "One or more added object references already exist for the following modified properties: 'members'."),
            };
          }
          group.members.push(uid);
          if (visibilityDelay > 0) invisible.push({ kind: 'member', userId: uid, groupId: group.id, reads: visibilityDelay });
          return { status: 204 };
        }
        if (segments.length === 5 && segments[4] === '$ref' && method === 'DELETE') {
          const uid = decodeURIComponent(segments[3]!);
          if (!group.members.includes(uid)) {
            return { status: 404, body: graphError('Request_ResourceNotFound', 'Resource does not exist or one of its queried reference-property objects are not present.') };
          }
          group.members = group.members.filter((m) => m !== uid);
          return { status: 204 };
        }
      }
      return { status: 404, body: graphError('Request_ResourceNotFound', `No route for ${path}`) };
    }

    return { status: 404, body: graphError('Request_ResourceNotFound', `No route for ${path}`) };
  }

  function send(res: ServerResponse, routed: Routed): void {
    const headers: Record<string, string> = { ...(routed.headers ?? {}) };
    if (routed.body !== undefined) headers['content-type'] = 'application/json';
    res.writeHead(routed.status, headers);
    res.end(routed.body === undefined ? undefined : JSON.stringify(routed.body));
  }

  const server = createServer((req, res) => {
    void (async () => {
      const raw = await readBody(req);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers[k.toLowerCase()] = v;
      }
      const method = req.method ?? 'GET';
      const url = req.url ?? '/';
      let body: unknown = undefined;
      if (raw !== '') {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }
      requests.push({ method, url, headers, body });

      // ---- token endpoint ------------------------------------------
      if (url === `/${options.tenantId}/oauth2/v2.0/token`) {
        const form = new URLSearchParams(raw);
        if (form.get('grant_type') !== 'client_credentials' || form.get('client_id') !== options.clientId) {
          send(res, { status: 400, body: { error: 'invalid_request', error_description: 'AADSTS700016: Application was not found in the directory.' } });
          return;
        }
        if (form.get('client_secret') !== clientSecret) {
          send(res, {
            status: 401,
            body: {
              error: 'invalid_client',
              error_description: `AADSTS7000215: Invalid client secret provided. Ensure the secret being sent in the request is the client secret value, not the client secret ID, for a secret added to app '${options.clientId}'.`,
            },
          });
          return;
        }
        const token = `fake-graph-token-${tokensIssued.length + 1}`;
        tokensIssued.push(token);
        validTokens.add(token);
        send(res, { status: 200, body: { token_type: 'Bearer', expires_in: 3599, access_token: token } });
        return;
      }

      // ---- Graph ---------------------------------------------------
      const bearer = (headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      if (!validTokens.has(bearer)) {
        send(res, { status: 401, body: graphError('InvalidAuthenticationToken', 'Access token is empty.') });
        return;
      }
      if (url.startsWith('/v1.0/$batch') && method === 'POST') {
        const items = ((body as { requests?: unknown } | null)?.requests ?? []) as {
          id: string;
          method: string;
          url: string;
          headers?: Record<string, string>;
          body?: unknown;
        }[];
        if (items.length > 20) {
          send(res, { status: 400, body: graphError('BadRequest', 'Batch size exceeds the limit of 20.') });
          return;
        }
        const responses = items.map((item) => {
          const sub = `/v1.0${item.url.startsWith('/') ? item.url : `/${item.url}`}`;
          requests.push({ method: item.method, url: sub, headers: item.headers ?? {}, body: item.body, inBatch: true });
          const routed = route(item.method, sub, { ...headers, ...(item.headers ?? {}) }, item.body);
          return {
            id: item.id,
            status: routed.status,
            headers: { ...(routed.headers ?? {}), ...(routed.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
            ...(routed.body === undefined ? {} : { body: routed.body }),
          };
        });
        // Graph does not promise order. Reversed so a client that relies on
        // it fails here rather than in production.
        send(res, { status: 200, body: { responses: responses.reverse() } });
        return;
      }
      send(res, route(method, url, headers, body));
    })().catch((cause) => {
      send(res, { status: 500, body: graphError('InternalServerError', cause instanceof Error ? cause.message : String(cause)) });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;
  const baseUrl = `${origin}/v1.0`;

  return {
    baseUrl,
    tokenUrl: `${origin}/${options.tenantId}/oauth2/v2.0/token`,
    users,
    groups,
    requests,
    tokensIssued,
    throttleNext: (n, retryAfterSeconds, match) =>
      injections.push({ kind: 'throttle', remaining: n, status: 429, retryAfter: retryAfterSeconds, ...(match ? { match } : {}) }),
    failNext: (n, status, match) =>
      injections.push({ kind: 'fail', remaining: n, status, ...(match ? { match } : {}) }),
    revokeAuth: (on = true) => {
      authRevoked = on;
    },
    consentDenied: (on = true) => {
      consentIsDenied = on;
    },
    delayVisibility: (n) => {
      visibilityDelay = n;
    },
    rotateSecret: (newSecret) => {
      clientSecret = newSecret;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
