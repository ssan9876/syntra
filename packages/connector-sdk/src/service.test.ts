import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { certifyConnectorService } from './certification.js';
import { ConnectorClient, ConnectorServiceError } from './client.js';
import { createInMemoryConnector } from './example/in-memory.js';
import { HEADERS, isRetryable } from './protocol.js';
import { ConnectorError, createConnectorServer, type ConnectorServerOptions } from './server.js';
import { signRequest } from './signing.js';

const SECRET = 'example-shared-secret-0123456789abcdef';
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function example(options: Partial<ConnectorServerOptions> = {}) {
  const { connector, store } = createInMemoryConnector({
    entitlements: [{ id: 'staff', type: 'group', displayName: 'Staff' }],
  });
  const errors: unknown[] = [];
  const baseUrl = await listen(
    createConnectorServer({ connector, secrets: SECRET, onError: (e) => errors.push(e), ...options }),
  );
  return { baseUrl, store, errors, client: new ConnectorClient({ baseUrl, secret: SECRET, timeoutMs: 2000 }) };
}

const create = {
  op: 'create_account' as const,
  actionId: 'action-create-1',
  correlationKey: 'anna.novak',
  attributes: { displayName: ['Anna Novak'] },
  enabled: true,
  initialPassword: 'Initial-Passw0rd!',
};

describe('certifyConnectorService', () => {
  it('certifies the example connector, protocol checks first', async () => {
    const { baseUrl } = await example();
    const report = await certifyConnectorService({
      baseUrl,
      secret: SECRET,
      create,
      update: (anchor) => ({ op: 'update_account', actionId: 'action-update-1', anchor, attributes: { displayName: ['Anna N.'] } }),
      disable: (anchor) => ({ op: 'disable_account', actionId: 'action-disable-1', anchor, reason: 'left' }),
      entitlement: {
        id: 'staff',
        grant: (anchor) => ({ op: 'grant_entitlement', actionId: 'action-grant-1', anchor, entitlementId: 'staff' }),
        revoke: (anchor) => ({ op: 'revoke_entitlement', actionId: 'action-revoke-1', anchor, entitlementId: 'staff' }),
      },
      missingAnchor: 'no-such-account',
      assertUpdated: (observed) => expect(observed.account?.attributes.displayName).toEqual(['Anna N.']),
    });
    expect(report.name).toBe('In-memory example');
    expect(report.checks).toEqual([
      'handshake',
      'signature',
      'version',
      'accounts-list',
      'connection',
      'container-placement',
      'create',
      'idempotent-create',
      'create-read-back',
      'update',
      'idempotent-update',
      'update-read-back',
      'grant-read-back',
      'revoke-read-back',
      'disable',
      'idempotent-disable',
      'disable-read-back',
      'missing-object',
    ]);
  });

  it('fails a service that does not check signatures', async () => {
    const baseUrl = await listen(
      createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            protocolVersions: [1],
            connector: { name: 'Lax', version: '0.0.1' },
            capabilities: { placesAccountsInContainers: false, entitlements: false, operations: [] },
            schema: { objectClasses: [], attributes: [] },
          }),
        );
      }),
    );
    await expect(
      certifyConnectorService({ baseUrl, secret: SECRET, create, missingAnchor: 'x' }),
    ).rejects.toThrow('an unsigned request was not refused: the service answered HTTP 200, expected 401');
  });
});

describe('authentication', () => {
  it('maps a refused signature on a write to unauthorized, which is not retried', async () => {
    const { baseUrl } = await example();
    const client = new ConnectorClient({ baseUrl, secret: `${SECRET}-but-wrong` });
    const result = await client.write(create);
    expect(result).toEqual({
      ok: false,
      failure: 'unauthorized',
      message:
        "Connector service refused Syntra's signature on write (HTTP 401): Request signature does not match. Check the shared secret.",
    });
    expect(isRetryable(result.ok ? undefined : result.failure)).toBe(false);
  });

  it('refuses a request whose clock is 10 minutes off', async () => {
    const { baseUrl } = await example();
    const client = new ConnectorClient({ baseUrl, secret: SECRET, now: () => Date.now() - 600_000 });
    await expect(client.test()).rejects.toMatchObject({ code: 'unauthenticated', status: 401 });
  });

  it('refuses a secret shorter than 32 characters at both ends', () => {
    expect(() => new ConnectorClient({ baseUrl: 'http://x', secret: 'short' })).toThrow(
      'Shared secret is shorter than 32 characters.',
    );
    const { connector } = createInMemoryConnector();
    expect(() => createConnectorServer({ connector, secrets: 'short' })).toThrow(
      'Shared secret is shorter than 32 characters.',
    );
  });
});

describe('versions', () => {
  it('refuses a request in a version the service does not speak, naming the ones it does', async () => {
    const { baseUrl } = await example();
    const body = '{}';
    const signed = signRequest(SECRET, 'test', body);
    const response = await fetch(`${baseUrl}/test`, {
      method: 'POST',
      headers: {
        [HEADERS.version]: '2',
        [HEADERS.timestamp]: signed.timestamp,
        [HEADERS.nonce]: signed.nonce,
        [HEADERS.signature]: signed.signature,
      },
      body,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: 'unsupported_version', message: 'Protocol version 2 is not supported.', supportedVersions: [1] },
    });
  });

  it('reports a service that speaks only another version as incompatible', () => {
    expect(
      ConnectorClient.incompatibility({
        protocolVersions: [2, 3],
        connector: { name: 'Future HR', version: '9.0.0' },
        capabilities: { placesAccountsInContainers: false, entitlements: false, operations: [] },
        schema: { objectClasses: [], attributes: [] },
      }),
    ).toBe('Connector service "Future HR" speaks protocol 2, 3. Syntra speaks 1. Update the connector service or Syntra.');
  });

  it('maps an unsupported_version answer to a write onto rejected', async () => {
    const baseUrl = await listen(
      createServer((_req, res) => {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'unsupported_version', message: 'no', supportedVersions: [2] } }));
      }),
    );
    const result = await new ConnectorClient({ baseUrl, secret: SECRET }).write(create);
    expect(result).toEqual({
      ok: false,
      failure: 'rejected',
      message: 'Connector service does not speak protocol 1 (it speaks 2). Update the connector service or Syntra.',
    });
  });
});

describe('timeouts', () => {
  it('reports a write that outlives the timeout as transient, so it is retried', async () => {
    const { baseUrl, store } = await example();
    store.delayMs = 1500;
    const client = new ConnectorClient({ baseUrl, secret: SECRET, timeoutMs: 1000 });
    const result = await client.write(create);
    expect(result).toEqual({
      ok: false,
      failure: 'transient',
      message: `No answer to write from ${baseUrl} within 1000 ms.`,
    });
  });

  it('throws a timeout error from a read', async () => {
    const { baseUrl, store } = await example();
    store.delayMs = 1500;
    const client = new ConnectorClient({ baseUrl, secret: SECRET, timeoutMs: 1000 });
    await expect(client.readBack('anything')).rejects.toMatchObject({ code: 'timeout' });
  });

  it('answers the retry of a timed-out create with the anchor the first attempt made', async () => {
    const { baseUrl, store } = await example();
    store.delayMs = 1500;
    const slow = new ConnectorClient({ baseUrl, secret: SECRET, timeoutMs: 1000 });
    expect((await slow.write(create)).ok).toBe(false);
    // The service finished the create after Syntra stopped waiting.
    await new Promise((r) => setTimeout(r, 700));
    store.delayMs = 0;
    const retried = await slow.write(create);
    expect(retried).toMatchObject({ ok: true, anchor: [...store.accounts.keys()][0] });
    expect(store.accounts.size).toBe(1);
  });
});

describe('failures', () => {
  it('passes a throttled failure through with its delay, which is retried', async () => {
    const { client, store } = await example();
    store.failNext('create_account', new ConnectorError('throttled', 'Rate limit reached.', { retryAfterMs: 5000 }));
    const result = await client.write(create);
    expect(result).toEqual({ ok: false, failure: 'throttled', message: 'Rate limit reached.', retryAfterMs: 5000 });
    expect(isRetryable('throttled')).toBe(true);
  });

  it('passes a rejected failure through, which is not retried', async () => {
    const { client, store } = await example();
    store.failNext('create_account', new ConnectorError('rejected', 'Department "Ops" does not exist.'));
    expect(await client.write(create)).toEqual({
      ok: false,
      failure: 'rejected',
      message: 'Department "Ops" does not exist.',
    });
  });

  it('turns an unexpected handler error into transient without leaking it', async () => {
    const { client, store, errors } = await example();
    store.failNext('create_account', new Error('socket hang up at 10.0.0.4') as ConnectorError);
    expect(await client.write(create)).toEqual({
      ok: false,
      failure: 'transient',
      message: 'Connector "In-memory example" failed on create_account.',
    });
    expect(errors).toHaveLength(1);
  });

  it('answers a write it has no handler for with rejected', async () => {
    const { connector } = createInMemoryConnector();
    delete connector.write.delete_account;
    const baseUrl = await listen(createConnectorServer({ connector, secrets: SECRET }));
    const client = new ConnectorClient({ baseUrl, secret: SECRET });
    expect(await client.write({ op: 'delete_account', actionId: 'a-1', anchor: 'x' })).toEqual({
      ok: false,
      failure: 'rejected',
      message: 'Connector "In-memory example" does not support delete_account.',
    });
    expect((await client.describe()).capabilities.operations).not.toContain('delete_account');
  });

  it('maps a 503 to transient and a 429 with Retry-After to throttled', async () => {
    let status = 503;
    const baseUrl = await listen(
      createServer((_req, res) => {
        res.writeHead(status, { 'content-type': 'text/html', 'retry-after': '7' });
        res.end('<html>busy</html>');
      }),
    );
    const client = new ConnectorClient({ baseUrl, secret: SECRET });
    expect(await client.write(create)).toMatchObject({ ok: false, failure: 'transient' });
    status = 429;
    expect(await client.write(create)).toMatchObject({ ok: false, failure: 'throttled', retryAfterMs: 7000 });
  });

  it('refuses an answer that is not the protocol', async () => {
    const baseUrl = await listen(
      createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ accounts: [{ anchor: 'a' }], nextCursor: null }));
      }),
    );
    const client = new ConnectorClient({ baseUrl, secret: SECRET });
    const error = await client.call('accounts.list', { cursor: null, pageSize: 10 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectorServiceError);
    expect((error as ConnectorServiceError).message).toBe(
      'Answer to accounts.list does not match protocol 1: accounts.0.correlationKey: Invalid input: expected string, received undefined',
    );
  });

  it('refuses to serve an account carrying a reserved attribute', async () => {
    const { connector } = createInMemoryConnector();
    connector.accounts.list = async () => ({
      accounts: [{ anchor: 'a', correlationKey: 'anna', attributes: { Enabled: ['true'] }, enabled: true }],
      nextCursor: null,
    });
    const errors: unknown[] = [];
    const baseUrl = await listen(createConnectorServer({ connector, secrets: SECRET, onError: (e) => errors.push(e) }));
    const client = new ConnectorClient({ baseUrl, secret: SECRET });
    await expect(client.call('accounts.list', { cursor: null, pageSize: 10 })).rejects.toMatchObject({
      code: 'internal',
      status: 500,
    });
    expect(String(errors[0])).toContain('accounts.0.attributes.Enabled: "Enabled" is reserved.');
  });

  it('stops a listing that hands back the same cursor twice', async () => {
    const { connector } = createInMemoryConnector();
    connector.accounts.list = async () => ({ accounts: [], nextCursor: 'again' });
    const baseUrl = await listen(createConnectorServer({ connector, secrets: SECRET }));
    const client = new ConnectorClient({ baseUrl, secret: SECRET });
    const read = async () => {
      for await (const account of client.accounts(10)) void account;
    };
    await expect(read()).rejects.toThrow('accounts.list returned cursor "again" twice.');
  });
});
