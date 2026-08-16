import { beforeEach, describe, expect, it } from 'vitest';
import { createPublicKey, createVerify, X509Certificate } from 'node:crypto';
import { prisma, withTenant } from '@syntra/db';
import { resetDatabase } from '@syntra/db/src/test-support.js';
import { localMasterKeyProvider } from '../vault/master-key.js';
import {
  ensureActiveKey,
  loadActiveKey,
  publishedKeys,
  readSigningKeyPem,
  retireExpiredKeys,
  rotateKey,
} from './signing-key-service.js';

const provider = localMasterKeyProvider(Buffer.alloc(32, 7));
let tenantId: string;

beforeEach(async () => {
  await resetDatabase();
  const t = await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  tenantId = t.id;
});

describe('signing keys', () => {
  it('creates one on demand and returns the same one next time', async () => {
    const a = await ensureActiveKey(tenantId, provider, 'oidc');
    const b = await ensureActiveKey(tenantId, provider, 'oidc');
    expect(b.kid).toBe(a.kid);
    const rows = await withTenant(tenantId, (tx) => tx.signingKey.findMany());
    expect(rows).toHaveLength(1);
  });

  it('reports a vault failure as itself rather than as "another worker won"', async () => {
    // The insert is wrapped in a `try` so that losing the race against
    // `signing_key_one_active` re-reads instead of failing. It used to be a
    // bare `catch {}`, which swallowed everything: a vault write failure, a
    // dropped connection, a serialization failure — all reported as the race,
    // and then rethrown from the re-read below as the generic "could not
    // establish a … signing key", with the real fault discarded. That is the
    // one line an operator has to diagnose this from.
    const broken = {
      ...provider,
      wrap: async () => {
        throw new Error('vault is unreachable');
      },
    };
    await expect(ensureActiveKey(tenantId, broken, 'oidc')).rejects.toThrow(
      /vault is unreachable/,
    );
    const rows = await withTenant(tenantId, (tx) => tx.signingKey.findMany());
    expect(rows).toHaveLength(0);
  });

  it('never stores the private key on the row', async () => {
    const key = await ensureActiveKey(tenantId, provider, 'oidc');
    const row = await withTenant(tenantId, (tx) =>
      tx.signingKey.findFirstOrThrow({ where: { kid: key.kid } }),
    );
    // The row carries a vault reference, not the material. Serialised whole
    // it must contain nothing that looks like a private key.
    expect(JSON.stringify(row)).not.toContain('PRIVATE KEY');
    expect(row.secretName).toBe(`signing:oidc:${key.kid}`);
  });

  it('produces a private key whose signature verifies under the published JWK', async () => {
    const key = await ensureActiveKey(tenantId, provider, 'oidc');
    const message = Buffer.from('the assertion bytes');
    const signature = createVerify; // placeholder to keep the import honest
    void signature;
    const { createSign } = await import('node:crypto');
    const sig = createSign('RSA-SHA256').update(message).sign(key.privateKeyPem);
    const pub = createPublicKey({ key: key.publicJwk as never, format: 'jwk' });
    expect(createVerify('RSA-SHA256').update(message).verify(pub, sig)).toBe(true);
  });

  it('issues a self-signed certificate for the saml kind and none for oidc', async () => {
    const saml = await ensureActiveKey(tenantId, provider, 'saml', {
      commonName: 'sso.acme.test',
    });
    expect(saml.certificate).toMatch(/^-----BEGIN CERTIFICATE-----/);
    expect(new X509Certificate(saml.certificate!).subject).toContain('sso.acme.test');
    const oidc = await ensureActiveKey(tenantId, provider, 'oidc');
    expect(oidc.certificate).toBeNull();
  });

  it('publishes the outgoing key alongside the incoming one for the length of a rollover', async () => {
    const first = await ensureActiveKey(tenantId, provider, 'oidc');
    const { incoming, outgoing } = await rotateKey(tenantId, provider, 'oidc', {
      overlapMs: 60_000,
    });

    expect(incoming.kid).not.toBe(first.kid);
    expect(outgoing?.kid).toBe(first.kid);

    const published = await publishedKeys(tenantId, 'oidc');
    // Both, and the incoming one first — a relying party that takes the head
    // of the list must land on the key new tokens are signed with.
    expect(published.map((k) => k.kid)).toEqual([incoming.kid, first.kid]);
    expect(published.map((k) => k.status)).toEqual(['active', 'outgoing']);

    // And the one that signs is the new one.
    const live = await loadActiveKey(tenantId, provider, 'oidc');
    expect(live?.kid).toBe(incoming.kid);
  });

  it('stops publishing the outgoing key once the overlap has passed', async () => {
    await ensureActiveKey(tenantId, provider, 'oidc');
    const { outgoing } = await rotateKey(tenantId, provider, 'oidc', { overlapMs: 1000 });
    const later = new Date(Date.now() + 5000);

    const published = await publishedKeys(tenantId, 'oidc', later);
    expect(published.map((k) => k.kid)).not.toContain(outgoing!.kid);

    const retired = await retireExpiredKeys(tenantId, 'oidc', later);
    expect(retired).toBe(1);
    const row = await withTenant(tenantId, (tx) =>
      tx.signingKey.findFirstOrThrow({ where: { kid: outgoing!.kid } }),
    );
    expect(row.status).toBe('retired');
  });

  it('reads a published key private half by kid, and refuses a retired one', async () => {
    const first = await ensureActiveKey(tenantId, provider, 'oidc');
    const { outgoing } = await rotateKey(tenantId, provider, 'oidc', { overlapMs: 1000 });

    // Both published keys are readable during the rollover — the OIDC
    // provider signs with one and must still verify the other.
    expect(await readSigningKeyPem(tenantId, provider, 'oidc', first.kid))
      .toContain('PRIVATE KEY');
    expect(await readSigningKeyPem(tenantId, provider, 'oidc', outgoing!.kid))
      .toContain('PRIVATE KEY');

    await retireExpiredKeys(tenantId, 'oidc', new Date(Date.now() + 5000));
    // Retired means gone, not merely unpublished.
    expect(await readSigningKeyPem(tenantId, provider, 'oidc', outgoing!.kid)).toBeNull();
    expect(await readSigningKeyPem(tenantId, provider, 'oidc', 'no-such-kid')).toBeNull();
  });

  it('keeps two tenants keys apart', async () => {
    const other = await prisma.tenant.create({ data: { name: 'Beta', slug: 'beta' } });
    const a = await ensureActiveKey(tenantId, provider, 'oidc');
    const b = await ensureActiveKey(other.id, provider, 'oidc');
    expect(a.kid).not.toBe(b.kid);
    const seen = await publishedKeys(other.id, 'oidc');
    expect(seen.map((k) => k.kid)).toEqual([b.kid]);
  });
});
