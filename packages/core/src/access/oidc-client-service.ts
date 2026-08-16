import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { matchesAllowlist } from '@syntra/contracts';
import { withTenant, type TenantClient } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';

export interface OidcClientRecord {
  id: string;
  applicationId: string;
  clientId: string;
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  grantTypes: string[];
  scopes: string[];
  requirePkce: boolean;
  /** See ruling A2-5. Off unless an administrator turned it on. */
  clientCredentialsEnabled: boolean;
  tokenEndpointAuthMethod: string;
  idTokenSignedResponseAlg: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
}

/**
 * SHA-256, deliberately not Argon2id.
 *
 * A client secret is 256 bits drawn from `randomBytes` — it is not a human
 * password and there is no dictionary to grind. A memory-hard KDF buys nothing
 * against a uniformly random 256-bit secret, and it costs something real: the
 * token endpoint verifies a secret on **every** token request, and Argon2id
 * there is both a latency floor on every client and, if anyone ever moved the
 * verification inside a transaction, a direct violation of Global Constraint
 * 1. The comparison below is constant-time so the hash is not a timing oracle.
 *
 * This reasoning does not transfer to `PasswordCredential`, which stays
 * Argon2id, because a human-chosen password is exactly the case a memory-hard
 * KDF exists for.
 */
export function hashClientSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

const toRecord = (row: Record<string, unknown>): OidcClientRecord => ({
  id: row.id as string,
  applicationId: row.applicationId as string,
  clientId: row.clientId as string,
  redirectUris: row.redirectUris as string[],
  postLogoutRedirectUris: row.postLogoutRedirectUris as string[],
  grantTypes: row.grantTypes as string[],
  scopes: row.scopes as string[],
  requirePkce: row.requirePkce as boolean,
  clientCredentialsEnabled: row.clientCredentialsEnabled as boolean,
  tokenEndpointAuthMethod: row.tokenEndpointAuthMethod as string,
  idTokenSignedResponseAlg: row.idTokenSignedResponseAlg as string,
  accessTokenTtlSeconds: row.accessTokenTtlSeconds as number,
  refreshTokenTtlSeconds: row.refreshTokenTtlSeconds as number,
});

/**
 * Creates or updates a client. A new secret is returned exactly once and never
 * again — spec section 12 says a secret, once written, is replaced rather than
 * read back.
 */
export async function upsertOidcClient(
  tx: TenantClient,
  applicationId: string,
  input: Omit<OidcClientRecord, 'id' | 'applicationId'> & { rotateSecret?: boolean },
): Promise<{ record: OidcClientRecord; clientSecret: string | null }> {
  const tenantId = await currentTenant(tx);
  const existing = await tx.oidcClient.findUnique({ where: { applicationId } });

  const clientSecret =
    !existing || input.rotateSecret ? randomBytes(32).toString('base64url') : null;

  const { rotateSecret: _ignored, ...fields } = input;
  const data = {
    ...fields,
    ...(clientSecret ? { clientSecretHash: hashClientSecret(clientSecret) } : {}),
  };

  const row = await tx.oidcClient.upsert({
    where: { applicationId },
    create: { tenantId, applicationId, ...data, clientSecretHash: hashClientSecret(clientSecret!) },
    update: data,
  });

  return { record: toRecord(row as unknown as Record<string, unknown>), clientSecret };
}

export async function findOidcClient(
  tenantId: string,
  clientId: string,
): Promise<OidcClientRecord | null> {
  return withTenant(tenantId, async (tx) => {
    const row = await tx.oidcClient.findFirst({ where: { clientId } });
    return row ? toRecord(row as unknown as Record<string, unknown>) : null;
  });
}

export async function listOidcClients(tenantId: string): Promise<OidcClientRecord[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.oidcClient.findMany();
    return rows.map((row) => toRecord(row as unknown as Record<string, unknown>));
  });
}

/** Constant-time. A length mismatch is answered false without comparing. */
export async function verifyClientSecret(
  tenantId: string,
  clientId: string,
  presented: string,
): Promise<boolean> {
  return withTenant(tenantId, async (tx) => {
    const row = await tx.oidcClient.findFirst({ where: { clientId } });
    if (!row) return false;
    const expected = Buffer.from(row.clientSecretHash, 'utf8');
    const actual = Buffer.from(hashClientSecret(presented), 'utf8');
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  });
}

/**
 * Whether a redirect URI is registered for this client.
 *
 * Exact string equality, via `matchesAllowlist`. `oidc-provider` performs the
 * same check itself with the `redirect_uris` this service feeds it; this
 * function exists for the RP-initiated logout path and the admin API, so
 * there is exactly one answer to the question in the codebase.
 */
export function isRegisteredRedirectUri(
  client: OidcClientRecord,
  candidate: string,
): boolean {
  return matchesAllowlist(candidate, client.redirectUris);
}

export function isRegisteredPostLogoutUri(
  client: OidcClientRecord,
  candidate: string,
): boolean {
  return matchesAllowlist(candidate, client.postLogoutRedirectUris);
}
