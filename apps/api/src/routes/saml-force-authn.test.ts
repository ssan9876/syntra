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

const PASSWORD = 'correct horse battery staple';
const PASSWORD_HASH = await hashPassword(PASSWORD);

let ctx: Awaited<ReturnType<typeof buildTestApp>>;
let cookie: string;

/**
 * An AuthnRequest that asks for a fresh authentication.
 *
 * `ForceAuthn="true"` is what a payroll system or a signing portal sends when
 * it wants the person in front of the browser proved again rather than
 * inherited from a session minted hours earlier. It is the one attribute this
 * identity provider stored, honoured, and could never satisfy.
 */
const forceAuthnRequest = (id = '_force1') =>
  `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}" Version="2.0" ForceAuthn="true" IssueInstant="${new Date().toISOString()}" Destination="http://${TEST_HOST}/saml/sso" AssertionConsumerServiceURL="${ACS}"><saml:Issuer>${SP}</saml:Issuer></samlp:AuthnRequest>`;

const postSso = (xml: string, cookies: string[]) =>
  ctx.app.inject({
    method: 'POST',
    url: '/saml/sso',
    headers: {
      host: TEST_HOST,
      'content-type': 'application/x-www-form-urlencoded',
      cookie: cookies.join('; '),
    },
    payload: new URLSearchParams({
      SAMLRequest: Buffer.from(xml).toString('base64'),
    }).toString(),
  });

const getContinue = (handle: string, cookies: string[]) =>
  ctx.app.inject({
    method: 'GET',
    url: `/saml/continue?handle=${handle}`,
    headers: { host: TEST_HOST, cookie: cookies.join('; ') },
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

/** The handle out of the `/login?next=/saml/continue?handle=…` redirect. */
const handleFrom = (location: string): string => {
  const next = decodeURIComponent(
    new URL(location, 'http://x').searchParams.get('next') ?? '',
  );
  return new URLSearchParams(next.split('?')[1] ?? '').get('handle')!;
};

beforeEach(async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();
  await prisma.tenant.update({
    where: { id: ctx.tenantId },
    data: { primaryDomain: TEST_HOST },
  });

  const applicationId = await withTenant(ctx.tenantId, async (tx) => {
    const user = await createUser(tx, {
      login: 'jdoe', email: 'j@acme.test', displayName: 'J Doe',
    });
    await setPasswordHash(tx, user.id, PASSWORD_HASH);
    const application = await createApplication(tx, {
      name: 'Payroll', slug: 'payroll', type: 'saml',
    });
    await assignApplication(tx, application.id, { type: 'user', id: user.id });
    return application.id;
  });
  await saveSamlConfig(ctx.tenantId, applicationId, samlConfig(), samlKeyOptions);
  cookie = await signIn();
});

describe('ForceAuthn', () => {
  /**
   * The loop, stated as a test.
   *
   * A session that already existed when the request was parked is not an
   * answer to ForceAuthn, so the first hop MUST be the login screen — that
   * part was always right and stays asserted here, so the fix cannot
   * accidentally satisfy the flag with the stale session.
   */
  it('sends a browser holding an older session to the login screen', async () => {
    const parked = await postSso(forceAuthnRequest(), [`syntra_session=${cookie}`]);
    expect(parked.statusCode).toBe(302);
    expect(parked.headers.location).toContain('/login?next=');
    expect(parked.headers.location).toContain('%2Fsaml%2Fcontinue');
  });

  /**
   * THE ONE THAT MATTERS. The user does what the redirect asked: they sign in
   * again. Before this fix the second sign-in changed nothing — nothing on the
   * parked row or on the session recorded that a re-authentication had
   * happened — so /saml/continue redirected to /login again, and again, until
   * the row expired at ten minutes with a 410 and no assertion was ever issued
   * to any service provider that asks for ForceAuthn.
   */
  it('issues the assertion once the user has authenticated again', async () => {
    const parked = await postSso(forceAuthnRequest(), [`syntra_session=${cookie}`]);
    const handle = handleFrom(parked.headers.location as string);
    const binding = bindingCookie(parked);

    // The login screen. A fresh session, minted after the request was parked.
    const fresh = await signIn();

    const done = await getContinue(handle, [`syntra_session=${fresh}`, ...binding]);
    expect(done.statusCode).toBe(200);
    expect(done.body).toContain(`action="${ACS}"`);
    expect(done.body).toContain('name="SAMLResponse"');
  });

  /**
   * And the loop itself: returning with the SAME session the request was
   * parked against must still be refused, or "re-authenticate" would be
   * satisfied by pressing back.
   */
  it('still refuses the session that was already held', async () => {
    const parked = await postSso(forceAuthnRequest(), [`syntra_session=${cookie}`]);
    const handle = handleFrom(parked.headers.location as string);
    const binding = bindingCookie(parked);

    const again = await getContinue(handle, [`syntra_session=${cookie}`, ...binding]);
    expect(again.statusCode).toBe(302);
    expect(again.headers.location).toContain('/login?next=');
  });

  /** An ordinary request is unaffected: the held session is enough. */
  it('does not ask for a fresh authentication when ForceAuthn is absent', async () => {
    const xml = forceAuthnRequest().replace(' ForceAuthn="true"', '');
    const res = await postSso(xml, [`syntra_session=${cookie}`]);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('name="SAMLResponse"');
  });
});
