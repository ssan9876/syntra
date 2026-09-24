import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { describeWrappedKey } from './master-key.js';
import { vaultTransitProvider, type VaultTransitOptions } from './vault-transit.js';

/**
 * The provider's HTTP behaviour against a small in-process Transit: paths,
 * headers, AppRole login and renewal, AAD, and what an error says. Whether a
 * REAL Vault authenticates the AAD is the integration test's to prove
 * (vault-transit.integration.test.ts); this file proves what we send.
 */
const tenantA = { tenantId: '11111111-1111-4111-8111-111111111111' };

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function fakeTransit() {
  const key = randomBytes(32);
  const seen: Seen[] = [];
  const state = { tokens: new Set(['root-token']), logins: 0, down: false, forbidNext: false };

  const answer = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = init!.headers as Record<string, string>;
    const body = JSON.parse(String(init!.body)) as Record<string, unknown>;
    seen.push({ url, headers, body });
    if (state.down) throw new TypeError('fetch failed');

    if (url.endsWith('/v1/auth/approle/login')) {
      if (body.role_id !== 'role' || body.secret_id !== 'secret') return answer(400, { errors: ['invalid role or secret ID'] });
      state.logins += 1;
      const token = `approle-token-${state.logins}`;
      state.tokens.add(token);
      return answer(200, { auth: { client_token: token, lease_duration: 3600 } });
    }
    if (state.forbidNext) {
      state.forbidNext = false;
      return answer(403, { errors: ['permission denied'] });
    }
    if (!state.tokens.has(headers['x-vault-token'] ?? '')) return answer(403, { errors: ['permission denied'] });

    const aad = body.associated_data ? Buffer.from(String(body.associated_data), 'base64') : Buffer.alloc(0);
    if (url.endsWith('/v1/transit/encrypt/syntra')) {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', key, iv);
      c.setAAD(aad);
      const ct = Buffer.concat([c.update(Buffer.from(String(body.plaintext), 'base64')), c.final()]);
      return answer(200, { data: { ciphertext: `vault:v1:${Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64')}`, key_version: 1 } });
    }
    if (url.endsWith('/v1/transit/decrypt/syntra')) {
      const raw = Buffer.from(String(body.ciphertext).slice('vault:v1:'.length), 'base64');
      const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
      d.setAAD(aad);
      d.setAuthTag(raw.subarray(12, 28));
      try {
        const pt = Buffer.concat([d.update(raw.subarray(28)), d.final()]);
        return answer(200, { data: { plaintext: pt.toString('base64') } });
      } catch {
        return answer(400, { errors: ['cipher: message authentication failed'] });
      }
    }
    return answer(404, { errors: ['no handler for route'] });
  }) as typeof globalThis.fetch;

  return { fetch, seen, state };
}

const options = (fetch: typeof globalThis.fetch, over: Partial<VaultTransitOptions> = {}): VaultTransitOptions => ({
  address: 'http://vault.test:8200/',
  keyName: 'syntra',
  mountPath: 'transit',
  auth: { method: 'token', token: 'root-token' },
  timeoutMs: 1000,
  fetch,
  ...over,
});

describe('vaultTransitProvider', () => {
  it('encrypts and decrypts through transit/<op>/<key>, with the token and the tenant as AAD', async () => {
    const vault = fakeTransit();
    const provider = vaultTransitProvider(options(vault.fetch, { namespace: 'admin/syntra' }));
    const dek = randomBytes(32);
    const wrapped = await provider.wrap(dek, tenantA);
    const back = await provider.unwrap(wrapped, tenantA);

    expect(back.equals(dek)).toBe(true);
    expect(vault.seen.map((s) => s.url)).toEqual([
      'http://vault.test:8200/v1/transit/encrypt/syntra',
      'http://vault.test:8200/v1/transit/decrypt/syntra',
    ]);
    expect(vault.seen[0]!.headers['x-vault-token']).toBe('root-token');
    expect(vault.seen[0]!.headers['x-vault-namespace']).toBe('admin/syntra');
    expect(Buffer.from(String(vault.seen[0]!.body.associated_data), 'base64').toString()).toBe(
      `syntra-tenant:${tenantA.tenantId}`,
    );
    expect(describeWrappedKey(wrapped)).toBe('vault-transit:syntra:v1');
  });

  it('logs in with AppRole once, and again after a 403', async () => {
    const vault = fakeTransit();
    const provider = vaultTransitProvider(
      options(vault.fetch, { auth: { method: 'approle', roleId: 'role', secretId: 'secret', mountPath: 'approle' } }),
    );
    // A burst at startup is one login, not one per request.
    await Promise.all([provider.check(), provider.check(), provider.check()]);
    expect(vault.state.logins).toBe(1);

    vault.state.forbidNext = true;
    await provider.check();
    expect(vault.state.logins).toBe(2);
    expect(vault.seen.at(-1)!.headers['x-vault-token']).toBe('approle-token-2');
  });

  it('refuses a data key presented under the wrong tenant', async () => {
    const vault = fakeTransit();
    const provider = vaultTransitProvider(options(vault.fetch));
    const wrapped = await provider.wrap(randomBytes(32), tenantA);
    await expect(
      provider.unwrap(wrapped, { tenantId: '22222222-2222-4222-8222-222222222222' }),
    ).rejects.toThrow(/HTTP 400: cipher: message authentication failed/);
  });

  it('names the address when Vault does not answer, and never the key', async () => {
    const vault = fakeTransit();
    const provider = vaultTransitProvider(options(vault.fetch));
    vault.state.down = true;
    const dek = randomBytes(32);
    const error = (await provider.wrap(dek, tenantA).catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(/vault-transit: http:\/\/vault.test:8200 did not answer/);
    expect(error.message).not.toContain(dek.toString('base64'));
    await expect(provider.check()).rejects.toThrow(/did not answer/);
  });

  it('reports a revoked token as Vault said it', async () => {
    const vault = fakeTransit();
    const provider = vaultTransitProvider(options(vault.fetch, { auth: { method: 'token', token: 'revoked' } }));
    await expect(provider.check()).rejects.toThrow(/HTTP 403: permission denied/);
  });

  it('does not send another provider\'s row to Vault', async () => {
    const vault = fakeTransit();
    const provider = vaultTransitProvider(options(vault.fetch));
    const local = { ciphertext: randomBytes(32), iv: randomBytes(12), tag: randomBytes(16) };
    expect(provider.recognizes(local)).toBe(false);
    await expect(provider.unwrap(local, tenantA)).rejects.toThrow(/not wrapped by Vault Transit/);
    expect(vault.seen).toEqual([]);
  });
});
