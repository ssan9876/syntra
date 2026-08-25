import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { lookup } from 'node:dns/promises';
import { guardedFetch } from './guarded-fetch.js';

let server: Server | null = null;

const listen = async (
  handler: Parameters<typeof createServer>[1],
  /**
   * Left out, the socket binds to 127.0.0.1. A test that reaches the server by
   * *name* must bind to the address that name resolves to first, because the
   * pin connects to the address the guard checked and to no other — which is
   * the property under test everywhere else in this file.
   */
  bindTo: string = '127.0.0.1',
): Promise<{ base: string; port: number }> => {
  server = createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, bindTo, resolve));
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, port };
};

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

describe('guardedFetch', () => {
  it('refuses a hostname that resolves inside the deployment', async () => {
    const { port } = await listen((_req, res) => res.end('{}'));
    const fetcher = guardedFetch({ allowPrivateAddresses: false });

    // `localhost` is a name, not a literal, and it is the shape that gets past
    // a check written against the string an administrator typed. It is also
    // https here, so the refusal cannot be a transport-scheme refusal wearing
    // the guard's clothes — nothing ever connects.
    await expect(fetcher(`https://localhost:${port}/.well-known/openid-configuration`))
      .rejects.toThrow(/inside this deployment/);
  });

  it('refuses a literal loopback address too', async () => {
    const { base } = await listen((_req, res) => res.end('{}'));
    await expect(guardedFetch({ allowPrivateAddresses: false })(base)).rejects.toThrow(
      /inside this deployment/,
    );
  });

  it('reaches the same address when the deployment allows it', async () => {
    const { base } = await listen((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ issuer: 'up' }));
    });
    const response = await guardedFetch({ allowPrivateAddresses: true })(base);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ issuer: 'up' });
  });

  it('refuses a redirect rather than following it', async () => {
    // A public hostname that redirects inward defeats an address check as
    // thoroughly as a rebinding one, so the redirect is where it stops.
    const { base } = await listen((_req, res) => {
      res.statusCode = 302;
      res.setHeader('location', 'http://169.254.169.254/latest/meta-data/');
      res.end();
    });
    await expect(guardedFetch({ allowPrivateAddresses: true })(base)).rejects.toThrow(
      /redirect/,
    );
  });

  it('sends the hostname as Host, not the address it connected to', async () => {
    let seenHost = '';
    // Bound to whichever address `localhost` resolves to first, because that
    // is the one the guard checks and therefore the only one it will connect
    // to. Reading it here rather than assuming keeps the test honest on a host
    // that answers `::1` first and one that answers `127.0.0.1` first alike.
    const first = (await lookup('localhost', { all: true }))[0]!.address;
    const { port } = await listen((req, res) => {
      seenHost = req.headers.host ?? '';
      res.end('{}');
    }, first);
    await guardedFetch({ allowPrivateAddresses: true })(`http://localhost:${port}/x`);
    // The connection is pinned to the resolved address; the request still says
    // who it meant to talk to, which is what keeps virtual hosting and — over
    // TLS — certificate validation working.
    expect(seenHost).toBe(`localhost:${port}`);
  });

  it('carries a POST body and its headers through', async () => {
    let body = '';
    let auth = '';
    const { base } = await listen((req, res) => {
      auth = req.headers.authorization ?? '';
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        body = Buffer.concat(chunks).toString('utf8');
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
      });
    });

    const response = await guardedFetch({ allowPrivateAddresses: true })(`${base}/token`, {
      method: 'POST',
      headers: { authorization: 'Basic abc', 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=authorization_code&code=xyz',
    });

    expect(body).toBe('grant_type=authorization_code&code=xyz');
    expect(auth).toBe('Basic abc');
    expect(await response.json()).toEqual({ ok: true });
  });

  it('refuses a scheme that is not http or https', async () => {
    await expect(guardedFetch({})('file:///etc/passwd')).rejects.toThrow(/only http/);
  });

  it('refuses a response larger than the cap', async () => {
    const { base } = await listen((_req, res) => res.end('x'.repeat(4096)));
    await expect(
      guardedFetch({ allowPrivateAddresses: true, maxBytes: 512 })(base),
    ).rejects.toThrow(/too large/);
  });
});
