import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_CONNECTOR_DOCUMENTS, snipeItDocument } from './documents/index.js';
import { httpConnectorDocument, type HttpConnectorDocument } from './document.js';
import { httpTargetConnector } from './connector.js';
import { FakeSnipeIt } from '../testing/fake-snipe-it.js';
import { certifyTargetConnector } from '../testing/target-connector-certification.js';
import { readBackTarget } from '../types.js';
import { capabilitiesForTarget } from '../capabilities.js';
import { connectorLifecycleMetadata } from '../metadata.js';
import { correlationKeyPolicyFor } from '../naming.js';

let snipe: FakeSnipeIt;

// The same seam the other HTTP connector tests use: `guardedFetch` is what
// the connector calls, so the fake answers there.
vi.mock('../net/guarded-fetch.js', () => ({
  guardedFetch: () => async (url: string | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const answer = snipe.handle({
      url: String(url),
      method: init?.method ?? 'GET',
      headers,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(answer.body === null ? '' : JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': 'application/json', ...(answer.headers ?? {}) },
    });
  },
}));

const API_KEY = 'snipe-personal-api-key-0123456789';

const document = (over: Partial<HttpConnectorDocument> = {}): HttpConnectorDocument => ({
  ...snipeItDocument,
  baseUrl: 'https://assets.example.test/api/v1',
  ...over,
});

const config = (doc: HttpConnectorDocument = document()) => ({ document: doc, bindPassword: API_KEY });

const collect = async <T>(source: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = [];
  for await (const item of source) out.push(item);
  return out;
};

const create = (over: Partial<{ actionId: string; correlationKey: string; enabled: boolean; password: string }> = {}) => ({
  op: 'create_account' as const,
  actionId: over.actionId ?? 'act-create-1',
  correlationKey: over.correlationKey ?? 'jdoe',
  attributes: {
    givenName: ['Jane'],
    familyName: ['Doe'],
    mail: ['jane.doe@example.test'],
    title: ['Engineer'],
  },
  enabled: over.enabled ?? true,
  initialPassword: over.password ?? 'Initial-Passw0rd!',
});

beforeEach(() => {
  snipe = new FakeSnipeIt(API_KEY);
});

describe('the Snipe-IT document', () => {
  it('is offered by the console and validates against the schema', () => {
    expect(BUILTIN_CONNECTOR_DOCUMENTS['snipe-it']).toBe(snipeItDocument);
    const parsed = httpConnectorDocument.parse(snipeItDocument);
    expect(parsed.failures.body).toEqual({
      at: 'status',
      equals: 'error',
      messageAt: 'messages',
      conflictWhen: ['already been taken'],
      notFoundWhen: ['not found', 'does not exist'],
    });
    expect(parsed.account.list.paging).toMatchObject({ style: 'offset', pageSize: 500, totalAt: 'total' });
  });

  it('declares email-shaped usernames, so a SAML NameID can match one', () => {
    expect(httpConnectorDocument.parse(snipeItDocument).naming).toEqual({
      allow: 'email',
      maxLength: 191,
    });
    expect(correlationKeyPolicyFor('httpJson', { document: snipeItDocument })).toEqual({
      charset: 'email',
      maxLength: 191,
    });
  });

  it('describes users only, with no delete, no archive and no entitlements', () => {
    expect(snipeItDocument.entitlement).toBeUndefined();
    expect(snipeItDocument.container).toBeUndefined();
    expect(snipeItDocument.account.archive).toBeUndefined();
  });

  it('advertises create, update, disable and read-back but no entitlements', () => {
    expect(capabilitiesForTarget('httpJson', { document: snipeItDocument })).toEqual({
      available: true,
      readBack: true,
      createAccount: true,
      updateAccount: true,
      disableAccount: true,
      manageEntitlements: false,
    });
  });

  it('runs on the document-driven HTTP adapter, which is preview and controlled', () => {
    expect(connectorLifecycleMetadata('httpJson')).toMatchObject({
      supportState: 'preview',
      rollout: 'controlled',
    });
  });
});

describe('Snipe-IT through the document-driven connector', () => {
  it('sends the bearer key and an explicit User-Agent', async () => {
    const result = await httpTargetConnector.test(config());
    expect(result.ok).toBe(true);
    expect(snipe.requests[0]?.headers).toMatchObject({
      authorization: `Bearer ${API_KEY}`,
      accept: 'application/json',
      'user-agent': 'Syntra-Provisioning/1',
    });
  });

  it('reads every user across offset pages, even when Snipe-IT caps the page size', async () => {
    for (let i = 0; i < 7; i += 1) snipe.seed({ username: `user${i}`, first_name: `U${i}` });
    // `limit=500` is asked for; the instance answers 3 at a time.
    snipe.maxResults = 3;
    const records = await collect(httpTargetConnector.read(config()));
    expect(records.map((r) => r.anchor)).toEqual(['1', '2', '3', '4', '5', '6', '7']);
    const pages = snipe.requests.map((r) => new URL(r.url).searchParams.get('offset'));
    expect(pages).toEqual(['0', '3', '6']);
    expect(new URL(snipe.requests[0]!.url).searchParams.get('sort')).toBe('id');
  });

  it('maps Snipe-IT fields to Syntra attribute names', async () => {
    snipe.seed({
      username: 'jdoe',
      first_name: 'Jane',
      last_name: 'Doe',
      email: 'jane.doe@example.test',
      jobtitle: 'Engineer',
      activated: false,
    });
    const [record] = await collect(httpTargetConnector.read(config()));
    expect(record).toMatchObject({
      anchor: '1',
      dn: 'jdoe',
      attributes: {
        userName: ['jdoe'],
        givenName: ['Jane'],
        familyName: ['Doe'],
        mail: ['jane.doe@example.test'],
        title: ['Engineer'],
        enabled: ['false'],
      },
    });
  });

  it('creates a user with the marker, both passwords and the anchor from payload.id', async () => {
    const result = await httpTargetConnector.write(config(), create());
    expect(result).toMatchObject({ ok: true, anchor: '1' });
    const post = snipe.requests.find((r) => r.method === 'POST');
    expect(post?.body).toEqual({
      first_name: 'Jane',
      last_name: 'Doe',
      username: 'jdoe',
      email: 'jane.doe@example.test',
      jobtitle: 'Engineer',
      password: 'Initial-Passw0rd!',
      password_confirmation: 'Initial-Passw0rd!',
      activated: true,
      employee_num: 'act-create-1',
    });
    expect(snipe.users.get(1)).toMatchObject({ employee_num: 'act-create-1', activated: true });
  });

  it('creates a user whose username is an email address, intact', async () => {
    const result = await httpTargetConnector.write(
      config(),
      create({ correlationKey: 'jane.doe@example.test' }),
    );
    expect(result).toMatchObject({ ok: true });
    const post = snipe.requests.find((r) => r.method === 'POST');
    expect((post?.body as { username?: string }).username).toBe('jane.doe@example.test');
  });

  it('adopts the account a lost-response create already made', async () => {
    await httpTargetConnector.write(config(), create());
    const again = await httpTargetConnector.write(config(), create());
    expect(again).toMatchObject({ ok: true, anchor: '1' });
    expect(snipe.users.size).toBe(1);
  });

  it('classifies a 200 "already been taken" as a conflict, with a redacted message', async () => {
    // The collision check would catch a username that is visible; this one
    // races in between the check and the POST.
    const original = snipe.handle.bind(snipe);
    snipe.handle = (request) => {
      if (request.method === 'POST') {
        return {
          status: 200,
          body: {
            status: 'error',
            messages: {
              username: ['The username has already been taken.'],
              email: ['jane.doe@example.test is in use by Bearer abcdefghijklmnopqrstuvwxyz'],
              password: ['Initial-Passw0rd! was not accepted'],
            },
            payload: null,
          },
        };
      }
      return original(request);
    };
    const result = await httpTargetConnector.write(config(), create());
    expect(result.ok).toBe(false);
    expect(result.failure).toBe('conflict');
    expect(result.message).toContain('The username has already been taken.');
    expect(result.message).not.toContain('jane.doe@example.test');
    expect(result.message).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(result.message).not.toContain('Initial-Passw0rd!');
    expect(result.message).not.toContain(API_KEY);
  });

  it('classifies any other 200 error body as rejected, never as success', async () => {
    const result = await httpTargetConnector.write(config(), create({ password: 'short' }));
    expect(result).toMatchObject({ ok: false, failure: 'rejected' });
    expect(result.message).toMatch(/at least 8 characters/);
    expect(result.message).not.toContain('short');
    expect(snipe.users.size).toBe(0);
  });

  it('bounds the surfaced message', async () => {
    snipe.handle = () => ({
      status: 200,
      body: { status: 'error', messages: { a: ['x'.repeat(5000)] } },
    });
    const result = await httpTargetConnector.write(config(), {
      op: 'update_account',
      actionId: 'u',
      anchor: '1',
      attributes: { givenName: ['A'] },
    });
    expect(result).toMatchObject({ ok: false, failure: 'rejected' });
    expect(result.message.length).toBeLessThan(400);
  });

  it('updates the mapped attributes and nothing else', async () => {
    snipe.seed({ username: 'jdoe', first_name: 'Jane', employee_num: 'act-original' });
    const result = await httpTargetConnector.write(config(), {
      op: 'update_account',
      actionId: 'act-update',
      anchor: '1',
      attributes: { givenName: ['Janet'], familyName: ['Doe'], title: ['Lead'] },
    });
    expect(result.ok).toBe(true);
    const patch = snipe.requests.find((r) => r.method === 'PATCH');
    expect(new URL(patch!.url).pathname).toBe('/api/v1/users/1');
    expect(patch?.body).toEqual({ first_name: 'Janet', last_name: 'Doe', jobtitle: 'Lead' });
    expect(snipe.users.get(1)).toMatchObject({ first_name: 'Janet', jobtitle: 'Lead', employee_num: 'act-original' });
  });

  it('deactivates and reactivates, and never deletes', async () => {
    snipe.seed({ username: 'jdoe' });
    const off = await httpTargetConnector.write(config(), {
      op: 'disable_account',
      actionId: 'act-off',
      anchor: '1',
      reason: 'leaver',
    });
    expect(off.ok).toBe(true);
    expect(snipe.users.get(1)?.activated).toBe(false);
    const on = await httpTargetConnector.write(config(), { op: 'enable_account', actionId: 'act-on', anchor: '1' });
    expect(on.ok).toBe(true);
    expect(snipe.users.get(1)?.activated).toBe(true);
    const archive = await httpTargetConnector.write(config(), {
      op: 'archive_account',
      actionId: 'act-archive',
      anchor: '1',
      entitlementDns: [],
    });
    expect(archive).toMatchObject({ ok: false, failure: 'rejected' });
    expect(snipe.requests.some((r) => r.method === 'DELETE')).toBe(false);
  });

  it('classifies a write against a missing user as not_found', async () => {
    const result = await httpTargetConnector.write(config(), {
      op: 'disable_account',
      actionId: 'act-missing',
      anchor: '404',
      reason: 'leaver',
    });
    expect(result).toMatchObject({ ok: false, failure: 'not_found' });
  });

  it('reads one user back by id', async () => {
    snipe.seed({ username: 'other' });
    snipe.seed({ username: 'jdoe', first_name: 'Jane', activated: false });
    snipe.requests.length = 0;
    const observed = await readBackTarget(httpTargetConnector, config(), '2');
    expect(observed).toMatchObject({ complete: true, enabled: false, entitlementIds: [] });
    expect(observed.account?.attributes.userName).toEqual(['jdoe']);
    // One GET for the user, no enumeration of the collection.
    expect(snipe.requests.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
      'GET /api/v1/users/2',
    ]);
  });

  it('reads a missing user back as absent, completely', async () => {
    const observed = await readBackTarget(httpTargetConnector, config(), '99');
    expect(observed).toEqual({ account: null, entitlementIds: [], enabled: null, complete: true });
  });

  it('refuses a list answered with an error body instead of reading it as empty', async () => {
    snipe.handle = () => ({ status: 200, body: { status: 'error', messages: 'Forbidden' } });
    await expect(collect(httpTargetConnector.read(config()))).rejects.toThrow(/refused the request: Forbidden/);
    const tested = await httpTargetConnector.test(config());
    expect(tested.ok).toBe(false);
  });

  it('passes the shared certification contract, users only', async () => {
    const report = await certifyTargetConnector({
      name: 'Snipe-IT',
      connector: httpTargetConnector,
      config: config(),
      create: create({ actionId: 'cert-snipe-create', correlationKey: 'cert.user' }),
      update: (anchor) => ({
        op: 'update_account',
        actionId: 'cert-snipe-update',
        anchor,
        attributes: { givenName: ['Certified'], familyName: ['User'], title: ['Auditor'] },
      }),
      disable: (anchor) => ({
        op: 'disable_account',
        actionId: 'cert-snipe-disable',
        anchor,
        reason: 'connector certification',
      }),
      missingAnchor: '424242',
      assertCreated: (observed) => {
        expect(observed.account?.attributes.userName).toEqual(['cert.user']);
        expect(observed.account?.attributes.mail).toEqual(['jane.doe@example.test']);
      },
      assertUpdated: (observed) => {
        expect(observed.account?.attributes.givenName).toEqual(['Certified']);
        expect(observed.account?.attributes.title).toEqual(['Auditor']);
      },
    });
    expect(report.checks).toEqual([
      'connection',
      'container-placement',
      'create',
      'idempotent-create',
      'create-read-back',
      'update',
      'idempotent-update',
      'update-read-back',
      'disable',
      'idempotent-disable',
      'disable-read-back',
      'missing-object',
    ]);
  });
});
