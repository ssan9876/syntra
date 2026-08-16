import { beforeEach, describe, expect, it } from 'vitest';
import * as client from 'openid-client';
import { prisma, withTenant } from '@syntra/db';
import {
  addRule,
  assignApplication,
  createApplication,
  createClaimMapping,
  createUser,
  hashPassword,
  setPasswordHash,
  upsertOidcClient,
} from '@syntra/core';
import { buildTestApp, TEST_HOST } from '../test-support.js';

const PASSWORD = 'correct horse battery staple';
const PASSWORD_HASH = await hashPassword(PASSWORD);
const REDIRECT = 'https://crm.acme.test/cb';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
let userId: string;
let applicationId: string;
let clientSecret: string;
let cookie: string;

/**
 * openid-client speaks fetch; the app under test speaks app.inject. This is the
 * bridge, and it is deliberately faithful: it does not follow redirects, it
 * preserves the status, and it carries every header both ways. A shim that
 * quietly followed a 302 would hide the very hop this suite is about.
 */
const injectFetch = (): client.CustomFetch => async (resource, options) => {
  const url = new URL(resource);
  const res = await ctx.app.inject({
    method: (options.method ?? 'GET') as 'GET',
    url: url.pathname + url.search,
    headers: { host: TEST_HOST, ...options.headers },
    ...(options.body ? { payload: String(options.body) } : {}),
  });
  const headers = new Headers();
  for (const [name, value] of Object.entries(res.headers)) {
    if (value === undefined) continue;
    // `content-length` is recomputed from the body below, and a stale one
    // truncates. Everything else is carried through.
    if (name === 'content-length' || name === 'transfer-encoding') continue;
    for (const one of Array.isArray(value) ? value : [value]) {
      headers.append(name, String(one));
    }
  }
  return new Response(new Uint8Array(res.rawPayload), {
    status: res.statusCode,
    headers,
  });
};

/**
 * The browser's cookie jar, paths and all.
 *
 * Not a convenience. `oidc-provider` carries the whole flow in cookies it sets
 * itself — `_interaction` names the interaction the route resolves,
 * `_interaction_resume` names the request to resume, `_session` is the session
 * this file's control is about — so a walk that dropped them between hops
 * could not reach a code at all. Worse, it would make CONTROL 1 vacuous: the
 * second authorization request would arrive with no `_session` for
 * oidc-provider to answer out of, and the assertion would hold with
 * `syntraAuthorizePrompt` deleted.
 *
 * Paths are honoured because `_interaction` is scoped to one interaction's own
 * URL. A jar keyed on name alone would send the first flow's interaction id to
 * the second flow's interaction URL, and Koa reads the first match.
 */
interface JarEntry {
  name: string;
  value: string;
  path: string;
}
let jar: JarEntry[] = [];

const rememberCookies = (
  cookies: { name: string; value: string; path?: string | undefined; expires?: Date | undefined }[],
) => {
  for (const set of cookies) {
    const path = set.path ?? '/';
    jar = jar.filter((entry) => !(entry.name === set.name && entry.path === path));
    const expired = set.expires !== undefined && set.expires.getTime() <= Date.now();
    if (set.value === '' || expired) continue;
    jar.push({ name: set.name, value: set.value, path });
  }
};

/** RFC 6265 section 5.1.4, longest match first — the order Koa reads. */
const cookieHeaderFor = (path: string, withSession: boolean): string => {
  const matches = jar
    .filter(
      (entry) =>
        entry.path === path ||
        (path.startsWith(entry.path) &&
          (entry.path.endsWith('/') || path[entry.path.length] === '/')),
    )
    .sort((a, b) => b.path.length - a.path.length)
    .map((entry) => `${entry.name}=${entry.value}`);
  if (withSession) matches.unshift(`syntra_session=${cookie}`);
  return matches.join('; ');
};

beforeEach(async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();
  await prisma.tenant.update({
    where: { id: ctx.tenantId },
    data: { primaryDomain: TEST_HOST },
  });
  jar = [];

  ({ userId, applicationId, clientSecret } = await withTenant(ctx.tenantId, async (tx) => {
    const user = await createUser(tx, { login: 'jdoe', email: 'j@acme.test', displayName: 'J Doe' });
    await setPasswordHash(tx, user.id, PASSWORD_HASH);
    const application = await createApplication(tx, { name: 'CRM', slug: 'crm', type: 'oidc' });
    await assignApplication(tx, application.id, { type: 'user', id: user.id });
    const { clientSecret: secret } = await upsertOidcClient(tx, application.id, {
      clientId: 'crm',
      redirectUris: [REDIRECT],
      postLogoutRedirectUris: ['https://crm.acme.test/bye'],
      grantTypes: ['authorization_code', 'refresh_token'],
      scopes: ['openid', 'profile', 'email'],
      requirePkce: true,
      clientCredentialsEnabled: false,
      tokenEndpointAuthMethod: 'client_secret_basic',
      idTokenSignedResponseAlg: 'RS256',
      accessTokenTtlSeconds: 3600,
      refreshTokenTtlSeconds: 1209600,
    });
    await createClaimMapping(tx, application.id, {
      protocol: 'oidc', claimName: 'email', nameFormat: '',
      sourceKind: 'user', sourceField: 'email', contractStrategy: 'primary',
      literalValue: null, releaseScope: 'email', multiValued: false,
    });
    return { userId: user.id, applicationId: application.id, clientSecret: secret! };
  }));

  const login = await ctx.app.inject({
    method: 'POST', url: '/api/auth/login',
    headers: { host: TEST_HOST },
    payload: { login: 'jdoe', password: PASSWORD },
  });
  cookie = login.cookies.find((c) => c.name === 'syntra_session')!.value;
});

/** Discovery through the shim. Task 12 copies this helper verbatim. */
const discover = (id = 'crm', secret?: string) =>
  client.discovery(
    new URL(`http://${TEST_HOST}/oidc`),
    id,
    secret ?? clientSecret,
    undefined,
    { [client.customFetch]: injectFetch(), execute: [client.allowInsecureRequests] },
  );

/**
 * Walks the authorization request the way a browser would, with the cookies.
 *
 * It stops on the registered redirect URI, and on any Syntra screen — the
 * login, MFA and enrolment screens are the web app's, not this app's, so a
 * walk that followed them would report a 404 and say nothing about the hop it
 * was actually asserting.
 */
const SCREENS = ['/login', '/mfa', '/enrol'];

const walk = async (url: URL, withCookie = true) => {
  let current = url;
  for (let hop = 0; hop < 8; hop += 1) {
    const res = await ctx.app.inject({
      method: 'GET',
      url: current.pathname + current.search,
      headers: {
        host: TEST_HOST,
        cookie: cookieHeaderFor(current.pathname, withCookie),
      },
    });
    rememberCookies(res.cookies);
    if (res.statusCode !== 302 && res.statusCode !== 303) return { res, url: current };
    const location = res.headers.location as string;
    if (location.startsWith(REDIRECT)) return { res, url: new URL(location) };
    if (SCREENS.some((screen) => location.startsWith(screen))) {
      return { res, url: new URL(location, `http://${TEST_HOST}`) };
    }
    current = new URL(location, `http://${TEST_HOST}`);
  }
  throw new Error('too many redirects');
};

const authUrlWithPkce = async (config: client.Configuration) => {
  const verifier = client.randomPKCECodeVerifier();
  const state = client.randomState();
  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: REDIRECT, scope: 'openid email', state,
    code_challenge: await client.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
  });
  return { url, verifier, state };
};

describe('OIDC discovery and JWKS', () => {
  it('publishes a discovery document whose endpoints keep the /oidc mount prefix', async () => {
    const config = await discover();
    const meta = config.serverMetadata();
    expect(meta.issuer).toBe(`http://${TEST_HOST}/oidc`);
    // The mount adaptation: strip the prefix from the path oidc-provider
    // routes on, keep it on the URLs it advertises. Getting only half of it
    // right publishes `http://host/token` and every relying party breaks.
    expect(meta.authorization_endpoint).toBe(`http://${TEST_HOST}/oidc/auth`);
    expect(meta.token_endpoint).toBe(`http://${TEST_HOST}/oidc/token`);
    expect(meta.jwks_uri).toBe(`http://${TEST_HOST}/oidc/jwks`);
    expect(meta.end_session_endpoint).toBe(`http://${TEST_HOST}/oidc/session/end`);
    expect(meta.code_challenge_methods_supported).toContain('S256');
    expect(meta.id_token_signing_alg_values_supported).toEqual(['RS256']);
  });

  it('publishes the outgoing key alongside the incoming one during a rollover, and no private material', async () => {
    const { rotateKey, localMasterKeyProvider } = await import('@syntra/core');
    const before = await ctx.app.inject({
      method: 'GET', url: '/oidc/jwks', headers: { host: TEST_HOST },
    });
    expect(JSON.parse(before.body).keys).toHaveLength(1);

    await rotateKey(ctx.tenantId, localMasterKeyProvider(Buffer.alloc(32, 7)), 'oidc', {
      overlapMs: 60_000,
    });
    const after = await ctx.app.inject({
      method: 'GET', url: '/oidc/jwks', headers: { host: TEST_HOST },
    });
    const keys = JSON.parse(after.body).keys;
    expect(keys).toHaveLength(2);
    for (const key of keys) {
      expect(key.d).toBeUndefined();
      expect(key.p).toBeUndefined();
      expect(key.q).toBeUndefined();
    }
  });

  it('refuses a discovery request that arrived on a sibling of the tenant host', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/oidc/.well-known/openid-configuration',
      headers: { host: `${TEST_HOST}.attacker.example` },
    });
    expect(res.statusCode).toBe(421);
  });
});

describe('the authorization endpoint', () => {
  it('refuses an authorization request with no PKCE challenge at all', async () => {
    const config = await discover();
    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: REDIRECT, scope: 'openid', state: client.randomState(),
    });
    const { url: landed } = await walk(url);
    // Refused at the authorization endpoint, so the error comes back on the
    // registered redirect URI rather than as a code.
    expect(landed.searchParams.get('code')).toBeNull();
    expect(landed.searchParams.get('error')).toBe('invalid_request');
  });

  it('refuses a redirect URI that is not exactly one of the registered ones', async () => {
    const config = await discover();
    for (const bad of [
      'https://crm.acme.test/cb/',
      'https://crm.acme.test/cb/../evil',
      'https://crm.acme.test/cbX',
      'https://crm.acme.test.attacker.example/cb',
      'https://crm.acme.test/CB',
    ]) {
      const url = client.buildAuthorizationUrl(config, {
        redirect_uri: bad, scope: 'openid', state: client.randomState(),
        code_challenge: 'x'.repeat(43), code_challenge_method: 'S256',
      });
      const res = await ctx.app.inject({
        method: 'GET', url: url.pathname + url.search,
        headers: { host: TEST_HOST, cookie: `syntra_session=${cookie}` },
      });
      // Never a redirect to the unregistered URI: an unregistered redirect
      // target is answered in place, so it cannot be used as an open redirect.
      expect(res.statusCode).not.toBe(302);
      expect(res.headers.location ?? '').not.toContain(bad);
    }
  });

  it('sends an unauthenticated caller to the login screen and issues no code', async () => {
    const config = await discover();
    const { url } = await authUrlWithPkce(config);
    const { res, url: landed } = await walk(url, false);
    // The login screen belongs to the web app, so the assertion is the hop
    // itself: the interaction route sent the browser there, carrying the
    // interaction to come back to, and nothing went to the redirect URI.
    expect(res.statusCode).toBe(302);
    expect(landed.pathname).toBe('/login');
    expect(landed.searchParams.get('next')).toMatch(/^\/oidc\/interaction\//);
    expect(res.headers.location ?? '').not.toContain(REDIRECT);
  });

  it('issues nothing for an application the user is not assigned', async () => {
    await withTenant(ctx.tenantId, async (tx) => {
      const rows = await tx.appAssignment.findMany({ where: { applicationId } });
      await tx.appAssignment.deleteMany({ where: { id: rows[0]!.id } });
    });
    const config = await discover();
    const { url } = await authUrlWithPkce(config);
    const { res } = await walk(url);
    expect(res.statusCode).toBe(403);
  });
});

describe('the chokepoint holds on every authorization request, not only the first', () => {
  it('CONTROL 1 — a rule added between two launches applies to the second', async () => {
    // The bypass this pins: oidc-provider keeps its own session cookie, and its
    // built-in login prompt would answer the second request out of that session
    // without ever re-entering Syntra. Syntra evaluates policy per application,
    // so a rule added between two launches must apply to the second.
    const config = await discover();
    const flow = async () => walk((await authUrlWithPkce(config)).url);

    const first = await flow();
    expect(first.url.searchParams.get('code')).toBeTruthy();

    await withTenant(ctx.tenantId, (tx) =>
      addRule(tx, { name: 'no crm', outcome: 'deny', applicationIds: [applicationId] }),
    );

    const second = await flow();
    expect(second.url.searchParams.get('code')).toBeNull();
    expect(second.res.statusCode).toBe(403);
  });

  it('records one decision per resolved interaction, for the right user and client', async () => {
    // The row Task 12's token endpoint independently requires. Asserted here
    // because this is the task that writes it: if the interaction route stops
    // writing it, that is this task's failure and not Task 12's.
    const config = await discover();
    const { url } = await authUrlWithPkce(config);
    const { url: landed } = await walk(url);
    expect(landed.searchParams.get('code')).toBeTruthy();

    // Through withTenant, because AuthorizationDecision is FORCE ROW LEVEL
    // SECURITY: a bare `prisma.authorizationDecision.findMany()` matches no
    // rows whatever the route wrote.
    const rows = await withTenant(ctx.tenantId, (tx) =>
      tx.authorizationDecision.findMany(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(userId);
    expect(rows[0]!.clientId).toBe('crm');
    expect(rows[0]!.consumedAt).toBeNull();
    // Its lifetime is the authorization code's, not longer. A decision that
    // outlived its code would be spendable by a code obtained another way.
    const { AUTHORIZATION_CODE_TTL_SECONDS } = await import('@syntra/core');
    const lifetimeMs = rows[0]!.expiresAt.getTime() - rows[0]!.createdAt.getTime();
    expect(Math.round(lifetimeMs / 1000)).toBe(AUTHORIZATION_CODE_TTL_SECONDS);
  });

  it('records no decision when policy denies', async () => {
    await withTenant(ctx.tenantId, (tx) =>
      addRule(tx, { name: 'no crm', outcome: 'deny', applicationIds: [applicationId] }),
    );
    const config = await discover();
    const { url } = await authUrlWithPkce(config);
    await walk(url);
    // Again through withTenant. Outside it this count is 0 whatever happened,
    // so the assertion would hold with the whole route deleted.
    const count = await withTenant(ctx.tenantId, (tx) =>
      tx.authorizationDecision.count(),
    );
    expect(count).toBe(0);
  });
});
