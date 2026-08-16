import { matchesAllowlist } from '@syntra/contracts';
import { withTenant, type TenantClient } from '@syntra/db';
import { ensureActiveKey } from '../keys/signing-key-service.js';
import type { MasterKeyProvider } from '../vault/master-key.js';
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

/**
 * What a caller writes. Everything on the record except the identifiers, and
 * `wantAuthnRequestsSigned` is optional.
 *
 * It is the one field where saying nothing has to mean the safe answer rather
 * than a compile error, because "say nothing" is what a newly registered
 * service provider does — a metadata import describes what the SP *is*, not
 * what Syntra should demand of it, and `AuthnRequestsSigned` in an SP's own
 * metadata is the SP's claim about itself, not the tenant's policy.
 *
 * Note the write semantics this inherits: `upsertSamlConfig` replaces every
 * column, so omitting the field on an *update* also resets it to the default.
 * That is consistent — this seam has always been a whole-record write, not a
 * patch — but it means an administrator who deliberately turned the
 * requirement off has to keep sending `false`. A future partial-update route
 * must read the row first rather than reusing this function.
 */
export type SamlConfigInput = Omit<
  SamlConfigRecord,
  'id' | 'applicationId' | 'wantAuthnRequestsSigned'
> & { wantAuthnRequestsSigned?: boolean };

/**
 * Ruling A2-10. A service provider that registers without saying anything
 * about signing gets the posture that does not depend on the service provider
 * validating `InResponseTo`.
 *
 * The Prisma column carries the same default, which is the backstop for any
 * insert that never comes through here. This constant is what makes it real
 * for the seam that does: `upsertSamlConfig` writes every column explicitly,
 * so the column default alone would never once be consulted.
 */
export const REQUIRE_SIGNED_AUTHN_REQUESTS_BY_DEFAULT = true;

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
  input: SamlConfigInput,
): Promise<SamlConfigRecord> {
  const tenantId = await currentTenant(tx);
  // Resolved once and used for both halves of the upsert, so create and update
  // cannot drift — an omitted flag that defaulted to true on insert and to
  // whatever Prisma felt like on update would be the worst of both.
  const resolved = {
    ...input,
    wantAuthnRequestsSigned:
      input.wantAuthnRequestsSigned ?? REQUIRE_SIGNED_AUTHN_REQUESTS_BY_DEFAULT,
  };
  const row = await tx.samlConfig.upsert({
    where: { applicationId },
    create: { tenantId, applicationId, ...resolved },
    update: resolved,
  });
  return toRecord(row as unknown as Record<string, unknown>);
}

/**
 * Writes a service provider's configuration and makes sure the tenant has a
 * SAML signing key.
 *
 * This is the seam, and it is here rather than at any request-time endpoint
 * because writing a `SamlConfig` is the moment a tenant commits to being an
 * identity provider. Everything downstream — `/saml/sso`, `/saml/continue`,
 * `/saml/start` — only ever *loads* a key, and nothing enforced the ordering
 * that put one there: `ensureActiveKey` lived in exactly one place, the
 * unauthenticated `/saml/metadata` handler, so an administrator who configured
 * a service provider and never fetched metadata on that tenant's host had
 * every first sign-in dead-end at 409 `saml-no-key` with nothing self-healing
 * it. `/saml/metadata` keeps its call as a backstop; it is no longer the only
 * route.
 *
 * The key comes first and outside the transaction. RSA-2048 generation plus a
 * self-signed certificate is well over a second — a large bite out of the
 * 5000 ms `withTenant` budget, spent on work that touches no row — and
 * ordering it first means a tenant whose key cannot be established does not
 * end up with a configuration that fails every login later. `ensureActiveKey`
 * is idempotent, so every write after the first is a single read.
 */
export async function saveSamlConfig(
  tenantId: string,
  applicationId: string,
  input: SamlConfigInput,
  key: { provider: MasterKeyProvider; commonName: string },
): Promise<SamlConfigRecord> {
  await ensureActiveKey(tenantId, key.provider, 'saml', {
    commonName: key.commonName,
  });
  return withTenant(tenantId, (tx) => upsertSamlConfig(tx, applicationId, input));
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
