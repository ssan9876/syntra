import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeScimUser {
  id: string;
  userName: string;
  externalId: string | null;
  active: boolean;
  name?: { givenName?: string; familyName?: string };
  emails?: { value: string; primary?: boolean }[];
  title?: string;
}

export interface FakeScimGroup {
  id: string;
  displayName: string;
  members: { value: string }[];
}

export interface FakeScimServerOptions {
  bearerToken: string;
  users?: FakeScimUser[];
  groups?: FakeScimGroup[];
}

export interface FakeScimServer {
  baseUrl: string;
  users: Map<string, FakeScimUser>;
  groups: Map<string, FakeScimGroup>;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      resolve(raw === '' ? undefined : JSON.parse(raw));
    });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/scim+json' });
  res.end(payload);
}

const LIST_RESPONSE_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';

/**
 * A minimal, in-process RFC 7644 server: bearer auth, `Users` and `Groups`
 * collections, list/get/post/put/patch. No filter-query support beyond what
 * the connector itself needs to exercise (pagination, and PATCH add/remove of
 * group members) — this stands in for a real SCIM service in tests the way
 * `FakeTarget` (`testing/fake-target.ts`) stands in for a real directory, not
 * as a spec-complete SCIM implementation.
 */
export async function startFakeScimServer(
  options: FakeScimServerOptions,
): Promise<FakeScimServer> {
  const users = new Map<string, FakeScimUser>((options.users ?? []).map((u) => [u.id, u]));
  const groups = new Map<string, FakeScimGroup>(
    (options.groups ?? []).map((g) => [g.id, g]),
  );
  let nextId = users.size + groups.size + 1;

  const server = createServer((req, res) => {
    void (async () => {
      const auth = req.headers.authorization ?? '';
      if (auth !== `Bearer ${options.bearerToken}`) {
        send(res, 401, { detail: 'invalid bearer token' });
        return;
      }
      const url = new URL(req.url ?? '/', 'http://fake-scim.invalid');
      const segments = url.pathname.split('/').filter(Boolean);

      if (segments[0] === 'Users') {
        await handleCollection(req, res, url, segments, users, () => `u-${nextId++}`);
        return;
      }
      if (segments[0] === 'Groups') {
        await handleCollection(req, res, url, segments, groups, () => `g-${nextId++}`);
        return;
      }
      send(res, 404, { detail: `no such resource: ${url.pathname}` });
    })().catch((cause) => {
      send(res, 500, { detail: cause instanceof Error ? cause.message : String(cause) });
    });
  });

  async function handleCollection<T extends { id: string }>(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    segments: string[],
    store: Map<string, T>,
    genId: () => string,
  ): Promise<void> {
    const id = segments[1];
    if (id === undefined) {
      if (req.method === 'GET') {
        const startIndex = Number(url.searchParams.get('startIndex') ?? '1');
        const count = Number(url.searchParams.get('count') ?? '100');
        const all = [...store.values()];
        const page = all.slice(startIndex - 1, startIndex - 1 + count);
        send(res, 200, {
          schemas: [LIST_RESPONSE_SCHEMA],
          totalResults: all.length,
          startIndex,
          itemsPerPage: page.length,
          Resources: page,
        });
        return;
      }
      if (req.method === 'POST') {
        const body = (await readBody(req)) as Record<string, unknown>;
        const created = { ...body, id: genId() } as unknown as T;
        store.set((created as { id: string }).id, created);
        send(res, 201, created);
        return;
      }
      send(res, 405, { detail: `${req.method} not supported on a collection` });
      return;
    }

    const existing = store.get(id);
    if (existing === undefined) {
      send(res, 404, { detail: `no such resource: ${id}` });
      return;
    }
    if (req.method === 'GET') {
      send(res, 200, existing);
      return;
    }
    if (req.method === 'PUT') {
      const body = (await readBody(req)) as Record<string, unknown>;
      const updated = { ...body, id } as unknown as T;
      store.set(id, updated);
      send(res, 200, updated);
      return;
    }
    if (req.method === 'PATCH') {
      const body = (await readBody(req)) as {
        Operations: { op: string; path?: string; value?: unknown }[];
      };
      let record = existing as unknown as Record<string, unknown>;
      for (const operation of body.Operations) {
        record = applyPatchOperation(record, operation);
      }
      store.set(id, record as unknown as T);
      send(res, 200, record);
      return;
    }
    send(res, 405, { detail: `${req.method} not supported on a resource` });
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    users,
    groups,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }),
  };
}

/**
 * RFC 7644 §3.5.2, the subset this fake exercises: `replace` on a top-level or
 * dotted path, and `add`/`remove` on `members` (the operation the group
 * grant/revoke connector methods issue).
 */
function applyPatchOperation(
  record: Record<string, unknown>,
  operation: { op: string; path?: string; value?: unknown },
): Record<string, unknown> {
  const path = operation.path ?? '';
  if (operation.op === 'replace') {
    if (path === '') return { ...record, ...(operation.value as Record<string, unknown>) };
    return setPath(record, path, operation.value);
  }
  if (operation.op === 'add' && path === 'members') {
    const current = Array.isArray(record.members) ? (record.members as unknown[]) : [];
    return { ...record, members: [...current, ...(operation.value as unknown[])] };
  }
  if (operation.op === 'remove' && path.startsWith('members[value eq ')) {
    const targetId = path.slice('members[value eq "'.length, -2);
    const current = Array.isArray(record.members) ? (record.members as { value: string }[]) : [];
    return { ...record, members: current.filter((m) => m.value !== targetId) };
  }
  throw new Error(`fake SCIM server: unsupported patch operation ${operation.op} ${path}`);
}

function setPath(record: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const [head, ...rest] = path.split('.');
  if (rest.length === 0) return { ...record, [head!]: value };
  const nested = (record[head!] as Record<string, unknown> | undefined) ?? {};
  return { ...record, [head!]: setPath(nested, rest.join('.'), value) };
}
