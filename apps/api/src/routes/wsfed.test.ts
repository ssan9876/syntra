import { beforeEach, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@syntra/db';
import {
  assignApplication,
  createApplication,
  createUser,
  hashPassword,
  saveSamlConfig,
  setPasswordHash,
} from '@syntra/core';
import { buildTestApp, TEST_HOST } from '../test-support.js';
import { ACS, SP, bindingCookie, samlConfig, samlKeyOptions } from './saml-sso-post.test.js';

/**
 * WS-Federation, end to end through the same machinery SAML uses.
 *
 * The point of every one of these is that WS-Fed is not a second, weaker door:
 * the same realm registration, the same reply-URL allowlist, the same
 * `authorize()`, the same signed assertion. What differs is the shape of the
 * answer, and that is the last thing to happen.
 */

const PASSWORD = 'correct horse battery staple';
const PASSWORD_HASH = await hashPassword(PASSWORD);

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
let applicationId: string;
let cookie: string;

const wsfed = (params: Record<string, string>, cookies: string[] = []) =>
  ctx.app.inject({
    method: 'GET',
    url: `/saml/wsfed?${new URLSearchParams(params).toString()}`,
    headers: { host: TEST_HOST, ...(cookies.length ? { cookie: cookies.join('; ') } : {}) },
  });

const signIn = async () => {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { host: TEST_HOST },
    payload: { login: 'jdoe', password: PASSWORD },
  });
  return res.cookies.find((c) => c.name === 'syntra_session')!.value;
};

const enableWsFed = (enabled: boolean) =>
  saveSamlConfig(
    ctx.tenantId,
    applicationId,
    samlConfig({ wsFedEnabled: enabled }),
    samlKeyOptions,
  );

beforeEach(async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();
  await prisma.tenant.update({
    where: { id: ctx.tenantId },
    data: { primaryDomain: TEST_HOST },
  });

  applicationId = await withTenant(ctx.tenantId, async (tx) => {
    const user = await createUser(tx, {
      login: 'jdoe',
      email: 'j@acme.test',
      displayName: 'J Doe',
    });
    await setPasswordHash(tx, user.id, PASSWORD_HASH);
    const application = await createApplication(tx, {
      name: 'Intranet',
      slug: 'intranet',
      type: 'saml',
    });
    await assignApplication(tx, application.id, { type: 'user', id: user.id });
    return application.id;
  });
  await enableWsFed(true);
  cookie = await signIn();
});

describe('WS-Federation sign-in', () => {
  it('posts a token to the registered reply URL', async () => {
    const res = await wsfed(
      { wa: 'wsignin1.0', wtrealm: SP, wreply: ACS, wctx: 'rm=0&id=abc' },
      [`syntra_session=${cookie}`],
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`action="${ACS}"`);
    expect(res.body).toContain('name="wresult"');
    expect(res.body).toContain('name="wctx" value="rm=0&amp;id=abc"');
    // The token is the same signed assertion SAML issues, carried in a
    // RequestSecurityTokenResponse instead of a samlp:Response.
    expect(res.body).toContain('RequestSecurityTokenResponseCollection');
    expect(res.body).toContain('Assertion');
    expect(res.body).not.toContain('samlp:Response');
  });

  it('falls back to the registered default reply URL', async () => {
    const res = await wsfed({ wa: 'wsignin1.0', wtrealm: SP }, [
      `syntra_session=${cookie}`,
    ]);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`action="${ACS}"`);
  });

  /**
   * The one that would be an open redirect carrying a bearer token.
   *
   * WS-Fed has no request signature, so `wreply` is attacker-controlled on
   * every request. Checked against the same allowlist SAML's ACS URL is.
   */
  it('refuses a reply URL that is not registered', async () => {
    const res = await wsfed(
      { wa: 'wsignin1.0', wtrealm: SP, wreply: 'https://evil.example.test/collect' },
      [`syntra_session=${cookie}`],
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('not registered');
  });

  it('does not answer an application that has not enabled WS-Federation', async () => {
    await enableWsFed(false);
    const res = await wsfed({ wa: 'wsignin1.0', wtrealm: SP, wreply: ACS }, [
      `syntra_session=${cookie}`,
    ]);
    expect(res.statusCode).toBe(404);
  });

  it('answers an unknown realm exactly as it answers a disabled one', async () => {
    // Both 404. Otherwise an unauthenticated caller can enumerate which realms
    // are registered by reading the difference.
    await enableWsFed(false);
    const disabled = await wsfed({ wa: 'wsignin1.0', wtrealm: SP });
    const unknown = await wsfed({
      wa: 'wsignin1.0',
      wtrealm: 'https://nobody.example.test/',
    });
    expect(disabled.statusCode).toBe(unknown.statusCode);
    expect(JSON.parse(disabled.body).detail ?? JSON.parse(disabled.body).title).toBe(
      JSON.parse(unknown.body).detail ?? JSON.parse(unknown.body).title,
    );
  });

  it('sends an unauthenticated browser to sign in first', async () => {
    const res = await wsfed({ wa: 'wsignin1.0', wtrealm: SP, wreply: ACS });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('/login?next=');
    expect(res.headers.location).toContain('%2Fsaml%2Fcontinue');
  });

  /**
   * The parked row carries the protocol, so returning through the shared
   * `/saml/continue` still produces a WS-Fed answer. Deriving it from the
   * application instead would answer this with a SAML Response, because this
   * application has SAML enabled too.
   */
  it('still answers in WS-Federation after the sign-in detour', async () => {
    const parked = await wsfed({ wa: 'wsignin1.0', wtrealm: SP, wreply: ACS });
    const next = decodeURIComponent(
      new URL(parked.headers.location as string, 'http://x').searchParams.get('next') ?? '',
    );
    const handle = new URLSearchParams(next.split('?')[1] ?? '').get('handle')!;

    const done = await ctx.app.inject({
      method: 'GET',
      url: `/saml/continue?handle=${handle}`,
      headers: {
        host: TEST_HOST,
        cookie: [`syntra_session=${cookie}`, ...bindingCookie(parked)].join('; '),
      },
    });
    expect(done.statusCode).toBe(200);
    expect(done.body).toContain('name="wresult"');
  });

  it('refuses an action it does not implement', async () => {
    const res = await wsfed({ wa: 'wsignout1.0x', wtrealm: SP }, [
      `syntra_session=${cookie}`,
    ]);
    expect(res.statusCode).toBe(400);
  });

  /**
   * Encryption is refused rather than quietly skipped.
   *
   * An application asking for encrypted assertions asked for a property of
   * every assertion it receives. WS-Fed has no envelope for one that relying
   * parties agree on, so issuing plaintext would hand out exactly what the
   * switch was turned on to prevent.
   */
  it('refuses rather than downgrading an application that wants encryption', async () => {
    await saveSamlConfig(
      ctx.tenantId,
      applicationId,
      samlConfig({
        wsFedEnabled: true,
        encryptAssertions: true,
        encryptionCertificate: null,
      }),
      samlKeyOptions,
    );
    const res = await wsfed({ wa: 'wsignin1.0', wtrealm: SP, wreply: ACS }, [
      `syntra_session=${cookie}`,
    ]);
    expect(res.statusCode).toBe(409);
    expect(res.body).toContain('encrypt');
  });
});

describe('WS-Federation sign-out', () => {
  it('returns the browser to a registered reply URL', async () => {
    const res = await wsfed({ wa: 'wsignout1.0', wtrealm: SP, wreply: ACS });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(ACS);
  });

  /**
   * The part a redirect alone would miss.
   *
   * A `wsignout1.0` that only redirected would be a sign-out link that signs
   * nobody out: the relying party clears its own cookie, the user sees a
   * signed-out page, and the next visit to any application lets them straight
   * back in.
   */
  it('actually ends the Syntra session', async () => {
    const before = await ctx.app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { host: TEST_HOST, cookie: `syntra_session=${cookie}` },
    });
    expect(before.statusCode).toBe(200);

    const out = await wsfed({ wa: 'wsignout1.0', wtrealm: SP, wreply: ACS }, [
      `syntra_session=${cookie}`,
    ]);
    expect(out.statusCode).toBe(302);

    const after = await ctx.app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { host: TEST_HOST, cookie: `syntra_session=${cookie}` },
    });
    expect(after.statusCode).toBe(401);
  });

  it('does not follow an unregistered one', async () => {
    // An unchecked `wreply` here is an open redirect reachable with no session
    // at all — the easiest one in the product to miss.
    const res = await wsfed({
      wa: 'wsignout1.0',
      wtrealm: SP,
      wreply: 'https://evil.example.test/',
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/logged-out');
  });

  it('lands on Syntra when the relying party names nowhere', async () => {
    const res = await wsfed({ wa: 'wsignout1.0' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/logged-out');
  });
});
