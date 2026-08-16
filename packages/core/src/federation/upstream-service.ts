import { withTenant, type TenantClient } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';
import { getSecret, putSecret } from '../vault/vault-service.js';
import type { MasterKeyProvider } from '../vault/master-key.js';

export type UpstreamProtocol = 'saml' | 'oidc';

export interface UpstreamIdpRecord {
  id: string;
  slug: string;
  name: string;
  protocol: UpstreamProtocol;
  enabled: boolean;
  issuerUrl: string | null;
  clientId: string | null;
  scopes: string[];
  idpEntityId: string | null;
  ssoUrl: string | null;
  idpSloUrl: string | null;
  ssoBinding: 'HTTP-Redirect' | 'HTTP-POST';
  idpCertificates: string[];
  wantAssertionsSigned: boolean;
  loginAttribute: string;
  emailAttribute: string;
  displayNameAttribute: string;
  groupsAttribute: string | null;
  createUsers: boolean;
  refreshOnLogin: boolean;
  defaultOrgUnitId: string | null;
}

const toRecord = (row: Record<string, unknown>): UpstreamIdpRecord => ({
  id: row.id as string,
  slug: row.slug as string,
  name: row.name as string,
  protocol: row.protocol === 'saml' ? 'saml' : 'oidc',
  enabled: row.enabled as boolean,
  issuerUrl: (row.issuerUrl as string | null) ?? null,
  clientId: (row.clientId as string | null) ?? null,
  scopes: row.scopes as string[],
  idpEntityId: (row.idpEntityId as string | null) ?? null,
  ssoUrl: (row.ssoUrl as string | null) ?? null,
  idpSloUrl: (row.idpSloUrl as string | null) ?? null,
  ssoBinding: row.ssoBinding === 'HTTP-POST' ? 'HTTP-POST' : 'HTTP-Redirect',
  idpCertificates: row.idpCertificates as string[],
  wantAssertionsSigned: row.wantAssertionsSigned as boolean,
  loginAttribute: row.loginAttribute as string,
  emailAttribute: row.emailAttribute as string,
  displayNameAttribute: row.displayNameAttribute as string,
  groupsAttribute: (row.groupsAttribute as string | null) ?? null,
  createUsers: row.createUsers as boolean,
  refreshOnLogin: row.refreshOnLogin as boolean,
  defaultOrgUnitId: (row.defaultOrgUnitId as string | null) ?? null,
});

export type UpstreamInput = Omit<UpstreamIdpRecord, 'id'> & {
  /** Written to the vault, never to a column. */
  clientSecret?: string | undefined;
};

export async function upsertUpstream(
  tx: TenantClient,
  provider: MasterKeyProvider,
  input: UpstreamInput,
): Promise<UpstreamIdpRecord> {
  const tenantId = await currentTenant(tx);
  const { clientSecret, ...fields } = input;
  const secretName = `upstream:${input.slug}:client_secret`;

  if (clientSecret !== undefined) {
    // AES-GCM wrapping only — microseconds, so it belongs inside the same
    // transaction as the row that names it. A row naming a secret that was
    // never written is an upstream that cannot complete a token exchange.
    await putSecret(tx, provider, secretName, clientSecret);
  }

  const row = await tx.upstreamIdp.upsert({
    where: { tenantId_slug: { tenantId, slug: input.slug } },
    create: {
      tenantId,
      ...fields,
      ...(clientSecret !== undefined ? { clientSecretName: secretName } : {}),
    },
    update: {
      ...fields,
      ...(clientSecret !== undefined ? { clientSecretName: secretName } : {}),
    },
  });
  return toRecord(row as unknown as Record<string, unknown>);
}

export async function listUpstreams(tx: TenantClient): Promise<UpstreamIdpRecord[]> {
  const rows = await tx.upstreamIdp.findMany({ orderBy: { name: 'asc' } });
  return rows.map((row) => toRecord(row as unknown as Record<string, unknown>));
}

export async function findUpstream(
  tenantId: string,
  id: string,
): Promise<UpstreamIdpRecord | null> {
  return withTenant(tenantId, async (tx) => {
    const row = await tx.upstreamIdp.findFirst({ where: { id, enabled: true } });
    return row ? toRecord(row as unknown as Record<string, unknown>) : null;
  });
}

export async function findUpstreamBySlug(
  tenantId: string,
  slug: string,
): Promise<UpstreamIdpRecord | null> {
  return withTenant(tenantId, async (tx) => {
    const row = await tx.upstreamIdp.findFirst({ where: { slug, enabled: true } });
    return row ? toRecord(row as unknown as Record<string, unknown>) : null;
  });
}

/** Internal only. No route returns this value. */
export async function upstreamClientSecret(
  tenantId: string,
  provider: MasterKeyProvider,
  upstreamId: string,
): Promise<string | null> {
  return withTenant(tenantId, async (tx) => {
    const row = await tx.upstreamIdp.findUnique({ where: { id: upstreamId } });
    if (!row?.clientSecretName) return null;
    return getSecret(tx, provider, row.clientSecretName);
  });
}
