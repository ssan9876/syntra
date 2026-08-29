import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLocalJWKSet, decodeJwt, jwtVerify } from 'jose';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { createUser } from '../directory/user-service.js';
import { createApplication } from './application-service.js';
import { upsertOidcClient } from './oidc-client-service.js';
import { ensureActiveKey, publishedKeys } from '../keys/signing-key-service.js';
import { localMasterKeyProvider } from '../vault/master-key.js';
import { WEBHOOK_MAX_ATTEMPTS } from '../notify/webhook-retry.js';
import { enqueueLogoutDeliveries, runLogoutDeliveryJob } from './logout-delivery.js';

const PUBLIC_URL = 'https://acme.test';
/** A real uuid: `LogoutDelivery.sessionId` is a uuid column, as sessions are. */
const SESSION_ID = '11111111-2222-4333-8444-555555555555';
const ISSUER = 'https://acme.test/oidc';
const provider = localMasterKeyProvider(Buffer.alloc(32, 7));

let tenantId: string;
let userId: string;

/**
 * A real relying party over HTTP, not a mock.
 *
 * What is being tested is that a signed token ARRIVES and VERIFIES. A stubbed
 * poster proves the code called something; it cannot prove the bytes on the
 * wire are a JWT a relying party would accept, which is the only thing a
 * relying party cares about.
 */
interface FakeRp {
  url: string;
  bodies: string[];
  close: () => Promise<void>;
}

async function listenAs(respond: () => number): Promise<FakeRp> {
  const bodies: string[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      bodies.push(body);
      res.statusCode = respond();
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/backchannel-logout`,
    bodies,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

let rp: FakeRp | null = null;

/** A client that asked to hear about logouts, and a grant the user holds. */
async function seedClient(
  backchannelLogoutUri: string | null,
  over: { clientId?: string; sessionRequired?: boolean } = {},
) {
  const clientId = over.clientId ?? 'crm';
  return withTenant(tenantId, async (tx) => {
    const application = await createApplication(tx, {
      name: `App ${clientId}`,
      slug: `app-${clientId}`,
    });
    await upsertOidcClient(tx, application.id, {
      clientId,
      redirectUris: ['https://rp.acme.test/cb'],
      postLogoutRedirectUris: [],
      grantTypes: ['authorization_code', 'refresh_token'],
      scopes: ['openid'],
      requirePkce: true,
      clientCredentialsEnabled: false,
      tokenEndpointAuthMethod: 'client_secret_basic',
      idTokenSignedResponseAlg: 'RS256',
      accessTokenTtlSeconds: 3600,
      refreshTokenTtlSeconds: 1_209_600,
      ...(backchannelLogoutUri === null ? {} : { backchannelLogoutUri }),
      ...(over.sessionRequired ? { backchannelLogoutSessionRequired: true } : {}),
    });
    return clientId;
  });
}

/** The artifact that says this user holds a live grant with that client. */
async function seedGrant(clientId: string) {
  await withTenant(tenantId, (tx) =>
    tx.oidcArtifact.create({
      data: {
        tenantId,
        model: 'Grant',
        artifactId: `grant-${clientId}`,
        accountId: userId,
        grantId: `grant-${clientId}`,
        payload: { clientId, accountId: userId },
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    }),
  );
}

const enqueue = (sessionId: string | null = null) =>
  withTenant(tenantId, (tx) =>
    enqueueLogoutDeliveries(tx, tenantId, { userId, sessionId }),
  );

beforeEach(async () => {
  await resetDatabase();
  const tenant = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = tenant.id;
  const user = await withTenant(tenantId, (tx) =>
    createUser(tx, { login: 'jdoe', email: 'j@acme.test', displayName: 'J Doe' }),
  );
  userId = user.id;
  await ensureActiveKey(tenantId, provider, 'oidc');
});

afterEach(async () => {
  await rp?.close();
  rp = null;
});

describe('enqueueLogoutDeliveries', () => {
  it('queues one delivery per client that asked and holds a grant', async () => {
    await seedClient('https://a.test/logout', { clientId: 'a' });
    await seedGrant('a');
    // Asked, but this person never signed into it.
    await seedClient('https://b.test/logout', { clientId: 'b' });
    // Holds a grant, but never asked to be told.
    await seedClient(null, { clientId: 'c' });
    await seedGrant('c');

    expect(await enqueue()).toBe(1);

    const rows = await withTenant(tenantId, (tx) => tx.logoutDelivery.findMany());
    expect(rows).toHaveLength(1);
  });

  it('queues nothing when no client asked', async () => {
    await seedClient(null);
    await seedGrant('crm');

    expect(await enqueue()).toBe(0);
  });

  it('records who signed out, not a token saying so', async () => {
    // Minting is the sender's job: it needs the issuer and the signing key,
    // and the callers that end sessions have neither. A row is a subject and
    // a destination.
    await seedClient('https://a.test/logout', { clientId: 'a' });
    await seedGrant('a');

    await enqueue(SESSION_ID);

    const row = await withTenant(tenantId, (tx) => tx.logoutDelivery.findFirstOrThrow());
    expect(row.userId).toBe(userId);
    expect(row.sessionId).toBe(SESSION_ID);
    expect(row).not.toHaveProperty('token');
  });

  it('records no session when every session ended at once', async () => {
    await seedClient('https://a.test/logout', { clientId: 'a' });
    await seedGrant('a');

    await enqueue(null);

    const row = await withTenant(tenantId, (tx) => tx.logoutDelivery.findFirstOrThrow());
    expect(row.sessionId).toBeNull();
  });
});

describe('runLogoutDeliveryJob', () => {
  it('POSTs a verifiable logout token and marks the delivery done', async () => {
    rp = await listenAs(() => 200);
    await seedClient(rp.url, { clientId: 'a' });
    await seedGrant('a');
    await enqueue();

    const result = await runLogoutDeliveryJob(tenantId, provider, { publicUrl: PUBLIC_URL, allowPrivateAddresses: true });

    expect(result).toEqual({ delivered: 1, failed: 0 });
    expect(rp.bodies).toHaveLength(1);

    // The bytes on the wire, verified the way a relying party would.
    const token = new URLSearchParams(rp.bodies[0]!).get('logout_token')!;
    const keys = await publishedKeys(tenantId, 'oidc');
    await expect(
      jwtVerify(token, createLocalJWKSet({ keys: keys.map((k) => k.publicJwk) as never }), {
        issuer: ISSUER,
        audience: 'a',
      }),
    ).resolves.toBeTruthy();

    const row = await withTenant(tenantId, (tx) => tx.logoutDelivery.findFirstOrThrow());
    expect(row.deliveredAt).not.toBeNull();
    expect(row.lastStatus).toBe(200);
  });

  it('carries sid on the wire only for a client that registered for it', async () => {
    rp = await listenAs(() => 200);
    await seedClient(rp.url, { clientId: 'a', sessionRequired: true });
    await seedGrant('a');
    await enqueue(SESSION_ID);
    await runLogoutDeliveryJob(tenantId, provider, {
      publicUrl: PUBLIC_URL,
      allowPrivateAddresses: true,
    });

    const token = new URLSearchParams(rp.bodies[0]!).get('logout_token')!;
    expect(decodeJwt(token).sid).toBe(SESSION_ID);
  });

  it('omits sid for a client that did not register for it', async () => {
    rp = await listenAs(() => 200);
    await seedClient(rp.url, { clientId: 'b' });
    await seedGrant('b');
    await enqueue(SESSION_ID);
    await runLogoutDeliveryJob(tenantId, provider, {
      publicUrl: PUBLIC_URL,
      allowPrivateAddresses: true,
    });

    const token = new URLSearchParams(rp.bodies[0]!).get('logout_token')!;
    expect(decodeJwt(token)).not.toHaveProperty('sid');
  });

  it('retries a 500 on the ladder', async () => {
    rp = await listenAs(() => 500);
    await seedClient(rp.url, { clientId: 'a' });
    await seedGrant('a');
    await enqueue();

    const now = new Date();
    const result = await runLogoutDeliveryJob(tenantId, provider, { publicUrl: PUBLIC_URL,
      allowPrivateAddresses: true,
      now,
    });

    expect(result).toEqual({ delivered: 0, failed: 1 });
    const row = await withTenant(tenantId, (tx) => tx.logoutDelivery.findFirstOrThrow());
    expect(row.deliveredAt).toBeNull();
    expect(row.attempts).toBe(1);
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(now.getTime());
  });

  it('does not retry a 400, and spends the row at once', async () => {
    // Retrying a 400 five times over seven hours does not make the receiver
    // understand the request any better.
    rp = await listenAs(() => 400);
    await seedClient(rp.url, { clientId: 'a' });
    await seedGrant('a');
    await enqueue();

    await runLogoutDeliveryJob(tenantId, provider, { publicUrl: PUBLIC_URL, allowPrivateAddresses: true });

    const row = await withTenant(tenantId, (tx) => tx.logoutDelivery.findFirstOrThrow());
    expect(row.attempts).toBe(WEBHOOK_MAX_ATTEMPTS);
    expect(row.lastStatus).toBe(400);
  });

  it('keeps a spent delivery as evidence rather than deleting it', async () => {
    // The reason back-channel beats the front-channel version: a failure is a
    // row somebody can look at, not a silent gap in an offboarding.
    rp = await listenAs(() => 400);
    await seedClient(rp.url, { clientId: 'a' });
    await seedGrant('a');
    await enqueue();
    await runLogoutDeliveryJob(tenantId, provider, { publicUrl: PUBLIC_URL, allowPrivateAddresses: true });

    // A second run must not pick it up again.
    const second = await runLogoutDeliveryJob(tenantId, provider, { publicUrl: PUBLIC_URL, allowPrivateAddresses: true });

    expect(second).toEqual({ delivered: 0, failed: 0 });
    expect(await withTenant(tenantId, (tx) => tx.logoutDelivery.count())).toBe(1);
  });

  it('refuses a private address when the guard is on, and records why', async () => {
    rp = await listenAs(() => 200);
    await seedClient(rp.url, { clientId: 'a' });
    await seedGrant('a');
    await enqueue();

    const result = await runLogoutDeliveryJob(tenantId, provider, { publicUrl: PUBLIC_URL, allowPrivateAddresses: false });

    expect(result).toEqual({ delivered: 0, failed: 1 });
    expect(rp.bodies).toHaveLength(0);
    const row = await withTenant(tenantId, (tx) => tx.logoutDelivery.findFirstOrThrow());
    expect(row.lastError).toBeTruthy();
  });

  it('does not deliver another tenants queued logout', async () => {
    rp = await listenAs(() => 200);
    await seedClient(rp.url, { clientId: 'a' });
    await seedGrant('a');
    await enqueue();

    const other = await prisma.tenant.create({ data: { name: 'Other', slug: 'other' } });
    const result = await runLogoutDeliveryJob(other.id, provider, { publicUrl: PUBLIC_URL, allowPrivateAddresses: true });

    expect(result).toEqual({ delivered: 0, failed: 0 });
    expect(rp.bodies).toHaveLength(0);
  });
});
