import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUILTIN_CONNECTOR_DOCUMENTS,
  entraIdDocument,
  googleWorkspaceDocument,
  snipeItDocument,
} from './documents/index.js';
import { httpConnectorDocument, type HttpConnectorDocument } from './document.js';
import { httpTargetConnector } from './connector.js';
import { forgetAccessTokens, readPath, readRetry } from './client.js';
import { certifyTargetConnector } from '../testing/target-connector-certification.js';

/**
 * Every request the connector made, and the canned answers it got.
 *
 * `guardedFetch` is spied at the module boundary rather than `fetch` being
 * mocked, because `guardedFetch` is what the connector calls — and mocking a
 * layer below the one under test would mean the address guard was never
 * exercised in production code paths the tests claim to cover.
 */
let calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[];
let answers: { status: number; body: unknown; headers?: Record<string, string> }[];
let responder:
  | ((call: (typeof calls)[number]) => { status: number; body: unknown; headers?: Record<string, string> })
  | undefined;

vi.mock('../net/guarded-fetch.js', () => ({
  guardedFetch: () => async (url: string | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const call = {
      url: String(url),
      method: init?.method ?? 'GET',
      headers,
      body: init?.body ? safeParse(String(init.body)) : undefined,
    };
    calls.push(call);
    const answer = responder?.(call) ?? answers.shift() ?? { status: 200, body: null };
    return new Response(answer.body === null ? '' : JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': 'application/json', ...(answer.headers ?? {}) },
    });
  },
}));

const safeParse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/** A minimal document: one page of users, no entitlements. */
const simple = (over: Partial<HttpConnectorDocument> = {}): HttpConnectorDocument => ({
  name: 'Example',
  version: 1,
  baseUrl: 'https://api.example.com/v1',
  auth: { type: 'bearer' },
  account: {
    list: { path: '/users', itemsAt: 'items' },
    anchorAt: 'id',
    correlationAt: 'login',
    provenance: { kind: 'scalar', path: 'actionId' },
    fields: { displayName: 'displayName', 'name.given': 'givenName' },
    create: {
      method: 'POST',
      path: '/users',
      body: { login: '{{correlationKey}}', displayName: '{{attr.displayName}}', actionId: '{{actionId}}' },
      anchorAt: 'id',
    },
    update: { method: 'PATCH', path: '/users/{{anchor}}', body: { displayName: '{{attr.displayName}}' } },
    disable: { method: 'PATCH', path: '/users/{{anchor}}', body: { active: false } },
  },
  ...over,
});

const config = (document: HttpConnectorDocument = simple()) => ({
  document,
  bindPassword: 'a-secret',
});

describe('container placement', () => {
  it('places accounts in containers only when the document describes containers', () => {
    expect(httpTargetConnector.placesAccountsInContainers(config())).toBe(false);
    expect(
      httpTargetConnector.placesAccountsInContainers(
        config(simple({ container: { list: { path: '/ous', itemsAt: 'items' }, dnAt: 'path' } })),
      ),
    ).toBe(true);
  });
});

const collect = async <T>(source: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = [];
  for await (const item of source) out.push(item);
  return out;
};

/** How long each read retry asked to wait. Nothing actually waits. */
let waits: number[];

beforeEach(() => {
  calls = [];
  answers = [];
  responder = undefined;
  waits = [];
  forgetAccessTokens();
  vi.spyOn(readRetry, 'sleep').mockImplementation(async (ms) => {
    waits.push(ms);
  });
});

describe('shared connector certification', () => {
  it('certifies a provenance-declaring HTTP document', async () => {
    const users = new Map<string, Record<string, unknown>>();
    const members = new Set<string>();
    let nextId = 1;
    responder = (call) => {
      const url = new URL(call.url);
      const path = url.pathname.replace('/v1', '');
      if (call.method === 'GET' && path === '/users') {
        return { status: 200, body: { items: [...users.values()] } };
      }
      if (call.method === 'POST' && path === '/users') {
        const id = `u-${nextId++}`;
        users.set(id, { id, active: true, ...(call.body as Record<string, unknown>) });
        return { status: 201, body: { id } };
      }
      const user = /^\/users\/([^/]+)$/.exec(path);
      if (user && call.method === 'PATCH') {
        const existing = users.get(user[1]!);
        if (!existing) return { status: 404, body: null };
        Object.assign(existing, call.body as Record<string, unknown>);
        return { status: 200, body: existing };
      }
      if (call.method === 'GET' && path === '/groups') {
        return { status: 200, body: { items: [{ id: 'g-1', name: 'Certified users' }] } };
      }
      if (call.method === 'GET' && path === '/groups/g-1/members') {
        return { status: 200, body: { items: [...members].map((id) => ({ id })) } };
      }
      if (call.method === 'POST' && path === '/groups/g-1/members') {
        members.add(String((call.body as { id: unknown }).id));
        return { status: 200, body: null };
      }
      const membership = /^\/groups\/g-1\/members\/([^/]+)$/.exec(path);
      if (membership && call.method === 'DELETE') {
        members.delete(membership[1]!);
        return { status: 200, body: null };
      }
      return { status: 404, body: null };
    };

    const document = simple({
      account: {
        ...simple().account,
        fields: { displayName: 'displayName', active: 'active' },
        update: {
          method: 'PATCH',
          path: '/users/{{anchor}}',
          body: { displayName: '{{attr.displayName}}' },
        },
        disable: {
          method: 'PATCH',
          path: '/users/{{anchor}}',
          body: { active: false },
        },
      },
      entitlement: {
        list: { path: '/groups', itemsAt: 'items' },
        anchorAt: 'id',
        displayNameAt: 'name',
        members: {
          path: '/groups/{{entitlementId}}/members',
          itemsAt: 'items',
          memberAnchorAt: 'id',
        },
        grant: {
          method: 'POST',
          path: '/groups/{{entitlementId}}/members',
          body: { id: '{{anchor}}' },
        },
        revoke: {
          method: 'DELETE',
          path: '/groups/{{entitlementId}}/members/{{anchor}}',
        },
      },
    });

    const report = await certifyTargetConnector({
      name: 'document-driven HTTP',
      connector: httpTargetConnector,
      config: config(document),
      create: {
        op: 'create_account',
        actionId: 'cert-http-create',
        correlationKey: 'connector.certification',
        attributes: { displayName: ['Connector Certification'] },
        enabled: true,
        initialPassword: 'not-retained',
      },
      update: (anchor) => ({
        op: 'update_account',
        actionId: 'cert-http-update',
        anchor,
        attributes: { displayName: ['Certified Connector'] },
      }),
      disable: (anchor) => ({
        op: 'disable_account',
        actionId: 'cert-http-disable',
        anchor,
        reason: 'connector certification',
      }),
      entitlement: {
        id: 'g-1',
        grant: (anchor) => ({ op: 'grant_entitlement', actionId: 'cert-http-grant', anchor, entitlementId: 'g-1' }),
        revoke: (anchor) => ({ op: 'revoke_entitlement', actionId: 'cert-http-revoke', anchor, entitlementId: 'g-1' }),
      },
      missingAnchor: 'missing-http-user',
      assertUpdated: (observed) => {
        expect(observed.account?.attributes.displayName).toEqual(['Certified Connector']);
      },
    });

    expect(report.checks).toContain('idempotent-create');
    expect(report.checks).toContain('grant-read-back');
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('the documents that ship with the product', () => {
  it.each(Object.entries(BUILTIN_CONNECTOR_DOCUMENTS))(
    '%s validates against the schema',
    (_name, document) => {
      expect(() => httpConnectorDocument.parse(document)).not.toThrow();
    },
  );

  it('never names DELETE on an account operation', () => {
    // The structural rule, asserted against the documents as well as the
    // schema. A shipped document is what an administrator copies and edits,
    // so it is also what teaches them what is allowed.
    for (const document of Object.values(BUILTIN_CONNECTOR_DOCUMENTS)) {
      const account = document.account as unknown as Record<string, { method?: string } | undefined>;
      for (const key of ['create', 'update', 'enable', 'disable', 'archive', 'rename']) {
        expect(account[key]?.method).not.toBe('DELETE');
      }
    }
  });

  it('describes no archive for either target', () => {
    // Both APIs' only removal is a hard delete, which this connector cannot
    // express. Saying so by omission is honest; an `archive` that quietly did
    // a disable under another name would not be.
    expect(entraIdDocument.account.archive).toBeUndefined();
    expect(googleWorkspaceDocument.account.archive).toBeUndefined();
    expect(snipeItDocument.account.archive).toBeUndefined();
  });
});

describe('the document schema', () => {
  it('refuses DELETE on an account operation', () => {
    const result = httpConnectorDocument.safeParse(
      simple({
        account: {
          ...simple().account,
          archive: { method: 'DELETE', path: '/users/{{anchor}}' },
        },
      } as never),
    );
    expect(result.success).toBe(false);
  });

  it('allows DELETE on a membership operation', () => {
    const result = httpConnectorDocument.safeParse(
      simple({
        entitlement: {
          list: { path: '/groups', itemsAt: 'items' },
          anchorAt: 'id',
          displayNameAt: 'name',
          revoke: { method: 'DELETE', path: '/groups/{{entitlementId}}/members/{{anchor}}' },
        },
      }),
    );
    expect(result.success).toBe(true);
  });

  it('refuses a path that climbs out of the base url', () => {
    const result = httpConnectorDocument.safeParse(
      simple({
        account: { ...simple().account, list: { path: '/../admin/users' } },
      } as never),
    );
    expect(result.success).toBe(false);
  });

  it('refuses a field it does not know', () => {
    const result = httpConnectorDocument.safeParse({ ...simple(), script: 'rm -rf /' });
    expect(result.success).toBe(false);
  });

  it('refuses http for an oauth token endpoint', () => {
    const result = httpConnectorDocument.safeParse(
      simple({
        auth: { type: 'oauth2', tokenUrl: 'http://token.example.com/t', clientId: 'x' },
      }),
    );
    expect(result.success).toBe(false);
  });
});

describe('readPath', () => {
  it('reads a key whose own name contains a dot', () => {
    // Microsoft Graph's page pointer. Splitting on every dot would look for
    // `nextLink` inside a non-existent `@odata` object and page exactly once.
    expect(readPath({ '@odata.nextLink': 'https://next' }, '@odata.nextLink')).toBe(
      'https://next',
    );
  });

  it('still reads a genuine nested path', () => {
    expect(readPath({ name: { given: 'Ada' } }, 'name.given')).toBe('Ada');
  });

  it('reads nothing inherited', () => {
    expect(readPath({}, 'constructor')).toBeUndefined();
    expect(readPath({}, 'toString')).toBeUndefined();
  });
});

describe('read', () => {
  it('turns items into records with the mapped attributes', async () => {
    answers = [
      {
        status: 200,
        body: {
          items: [
            { id: 'u1', login: 'ada', displayName: 'Ada Lovelace', name: { given: 'Ada' } },
          ],
        },
      },
    ];

    const records = await collect(httpTargetConnector.read(config()));
    expect(records).toEqual([
      {
        anchor: 'u1',
        objectType: 'user',
        dn: 'ada',
        attributes: { displayName: ['Ada Lovelace'], givenName: ['Ada'] },
      },
    ]);
  });

  it('skips an item with no anchor rather than inventing one', async () => {
    // A record with no identity looks like a new account on every run.
    answers = [{ status: 200, body: { items: [{ login: 'nobody' }, { id: 'u2' }] } }];
    const records = await collect(httpTargetConnector.read(config()));
    expect(records.map((r) => r.anchor)).toEqual(['u2']);
  });

  it('follows a cursor to the end', async () => {
    const document = simple({
      account: {
        ...simple().account,
        list: {
          path: '/users',
          itemsAt: 'items',
          paging: { style: 'cursor', nextAt: 'next', kind: 'url' },
        },
      },
    } as never);
    answers = [
      { status: 200, body: { items: [{ id: 'u1' }], next: 'https://api.example.com/v1/users?p=2' } },
      { status: 200, body: { items: [{ id: 'u2' }] } },
    ];

    const records = await collect(httpTargetConnector.read(config(document)));
    expect(records.map((r) => r.anchor)).toEqual(['u1', 'u2']);
  });

  it('refuses a page pointer at another host', async () => {
    // Otherwise a compromised or misbehaving target redirects the next
    // request — carrying this connector's credential — anywhere it likes.
    const document = simple({
      account: {
        ...simple().account,
        list: {
          path: '/users',
          itemsAt: 'items',
          paging: { style: 'cursor', nextAt: 'next', kind: 'url' },
        },
      },
    } as never);
    answers = [
      { status: 200, body: { items: [{ id: 'u1' }], next: 'https://evil.example.net/users' } },
    ];

    await expect(collect(httpTargetConnector.read(config(document)))).rejects.toThrow(
      /evil\.example\.net/,
    );
  });

  it('throws rather than returning a short list when a page fails', async () => {
    const document = simple({
      account: {
        ...simple().account,
        list: {
          path: '/users',
          itemsAt: 'items',
          paging: { style: 'cursor', nextAt: 'next', kind: 'url' },
        },
      },
    } as never);
    answers = [
      { status: 200, body: { items: [{ id: 'u1' }], next: 'https://api.example.com/v1/users?p=2' } },
      { status: 500, body: null },
      { status: 500, body: null },
      { status: 500, body: null },
      { status: 500, body: null },
    ];

    await expect(collect(httpTargetConnector.read(config(document)))).rejects.toThrow(/500/);
    // The failing page was tried four times, waiting 1, 2 and 4 seconds.
    expect(calls).toHaveLength(5);
    expect(waits).toEqual([1000, 2000, 4000]);
  });
});

describe('readEntitlementMembers', () => {
  it('throws when the document cannot read a membership', async () => {
    // An empty list is indistinguishable from a group with no members, and
    // the run would propose revoking it from everybody who holds it.
    await expect(
      httpTargetConnector.readEntitlementMembers(config(), 'g1'),
    ).rejects.toThrow(/does not describe/);
  });

  it('returns every member across pages', async () => {
    const document = simple({
      entitlement: {
        list: { path: '/groups', itemsAt: 'items' },
        anchorAt: 'id',
        displayNameAt: 'name',
        members: {
          path: '/groups/{{entitlementId}}/members',
          itemsAt: 'items',
          memberAnchorAt: 'id',
          paging: { style: 'cursor', nextAt: 'next', kind: 'url' },
        },
      },
    });
    answers = [
      { status: 200, body: { items: [{ id: 'u1' }], next: 'https://api.example.com/v1/g?p=2' } },
      { status: 200, body: { items: [{ id: 'u2' }] } },
    ];

    expect(await httpTargetConnector.readEntitlementMembers(config(document), 'g1')).toEqual([
      'u1',
      'u2',
    ]);
  });
});

describe('write', () => {
  it('refuses create when the document cannot prove idempotency', async () => {
    const unsafe = simple({
      account: { ...simple().account, provenance: undefined },
    } as never);
    const result = await httpTargetConnector.write(config(unsafe), {
      op: 'create_account',
      actionId: 'unsafe-create',
      correlationKey: 'ada',
      attributes: {},
      enabled: true,
      initialPassword: 'not-retained',
    });
    expect(result).toMatchObject({ ok: false, failure: 'rejected' });
    expect(result.message).toMatch(/provenance read-back/);
    expect(calls).toHaveLength(0);
  });

  it('adopts only an exact action-id match and rejects a foreign collision', async () => {
    answers = [{ status: 200, body: { items: [{ id: 'u-1', login: 'ada', actionId: 'act-1' }] } }];
    const adopted = await httpTargetConnector.write(config(), {
      op: 'create_account',
      actionId: 'act-1',
      correlationKey: 'ADA',
      attributes: {},
      enabled: true,
      initialPassword: 'not-retained',
    });
    expect(adopted).toMatchObject({ ok: true, anchor: 'u-1' });
    expect(calls).toHaveLength(1);

    calls = [];
    answers = [{ status: 200, body: { items: [{ id: 'u-1', login: 'ada', actionId: 'act-10' }] } }];
    const collision = await httpTargetConnector.write(config(), {
      op: 'create_account',
      actionId: 'act-1',
      correlationKey: 'ada',
      attributes: {},
      enabled: true,
      initialPassword: 'not-retained',
    });
    expect(collision).toMatchObject({ ok: false, failure: 'conflict' });
    expect(calls).toHaveLength(1);
  });

  it('creates an account and reports the anchor the target chose', async () => {
    answers = [
      { status: 200, body: { items: [] } },
      { status: 201, body: { id: 'new-1' } },
    ];

    const result = await httpTargetConnector.write(config(), {
      op: 'create_account',
      actionId: 'act-1',
      correlationKey: 'ada',
      attributes: { displayName: ['Ada Lovelace'] },
      enabled: true,
      initialPassword: 'a-generated-one',
    });

    expect(result).toMatchObject({ ok: true, anchor: 'new-1' });
    expect(calls[1]).toMatchObject({
      url: 'https://api.example.com/v1/users',
      method: 'POST',
      body: { login: 'ada', displayName: 'Ada Lovelace', actionId: 'act-1' },
    });
  });

  it('omits a key whose attribute nobody set', async () => {
    answers = [
      { status: 200, body: { items: [] } },
      { status: 201, body: { id: 'new-1' } },
    ];

    await httpTargetConnector.write(config(), {
      op: 'create_account',
      actionId: 'act-1',
      correlationKey: 'ada',
      attributes: {},
      enabled: true,
      initialPassword: 'x',
    });

    // Not `{"login": "ada", "displayName": null}` — null is a WRITE that
    // clears the field at most targets.
    expect(calls[1]!.body).toEqual({ login: 'ada', actionId: 'act-1' });
  });

  it('sends no body at all when every field of one would be missing', async () => {
    answers = [{ status: 200, body: null }];

    await httpTargetConnector.write(config(), {
      op: 'update_account',
      actionId: 'act-1',
      anchor: 'u1',
      attributes: {},
    });

    // `PATCH {}` is a write of nothing, which some targets treat as a write
    // of nothing and others as a reset. Sending no body says what was meant.
    expect(calls[0]!.body).toBeUndefined();
  });

  it('escapes an anchor into the path', async () => {
    answers = [{ status: 200, body: null }];

    await httpTargetConnector.write(config(), {
      op: 'update_account',
      actionId: 'act-1',
      anchor: 'a/../admin',
      attributes: { displayName: ['x'] },
    });

    expect(calls[0]!.url).toBe('https://api.example.com/v1/users/a%2F..%2Fadmin');
  });

  it('classifies a refusal so the run knows whether to retry', async () => {
    answers = [{ status: 409, body: null }];
    const result = await httpTargetConnector.write(config(), {
      op: 'update_account',
      actionId: 'act-1',
      anchor: 'u1',
      attributes: { displayName: ['x'] },
    });
    expect(result).toMatchObject({ ok: false, failure: 'conflict' });
  });

  it("honours the target's own Retry-After", async () => {
    answers = [{ status: 429, body: null, headers: { 'retry-after': '30' } }];
    const result = await httpTargetConnector.write(config(), {
      op: 'update_account',
      actionId: 'act-1',
      anchor: 'u1',
      attributes: { displayName: ['x'] },
    });
    expect(result).toMatchObject({ failure: 'throttled', retryAfterMs: 30_000 });
  });

  it("never puts the target's response body in the message", async () => {
    // A target's error text quotes back what was sent, and what was sent may
    // include an initial password.
    answers = [
      { status: 200, body: { items: [] } },
      { status: 400, body: { error: "password 'hunter2' is too weak" } },
    ];
    const result = await httpTargetConnector.write(config(), {
      op: 'create_account',
      actionId: 'act-1',
      correlationKey: 'ada',
      attributes: {},
      enabled: true,
      initialPassword: 'hunter2',
    });
    expect(result.message).not.toContain('hunter2');
    expect(result.message).toBe('the target answered HTTP 400');
  });

  it('refuses an operation the document does not describe, without retrying', async () => {
    const result = await httpTargetConnector.write(config(), {
      op: 'rename_account',
      actionId: 'act-1',
      anchor: 'u1',
      correlationKey: 'ada2',
    });
    // `rejected`, not `transient`: it will not be described on the third
    // attempt either.
    expect(result).toMatchObject({ ok: false, failure: 'rejected' });
    expect(calls).toHaveLength(0);
  });

  it('refuses delete_account without a request', async () => {
    const result = await httpTargetConnector.write(config(), {
      op: 'delete_account',
      actionId: 'act-1',
      anchor: 'u1',
    });
    expect(result).toMatchObject({ ok: false, failure: 'rejected' });
    expect(calls).toHaveLength(0);
  });

  it('stops an archive when an entitlement will not come off', async () => {
    const document = simple({
      entitlement: {
        list: { path: '/groups', itemsAt: 'items' },
        anchorAt: 'id',
        displayNameAt: 'name',
        revoke: { method: 'DELETE', path: '/groups/{{entitlementId}}/members/{{anchor}}' },
      },
      account: { ...simple().account, archive: { method: 'PATCH', path: '/users/{{anchor}}', body: { archived: true } } },
    } as never);
    answers = [{ status: 500, body: null }];

    const result = await httpTargetConnector.write(config(document), {
      op: 'archive_account',
      actionId: 'act-1',
      anchor: 'u1',
      entitlementDns: ['g1'],
    });

    // Archiving an account that still holds what Provision granted it leaves
    // the access in place behind an object nobody looks at any more.
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(1);
  });
});

describe('auth', () => {
  it('sends a bearer credential', async () => {
    answers = [{ status: 200, body: { items: [] } }];
    await collect(httpTargetConnector.read(config()));
    expect(calls[0]!.headers.authorization).toBe('Bearer a-secret');
  });

  it('exchanges a client secret for a token, once', async () => {
    const document = simple({
      auth: {
        type: 'oauth2',
        tokenUrl: 'https://login.example.com/token',
        clientId: 'client-1',
        scope: 'https://api.example.com/.default',
      },
    });
    answers = [
      { status: 200, body: { access_token: 'issued-token', expires_in: 3600 } },
      { status: 200, body: { items: [] } },
      { status: 200, body: { items: [] } },
    ];

    await collect(httpTargetConnector.read(config(document)));
    await collect(httpTargetConnector.read(config(document)));

    // One token exchange, two reads. A token fetched per request would be
    // three times the traffic and a rate limit nobody expected.
    const exchanges = calls.filter((c) => new URL(c.url).origin === 'https://login.example.com');
    expect(exchanges).toHaveLength(1);
    expect(calls.at(-1)!.headers.authorization).toBe('Bearer issued-token');
  });

  it("never echoes the token endpoint's body into the error", async () => {
    const document = simple({
      auth: { type: 'oauth2', tokenUrl: 'https://login.example.com/token', clientId: 'client-1' },
    });
    answers = [{ status: 400, body: { error_description: 'client_secret a-secret is invalid' } }];

    await expect(collect(httpTargetConnector.read(config(document)))).rejects.toThrow(
      /^the token endpoint answered HTTP 400$/,
    );
  });

  it('shows only Microsoft\'s stable diagnostic code, never its token response', async () => {
    const document = simple({
      auth: { type: 'oauth2', tokenUrl: 'https://login.example.com/token', clientId: 'client-1' },
    });
    answers = [
      {
        status: 401,
        body: {
          error: 'invalid_client',
          error_description: 'AADSTS7000215: client_secret a-secret is invalid',
        },
      },
    ];

    let message = '';
    try {
      await collect(httpTargetConnector.read(config(document)));
    } catch (cause) {
      message = cause instanceof Error ? cause.message : String(cause);
    }
    expect(message).toBe('the token endpoint answered HTTP 401 (AADSTS7000215)');
    expect(message).not.toContain('a-secret');
  });
});

describe('failures declared in a 2xx body', () => {
  const withBodyRule = (over: Record<string, unknown> = {}) =>
    simple({
      failures: {
        body: {
          at: 'result.state',
          equals: 'failed',
          messageAt: 'errors',
          conflictWhen: ['is taken'],
          notFoundWhen: ['no such'],
          ...over,
        },
      },
    } as never);

  const update = {
    op: 'update_account' as const,
    actionId: 'act-1',
    anchor: 'u1',
    attributes: { displayName: ['x'] },
  };

  it('validates the rule', () => {
    expect(httpConnectorDocument.safeParse(withBodyRule()).success).toBe(true);
    for (const broken of [
      { equals: undefined },
      { at: 'not a path' },
      { at: '__proto__' },
      { conflictWhen: [''] },
      { conflictWhen: 'is taken' },
      { script: 'x' },
    ]) {
      expect(httpConnectorDocument.safeParse(withBodyRule(broken)).success).toBe(false);
    }
  });

  it('leaves a 2xx without the marker a success', async () => {
    answers = [{ status: 200, body: { result: { state: 'ok' } } }];
    const result = await httpTargetConnector.write(config(withBodyRule()), update);
    expect(result.ok).toBe(true);
  });

  it('turns a matching 2xx into a classified failure', async () => {
    answers = [
      { status: 200, body: { result: { state: 'failed' }, errors: ['login is taken'] } },
      { status: 200, body: { result: { state: 'failed' }, errors: { id: ['no such user'] } } },
      { status: 200, body: { result: { state: 'failed' }, errors: 'quota exceeded' } },
      { status: 200, body: { result: { state: 'failed' } } },
    ];
    const document = withBodyRule();
    expect(await httpTargetConnector.write(config(document), update)).toMatchObject({
      ok: false,
      failure: 'conflict',
      message: 'the target refused the request: login is taken',
    });
    expect(await httpTargetConnector.write(config(document), update)).toMatchObject({
      ok: false,
      failure: 'not_found',
    });
    expect(await httpTargetConnector.write(config(document), update)).toMatchObject({
      ok: false,
      failure: 'rejected',
      message: 'the target refused the request: quota exceeded',
    });
    expect(await httpTargetConnector.write(config(document), update)).toMatchObject({
      ok: false,
      failure: 'rejected',
      message: 'the target refused the request',
    });
  });

  it('never surfaces the credential or the initial password', async () => {
    answers = [
      { status: 200, body: { items: [] } },
      {
        status: 200,
        body: {
          result: { state: 'failed' },
          errors: ['hunter2 rejected for key a-secret by ada@example.com'],
        },
      },
    ];
    const result = await httpTargetConnector.write(config(withBodyRule()), {
      op: 'create_account',
      actionId: 'act-1',
      correlationKey: 'ada',
      attributes: {},
      enabled: true,
      initialPassword: 'hunter2',
    });
    expect(result.ok).toBe(false);
    expect(result.message).not.toContain('hunter2');
    expect(result.message).not.toContain('a-secret');
    expect(result.message).not.toContain('ada@example.com');
    expect(result.message).toContain('rejected for key');
  });
});

describe('offset paging with a stated total', () => {
  const offsetDocument = (totalAt?: string) =>
    simple({
      account: {
        ...simple().account,
        list: {
          path: '/users',
          itemsAt: 'items',
          paging: { style: 'offset', pageSize: 5, ...(totalAt ? { totalAt } : {}) },
        },
      },
    } as never);

  it('keeps walking past short pages until the total is reached', async () => {
    answers = [
      { status: 200, body: { total: 4, items: [{ id: 'u1' }, { id: 'u2' }] } },
      { status: 200, body: { total: 4, items: [{ id: 'u3' }, { id: 'u4' }] } },
    ];
    const records = await collect(httpTargetConnector.read(config(offsetDocument('total'))));
    expect(records.map((r) => r.anchor)).toEqual(['u1', 'u2', 'u3', 'u4']);
    expect(calls.map((c) => new URL(c.url).searchParams.get('offset'))).toEqual(['0', '2']);
  });

  it('refuses a walk that runs dry before the total', async () => {
    answers = [
      { status: 200, body: { total: 4, items: [{ id: 'u1' }, { id: 'u2' }] } },
      { status: 200, body: { total: 4, items: [] } },
    ];
    await expect(
      collect(httpTargetConnector.read(config(offsetDocument('total')))),
    ).rejects.toThrow(/partial list/);
  });

  it('refuses a response with no count where one was declared', async () => {
    answers = [{ status: 200, body: { items: [{ id: 'u1' }] } }];
    await expect(
      collect(httpTargetConnector.read(config(offsetDocument('total')))),
    ).rejects.toThrow(/no item count/);
  });

  it('without a total, still ends on a short page', async () => {
    answers = [{ status: 200, body: { items: [{ id: 'u1' }] } }];
    const records = await collect(httpTargetConnector.read(config(offsetDocument())));
    expect(records.map((r) => r.anchor)).toEqual(['u1']);
    expect(calls).toHaveLength(1);
  });
});

describe('numbered and Link-header paging', () => {
  const withPaging = (paging: unknown, itemsAt: string | null = 'items') =>
    simple({
      account: { ...simple().account, list: { path: '/users', ...(itemsAt ? { itemsAt } : {}), paging } },
    } as never);

  it('walks numbered pages from 1 until an empty page', async () => {
    responder = (call) => {
      const page = Number(new URL(call.url).searchParams.get('page'));
      return { status: 200, body: { items: page <= 2 ? [{ id: `u${page}` }] : [] } };
    };

    const records = await collect(httpTargetConnector.read(config(withPaging({ style: 'page', pageSize: 50 }))));

    expect(records.map((r) => r.anchor)).toEqual(['u1', 'u2']);
    expect(calls.map((c) => new URL(c.url).search)).toEqual([
      '?page=1&per_page=50',
      '?page=2&per_page=50',
      '?page=3&per_page=50',
    ]);
  });

  it('holds numbered pages to a stated total', async () => {
    responder = (call) => {
      const page = Number(new URL(call.url).searchParams.get('page'));
      return { status: 200, body: { total: 3, items: page === 1 ? [{ id: 'a' }, { id: 'b' }] : [] } };
    };

    await expect(
      collect(httpTargetConnector.read(config(withPaging({ style: 'page', totalAt: 'total' })))),
    ).rejects.toThrow(/stopped answering at 2 of 3 items/);
  });

  it('follows rel="next" in the Link header, resolved against baseUrl', async () => {
    answers = [
      {
        status: 200,
        body: [{ id: 'u1' }],
        headers: { link: '</v1/users?after=u1>; rel="next", </v1/users>; rel="first"' },
      },
      { status: 200, body: [{ id: 'u2' }], headers: { link: '</v1/users>; rel="first"' } },
    ];

    const records = await collect(httpTargetConnector.read(config(withPaging({ style: 'link' }, null))));

    expect(records.map((r) => r.anchor)).toEqual(['u1', 'u2']);
    expect(calls[1]!.url).toBe('https://api.example.com/v1/users?after=u1');
  });

  it('refuses a Link header pointing at another host', async () => {
    answers = [
      { status: 200, body: [{ id: 'u1' }], headers: { link: '<https://evil.example.net/users>; rel=next' } },
    ];

    await expect(
      collect(httpTargetConnector.read(config(withPaging({ style: 'link' }, null)))),
    ).rejects.toThrow(/evil\.example\.net/);
  });
});

describe('reads retried on throttling', () => {
  it('honours Retry-After, then succeeds', async () => {
    answers = [
      { status: 429, body: null, headers: { 'retry-after': '7' } },
      { status: 200, body: { items: [{ id: 'u1' }] } },
    ];

    const records = await collect(httpTargetConnector.read(config()));

    expect(records).toHaveLength(1);
    expect(waits).toEqual([7000]);
  });

  it('does not retry a 4xx that is not throttling', async () => {
    answers = [{ status: 400, body: null }];

    await expect(collect(httpTargetConnector.read(config()))).rejects.toThrow(/HTTP 400/);
    expect(calls).toHaveLength(1);
  });
});

describe('paths into lists', () => {
  it('reads a list entry by position', async () => {
    const document = simple({
      account: { ...simple().account, fields: { 'emails.0.value': 'mail' } },
    });
    answers = [
      {
        status: 200,
        body: { items: [{ id: 'u1', emails: [{ value: 'a@example.com' }, { value: 'b@example.com' }] }] },
      },
    ];

    const [record] = await collect(httpTargetConnector.read(config(document)));

    expect(record!.attributes.mail).toEqual(['a@example.com']);
    expect(readPath({ list: ['x', 'y'] }, 'list.1')).toBe('y');
  });
});

describe('templated requests', () => {
  it('renders query and headers, leaving out what has no value', async () => {
    const document = simple({
      account: {
        ...simple().account,
        update: {
          method: 'PATCH',
          path: '/users/{{anchor}}',
          query: { notify: 'false', dept: '{{attr.department}}' },
          headers: { 'If-Match': '{{attr.etag}}', 'X-Reason': '{{attr.missing}}' },
          body: { displayName: '{{attr.displayName}}' },
        },
      },
    });
    answers = [{ status: 200, body: {} }];

    await httpTargetConnector.write(config(document), {
      op: 'update_account',
      actionId: 'a1',
      anchor: 'u1',
      attributes: { displayName: ['Jane'], etag: ['W/"3"'] },
    });

    expect(calls[0]!.url).toBe('https://api.example.com/v1/users/u1?notify=false');
    expect(calls[0]!.headers['if-match']).toBe('W/"3"');
    expect(calls[0]!.headers['x-reason']).toBeUndefined();
  });

  it('never renders the initial password into a URL or a header', async () => {
    const document = simple({
      account: {
        ...simple().account,
        create: {
          method: 'POST',
          path: '/users',
          query: { pw: '{{initialPassword}}' },
          headers: { 'X-Password': '{{initialPassword}}' },
          body: { login: '{{correlationKey}}', actionId: '{{actionId}}' },
        },
      },
    });
    answers = [{ status: 200, body: { items: [] } }, { status: 201, body: { id: 'new' } }];

    await httpTargetConnector.write(config(document), {
      op: 'create_account',
      actionId: 'a1',
      correlationKey: 'jdoe',
      attributes: {},
      enabled: true,
      initialPassword: 'Initial-Passw0rd!',
    });

    const sent = calls.at(-1)!;
    expect(sent.url).not.toContain('Passw0rd');
    expect(sent.headers['x-password']).toBeUndefined();
  });

  it('cannot replace the credential with a request header', async () => {
    const document = simple({
      account: {
        ...simple().account,
        update: {
          method: 'PATCH',
          path: '/users/{{anchor}}',
          headers: { Authorization: 'Bearer {{attr.displayName}}' },
          body: { displayName: '{{attr.displayName}}' },
        },
      },
    });
    answers = [{ status: 200, body: {} }];

    await httpTargetConnector.write(config(document), {
      op: 'update_account',
      actionId: 'a1',
      anchor: 'u1',
      attributes: { displayName: ['Jane'] },
    });

    expect(calls[0]!.headers.authorization).toBe('Bearer a-secret');
  });

  it('sends typed values: numbers and booleans', async () => {
    const document = simple({
      account: {
        ...simple().account,
        update: {
          method: 'PATCH',
          path: '/users/{{anchor}}',
          body: {
            department_id: '{{attr.departmentId|number}}',
            manager: '{{attr.isManager|boolean}}',
            floor: '{{attr.floor|number}}',
          },
        },
      },
    });
    answers = [{ status: 200, body: {} }];

    await httpTargetConnector.write(config(document), {
      op: 'update_account',
      actionId: 'a1',
      anchor: 'u1',
      attributes: { departmentId: ['12'], isManager: ['TRUE'], floor: ['ground'] },
    });

    // `floor` is not a number, so it is left out rather than sent as NaN.
    expect(calls[0]!.body).toEqual({ department_id: 12, manager: true });
  });

  it('sends a form-encoded body', async () => {
    const document = simple({
      account: {
        ...simple().account,
        update: {
          method: 'POST',
          path: '/users/{{anchor}}',
          bodyFormat: 'form',
          body: { display_name: '{{attr.displayName}}', active: true },
        },
      },
    });
    answers = [{ status: 200, body: {} }];

    await httpTargetConnector.write(config(document), {
      op: 'update_account',
      actionId: 'a1',
      anchor: 'u1',
      attributes: { displayName: ['Jane Doe'] },
    });

    expect(calls[0]!.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(calls[0]!.body).toBe('display_name=Jane+Doe&active=true');
  });

  it('refuses a nested form body without sending it', async () => {
    const document = simple({
      account: {
        ...simple().account,
        update: {
          method: 'POST',
          path: '/users/{{anchor}}',
          bodyFormat: 'form',
          body: { name: { given: '{{attr.displayName}}' } },
        },
      },
    });

    const result = await httpTargetConnector.write(config(document), {
      op: 'update_account',
      actionId: 'a1',
      anchor: 'u1',
      attributes: { displayName: ['Jane'] },
    });

    expect(result).toMatchObject({ ok: false, failure: 'rejected' });
    expect(calls).toHaveLength(0);
  });
});

describe('finding an account before a create', () => {
  const withFind = (find: unknown) => simple({ account: { ...simple().account, find } } as never);

  it('asks the search endpoint instead of walking the collection', async () => {
    answers = [
      { status: 200, body: { results: [{ id: 'other', login: 'jdoe.smith' }] } },
      { status: 201, body: { id: 'new' } },
    ];

    const result = await httpTargetConnector.write(
      config(withFind({ path: '/users', query: { q: '{{correlationKey}}' }, itemsAt: 'results' })),
      { op: 'create_account', actionId: 'a1', correlationKey: 'jdoe', attributes: {}, enabled: true },
    );

    // A near match from a fuzzy search is not a collision.
    expect(result).toMatchObject({ ok: true, anchor: 'new' });
    expect(calls[0]!.url).toBe('https://api.example.com/v1/users?q=jdoe');
  });

  it('reads a not-found answer as no collision', async () => {
    answers = [{ status: 404, body: null }, { status: 201, body: { id: 'new' } }];

    const result = await httpTargetConnector.write(
      config(withFind({ path: '/users/by-login/{{correlationKey}}' })),
      { op: 'create_account', actionId: 'a1', correlationKey: 'jdoe', attributes: {}, enabled: true },
    );

    expect(result).toMatchObject({ ok: true, anchor: 'new' });
  });
});

describe('failures explained in a 4xx body', () => {
  it('classifies by message only where the status leaves it rejected', async () => {
    const document = simple({
      failures: { error: { messageAt: 'error.message', conflictWhen: ['taken'] } },
    } as never);
    answers = [{ status: 422, body: { error: { message: 'login is taken; secret a-secret' } } }];

    const result = await httpTargetConnector.write(config(document), {
      op: 'update_account',
      actionId: 'a1',
      anchor: 'u1',
      attributes: { displayName: ['Jane'] },
    });

    expect(result).toMatchObject({ ok: false, failure: 'conflict' });
    expect(result.message).toMatch(/^the target answered HTTP 422: login is taken/);
    expect(result.message).not.toContain('a-secret');
  });

  it('shows only the status when the document names no message', async () => {
    answers = [{ status: 422, body: { error: { message: 'Initial-Passw0rd! is too short' } } }];

    const result = await httpTargetConnector.write(config(), {
      op: 'update_account',
      actionId: 'a1',
      anchor: 'u1',
      attributes: { displayName: ['Jane'] },
    });

    expect(result.message).toBe('the target answered HTTP 422');
  });
});

describe('more ways to authenticate', () => {
  it('sends client credentials as HTTP Basic, with extra token fields', async () => {
    const document = simple({
      auth: {
        type: 'oauth2',
        tokenUrl: 'https://login.example.com/token',
        clientId: 'client 1',
        clientAuth: 'basic',
        tokenParams: { audience: 'https://api.example.com' },
      },
    });
    answers = [
      { status: 200, body: { access_token: 'issued', expires_in: 3600 } },
      { status: 200, body: { items: [] } },
    ];

    await collect(httpTargetConnector.read(config(document)));

    const exchange = calls[0]!;
    expect(exchange.headers.authorization).toBe(
      `Basic ${Buffer.from('client+1:a-secret').toString('base64')}`,
    );
    expect(exchange.body).toBe('audience=https%3A%2F%2Fapi.example.com&grant_type=client_credentials');
  });

  it('refuses a token field Syntra sets itself', () => {
    const parsed = httpConnectorDocument.safeParse(
      simple({
        auth: {
          type: 'oauth2',
          tokenUrl: 'https://login.example.com/token',
          clientId: 'c',
          tokenParams: { client_secret: 'x' },
        },
      }),
    );
    expect(parsed.success).toBe(false);
  });

  it('sends the credential as a query parameter', async () => {
    answers = [{ status: 200, body: { items: [] } }];

    await collect(
      httpTargetConnector.read(config(simple({ auth: { type: 'query', param: 'api_key' } }))),
    );

    expect(new URL(calls[0]!.url).searchParams.get('api_key')).toBe('a-secret');
    expect(calls[0]!.headers.authorization).toBeUndefined();
  });
});

describe('the connection test preview', () => {
  it('shows mapped accounts, skipped items and fields the document leaves unread', async () => {
    const document = simple({
      account: { ...simple().account, exclude: [{ at: 'type', equals: 'service' }] },
    });
    answers = [
      {
        status: 200,
        body: {
          items: [
            { id: 'u1', login: 'jdoe', displayName: 'Jane', type: 'person', phone: '555' },
            { id: 'svc', login: 'backup', type: 'service' },
            { login: 'no-id' },
          ],
        },
      },
    ];

    const tested = await httpTargetConnector.test(config(document));

    expect(tested.preview).toEqual({
      accounts: [{ anchor: 'u1', name: 'jdoe', enabled: null, attributes: { displayName: ['Jane'] } }],
      skipped: 2,
      unreadFields: ['phone'],
    });
  });
});
