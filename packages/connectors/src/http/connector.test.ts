import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUILTIN_CONNECTOR_DOCUMENTS,
  entraIdDocument,
  googleWorkspaceDocument,
} from './documents/index.js';
import { httpConnectorDocument, type HttpConnectorDocument } from './document.js';
import { httpTargetConnector } from './connector.js';
import { forgetAccessTokens, readPath } from './client.js';

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

vi.mock('../net/guarded-fetch.js', () => ({
  guardedFetch: () => async (url: string | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers,
      body: init?.body ? safeParse(String(init.body)) : undefined,
    });
    const answer = answers.shift() ?? { status: 200, body: null };
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
    fields: { displayName: 'displayName', 'name.given': 'givenName' },
    create: {
      method: 'POST',
      path: '/users',
      body: { login: '{{correlationKey}}', displayName: '{{attr.displayName}}' },
      anchorAt: 'id',
    },
    update: { method: 'PATCH', path: '/users/{{anchor}}', body: { displayName: '{{attr.displayName}}' } },
    disable: { method: 'PATCH', path: '/users/{{anchor}}', body: { active: false } },
  },
  ...over,
});

const config = (document: HttpConnectorDocument = simple()) => ({
  document,
  credential: 'a-secret',
});

const collect = async <T>(source: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = [];
  for await (const item of source) out.push(item);
  return out;
};

beforeEach(() => {
  calls = [];
  answers = [];
  forgetAccessTokens();
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
      const account = document.account as Record<string, { method?: string }>;
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
    ];

    await expect(collect(httpTargetConnector.read(config(document)))).rejects.toThrow(/500/);
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
  it('creates an account and reports the anchor the target chose', async () => {
    answers = [{ status: 201, body: { id: 'new-1' } }];

    const result = await httpTargetConnector.write(config(), {
      op: 'create_account',
      actionId: 'act-1',
      correlationKey: 'ada',
      attributes: { displayName: ['Ada Lovelace'] },
      enabled: true,
      initialPassword: 'a-generated-one',
    });

    expect(result).toMatchObject({ ok: true, anchor: 'new-1' });
    expect(calls[0]).toMatchObject({
      url: 'https://api.example.com/v1/users',
      method: 'POST',
      body: { login: 'ada', displayName: 'Ada Lovelace' },
    });
  });

  it('omits a key whose attribute nobody set', async () => {
    answers = [{ status: 201, body: { id: 'new-1' } }];

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
    expect(calls[0]!.body).toEqual({ login: 'ada' });
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
    answers = [{ status: 400, body: { error: "password 'hunter2' is too weak" } }];
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
    const exchanges = calls.filter((c) => c.url.startsWith('https://login.example.com'));
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
});
