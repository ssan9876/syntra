import { describe, expect, it } from 'vitest';
import { MemoryNonceStore, signRequest, verifyRequest } from './signing.js';

const secret = 's'.repeat(40);
const now = 1_800_000_000_000;

function verify(overrides: Partial<Parameters<typeof verifyRequest>[0]> = {}, signed = signRequest(secret, 'write', '{"a":1}', { now })) {
  return verifyRequest({
    secrets: [secret],
    method: 'write',
    body: '{"a":1}',
    timestamp: signed.timestamp,
    nonce: signed.nonce,
    signature: signed.signature,
    nonces: new MemoryNonceStore(),
    now,
    ...overrides,
  });
}

describe('request signing', () => {
  it('accepts a request signed with the shared secret', async () => {
    expect(await verify()).toEqual({ ok: true });
  });

  it('refuses a missing signature', async () => {
    expect(await verify({ signature: undefined })).toEqual({ ok: false, message: 'Request is not signed.' });
  });

  it('refuses a request signed with another secret', async () => {
    const signed = signRequest('t'.repeat(40), 'write', '{"a":1}', { now });
    expect(await verify({}, signed)).toEqual({ ok: false, message: 'Request signature does not match.' });
  });

  it('refuses a body or method changed after signing', async () => {
    expect((await verify({ body: '{"a":2}' })).ok).toBe(false);
    expect((await verify({ method: 'test' })).ok).toBe(false);
  });

  it('refuses a timestamp outside the window and says how far off it is', async () => {
    const result = await verify({ now: now + 301_000 });
    expect(result).toEqual({
      ok: false,
      message: "Request timestamp is 301 s from this service's clock (limit 300 s). Check both clocks.",
    });
  });

  it('refuses the same nonce twice', async () => {
    const nonces = new MemoryNonceStore(10, () => now);
    const signed = signRequest(secret, 'write', '{"a":1}', { now });
    expect(await verify({ nonces }, signed)).toEqual({ ok: true });
    expect(await verify({ nonces }, signed)).toEqual({ ok: false, message: 'Request nonce was already used.' });
  });

  it('accepts the previous secret during a rotation', async () => {
    const signed = signRequest('old'.repeat(12), 'write', '{"a":1}', { now });
    expect(await verify({ secrets: [secret, 'old'.repeat(12)] }, signed)).toEqual({ ok: true });
  });

  it('forgets nonces whose window has passed', () => {
    let clock = now;
    const store = new MemoryNonceStore(2, () => clock);
    expect(store.claim('a', now + 1000)).toBe(true);
    expect(store.claim('b', now + 1000)).toBe(true);
    clock = now + 2000;
    expect(store.claim('c', now + 5000)).toBe(true);
    expect(store.claim('a', now + 5000)).toBe(true);
  });
});
