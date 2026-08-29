import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { scim2TargetConfigSchema } from './config.js';
import { scimRequest, ScimMalformedBodyError } from './client.js';
import { scimTargetConnector } from './connector.js';

/**
 * A server that answers every request with an HTML body, the way a proxy or
 * load balancer sitting in front of the real SCIM endpoint does when it
 * intercepts the request itself (an auth wall, a maintenance page, a 502
 * from the upstream being down) rather than passing it through.
 */
function startHtmlServer(status: number, body = '<html><body>not scim</body></html>'): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  let server: Server;
  return new Promise((resolve) => {
    server = createServer((_req, res) => {
      res.writeHead(status, { 'content-type': 'text/html' });
      res.end(body);
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res()))),
      });
    });
  });
}

let server: { baseUrl: string; close: () => Promise<void> } | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('scimRequest', () => {
  it('raises a classified error instead of throwing a raw SyntaxError on an HTML body', async () => {
    server = await startHtmlServer(502);
    const config = {
      ...scim2TargetConfigSchema.parse({ baseUrl: server.baseUrl, allowPrivateAddresses: true }),
      bearerToken: 't',
    };

    const failure = await scimRequest(config, 'GET', '/Users?startIndex=1&count=1').catch(
      (cause: unknown) => cause,
    );

    expect(failure).toBeInstanceOf(ScimMalformedBodyError);
    expect((failure as ScimMalformedBodyError).status).toBe(502);
    expect((failure as ScimMalformedBodyError).message).toMatch(/not JSON/);
  });
});

describe('scimTargetConnector.write against a non-JSON body', () => {
  const baseConfig = (baseUrl: string) => ({
    baseUrl,
    bearerToken: 't',
    userResourcePath: '/Users',
    groupResourcePath: '/Groups',
    pageSize: 200,
    connectTimeoutMs: 10_000,
    timeoutMs: 10_000,
    allowPrivateAddresses: true,
  });

  it('classifies an HTML 401 as unauthorized rather than a generic transient failure', async () => {
    server = await startHtmlServer(401, '<html>please sign in</html>');

    const result = await scimTargetConnector.write(baseConfig(server.baseUrl), {
      op: 'create_account',
      actionId: 'action-1',
      correlationKey: 'jdoe',
      attributes: {},
      enabled: true,
      initialPassword: 'S3cret!',
    });

    expect(result.ok).toBe(false);
    expect(result.failure).toBe('unauthorized');
  });

  it('classifies an HTML 500 as transient', async () => {
    server = await startHtmlServer(500, '<html>internal error</html>');

    const result = await scimTargetConnector.write(baseConfig(server.baseUrl), {
      op: 'create_account',
      actionId: 'action-1',
      correlationKey: 'jdoe',
      attributes: {},
      enabled: true,
      initialPassword: 'S3cret!',
    });

    expect(result.ok).toBe(false);
    expect(result.failure).toBe('transient');
  });
});
