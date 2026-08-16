import { matchesAllowlist } from '@syntra/contracts';
import type { TenantClient } from '@syntra/db';
import { currentTenant } from '../tenant-context.js';

export type SamlBinding = 'HTTP-POST' | 'HTTP-Redirect';

export interface SamlConfigRecord {
  id: string;
  applicationId: string;
  spEntityId: string;
  acsUrls: string[];
  defaultAcsUrl: string | null;
  acsBinding: SamlBinding;
  nameIdFormat: string;
  nameIdClaim: string | null;
  spCertificates: string[];
  wantAuthnRequestsSigned: boolean;
  encryptAssertions: boolean;
  encryptionCertificate: string | null;
  sloUrl: string | null;
  sloBinding: SamlBinding;
  allowIdpInitiated: boolean;
  assertionLifetimeMs: number;
}

const asBinding = (value: string): SamlBinding =>
  value === 'HTTP-Redirect' ? 'HTTP-Redirect' : 'HTTP-POST';

const toRecord = (row: Record<string, unknown>): SamlConfigRecord => ({
  id: row.id as string,
  applicationId: row.applicationId as string,
  spEntityId: row.spEntityId as string,
  acsUrls: row.acsUrls as string[],
  defaultAcsUrl: (row.defaultAcsUrl as string | null) ?? null,
  acsBinding: asBinding(row.acsBinding as string),
  nameIdFormat: row.nameIdFormat as string,
  nameIdClaim: (row.nameIdClaim as string | null) ?? null,
  spCertificates: row.spCertificates as string[],
  wantAuthnRequestsSigned: row.wantAuthnRequestsSigned as boolean,
  encryptAssertions: row.encryptAssertions as boolean,
  encryptionCertificate: (row.encryptionCertificate as string | null) ?? null,
  sloUrl: (row.sloUrl as string | null) ?? null,
  sloBinding: asBinding(row.sloBinding as string),
  allowIdpInitiated: row.allowIdpInitiated as boolean,
  assertionLifetimeMs: row.assertionLifetimeMs as number,
});

export async function upsertSamlConfig(
  tx: TenantClient,
  applicationId: string,
  input: Omit<SamlConfigRecord, 'id' | 'applicationId'>,
): Promise<SamlConfigRecord> {
  const tenantId = await currentTenant(tx);
  const data = { tenantId, applicationId, ...input };
  const row = await tx.samlConfig.upsert({
    where: { applicationId },
    create: data,
    update: input,
  });
  return toRecord(row as unknown as Record<string, unknown>);
}

export async function findSamlConfigByEntityId(
  tx: TenantClient,
  spEntityId: string,
): Promise<SamlConfigRecord | null> {
  const row = await tx.samlConfig.findFirst({ where: { spEntityId } });
  return row ? toRecord(row as unknown as Record<string, unknown>) : null;
}

export async function findSamlConfigForApplication(
  tx: TenantClient,
  applicationId: string,
): Promise<SamlConfigRecord | null> {
  const row = await tx.samlConfig.findUnique({ where: { applicationId } });
  return row ? toRecord(row as unknown as Record<string, unknown>) : null;
}

/**
 * The address an assertion may be delivered to, or null.
 *
 * A requested URL is honoured only if it is byte-identical to one on the
 * allowlist. This is the SAML half of spec section 7's allowlisting
 * requirement, and it is the control that stops an AuthnRequest naming
 * `AssertionConsumerServiceURL="https://attacker.test/"` from having Syntra
 * post a valid, signed assertion for a real user straight to the attacker.
 *
 * A request that names no ACS URL uses `defaultAcsUrl`, and if there is none
 * it resolves to null and the flow refuses.
 *
 * THERE IS DELIBERATELY NO FALL BACK TO `acsUrls[0]`. An earlier draft had
 * one, and it fails in a way nobody would notice: the allowlist is an
 * unordered set as far as an administrator is concerned, and metadata import
 * rewrites it wholesale from whatever order the service provider's document
 * happened to list its endpoints in. A reordered import would silently change
 * where unsolicited assertions are delivered, with no write, no audit event
 * and nothing on screen. Choosing the default is a decision, so it is made
 * once at write time where it is visible and audited — `parseSpMetadata`
 * records the SP's own `isDefault="true"` entry, and the admin schema refuses
 * a default that is not on the allowlist.
 */
export function resolveAcsUrl(
  config: SamlConfigRecord,
  requested: string | null,
): string | null {
  if (requested !== null && requested !== '') {
    return matchesAllowlist(requested, config.acsUrls) ? requested : null;
  }
  if (config.defaultAcsUrl && matchesAllowlist(config.defaultAcsUrl, config.acsUrls)) {
    return config.defaultAcsUrl;
  }
  return null;
}
