import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp } from './test-support.js';

let ctx: Awaited<ReturnType<typeof buildTestApp>> | undefined;

afterEach(async () => {
  await ctx?.app.close();
  ctx = undefined;
});

describe('GET /health/ready', () => {
  it('is 200 with ready: true and a probes array on a freshly built app', async () => {
    ctx = await buildTestApp();
    await ctx.app.ready();

    const res = await ctx.app.inject({ method: 'GET', url: '/health/ready' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ready).toBe(true);
    expect(Array.isArray(body.probes)).toBe(true);
  });

  // The primary, deterministic test this task's own change had zero coverage
  // for: `config: { rateLimit: { max: 60, timeWindow: '1 minute' } }` on the
  // route actually applies. `/health/ready` is an UNSCOPED path (see
  // tenant-context.ts), so every one of these requests -- with no Host header
  // at all -- shares the one 'unscoped|127.0.0.1' bucket, and a fresh app per
  // test means a fresh in-memory limiter with nothing left over from another
  // test.
  it('allows 60 requests a minute and 429s the 61st', async () => {
    ctx = await buildTestApp();
    await ctx.app.ready();

    for (let i = 0; i < 60; i++) {
      const res = await ctx.app.inject({ method: 'GET', url: '/health/ready' });
      expect(res.statusCode).not.toBe(429);
    }

    const res = await ctx.app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(429);
  });

  // The strongest test for what this task actually fixed: that a failing
  // probe's `detail` on the wire is the fixed redacted string, not whatever
  // `readiness()` itself produced. Forced through the `web` probe rather than
  // the database or vault -- `probeWeb` is a plain `existsSync` check with no
  // I/O to fake, so this is deterministic and touches nothing else `readiness()`
  // checks.
  //
  // `registerWebApp` reads `index.html` into memory once at startup, so the
  // app builds successfully against a WEB_ROOT that has one; deleting the file
  // afterwards makes `probeWeb`'s per-request `existsSync` check fail on the
  // next `/health/ready` call without disturbing anything already registered.
  it('redacts the detail of a failing probe', async () => {
    const webRoot = mkdtempSync(join(tmpdir(), 'syntra-web-ready-'));
    writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>Syntra</title>');
    try {
      ctx = await buildTestApp({ env: { WEB_ROOT: webRoot } });
      await ctx.app.ready();

      unlinkSync(join(webRoot, 'index.html'));

      const res = await ctx.app.inject({ method: 'GET', url: '/health/ready' });

      expect(res.statusCode).toBe(503);
      const body = res.json();
      expect(body.ready).toBe(false);
      const webProbe = body.probes.find((probe: { name: string }) => probe.name === 'web');
      expect(webProbe.status).toBe('fail');
      expect(webProbe.detail).toBe('this check did not pass');
    } finally {
      rmSync(webRoot, { recursive: true, force: true });
    }
  });
});
