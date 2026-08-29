import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createLocalJWKSet, decodeJwt, decodeProtectedHeader, exportJWK, jwtVerify } from 'jose';
import type { ActiveKey } from '../keys/signing-key-service.js';
import { BACKCHANNEL_EVENT, mintLogoutToken } from './logout-token.js';

const ISSUER = 'https://acme.test/oidc';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const key: ActiveKey = {
  kid: 'test-key-1',
  alg: 'RS256',
  status: 'active',
  publicJwk: {},
  certificate: null,
  notBefore: new Date(Date.now() - 1000),
  notAfter: new Date(Date.now() + 86_400_000),
  privateKeyPem,
};

const input = (over: Partial<Parameters<typeof mintLogoutToken>[0]> = {}) => ({
  issuer: ISSUER,
  audience: 'client-abc',
  subject: 'user-1',
  sessionId: 'sess-1',
  includeSid: false,
  ...over,
});

const jwks = async () =>
  createLocalJWKSet({
    keys: [{ ...(await exportJWK(publicKey)), kid: key.kid, alg: 'RS256' }],
  });

describe('mintLogoutToken', () => {
  it('carries the events claim the spec defines', async () => {
    // A relying party identifies a logout token by this claim and nothing
    // else. Without it the token is just a JWT it will refuse.
    const claims = decodeJwt(await mintLogoutToken(input(), key));

    expect(claims.events).toEqual({ [BACKCHANNEL_EVENT]: {} });
  });

  it('carries no nonce', async () => {
    // Section 2.4 PROHIBITS it, and requires a conforming relying party to
    // reject a logout token that has one -- so adding it out of symmetry with
    // the id token would fail against exactly the correct implementations.
    expect(decodeJwt(await mintLogoutToken(input(), key))).not.toHaveProperty('nonce');
  });

  it('verifies against the published key, for the right issuer and audience', async () => {
    const token = await mintLogoutToken(input(), key);

    const { payload } = await jwtVerify(token, await jwks(), {
      issuer: ISSUER,
      audience: 'client-abc',
    });

    expect(payload.sub).toBe('user-1');
    expect(payload.jti).toEqual(expect.any(String));
  });

  it('is refused by a relying party expecting a different audience', async () => {
    const token = await mintLogoutToken(input(), key);

    await expect(
      jwtVerify(token, await jwks(), { issuer: ISSUER, audience: 'somebody-else' }),
    ).rejects.toThrow();
  });

  it('names the key it was signed with, so a rotated JWKS still resolves it', async () => {
    const header = decodeProtectedHeader(await mintLogoutToken(input(), key));

    expect(header.kid).toBe('test-key-1');
    expect(header.typ).toBe('logout+jwt');
  });

  it('includes sid only when the client asked for it', async () => {
    // A client that did not ask has no session identifier of ours to match it
    // against, so sending one tells it nothing and names one of our sessions
    // in its logs.
    const withSid = await mintLogoutToken(input({ includeSid: true }), key);
    expect(decodeJwt(withSid).sid).toBe('sess-1');

    const without = await mintLogoutToken(input({ includeSid: false }), key);
    expect(decodeJwt(without)).not.toHaveProperty('sid');
  });

  it('omits sid when there is no session to name, even if the client asked', async () => {
    // A user-wide revocation ends every session at once and names none of
    // them. Inventing an identifier would be worse than omitting the claim.
    const token = await mintLogoutToken(
      input({ includeSid: true, sessionId: null }),
      key,
    );

    expect(decodeJwt(token)).not.toHaveProperty('sid');
  });

  it('expires quickly', async () => {
    const claims = decodeJwt(await mintLogoutToken(input(), key));

    const lifetime = claims.exp! - claims.iat!;
    expect(lifetime).toBeLessThanOrEqual(120);
  });

  it('gives every token its own jti', async () => {
    const a = decodeJwt(await mintLogoutToken(input(), key));
    const b = decodeJwt(await mintLogoutToken(input(), key));

    expect(a.jti).not.toBe(b.jti);
  });
});
