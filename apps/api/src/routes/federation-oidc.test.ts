import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, exportJWK, generateKeyPair, type KeyObject } from 'jose';
import { prisma, withTenant } from '@syntra/db';
import {
  addRule,
  deactivateUser,
  localMasterKeyProvider,
  upsertUpstream,
  type UpstreamInput,
} from '@syntra/core';
import { buildTestApp, TEST_HOST } from '../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
let upstreamServer: Server;
let issuer: string;
let signedNonce: string | null = null;
let subject = 'upstream-sub-1';
/**
 * Sockets the stub provider has accepted.
 *
 * The discriminator for the outbound guard. A refusal that happens *before*
 * the socket is opened is the guard; a refusal that happens after one is
 * opened is a failed handshake or a failed request, which would refuse the
 * same configuration for a reason that is not a control.
 */
let upstreamConnections = 0;

/**
 * What the stub provider puts in the next id_token, and what it signs it with.
 *
 * Every field here is one of the checks a relying party owes its tenant. A
 * federation suite that only proves a well-behaved provider works proves that
 * `openid-client` exists; what has to be proved is that a provider which
 * misbehaves — or an attacker who has got hold of a redirect — is refused.
 */
interface Lie {
  issuer?: string;
  audience?: string;
  nonce?: string;
  /** Sign with a key the JWKS document does not publish. */
  rogueKey?: boolean;
  /** Claims the id_token omits, left for the UserInfo endpoint to supply. */
  onlyInUserInfo?: Record<string, unknown>;
  /** Answer UserInfo 404, the way a provider that has none does. */
  noUserInfo?: boolean;
}
let lie: Lie = {};

const keyProvider = localMasterKeyProvider(Buffer.alloc(32, 7));

const upstreamFixture = (over: Partial<UpstreamInput> = {}): UpstreamInput => ({
  slug: 'entra',
  name: 'Entra ID',
  protocol: 'oidc',
  enabled: true,
  issuerUrl: issuer,
  clientId: 'syntra',
  clientSecret: 'up-secret',
  scopes: ['openid', 'profile', 'email'],
  idpEntityId: null,
  ssoUrl: null,
  idpSloUrl: null,
  ssoBinding: 'HTTP-Redirect',
  idpCertificates: [],
  wantAssertionsSigned: true,
  loginAttribute: 'preferred_username',
  emailAttribute: 'email',
  displayNameAttribute: 'name',
  groupsAttribute: null,
  createUsers: true,
  refreshOnLogin: true,
  defaultOrgUnitId: null,
  ...over,
});

/**
 * Sets a tenant up to federate: one upstream, one `federate` routing rule.
 *
 * Through `withTenant` and through `addRule`, never a bare `prisma.*.create` —
 * every table below is FORCE ROW LEVEL SECURITY, so a fixture written the
 * other way writes nothing and the test that follows proves nothing.
 */
const setUpFederation = async (tenantId: string, over: Partial<UpstreamInput> = {}) =>
  withTenant(tenantId, async (tx) => {
    const upstream = await upsertUpstream(tx, keyProvider, upstreamFixture(over));
    await addRule(tx, {
      name: 'entra for acme',
      outcome: 'federate',
      upstreamIdpId: upstream.id,
      loginDomains: ['acme.test'],
    });
    return upstream;
  });

beforeEach(async () => {
  lie = {};
  subject = 'upstream-sub-1';
  signedNonce = null;

  ctx = await buildTestApp();
  await ctx.app.ready();
  await prisma.tenant.update({
    where: { id: ctx.tenantId },
    data: { primaryDomain: TEST_HOST },
  });

  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const rogue = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid: 'up-1', alg: 'RS256', use: 'sig' };

  upstreamServer = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url!, issuer);
      if (url.pathname === '/.well-known/openid-configuration') {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            jwks_uri: `${issuer}/jwks`,
            userinfo_endpoint: `${issuer}/userinfo`,
            response_types_supported: ['code'],
            subject_types_supported: ['public'],
            id_token_signing_alg_values_supported: ['RS256'],
            code_challenge_methods_supported: ['S256'],
          }),
        );
        return;
      }
      if (url.pathname === '/jwks') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ keys: [jwk] }));
        return;
      }
      if (url.pathname === '/userinfo') {
        if (lie.noUserInfo) {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ sub: subject, ...(lie.onlyInUserInfo ?? {}) }));
        return;
      }
      if (url.pathname === '/token') {
        const signingKey: KeyObject | CryptoKey = lie.rogueKey ? rogue.privateKey : privateKey;
        const thin = lie.onlyInUserInfo !== undefined;
        const idToken = await new SignJWT({
          nonce: lie.nonce ?? signedNonce,
          ...(thin
            ? {}
            : {
                preferred_username: 'jdoe@acme.test',
                email: 'jdoe@acme.test',
                name: 'J Doe',
              }),
        })
          .setProtectedHeader({ alg: 'RS256', kid: 'up-1' })
          .setIssuer(lie.issuer ?? issuer)
          .setSubject(subject)
          .setAudience(lie.audience ?? 'syntra')
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(signingKey);
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            access_token: 'up-access',
            token_type: 'Bearer',
            expires_in: 300,
            id_token: idToken,
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end();
    })();
  });

  upstreamConnections = 0;
  upstreamServer.on('connection', () => {
    upstreamConnections += 1;
  });
  await new Promise<void>((resolve) => upstreamServer.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(upstreamServer.address() as AddressInfo).port}`;

  await setUpFederation(ctx.tenantId);
  binding = null;
});

afterEach(async () => {
  await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
  await ctx.app.close();
});

/**
 * The browser's `syntra_federation_bind` cookie, carried across the flow.
 *
 * This file used to inject with no cookies at all, so the request that STARTED
 * a login and the request that COMPLETED it shared no browser state — and the
 * happy-path test passed. That is the attack rather than the feature: the
 * callback URL is then a bearer credential the attacker can hand to a victim.
 * Every helper carries the cookie now, and a test that wants the unbound case
 * asks for it.
 */
const BINDING_COOKIE = 'syntra_federation_bind';
let binding: string | null = null;

const get = (url: string, withBinding = true) =>
  ctx.app.inject({
    method: 'GET',
    url,
    headers: {
      host: TEST_HOST,
      ...(withBinding && binding !== null ? { cookie: `${BINDING_COOKIE}=${binding}` } : {}),
    },
  });

/** Starts a login and remembers the binding cookie the browser was handed. */
const startLogin = async (login = 'jdoe@acme.test', query = '') => {
  const res = await get(`/federation/start?login=${encodeURIComponent(login)}${query}`);
  const issued = res.cookies.find((c) => c.name === BINDING_COOKIE)?.value;
  if (issued !== undefined) binding = issued;
  return res;
};

/** Drives the whole round trip, standing in for the upstream's redirect. */
const federate = async (login = 'jdoe@acme.test') => {
  const start = await startLogin(login);
  if (start.statusCode !== 302) return { start, callback: null, state: null };
  const authUrl = new URL(start.headers.location as string);
  signedNonce = authUrl.searchParams.get('nonce');
  const state = authUrl.searchParams.get('state')!;
  const callback = await get(
    `/federation/oidc/callback?code=up-code&state=${encodeURIComponent(state)}`,
  );
  return { start, callback, state };
};

const usersOf = (tenantId: string) => withTenant(tenantId, (tx) => tx.user.findMany());
const eventsOf = (tenantId: string, action: string) =>
  withTenant(tenantId, (tx) => tx.auditEvent.findMany({ where: { action } }));

const hasSession = (cookies: { name: string }[]) =>
  cookies.some((c) => c.name === 'syntra_session');

describe('upstream OIDC federation', () => {
  it('creates the local user on first login and issues a Syntra session', async () => {
    const { callback } = await federate();
    expect(callback!.statusCode).toBe(302);
    expect(hasSession(callback!.cookies)).toBe(true);

    const users = await usersOf(ctx.tenantId);
    expect(users).toHaveLength(1);
    expect(users[0]!.login).toBe('jdoe@acme.test');
    expect(users[0]!.passwordSource).toBe('upstream');

    // And the decision is in the audit log, naming who vouched.
    const events = await eventsOf(ctx.tenantId, 'auth.login');
    expect(events.some((e) => JSON.stringify(e.payload).includes('external'))).toBe(true);
    expect(events.some((e) => JSON.stringify(e.payload).includes(issuer))).toBe(true);
  });

  it('refreshes the same user on the second login rather than creating another', async () => {
    await federate();
    await federate();
    expect(await usersOf(ctx.tenantId)).toHaveLength(1);
  });

  it('sends a login that matches no routing rule to the local screen', async () => {
    const start = await get('/federation/start?login=someone@other.test');
    expect(start.headers.location).toMatch(/^\/login\?next=/);
    expect(await withTenant(ctx.tenantId, (tx) => tx.federationRequest.count())).toBe(0);
  });

  it('challenges rather than issuing a session when policy requires a factor', async () => {
    await withTenant(ctx.tenantId, (tx) =>
      addRule(tx, { name: 'mfa always', outcome: 'require_mfa' }),
    );
    const { callback } = await federate();
    // The upstream authenticated them. Syntra still wants its own factor,
    // which is the whole reason federation runs THROUGH authorize().
    expect(callback!.statusCode).toBe(302);
    expect(callback!.headers.location).toMatch(/^\/(mfa|enrol)\?attempt=/);
    expect(hasSession(callback!.cookies)).toBe(false);
  });

  it('issues no session when policy denies, even though the upstream said yes', async () => {
    await withTenant(ctx.tenantId, (tx) => addRule(tx, { name: 'nobody', outcome: 'deny' }));
    const { callback } = await federate();
    expect(callback!.statusCode).toBe(403);
    expect(hasSession(callback!.cookies)).toBe(false);
  });

  it('refuses a replayed callback', async () => {
    const { state } = await federate();
    const replay = await get(
      `/federation/oidc/callback?code=up-code&state=${encodeURIComponent(state!)}`,
    );
    expect(replay.statusCode).toBe(400);
    expect(hasSession(replay.cookies)).toBe(false);
  });

  it('refuses a callback presented by a browser that did not start the login', async () => {
    // Login CSRF, and the reason this file needed a cookie jar at all. The
    // attacker starts a login in their own browser and signs in at the
    // upstream as themselves. Instead of following the redirect they copy it
    // and send it to the victim. Nothing about the request is forged: the
    // ticket is live, and the PKCE verifier and the nonce come off the ROW
    // rather than the browser, so the exchange succeeds and `linkOrProvision`
    // returns the ATTACKER's user id -- which means `issueSession` would write
    // the attacker's session into the victim's browser and the victim would
    // never know they were working inside somebody else's account.
    //
    // `sameSite: lax` does not reach this either: the callback is a top-level
    // cross-site GET, which is exactly the shape a Lax cookie IS sent on.
    const start = await startLogin();
    const authUrl = new URL(start.headers.location as string);
    signedNonce = authUrl.searchParams.get('nonce');
    const state = authUrl.searchParams.get('state')!;

    const unbound = await get(
      `/federation/oidc/callback?code=up-code&state=${encodeURIComponent(state)}`,
      false,
    );
    expect(unbound.statusCode).toBe(400);
    expect(hasSession(unbound.cookies)).toBe(false);
    expect(await usersOf(ctx.tenantId)).toHaveLength(0);

    // The positive control: the browser that started it still completes. A
    // refusal that also refuses the legitimate flow proves nothing.
    const bound = await get(
      `/federation/oidc/callback?code=up-code&state=${encodeURIComponent(state)}`,
    );
    expect(bound.statusCode).toBe(302);
    expect(hasSession(bound.cookies)).toBe(true);
  });

  it('refuses a callback presented with somebody else’s binding cookie', async () => {
    const start = await startLogin();
    const authUrl = new URL(start.headers.location as string);
    signedNonce = authUrl.searchParams.get('nonce');
    const state = authUrl.searchParams.get('state')!;
    const mine = binding!;

    // A second browser. Starting a login is enough to get a binding of one's
    // own, and it is worth no more than none.
    binding = null;
    await startLogin();
    expect(binding).not.toBe(mine);

    const wrong = await get(
      `/federation/oidc/callback?code=up-code&state=${encodeURIComponent(state)}`,
    );
    expect(wrong.statusCode).toBe(400);
    expect(hasSession(wrong.cookies)).toBe(false);

    // And it did not spend the ticket: a wrong binding must not be a way to
    // cancel somebody else's sign-in.
    binding = mine;
    signedNonce = authUrl.searchParams.get('nonce');
    const bound = await get(
      `/federation/oidc/callback?code=up-code&state=${encodeURIComponent(state)}`,
    );
    expect(bound.statusCode).toBe(302);
    expect(hasSession(bound.cookies)).toBe(true);
  });

  it('refuses a callback with a state nobody issued', async () => {
    const res = await get('/federation/oidc/callback?code=x&state=made-up');
    expect(res.statusCode).toBe(400);
    expect(hasSession(res.cookies)).toBe(false);
    expect(await usersOf(ctx.tenantId)).toHaveLength(0);
  });

  it('refuses a callback with no state at all', async () => {
    const res = await get('/federation/oidc/callback?code=x');
    expect(res.statusCode).toBe(400);
    expect(hasSession(res.cookies)).toBe(false);
  });

  // The four ways a token can be evidence of nothing. Each one leaves the
  // browser with no session and Syntra with no user, and each is a lie the
  // happy path cannot distinguish from the truth without checking.
  const forgeries: [string, Lie][] = [
    ['whose issuer is not the configured one', { issuer: 'https://evil.example' }],
    ['whose audience is another client', { audience: 'someone-else' }],
    ['whose nonce is not the one Syntra sent', { nonce: 'a-nonce-syntra-never-issued' }],
    ['whose signature verifies against no published key', { rogueKey: true }],
  ];

  for (const [what, forged] of forgeries) {
    it(`refuses an id_token ${what}`, async () => {
      lie = forged;
      const { callback } = await federate();
      expect(callback!.statusCode).toBe(401);
      expect(hasSession(callback!.cookies)).toBe(false);
      expect(await usersOf(ctx.tenantId)).toHaveLength(0);
      // Refused, and recorded. An upstream that starts failing verification is
      // either broken or under attack, and neither is a thing to swallow.
      expect(await eventsOf(ctx.tenantId, 'federation.exchange_refused')).toHaveLength(1);
    });
  }

  it('refuses to provision when the upstream may not create users, and says why', async () => {
    await setUpFederation(ctx.tenantId, { createUsers: false });
    const { callback } = await federate();
    expect(callback!.statusCode).toBe(403);
    expect(hasSession(callback!.cookies)).toBe(false);
    expect(await usersOf(ctx.tenantId)).toHaveLength(0);

    const refusals = await eventsOf(ctx.tenantId, 'federation.provision_refused');
    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.payload).toMatchObject({ reason: 'no_local_user' });
  });

  it('asks UserInfo when the id_token carried no identifier', async () => {
    // Several providers put everything but `sub` behind UserInfo. Refusing the
    // login because the id_token was thin would be Syntra reporting its own
    // missing second request as the tenant's misconfiguration.
    lie = {
      onlyInUserInfo: {
        preferred_username: 'jdoe@acme.test',
        email: 'jdoe@acme.test',
        name: 'J Doe',
      },
    };
    const { callback } = await federate();
    expect(callback!.statusCode).toBe(302);
    expect(hasSession(callback!.cookies)).toBe(true);
    const users = await usersOf(ctx.tenantId);
    expect(users).toHaveLength(1);
    expect(users[0]!.displayName).toBe('J Doe');
  });

  it('refuses a profile the attribute mapping cannot identify', async () => {
    // The upstream sends its login under a claim this tenant did not map, and
    // UserInfo does not have it either. The record cannot be processed, so it
    // is refused and recorded — not dropped, and certainly not turned into an
    // account named after the subject.
    await setUpFederation(ctx.tenantId, {
      loginAttribute: 'upn',
      emailAttribute: 'upn',
    });
    const { callback } = await federate();
    expect(callback!.statusCode).toBe(403);
    expect(await usersOf(ctx.tenantId)).toHaveLength(0);
    const refusals = await eventsOf(ctx.tenantId, 'federation.provision_refused');
    expect(refusals[0]!.payload).toMatchObject({ reason: 'incomplete_profile' });
  });

  it('still refuses when the provider has no UserInfo endpoint to fall back on', async () => {
    lie = { onlyInUserInfo: {}, noUserInfo: true };
    const { callback } = await federate();
    expect(callback!.statusCode).toBe(403);
    expect(hasSession(callback!.cookies)).toBe(false);
    expect(await usersOf(ctx.tenantId)).toHaveLength(0);
    const refusals = await eventsOf(ctx.tenantId, 'federation.provision_refused');
    expect(refusals[0]!.payload).toMatchObject({ reason: 'incomplete_profile' });
  });

  it('never redirects off-origin after federation', async () => {
    for (const bad of ['https://attacker.test/', '//attacker.test/', '/\\attacker.test']) {
      const start = await startLogin('jdoe@acme.test', `&next=${encodeURIComponent(bad)}`);
      const authUrl = new URL(start.headers.location as string);
      signedNonce = authUrl.searchParams.get('nonce');
      const callback = await get(
        `/federation/oidc/callback?code=up-code&state=${encodeURIComponent(
          authUrl.searchParams.get('state')!,
        )}`,
      );
      const location = callback.headers.location as string;
      expect(location.startsWith('/')).toBe(true);
      expect(location.startsWith('//')).toBe(false);
      expect(location).not.toContain('attacker.test');
    }
  });

  it('sends the code back to the tenant identity, not to whatever Host said', async () => {
    const start = await startLogin();
    const redirectUri = new URL(start.headers.location as string).searchParams.get(
      'redirect_uri',
    );
    expect(redirectUri).toBe(`http://${TEST_HOST}/federation/oidc/callback`);
  });

  it('refuses a protocol request that arrived on the wrong host', async () => {
    // `acme.attacker.example` resolves tenant `acme`. Nothing here is allowed
    // to be derived from that.
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/federation/start?login=jdoe@acme.test',
      headers: { host: 'acme.attacker.example' },
    });
    expect(res.statusCode).toBe(421);
  });

  it('refuses an upstream whose issuer resolves inside the deployment, by default', async () => {
    // The stub above listens on 127.0.0.1, which is why buildTestApp allows
    // private addresses. With the shipped default the same configuration is
    // refused, and discovery never happens.
    const strict = await buildTestApp({ env: { OUTBOUND_ALLOW_PRIVATE: 'false' } });
    await strict.app.ready();
    try {
      await prisma.tenant.update({
        where: { id: strict.tenantId },
        data: { primaryDomain: TEST_HOST },
      });
      await setUpFederation(strict.tenantId);

      const start = (url: string) =>
        strict.app.inject({ method: 'GET', url, headers: { host: TEST_HOST } });

      const res = await start('/federation/start?login=jdoe@acme.test');
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).not.toBe(302);
      // Nothing was opened, so nothing reached the provider: the refusal is
      // before the first byte, not after a failed exchange.
      expect(await withTenant(strict.tenantId, (tx) => tx.federationRequest.count())).toBe(
        0,
      );
      // And the address the hostname resolved to is not handed to the browser.
      expect(res.body).not.toContain('127.0.0.1');

      // The refusal above is over-determined — the shipped default also
      // refuses a plain-http issuer — so here is the same tenant pointed at an
      // https issuer on a name that resolves inward. The socket count is what
      // makes the answer unambiguous: the guard refuses before connecting, so
      // the stub sees nothing at all, where a failed TLS handshake against it
      // would have shown up as an accepted connection.
      await withTenant(strict.tenantId, (tx) =>
        upsertUpstream(
          tx,
          keyProvider,
          upstreamFixture({ issuerUrl: `https://127.0.0.1:${new URL(issuer).port}` }),
        ),
      );
      const connectionsBefore = upstreamConnections;
      const overTls = await start('/federation/start?login=jdoe@acme.test');
      expect(overTls.statusCode).toBe(502);
      expect(upstreamConnections).toBe(connectionsBefore);
      expect(overTls.body).not.toContain('127.0.0.1');
      expect(await withTenant(strict.tenantId, (tx) => tx.federationRequest.count())).toBe(
        0,
      );
    } finally {
      await strict.app.close();
    }
  });

  it('refuses to sign in a deactivated account the upstream still recognises', async () => {
    await federate();
    const user = (await usersOf(ctx.tenantId))[0]!;
    await withTenant(ctx.tenantId, (tx) => deactivateUser(tx, user.id, 'left'));

    const { callback } = await federate();
    expect(callback!.statusCode).toBe(403);
    expect(hasSession(callback!.cookies)).toBe(false);
    // Still inactive. Signing in is not a way to come back.
    const after = (await usersOf(ctx.tenantId))[0]!;
    expect(after.status).toBe('inactive');
  });

  it('keeps the verifier out of the row and out of the vault once spent', async () => {
    const start = await startLogin();
    const authUrl = new URL(start.headers.location as string);
    signedNonce = authUrl.searchParams.get('nonce');

    const before = await withTenant(ctx.tenantId, (tx) =>
      tx.federationRequest.findFirstOrThrow(),
    );
    expect(before.verifierName).toMatch(/^federation:/);
    // The row names the secret; it never holds it, and the challenge that went
    // to the provider is not the verifier.
    expect(JSON.stringify(before)).not.toContain(
      authUrl.searchParams.get('code_challenge')!,
    );

    await get(
      `/federation/oidc/callback?code=up-code&state=${encodeURIComponent(
        authUrl.searchParams.get('state')!,
      )}`,
    );

    const after = await withTenant(ctx.tenantId, async (tx) => ({
      request: await tx.federationRequest.findFirstOrThrow(),
      secrets: await tx.secret.findMany({ where: { name: before.verifierName! } }),
    }));
    expect(after.request.consumedAt).not.toBeNull();
    // Spent, and gone. A vault that keeps one dead verifier per sign-in is a
    // vault nobody can audit.
    expect(after.secrets).toHaveLength(0);
  });
});
