import { prisma } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { loadConfig, memoryTransport } from '@syntra/core';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';

const TEST_HOST = 'acme.syntra.test';

/**
 * Backlog #56, asserted against the REAL application logger: `buildApp`'s own
 * configuration, writing to a collector through the `logStream` seam, so a
 * regression in `logging.ts` -- or a second logger config creeping into
 * `app.ts` -- fails here rather than in somebody's log archive.
 *
 * The fixtures are the representative leak routes: an HTTP client error
 * carrying its request config (Authorization header, JSON body with a
 * password), an LDAP bind failure naming the DN and password, and a context
 * object carrying a person record and vault material.
 */
const PLANTED = [
  'Bearer-ghp_live_R4nd0mT0kenValue0123456789ABCdef',
  'ghp_live_R4nd0mT0kenValue0123456789ABCdef',
  'Sup3rS3cretBindPw!',
  'client-secret-9f8e7d6c5b4a',
  'abc123cookievalue',
  'jane.doe@acme.test',
  'Jane Doe',
  'JBSWY3DPEHPK3PXP',
  'RC-1111-2222-3333',
  'vault-plaintext-value',
  'secret-state',
];

let app: Awaited<ReturnType<typeof buildApp>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function appWithCollector() {
  await resetDatabase();
  await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  const config = loadConfig({
    DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://syntra_app:syntra_app@localhost:5432/syntra',
    PORT: '3000',
    PUBLIC_URL: `http://${TEST_HOST}`,
    SESSION_SECRET: 'x'.repeat(32),
    MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
    SMTP_URL: 'smtp://localhost:1025',
    OUTBOUND_ALLOW_PRIVATE: 'true',
    GOVERN_CHECKPOINT_KEY: Buffer.alloc(32, 11).toString('base64'),
  });
  const lines: string[] = [];
  app = await buildApp(config, {
    transport: memoryTransport(),
    logStream: { write: (line) => { lines.push(line); } },
  });
  return { app, lines };
}

function connectorError(): Error {
  return Object.assign(new Error('Request failed with status code 401'), {
    name: 'AxiosError',
    code: 'ERR_BAD_REQUEST',
    config: {
      method: 'post',
      url: 'https://scim.example.test/Users?filter=userName%20eq%20%22jane.doe@acme.test%22',
      headers: { Authorization: 'Bearer ghp_live_R4nd0mT0kenValue0123456789ABCdef' },
      data: '{"password":"Sup3rS3cretBindPw!","userName":"jane.doe@acme.test"}',
    },
    response: { status: 401, data: { client_secret: 'client-secret-9f8e7d6c5b4a' } },
  });
}

function ldapBindError(): Error {
  return Object.assign(
    new Error('bind as CN=Jane Doe,OU=Staff,DC=acme,DC=test failed: password=Sup3rS3cretBindPw!'),
    {
      name: 'InvalidCredentialsError',
      code: 49,
      dn: 'CN=Jane Doe,OU=Staff,DC=acme,DC=test',
      bindPassword: 'Sup3rS3cretBindPw!',
    },
  );
}

describe('application logger redaction', () => {
  it('writes no secret or personal value from connector, LDAP and unhandled errors', async () => {
    const { app, lines } = await appWithCollector();
    app.post('/test/boom', async () => {
      throw connectorError();
    });
    app.post('/test/ldap', async (request) => {
      request.log.error({ err: ldapBindError(), sourceId: '4b6f0c52-3f4e-4b0c-9a55-1f0d9a2c7e11' }, 'directory sync failed');
      request.log.warn(
        {
          person: { displayName: 'Jane Doe', email: 'jane.doe@acme.test' },
          mfa: { totpSecret: 'JBSWY3DPEHPK3PXP', recoveryCodes: ['RC-1111-2222-3333'] },
          vault: { plaintext: 'vault-plaintext-value' },
          headers: { authorization: 'Bearer ghp_live_R4nd0mT0kenValue0123456789ABCdef', cookie: 'syntra_session=abc123cookievalue' },
        },
        'context object with everything in it',
      );
      // The message string itself, interpolating an error's text.
      request.log.error(`upstream said: ${connectorError().message} for jane.doe@acme.test`);
      return { ok: true };
    });
    await app.ready();

    const boom = await app.inject({
      method: 'POST',
      url: '/test/boom?state=secret-state',
      headers: {
        host: TEST_HOST,
        authorization: 'Bearer ghp_live_R4nd0mT0kenValue0123456789ABCdef',
        cookie: 'syntra_session=abc123cookievalue',
      },
      payload: { password: 'Sup3rS3cretBindPw!' },
    });
    expect(boom.statusCode).toBe(500);
    const ldap = await app.inject({ method: 'POST', url: '/test/ldap', headers: { host: TEST_HOST }, payload: {} });
    expect(ldap.statusCode).toBe(200);

    const logs = lines.join('');
    for (const planted of PLANTED) expect(logs, planted).not.toContain(planted);

    // Still diagnosable: the type, the code, the host and the status survive.
    const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const unhandled = parsed.find((line) => line.msg === 'unhandled error');
    expect(unhandled?.err).toMatchObject({
      type: 'AxiosError',
      code: 'ERR_BAD_REQUEST',
      config: { method: 'post', url: 'https://scim.example.test/Users' },
      response: { status: 401 },
    });
    const sync = parsed.find((line) => line.msg === 'directory sync failed');
    expect(sync?.err).toMatchObject({ type: 'InvalidCredentialsError', code: 49 });
    expect(String((sync?.err as { message?: unknown }).message)).toContain('DC=acme,DC=test');
    expect(sync?.sourceId).toBe('4b6f0c52-3f4e-4b0c-9a55-1f0d9a2c7e11');
  });

  it('stamps every line of a request with the correlation id it returns', async () => {
    const { app, lines } = await appWithCollector();
    let seen: string | undefined;
    // A POST with a body, deliberately: body parsing is where an async context
    // entered too early is lost.
    app.post('/test/correlated', async (request) => {
      seen = request.correlationId;
      request.log.info('inside the handler');
      return { ok: true };
    });
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/test/correlated',
      headers: { host: TEST_HOST },
      payload: { some: 'body' },
    });
    const header = response.headers['x-correlation-id'];
    expect(header).toMatch(/^[0-9a-f]{32}$/);
    expect(seen).toBe(header);
    const inside = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.msg === 'inside the handler');
    expect(inside?.correlationId).toBe(header);
  });

  it('ignores an incoming traceparent while tracing is off', async () => {
    const { app } = await appWithCollector();
    await app.ready();
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' },
    });
    expect(response.headers['x-correlation-id']).toMatch(/^[0-9a-f]{32}$/);
    expect(response.headers['x-correlation-id']).not.toBe('0af7651916cd43dd8448eb211c80319c');
  });
});
