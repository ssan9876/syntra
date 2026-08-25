import { beforeEach, describe, expect, it } from 'vitest';
import * as client from 'openid-client';
import { prisma, withTenant } from '@syntra/db';
import {
  assignApplication,
  createApplication,
  createClaimMapping,
  createUser,
  hashPassword,
  setPasswordHash,
  upsertOidcClient,
} from '@syntra/core';
import { buildTestApp, TEST_HOST } from '../test-support.js';
import { PROVIDER_CLIENT_SECRET } from './oidc-op.js';

const PASSWORD = 'correct horse battery staple';
const PASSWORD_HASH = await hashPassword(PASSWORD);
const REDIRECT = 'https://crm.acme.test/cb';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
let userId: string;
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
 * Copied verbatim from `oidc-authorize.test.ts`, along with `injectFetch`,
 * `discover`, `walk` and `authUrlWithPkce`: those helpers close over that
 * file's module-level `ctx`, `cookie` and `clientSecret`, so they are not
 * importable and sharing them would mean sharing mutable test state.
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
  cookies: {
    name: string;
    value: string;
    path?: string | undefined;
    expires?: Date | undefined;
  }[],
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

  ({ userId, clientSecret } = await withTenant(ctx.tenantId, async (tx) => {
    const user = await createUser(tx, {
      login: 'jdoe',
      email: 'j@acme.test',
      displayName: 'J Doe',
    });
    await setPasswordHash(tx, user.id, PASSWORD_HASH);
    const application = await createApplication(tx, {
      name: 'CRM',
      slug: 'crm',
      type: 'oidc',
    });
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
      protocol: 'oidc',
      claimName: 'email',
      nameFormat: '',
      sourceKind: 'user',
      sourceField: 'email',
      contractStrategy: 'primary',
      literalValue: null,
      releaseScope: 'email',
      multiValued: false,
    });
    return { userId: user.id, clientSecret: secret! };
  }));

  const login = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { host: TEST_HOST },
    payload: { login: 'jdoe', password: PASSWORD },
  });
  cookie = login.cookies.find((c) => c.name === 'syntra_session')!.value;
});

/** Discovery through the shim. */
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
 * login, MFA and enrolment screens are the web app's, not this app's.
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
    redirect_uri: REDIRECT,
    scope: 'openid email',
    state,
    code_challenge: await client.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
  });
  return { url, verifier, state };
};

/**
 * The properties an authorization code is minted with.
 *
 * Cast at each construction because `@types/oidc-provider` 9.11.1 declares
 * `client` and `gty` as required on the `AuthorizationCode` constructor, while
 * the library itself passes no `gty` at all
 * (`lib/helpers/process_response_types.js:78`). Widening the payload to satisfy
 * the typings would mint a code that differs from a real one, and "a genuine
 * code" is the entire premise of the CONTROL 2 case below. The contract block
 * proves the round trip instead: what goes in comes back out of `find`.
 */
type CodeProperties = Record<string, unknown>;

describe('the authorization code exchange', () => {
  it('completes the code flow with PKCE and returns claims from the mapping', async () => {
    const config = await discover();
    const { url, verifier, state } = await authUrlWithPkce(config);
    const { url: landed } = await walk(url);
    expect(landed.searchParams.get('code')).toBeTruthy();

    const tokens = await client.authorizationCodeGrant(config, landed, {
      pkceCodeVerifier: verifier,
      expectedState: state,
    });
    expect(tokens.access_token).toBeTruthy();
    const idClaims = tokens.claims()!;
    expect(idClaims.sub).toBe(userId);
    expect(idClaims.aud).toBe('crm');
    expect(idClaims.iss).toBe(`http://${TEST_HOST}/oidc`);
    expect((idClaims as Record<string, unknown>).email).toBe('j@acme.test');
  });

  it('refuses the token exchange when the PKCE verifier does not match', async () => {
    const config = await discover();
    const { url, state } = await authUrlWithPkce(config);
    const { url: landed } = await walk(url);
    await expect(
      client.authorizationCodeGrant(config, landed, {
        pkceCodeVerifier: client.randomPKCECodeVerifier(),
        expectedState: state,
      }),
    ).rejects.toThrow();
  });

  it('refuses the token exchange with the wrong client secret', async () => {
    const config = await discover();
    const { url, verifier, state } = await authUrlWithPkce(config);
    const { url: landed } = await walk(url);
    const wrong = await discover('crm', 'not-the-secret');
    await expect(
      client.authorizationCodeGrant(wrong, landed, {
        pkceCodeVerifier: verifier,
        expectedState: state,
      }),
    ).rejects.toThrow();
  });
});

/**
 * The library contract Control 2 rests on.
 *
 * Ruling A2-7 accepted the dependency on `provider.AuthorizationCode.find` —
 * public API, verified round trip, version pinned exactly — on the condition
 * that it fail loudly and specifically if the library stops returning what it
 * returns today. A pinned dependency that breaks quietly on upgrade is how a
 * control disappears between releases, and without this the symptom would be
 * the security test below failing with a bare "expected 400, got 200".
 */
describe('the oidc-provider model API Control 2 depends on', () => {
  const CONTRACT = [
    'CONTRACT BROKEN: oidc-provider AuthorizationCode.find no longer behaves as',
    'apps/api/src/routes/oidc-token.ts assumes. That function is the second of the',
    'two controls behind the spec section 7 chokepoint: without it the token',
    'endpoint cannot tell which user and client a code belongs to, and therefore',
    'cannot require an AuthorizationDecision before issuing a token.',
    'Do NOT relax this test. Either adapt oidc-token.ts to the new behaviour and',
    'update this contract, or pin oidc-provider back to the version below.',
  ].join(' ');

  it('returns the stored accountId, clientId and grantId for a code it just minted', async () => {
    await discover(); // builds and caches the Provider this tenant is served from
    const provider = await providerForCached(ctx.tenantId);

    const grant = new provider.Grant({ clientId: 'crm', accountId: userId });
    grant.addOIDCScope('openid');
    const grantId = await grant.save();

    const verifier = client.randomPKCECodeVerifier();
    const code = new provider.AuthorizationCode({
      accountId: userId,
      clientId: 'crm',
      grantId,
      redirectUri: REDIRECT,
      scope: 'openid',
      codeChallenge: await client.calculatePKCECodeChallenge(verifier),
      codeChallengeMethod: 'S256',
    } satisfies CodeProperties as never);
    const value = await code.save();

    const found = await provider.AuthorizationCode.find(value);
    expect(found, CONTRACT).toBeTruthy();
    expect(found!.accountId, CONTRACT).toBe(userId);
    expect(found!.clientId, CONTRACT).toBe('crm');
    expect(found!.grantId, CONTRACT).toBe(grantId);
    // Falsy on a live code is what lets the check know it has not been spent.
    // Read through a cast because @types/oidc-provider 9.11.1 omits `consumed`
    // from `AuthorizationCode` — it is on the instance at runtime, put there by
    // `lib/models/mixins/consumable.js`'s IN_PAYLOAD, and `oidc-token.ts`
    // narrows the same three fields for the same reason.
    expect((found as unknown as { consumed?: unknown }).consumed, CONTRACT).toBeFalsy();
  });

  it('returns undefined for an unknown code rather than throwing', async () => {
    // The token endpoint steps aside for an unknown or spent code so that
    // oidc-provider's own replay detection can revoke the grant. A throw here
    // would turn that into a 500 and lose the revocation.
    await discover();
    const provider = await providerForCached(ctx.tenantId);
    await expect(
      provider.AuthorizationCode.find('not-a-real-code'),
    ).resolves.toBeUndefined();
  });

  it('is still the exact version this contract was verified against', async () => {
    const { createRequire } = await import('node:module');
    const pkg = createRequire(import.meta.url)('oidc-provider/package.json') as {
      version: string;
    };
    // Named separately from the behaviour cases so an upgrade reads as "the
    // pin moved" rather than as a mysterious behavioural failure.
    expect(pkg.version, CONTRACT).toBe('9.11.3');
  });

  it('authenticates a client against the placeholder secret the provider was given', async () => {
    // The other half of the same contract, and the reason `oidc-token.ts`
    // substitutes. oidc-provider authenticates the client itself, against the
    // `client_secret` in the metadata `loadClients` handed it — a placeholder,
    // because Syntra holds only a hash of the real secret. If the library ever
    // stopped comparing that field, or Syntra stopped substituting, the
    // placeholder would reach a comparison against the real secret and every
    // token exchange would fail with `invalid_client`.
    await discover();
    const provider = await providerForCached(ctx.tenantId);
    const registered = await provider.Client.find('crm');
    expect(registered, CONTRACT).toBeTruthy();
    expect(await registered!.compareClientSecret(PROVIDER_CLIENT_SECRET), CONTRACT).toBe(
      true,
    );
    expect(await registered!.compareClientSecret(clientSecret), CONTRACT).toBe(false);
  });
});

describe('CONTROL 2 — the token endpoint requires a decision from authorize()', () => {
  it('CONTROL 2 — a code minted with no interaction at all is refused at the token endpoint', async () => {
    // What deleting `syntraAuthorizePrompt` would produce: a genuine, valid,
    // oidc-provider-minted authorization code for a real user and a real
    // client, with no Syntra decision behind it. Rather than editing the
    // source, this mints exactly that code through the provider's own model
    // API — the strongest form of "the prompt is gone".
    //
    // `providerFor` returns the cached instance for a tenant and ignores its
    // deps on a cache hit, so this is the same Provider the app is serving
    // from. The discovery call above is what put it in the cache.
    const config = await discover();
    void config;
    const provider = await providerForCached(ctx.tenantId);

    const grant = new provider.Grant({ clientId: 'crm', accountId: userId });
    grant.addOIDCScope('openid');
    const grantId = await grant.save();

    const verifier = client.randomPKCECodeVerifier();
    const code = new provider.AuthorizationCode({
      accountId: userId,
      clientId: 'crm',
      grantId,
      redirectUri: REDIRECT,
      scope: 'openid',
      codeChallenge: await client.calculatePKCECodeChallenge(verifier),
      codeChallengeMethod: 'S256',
    } satisfies CodeProperties as never);
    const value = await code.save();

    // Sanity: the code is real and oidc-provider can find it. If this fails
    // the test is not exercising what it claims to.
    expect(await provider.AuthorizationCode.find(value)).toBeTruthy();

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/oidc/token',
      headers: {
        host: TEST_HOST,
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`crm:${clientSecret}`).toString('base64')}`,
      },
      payload: new URLSearchParams({
        grant_type: 'authorization_code',
        code: value,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      }).toString(),
    });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_grant');
    expect(res.body).not.toContain('access_token');
    expect(res.body).not.toContain('id_token');

    // And it is visible afterwards rather than only refused. Read through
    // `withTenant`, because AuditEvent is FORCE ROW LEVEL SECURITY: a bare
    // `prisma.auditEvent.findMany()` matches no rows whatever the route wrote,
    // so the assertion would fail for a reason that has nothing to do with the
    // control.
    const events = await withTenant(ctx.tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'oidc.decision_missing' } }),
    );
    expect(events).toHaveLength(1);
  });

  it('CONTROL 2 — a decision is single-use, so one interaction cannot buy two tokens', async () => {
    const config = await discover();
    const { url, verifier, state } = await authUrlWithPkce(config);
    const { url: landed } = await walk(url);

    await client.authorizationCodeGrant(config, landed, {
      pkceCodeVerifier: verifier,
      expectedState: state,
    });
    // Replaying the same code: oidc-provider's own replay detection answers
    // this one, because the decision check deliberately steps aside for a code
    // that is already consumed.
    await expect(
      client.authorizationCodeGrant(config, landed, {
        pkceCodeVerifier: verifier,
        expectedState: state,
      }),
    ).rejects.toThrow();

    // Through `withTenant`: AuthorizationDecision is FORCE ROW LEVEL SECURITY,
    // so a bare `prisma.authorizationDecision.findMany()` is empty however the
    // exchange went, and both assertions below would be about nothing.
    const rows = await withTenant(ctx.tenantId, (tx) =>
      tx.authorizationDecision.findMany(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.consumedAt).not.toBeNull();
  });

  it('CONTROL 2 — a decision made for one client does not satisfy another', async () => {
    await withTenant(ctx.tenantId, async (tx) => {
      const other = await createApplication(tx, { name: 'HR', slug: 'hr', type: 'oidc' });
      await assignApplication(tx, other.id, { type: 'user', id: userId });
      await upsertOidcClient(tx, other.id, {
        clientId: 'hr',
        redirectUris: ['https://hr.acme.test/cb'],
        postLogoutRedirectUris: [],
        grantTypes: ['authorization_code'],
        scopes: ['openid'],
        requirePkce: true,
        clientCredentialsEnabled: false,
        tokenEndpointAuthMethod: 'client_secret_basic',
        idTokenSignedResponseAlg: 'RS256',
        accessTokenTtlSeconds: 3600,
        refreshTokenTtlSeconds: 0,
      });
    });
    const { invalidateProvider } = await import('@syntra/protocols');
    invalidateProvider(ctx.tenantId);

    // One legitimate flow for CRM, left unexchanged, so its decision is live.
    const config = await discover();
    const { url } = await authUrlWithPkce(config);
    await walk(url);
    expect(
      await withTenant(ctx.tenantId, (tx) => tx.authorizationDecision.count()),
    ).toBe(1);

    // Now mint an HR code with no interaction. The live CRM decision must not
    // pay for it — otherwise a launch of a low-risk application would satisfy
    // the requirement for a high-risk one.
    const provider = await providerForCached(ctx.tenantId);
    const grant = new provider.Grant({ clientId: 'hr', accountId: userId });
    grant.addOIDCScope('openid');
    const grantId = await grant.save();
    const verifier = client.randomPKCECodeVerifier();
    const code = new provider.AuthorizationCode({
      accountId: userId,
      clientId: 'hr',
      grantId,
      redirectUri: 'https://hr.acme.test/cb',
      scope: 'openid',
      codeChallenge: await client.calculatePKCECodeChallenge(verifier),
      codeChallengeMethod: 'S256',
    } satisfies CodeProperties as never);
    const value = await code.save();

    const hrSecret = await withTenant(ctx.tenantId, async (tx) => {
      const application = await tx.application.findFirstOrThrow({
        where: { slug: 'hr' },
      });
      const { clientSecret: s } = await upsertOidcClient(tx, application.id, {
        clientId: 'hr',
        redirectUris: ['https://hr.acme.test/cb'],
        postLogoutRedirectUris: [],
        grantTypes: ['authorization_code'],
        scopes: ['openid'],
        requirePkce: true,
        clientCredentialsEnabled: false,
        tokenEndpointAuthMethod: 'client_secret_basic',
        idTokenSignedResponseAlg: 'RS256',
        accessTokenTtlSeconds: 3600,
        refreshTokenTtlSeconds: 0,
        rotateSecret: true,
      });
      return s!;
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/oidc/token',
      headers: {
        host: TEST_HOST,
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`hr:${hrSecret}`).toString('base64')}`,
      },
      payload: new URLSearchParams({
        grant_type: 'authorization_code',
        code: value,
        redirect_uri: 'https://hr.acme.test/cb',
        code_verifier: verifier,
      }).toString(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('access_token');
    // The CRM decision is untouched.
    const rows = await withTenant(ctx.tenantId, (tx) =>
      tx.authorizationDecision.findMany(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.clientId).toBe('crm');
    expect(rows[0]!.consumedAt).toBeNull();
  });
});

/** The Provider the app is serving from, out of `providerFor`'s cache. */
async function providerForCached(tenantId: string) {
  // `providerFor` returns the cached instance for a tenant and ignores its
  // deps on a cache hit, so this is the same Provider the app serves from.
  // A `discover()` call is what puts it in the cache.
  const { providerFor } = await import('@syntra/protocols');
  return providerFor(tenantId, `http://${TEST_HOST}/oidc`, null as never);
}

describe('malformed client credentials', () => {
  const tokenWith = (header: string) =>
    ctx.app.inject({
      method: 'POST',
      url: '/oidc/token',
      headers: {
        host: ctx.host,
        authorization: `Basic ${Buffer.from(header, 'utf8').toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
    });

  /**
   * RFC 6749 2.3.1 percent-encodes both halves of a Basic credential, so this
   * decodes them -- and `decodeURIComponent('%zz')` throws URIError. The token
   * endpoint answered 500 where the specification requires invalid_client, so
   * a client with a broken encoder got an unexplained server error instead of
   * the one refusal that tells it what is wrong.
   */
  it('answers invalid_client for percent-encoding that cannot be read', async () => {
    const res = await tokenWith('client%zz:secret');
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'invalid_client' });
  });

  /** A header with no colon at all is the same answer, not a different one. */
  it('answers invalid_client for a Basic header with no separator', async () => {
    const res = await tokenWith('nocolonhere');
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'invalid_client' });
  });
});
