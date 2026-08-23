import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, TEST_HOST } from '../test-support.js';

/**
 * A stand-in for `vite build` output. Built here rather than pointed at
 * `apps/web/dist` on purpose: a test that needs the real build to have been
 * run passes or fails on whether somebody remembered to run it, which is the
 * definition of a flaky gate.
 */
function makeDist(options: { index?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'syntra-web-'));
  if (options.index !== false) {
    writeFileSync(join(root, 'index.html'), '<!doctype html><title>Syntra</title>');
  }
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'assets', 'index-abc123.js'), 'console.log(1)\n');
  writeFileSync(join(root, 'favicon.ico'), 'x');
  return root;
}

const root = makeDist();
let ctx: Awaited<ReturnType<typeof buildTestApp>>;

beforeAll(async () => {
  ctx = await buildTestApp({ env: { WEB_ROOT: root } });
  await ctx.app.ready();
});

afterAll(async () => {
  await ctx.app.close();
  rmSync(root, { recursive: true, force: true });
});

const page = (url: string) =>
  ctx.app.inject({
    method: 'GET',
    url,
    headers: { host: TEST_HOST, accept: 'text/html,application/xhtml+xml' },
  });

describe('serving the built application', () => {
  it('answers the root with the application', async () => {
    const res = await page('/');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('<title>Syntra</title>');
  });

  it('answers a DEEP LINK with the application, not a 404', async () => {
    // The whole reason this plugin exists. `/admin/users` is a real screen the
    // server has no route for, because the routing happens in the browser —
    // and without a fallback, typing it in or reloading the page 404s.
    for (const url of ['/admin/users', '/login', '/govern/reviews', '/catalog/abc']) {
      const res = await page(url);
      expect(res.statusCode, url).toBe(200);
      expect(res.body, url).toContain('<title>Syntra</title>');
    }
  });

  it('serves a hashed bundle, and lets the browser keep it forever', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/assets/index-abc123.js',
      headers: { host: TEST_HOST },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('console.log(1)');
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('never lets the browser keep index.html', async () => {
    // It names the hashed bundles. A cached copy after a deploy points at
    // files that no longer exist, and the application fails to boot with
    // nothing on screen to say why.
    expect((await page('/')).headers['cache-control']).toBe('no-cache');
  });

  it('revalidates an unhashed file, which keeps its name across builds', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/favicon.ico',
      headers: { host: TEST_HOST },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-cache');
  });
});

describe('what the fallback must NOT swallow', () => {
  it('answers an unknown API path with problem+json, never a page', async () => {
    // A fallback that swallowed /api would answer a mistyped or withdrawn
    // endpoint with 200 and a page of HTML. Every client parsing that as JSON
    // reports a syntax error, and the real cause — the endpoint is gone — is
    // nowhere in the message.
    for (const url of ['/api/nope', '/api/admin/nothing-here', '/saml/nope', '/federation/nope']) {
      const res = await page(url);
      expect(res.statusCode, url).toBe(404);
      expect(res.headers['content-type'], url).toContain('application/problem+json');
    }
  });

  it('leaves the OIDC provider to answer for its own unknown paths', async () => {
    // Everything under /oidc is oidc-provider's, including what it says about
    // a path it does not have — which is text, not problem+json. The property
    // that matters here is the same one as above: the fallback did not take
    // it and hand back a page.
    const res = await page('/oidc/nope');
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).not.toContain('text/html');
    expect(res.body).not.toContain('<title>Syntra</title>');
  });

  it('answers a MISSING BUNDLE with 404 rather than the page', async () => {
    // A page cached from before a deploy asks for a bundle that no longer
    // exists. Answering with index.html returns 200 and HTML where a script
    // was expected, and the browser reports a MIME type error that says
    // nothing about the real cause.
    const res = await page('/assets/index-gone.js');
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('does not treat a write as a page request', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/nope',
      headers: { host: TEST_HOST, accept: 'text/html' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('leaves the routes that do exist alone', async () => {
    const health = await ctx.app.inject({ method: 'GET', url: '/health' });
    expect(health.json()).toEqual({ status: 'ok' });

    // An unauthenticated admin read still refuses as itself.
    const admin = await ctx.app.inject({
      method: 'GET',
      url: '/api/admin/users',
      headers: { host: TEST_HOST },
    });
    expect(admin.statusCode).toBe(401);
    expect(admin.headers['content-type']).toContain('application/problem+json');
  });
});

describe('arriving on a hostname no tenant claims', () => {
  const unknown = (accept: string, url = '/') =>
    ctx.app.inject({
      method: 'GET',
      url,
      headers: { host: 'brand-new.example.com', accept },
    });

  it('explains it to a browser, and says where to fix it', async () => {
    const res = await unknown('text/html');
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('brand-new.example.com');
    expect(res.body).toContain('Also');
  });

  it('does not name the tenants that WOULD have worked', async () => {
    // Which organizations live on a server is not something an
    // unauthenticated request gets to enumerate.
    const res = await unknown('text/html');
    expect(res.body).not.toContain('acme');
    expect(res.body).not.toContain(TEST_HOST);
  });

  it('ESCAPES the hostname it echoes', async () => {
    // The Host header is attacker-controlled and this page prints it back.
    // Unescaped, that is script execution against anyone who follows a link.
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/',
      headers: { host: 'x<script>alert(1)</script>', accept: 'text/html' },
    });
    expect(res.body).not.toContain('<script>alert(1)</script>');
    expect(res.body).toContain('&lt;script&gt;');
  });

  it('still answers an API call with problem+json', async () => {
    // `fetch` sends `*/*`. Answering it with a page would turn a clear 404
    // into a parse error in the caller.
    const res = await unknown('*/*', '/api/admin/users');
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({ title: 'Unknown tenant' });
  });
});

describe('a WEB_ROOT that is not a build', () => {
  it('refuses to start when the directory does not exist', async () => {
    // Tolerated, it produces a server that looks healthy and answers every
    // page with 404 — which reads as a routing bug for as long as it takes
    // somebody to check the path.
    await expect(
      buildTestApp({ env: { WEB_ROOT: join(tmpdir(), 'syntra-not-a-real-dir') } }),
    ).rejects.toThrow(/does not exist/);
  });

  it('refuses to start when there is no index.html in it', async () => {
    const empty = makeDist({ index: false });
    await expect(buildTestApp({ env: { WEB_ROOT: empty } })).rejects.toThrow(
      /no index\.html/,
    );
    rmSync(empty, { recursive: true, force: true });
  });
});

describe('the API-only deployment', () => {
  it('keeps answering 404 as problem+json when no WEB_ROOT is set', async () => {
    // `pnpm dev` and the whole test suite run this way. Serving pages must be
    // something a deployment opts into, not something that appeared.
    const api = await buildTestApp();
    await api.app.ready();
    const res = await api.app.inject({
      method: 'GET',
      url: '/admin/users',
      headers: { host: TEST_HOST, accept: 'text/html' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    await api.app.close();
  });
});
