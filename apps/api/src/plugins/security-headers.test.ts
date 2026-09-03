import { beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp } from '../test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>>;

beforeEach(async () => {
  ctx = await buildTestApp();
  await ctx.app.ready();
});

const get = (url: string) =>
  ctx.app.inject({ method: 'GET', url, headers: { host: ctx.host } });

describe('the headers every response carries', () => {
  it('refuses to let a browser guess a content type', async () => {
    // The response this arrives on is a 401, deliberately: an error response is
    // the one a header is most often missing from, because it is produced by a
    // handler rather than a route.
    const res = await get('/api/admin/users');

    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('keeps the full URL from reaching another origin', async () => {
    // A URL here can hold a SAML RelayState or an authorization code, and a
    // Referer header carrying one to a service provider hands it that code.
    const res = await get('/api/admin/users');

    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });
});

describe('the content policy', () => {
  it('forbids inline script and framing on an application path', async () => {
    const res = await get('/api/admin/users');
    const csp = res.headers['content-security-policy'] as string;

    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it('exempts the federation paths, which post a form to another origin', async () => {
    // THE assertion in this file. A SAML Response is delivered by an HTML page
    // that submits itself to the service provider's ACS URL with an inline
    // onload handler. Under the console's policy the browser blocks both the
    // handler and the cross-origin submission, and single sign-on fails as a
    // blank page with nothing in any log.
    const res = await get('/saml/metadata');

    expect(res.headers['content-security-policy']).toBeUndefined();
    expect(res.headers['x-frame-options']).toBeUndefined();
    // The transport-level headers still apply there.
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('strict transport security', () => {
  it('is absent when the deployment is reached over plain HTTP', async () => {
    // Pinning a browser to HTTPS against a server that does not speak it makes
    // the deployment unreachable, and the pin outlives the mistake.
    const res = await get('/api/admin/users');

    expect(res.headers['strict-transport-security']).toBeUndefined();
  });

  it('is sent when the public URL is HTTPS', async () => {
    const secure = await buildTestApp({ env: { PUBLIC_URL: 'https://acme.example.test' } });
    await secure.app.ready();

    const res = await secure.app.inject({
      method: 'GET',
      url: '/api/admin/users',
      headers: { host: secure.host },
    });

    expect(res.headers['strict-transport-security']).toContain('max-age=');
  });
});
