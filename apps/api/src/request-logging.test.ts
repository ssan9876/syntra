import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { serializeRequest } from './request-logging.js';

describe('request logging', () => {
  it('keeps diagnostics without leaking query credentials, headers or bodies', async () => {
    const lines: string[] = [];
    const app = Fastify({ logger: {
      serializers: { req: serializeRequest },
      stream: { write: (line: string) => { lines.push(line); } },
    } });
    app.post('/federation/oidc/callback', async () => ({ ok: true }));
    try {
      await app.inject({
        method: 'POST',
        url: '/federation/oidc/callback?code=secret-code&state=secret-state',
        headers: { authorization: 'Bearer secret-token', cookie: 'syntra_session=secret-cookie' },
        payload: { password: 'secret-password' },
      });
      const logs = lines.join('');
      expect(logs).toContain('/federation/oidc/callback');
      expect(logs).toContain('POST');
      expect(logs).not.toContain('secret-');
      expect(lines.map((line) => JSON.parse(line)).find((line) => line.req)?.req.url)
        .toBe('/federation/oidc/callback');
    } finally {
      await app.close();
    }
  });
});
