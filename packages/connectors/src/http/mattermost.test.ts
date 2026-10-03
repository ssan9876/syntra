import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_CONNECTOR_DOCUMENTS, mattermostDocument } from './documents/index.js';
import { httpConnectorDocument, type HttpConnectorDocument } from './document.js';
import { httpTargetConnector } from './connector.js';
import { readRetry } from './client.js';
import { FakeMattermost } from '../testing/fake-mattermost.js';
import { certifyTargetConnector } from '../testing/target-connector-certification.js';
import { capabilitiesForTarget } from '../capabilities.js';

let mm: FakeMattermost;

vi.mock('../net/guarded-fetch.js', () => ({
  guardedFetch: () => async (url: string | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const answer = mm.handle({
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

const TOKEN = 'mattermost-personal-access-token-0123';

const document = (over: Partial<HttpConnectorDocument> = {}): HttpConnectorDocument => ({
  ...mattermostDocument,
  baseUrl: 'https://chat.example.test/api/v4',
  ...over,
});

const config = (doc: HttpConnectorDocument = document()) => ({ document: doc, bindPassword: TOKEN });

const collect = async <T>(source: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = [];
  for await (const item of source) out.push(item);
  return out;
};

const create = (over: Partial<{ actionId: string; correlationKey: string; enabled: boolean; mail: string }> = {}) => ({
  op: 'create_account' as const,
  actionId: over.actionId ?? 'act-create-1',
  correlationKey: over.correlationKey ?? 'jdoe',
  attributes: {
    givenName: ['Jane'],
    familyName: ['Doe'],
    mail: [over.mail ?? 'jane.doe@example.test'],
    title: ['Engineer'],
  },
  enabled: over.enabled ?? true,
  initialPassword: 'Initial-Passw0rd!',
});

let waits: number[];

beforeEach(() => {
  mm = new FakeMattermost(TOKEN);
  waits = [];
  vi.spyOn(readRetry, 'sleep').mockImplementation(async (ms) => {
    waits.push(ms);
  });
});

describe('the Mattermost document', () => {
  it('is offered by the console and validates against the schema', () => {
    expect(BUILTIN_CONNECTOR_DOCUMENTS.mattermost).toBe(mattermostDocument);
    const parsed = httpConnectorDocument.parse(mattermostDocument);
    expect(parsed.account.list.paging).toEqual({
      style: 'page',
      pageParam: 'page',
      sizeParam: 'per_page',
      pageSize: 200,
      firstPage: 0,
    });
  });

  it('advertises create, update, disable, teams and complete read-back', () => {
    expect(capabilitiesForTarget('httpJson', config())).toMatchObject({
      createAccount: true,
      updateAccount: true,
      disableAccount: true,
      manageEntitlements: true,
      readBack: true,
      deleteAccount: false,
    });
  });
});

describe('Mattermost through the document-driven connector', () => {
  it('reads every user across numbered pages from 0, and leaves bots out', async () => {
    for (let i = 0; i < 450; i += 1) mm.seedUser({ username: `user${String(i).padStart(3, '0')}` });
    mm.seedUser({ username: 'zz-bot', is_bot: true });

    const records = await collect(httpTargetConnector.read(config()));

    expect(records).toHaveLength(450);
    expect(records.some((r) => r.attributes.userName?.[0] === 'zz-bot')).toBe(false);
    const pages = mm.requests
      .filter((r) => new URL(r.url).pathname === '/api/v4/users')
      .map((r) => new URL(r.url).searchParams.get('page'));
    // 200 + 200 + 51 (450 users and the bot), then the empty page that ends it.
    expect(pages).toEqual(['0', '1', '2', '3']);
  });

  it('reads delete_at as enabled state', async () => {
    mm.seedUser({ username: 'active' });
    mm.seedUser({ username: 'gone', delete_at: 1_690_000_000_000 });

    const records = await collect(httpTargetConnector.read(config()));

    expect(Object.fromEntries(records.map((r) => [r.dn, r.attributes.enabled]))).toEqual({
      active: ['true'],
      gone: ['false'],
    });
  });

  it('creates a user with the marker in props, looking the username up first', async () => {
    const result = await httpTargetConnector.write(config(), create());

    expect(result).toMatchObject({ ok: true });
    const user = [...mm.users.values()].find((u) => u.username === 'jdoe');
    expect(user).toMatchObject({
      email: 'jane.doe@example.test',
      first_name: 'Jane',
      position: 'Engineer',
      props: { syntra_action_id: 'act-create-1' },
      delete_at: 0,
    });
    expect(result.ok && result.anchor).toBe(user?.id);
    // One lookup by name, not a walk of every user.
    const paths = mm.requests.map((r) => `${r.method} ${new URL(r.url).pathname}`);
    expect(paths).toEqual(['GET /api/v4/users/username/jdoe', 'POST /api/v4/users']);
  });

  it('creates a pre-hire account and then deactivates it', async () => {
    const result = await httpTargetConnector.write(config(), create({ enabled: false }));

    expect(result).toMatchObject({ ok: true });
    const user = [...mm.users.values()].find((u) => u.username === 'jdoe');
    expect(user?.delete_at).not.toBe(0);
  });

  it('adopts the account a lost-response create made, and still deactivates a pre-hire', async () => {
    const first = await httpTargetConnector.write(config(), create({ enabled: false }));
    const user = [...mm.users.values()].find((u) => u.username === 'jdoe');
    if (user) user.delete_at = 0; // the first attempt's disable was lost

    const retried = await httpTargetConnector.write(config(), create({ enabled: false }));

    expect(retried).toMatchObject({ ok: true, anchor: first.ok ? first.anchor : 'none' });
    expect(user?.delete_at).not.toBe(0);
    expect(mm.users.size).toBe(1);
  });

  it('refuses to adopt a user Syntra did not create', async () => {
    mm.seedUser({ username: 'jdoe' });

    const result = await httpTargetConnector.write(config(), create());

    expect(result).toMatchObject({ ok: false, failure: 'conflict' });
  });

  it('classifies a 400 "already exists" as a conflict, with the target\'s message', async () => {
    mm.seedUser({ username: 'someone', email: 'jane.doe@example.test' });

    const result = await httpTargetConnector.write(config(), create());

    expect(result).toEqual({
      ok: false,
      failure: 'conflict',
      message: 'the target answered HTTP 400: An account with that email already exists.',
    });
  });

  it('updates, renames, deactivates and reactivates by id', async () => {
    const user = mm.seedUser({ username: 'jdoe', first_name: 'Jane' });

    expect(
      await httpTargetConnector.write(config(), {
        op: 'update_account',
        actionId: 'a-up',
        anchor: user.id,
        attributes: { givenName: ['Janet'], title: ['Lead'] },
      }),
    ).toMatchObject({ ok: true });
    expect(user).toMatchObject({ first_name: 'Janet', position: 'Lead' });

    expect(
      await httpTargetConnector.write(config(), {
        op: 'rename_account',
        actionId: 'a-rn',
        anchor: user.id,
        correlationKey: 'jdoe2',
      } as never),
    ).toMatchObject({ ok: true });
    expect(user.username).toBe('jdoe2');

    await httpTargetConnector.write(config(), {
      op: 'disable_account',
      actionId: 'a-dis',
      anchor: user.id,
      reason: 'leaver',
    });
    expect(user.delete_at).not.toBe(0);
    await httpTargetConnector.write(config(), { op: 'enable_account', actionId: 'a-en', anchor: user.id });
    expect(user.delete_at).toBe(0);
  });

  it('switches an existing user to SAML sign-in on update when the profile maps authService', async () => {
    const user = mm.seedUser({ username: 'jdoe', email: 'jane.doe@example.test' });

    const result = await httpTargetConnector.write(config(), {
      op: 'update_account',
      actionId: 'a-up',
      anchor: user.id,
      attributes: { givenName: ['Jane'], authService: ['saml'], authData: ['jane.doe@example.test'] },
    });

    expect(result).toMatchObject({ ok: true });
    expect(user).toMatchObject({ auth_service: 'saml', auth_data: 'jane.doe@example.test' });
    const writes = mm.requests.map((r) => `${r.method} ${new URL(r.url).pathname}`);
    expect(writes).toEqual([`PUT /api/v4/users/${user.id}/patch`, `PUT /api/v4/users/${user.id}/auth`]);
  });

  it('leaves the sign-in method alone when the profile does not map authService', async () => {
    const user = mm.seedUser({ username: 'jdoe' });

    await httpTargetConnector.write(config(), {
      op: 'update_account',
      actionId: 'a-up',
      anchor: user.id,
      attributes: { givenName: ['Jane'] },
    });

    expect(user.auth_service).toBe('');
    expect(mm.requests.map((r) => new URL(r.url).pathname)).toEqual([`/api/v4/users/${user.id}/patch`]);
  });

  it('creates a user and switches it to SAML sign-in', async () => {
    const op = create({ enabled: false });
    const result = await httpTargetConnector.write(config(), {
      ...op,
      attributes: { ...op.attributes, authService: ['saml'], authData: ['jane.doe@example.test'] },
    });

    expect(result).toMatchObject({ ok: true });
    const user = [...mm.users.values()].find((u) => u.username === 'jdoe');
    expect(user).toMatchObject({ auth_service: 'saml', auth_data: 'jane.doe@example.test' });
    expect(user?.delete_at).not.toBe(0);
  });

  it('reports a failed sign-in switch as a failed update', async () => {
    const user = mm.seedUser({ username: 'jdoe' });

    const result = await httpTargetConnector.write(config(), {
      op: 'update_account',
      actionId: 'a-up',
      anchor: user.id,
      // No authData: Mattermost refuses the body.
      attributes: { authService: ['saml'] },
    });

    expect(result).toMatchObject({ ok: false, failure: 'rejected' });
    expect(result.message).toMatch(/^Updated the account, but follow-up PUT \/users\/\{\{anchor\}\}\/auth failed: /);
  });

  it('lists teams and reads, grants and revokes team membership', async () => {
    const team = mm.seedTeam('eng', 'Engineering');
    const user = mm.seedUser({ username: 'jdoe' });

    expect(await collect(httpTargetConnector.listEntitlements(config()))).toEqual([
      { externalId: team.id, dn: team.id, type: 'group', displayName: 'Engineering', description: '' },
    ]);

    await httpTargetConnector.write(config(), {
      op: 'grant_entitlement',
      actionId: 'a-g',
      anchor: user.id,
      entitlementId: team.id,
    } as never);
    expect(await httpTargetConnector.readEntitlementMembers(config(), team.id)).toEqual([user.id]);

    await httpTargetConnector.write(config(), {
      op: 'revoke_entitlement',
      actionId: 'a-r',
      anchor: user.id,
      entitlementId: team.id,
    } as never);
    expect(await httpTargetConnector.readEntitlementMembers(config(), team.id)).toEqual([]);
  });

  it('waits out a throttled read instead of failing the run', async () => {
    mm.seedUser({ username: 'jdoe' });
    mm.throttleNext = 2;

    const records = await collect(httpTargetConnector.read(config()));

    expect(records).toHaveLength(1);
    expect(waits).toEqual([1000, 1000]);
  });

  it('previews the first accounts in the connection test', async () => {
    mm.seedUser({ username: 'jdoe', first_name: 'Jane' });
    mm.seedUser({ username: 'helper-bot', is_bot: true });

    const tested = await httpTargetConnector.test(config());

    expect(tested.ok).toBe(true);
    expect(tested.preview).toEqual({
      accounts: [
        {
          anchor: expect.any(String),
          name: 'jdoe',
          enabled: true,
          attributes: expect.objectContaining({ givenName: ['Jane'], enabled: ['true'] }),
        },
      ],
      skipped: 1,
      unreadFields: ['auth_data'],
    });
  });

  it('reports a refused token as such', async () => {
    const tested = await httpTargetConnector.test({ document: document(), bindPassword: 'wrong' });
    expect(tested).toMatchObject({ ok: false, message: 'the credential was refused' });
  });

  it('passes the shared certification contract, with teams', async () => {
    const team = mm.seedTeam('eng', 'Engineering');
    const report = await certifyTargetConnector({
      name: 'Mattermost',
      connector: httpTargetConnector,
      config: config(),
      create: create({ actionId: 'cert-mm-create', correlationKey: 'cert.user' }),
      update: (anchor) => ({
        op: 'update_account',
        actionId: 'cert-mm-update',
        anchor,
        attributes: { givenName: ['Certified'], title: ['Auditor'] },
      }),
      entitlement: {
        id: team.id,
        grant: (anchor) => ({ op: 'grant_entitlement', actionId: 'cert-mm-grant', anchor, entitlementId: team.id }) as never,
        revoke: (anchor) => ({ op: 'revoke_entitlement', actionId: 'cert-mm-revoke', anchor, entitlementId: team.id }) as never,
      },
      disable: (anchor) => ({ op: 'disable_account', actionId: 'cert-mm-disable', anchor, reason: 'certification' }),
      missingAnchor: 'id999999999999999999999999',
      assertUpdated: (observed) => {
        expect(observed.account?.attributes.givenName).toEqual(['Certified']);
      },
    });
    expect(report.checks).toContain('revoke-read-back');
    expect(report.checks).toContain('missing-object');
  });
});
