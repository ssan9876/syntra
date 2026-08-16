import { afterEach, describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair } from 'jose';
import { invalidateAllProviders, providerFor } from './provider-factory.js';
import {
  SYNTRA_DECISION_KEY,
  syntraAuthorizePrompt,
  syntraInteractionPolicy,
} from './interaction-prompt.js';

afterEach(() => invalidateAllProviders());

const deps = async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = await exportJWK(privateKey);
  void publicKey;
  return {
    findAccount: async () => ({ accountId: 'u1', claims: { email: 'j@acme.test' } }),
    loadClients: async () => [
      {
        client_id: 'crm',
        client_secret: 'not-used-here',
        redirect_uris: ['https://crm.acme.test/cb'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      },
    ],
    jwks: async () => ({ keys: [{ ...jwk, alg: 'RS256', use: 'sig' }] }),
    interactionUrl: (uid: string) => `/oidc/interaction/${uid}`,
    cookieKeys: ['k'.repeat(32)],
  };
};

describe('providerFor', () => {
  it('constructs with the issuer it is given and caches per tenant', async () => {
    const d = await deps();
    const a = await providerFor('t1', 'https://sso.acme.test/oidc', d);
    const again = await providerFor('t1', 'https://sso.acme.test/oidc', d);
    const other = await providerFor('t2', 'https://sso.beta.test/oidc', d);

    expect(a.issuer).toBe('https://sso.acme.test/oidc');
    expect(again).toBe(a);
    // Two tenants, two issuers, two instances. One shared Provider could
    // publish only one `iss`, and a relying party checks it.
    expect(other).not.toBe(a);
    expect(other.issuer).toBe('https://sso.beta.test/oidc');
  });

  it('refuses an issuer that is not a web URI rather than starting with a broken one', async () => {
    const d = await deps();
    await expect(providerFor('t3', 'not-a-url', d)).rejects.toThrow();
    // And a failed build is not cached, so fixing the configuration works
    // without a restart.
    await expect(providerFor('t3', 'https://ok.test/oidc', d)).resolves.toBeDefined();
  });
});

describe('syntraAuthorizePrompt', () => {
  const prompt = syntraAuthorizePrompt();
  const check = prompt.checks[0]!;

  const ctx = (result: unknown, clientId: string) =>
    ({ oidc: { result, client: { clientId } } }) as never;

  it('requests the prompt when no Syntra decision is present', () => {
    expect(check.check(ctx(undefined, 'crm'))).toBe(true);
    expect(check.check(ctx({}, 'crm'))).toBe(true);
  });

  it('requests the prompt when a decision names a different client', () => {
    // Otherwise one launch of a low-risk application would satisfy the
    // requirement for a high-risk one in the same browser session.
    expect(
      check.check(ctx({ [SYNTRA_DECISION_KEY]: { clientId: 'other' } }, 'crm')),
    ).toBe(true);
  });

  it('lets the request through only when this interaction carries a decision for this client', () => {
    expect(
      check.check(ctx({ [SYNTRA_DECISION_KEY]: { clientId: 'crm' } }, 'crm')),
    ).toBe(false);
  });

  it('is first in the policy, ahead of the built-in login prompt', () => {
    const policy = syntraInteractionPolicy();
    expect(policy[0]!.name).toBe('syntra_authorize');
    expect(policy.map((p: { name: string }) => p.name)).toContain('login');
  });
});
