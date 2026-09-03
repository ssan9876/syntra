import { beforeEach, describe, expect, it } from 'vitest';
import * as client from 'openid-client';
import { createLocalJWKSet, jwtVerify } from 'jose';
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
      scopes: ['openid', 'profile', 'email', 'offline_access'],
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

describe('refresh tokens', () => {
  const codeFlow = async (scope: string) => {
    const config = await discover();
    const verifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const authUrl = client.buildAuthorizationUrl(config, {
      redirect_uri: REDIRECT, scope, state,
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      // oidc-provider strips `offline_access` from the request before it ever
      // reaches Syntra's interaction route unless `prompt=consent` came with
      // it (`check_scope.js`) — a request-level guard against silently minting
      // a refresh token, independent of whether an actual consent screen is
      // shown. Syntra's `loadExistingGrant` auto-grants whatever was
      // requested, so this does not add an extra hop; it only keeps the scope
      // alive long enough for that grant to cover it.
      ...(scope.includes('offline_access') ? { prompt: 'consent' } : {}),
    });
    const { url: landed } = await walk(authUrl);
    const tokens = await client.authorizationCodeGrant(config, landed, {
      pkceCodeVerifier: verifier,
      expectedState: state,
    });
    return { config, tokens };
  };

  it('issues a refresh token when offline_access is requested, and exchanges it', async () => {
    const { config, tokens } = await codeFlow('openid email offline_access');
    expect(tokens.refresh_token).toBeTruthy();

    const refreshed = await client.refreshTokenGrant(config, tokens.refresh_token!);
    expect(refreshed.access_token).toBeTruthy();
    expect(refreshed.access_token).not.toBe(tokens.access_token);
    // Rotation is on, so the old refresh token is replaced rather than reused.
    expect(refreshed.refresh_token).toBeTruthy();
    expect(refreshed.refresh_token).not.toBe(tokens.refresh_token);
  });

  it('refuses a rotated-out refresh token and revokes the whole grant', async () => {
    const { config, tokens } = await codeFlow('openid offline_access');
    const first = await client.refreshTokenGrant(config, tokens.refresh_token!);

    // Replaying the original is the signal that a refresh token leaked.
    await expect(client.refreshTokenGrant(config, tokens.refresh_token!)).rejects.toThrow();
    // And the replacement is dead too, because the grant behind both is gone.
    await expect(client.refreshTokenGrant(config, first.refresh_token!)).rejects.toThrow();
  });

  it('issues no refresh token without offline_access', async () => {
    const { tokens } = await codeFlow('openid email');
    expect(tokens.refresh_token).toBeUndefined();
  });

  it('stops honouring a refresh token once the password is reset', async () => {
    const { config, tokens } = await codeFlow('openid offline_access');
    expect(tokens.refresh_token).toBeTruthy();

    // Spec section 9.4 point 4. This is the revocation a completed password
    // reset performs, and the same one deactivation and a sync-driven leaver
    // perform: the user stays active throughout, so nothing here is carried
    // by `findAccount` refusing an inactive account the way the deactivation
    // test below is. A phished password already exchanged for a refresh token
    // has to die with the password.
    const { revokeAllRefreshTokensForUser } = await import('@syntra/core');
    await withTenant(ctx.tenantId, (tx) => revokeAllRefreshTokensForUser(tx, userId));

    await expect(client.refreshTokenGrant(config, tokens.refresh_token!)).rejects.toThrow();

    // The positive control. Refresh has to still work for a token issued
    // after the reset, or the assertion above would hold just as well with
    // the whole grant type broken.
    const after = await codeFlow('openid offline_access');
    await expect(
      client.refreshTokenGrant(after.config, after.tokens.refresh_token!),
    ).resolves.toBeTruthy();
  });

  it('stops honouring a refresh token once the user is deactivated', async () => {
    const { config, tokens } = await codeFlow('openid offline_access');
    const { deactivateUser } = await import('@syntra/core');
    await withTenant(ctx.tenantId, (tx) => deactivateUser(tx, userId, 'left'));
    // findAccount returns null for an inactive user, and oidc-provider
    // refuses to mint an id_token for an account it cannot find.
    await expect(client.refreshTokenGrant(config, tokens.refresh_token!)).rejects.toThrow();
  });
});

/**
 * One whole authorization code flow, discovering afresh each time.
 *
 * Fresh discovery on purpose: a relying party re-reads the JWKS when it meets
 * a `kid` it does not know, and this file's rotation test is about exactly
 * which key the provider signed with.
 */
const signIntoCrm = async () => {
  const config = await discover();
  const { url, verifier, state } = await authUrlWithPkce(config);
  const { url: landed } = await walk(url);
  return client.authorizationCodeGrant(config, landed, {
    pkceCodeVerifier: verifier,
    expectedState: state,
  });
};

/** The `kid` off a JWT header, without verifying anything. */
const kidOf = (jwt: string): string =>
  JSON.parse(Buffer.from(jwt.split('.')[0]!, 'base64url').toString('utf8')).kid;

describe('signing key rotation', () => {
  it('signs with the new key once the old one is retired', async () => {
    // The Provider resolves `deps.jwks()` ONCE, at construction, and is cached
    // per tenant. Nothing invalidated it on rotation, so after a roll it kept
    // signing with the old private key -- invisible during the overlap, and a
    // total outage the moment `retireExpiredKeys` unpublished that key, until
    // the process restarted. The existing rotation test could not see it: it
    // asserts against `GET /oidc/jwks`, which is Syntra's own route reading
    // `publishedKeys` fresh on every request.
    //
    // `overlapMs: 0` collapses the rollover so the old key is retired in the
    // same breath, which is the state that breaks.
    const { localMasterKeyProvider, publishedKeys, retireExpiredKeys, rotateKey } =
      await import('@syntra/core');
    const provider = localMasterKeyProvider(Buffer.alloc(32, 7));

    const before = await signIntoCrm();
    expect(before.id_token).toBeTruthy();

    await rotateKey(ctx.tenantId, provider, 'oidc', { overlapMs: 0 });
    expect(await retireExpiredKeys(ctx.tenantId, 'oidc')).toBe(1);

    // Exactly one key is published, and it is not the one that signed above.
    const published = await publishedKeys(ctx.tenantId, 'oidc');
    expect(published).toHaveLength(1);
    expect(published[0]!.kid).not.toBe(kidOf(before.id_token!));


    jar = [];
    const after = await signIntoCrm();
    expect(after.id_token).toBeTruthy();

    // THE ASSERTION. Not "the exchange succeeded": openid-client does not
    // verify an id_token's signature by default, so a token signed with a key
    // nobody publishes any more sails straight through it -- which is exactly
    // how this would reach production unnoticed. Verified here against the
    // document `/oidc/jwks` actually serves.
    const jwks = await ctx.app.inject({
      method: 'GET', url: '/oidc/jwks', headers: { host: TEST_HOST },
    });
    await expect(
      jwtVerify(after.id_token!, createLocalJWKSet(jwks.json())),
    ).resolves.toBeTruthy();

    // And the old token no longer verifies, which is what the outage looked
    // like from a relying party's side.
    await expect(
      jwtVerify(before.id_token!, createLocalJWKSet(jwks.json())),
    ).rejects.toThrow();
  });
});

describe('per-client token lifetimes', () => {
  /** Re-registers `crm` with different lifetimes and rebuilds the provider. */
  const reregister = async (over: Record<string, unknown>) => {
    await withTenant(ctx.tenantId, (tx) =>
      upsertOidcClient(tx, applicationId, {
        clientId: 'crm',
        redirectUris: [REDIRECT],
        postLogoutRedirectUris: ['https://crm.acme.test/bye'],
        grantTypes: ['authorization_code', 'refresh_token'],
        scopes: ['openid', 'profile', 'email', 'offline_access'],
        requirePkce: true,
        clientCredentialsEnabled: false,
        tokenEndpointAuthMethod: 'client_secret_basic',
        idTokenSignedResponseAlg: 'RS256',
        accessTokenTtlSeconds: 3600,
        refreshTokenTtlSeconds: 1_209_600,
        ...over,
      }),
    );
    const { invalidateProvider } = await import('@syntra/protocols');
    invalidateProvider(ctx.tenantId);
  };

  const codeFlow = async (scope = 'openid email') => {
    const config = await discover();
    const verifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const authUrl = client.buildAuthorizationUrl(config, {
      redirect_uri: REDIRECT, scope, state,
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      ...(scope.includes('offline_access') ? { prompt: 'consent' } : {}),
    });
    const { url: landed } = await walk(authUrl);
    return client.authorizationCodeGrant(config, landed, {
      pkceCodeVerifier: verifier,
      expectedState: state,
    });
  };

  it('honours the access token lifetime an administrator set on the client', async () => {
    // The fixture registers 3600 and the branch shipped `expires_in: 600` --
    // oidc-provider's own default, because nothing ever read the column. The
    // per-tenant value was not being applied either, so both halves of the
    // setting were inert.
    const asRegistered = await codeFlow();
    expect(asRegistered.expires_in).toBe(3600);

    await reregister({ accessTokenTtlSeconds: 900 });
    const shorter = await codeFlow();
    expect(shorter.expires_in).toBe(900);
  });

  it('issues no refresh token to a client whose refresh lifetime is zero', async () => {
    // `min(0)` is in the contract and an administrator will read `0` as "no
    // refresh tokens for this client". Two of this branch's own fixtures
    // already set it, which is how invisible it was.
    await reregister({ refreshTokenTtlSeconds: 0 });
    const none = await codeFlow('openid offline_access');
    expect(none.refresh_token).toBeUndefined();

    // The positive control. A positive lifetime still gets one, so this
    // cannot pass by having broken refresh tokens outright. The jar is emptied
    // first: `prompt=consent` twice over one oidc-provider session resolves
    // its second interaction against the grant the first one left, and the
    // walk loops.
    await reregister({ refreshTokenTtlSeconds: 3600 });
    jar = [];
    const some = await codeFlow('openid offline_access');
    expect(some.refresh_token).toBeTruthy();
  });
});

describe('client credentials — the one grant that bypasses authorize()', () => {
  /** Registers a machine client and returns its secret. */
  const machineClient = async (over: Record<string, unknown> = {}) => {
    const secret = await withTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.application.findFirst({ where: { slug: 'job' } });
      const application =
        existing ?? (await createApplication(tx, { name: 'Job', slug: 'job', type: 'oidc' }));
      const { clientSecret } = await upsertOidcClient(tx, application.id, {
        clientId: 'job', redirectUris: [], postLogoutRedirectUris: [],
        grantTypes: [], clientCredentialsEnabled: true, scopes: ['reports.read'],
        requirePkce: true, tokenEndpointAuthMethod: 'client_secret_basic',
        idTokenSignedResponseAlg: 'RS256', accessTokenTtlSeconds: 3600,
        refreshTokenTtlSeconds: 0, rotateSecret: true, ...over,
      });
      return clientSecret!;
    });
    const { invalidateProvider } = await import('@syntra/protocols');
    invalidateProvider(ctx.tenantId);
    return client.discovery(
      new URL(`http://${TEST_HOST}/oidc`), 'job', secret, undefined,
      { [client.customFetch]: injectFetch(), execute: [client.allowInsecureRequests] },
    );
  };

  it('issues a token to a client an administrator enabled, and audits it distinctly', async () => {
    const config = await machineClient();
    const tokens = await client.clientCredentialsGrant(config, { scope: 'reports.read' });
    expect(tokens.access_token).toBeTruthy();
    // No user behind it, so no id_token and no subject.
    expect(tokens.id_token).toBeUndefined();

    // A2-5 condition 2. "What was issued with no policy decision behind it"
    // has to be an answerable question, and a generic token event would not
    // answer it.
    const events = await withTenant(ctx.tenantId, (tx) =>
      tx.auditEvent.findMany({ where: { action: 'oidc.client_credentials_authorized' } }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.actorUserId).toBeNull();
    expect(JSON.stringify(events[0]!.payload)).toContain('job');
    // And nothing pretends a decision happened.
    expect(await withTenant(ctx.tenantId, (tx) => tx.authorizationDecision.count())).toBe(0);
  });

  it('gives a machine token the client’s own lifetime, not the library’s default', async () => {
    // `ttl.ClientCredentials` had no entry at all, so oidc-provider used its
    // own default and said so at every boot: "default ttl.ClientCredentials
    // function called, you SHOULD change it". A machine token's lifetime is
    // the client's access-token lifetime.
    const config = await machineClient({ accessTokenTtlSeconds: 1800 });
    const tokens = await client.clientCredentialsGrant(config, { scope: 'reports.read' });
    expect(tokens.expires_in).toBe(1800);
    // And not the library's default, which is what this is really about.
    expect(tokens.expires_in).not.toBe(600);
  });

  it('refuses the grant when the flag is off, even if the request is otherwise perfect', async () => {
    // A2-5 condition 1. The client exists, the secret is right, the scope is
    // registered — and the grant is off, which is the default.
    const config = await machineClient({ clientCredentialsEnabled: false });
    await expect(client.clientCredentialsGrant(config, { scope: 'reports.read' }))
      .rejects.toThrow();
    expect(
      await withTenant(ctx.tenantId, (tx) =>
        tx.auditEvent.count({ where: { action: 'oidc.client_credentials_authorized' } }),
      ),
    ).toBe(0);
  });

  it('refuses a scope that would let the token stand in for a user token', async () => {
    // A2-5 condition 3. If a machine token could carry `openid` it would be
    // presentable wherever a user token is accepted, and the exemption would
    // stop being bounded.
    const config = await machineClient({ scopes: ['reports.read', 'openid'] });
    await expect(client.clientCredentialsGrant(config, { scope: 'openid' })).rejects.toThrow();
    await expect(client.clientCredentialsGrant(config, { scope: 'reports.read openid' }))
      .rejects.toThrow();
    // The machine scope on its own is still fine.
    await expect(client.clientCredentialsGrant(config, { scope: 'reports.read' }))
      .resolves.toBeTruthy();
  });

  it('issues a token that UserInfo refuses', async () => {
    // The other half of condition 3, from the resource side: there is no
    // subject, so the endpoint that answers about a subject must refuse it.
    const config = await machineClient();
    const tokens = await client.clientCredentialsGrant(config, { scope: 'reports.read' });
    const res = await ctx.app.inject({
      method: 'GET', url: '/oidc/me',
      headers: { host: TEST_HOST, authorization: `Bearer ${tokens.access_token}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain('sub');
  });

  it('refuses client credentials with the wrong secret', async () => {
    const config = await client.discovery(
      new URL(`http://${TEST_HOST}/oidc`), 'crm', 'wrong-secret', undefined,
      { [client.customFetch]: injectFetch(), execute: [client.allowInsecureRequests] },
    );
    await expect(client.clientCredentialsGrant(config)).rejects.toThrow();
  });

  it('refuses client credentials from an ordinary user-facing client', async () => {
    const config = await discover();
    await expect(client.clientCredentialsGrant(config)).rejects.toThrow();
  });

  /** A token request with no Authorization header and no `client_secret`. */
  const anonymousTokenRequest = (form: Record<string, string>) =>
    ctx.app.inject({
      method: 'POST',
      url: '/oidc/token',
      headers: { host: TEST_HOST, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams(form).toString(),
    });

  const clientCredentialEvents = () =>
    withTenant(ctx.tenantId, (tx) =>
      tx.auditEvent.count({ where: { action: 'oidc.client_credentials_authorized' } }),
    );

  it('refuses a client credentials request that presents no credential at all', async () => {
    // The client is registered `none`, which `oidc-provider` honours at
    // /token, so nothing downstream refuses this: without the guard the only
    // control left is knowledge of a client id, which is not a secret.
    // `upsertOidcClient` is called directly rather than through the admin API
    // because the contract now refuses this registration outright -- the two
    // halves are independent and this one has to be provable on its own.
    await machineClient({ tokenEndpointAuthMethod: 'none' });

    const res = await anonymousTokenRequest({
      grant_type: 'client_credentials',
      client_id: 'job',
      scope: 'reports.read',
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_client');
    expect(res.body).not.toContain('access_token');

    // A2-5 condition 2. The event an auditor is told to read must not be
    // writable by a caller who authenticated nothing.
    expect(await clientCredentialEvents()).toBe(0);

    // The positive control: re-registered to authenticate with a secret, the
    // same client still gets a token. Without this the assertion above would
    // pass just as well if the grant were broken for everybody.
    const config = await machineClient();
    const tokens = await client.clientCredentialsGrant(config, { scope: 'reports.read' });
    expect(tokens.access_token).toBeTruthy();
    expect(await clientCredentialEvents()).toBe(1);
  });

  it('writes no audit event for an unauthenticated request against a confidential client', async () => {
    // The client here authenticates with a secret and the request carries
    // none. oidc-provider answers 401 either way; what this is about is that
    // Syntra does not first record `outcome: success` in the hash-chained log
    // for an issuance that never happened.
    await machineClient();

    const res = await anonymousTokenRequest({
      grant_type: 'client_credentials',
      client_id: 'job',
      scope: 'reports.read',
    });
    expect(res.statusCode).toBe(401);
    expect(await clientCredentialEvents()).toBe(0);
  });
});

describe('UserInfo', () => {
  it('returns the mapped claims for the token subject', async () => {
    const config = await discover();
    const verifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const authUrl = client.buildAuthorizationUrl(config, {
      redirect_uri: REDIRECT, scope: 'openid email', state,
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
    });
    const { url: landed } = await walk(authUrl);
    const tokens = await client.authorizationCodeGrant(config, landed, {
      pkceCodeVerifier: verifier, expectedState: state,
    });

    const info = await client.fetchUserInfo(config, tokens.access_token, userId);
    expect(info.sub).toBe(userId);
    expect(info.email).toBe('j@acme.test');
  });

  it('refuses a UserInfo call with no token and with a made-up one', async () => {
    const none = await ctx.app.inject({
      method: 'GET', url: '/oidc/me', headers: { host: TEST_HOST },
    });
    expect(none.statusCode).toBe(401);
    const bogus = await ctx.app.inject({
      method: 'GET', url: '/oidc/me',
      headers: { host: TEST_HOST, authorization: 'Bearer not-a-token' },
    });
    expect(bogus.statusCode).toBe(401);
  });
});

describe('RP-initiated logout', () => {
  it('ends the Syntra session and returns to a registered post-logout URI', async () => {
    const config = await discover();
    const verifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const authUrl = client.buildAuthorizationUrl(config, {
      redirect_uri: REDIRECT, scope: 'openid', state,
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
    });
    const { url: landed } = await walk(authUrl);
    const tokens = await client.authorizationCodeGrant(config, landed, {
      pkceCodeVerifier: verifier, expectedState: state,
    });

    const endSession = client.buildEndSessionUrl(config, {
      id_token_hint: tokens.id_token!,
      post_logout_redirect_uri: 'https://crm.acme.test/bye',
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: endSession.pathname + endSession.search,
      headers: { host: TEST_HOST, cookie: `syntra_session=${cookie}` },
    });
    expect([200, 302, 303]).toContain(res.statusCode);

    // The Syntra session is gone, not merely oidc-provider's.
    const after = await ctx.app.inject({
      method: 'GET', url: '/api/portal/applications',
      headers: { host: TEST_HOST, cookie: `syntra_session=${cookie}` },
    });
    expect(after.statusCode).toBe(401);
  });

  it('will not end a session on a bare cross-site GET', async () => {
    // Logout CSRF. A plain GET revoked the session and cleared the cookie, and
    // `logoutSource` auto-submits with no confirmation, so an image tag on any
    // page signed the user out. Three things were wrong at once: no hint was
    // required, the host was only checked at the END of the handler (after the
    // revocation), and this was the one protocol route with no rate limit.
    const bare = await ctx.app.inject({
      method: 'GET',
      url: '/oidc/session/end',
      headers: { host: TEST_HOST, cookie: `syntra_session=${cookie}` },
    });
    expect(bare.statusCode).toBe(400);

    // Still signed in.
    const alive = await ctx.app.inject({
      method: 'GET', url: '/api/portal/applications',
      headers: { host: TEST_HOST, cookie: `syntra_session=${cookie}` },
    });
    expect(alive.statusCode).toBe(200);
  });

  it('will not end a session named by somebody else’s id_token', async () => {
    // Requiring a hint is not enough: an attacker with an account in this
    // tenant holds an id_token of their own, and a cross-site link carrying it
    // would sign the victim out. The subject has to match the session.
    const { url, verifier, state } = await authUrlWithPkce(await discover());
    const { url: landed } = await walk(url);
    const tokens = await client.authorizationCodeGrant(await discover(), landed, {
      pkceCodeVerifier: verifier, expectedState: state,
    });

    // A second person, with a session of their own.
    const otherId = await withTenant(ctx.tenantId, async (tx) => {
      const other = await createUser(tx, {
        login: 'rroe', email: 'r@acme.test', displayName: 'R Roe',
      });
      await setPasswordHash(tx, other.id, PASSWORD_HASH);
      return other.id;
    });
    expect(otherId).not.toBe(userId);
    const otherLogin = await ctx.app.inject({
      method: 'POST', url: '/api/auth/login',
      headers: { host: TEST_HOST },
      payload: { login: 'rroe', password: PASSWORD },
    });
    const otherCookie = otherLogin.cookies.find((c) => c.name === 'syntra_session')!.value;

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/oidc/session/end?id_token_hint=${encodeURIComponent(tokens.id_token!)}`,
      headers: { host: TEST_HOST, cookie: `syntra_session=${otherCookie}` },
    });
    expect(res.statusCode).toBe(400);

    const alive = await ctx.app.inject({
      method: 'GET', url: '/api/portal/applications',
      headers: { host: TEST_HOST, cookie: `syntra_session=${otherCookie}` },
    });
    expect(alive.statusCode).toBe(200);
  });

  it('refuses a request that arrived on the wrong host before revoking anything', async () => {
    const { url, verifier, state } = await authUrlWithPkce(await discover());
    const { url: landed } = await walk(url);
    const tokens = await client.authorizationCodeGrant(await discover(), landed, {
      pkceCodeVerifier: verifier, expectedState: state,
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/oidc/session/end?id_token_hint=${encodeURIComponent(tokens.id_token!)}`,
      headers: { host: 'acme.attacker.example', cookie: `syntra_session=${cookie}` },
    });
    expect(res.statusCode).toBe(421);

    // The point of the ordering: the refusal came before the revocation, not
    // after it.
    const alive = await ctx.app.inject({
      method: 'GET', url: '/api/portal/applications',
      headers: { host: TEST_HOST, cookie: `syntra_session=${cookie}` },
    });
    expect(alive.statusCode).toBe(200);
  });

  it('refuses an unregistered post-logout redirect URI', async () => {
    const config = await discover();
    const endSession = client.buildEndSessionUrl(config, {
      post_logout_redirect_uri: 'https://attacker.test/bye',
      client_id: 'crm',
    });
    const res = await ctx.app.inject({
      method: 'GET',
      url: endSession.pathname + endSession.search,
      headers: { host: TEST_HOST, cookie: `syntra_session=${cookie}` },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.headers.location ?? '').not.toContain('attacker.test');
  });
});

/**
 * Revocation and introspection, and the client authentication they lacked.
 *
 * These live here rather than in a file of their own because the harness above
 * -- the fetch shim, the cookie jar, the walk -- is what it takes to hold a
 * real token, and revoking one is a grant-lifecycle operation like every other
 * case in this file.
 *
 * The defect they close: Syntra authenticates clients for `/token` itself,
 * constant-time against the stored hash, and hands oidc-provider a placeholder
 * secret it never learns the real value of. Every OTHER client-authenticated
 * endpoint therefore answered `invalid_client` to a client presenting its
 * correct secret, because the provider was comparing against a value nobody
 * holds. `oidc-boundary.test.ts` pinned that as deliberate; this moves it.
 */
describe('revocation and introspection', () => {
  const postForm = (path: string, body: Record<string, string>) =>
    ctx.app.inject({
      method: 'POST',
      url: path,
      headers: {
        host: TEST_HOST,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams(body).toString(),
    });

  const tokensWithRefresh = async () => {
    const config = await discover();
    const verifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const authUrl = client.buildAuthorizationUrl(config, {
      redirect_uri: REDIRECT,
      scope: 'openid email offline_access',
      state,
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      prompt: 'consent',
    });
    const { url: landed } = await walk(authUrl);
    const tokens = await client.authorizationCodeGrant(config, landed, {
      pkceCodeVerifier: verifier,
      expectedState: state,
    });
    return { config, tokens };
  };

  describe('revocation', () => {
    it('authenticates a client presenting its real secret', async () => {
      // THE defect. Before this, the correct secret got `invalid_client`.
      const { tokens } = await tokensWithRefresh();

      const res = await postForm('/oidc/token/revocation', {
        token: tokens.refresh_token!,
        client_id: 'crm',
        client_secret: clientSecret,
      });

      expect(res.statusCode).toBe(200);
    });

    it('kills the grant, so the refresh token stops working', async () => {
      const { config, tokens } = await tokensWithRefresh();

      await postForm('/oidc/token/revocation', {
        token: tokens.refresh_token!,
        client_id: 'crm',
        client_secret: clientSecret,
      });

      await expect(
        client.refreshTokenGrant(config, tokens.refresh_token!),
      ).rejects.toThrow();
    });

    it('answers 200 for a token that never existed', async () => {
      // RFC 7009 requires it, and it is also the only answer that does not
      // turn this endpoint into an oracle for guessing tokens.
      const res = await postForm('/oidc/token/revocation', {
        token: 'not-a-token-anybody-issued',
        client_id: 'crm',
        client_secret: clientSecret,
      });

      expect(res.statusCode).toBe(200);
    });

    it('refuses a wrong secret', async () => {
      const res = await postForm('/oidc/token/revocation', {
        token: 'anything',
        client_id: 'crm',
        client_secret: 'not-the-secret',
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe('invalid_client');
    });

    it('refuses a caller presenting no credential at all', async () => {
      const res = await postForm('/oidc/token/revocation', { token: 'anything' });

      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe('invalid_client');
    });
  });

  describe('introspection', () => {
    it('describes the client\'s own live access token', async () => {
      const { tokens } = await tokensWithRefresh();

      const res = await postForm('/oidc/token/introspection', {
        token: tokens.access_token,
        client_id: 'crm',
        client_secret: clientSecret,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.active).toBe(true);
      expect(body.client_id).toBe('crm');
      expect(body.sub).toBe(userId);
      expect(body.token_type).toBe('Bearer');
    });

    it('answers active:false for a revoked token, and describes nothing', async () => {
      const { tokens } = await tokensWithRefresh();
      await postForm('/oidc/token/revocation', {
        token: tokens.refresh_token!,
        client_id: 'crm',
        client_secret: clientSecret,
      });

      const res = await postForm('/oidc/token/introspection', {
        token: tokens.refresh_token!,
        client_id: 'crm',
        client_secret: clientSecret,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ active: false });
    });

    it('answers active:false for nonsense', async () => {
      const res = await postForm('/oidc/token/introspection', {
        token: 'nonsense',
        client_id: 'crm',
        client_secret: clientSecret,
      });

      expect(res.json()).toEqual({ active: false });
    });

    it('refuses a wrong secret', async () => {
      const res = await postForm('/oidc/token/introspection', {
        token: 'nonsense',
        client_id: 'crm',
        client_secret: 'not-the-secret',
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe('invalid_client');
    });
  });
});
