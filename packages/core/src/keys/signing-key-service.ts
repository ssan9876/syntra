import 'reflect-metadata';
import * as x509 from '@peculiar/x509';
import {
  createPrivateKey,
  createPublicKey,
  randomUUID,
  webcrypto,
} from 'node:crypto';
import { calculateJwkThumbprint, exportJWK } from 'jose';
import { withTenant, type TenantClient } from '@syntra/db';
import { getSecret, putSecret } from '../vault/vault-service.js';
import type { MasterKeyProvider } from '../vault/master-key.js';

x509.cryptoProvider.set(webcrypto as unknown as webcrypto.Crypto);

export type KeyKind = 'oidc' | 'saml';

const ALG = {
  name: 'RSASSA-PKCS1-v1_5',
  hash: 'SHA-256',
  publicExponent: new Uint8Array([1, 0, 1]),
  modulusLength: 2048,
} as const;

/** Three years. A SAML SP typically pins the certificate for its lifetime. */
const LIFETIME_MS = 3 * 365 * 24 * 60 * 60 * 1000;
/** How long an outgoing key stays published by default. */
const DEFAULT_OVERLAP_MS = 7 * 24 * 60 * 60 * 1000;

export interface PublishedKey {
  kid: string;
  alg: string;
  status: 'active' | 'outgoing';
  publicJwk: Record<string, unknown>;
  certificate: string | null;
  notBefore: Date;
  notAfter: Date;
}

export interface ActiveKey extends PublishedKey {
  status: 'active';
  /** PKCS#8 PEM, read from the vault. Never stored on the row. */
  privateKeyPem: string;
}

interface GeneratedKey {
  kid: string;
  publicJwk: Record<string, unknown>;
  privateKeyPem: string;
  certificate: string | null;
  notBefore: Date;
  notAfter: Date;
}

/**
 * Generates a key pair and, for SAML, a self-signed certificate.
 *
 * Deliberately outside any transaction and called before one opens. RSA-2048
 * generation is hundreds of milliseconds and certificate signing is more;
 * inside `withTenant` that is a meaningful fraction of Prisma's 5000 ms
 * interactive-transaction budget, spent on work that touches no row.
 */
async function generate(
  kind: KeyKind,
  commonName: string,
  now: Date,
): Promise<GeneratedKey> {
  const keys = (await webcrypto.subtle.generateKey(ALG, true, [
    'sign',
    'verify',
  ])) as webcrypto.CryptoKeyPair;

  const pkcs8 = Buffer.from(
    await webcrypto.subtle.exportKey('pkcs8', keys.privateKey),
  );
  const privateKeyObject = createPrivateKey({
    key: pkcs8,
    format: 'der',
    type: 'pkcs8',
  });
  const privateKeyPem = privateKeyObject
    .export({ type: 'pkcs8', format: 'pem' })
    .toString();

  const jwk = (await exportJWK(createPublicKey(privateKeyObject))) as Record<
    string,
    unknown
  >;
  // RFC 7638 over the public members only, so the kid is stable and carries
  // no secret. jose refuses to thumbprint a JWK holding private members,
  // which is the check that would catch exporting the wrong key here.
  const kid = await calculateJwkThumbprint(jwk as never, 'sha256');
  const publicJwk = { ...jwk, kid, alg: 'RS256', use: 'sig' };

  const notBefore = new Date(now.getTime() - 60_000);
  const notAfter = new Date(now.getTime() + LIFETIME_MS);

  let certificate: string | null = null;
  if (kind === 'saml') {
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: randomUUID().replace(/-/g, ''),
      name: `CN=${commonName}`,
      notBefore,
      notAfter,
      signingAlgorithm: ALG,
      keys,
      extensions: [new x509.BasicConstraintsExtension(false, undefined, true)],
    });
    certificate = cert.toString('pem');
  }

  return { kid, publicJwk, privateKeyPem, certificate, notBefore, notAfter };
}

const secretNameFor = (kind: KeyKind, kid: string) => `signing:${kind}:${kid}`;

async function insert(
  tx: TenantClient,
  tenantId: string,
  kind: KeyKind,
  generated: GeneratedKey,
  provider: MasterKeyProvider,
  status: 'active',
): Promise<void> {
  const secretName = secretNameFor(kind, generated.kid);
  // The material goes to the vault and the row gets only its name. AES-GCM
  // wrapping is microseconds, so this one belongs inside the transaction:
  // a row that names a secret which was never written is a key that cannot
  // sign, and the two must commit together.
  await putSecret(tx, provider, secretName, generated.privateKeyPem);
  await tx.signingKey.create({
    data: {
      tenantId,
      kind,
      kid: generated.kid,
      alg: 'RS256',
      publicJwk: generated.publicJwk as never,
      certificate: generated.certificate,
      secretName,
      status,
      notBefore: generated.notBefore,
      notAfter: generated.notAfter,
    },
  });
}

const toPublished = (row: {
  kid: string;
  alg: string;
  status: string;
  publicJwk: unknown;
  certificate: string | null;
  notBefore: Date;
  notAfter: Date;
}): PublishedKey => ({
  kid: row.kid,
  alg: row.alg,
  status: row.status === 'outgoing' ? 'outgoing' : 'active',
  publicJwk: row.publicJwk as Record<string, unknown>,
  certificate: row.certificate,
  notBefore: row.notBefore,
  notAfter: row.notAfter,
});

/** The active key, with its private material, or null if there is none. */
export async function loadActiveKey(
  tenantId: string,
  provider: MasterKeyProvider,
  kind: KeyKind,
): Promise<ActiveKey | null> {
  return withTenant(tenantId, async (tx) => {
    const row = await tx.signingKey.findFirst({
      where: { kind, status: 'active' },
    });
    if (!row) return null;
    const privateKeyPem = await getSecret(tx, provider, row.secretName);
    if (!privateKeyPem) {
      throw new Error(
        `signing key ${row.kid} names vault secret ${row.secretName}, which does not exist`,
      );
    }
    return { ...toPublished(row), status: 'active' as const, privateKeyPem };
  });
}

/**
 * The active key, creating one if the tenant has none.
 *
 * Generation happens outside the transaction; the insert races only against
 * another process doing the same thing, and `signing_key_one_active` decides
 * that race. The loser re-reads rather than failing, so a first sign-in that
 * arrives on two workers at once still signs.
 */
export async function ensureActiveKey(
  tenantId: string,
  provider: MasterKeyProvider,
  kind: KeyKind,
  opts: { commonName?: string; now?: Date } = {},
): Promise<ActiveKey> {
  const existing = await loadActiveKey(tenantId, provider, kind);
  if (existing) return existing;

  const generated = await generate(
    kind,
    opts.commonName ?? 'syntra',
    opts.now ?? new Date(),
  );

  try {
    await withTenant(tenantId, (tx) =>
      insert(tx, tenantId, kind, generated, provider, 'active'),
    );
  } catch {
    // Another worker won. Its key is as good as this one.
  }

  const active = await loadActiveKey(tenantId, provider, kind);
  if (!active) throw new Error(`could not establish a ${kind} signing key`);
  return active;
}

/**
 * What the JWKS document and the SAML metadata publish: the active key, and
 * the outgoing one while its overlap is still running.
 *
 * Ordered active-first. A relying party that caches by `kid` reads both; one
 * that naively takes the first key must land on the one new tokens are signed
 * with, or every fresh token fails validation for the length of the rollover.
 */
export async function publishedKeys(
  tenantId: string,
  kind: KeyKind,
  now: Date = new Date(),
): Promise<PublishedKey[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.signingKey.findMany({
      where: {
        kind,
        OR: [
          { status: 'active' },
          { status: 'outgoing', notAfter: { gt: now } },
        ],
      },
    });
    return rows
      .map(toPublished)
      .sort((a, b) => (a.status === b.status ? 0 : a.status === 'active' ? -1 : 1));
  });
}

/**
 * Rolls the key over.
 *
 * The old key becomes `outgoing` and its `notAfter` is pulled in to the end of
 * the overlap window, which is what `publishedKeys` filters on. Spec section 7
 * asks for the outgoing key to be published alongside the incoming one for the
 * duration of the rollover; this is that duration, written on the row rather
 * than held in a scheduler's memory, so a restart mid-rollover does not drop
 * the old key and invalidate every token in flight.
 */
export async function rotateKey(
  tenantId: string,
  provider: MasterKeyProvider,
  kind: KeyKind,
  opts: { overlapMs?: number; commonName?: string; now?: Date } = {},
): Promise<{ incoming: ActiveKey; outgoing: PublishedKey | null }> {
  const now = opts.now ?? new Date();
  const overlapMs = opts.overlapMs ?? DEFAULT_OVERLAP_MS;
  const generated = await generate(kind, opts.commonName ?? 'syntra', now);

  const outgoing = await withTenant(tenantId, async (tx) => {
    const previous = await tx.signingKey.findFirst({
      where: { kind, status: 'active' },
    });
    if (previous) {
      await tx.signingKey.update({
        where: { id: previous.id },
        data: {
          status: 'outgoing',
          notAfter: new Date(now.getTime() + overlapMs),
        },
      });
    }
    // Only after the previous row has left 'active' — signing_key_one_active
    // is what makes this ordering load-bearing rather than stylistic.
    await insert(tx, tenantId, kind, generated, provider, 'active');
    return previous
      ? toPublished({
          ...previous,
          status: 'outgoing',
          notAfter: new Date(now.getTime() + overlapMs),
        })
      : null;
  });

  const incoming = await loadActiveKey(tenantId, provider, kind);
  if (!incoming) throw new Error('rotation left no active key');
  return { incoming, outgoing };
}

/**
 * The private PEM for one published key, named by its kid.
 *
 * Null once the key is retired, so a rollover that has finished cannot be
 * talked into signing with the old material. Task 11's OIDC provider needs
 * every *published* key's private half — it signs with the active one and must
 * still be able to verify a token signed with the outgoing one — which is the
 * one caller `loadActiveKey` cannot serve.
 */
export async function readSigningKeyPem(
  tenantId: string,
  provider: MasterKeyProvider,
  kind: KeyKind,
  kid: string,
): Promise<string | null> {
  return withTenant(tenantId, async (tx) => {
    const row = await tx.signingKey.findFirst({ where: { kind, kid } });
    if (!row || row.status === 'retired') return null;
    return getSecret(tx, provider, row.secretName);
  });
}

/** Marks overlapped-out keys retired. Returns how many. */
export async function retireExpiredKeys(
  tenantId: string,
  kind: KeyKind,
  now: Date = new Date(),
): Promise<number> {
  return withTenant(tenantId, async (tx) => {
    const result = await tx.signingKey.updateMany({
      where: { kind, status: 'outgoing', notAfter: { lte: now } },
      data: { status: 'retired', retiredAt: now },
    });
    return result.count;
  });
}
