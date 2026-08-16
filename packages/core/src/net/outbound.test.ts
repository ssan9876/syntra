import { describe, expect, it } from 'vitest';
import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { classifyAddress, fetchExternalDocument } from './outbound.js';

describe('classifyAddress', () => {
  it('refuses loopback, link-local, private, unique-local and unspecified', () => {
    for (const address of [
      '127.0.0.1', '127.5.5.5', '::1',
      '169.254.169.254', 'fe80::1',
      '10.0.0.5', '172.16.0.1', '172.31.255.254', '192.168.1.1',
      'fc00::1', 'fd12::1',
      '0.0.0.0', '255.255.255.255', '224.0.0.1', '100.64.0.1',
    ]) {
      expect(classifyAddress(address)).toBe('blocked');
    }
  });

  it('refuses an IPv4-mapped IPv6 address that wraps a private one', () => {
    // ::ffff:10.0.0.1 IS 10.0.0.1. Measured: `ipaddr.parse` classifies all
    // three of these as `ipv4Mapped` and nothing more specific, so a
    // block-list naming only loopback, linkLocal and private lets every one of
    // them through. `ipaddr.process` unwraps them to their IPv4 form first —
    // verified to return loopback, private and linkLocal respectively — which
    // is why `classifyAddress` uses `process` and not `parse`.
    expect(classifyAddress('::ffff:127.0.0.1')).toBe('blocked');
    expect(classifyAddress('::ffff:10.0.0.1')).toBe('blocked');
    expect(classifyAddress('::ffff:169.254.169.254')).toBe('blocked');
  });

  it('allows ordinary public addresses', () => {
    for (const address of ['8.8.8.8', '203.0.113.5', '2606:4700::1111']) {
      expect(classifyAddress(address)).toBe('allowed');
    }
  });

  it('refuses anything it cannot parse rather than allowing it', () => {
    expect(classifyAddress('not-an-address')).toBe('blocked');
    expect(classifyAddress('')).toBe('blocked');
  });
});

describe('fetchExternalDocument', () => {
  let server: Server;

  const start = async (handler: RequestListener) => {
    server = createServer(handler);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };
  const stop = () => new Promise<void>((r) => server.close(() => r()));

  it('refuses a loopback host by default, naming the address it refused', async () => {
    const base = await start((_q, res) => res.end('should never be read'));
    try {
      await expect(fetchExternalDocument(`${base}/metadata`, {})).rejects.toThrow(
        /127\.0\.0\.1/,
      );
    } finally {
      await stop();
    }
  });

  it('fetches it when the deployment has allowed private addresses', async () => {
    const base = await start((_q, res) => {
      res.setHeader('content-type', 'application/xml');
      res.end('<EntityDescriptor/>');
    });
    try {
      const body = await fetchExternalDocument(`${base}/metadata`, {
        allowPrivateAddresses: true,
      });
      expect(body).toBe('<EntityDescriptor/>');
    } finally {
      await stop();
    }
  });

  it('refuses a redirect rather than following it', async () => {
    const base = await start((_q, res) => {
      res.statusCode = 302;
      res.setHeader('location', 'http://169.254.169.254/latest/meta-data/');
      res.end();
    });
    try {
      // A followed redirect is how a public hostname reaches a private one.
      await expect(
        fetchExternalDocument(`${base}/metadata`, { allowPrivateAddresses: true }),
      ).rejects.toThrow(/redirect/i);
    } finally {
      await stop();
    }
  });

  it('refuses a body past the ceiling', async () => {
    const base = await start((_q, res) => res.end('x'.repeat(200_000)));
    try {
      await expect(
        fetchExternalDocument(`${base}/metadata`, {
          allowPrivateAddresses: true, maxBytes: 1000,
        }),
      ).rejects.toThrow(/too large/i);
    } finally {
      await stop();
    }
  });

  it('refuses a scheme that is not http or https', async () => {
    await expect(fetchExternalDocument('file:///etc/passwd', {})).rejects.toThrow();
    await expect(fetchExternalDocument('gopher://x/', {})).rejects.toThrow();
  });
});
